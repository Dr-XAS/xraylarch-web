import "@testing-library/jest-dom/vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { IntegrationLaunch } from "./integration-launch"

const response = {
  project_id: "p1", capability: "browser-capability", allowed_operations: ["read_project"],
  seed_group: { group_id: "g1", label: "Copper", source: null },
  return_reference: { project_id: "p1", persistent: false },
  project: { contract_version: 2, project_id: "p1", name: "Project", persistent: false, project_version: 1, group_count: 1, file_count: 1, stored_bytes: 100, expires_at: "2099-01-01T00:00:00Z" },
}

beforeEach(() => {
  sessionStorage.clear()
  history.replaceState({}, "", "/integration?launch=one-use-handle&return=%2Fanalysis%2F1")
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear() })

describe("IntegrationLaunch", () => {
  it("scrubs the launch handle before consuming it", async () => {
    const replace = vi.spyOn(history, "replaceState")
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetcher)
    render(<IntegrationLaunch />)
    await screen.findByText(/spectrum/i)
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0])
    expect(location.search).toBe("")
    const saved = JSON.parse(sessionStorage.getItem("xraylarch.integration.session.v2")!)
    expect(Date.parse(saved.expiresAt)).toBeGreaterThan(Date.now())
    expect(Date.parse(saved.expiresAt)).toBeLessThanOrEqual(Date.now() + 300_000)
    expect(saved.returnTo).toBe("/analysis/1")
  })

  it.each([
    { ...response, extra: true },
    { ...response, project_id: "" },
    { ...response, capability: "" },
    { ...response, allowed_operations: ["read_project", "read_project"] },
    { ...response, allowed_operations: ["owner"] },
    { ...response, seed_group: { group_id: "" } },
    { ...response, project: { ...response.project, expires_at: "not-a-date" } },
  ])("rejects an invalid consume response without storing authority", async invalid => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid))))
    render(<IntegrationLaunch />)
    expect(await screen.findByText(/Launch again from Dr\.XAS/i)).toBeInTheDocument()
    expect(sessionStorage.getItem("xraylarch.integration.session.v2")).toBeNull()
  })

  it("rejects an oversized consume response without parsing or storing it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...response, seed_group: { ...response.seed_group, source: { data: "x".repeat(70_000) } } }))))
    render(<IntegrationLaunch />)
    expect(await screen.findByText(/Launch again from Dr\.XAS/i)).toBeInTheDocument()
    expect(sessionStorage.getItem("xraylarch.integration.session.v2")).toBeNull()
  })

  it.each(["/a/../admin", "/a/%2e%2e/admin", "/%2f%2fevil.test"])("rejects unsafe query return target %s before consuming", async returnTo => {
    history.replaceState({}, "", `/integration?launch=one-use-handle&return=${encodeURIComponent(returnTo)}`)
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    render(<IntegrationLaunch />)
    expect(await screen.findByText(/Launch again from Dr\.XAS/i)).toBeInTheDocument()
    expect(location.search).toBe("")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("restores a valid tab session on refresh without consuming again", async () => {
    sessionStorage.setItem("xraylarch.integration.session.v2", JSON.stringify({ mode: "integration", projectId: "p1", capability: "browser-capability", allowedOperations: ["read_project"], expiresAt: "2099-01-01T00:00:00Z" }))
    history.replaceState({}, "", "/integration")
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    render(<IntegrationLaunch />)
    await screen.findByText(/spectrum/i)
    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining("/browser/consume"), expect.anything())
  })

  it("rejects unrelated query parameters before consuming", async () => {
    history.replaceState({}, "", "/integration?launch=one-use-handle&unexpected=value")
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    render(<IntegrationLaunch />)
    expect(await screen.findByText(/Launch again from Dr\.XAS/i)).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("clears a stale return selection before a new launch and when launch fails", async () => {
    sessionStorage.setItem("xraylarch.integration.return-selection.v1", JSON.stringify({ projectId: "old" }))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rejected", { status: 403 })))
    render(<IntegrationLaunch />)
    expect(sessionStorage.getItem("xraylarch.integration.return-selection.v1")).toBeNull()
    expect(await screen.findByText(/Launch again from Dr\.XAS/i)).toBeInTheDocument()
  })

  it("expires mounted authority at the local deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    render(<IntegrationLaunch />)
    await screen.findByText(/spectrum/i)
    expect(sessionStorage.getItem("xraylarch.integration.session.v2")).not.toBeNull()
    await act(async () => { vi.advanceTimersByTime(300_001) })
    expect(screen.getByText(/Launch again from Dr\.XAS/i)).toBeInTheDocument()
    expect(sessionStorage.getItem("xraylarch.integration.session.v2")).toBeNull()
    vi.useRealTimers()
  })

  it("shows a relaunch message for missing or rejected state", async () => {
    history.replaceState({}, "", "/integration")
    render(<IntegrationLaunch />)
    expect(await screen.findByText(/Launch again from Dr\.XAS/i)).toBeInTheDocument()
  })

  it("does not retain a rejected handle or capability", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "not found" }), { status: 404, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetcher)
    render(<IntegrationLaunch />)
    await waitFor(() => expect(screen.getByText(/Launch again from Dr\.XAS/i)).toBeInTheDocument())
    expect(location.search).toBe("")
    expect(sessionStorage.getItem("xraylarch.integration.session.v2")).toBeNull()
  })
})

vi.mock("./athena-workbench", () => ({ AthenaWorkbench: () => <div>Spectrum workbench</div> }))
