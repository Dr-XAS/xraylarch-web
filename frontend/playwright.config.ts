import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig, devices } from "@playwright/test"

const frontendRoot = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = path.resolve(frontendRoot, "..")
const dataRoot = mkdtempSync(path.join(os.tmpdir(), "xraylarch-web-playwright-"))
const appBasePath = "/advanced-xas/app"
const backendPort = process.env.XRAYLARCH_E2E_BACKEND_PORT ?? "18006"
const frontendPort = process.env.XRAYLARCH_E2E_FRONTEND_PORT ?? "13004"
const testSecret = "playwright-only-integration-secret-32-bytes"

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}${appBasePath}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `.venv/bin/python -m uvicorn xraylarch_web.main:app --host 127.0.0.1 --port ${backendPort}`,
      cwd: path.join(repositoryRoot, "backend"),
      env: {
        XRAYLARCH_DATA_ROOT: dataRoot,
        XRAYLARCH_INTEGRATION_API_ENABLED: "true",
        XRAYLARCH_BROWSER_CONSUME_ENABLED: "true",
        XRAYLARCH_IMPORT_ENABLED: "true",
        XRAYLARCH_INTEGRATION_ISSUER: "playwright-drxas",
        XRAYLARCH_INTEGRATION_AUDIENCE: "playwright-athena",
        XRAYLARCH_INTEGRATION_HMAC_SECRET: testSecret,
        XRAYLARCH_GIT_REVISION: "0123456789abcdef0123456789abcdef01234567",
      },
      url: `http://127.0.0.1:${backendPort}/health`,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --hostname 127.0.0.1 --port ${frontendPort}`,
      cwd: frontendRoot,
      env: {
        BACKEND_URL: `http://127.0.0.1:${backendPort}`,
        NEXT_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
        NEXT_PUBLIC_APP_BASE_PATH: appBasePath,
        NEXT_BUILD_DIR: ".next-e2e",
      },
      url: `http://127.0.0.1:${frontendPort}${appBasePath}`,
      reuseExistingServer: false,
    },
  ],
})
