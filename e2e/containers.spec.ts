import { test, expect, type Page } from "@playwright/test";
import { openStripRow } from "./fixtures/strip";

/**
 * Smart containers smoke (docs/containers.md, FR-59), against the real Excalidraw 0.18.1 editor:
 * Alt/Option+Shift+A stacks the selection in a container, the native panel's Gap field re-flows
 * it in one undo step, and resizing a child through the agent's update_elements tool re-flows
 * the container in the same commit.
 */

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("excalidraw-desktop:e2e", "1"));
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__canvas && window.__e2e);
}

const geom = (page: Page) =>
  page.evaluate(() => {
    const els = window.__canvas!.getSceneElements();
    const box = els.find((e) => e.customData?.["excalidrawDesktop.layout"]);
    const at = (id: string) => els.find((e) => e.id === id)!;
    return {
      box: box ? { id: box.id, x: box.x, y: box.y, h: box.height } : null,
      a: at("A").y,
      b: at("B").y,
    };
  });

test("make a container, change its gap from the panel, undo", async ({ page }) => {
  await open(page);
  const canvas = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + canvas.height - 120);
  await page.evaluate(() => {
    const els = window.__e2e!.convertToExcalidrawElements(
      [
        { type: "rectangle", id: "A", x: 120, y: 120, width: 160, height: 60 },
        { type: "rectangle", id: "B", x: 120, y: 260, width: 100, height: 40 },
      ] as never,
      { regenerateIds: false },
    );
    window.__canvas!.updateScene({
      elements: els,
      appState: { selectedElementIds: { A: true, B: true } } as never,
      captureUpdate: "IMMEDIATELY" as never,
    });
  });

  await page.keyboard.press("Alt+Shift+A");
  await expect.poll(async () => (await geom(page)).box).toMatchObject({ x: 104, y: 104, h: 148 });
  expect((await geom(page)).b).toBe(196); // 120 + 60 + gap 16

  const section = page.locator(
    ".App-menu__left .panelColumn > [data-testid=container-section-native]",
  );
  await expect(section).toBeVisible();
  await openStripRow(page, "container-section");
  const gap = section.getByTestId("container-gap");
  await gap.fill("40");
  await gap.press("Enter");
  await expect.poll(async () => (await geom(page)).b).toBe(220);

  // The agent resizes a child; the container re-flows in the same commit.
  await page.evaluate(() =>
    window.__e2e!.runSceneTool("update_elements", {
      updates: [{ id: "A", patch: { height: 100 } }],
    }),
  );
  await expect.poll(async () => (await geom(page)).b).toBe(260);
  expect((await geom(page)).box?.h).toBe(16 + 100 + 40 + 40 + 16);

  // Each change is one undo step: agent edit, then the gap change, then make-container.
  const undo = () => page.getByRole("button", { name: "Undo" }).first().click();
  await undo();
  await expect.poll(async () => (await geom(page)).b).toBe(220);
  await undo();
  await expect.poll(async () => (await geom(page)).b).toBe(196);
  await undo();
  await expect.poll(async () => (await geom(page)).box).toBeNull();
  expect((await geom(page)).b).toBe(260);
});
