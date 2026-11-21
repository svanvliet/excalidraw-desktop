import { test, expect, type Page } from "@playwright/test";

/**
 * Layers tab smoke (docs/requirements.md FR-50): the tab lives in Excalidraw's own default
 * sidebar next to Search / Library, lists frames → groups → elements, selects + reveals on click,
 * renames into customData (one undo step) and toggles locks.
 */

async function drawRect(page: Page, x: number, y: number) {
  const box = (await page.locator(".excalidraw__canvas.interactive").boundingBox())!;
  // Focus the canvas (an empty-area click) so the tool shortcut reaches Excalidraw.
  await page.mouse.click(box.x + box.width - 60, box.y + box.height - 60);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 80, box.y + y + 60, { steps: 4 });
  await page.mouse.up();
}

/** Opens the app and draws the first rectangle once the blank tab has settled (a draw during the
 * initial tab seeding is discarded with the remount, so retry until it lands in history). */
async function openWithRect(page: Page) {
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    await drawRect(page, 420, 200);
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

async function openLayers(page: Page) {
  await page.locator(".excalidraw .sidebar-trigger").first().click();
  await page.getByTestId("sidebar-tab-layers").click();
  // Dock it so clicks on the canvas / toolbar don't dismiss it.
  await page.getByTestId("sidebar-dock").click();
  const panel = page.getByTestId("layers-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("Layers tab lists, selects, renames and locks layers", async ({ page }) => {
  await openWithRect(page);
  await drawRect(page, 580, 200);
  // Group both.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+g");
  await page.keyboard.press("Escape");

  const panel = await openLayers(page);
  const rows = panel.getByRole("treeitem");
  await expect(rows).toHaveCount(3);
  const group = rows.nth(0);
  await expect(group).toHaveAttribute("data-layer-kind", "group");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(rows.nth(1)).toHaveAttribute("aria-level", "2");

  // Click an element inside the group: it alone gets selected (Excalidraw shows its props).
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(group).toHaveAttribute("aria-selected", "false");
  await rows.nth(0).click();
  await expect(group).toHaveAttribute("aria-selected", "true");

  // Rename the group: double-click, type, Enter → one undo step.
  await group.dblclick();
  const input = panel.getByRole("textbox", { name: "Layer name" });
  await input.fill("Header");
  await input.press("Enter");
  await expect(group).toContainText("Header");
  await page.getByTestId("button-undo").click();
  await expect(group.locator(".desktop-layers__label")).toHaveText("Group");
  await page.getByTestId("button-redo").click();
  await expect(group).toContainText("Header");

  // Lock the group: every member locks.
  await group.getByRole("button", { name: "Lock Header" }).click();
  await expect(group.getByRole("button", { name: "Unlock Header" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(rows.nth(1).getByRole("button", { name: /^Unlock / })).toBeVisible();

  // Collapse hides the children.
  await group.getByRole("button", { name: "Collapse" }).click();
  await expect(rows).toHaveCount(1);

  // The built-in Library tab still works beside ours.
  await page.locator(".excalidraw .sidebar-tab-trigger[id$='-trigger-library']").click();
  await expect(page.locator(".excalidraw .layer-ui__library")).toBeVisible();
  await expect(panel).toHaveCount(0);
});

test("Layers tab follows the dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openWithRect(page);
  await expect(page.locator(".excalidraw.theme--dark")).toBeVisible();
  const panel = await openLayers(page);
  const row = panel.getByRole("treeitem").first();
  await expect(row).toContainText("Rectangle");
  // Text color comes from Excalidraw's dark palette, not a hardcoded light value.
  const color = await row.evaluate((el) => getComputedStyle(el).color);
  const [r, g, b] = color.match(/\d+/g)!.map(Number);
  expect(r + g + b).toBeGreaterThan(400);
});
