import { afterEach, describe, expect, it } from "vitest"

import { clearIntegrationSession, loadIntegrationSession, parseSafeInternalReturn, saveIntegrationSession, integrationSessionStorageKey } from "./integration-session"

const session = { mode: "integration" as const, projectId: "p1", capability: "browser-capability", allowedOperations: ["read_project"], returnTo: "/analysis/1", sourceGroupId: "g1" }

afterEach(() => sessionStorage.clear())

describe("integration session storage", () => {
  it("round trips only a validated browser session", () => {
    saveIntegrationSession(session)
    expect(loadIntegrationSession()).toEqual(session)
  })

  it("clears malformed and expired session values", () => {
    sessionStorage.setItem(integrationSessionStorageKey, JSON.stringify({ ...session, expiresAt: "2000-01-01T00:00:00Z" }))
    expect(loadIntegrationSession()).toBeNull()
    expect(sessionStorage.getItem(integrationSessionStorageKey)).toBeNull()
  })

  it("rejects owner-shaped capability fields", () => {
    sessionStorage.setItem(integrationSessionStorageKey, JSON.stringify({ ...session, owner_capability: "owner-secret" }))
    expect(loadIntegrationSession()).toBeNull()
  })

  it.each([
    "https://example.test/project", "//example.test/project", "/projects\\escape", "/projects/../admin",
    "/projects/%2e%2e/admin", "/projects/%252e%252e/admin", "/%2f%2fevil.test/path", "/%5cevil",
  ])("rejects an unsafe stored return target: %s", returnTo => {
    sessionStorage.setItem(integrationSessionStorageKey, JSON.stringify({ ...session, returnTo }))
    expect(loadIntegrationSession()).toBeNull()
  })

  it.each([
    "/analysis/1?tab=x#result", "/projects/%E2%82%AC",
  ])("accepts a canonical safe internal return target: %s", returnTo => {
    expect(parseSafeInternalReturn(returnTo)).toBe(returnTo)
  })

  it("rejects duplicate and unknown operations in stored sessions", () => {
    sessionStorage.setItem(integrationSessionStorageKey, JSON.stringify({ ...session, allowedOperations: ["read_project", "read_project"] }))
    expect(loadIntegrationSession()).toBeNull()
    sessionStorage.setItem(integrationSessionStorageKey, JSON.stringify({ ...session, allowedOperations: ["owner"] }))
    expect(loadIntegrationSession()).toBeNull()
  })

  it("clears the tab session", () => {
    saveIntegrationSession(session)
    clearIntegrationSession()
    expect(sessionStorage.getItem(integrationSessionStorageKey)).toBeNull()
  })
})
