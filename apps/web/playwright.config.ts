import { defineConfig, devices } from "@playwright/test";

const port = 3100;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // CI hands over the Build job's output instead of building a second time.
    command: process.env.CI ? `npm run start -- -p ${port}` : `npm run build && npm run start -- -p ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
