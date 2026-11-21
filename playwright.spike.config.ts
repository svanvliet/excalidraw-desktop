import { defineConfig, devices } from "@playwright/test";

/**
 * EXPERIMENTAL: headless perf/undo spike for the derived-sync reactor
 * (docs/reactor-spike.md). Separate from playwright.config.ts so `npm run e2e`
 * never runs it (that config's default testMatch ignores `*.spike.ts`).
 * Run with `npm run e2e:reactor-spike`.
 */
export default defineConfig({
  testDir: "./e2e/spikes",
  testMatch: "*.spike.ts",
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:5179",
    headless: true,
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
  ],
  webServer: {
    command: "npx vite --port 5179 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5179/src/extensions/reactor/spike/index.html",
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
