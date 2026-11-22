import { test, expect, type Page } from "@playwright/test";
import { openStripRow } from "./fixtures/strip";

/**
 * Shape data + elbow-arrow anchors smoke (docs/plan.md D-DX2 / D-DX3), against the real
 * Excalidraw 0.18.1 editor: the Data and Anchors sections in the native properties panel, one
 * undo step per action, and Excalidraw's own elbow router honouring the pinned sides — from the
 * panel and from the agent's connect / set_arrow_anchors tools.
 */

interface ElbowState {
  startBinding: { elementId: string; fixedPoint: [number, number] } | null;
  endBinding: { elementId: string; fixedPoint: [number, number] } | null;
  /** Absolute points. */
  points: [number, number][];
}

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("excalidraw-desktop:e2e", "1"));
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__canvas && window.__e2e);
}

/** Two 120×80 boxes (A top-left, B down-right) plus optional extra skeletons, as one step. */
async function seed(page: Page, extra: Record<string, unknown>[] = []) {
  await page.evaluate((extra) => {
    const els = window.__e2e!.convertToExcalidrawElements(
      [
        { type: "rectangle", id: "A", x: 100, y: 100, width: 120, height: 80 },
        { type: "rectangle", id: "B", x: 450, y: 300, width: 120, height: 80 },
        ...extra,
      ] as never,
      { regenerateIds: false },
    );
    window.__canvas!.updateScene({ elements: els, captureUpdate: "IMMEDIATELY" as never });
  }, extra);
}

const select = (page: Page, ...ids: string[]) =>
  page.evaluate(
    (ids) =>
      window.__canvas!.updateScene({
        appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) } as never,
      }),
    ids,
  );

const elbow = (page: Page, id: string) =>
  page.evaluate((id) => {
    const a = window.__canvas!.getSceneElements().find((e) => e.id === id) as unknown as
      | (ElbowState & { x: number; y: number; isDeleted: boolean })
      | undefined;
    if (!a) return null;
    return {
      startBinding: a.startBinding,
      endBinding: a.endBinding,
      points: a.points.map(([px, py]) => [a.x + px, a.y + py]),
    } as ElbowState;
  }, id);

const dataOf = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (
        window.__canvas!.getSceneElements().find((e) => e.id === id)?.customData as
          | { "excalidrawDesktop.data"?: { entries: [string, string][] } }
          | undefined
      )?.["excalidrawDesktop.data"]?.entries ?? [],
    id,
  );

/** Keyboard undo: the panel sections must hand Ctrl/Cmd+Z back to Excalidraw. */
const undo = (page: Page) => page.keyboard.press("ControlOrMeta+z");
const undoButton = (page: Page) => page.getByRole("button", { name: "Undo" }).first().click();

function expectOrthogonal(points: [number, number][]) {
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    expect(Math.min(Math.abs(ax - bx), Math.abs(ay - by))).toBeLessThan(0.5);
  }
}

function expectNear(p: [number, number], q: [number, number]) {
  expect(Math.abs(p[0] - q[0])).toBeLessThan(1.5);
  expect(Math.abs(p[1] - q[1])).toBeLessThan(1.5);
}

// A = (100,100) 120×80, B = (450,300) 120×80; pinned ends sit 5px outside the outline.
const A_TOP: [number, number] = [160, 95];
const A_BOTTOM: [number, number] = [160, 185];
const A_RIGHT: [number, number] = [225, 140];
const B_TOP: [number, number] = [510, 295];
const B_LEFT: [number, number] = [445, 340];

