import { test, expect, type Page } from "@playwright/test";

/**
 * Property-driven text fits its value (docs/components.md §2, FR-56/FR-64), against the real
 * Excalidraw 0.18.1 editor and real web fonts: an instance's text property longer than the
 * master's text is measured with the loaded font, so it isn't clipped at the master's width,
 * a left-aligned slot keeps its x, and a fixed-width slot wraps and grows instead of overflowing.
 */

const NS = "excalidrawDesktop.component";

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("excalidraw-desktop:e2e", "1"));
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__canvas && window.__e2e);
}

const tool = <T>(page: Page, name: string, args: Record<string, unknown>) =>
  page.evaluate(
    async ([name, args]) => {
      const out = await window.__e2e!.runSceneTool(name as string, args as never);
      return JSON.parse((out[0] as { text: string }).text) as unknown;
    },
    [name, args] as const,
  ) as Promise<T>;

interface TextRow {
  x: number;
  width: number;
  height: number;
  text: string;
  autoResize: boolean;
  slot?: string;
}

/** The live instance texts of a component group, keyed by slot. */
const instanceTexts = (page: Page, groupId: string) =>
  page.evaluate(
    ([ns, groupId]) =>
      window
        .__canvas!.getSceneElements()
        .filter((e) => e.type === "text" && e.groupIds.includes(groupId))
        .map((e) => {
          const t = e as unknown as TextRow;
          const tag = e.customData?.[ns] as { slot?: string } | undefined;
          return {
            x: t.x,
            width: t.width,
            height: t.height,
            text: t.text,
            autoResize: t.autoResize,
            slot: tag?.slot,
          };
        }),
    [NS, groupId] as const,
  ) as Promise<TextRow[]>;

/** Width Excalidraw measures for `text` in a family once its font is loaded. */
const measured = (page: Page, text: string, fontFamily: number) =>
  page.evaluate(
    async ([text, fontFamily]) => {
      await document.fonts.ready;
      const [t] = window.__e2e!.convertToExcalidrawElements([
        { type: "text", x: 0, y: 0, text, fontSize: 20, fontFamily },
      ] as never);
      return t.width;
    },
    [text, fontFamily] as const,
  );

test("an instance's long text property isn't clipped at the master's width", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const els = window.__e2e!.convertToExcalidrawElements(
      [
        { type: "rectangle", id: "card", x: 100, y: 100, width: 260, height: 120 },
        { type: "text", id: "name", x: 120, y: 120, text: "Name", fontSize: 20, fontFamily: 6 },
        {
          type: "text",
          id: "title",
          x: 120,
          y: 160,
          text: "Job title",
          fontSize: 20,
          fontFamily: 6,
        },
      ] as never,
      { regenerateIds: false },
    );
    window.__canvas!.updateScene({ elements: els });
  });
  // A fixed-width title: values longer than its box wrap and grow it instead of running out.
  await page.evaluate(() => {
    const els = window
      .__canvas!.getSceneElements()
      .map((e) => (e.id === "title" ? { ...e, autoResize: false, width: 120 } : e));
    window.__canvas!.updateScene({ elements: els as never });
  });

  const created = await tool<{ componentId: string }>(page, "create_component", {
    ids: ["card", "name", "title"],
    name: "Person",
  });
  const cid = created.componentId;
  await tool(page, "define_property", {
    component: cid,
    property: { name: "Name", type: "text", bindings: [{ elementId: "name" }] },
  });
  await tool(page, "define_property", {
    component: cid,
    property: { name: "Title", type: "text", bindings: [{ elementId: "title" }] },
  });
  const inst = await tool<{ groupId: string }>(page, "insert_instance", {
    component: cid,
    x: 500,
    y: 100,
  });
  const before = await instanceTexts(page, inst.groupId);
  const nameBefore = before.find((t) => t.text === "Name")!;
  const titleBefore = before.find((t) => t.text === "Job title")!;
  expect(titleBefore.autoResize).toBe(false);

  const longName = "Casey Jacobs-Montgomery";
  const longTitle = "VP, Xbox Services & Operations";
  await tool(page, "set_properties", {
    instance: inst.groupId,
    values: { Name: longName, Title: longTitle },
  });
  await page.evaluate(() => document.fonts.ready);

  const want = await measured(page, longName, 6);
  expect(want).toBeGreaterThan(nameBefore.width * 2);
  await expect
    .poll(async () => (await instanceTexts(page, inst.groupId)).find((t) => t.text === longName))
    .toMatchObject({ x: nameBefore.x });
  const name = (await instanceTexts(page, inst.groupId)).find((t) => t.text === longName)!;
  expect(Math.abs(name.width - want)).toBeLessThan(2);

  const title = (await instanceTexts(page, inst.groupId)).find(
    (t) => t.text.replace(/\n/g, " ") === longTitle,
  )!;
  expect(title.width).toBeCloseTo(titleBefore.width, 0);
  expect(title.text).toContain("\n");
  expect(title.height).toBeGreaterThan(titleBefore.height * 1.5);
});
