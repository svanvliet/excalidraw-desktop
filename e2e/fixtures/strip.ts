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

/**
 * Reveals a strip row that is hidden until used (FR-65), e.g. "shape-data", from the strip's "+"
 * menu; picking it also opens the row.
 */
export async function revealStripRow(page: Page, testId: string) {
  await page.locator("[data-testid=props-strip-more-toggle]:visible").click();
  await page.locator(`[data-testid=props-strip-more-${testId}]:visible`).click();
  await expect(page.locator(`[data-testid=${testId}-toggle]:visible`)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
}
