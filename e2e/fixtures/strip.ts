import { expect, type Page } from "@playwright/test";

/**
 * Opens a properties-panel strip row (FR-63) by its section test id, e.g. "image-props". Rows
 * start collapsed and the accordion keeps one open, so specs open the row they work in.
 */
export async function openStripRow(page: Page, testId: string) {
  const toggle = page.locator(`[data-testid=${testId}-toggle]:visible`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}
