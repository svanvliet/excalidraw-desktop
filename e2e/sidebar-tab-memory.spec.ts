import { test, expect, type Page } from "@playwright/test";

/**
 * FR-68: the Library button reopens the default sidebar on the last-used tab (e.g. Components),
 * including in another document tab, instead of always on Excalidraw's Library tab.
 */

const trigger = (page: Page) => page.locator(".excalidraw .sidebar-trigger:visible").first();
const componentsPanel = (page: Page) => page.locator("[data-testid=components-panel]:visible");
const libraryPanel = (page: Page) => page.locator(".layer-ui__library:visible");

test("Library button reopens the sidebar on the last-used tab", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });

  // First open: Excalidraw's Library tab.
  await trigger(page).click();
  await expect(libraryPanel(page)).toHaveCount(1);

  await page.locator("[data-testid=sidebar-tab-components]:visible").click();
  await expect(componentsPanel(page)).toHaveCount(1);
  await page.getByTestId("sidebar-close").click();
  await expect(componentsPanel(page)).toHaveCount(0);

  await trigger(page).click();
  await expect(componentsPanel(page)).toHaveCount(1);
  await page.getByTestId("sidebar-close").click();

  // Another document tab opens there too.
  await page.getByRole("button", { name: "New tab" }).click();
  await trigger(page).click();
  await expect(componentsPanel(page)).toHaveCount(1);

  // Going back to Library is remembered as well.
  await page.locator('.sidebar-tab-trigger[id$="-trigger-library"]:visible').click();
  await expect(libraryPanel(page)).toHaveCount(1);
  await page.getByTestId("sidebar-close").click();
  await trigger(page).click();
  await expect(libraryPanel(page)).toHaveCount(1);
  await expect(componentsPanel(page)).toHaveCount(0);
});
