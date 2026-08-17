import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { defineConfig, devices } from "@playwright/test"

const repositoryRoot = path.resolve(__dirname, "..")
const dataRoot = mkdtempSync(path.join(os.tmpdir(), "xraylarch-web-playwright-"))

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:13004",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: ".venv/bin/python -m uvicorn xraylarch_web.main:app --host 127.0.0.1 --port 18006",
      cwd: path.join(repositoryRoot, "backend"),
      env: { XRAYLARCH_DATA_ROOT: dataRoot },
      url: "http://127.0.0.1:18006/health",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 13004",
      cwd: __dirname,
      env: { BACKEND_URL: "http://127.0.0.1:18006" },
      url: "http://127.0.0.1:13004",
      reuseExistingServer: false,
    },
  ],
})
