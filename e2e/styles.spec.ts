import { test, expect, type Page } from "@playwright/test";
import { openStripRow } from "./fixtures/strip";

/**
 * Named styles smoke (docs/styles.md, FR-58), against the real Excalidraw editor: make a style
 * from the selection in the properties panel's Style picker, edit it from the Styles tab and
 * from the agent's update_style tool, and watch every linked element follow; one undo reverts
 * the whole edit. A local edit becomes an override that the style no longer touches.
 */

const STYLE_NS = "excalidrawDesktop.style";

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("excalidraw-desktop:e2e", "1"));
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__canvas && window.__e2e);
}

const strokes = (page: Page) =>
  page.evaluate(
    (ns) =>
      Object.fromEntries(
        window
          .__canvas!.getSceneElements()
          .filter((e) => e.type === "rectangle")
          .map((e) => [
            e.id,
            {
              stroke: e.strokeColor,
              style: (e.customData?.[ns] as { name?: string } | undefined)?.name ?? null,
            },
          ]),
      ),
    STYLE_NS,
  ) as Promise<Record<string, { stroke: string; style: string | null }>>;

const select = (page: Page, ids: string[]) =>
  page.evaluate(
    (ids) =>
      window.__canvas!.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
        } as never,
      }),
    ids,
  );

test("a named style updates its linked elements live; one undo reverts", async ({ page }) => {
  await open(page);
  const canvas = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + canvas.height - 120);
  await page.evaluate(() => {
    const els = window.__e2e!.convertToExcalidrawElements(
      [
        { type: "rectangle", id: "A", x: 120, y: 120, width: 120, height: 80 },
        { type: "rectangle", id: "B", x: 280, y: 120, width: 120, height: 80 },
        { type: "rectangle", id: "C", x: 440, y: 120, width: 120, height: 80 },
      ] as never,
      { regenerateIds: false },
    );
    window.__canvas!.updateScene({ elements: els, captureUpdate: "IMMEDIATELY" as never });
  });
  await select(page, ["A", "B"]);

  // Properties panel: new style from the selection links both.
  await openStripRow(page, "style-section");
  const picker = page.getByTestId("style-section-picker");
  await expect(picker).toBeVisible();
  await picker.selectOption("__new__");
  await expect.poll(async () => (await strokes(page)).A.style).toBe("Style 1");
  expect((await strokes(page)).B.style).toBe("Style 1");
  expect((await strokes(page)).C.style).toBeNull();
  await expect(picker).not.toHaveValue("");

  // Styles tab: edit the stroke; both linked rectangles follow, C does not.
  await page.locator(".excalidraw .sidebar-trigger").first().click();
  await page.getByTestId("sidebar-tab-styles").click();
  await page.getByTestId("sidebar-dock").click();
  const panel = page.getByTestId("styles-panel");
  await expect(panel.getByTestId("styles-row")).toHaveCount(1);
  await panel.getByTestId("styles-row").click();
  const stroke = panel.getByTestId("styles-prop-strokeColor").getByRole("textbox");
  await stroke.fill("#e03131");
  await stroke.press("Enter");
  await expect.poll(async () => (await strokes(page)).A.stroke).toBe("#e03131");
  expect((await strokes(page)).B.stroke).toBe("#e03131");
  expect((await strokes(page)).C.stroke).toBe("#1e1e1e");

  // One undo reverts the whole style edit.
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(async () => (await strokes(page)).A.stroke).toBe("#1e1e1e");
  expect((await strokes(page)).B.stroke).toBe("#1e1e1e");

  // A local edit on B becomes an override; the agent's update_style then skips B.
  await select(page, ["B"]);
  await page.getByTestId("color-top-pick-#2f9e44").first().click();
  await expect(page.getByTestId("style-section-overrides")).toBeVisible();
  const out = await page.evaluate(async () => {
    const r = await window.__e2e!.runSceneTool("update_style", {
      style: "Style 1",
      props: { strokeColor: "#1971c2" },
    });
    return JSON.parse((r[0] as { text: string }).text) as { elementIds: string[] };
  });
  expect(out.elementIds.sort()).toEqual(["A", "B"]);
  await expect.poll(async () => (await strokes(page)).A.stroke).toBe("#1971c2");
  expect((await strokes(page)).B.stroke).toBe("#2f9e44");

  // Reset the override from the panel: B snaps back to the style.
  await page.getByRole("button", { name: "Reset overrides" }).click();
  await expect.poll(async () => (await strokes(page)).B.stroke).toBe("#1971c2");
});
