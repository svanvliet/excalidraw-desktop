import { test, expect, type Page } from "@playwright/test";
import { openStripRow } from "./fixtures/strip";

/**
 * Panel strip smoke (FR-63, D-DX17): our panel sections are compact rows at the top of
 * Excalidraw's properties panel, so they are on screen without scrolling for a shape, an image
 * and a component instance — even on a short window where the native controls overflow.
 */

const NS = "excalidrawDesktop.component";

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.addInitScript(() => localStorage.setItem("excalidraw-desktop:e2e", "1"));
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__canvas && window.__e2e);
}

/** Where the strip sits in the panel and whether every row is visible without scrolling. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const col = document.querySelector<HTMLElement>(".App-menu__left .panelColumn")!;
    let scroller: HTMLElement | null = col;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    const view = (scroller ?? document.documentElement).getBoundingClientRect();
    const rows = Array.from(col.querySelectorAll<HTMLElement>(":scope > .props-strip__row"));
    return {
      scrollTop: scroller?.scrollTop ?? 0,
      scrollable: !!scroller && scroller.scrollHeight > scroller.clientHeight,
      firstIsRow: col.firstElementChild?.classList.contains("props-strip__row") ?? false,
      rows: rows.map((r) => r.dataset.testid),
      offscreen: rows
        .filter((r) => {
          const b = r.getBoundingClientRect();
          return b.height === 0 || b.top < view.top || b.bottom > view.bottom;
        })
        .map((r) => r.dataset.testid),
    };
  });

async function expectStripOnTop(page: Page, rows: string[]) {
  await expect(page.locator(`[data-testid=${rows[0]}]`)).toBeVisible();
  await expect.poll(async () => (await layout(page)).rows).toEqual(rows);
  const l = await layout(page);
  expect(l.scrollTop).toBe(0);
  expect(l.firstIsRow).toBe(true);
  expect(l.offscreen).toEqual([]);
}

async function select(page: Page, ids: string[]) {
  await page.evaluate((ids) => {
    const els = window.__canvas!.getSceneElements().filter((e) => ids.includes(e.id));
    const groupId = els[0].groupIds.at(-1);
    window.__canvas!.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
        selectedGroupIds: groupId ? { [groupId]: true } : {},
      } as never,
    });
  }, ids);
}

const roles = (page: Page) =>
  page.evaluate(
    (ns) =>
      window
        .__canvas!.getSceneElements()
        .map((e) => ({ id: e.id, role: (e.customData?.[ns] as { role?: string })?.role })),
    NS,
  );

async function seedRectangle(page: Page) {
  await page.evaluate(() => {
    const els = window.__e2e!.convertToExcalidrawElements(
      [{ type: "rectangle", id: "R", x: 160, y: 160, width: 160, height: 80 }] as never,
      { regenerateIds: false },
    );
    window.__canvas!.updateScene({ elements: els, captureUpdate: "IMMEDIATELY" as never });
  });
}

test("rows sit at the top of the panel for a rectangle; Create runs inline", async ({ page }) => {
  await open(page);
  await seedRectangle(page);
  await select(page, ["R"]);
  await expectStripOnTop(page, [
    "component-props-native",
    "style-section-native",
    "shape-data-native",
  ]);
  await expect(page.getByTestId("component-props-native")).toContainText("Not a component");
  // The window is short enough that the native controls below the strip overflow.
  expect((await layout(page)).scrollable).toBe(true);

  // Single-open: opening Style closes nothing else, then Data replaces it.
  await openStripRow(page, "style-section");
  await expect(page.getByTestId("style-section-picker")).toBeVisible();
  await openStripRow(page, "shape-data");
  await expect(page.getByTestId("style-section-picker")).toHaveCount(0);
  await expect(page.getByTestId("style-section-toggle")).toHaveAttribute("aria-expanded", "false");
  expect((await layout(page)).scrollTop).toBe(0);

  // The inline primary acts without opening the row.
  await page.getByTestId("component-props-primary").click();
  await expect.poll(async () => (await roles(page)).find((e) => e.id === "R")?.role).toBe("master");
  await expect(page.getByTestId("component-props-native")).toContainText("master");
  await expect(page.getByTestId("component-props-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("rows sit at the top of the panel for a component instance", async ({ page }) => {
  await open(page);
  await seedRectangle(page);
  await select(page, ["R"]);
  await page.getByTestId("component-props-primary").click();
  await expect.poll(async () => (await roles(page)).find((e) => e.id === "R")?.role).toBe("master");
  await page.keyboard.press("ControlOrMeta+d");
  await expect
    .poll(async () => (await roles(page)).filter((e) => e.role === "instance").length)
    .toBe(1);
  const inst = (await roles(page)).filter((e) => e.role === "instance").map((e) => e.id);
  await select(page, inst);
  await expectStripOnTop(page, [
    "component-props-native",
    "style-section-native",
    "shape-data-native",
  ]);
  // Its summary is the component's name (no overrides yet).
  await expect(
    page.locator("[data-testid=component-props-native] .props-strip__summary"),
  ).toHaveText("Component");
});

test("rows sit at the top of the panel for an image", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#e03131";
    ctx.fillRect(0, 0, 64, 64);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "red.png", { type: "image/png" }));
    const target = document.querySelector(".excalidraw .excalidraw__canvas.interactive")!;
    const rect = target.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...at }),
      );
    }
  });
  await expect(page.getByTestId("image-props-native")).toBeVisible({ timeout: 10_000 });
  const rows = (await layout(page)).rows;
  expect(rows[0]).toBe("component-props-native");
  expect(rows).toContain("image-props-native");
  await expectStripOnTop(page, rows as string[]);
  await expect(page.getByTestId("image-props-native")).toContainText("No effects");
});
