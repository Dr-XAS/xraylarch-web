import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig, devices } from "@playwright/test"

const frontendRoot = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = path.resolve(frontendRoot, "..")
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
      cwd: frontendRoot,
      env: { BACKEND_URL: "http://127.0.0.1:18006", NEXT_BUILD_DIR: ".next-e2e" },
      url: "http://127.0.0.1:13004",
      reuseExistingServer: false,
    },
  ],
})
