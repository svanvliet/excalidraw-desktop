import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Runs the web build under the CSP shipped in `src-tauri/tauri.conf.json`
 * (served as a response header by the preview server) and asserts:
 *   - the editor works without CSP violations, including text rendering
 *     (fonts) and SVG export (font subsetting via wasm + worker);
 *   - with every online toggle off, nothing leaves 127.0.0.1 — even after
 *     drawing text (which used to fetch fonts from esm.sh) and opening the
 *     Share / Join dialogs.
 *
 * Tauri appends its own IPC sources and script nonces at runtime; the
 * header here is the static policy only.
 */

const ORIGIN = "http://127.0.0.1:4173";

function shippedCsp(): string {
  const conf = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ) as { app: { security: { csp: Record<string, string> } } };
  return Object.entries(conf.app.security.csp)
    .map(([directive, sources]) => `${directive} ${sources}`)
    .join("; ");
}

async function withShippedCsp(page: Page) {
  const csp = shippedCsp();
  await page.route(`${ORIGIN}/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": csp },
    });
  });
  await page.addInitScript(() => {
    // Capture exports in-page instead of hitting the native save picker.
    const saved: Blob[] = [];
    Object.assign(window, {
      __saved: saved,
      showSaveFilePicker: async () => ({
        name: "export.svg",
        createWritable: async () => ({
          write: async (b: Blob) => void saved.push(b),
          close: async () => {},
        }),
      }),
    });
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
}

/**
 * Remote requests that actually reached the network. CSP-blocked attempts
 * still surface as `request` events in Chromium, so count responses and
 * non-CSP failures instead.
 */
function trackRemoteRequests(page: Page): string[] {
  const remote: string[] = [];
  const isRemote = (url: string) => !url.startsWith(ORIGIN) && !/^(data|blob|about):/.test(url);
  page.on("response", (res) => {
    if (isRemote(res.url())) remote.push(`${res.request().method()} ${res.url()}`);
  });
  page.on("requestfailed", (req) => {
    if (isRemote(req.url()) && req.failure()?.errorText !== "csp") {
      remote.push(`${req.method()} ${req.url()} (${req.failure()?.errorText})`);
    }
  });
  return remote;
}

async function drawText(page: Page, text: string) {
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  const canvas = page.locator("canvas.excalidraw__canvas.interactive");
  await canvas.click({ position: { x: 400, y: 300 } });
  await page.keyboard.press("t");
  await canvas.click({ position: { x: 400, y: 300 } });
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

test.describe("CSP + offline fonts", () => {
  test("text and SVG export work under the shipped CSP, fonts are self-hosted", async ({
    page,
  }) => {
    await withShippedCsp(page);
    const remote = trackRemoteRequests(page);
    const fontRequests: string[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/fonts/")) fontRequests.push(res.url());
    });

    await page.goto("/");
    await drawText(page, "Hello offline");
    await expect.poll(() => fontRequests.some((u) => u.includes("Excalifont"))).toBe(true);

    await page.keyboard.press("ControlOrMeta+Shift+E");
    const svgButton = page.getByRole("button", { name: /svg/i }).first();
    await expect(svgButton).toBeVisible();
    await svgButton.click();
    const savedSvg = () =>
      page.evaluate(async () => {
        const [blob] = (window as unknown as { __saved: Blob[] }).__saved;
        return blob ? blob.text() : "";
      });
    await expect.poll(savedSvg, { timeout: 15_000 }).toContain("</svg>");
    const body = await savedSvg();
    expect(body).toContain("Hello offline");
    expect(body).toContain("@font-face");

    // Expected, harmless violations (blocked before any request leaves):
    //  - font-src esm.sh: Excalidraw appends its CDN fallback to every
    //    FontFace `src` list and Chromium CSP-checks the whole list; the
    //    self-hosted source is what loads (see the no-CSP test below).
    //  - script-src eval: the woff2 font-subsetting glue (emscripten embind)
    //    uses `new Function`. We deliberately don't allow 'unsafe-eval'.
    //  - connect-src esm.sh: after subsetting fails, Excalidraw retries the
    //    next URL in the list (the CDN); CSP blocks it and SVG export embeds
    //    the whole self-hosted font instead.
    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    const cdn = "https://esm.sh/@excalidraw/excalidraw@";
    const unexpected = violations.filter(
      (v) =>
        v !== "script-src eval" &&
        !v.startsWith(`font-src ${cdn}`) &&
        !v.startsWith(`connect-src ${cdn}`),
    );
    expect(unexpected, unexpected.join("\n")).toEqual([]);
    expect(remote, remote.join("\n")).toEqual([]);
    expect(fontRequests.every((u) => u.startsWith(`${ORIGIN}/fonts/`))).toBe(true);
  });

  test("collab off: Share/Join dialogs and text make zero outbound requests", async ({ page }) => {
    const remote = trackRemoteRequests(page);
    await page.goto("/");
    await drawText(page, "Private");

    await page.getByTestId("toolbar-share").click();
    await expect(page.getByTestId("share-disabled")).toBeVisible();
    await expect(page.getByTestId("share-start")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByTestId("toolbar-join").click();
    await expect(page.getByTestId("join-disabled")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.waitForTimeout(1_000);
    expect(remote, remote.join("\n")).toEqual([]);
  });

  test("updates: no consent prompt or update traffic from the webview", async ({ page }) => {
    // Update checks run natively in Rust (not subject to the CSP) and only
    // after consent; this guards the webview side of that promise.
    const remote = trackRemoteRequests(page);
    await page.goto("/");
    await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("update-consent")).toHaveCount(0);

    await page.getByTestId("toolbar-settings").click();
    const toggle = page.getByTestId("toggle-auto-update");
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("update-check-now")).toBeDisabled();
    await toggle.check();
    await expect(toggle).toBeChecked();

    await page.waitForTimeout(1_000);
    expect(remote, remote.join("\n")).toEqual([]);
  });

  test("AI off: no agent UI, shortcut is inert, zero outbound requests", async ({ page }) => {
    const remote = trackRemoteRequests(page);
    await page.goto("/");
    await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("toolbar-agent")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+A");
    await expect(page.getByTestId("agent-panel")).toHaveCount(0);

    await page.getByTestId("toolbar-settings").click();
    await expect(page.getByTestId("ai-off-hint")).toBeVisible();

    await page.waitForTimeout(1_000);
    expect(remote, remote.join("\n")).toEqual([]);
  });
});
