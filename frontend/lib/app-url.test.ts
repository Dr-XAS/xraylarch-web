import { afterEach, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it.each([
  ["", "/api/backend/health", "/api/backend/health"],
  ["/advanced-xas/app", "/api/backend/health", "/advanced-xas/app/api/backend/health"],
])("prefixes internal URLs", async (basePath, path, expected) => {
  vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", basePath)
  vi.resetModules()
  const { appUrl } = await import("./app-url")
  expect(appUrl(path)).toBe(expected)
})

it.each(["https://other.test/x", "//other.test/x", "/../secret"])(
  "rejects unsafe internal paths",
  async (path) => {
    const { appUrl } = await import("./app-url")
    expect(() => appUrl(path)).toThrow()
  },
)

it.each(["/advanced//app", "/advanced-xas/app?draft=1", "/advanced-xas/app#top", "/advanced-xas\\app"])(
  "rejects malformed base paths",
  async (basePath) => {
    vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", basePath)
    vi.resetModules()
    await expect(import("./app-url")).rejects.toThrow("NEXT_PUBLIC_APP_BASE_PATH")
  },
)

it.each([
  ["", "/projects/p/parameter-report", "/api/backend/api/athena/projects/p/parameter-report"],
  ["", "/projects/p/export-data", "/api/backend/api/athena/projects/p/export-data"],
  ["", "/projects/p/uploads/u/file", "/api/backend/api/athena/projects/p/uploads/u/file"],
  ["/advanced-xas/app", "/projects/p/parameter-report", "/advanced-xas/app/api/backend/api/athena/projects/p/parameter-report"],
  ["/advanced-xas/app", "/projects/p/export-data", "/advanced-xas/app/api/backend/api/athena/projects/p/export-data"],
  ["/advanced-xas/app", "/projects/p/uploads/u/file", "/advanced-xas/app/api/backend/api/athena/projects/p/uploads/u/file"],
])("builds root and mounted Athena report, export, and upload URLs", async (basePath, path, expected) => {
  vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", basePath)
  vi.resetModules()
  const { apiBase } = await import("./athena")
  expect(`${apiBase}${path}`).toBe(expected)
})
