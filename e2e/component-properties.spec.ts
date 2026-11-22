import { test, expect, type Page } from "@playwright/test";
import { openStripRow } from "./fixtures/strip";

/**
 * Component properties + nested components smoke (docs/components.md §4b–4c, FR-56/FR-57,
 * FR-64), against the real Excalidraw 0.18.1 editor: declare a property while editing the
 * off-canvas master and set it on an instance from the Component row (one undo step), set a nested
 * Card's property from an outer Panel instance, and an Alt/Option-drag of an instance with the real
 * mouse places another instance that follows master edits.
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
  // Create makes the first instance; the master lives off-canvas (FR-64).
  await expect
    .poll(async () => (await tagged(page)).find((e) => e.id === "M")?.role)
    .toBe("instance");
  return (await tagged(page)).filter((e) => e.role === "instance").map((e) => e.id);
}

const componentIdOf = (page: Page, id: string) =>
  page.evaluate(
    ([ns, id]) =>
      (
        window.__canvas!.getSceneElements().find((e) => e.id === id)!.customData![ns] as {
          componentId: string;
        }
      ).componentId,
    [NS, id] as const,
  );

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
  const instIds = await card(page);
  await select(page, instIds);
  await openStripRow(page, "component-props");
  await tid(page, "component-edit-master").click();
  // The master is edited in the overlay (FR-66); declare the property there.
  await expect(tid(page, "master-edit-header")).toBeVisible();
  await page.waitForFunction(() => window.__masterEditor);
  await page.evaluate((ns) => {
    const api = window.__masterEditor!;
    const ids = api
      .getSceneElements()
      .filter((e) => (e.customData?.[ns] as { role?: string } | undefined)?.role === "master")
      .map((e) => e.id);
    const groupId = api
      .getSceneElements()
      .find((e) => e.id === ids[0])!
      .groupIds.at(-1)!;
    api.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
        selectedGroupIds: { [groupId]: true },
      } as never,
    });
  }, NS);
  const inOverlay = (id: string) =>
    page.locator(`[data-testid=master-edit] [data-testid=${id}]:visible`);
  const toggle = inOverlay("component-props-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await inOverlay("propdef-name").fill("Title");
  await inOverlay("propdef-add").click();
  await expect(inOverlay("propdef-remove-Title")).toBeVisible();
  await tid(page, "master-edit-done").click();
  await expect(tid(page, "master-edit-header")).toHaveCount(0);
  expect((await tagged(page)).filter((e) => e.role === "master")).toEqual([]);

  await select(page, instIds);
  await openStripRow(page, "component-props");
  const field = tid(page, "propval-own-Title");
  await field.fill("Hello");
  await field.press("Enter");
  await expect.poll(async () => textOf(page, "instance")).toBe("Hello");
  await expect(tid(page, "propval-reset-own-Title")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(async () => textOf(page, "instance")).toBe("Card");
});

test("an outer Panel instance sets its nested Card's property", async ({ page }) => {
  await open(page);
  await card(page);
  const cardId = await componentIdOf(page, "M");
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
  await openStripRow(page, "component-props");
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
  const master = await tool<{ elements: { slot: string; type: string }[] }>(
    page,
    "get_component_master",
    { component: cardId },
  );
  await tool(page, "edit_component_master", {
    component: cardId,
    updates: [
      {
        slot: master.elements.find((e) => e.type === "rectangle")!.slot,
        patch: { backgroundColor: "#a5d8ff" },
      },
    ],
  });
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

test("Alt/Option-drag of an instance with the mouse places another instance", async ({ page }) => {
  await open(page);
  const instIds = await card(page);
  await select(page, instIds);
  // Scroll the instance clear of the properties panel on the left.
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
  expect(rects.every((e) => e.role === "instance")).toBe(true);
  expect(rects.map((e) => e.x).sort((a, b) => a - b)[0]).toBe(120);
  expect(rects.some((e) => e.x > 200)).toBe(true);
  // And both follow a master edit.
  const cid = await componentIdOf(page, "M");
  const master = await tool<{ elements: { slot: string; type: string }[] }>(
    page,
    "get_component_master",
    { component: cid },
  );
  await tool(page, "edit_component_master", {
    component: cid,
    updates: [
      {
        slot: master.elements.find((e) => e.type === "rectangle")!.slot,
        patch: { strokeColor: "#e03131" },
      },
    ],
  });
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

test("a slot a choice hides in every instance survives Edit master… Done (FR-69)", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const els = window.__e2e!.convertToExcalidrawElements(
      [
        { type: "rectangle", id: "M", x: 120, y: 120, width: 160, height: 80 },
        { type: "ellipse", id: "E", x: 300, y: 140, width: 40, height: 40 },
      ] as never,
      { regenerateIds: false },
    );
    window.__canvas!.updateScene({ elements: els, captureUpdate: "IMMEDIATELY" as never });
  });
  const created = await tool<{ componentId: string; groupId: string }>(page, "create_component", {
    ids: ["M", "E"],
    name: "Avatar card",
  });
  const cid = created.componentId;
  await tool(page, "define_property", {
    component: cid,
    property: {
      name: "Avatar",
      type: "choice",
      options: ["photo", "initials"],
      default: "photo",
      bindings: [{ elementId: "E", key: "visible", map: { photo: false, initials: true } }],
    },
  });
  const other = await tool<{ groupId: string; ids: string[] }>(page, "insert_instance", {
    component: cid,
    x: 120,
    y: 320,
  });
  const ellipses = async () => (await tagged(page)).filter((e) => e.type === "ellipse");
  await expect.poll(async () => (await ellipses()).length).toBe(0);

  const first = (await tagged(page)).filter((e) => e.role && !other.ids.includes(e.id));
  await select(
    page,
    first.map((e) => e.id),
  );
  await openStripRow(page, "component-props");
  await tid(page, "component-edit-master").click();
  await expect(tid(page, "master-edit-header")).toBeVisible();
  await page.waitForFunction(() => window.__masterEditor);
  // The overlay's master has the slot no instance shows; recolor the card and apply.
  expect(
    await page.evaluate((ns) => {
      const api = window.__masterEditor!;
      const master = api.getSceneElements().filter((e) => e.customData?.[ns]);
      api.updateScene({
        elements: api
          .getSceneElementsIncludingDeleted()
          .map((e) =>
            master.includes(e) && e.type === "rectangle"
              ? { ...e, backgroundColor: "#a5d8ff", version: e.version + 1 }
              : e,
          ),
        captureUpdate: "IMMEDIATELY" as never,
      });
      return master.map((e) => e.type).sort();
    }, NS),
  ).toEqual(["ellipse", "rectangle"]);
  await tid(page, "master-edit-done").click();
  await expect(tid(page, "master-edit-header")).toHaveCount(0);

  await tool(page, "set_properties", { instance: other.groupId, values: { Avatar: "initials" } });
  await expect.poll(async () => (await ellipses()).length).toBe(1);
  expect((await ellipses())[0].groupIds).toContain(other.groupId);
});
