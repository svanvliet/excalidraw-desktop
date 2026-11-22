import { test, expect, type Page } from "@playwright/test";

/**
 * FR-62 / D-DX16 regression: a pinned (docked) sidebar must survive opening and closing the AI
 * panel. The 360px AI panel used to shrink the editor below Excalidraw's default 1229px docking
 * breakpoint, turning the pinned sidebar into an overlay that the next outside click closed.
 */

async function openWithAi(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("toggle-ai").check();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("toolbar-agent")).toBeVisible();
}

async function pinSidebar(page: Page, tab?: string) {
  await page.locator(".excalidraw .sidebar-trigger").first().click();
  if (tab) await page.getByTestId(`sidebar-tab-${tab}`).click();
  await page.getByTestId("sidebar-dock").click();
  await expect(page.locator(".excalidraw .sidebar.sidebar--docked")).toBeVisible();
}

async function openAiAndClickInside(page: Page) {
  await page.getByTestId("toolbar-agent").click();
  const panel = page.getByTestId("agent-panel");
  await expect(panel).toBeVisible();
  await page.getByTestId("agent-transcript").click();
  return panel;
}

async function closeAi(page: Page) {
  await page.getByTestId("agent-close").click();
  await expect(page.getByTestId("agent-panel")).toHaveCount(0);
}

test.describe("pinned sidebar and the AI panel", () => {
  test("pinned Library stays docked at 1440px", async ({ page }) => {
    await openWithAi(page, 1440);
    await pinSidebar(page);
    await expect(page.locator(".excalidraw .layer-ui__library")).toBeVisible();

    await openAiAndClickInside(page);
    // Still docked (the dock toggle only renders while the sidebar can dock).
    await expect(page.locator(".excalidraw .sidebar.sidebar--docked")).toBeVisible();
    await expect(page.getByTestId("sidebar-dock")).toBeVisible();

    await closeAi(page);
    await expect(page.locator(".excalidraw .sidebar.sidebar--docked")).toBeVisible();
    await expect(page.locator(".excalidraw .layer-ui__library")).toBeVisible();
  });

  test("pinned custom tab (Layers) stays docked at 1440px", async ({ page }) => {
    await openWithAi(page, 1440);
    await pinSidebar(page, "layers");

    await openAiAndClickInside(page);
    await expect(page.getByTestId("layers-panel")).toBeVisible();
    await closeAi(page);
    await expect(page.getByTestId("layers-panel")).toBeVisible();
    await expect(page.locator(".excalidraw .sidebar.sidebar--docked")).toBeVisible();
  });

  test("a narrow window reopens the pinned sidebar when the AI panel closes", async ({ page }) => {
    // 1110 − 360 = 750px editor, below the 760px breakpoint (but above Excalidraw's 730px mobile
    // layout): the sidebar turns into an overlay and closes on the click inside the AI panel,
    // then comes back when the panel closes.
    await openWithAi(page, 1110);
    await pinSidebar(page);

    await openAiAndClickInside(page);
    await expect(page.locator(".excalidraw .sidebar")).toHaveCount(0);

    await closeAi(page);
    await expect(page.locator(".excalidraw .sidebar.sidebar--docked")).toBeVisible();
    await expect(page.locator(".excalidraw .layer-ui__library")).toBeVisible();
  });
});
