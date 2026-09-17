import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig, devices } from "@playwright/test"

const frontendRoot = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = path.resolve(frontendRoot, "..")
const dataRoot = mkdtempSync(path.join(os.tmpdir(), "xraylarch-web-playwright-"))
process.env.XRAYLARCH_E2E_DATA_ROOT_INTERNAL = dataRoot
const appBasePath = "/advanced-xas/app"
const backendPort = process.env.XRAYLARCH_E2E_BACKEND_PORT ?? "18006"
const frontendPort = process.env.XRAYLARCH_E2E_FRONTEND_PORT ?? "13004"
// Two serving modes, two dev servers. Every spec but the mounted one navigates to
// absolute origin paths (`page.goto("/")`, `request.get("/api/backend/...")`), which
// 404 the moment the server runs under a base path — so serving the whole suite
// mounted silently broke all 38 of them. Keep the standalone server for those and
// give the mount its own port, so both modes stay qualified.
const mountPort = process.env.XRAYLARCH_E2E_MOUNT_PORT ?? String(Number(frontendPort) + 1)
process.env.XRAYLARCH_E2E_MOUNT_PORT = mountPort
const testSecret = "playwright-only-integration-secret-32-bytes"
const mountedSpec = /integration-mounted\.spec\.ts/

const backendEnv = {
  XRAYLARCH_DATA_ROOT: dataRoot,
  XRAYLARCH_INTEGRATION_API_ENABLED: "true",
  XRAYLARCH_BROWSER_CONSUME_ENABLED: "true",
  XRAYLARCH_IMPORT_ENABLED: "true",
  XRAYLARCH_INTEGRATION_ISSUER: "playwright-drxas",
  XRAYLARCH_INTEGRATION_AUDIENCE: "playwright-athena",
  XRAYLARCH_INTEGRATION_HMAC_SECRET: testSecret,
  XRAYLARCH_GIT_REVISION: "0123456789abcdef0123456789abcdef01234567",
}

const frontendEnv = {
  BACKEND_URL: `http://127.0.0.1:${backendPort}`,
  NEXT_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
}

export default defineConfig({
  testDir: "./tests/e2e",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: mountedSpec,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${frontendPort}` },
    },
    {
      name: "chromium-mounted",
      testMatch: mountedSpec,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${mountPort}` },
    },
  ],
  webServer: [
    {
      command: `.venv/bin/python -m uvicorn xraylarch_web.main:app --host 127.0.0.1 --port ${backendPort}`,
      cwd: path.join(repositoryRoot, "backend"),
      env: backendEnv,
      url: `http://127.0.0.1:${backendPort}/health`,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --hostname 127.0.0.1 --port ${frontendPort}`,
      cwd: frontendRoot,
      env: { ...frontendEnv, NEXT_BUILD_DIR: ".next-e2e" },
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --hostname 127.0.0.1 --port ${mountPort}`,
      cwd: frontendRoot,
      env: { ...frontendEnv, NEXT_PUBLIC_APP_BASE_PATH: appBasePath, NEXT_BUILD_DIR: ".next-e2e-mounted" },
      url: `http://127.0.0.1:${mountPort}${appBasePath}`,
      reuseExistingServer: false,
    },
  ],
})
