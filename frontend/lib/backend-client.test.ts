import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("BackendClient", () => {
  it("calls the default browser fetch without binding it to the client", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "")
    vi.resetModules()
    const { BackendClient } = await import("./backend-client")
    const nativeStyleFetch = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation")
      return Promise.resolve(new Response(JSON.stringify({
        workspace_id: "workspace-1",
        active_revision_id: null,
        revisions: [],
        active_result: null,
      })))
    })
    vi.stubGlobal("fetch", nativeStyleFetch)

    await expect(new BackendClient().createWorkspace()).resolves.toMatchObject({ workspace_id: "workspace-1" })
    expect(nativeStyleFetch).toHaveBeenCalledWith("/api/backend/api/workspaces", { method: "POST" })
  })
})

describe("decodeApiError", () => {
  it("keeps the backend's error envelope", async () => {
    const { decodeApiError } = await import("./backend-client")
    const error = decodeApiError(409, { error: { code: "stale_revision", message: "Changed elsewhere.", fields: ["version"], recovery: "Reload." } })
    expect(error).toMatchObject({ status: 409, code: "stale_revision", message: "Changed elsewhere.", fields: ["version"], recovery: "Reload." })
  })

  it("shows a FastAPI HTTPException detail instead of the generic failure", async () => {
    const { decodeApiError } = await import("./backend-client")
    const error = decodeApiError(409, { detail: "Integration project byte quota is exhausted." })
    expect(error).toMatchObject({ status: 409, code: "http_409", message: "Integration project byte quota is exhausted." })
  })

  it.each([undefined, "plain text", { detail: ["loc"] }, { detail: "  " }, { error: "Not found" }])("falls back for an unrecognised body: %j", async body => {
    const { decodeApiError } = await import("./backend-client")
    expect(decodeApiError(500, body)).toMatchObject({ code: "api_request_failed", message: "The backend request could not be completed." })
  })
})
