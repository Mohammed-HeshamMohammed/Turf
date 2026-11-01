import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 2,
  fullyParallel: true,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5205",
    browserName: "chromium",
    launchOptions: process.env.CALLERWHALE_BROWSER_EXECUTABLE
      ? { executablePath: process.env.CALLERWHALE_BROWSER_EXECUTABLE }
      : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5205 --strictPort",
    url: "http://127.0.0.1:5205",
    reuseExistingServer: !process.env.CI,
  },
});
