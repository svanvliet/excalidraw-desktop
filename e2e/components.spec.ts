import { test, expect, type Page } from "@playwright/test";

/**
 * Components v1 smoke (docs/components.md, FR-54, FR-64), against the real Excalidraw 0.18.1
 * editor: Alt/Option+Cmd/Ctrl+K turns the selection into the component's first instance (the
 * master lives off-canvas), Cmd/Ctrl+D on an instance places another, an edit to the master
 * (agent edit_component_master) updates both in one undo step, and a native-panel edit to one
 * instance stays an override on that instance.
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

const instances = async (page: Page) => (await rows(page)).filter((r) => r.role === "instance");

const tool = <T>(page: Page, name: string, args: Record<string, unknown>) =>
  page.evaluate(
    async ([name, args]) => {
      const out = await window.__e2e!.runSceneTool(name as string, args as never);
      return JSON.parse((out[0] as { text: string }).text) as unknown;
    },
    [name, args] as const,
  ) as Promise<T>;

test("edit a master and every instance follows; one undo reverts both", async ({ page }) => {
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

  // Create turns the selection into the first instance; no master on the canvas.
  await page.keyboard.press("Alt+ControlOrMeta+k");
  await expect.poll(async () => (await byRole(page, "instance"))?.id).toBe("M");
  expect(await byRole(page, "master")).toBeUndefined();

  // Duplicating an instance places another instance.
  await page.keyboard.press("ControlOrMeta+d");
  await expect.poll(async () => (await instances(page)).length).toBe(2);
  const comps = await tool<{ components: { instances: unknown[] }[] }>(page, "list_components", {});
  expect(comps.components).toHaveLength(1);
  expect(comps.components[0].instances).toHaveLength(2);

  // Edit the off-canvas master by slot: both instances follow in one undo step.
  const master = await tool<{ onCanvas: boolean; elements: { slot: string; type: string }[] }>(
    page,
    "get_component_master",
    { component: "M" },
  );
  expect(master.onCanvas).toBe(false);
  const slot = master.elements.find((e) => e.type === "rectangle")!.slot;
  await tool(page, "edit_component_master", {
    component: "M",
    updates: [{ slot, patch: { strokeColor: "#e03131", width: 240 } }],
  });
  await expect
    .poll(async () => (await instances(page)).map((r) => [r.strokeColor, r.width]))
    .toEqual([
      ["#e03131", 240],
      ["#e03131", 240],
    ]);
  expect(await byRole(page, "master")).toBeUndefined();
  await undo(page);
  await expect
    .poll(async () => (await instances(page)).map((r) => [r.strokeColor, r.width]))
    .toEqual([
      ["#1e1e1e", 160],
      ["#1e1e1e", 160],
    ]);

  // A native-panel edit on one instance is an override on that instance only.
  await page.evaluate(() =>
    window.__canvas!.updateScene({
      appState: { selectedElementIds: { M: true } } as never,
    }),
  );
  await page.getByTestId("color-top-pick-#e03131").first().click();
  await expect.poll(async () => (await byRole(page, "instance"))?.strokeColor).toBe("#e03131");
  expect((await instances(page)).map((r) => r.strokeColor).sort()).toEqual(["#1e1e1e", "#e03131"]);
});
