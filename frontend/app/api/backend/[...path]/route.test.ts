import { afterEach, describe, expect, it, vi } from "vitest"

import { GET, POST } from "./route"

const validParams = { params: { path: ["api", "workspaces", "workspace-1", "mapping"] } }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("backend proxy", () => {
  it("forwards a POST body with the Node duplex requirement", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "content-type": "application/json" },
    }))
    vi.stubGlobal("fetch", fetcher)
    const request = new Request("http://localhost/api/backend/api/workspaces/workspace-1/mapping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"energy_column":"energy"}',
    })

    await POST(request, validParams)

    const init = fetcher.mock.calls[0][1] as RequestInit & { duplex?: string }
    expect(init.body).toBe(request.body)
    expect(init.duplex).toBe("half")
  })

  it("forwards only allowed request headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"))
    vi.stubGlobal("fetch", fetcher)
    const request = new Request("http://localhost/api/backend/api/workspaces", {
      headers: {
        accept: "application/json",
        authorization: "Bearer must-not-forward",
        cookie: "session=must-not-forward",
        "content-type": "application/json",
      },
    })

    await GET(request, { params: { path: ["api", "workspaces"] } })

    const headers = fetcher.mock.calls[0][1]?.headers as Headers
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("cookie")).toBeNull()
  })

  it("rejects paths outside the backend allowlist before fetching", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)

    const response = await GET(new Request("http://localhost/api/backend/other"), {
      params: { path: ["other"] },
    })

    expect(response.status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
