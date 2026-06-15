import { test, expect } from "@playwright/test";

/**
 * Web-build smoke test.
 *
 * Confirms that the React/Vite layer of the app loads end-to-end against
 * a real browser. Tauri APIs are gracefully unavailable here (the IPC
 * wrappers fall back to safe defaults — see `src/ipc/commands.ts`), so
 * this test exercises the editor UI without touching the OS.
 *
 * Treat this as a regression guard. Heavyweight cross-window tests
 * (file associations, drag-drop, native menus) live in the Tauri-driver
 * suite that's planned for M9.
 */

test.describe("Excalidraw Desktop — web build smoke", () => {
  test("loads and shows the editor shell", async ({ page }) => {
    await page.goto("/");
    // The toolbar always renders.
    await expect(page.getByTestId("toolbar")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("tabbar")).toBeVisible();
    // Excalidraw mounts its canvas as soon as the editor is ready.
    await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  });

  test("opens the settings dialog with every online toggle off", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("toolbar-settings").click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // Privacy invariant: each online toggle starts unchecked.
    await expect(page.getByTestId("toggle-collab")).not.toBeChecked();
    await expect(page.getByTestId("toggle-library")).not.toBeChecked();
    await expect(page.getByTestId("toggle-ai")).not.toBeChecked();
    await page.getByTestId("settings-close").click();
  });

  test("makes zero outbound network requests when every toggle is off", async ({ page }) => {
    // Capture every request the page initiates that targets a host other
    // than the local preview server. If the app stayed offline this list
    // must be empty.
    const remoteRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.startsWith("http://127.0.0.1:4173") || url.startsWith("data:")) return;
      if (url.startsWith("blob:") || url.startsWith("about:")) return;
      remoteRequests.push(`${req.method()} ${url}`);
    });

    await page.goto("/");
    // Give the editor time to mount and any opportunistic fetches a chance
    // to fire before we assert.
    await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);

    expect(
      remoteRequests,
      `Expected no remote requests but saw:\n  ${remoteRequests.join("\n  ")}`,
    ).toHaveLength(0);
  });
});
