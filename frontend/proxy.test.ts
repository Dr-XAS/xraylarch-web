// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { proxy } from "./proxy"

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("public document session", () => {
  it("sets the session cookie before the page starts parallel API calls", async () => {
    vi.stubEnv("XRAYLARCH_PUBLIC_MODE", "true")
    vi.stubEnv("BACKEND_URL", "http://backend:8006")
    const fetcher = vi.fn().mockResolvedValue(Response.json({ isolated: true }, {
      headers: { "set-cookie": "xraylarch_session=signed; Path=/; Secure; HttpOnly; SameSite=Lax" },
    }))
    vi.stubGlobal("fetch", fetcher)
    const response = await proxy(new NextRequest("https://workbench.test/", {
      headers: { cookie: "other=private; xraylarch_session=previous" },
    }))
    expect(fetcher.mock.calls[0][0].href).toBe("http://backend:8006/api/session")
    expect([...fetcher.mock.calls[0][1].headers.entries()]).toEqual([["cookie", "xraylarch_session=previous"]])
    expect(response.headers.get("set-cookie")).toContain("xraylarch_session=signed")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  it.each([false, "unavailable"])("fails closed when backend isolation is %s", async isolated => {
    vi.stubEnv("XRAYLARCH_PUBLIC_MODE", "true")
    vi.stubGlobal("fetch", isolated === false
      ? vi.fn().mockResolvedValue(Response.json({ isolated: false }))
      : vi.fn().mockRejectedValue(new Error("offline")))
    const response = await proxy(new NextRequest("https://workbench.test/"))
    expect(response.status).toBe(503)
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("leaves trusted local mode unchanged", async () => {
    vi.stubEnv("XRAYLARCH_PUBLIC_MODE", "false")
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    expect((await proxy(new NextRequest("http://localhost/"))).status).toBe(200)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
