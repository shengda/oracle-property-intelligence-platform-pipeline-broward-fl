import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4399);
// Playwright ships no Chromium build for older macOS; use the installed Google Chrome there.
const channel = process.platform === "darwin" && !process.env.PW_BUNDLED_CHROMIUM ? "chrome" : undefined;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `npm run ui:build && npx tsx ui/e2e/server.ts`,
    cwd: "..",
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(port) },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel }, testIgnore: /no-webgl/ },
    {
      name: "no-webgl",
      testMatch: /no-webgl/,
      use: {
        ...devices["Desktop Chrome"],
        channel,
        launchOptions: { args: ["--disable-gpu", "--disable-webgl", "--disable-3d-apis"] },
      },
    },
  ],
});
