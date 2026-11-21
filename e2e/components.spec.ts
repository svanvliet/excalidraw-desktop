import { test, expect, type Page } from "@playwright/test";

/**
 * Components v1 smoke (docs/components.md, FR-54), against the real Excalidraw 0.18.1 editor:
 * Alt/Option+Cmd/Ctrl+K turns the selection into a component, Cmd/Ctrl+D on the master places
 * an instance, and editing the master — from the native properties panel and from the agent's
 * update_elements tool — updates the instance live; one undo reverts master and instance.
 */

interface Row {
  id: string;
  type: string;
  width: number;
  strokeColor: string;
  role?: string;
}

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("excalidraw-desktop:e2e", "1"));
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__canvas && window.__e2e);
}

const rows = (page: Page) =>
  page.evaluate(() =>
    window
      .__canvas!.getSceneElements()
      .filter((e) => e.type === "rectangle")
      .map((e) => ({
        id: e.id,
        type: e.type,
        width: Math.round(e.width),
        strokeColor: e.strokeColor,
        role: (e.customData?.["excalidrawDesktop.component"] as { role?: string } | undefined)
          ?.role,
      })),
  ) as Promise<Row[]>;

const byRole = async (page: Page, role: string) => (await rows(page)).find((r) => r.role === role);

const undo = (page: Page) => page.getByRole("button", { name: "Undo" }).first().click();

test("edit a master and its instance follows; one undo reverts both", async ({ page }) => {
  await open(page);
  const canvas = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  // Focus the canvas so shortcuts reach Excalidraw.
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + canvas.height - 120);
  await page.evaluate(() => {
    const els = window.__e2e!.convertToExcalidrawElements(
      [
        {
          type: "rectangle",
          id: "M",
          x: 120,
          y: 120,
          width: 160,
          height: 80,
          label: { text: "Card" },
        },
      ] as never,
      { regenerateIds: false },
    );
    window.__canvas!.updateScene({
      elements: els,
      appState: { selectedElementIds: { M: true } } as never,
      captureUpdate: "IMMEDIATELY" as never,
    });
  });

  await page.keyboard.press("Alt+ControlOrMeta+k");
  await expect.poll(async () => (await byRole(page, "master"))?.id).toBe("M");

  // Duplicating a master creates an instance (onDuplicate), not a second master.
  await page.keyboard.press("ControlOrMeta+d");
  await expect.poll(async () => (await byRole(page, "instance"))?.width).toBe(160);
  const comps = await page.evaluate(async () => {
    const out = await window.__e2e!.runSceneTool("list_components", {});
    return JSON.parse((out[0] as { text: string }).text).components as {
      instances: unknown[];
    }[];
  });
  expect(comps).toHaveLength(1);
  expect(comps[0].instances).toHaveLength(1);

  // Select the master and change its stroke from the native properties panel.
  await page.evaluate(() =>
    window.__canvas!.updateScene({
      appState: { selectedElementIds: { M: true } } as never,
    }),
  );
  await page.getByTestId("color-top-pick-#e03131").first().click();
  await expect.poll(async () => (await byRole(page, "master"))?.strokeColor).toBe("#e03131");
  await expect.poll(async () => (await byRole(page, "instance"))?.strokeColor).toBe("#e03131");

  await undo(page);
  await expect.poll(async () => (await byRole(page, "master"))?.strokeColor).toBe("#1e1e1e");
  expect((await byRole(page, "instance"))?.strokeColor).toBe("#1e1e1e");

  // The agent path: a generic update_elements on the master syncs the instance in one step.
  await page.evaluate(() =>
    window.__e2e!.runSceneTool("update_elements", {
      updates: [{ id: "M", patch: { width: 240 } }],
    }),
  );
  await expect.poll(async () => (await byRole(page, "instance"))?.width).toBe(240);
  await undo(page);
  await expect.poll(async () => (await byRole(page, "master"))?.width).toBe(160);
  expect((await byRole(page, "instance"))?.width).toBe(160);
});
