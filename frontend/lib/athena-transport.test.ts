import { afterEach, describe, expect, it, vi } from "vitest"

import { createAthenaTransport, type AthenaSession } from "./athena-transport"

const integrated = (values: Partial<Extract<AthenaSession, { mode: "integration" }>> = {}): AthenaSession => ({
  mode: "integration", projectId: "p1", capability: "browser-capability", allowedOperations: ["read_project"], ...values,
})

afterEach(() => vi.restoreAllMocks())

describe("Athena transport", () => {
  it("adds the browser capability to base-path-aware integrated API requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }))
    const transport = createAthenaTransport(integrated(), fetcher)
    await transport.api("/api/athena/projects/p1")
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/backend/api/athena/projects/p1"), expect.anything())
    const headers = fetcher.mock.calls[0][1].headers as Headers
    expect(headers.get("X-XrayLarch-Project-Capability")).toBe("browser-capability")
  })

  it("rejects a different project before fetch without exposing capability", async () => {
    const fetcher = vi.fn()
    const transport = createAthenaTransport(integrated(), fetcher)
    await expect(transport.api("/api/athena/projects/p2")).rejects.toThrow(/project/i)
    expect(fetcher).not.toHaveBeenCalled()
    await expect(transport.api("/api/athena/projects/p2")).rejects.not.toThrow(/browser-capability/)
  })

  it("downloads bytes with a safe server filename and revokes its object URL", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test")
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), {
      headers: { "content-disposition": "attachment; filename*=UTF-8''Fe%20foil.csv" },
    }))
    await createAthenaTransport(integrated(), fetcher).download("/api/athena/projects/p1/export", "fallback.dat")
    expect(click).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(expect.any(Blob))
    expect(revoke).toHaveBeenCalledWith("blob:test")
  })

  it("binds raw fetch responses to the project capability", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("bytes"))
    const response = await createAthenaTransport(integrated(), fetcher).fetch("/api/athena/projects/p1/uploads/u/file")
    expect(await response.text()).toBe("bytes")
    const headers = fetcher.mock.calls[0][1].headers as Headers
    expect(headers.get("X-XrayLarch-Project-Capability")).toBe("browser-capability")
  })

  it("keeps capabilities out of href URLs", () => {
    const href = createAthenaTransport(integrated()).href("/api/athena/projects/p1/export")
    expect(href).not.toContain("browser-capability")
    expect(href).toContain("/api/backend/api/athena/projects/p1/export")
  })

  it.each([
    "/api/athena/projects/p1/../p2", "/api/athena/projects/p1/%2e%2e/p2",
    "/api/athena/projects/p1/%252e%252e/p2", "//api/athena/projects/p1", "/api/athena/preferences/plugins",
  ])("rejects unsafe or non-project integrated path before fetch: %s", async path => {
    const fetcher = vi.fn()
    await expect(createAthenaTransport(integrated(), fetcher).api(path)).rejects.toThrow(/path|project/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not add a capability to legacy requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"))
    await createAthenaTransport({ mode: "legacy" }, fetcher).api("/api/athena/preferences/plugins")
    expect((fetcher.mock.calls[0][1].headers as Headers).get("x-xraylarch-project-capability")).toBeNull()
  })
})
