import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Auto-layout smoke (docs/requirements.md FR-LAYOUT): paste a scrambled org chart, press
 * Alt/Option+Shift+L and check the layered top-to-bottom result, that bindings survive, that
 * ELK's worker runs under the shipped CSP (no 'unsafe-eval', `worker-src 'self' blob:`) without
 * any request leaving 127.0.0.1, and that one undo restores the original positions.
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

type El = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: [number, number][];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  isDeleted?: boolean;
  customData?: { name?: string };
};

const base = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  updated: 1,
  link: null,
  locked: false,
};

/** CEO → CTO, CEO → CFO, CTO → Dev, scrambled so nothing is in its tree position. */
function orgChart() {
  const box = (id: string, x: number, y: number, arrows: string[]) => ({
    ...base,
    id,
    customData: { name: id },
    type: "rectangle",
    x,
    y,
    width: 120,
    height: 60,
    boundElements: arrows.map((a) => ({ id: a, type: "arrow" })),
  });
  const pos: Record<string, [number, number]> = {
    ceo: [300, 300],
    cto: [0, 0],
    cfo: [600, 40],
    dev: [300, 0],
  };
  const arrow = (id: string, from: string, to: string) => {
    const [fx, fy] = pos[from]!;
    const [tx, ty] = pos[to]!;
    return {
      ...base,
      id,
      customData: { name: id },
      type: "arrow",
      x: fx + 60,
      y: fy + 30,
      width: Math.abs(tx - fx),
      height: Math.abs(ty - fy),
      points: [
        [0, 0],
        [tx - fx, ty - fy],
      ],
      boundElements: [],
      startBinding: { elementId: from, focus: 0, gap: 4 },
      endBinding: { elementId: to, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    };
  };
  return [
    box("ceo", ...pos.ceo!, ["a1", "a2"]),
    box("cto", ...pos.cto!, ["a1", "a3"]),
    box("cfo", ...pos.cfo!, ["a2"]),
    box("dev", ...pos.dev!, ["a3"]),
    arrow("a1", "ceo", "cto"),
    arrow("a2", "ceo", "cfo"),
    arrow("a3", "cto", "dev"),
  ];
}

async function setup(page: Page) {
  const csp = shippedCsp();
  // The document and the worker script each get the shipped policy.
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/assets/elk-worker*`]) {
    await page.route(url, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": csp },
      });
    });
  }
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[]; __copied: string };
    w.__cspViolations = [];
    w.__copied = "";
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
    // Excalidraw copies through navigator.clipboard.writeText; capture it in-page.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void (w.__copied = t) },
    });
  });
}

const workerRequests: string[] = [];

async function paste(page: Page, elements: unknown[]) {
  await page.evaluate((els) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", JSON.stringify({ type: "excalidraw/clipboard", elements: els }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, elements);
}

/** Copies the whole scene and reads it back from the stubbed clipboard. */
async function readScene(page: Page): Promise<Record<string, El>> {
  await page.keyboard.press("ControlOrMeta+a");
  await page.evaluate(() => ((window as unknown as { __copied: string }).__copied = ""));
  await page.keyboard.press("ControlOrMeta+c");
  const text = await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied: string }).__copied))
    .not.toBe("")
    .then(() => page.evaluate(() => (window as unknown as { __copied: string }).__copied));
  // Paste regenerates ids; key by the name we stashed in customData and map bindings back.
  const els = (JSON.parse(text) as { elements: El[] }).elements.filter((e) => !e.isDeleted);
  const name = new Map(els.map((e) => [e.id, e.customData?.name ?? e.id]));
  const named = (b: { elementId: string } | null | undefined) =>
    b ? { elementId: name.get(b.elementId) ?? b.elementId } : b;
  return Object.fromEntries(
    els.map((e) => [
      name.get(e.id)!,
      { ...e, startBinding: named(e.startBinding), endBinding: named(e.endBinding) },
    ]),
  );
}

/** Clicks empty canvas: focuses Excalidraw and clears the selection (→ whole-diagram layout). */
async function deselect(page: Page) {
  const box = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 100);
}

const rel = (s: Record<string, El>) =>
  Object.fromEntries(
    ["cto", "cfo", "dev"].map((id) => [id, [s[id]!.x - s.ceo!.x, s[id]!.y - s.ceo!.y]]),
  );

function remoteRequests(page: Page): string[] {
  const remote: string[] = [];
  const isRemote = (url: string) => !url.startsWith(ORIGIN) && !/^(data|blob|about):/.test(url);
  page.on("response", (res) => {
    if (res.url().includes("elk-worker")) workerRequests.push(res.url());
    if (isRemote(res.url())) remote.push(`${res.request().method()} ${res.url()}`);
  });
  page.on("requestfailed", (req) => {
    if (isRemote(req.url())) remote.push(`${req.method()} ${req.url()}`);
  });
  return remote;
}

test("Alt+Shift+L lays out an org chart under the shipped CSP, as one undo step", async ({
  page,
}) => {
  await setup(page);
  const remote = remoteRequests(page);
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await deselect(page);
  await paste(page, orgChart());
  await deselect(page);
  // Leaves everything selected (= the whole diagram). Selection changes are history entries in
  // Excalidraw, so keep it unchanged from here on: the next undo must be the layout itself.
  const before = await readScene(page);
  expect(Object.keys(before).sort()).toEqual(["a1", "a2", "a3", "ceo", "cfo", "cto", "dev"]);

  await page.keyboard.press("Alt+Shift+L");
  // Layout is async (ELK in a worker): wait until CEO sits above both reports.
  let after: Record<string, El> = {};
  await expect
    .poll(
      async () => {
        after = await readScene(page);
        return after.ceo!.y + 60 < after.cto!.y && after.ceo!.y + 60 < after.cfo!.y;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  expect(after.cto!.y).toBe(after.cfo!.y);
  expect(after.dev!.y).toBeGreaterThan(after.cto!.y + 60);
  expect(Math.abs(after.dev!.x - after.cto!.x)).toBeLessThan(1); // Dev directly under CTO
  for (const [a, from, to] of [
    ["a1", "ceo", "cto"],
    ["a2", "ceo", "cfo"],
    ["a3", "cto", "dev"],
  ] as const) {
    const arrow = after[a]!;
    expect(arrow.startBinding?.elementId).toBe(from);
    expect(arrow.endBinding?.elementId).toBe(to);
    // Re-routed: the arrow starts at its source's bottom edge and ends at its target's top.
    const start = arrow.points![0]!;
    const end = arrow.points![arrow.points!.length - 1]!;
    expect(Math.abs(arrow.y + start[1] - (after[from]!.y + 60))).toBeLessThan(12);
    expect(Math.abs(arrow.y + end[1] - after[to]!.y)).toBeLessThan(12);
  }
  expect(workerRequests.some((u) => u.startsWith(`${ORIGIN}/assets/`))).toBe(true);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => rel(await readScene(page))).toEqual(rel(before));

  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
  // Excalidraw's own CDN font fallback is blocked on every load (see csp-privacy.spec.ts).
  const unexpected = violations.filter((v) => !v.startsWith("font-src https://esm.sh/"));
  expect(unexpected, unexpected.join("\n")).toEqual([]);
  expect(
    remote.filter((r) => !r.includes("esm.sh")),
    remote.join("\n"),
  ).toEqual([]);
});
