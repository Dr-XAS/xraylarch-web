import { afterEach, describe, expect, it, vi } from "vitest"

import { BackendClient } from "./backend-client"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("BackendClient", () => {
  it("calls the default browser fetch without binding it to the client", async () => {
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