test("edits shape data from the native panel; Ctrl/Cmd+Z undoes each change", async ({ page }) => {
  await open(page);
  await seed(page);
  await select(page, "A", "B");
  const section = page.locator(".App-menu__left .panelColumn > [data-testid=shape-data-native]");
  await expect(section).toBeVisible();
  await openStripRow(page, "shape-data");

  await section.getByLabel("New key").fill("owner");
  await section.getByLabel("New value").fill("ann");
  await section.getByLabel("New value").press("Enter");
  await expect.poll(() => dataOf(page, "B")).toEqual([["owner", "ann"]]);
  expect(await dataOf(page, "A")).toEqual([["owner", "ann"]]);

  // A focused text input keeps its own text undo; the scene is untouched.
  const newKey = section.getByLabel("New key");
  await newKey.pressSequentially("tmp");
  await undo(page);
  await expect(newKey).toHaveValue("");
  expect(await dataOf(page, "A")).toEqual([["owner", "ann"]]);

  const value = section.getByLabel("Value of owner");
  await value.fill("bob");
  await value.press("Enter");
  await expect.poll(() => dataOf(page, "A")).toEqual([["owner", "bob"]]);

  await undo(page);
  await expect.poll(() => dataOf(page, "A")).toEqual([["owner", "ann"]]);
  await section.getByRole("button", { name: "Remove owner" }).click();
  await expect.poll(() => dataOf(page, "B")).toEqual([]);
  await undo(page);
  await expect.poll(() => dataOf(page, "B")).toEqual([["owner", "ann"]]);
});

test("pins an elbow arrow's start from the native panel and undoes it", async ({ page }) => {
  await open(page);
  await seed(page, [
    { type: "arrow", id: "X", elbowed: true, x: 220, y: 140, start: { id: "A" }, end: { id: "B" } },
  ]);
  const before = (await elbow(page, "X"))!;
  await select(page, "X");
  const section = page.locator(".App-menu__left .panelColumn > [data-testid=arrow-anchors-native]");
  await expect(section).toBeVisible();
  await openStripRow(page, "arrow-anchors");

  await section.getByRole("button", { name: "Start: Top" }).click();
  await expect(section.getByRole("button", { name: "Start: Top" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const pinned = (await elbow(page, "X"))!;
  expect(pinned.startBinding!.fixedPoint[1]).toBeLessThan(0);
  expectNear(pinned.points[0], A_TOP);
  expectOrthogonal(pinned.points);

  await section.getByRole("button", { name: "End: Left" }).click();
  const both = (await elbow(page, "X"))!;
  expectNear(both.points[0], A_TOP);
  expectNear(both.points[both.points.length - 1], B_LEFT);
  expectOrthogonal(both.points);

  await undo(page);
  const startOnly = (await elbow(page, "X"))!;
  expect(startOnly.endBinding).toEqual(pinned.endBinding);
  expectNear(startOnly.points[0], A_TOP);
  await undo(page);
  const restored = (await elbow(page, "X"))!;
  expect(restored.startBinding).toEqual(before.startBinding);
  expect(restored.endBinding).toEqual(before.endBinding);
});

test("agent connect and set_arrow_anchors route through Excalidraw as one step each", async ({
  page,
}) => {
  await open(page);
  await seed(page);
  const res = await page.evaluate(async () => {
    const out = await window.__e2e!.runSceneTool("connect", {
      from: "A",
      to: "B",
      startAnchor: "s",
      endAnchor: "n",
    });
    return JSON.parse((out[0] as { text: string }).text) as { id: string; startAnchor: string };
  });
  expect(res.startAnchor).toBe("s");
  const routed = (await elbow(page, res.id))!;
  expectNear(routed.points[0], A_BOTTOM);
  expectNear(routed.points[routed.points.length - 1], B_TOP);
  expectOrthogonal(routed.points);
  expect(routed.points.length).toBeGreaterThan(2);

  await page.evaluate(
    (id) => window.__e2e!.runSceneTool("set_arrow_anchors", { id, start: "e" }),
    res.id,
  );
  const moved = (await elbow(page, res.id))!;
  expectNear(moved.points[0], A_RIGHT);
  expectOrthogonal(moved.points);

  await undoButton(page);
  expectNear((await elbow(page, res.id))!.points[0], A_BOTTOM);
  await undoButton(page);
  expect(await elbow(page, res.id)).toBeNull();
});
