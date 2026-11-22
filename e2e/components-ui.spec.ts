import { test, expect, type Page } from "@playwright/test";
import { openStripRow } from "./fixtures/strip";

/**
 * Components UI smoke (docs/components.md § UI, FR-55): make a component with the shortcut, save
 * it to My components from the properties panel, and place it in another drawing from the
 * Components tab. Making a component leaves no master on the canvas: the selection becomes its
 * first instance (FR-64). Edit master… opens the master in a temporary overlay canvas over the
 * drawing (FR-66); Done updates every instance as one undo step, Cancel/Esc changes nothing.
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

/** Changes the master's label inside the open overlay, like a user would. */
async function editOverlayLabel(page: Page, text: string) {
  await page.waitForFunction(() => window.__masterEditor);
  await page.evaluate(
    ([ns, text]) => {
      const api = window.__masterEditor!;
      api.updateScene({
        elements: api.getSceneElementsIncludingDeleted().map((e) => {
          const role = (e.customData?.[ns] as { role?: string } | undefined)?.role;
          return role === "master" && e.type === "text"
            ? { ...e, text, originalText: text, version: e.version + 1 }
            : e;
        }),
        captureUpdate: "IMMEDIATELY" as never,
      });
    },
    [NS, text] as const,
  );
}

const texts = async (page: Page) =>
  (await tagged(page))
    .filter((e) => e.type === "text")
    .map((e) => e.text)
    .sort();

/** A Card plus a second instance placed with the agent tool. */
async function twoCards(page: Page) {
  const componentId = await makeCard(page);
  await page.evaluate(
    async (componentId) =>
      window.__e2e!.runSceneTool("insert_instance", {
        component: componentId,
        x: 500,
        y: 120,
      } as never),
    componentId,
  );
  await expect.poll(() => roles(page)).toEqual(["instance", "instance", "instance", "instance"]);
  return componentId;
}

const overlay = (page: Page) => page.locator("[data-testid=master-edit]");

test("Edit master… opens an overlay; Done updates every instance; one undo reverts", async ({
  page,
}) => {
  await open(page);
  await twoCards(page);
  const all = await tagged(page);
  const group = all.find((e) => e.id === "M")!.groupIds.at(-1)!;
  await select(
    page,
    all.filter((e) => e.groupIds.includes(group)).map((e) => e.id),
  );
  await openStripRow(page, "component-props");
  await page.locator("[data-testid=component-edit-master]:visible").click();
  await expect(overlay(page)).toBeVisible();
  await expect(page.getByTestId("master-edit-header")).toContainText("“Component”");
  await expect(page.getByTestId("master-edit-header")).toContainText("2 instances");
  // The drawing never holds the master, not even while editing it.
  expect(await roles(page)).toEqual(["instance", "instance", "instance", "instance"]);

  await editOverlayLabel(page, "Edited");
  await page.getByTestId("master-edit-done").click();
  await expect(overlay(page)).toHaveCount(0);
  await expect.poll(() => texts(page)).toEqual(["Edited", "Edited"]);
  expect(await roles(page)).toEqual(["instance", "instance", "instance", "instance"]);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => texts(page)).toEqual(["Card", "Card"]);
});

test("Cancel and Escape leave the drawing untouched", async ({ page }) => {
  await open(page);
  await twoCards(page);
  const before = await page.evaluate(() =>
    window.__canvas!.getSceneElementsIncludingDeleted().map((e) => [e.id, e.version]),
  );
  await page.locator(".excalidraw .sidebar-trigger:visible").first().click();
  await page.locator("[data-testid=sidebar-tab-components]:visible").click();
  await page.getByRole("button", { name: "Edit the master of Component", exact: true }).click();
  await expect(overlay(page)).toBeVisible();
  await editOverlayLabel(page, "Nope");
  await page.getByTestId("master-edit-cancel").click();
  await expect(overlay(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Edit the master of Component", exact: true }).click();
  await expect(overlay(page)).toBeVisible();
  await page.evaluate(() =>
    window.__masterEditor!.updateScene({ appState: { selectedElementIds: {} } as never }),
  );
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);

  expect(
    await page.evaluate(() =>
      window.__canvas!.getSceneElementsIncludingDeleted().map((e) => [e.id, e.version]),
    ),
  ).toEqual(before);
  expect(await texts(page)).toEqual(["Card", "Card"]);
});

test("library-linked instance: Edit master…, Done updates the instance", async ({ page }) => {
  await open(page);
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
  await expect(overlay(page)).toBeVisible();
  await expect(page.getByTestId("master-edit-update-library")).toBeChecked();
  await editOverlayLabel(page, "Edited");
  await page.getByTestId("master-edit-done").click();

  await expect(overlay(page)).toHaveCount(0);
  await expect.poll(() => roles(page)).toEqual(["instance", "instance"]);
  await expect.poll(() => texts(page)).toEqual(["Edited"]);
});

/** Edits the elements matching `ids` like a user would (one undoable step). */
async function userEdit(page: Page, ids: string[], patch: Record<string, unknown>) {
  await page.evaluate(
    ([ids, patch]) =>
      window.__canvas!.updateScene({
        elements: window
          .__canvas!.getSceneElementsIncludingDeleted()
          .map((e) => (ids.includes(e.id) ? { ...e, ...patch, version: e.version + 1 } : e)),
        captureUpdate: "IMMEDIATELY" as never,
      }),
    [ids, patch] as const,
  );
}

const fontSizes = (page: Page) =>
  page.evaluate(() =>
    window
      .__canvas!.getSceneElements()
      .filter((e) => e.type === "text")
      .map((e) => ({
        text: (e as { text: string }).text,
        fontSize: (e as { fontSize: number }).fontSize,
        group: e.groupIds.at(-1),
      })),
  );

test("Reset overrides resets only that instance's look and keeps its text (FR-67)", async ({
  page,
}) => {
  await open(page);
  await twoCards(page);
  const all = await tagged(page);
  const group = all.find((e) => e.id === "M")!.groupIds.at(-1)!;
  const label = all.find((e) => e.type === "text" && e.groupIds.includes(group))!;
  await userEdit(page, [label.id], { text: "Magnus", originalText: "Magnus" });
  await userEdit(page, [label.id], { fontSize: 40 });
  await expect
    .poll(async () => (await fontSizes(page)).map((t) => [t.text, t.fontSize]).sort())
    .toEqual([
      ["Card", 20],
      ["Magnus", 40],
    ]);

  await select(
    page,
    all.filter((e) => e.groupIds.includes(group)).map((e) => e.id),
  );
  await openStripRow(page, "component-props");
  await expect(page.locator("[data-testid=component-override]:visible")).toContainText("font size");
  await page.locator("[data-testid=component-reset]:visible").click();
  await expect
    .poll(async () => (await fontSizes(page)).map((t) => [t.text, t.fontSize]).sort())
    .toEqual([
      ["Card", 20],
      ["Magnus", 20],
    ]);
  await expect(page.locator("[data-testid=component-reset]:visible")).toBeDisabled();

  // The master kept its own look: Edit master… shows the original size.
  await page.locator("[data-testid=component-edit-master]:visible").click();
  await expect(overlay(page)).toBeVisible();
  await page.waitForFunction(() => window.__masterEditor);
  const masterSizes = await page.evaluate(() =>
    window
      .__masterEditor!.getSceneElements()
      .filter((e) => e.type === "text")
      .map((e) => (e as { fontSize: number }).fontSize),
  );
  expect(masterSizes.length).toBeGreaterThan(0);
  expect(masterSizes.every((s) => s === 20)).toBe(true);
  await page.getByTestId("master-edit-cancel").click();
});
