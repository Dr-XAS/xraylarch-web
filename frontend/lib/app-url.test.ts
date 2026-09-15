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
