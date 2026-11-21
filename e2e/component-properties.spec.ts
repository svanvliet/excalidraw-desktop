import { test, expect, type Page } from "@playwright/test";

/**
 * Component properties + nested components smoke (docs/components.md §5–6, FR-56/FR-57), against
 * the real Excalidraw 0.18.1 editor: declare a property on the master and set it on an instance
 * from the "Properties" panel section (one undo step), set a nested Card's property from an outer
 * Panel instance, and an Alt/Option-drag of a master with the real mouse keeps the stationary copy
 * as the master.
 */

const NS = "excalidrawDesktop.component";

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("excalidraw-desktop:e2e", "1"));
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__canvas && window.__e2e);
}

interface Tagged {
  id: string;
  type: string;
  x: number;
  text?: string;
  role?: string;
  groupIds: readonly string[];
}

const tagged = (page: Page) =>
  page.evaluate(
    (ns) =>
      window.__canvas!.getSceneElements().map((e) => {
        // The outermost tag is first on nested copies; its role is what the user sees.
        const t = e.customData?.[ns] as { role?: string } | undefined;
        return {
          id: e.id,
          type: e.type,
          x: Math.round(e.x),
          text: (e as { text?: string }).text,
          role: t?.role,
          groupIds: e.groupIds,
        };
      }),
    NS,
  ) as Promise<Tagged[]>;

const textOf = async (page: Page, role: string) =>
  (await tagged(page)).find((e) => e.type === "text" && e.role === role)?.text;

/** Visible copy of a test id (the panel section also renders in the hidden dock). */
const tid = (page: Page, id: string) => page.locator(`[data-testid="${id}"]:visible`);

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

async function card(page: Page) {
  const canvas = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
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
  await expect
    .poll(async () => (await tagged(page)).find((e) => e.id === "M")?.role)
    .toBe("master");
  return (await tagged(page)).filter((e) => e.role === "master").map((e) => e.id);
}

const tool = <T>(page: Page, name: string, args: Record<string, unknown>) =>
  page.evaluate(
    async ([name, args]) => {
      const out = await window.__e2e!.runSceneTool(name as string, args as never);
      return JSON.parse((out[0] as { text: string }).text) as unknown;
    },
    [name, args] as const,
  ) as Promise<T>;

test("declare a property on the master; set it on an instance; one undo reverts", async ({
  page,
}) => {
  await open(page);
  const masterIds = await card(page);
  await select(page, masterIds);
  await tid(page, "propdef-name").fill("Title");
  await tid(page, "propdef-add").click();
  await expect(tid(page, "propdef-remove-Title")).toBeVisible();

  // Give the keyboard back to the canvas, then duplicate the master into an instance.
  const canvas = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + canvas.height - 120);
  await select(page, masterIds);
  await page.keyboard.press("ControlOrMeta+d");
  await expect.poll(async () => textOf(page, "instance")).toBe("Card");
  const instIds = (await tagged(page)).filter((e) => e.role === "instance").map((e) => e.id);
  await select(page, instIds);
  const field = tid(page, "propval-own-Title");
  await field.fill("Hello");
  await field.press("Enter");
  await expect.poll(async () => textOf(page, "instance")).toBe("Hello");
  expect(await textOf(page, "master")).toBe("Card");
  await expect(tid(page, "propval-reset-own-Title")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(async () => textOf(page, "instance")).toBe("Card");
});

test("an outer Panel instance sets its nested Card's property", async ({ page }) => {
  await open(page);
  const masterIds = await card(page);
  const cardId = await page.evaluate(
    ([ns, id]) =>
      (
        window.__canvas!.getSceneElements().find((e) => e.id === id)!.customData![ns] as {
          componentId: string;
        }
      ).componentId,
    [NS, masterIds[0]] as const,
  );
  await tool(page, "define_property", {
    component: cardId,
    property: { name: "Title", type: "text", bindings: [{ elementId: "M" }] },
  });
  const inner = await tool<{ ids: string[] }>(page, "insert_instance", {
    component: cardId,
    x: 120,
    y: 320,
  });
  const panel = await tool<{ componentId: string }>(page, "create_component", {
    ids: inner.ids,
    name: "Panel",
  });
  const outer = await tool<{ ids: string[] }>(page, "insert_instance", {
    component: panel.componentId,
    x: 420,
    y: 320,
  });

  await select(page, outer.ids);
  const nested = tid(page, "propvals-nested");
  await expect(nested).toContainText("(nested)");
  const field = nested.locator('[data-testid^="propval-"][data-testid$="-Title"]');
  await field.fill("Inner");
  await field.press("Enter");
  await expect
    .poll(async () =>
      (await tagged(page))
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .sort(),
    )
    .toEqual(["Card", "Card", "Inner"]);
  // The Card master still drives the nested copy's other keys.
  await page.evaluate(() =>
    window.__e2e!.runSceneTool("update_elements", {
      updates: [{ id: "M", patch: { backgroundColor: "#a5d8ff" } }],
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        (ids) =>
          window
            .__canvas!.getSceneElements()
            .filter((e) => ids.includes(e.id) && e.type === "rectangle")
            .map((e) => e.backgroundColor),
        outer.ids,
      ),
    )
    .toEqual(["#a5d8ff"]);
});

test("Alt/Option-drag of a master with the mouse keeps the stationary copy as master", async ({
  page,
}) => {
  await open(page);
  const masterIds = await card(page);
  await select(page, masterIds);
  // Scroll the master clear of the properties panel on the left.
  await page.evaluate(() => {
    const s = window.__canvas!.getAppState();
    window.__canvas!.updateScene({ appState: { scrollX: s.scrollX + 400 } as never });
  });
  const { sx, sy } = await page.evaluate(() => {
    const s = window.__canvas!.getAppState();
    const z = s.zoom.value;
    return {
      sx: (120 + 80 + s.scrollX) * z + s.offsetLeft,
      sy: (120 + 20 + s.scrollY) * z + s.offsetTop,
    };
  });
  await page.mouse.move(sx, sy);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(sx + 150, sy + 200, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Alt");

  await expect
    .poll(async () => (await tagged(page)).filter((e) => e.type === "rectangle").length)
    .toBe(2);
  const rects = (await tagged(page)).filter((e) => e.type === "rectangle");
  expect(rects.find((e) => e.role === "master")?.x).toBe(120);
  expect(rects.find((e) => e.role === "instance")?.x).toBeGreaterThan(200);
  // And the instance follows the stationary master.
  await page.evaluate(
    (id) =>
      window.__e2e!.runSceneTool("update_elements", {
        updates: [{ id, patch: { strokeColor: "#e03131" } }],
      }),
    rects.find((e) => e.role === "master")!.id,
  );
  await expect
    .poll(async () =>
      page.evaluate(() =>
        window
          .__canvas!.getSceneElements()
          .filter((e) => e.type === "rectangle")
          .map((e) => e.strokeColor),
      ),
    )
    .toEqual(["#e03131", "#e03131"]);
});
