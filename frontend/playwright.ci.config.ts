import { defineConfig } from "@playwright/test"

import base from "./playwright.config"

// Reuse the isolated backend and mounted integration server from the full suite.
// The scientific workflow exercises the production build produced by `npm run build`.
if (!Array.isArray(base.webServer)) throw new Error("The full E2E suite must configure backend and frontend servers.")
const [backend, standalone, mounted] = base.webServer

export default defineConfig({
  ...base,
  testMatch: ["**/athena-scientific-workflow.spec.ts", "**/athena-quality-report.spec.ts", "**/athena-comparison-report.spec.ts", "**/artemis-project-persistence.spec.ts", "**/integration-mounted.spec.ts"],
  forbidOnly: true,
  use: { ...base.use, channel: process.env.XRAYLARCH_E2E_BROWSER_CHANNEL },
  webServer: [
    backend,
    {
      ...standalone,
      command: standalone.command.replace("npm run dev", "npm run start"),
      env: { ...standalone.env, NEXT_BUILD_DIR: process.env.NEXT_BUILD_DIR ?? ".next" },
    },
    mounted,
  ],
})
