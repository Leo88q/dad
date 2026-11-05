import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";
import { browserRuntime } from "./scripts/browser-runtime.js";

const runId = randomUUID();
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3221",
    headless: true,
    launchOptions: await browserRuntime(),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1365, height: 900 } } },
    {
      name: "mobile-chromium",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: [
    {
      command: "node server.js",
      url: "http://127.0.0.1:3221/healthz",
      reuseExistingServer: false,
      env: {
        PORT: "3221",
        DATA_DIR: `./data/e2e-${runId}`,
        MAX_BOT_TOKEN: "",
        MAX_ONLY: "false",
      },
      timeout: 15000,
    },
    {
      command: "node server.js",
      url: "http://127.0.0.1:3226/healthz",
      reuseExistingServer: false,
      env: {
        PORT: "3226",
        DATA_DIR: `./data/e2e-max-${runId}`,
        MAX_BOT_TOKEN: "not-a-real-max-token-e2e-fixture",
        MAX_BOT_NAME: "RyadomTestBot",
        MAX_ONLY: "true",
        PUBLIC_URL: "https://ryadom.example.invalid",
      },
      timeout: 15000,
    },
  ],
});
