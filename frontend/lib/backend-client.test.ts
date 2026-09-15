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
