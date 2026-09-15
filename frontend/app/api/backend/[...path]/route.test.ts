import { afterEach, describe, expect, it, vi } from "vitest"

import { GET, POST } from "./route"

const validParams = { params: Promise.resolve({ path: ["api", "workspaces", "workspace-1", "mapping"] }) }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("backend proxy", () => {
  it("preserves the Athena export revision with attachment bytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# saved data\n8970 1", {
      headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="Cu.xmu"', "x-athena-project-version": "17" },
    })))
    const response = await POST(new Request("http://localhost/api/backend/api/athena/projects/cu/export-data", {
      method: "POST", body: JSON.stringify({ version: 17 }),
    }), { params: Promise.resolve({ path: ["api", "athena", "projects", "cu", "export-data"] }) })
    expect(response.headers.get("x-athena-project-version")).toBe("17")
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="Cu.xmu"')
    expect(await response.text()).toBe("# saved data\n8970 1")
  })
  it("forwards normalized preview mode and repeated encoded IDs without mutating the request or route parameters", async () => {
    vi.stubEnv("BACKEND_URL", "http://backend.test:8010/")
    const nativeId = "Fe/foil ?# μ+"
    const routePath = ["api", "athena", "projects", "project-cu", "preview-project", "upload-1", "groups", nativeId]
    Object.freeze(routePath)
    const query = "?mode=norm&group_ids=Fe%2Ffoil%20%23A&group_ids=native%2Bid%2520&group_ids=Fe%2Ffoil%20%23A&label=Fe+foil%20%CE%BC&empty="
    const request = new Request(`https://frontend.test/api/backend/${routePath.map(encodeURIComponent).join("/")}${query}`, {
      headers: {
        accept: "application/json", "content-type": "application/json", "content-length": "0",
        authorization: "Bearer must-not-forward", cookie: "session=must-not-forward",
      },
    })
    const before = { url: request.url, headers: Array.from(request.headers.entries()), path: [...routePath] }
    const normalized = JSON.stringify({ mode: "norm", x: [8970, 8990], y: [0, 1] })
    // Mirror the backend's default raw mode so dropping the query reproduces the live failure.
    const fetcher = vi.fn(async (url: URL, _options: RequestInit) => new Response(
      url.searchParams.get("mode") === "norm" ? normalized : JSON.stringify({ mode: "mu", x: [8970, 8990], y: [1, 3] }),
      { headers: { "content-type": "application/json" } },
    ))
    vi.stubGlobal("fetch", fetcher)

    const response = await GET(request, { params: Promise.resolve({ path: routePath }) })

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, options] = fetcher.mock.calls[0]
    expect(url.href).toBe(`http://backend.test:8010/api/athena/projects/project-cu/preview-project/upload-1/groups/Fe%2Ffoil%20%3F%23%20%CE%BC%2B${query}`)
    expect(url.searchParams.getAll("group_ids")).toEqual(["Fe/foil #A", "native+id%20", "Fe/foil #A"])
    expect(url.searchParams.get("label")).toBe("Fe foil μ")
    expect(options).toEqual({ method: "GET", headers: expect.any(Headers), body: undefined, cache: "no-store" })
    expect(Array.from((options.headers as Headers).entries())).toEqual([
      ["accept", "application/json"], ["content-length", "0"], ["content-type", "application/json"],
    ])
    expect(options.headers).not.toBe(request.headers)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe(normalized)
    expect({ url: request.url, headers: Array.from(request.headers.entries()), path: routePath }).toEqual(before)
    expect(request.bodyUsed).toBe(false)
  })

  it.each([
    { path: ["api", "athena", "projects", "project-cu", "export"], query: "?format=json&marked_only=true&group_ids=native%2Fone&group_ids=native%2Btwo", type: "application/json", filename: "marked.json" },
    { path: ["api", "athena", "projects", "project-cu", "export"], query: "?format=prj&marked_only=true", type: "application/octet-stream", filename: "marked.prj" },
    { path: ["api", "athena", "projects", "project-cu", "groups", "native/id", "export"], query: "?space=R", type: "text/csv", filename: "spectrum.csv" },
  ])("preserves export query $query and the exact response bytes and attachment headers", async ({ path, query, type, filename }) => {
    vi.stubEnv("BACKEND_URL", "http://backend.test:8010")
    const bytes = new Uint8Array([0, 31, 139, 255, 65, 10])
    const disposition = `attachment; filename="${filename}"; filename*=UTF-8''Fe%20%CE%BC-${filename}`
    const upstreamResponse = new Response(bytes, {
      status: 206,
      headers: { "content-type": type, "content-length": String(bytes.length), "content-disposition": disposition, "set-cookie": "must-not-forward=1" },
    })
    const fetcher = vi.fn().mockResolvedValue(upstreamResponse)
    vi.stubGlobal("fetch", fetcher)
    const encodedPath = `/${path.map(encodeURIComponent).join("/")}`
    const request = new Request(`https://frontend.test/api/backend${encodedPath}${query}`)

    const response = await GET(request, { params: Promise.resolve({ path }) })

    const [url, options] = fetcher.mock.calls[0] as [URL, RequestInit]
    expect(url.href).toBe(`http://backend.test:8010${encodedPath}${query}`)
    expect(options).toEqual({ method: "GET", headers: expect.any(Headers), body: undefined, cache: "no-store" })
    expect(response.status).toBe(206)
    expect(response.headers.get("content-disposition")).toBe(disposition)
    expect(response.headers.get("content-type")).toBe(type)
    expect(response.headers.get("content-length")).toBe(String(bytes.length))
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(upstreamResponse.headers.get("set-cookie")).toBe("must-not-forward=1")
    expect(request.url).toBe(`https://frontend.test/api/backend${encodedPath}${query}`)
  })

  it("keeps the configured upstream origin when the incoming host, headers or query name another URL", async () => {
    const backend = "http://backend.test:8010"
    vi.stubEnv("BACKEND_URL", backend)
    const query = "?BACKEND_URL=https%3A%2F%2Fother.test%2F&url=%2F%2Fother.test%2Fapi&mode=norm"
    const request = new Request(`https://other.test/api/backend/api/athena/projects/project-cu/export${query}`, {
      headers: { host: "other.test", "x-forwarded-host": "other.test" },
    })
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"))
    vi.stubGlobal("fetch", fetcher)

    await GET(request, { params: Promise.resolve({ path: ["api", "athena", "projects", "project-cu", "export"] }) })

    const [url, options] = fetcher.mock.calls[0] as [URL, RequestInit]
    expect(url.origin).toBe(backend)
    expect(url.pathname).toBe("/api/athena/projects/project-cu/export")
    expect(url.search).toBe(query)
    expect(url.hash).toBe("")
    expect(Array.from((options.headers as Headers).entries())).toEqual([])
    expect(process.env.BACKEND_URL).toBe(backend)
  })

  it.each([
    [], ["health", "extra"], ["api", "other"], ["api", "athena", "projects", ".."],
    ["api", "workspaces", "."], ["api", "athena", "", "export"],
  ].map(path => ({ path })))("retains the path allowlist for $path even when query parameters name an allowed path", async ({ path }) => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const request = new Request("https://frontend.test/api/backend/other?path=api%2Fathena%2Fprojects&mode=norm&format=json")

    const response = await GET(request, { params: Promise.resolve({ path }) })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("accepts Next 16 promised route parameters", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetcher)

    const response = await GET(
      new Request("http://localhost/api/backend/api/workspaces"),
      { params: Promise.resolve({ path: ["api", "workspaces"] }) },
    )

    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledOnce()
  })

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

    await GET(request, { params: Promise.resolve({ path: ["api", "workspaces"] }) })

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
      params: Promise.resolve({ path: ["other"] }),
    })

    expect(response.status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ["data.csv", 'attachment; filename="data.csv"'],
    ["recipe.json", 'attachment; filename="recipe.json"'],
  ])("forwards the exact %s attachment name", async (filename, disposition) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("download", {
      headers: {
        "content-disposition": disposition,
        "content-type": filename.endsWith(".csv") ? "text/csv" : "application/json",
      },
    }))
    vi.stubGlobal("fetch", fetcher)
    const response = await GET(
      new Request(`http://localhost/api/backend/api/workspaces/workspace-1/revisions/2/${filename}`),
      { params: Promise.resolve({ path: ["api", "workspaces", "workspace-1", "revisions", "2", filename] }) },
    )

    expect(response.headers.get("content-disposition")).toBe(disposition)
  })
})
