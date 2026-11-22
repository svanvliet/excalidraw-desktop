import { test, expect, type Page } from "@playwright/test";
import { revealStripRow } from "./fixtures/strip";

/**
 * Named styles smoke (docs/styles.md, FR-58, FR-65), against the real Excalidraw editor: reveal
 * the Style row from the strip's "+", make a style from the selection, rename it, edit it by
 * pushing one element's local change ("Update style") and from the agent's update_style tool, and
 * watch every linked element follow; one undo reverts the whole edit. A local edit becomes an
 * override that the style no longer touches.
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

  // No style yet: the Style row waits behind "+"; a new style from the selection links both.
  await expect(page.getByTestId("style-section-toggle")).toHaveCount(0);
  await revealStripRow(page, "style-section");
  const picker = page.getByTestId("style-section-picker");
  await expect(picker).toBeVisible();
  await picker.selectOption("__new__");
  await expect.poll(async () => (await strokes(page)).A.style).toBe("Style 1");
  expect((await strokes(page)).B.style).toBe("Style 1");
  expect((await strokes(page)).C.style).toBeNull();
  await expect(picker).not.toHaveValue("");

  // Rename it in place.
  await page.getByTestId("style-section-rename").click();
  const name = page.getByTestId("style-section-name");
  await name.fill("Brand");
  await name.press("Enter");
  await expect.poll(async () => (await strokes(page)).A.style).toBe("Brand");

  // Edit A's stroke locally, then push it into the style: B follows, C does not.
  await select(page, ["A"]);
  await page.getByTestId("color-top-pick-#e03131").first().click();
  await expect(page.getByTestId("style-section-overrides")).toBeVisible();
  expect((await strokes(page)).B.stroke).toBe("#1e1e1e");
  await page.getByRole("button", { name: "Update style" }).click();
  await expect.poll(async () => (await strokes(page)).B.stroke).toBe("#e03131");
  expect((await strokes(page)).A.stroke).toBe("#e03131");
  expect((await strokes(page)).C.stroke).toBe("#1e1e1e");
  await expect(page.getByTestId("style-section-overrides")).toHaveCount(0);

  // One undo reverts the whole style edit (B), a second A's local change.
  const undo = () => page.getByRole("button", { name: "Undo" }).first().click();
  await undo();
  await expect.poll(async () => (await strokes(page)).B.stroke).toBe("#1e1e1e");
  expect((await strokes(page)).A.stroke).toBe("#e03131");
  await undo();
  await expect.poll(async () => (await strokes(page)).A.stroke).toBe("#1e1e1e");

  // A local edit on B becomes an override; the agent's update_style then skips B.
  await select(page, ["B"]);
  await page.getByTestId("color-top-pick-#2f9e44").first().click();
  await expect(page.getByTestId("style-section-overrides")).toBeVisible();
  const out = await page.evaluate(async () => {
    const r = await window.__e2e!.runSceneTool("update_style", {
      style: "Brand",
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
