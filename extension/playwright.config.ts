import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const reportRoot = process.env.KG_TEST_REPORT_DIR ? resolve(process.env.KG_TEST_REPORT_DIR) : resolve(__dirname, 'test-results');

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["json", { outputFile: resolve(reportRoot, "e2e-results.json") }]],
  outputDir: resolve(reportRoot, "artifacts"),
  use: {
    baseURL: "http://127.0.0.1:5173",
    channel: "chrome",
    headless: true,
    viewport: { width: 480, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  }
});
