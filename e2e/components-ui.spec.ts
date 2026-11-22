import { test, expect, type Page } from "@playwright/test";
import { openStripRow } from "./fixtures/strip";

/**
 * Components UI smoke (docs/components.md § UI, FR-55): make a component with the shortcut, save
 * it to My components from the properties panel, and place it in another drawing from the
 * Components tab. Making a component leaves no master on the canvas: the selection becomes its
 * first instance (FR-64). With library-backed masters, insert places only an instance, Edit
 * master… → Done updates the instance and takes the master away again.
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
  text?: string;
  role?: string;
  componentId?: string;
  groupIds: readonly string[];
}

const tagged = (page: Page) =>
  page.evaluate(
    (ns) =>
      window.__canvas!.getSceneElements().map((e) => {
        const t = e.customData?.[ns] as { role?: string; componentId?: string } | undefined;
        return {
          id: e.id,
          type: e.type,
          text: (e as { text?: string }).text,
          role: t?.role,
          componentId: t?.componentId,
          groupIds: e.groupIds,
        };
      }),
    NS,
  ) as Promise<Tagged[]>;

const roles = async (page: Page) => (await tagged(page)).map((e) => e.role ?? "-").sort();

/** A "Card" (rectangle + bound text) turned into a component with Alt/Option+Cmd/Ctrl+K: the
 * selection becomes the first instance, with no master on the canvas. */
async function makeCard(page: Page): Promise<string> {
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
    .toBe("instance");
  expect(await roles(page)).toEqual(["instance", "instance"]);
  return (await tagged(page)).find((e) => e.id === "M")!.componentId!;
}

/** Selects elements like a user selection of the whole group (the properties panel follows). */
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

async function newDrawingWithComponentsTab(page: Page) {
  await page.getByRole("button", { name: "New tab" }).click();
  await expect.poll(async () => (await tagged(page)).length).toBe(0);
  await page.locator(".excalidraw .sidebar-trigger:visible").first().click();
  await page.locator("[data-testid=sidebar-tab-components]:visible").click();
  await expect(page.locator("[data-testid=components-panel]:visible")).toHaveCount(1);
}

test("save a component to My components and place it in another drawing", async ({ page }) => {
  await open(page);
  const componentId = await makeCard(page);
  await select(
    page,
    (await tagged(page)).map((e) => e.id),
  );
  await openStripRow(page, "component-props");
  await page.getByTestId("component-save").click();
  await expect(page.getByTestId("component-save")).toHaveText("Update in My components");
  expect(await roles(page)).toEqual(["instance", "instance"]);

  await newDrawingWithComponentsTab(page);
  const libraryMasters = await page.evaluate(() => window.__e2e!.libraryMasters);
  await page.locator(`[data-testid=component-mine-${componentId}]:visible`).click();
  // Without library masters the master comes along (beside the instance); with them, only an
  // instance linked to My components is placed.
  await expect
    .poll(() => roles(page))
    .toEqual(
      libraryMasters ? ["instance", "instance"] : ["instance", "instance", "master", "master"],
    );
  const texts = (await tagged(page)).filter((e) => e.type === "text").map((e) => e.text);
  expect(new Set(texts)).toEqual(new Set(["Card"]));
});

test("library master: insert, Edit master…, Done updates the instance", async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => window.__e2e!.libraryMasters)).toBe(true);
  const componentId = await makeCard(page);
  await select(
    page,
    (await tagged(page)).map((e) => e.id),
  );
  await openStripRow(page, "component-props");
  await page.getByTestId("component-save").click();
  await expect(page.getByTestId("component-save")).toHaveText("Update in My components");

  await newDrawingWithComponentsTab(page);
  await page.locator(`[data-testid=component-mine-${componentId}]:visible`).click();
  await expect.poll(() => roles(page)).toEqual(["instance", "instance"]);

  await select(
    page,
    (await tagged(page)).map((e) => e.id),
  );
  await page.locator("[data-testid=component-edit-master]:visible").click();
  await expect(page.locator("[data-testid=master-edit-banner]:visible")).toBeVisible();
  await expect.poll(async () => (await roles(page)).filter((r) => r === "master").length).toBe(2);

  // Edit the master's label like a user would; the engine syncs it to the instance.
  await page.evaluate((ns) => {
    const api = window.__canvas!;
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((e) => {
        const role = (e.customData?.[ns] as { role?: string } | undefined)?.role;
        return role === "master" && e.type === "text"
          ? { ...e, text: "Edited", originalText: "Edited", version: e.version + 1 }
          : e;
      }),
      captureUpdate: "IMMEDIATELY" as never,
    });
  }, NS);
  await page.locator("[data-testid=master-edit-done]:visible").click();

  await expect(page.locator("[data-testid=master-edit-banner]:visible")).toHaveCount(0);
  await expect.poll(() => roles(page)).toEqual(["instance", "instance"]);
  await expect
    .poll(async () => (await tagged(page)).find((e) => e.type === "text")?.text)
    .toBe("Edited");
});
