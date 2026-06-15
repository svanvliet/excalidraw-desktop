import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for E2E smoke tests of the **web build**.
 *
 * We don't run against the packaged Tauri shell here — that requires
 * `tauri-driver` + native WebView automation, which isn't supported
 * on macOS in stable. Tauri-driver-based E2E is tracked in docs/plan.md
 * §M9 (CI release pipeline). Until then, the web-build smoke covers
 * the React/Vite layer (the bulk of the app) end-to-end and gives us a
 * privacy regression test (zero outbound requests when toggles are off).
 *
 * The webServer block starts `npm run preview` automatically; it serves
 * the production Vite bundle on the configured port.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run preview -- --strictPort --port 4173 --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
