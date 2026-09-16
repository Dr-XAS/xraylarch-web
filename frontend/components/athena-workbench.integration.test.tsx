import "@testing-library/jest-dom/vitest"

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AthenaProject, Parameters } from "@/lib/athena"
import { AthenaProvider } from "@/lib/athena-context"
import { AthenaPointEdit } from "./athena-point-edit"
import { AthenaProjectImport, type ProjectPreview } from "./athena-project-import"
import { AthenaWorkbench } from "./athena-workbench"

vi.mock("next/dynamic", () => ({ default: () => () => null }))

const parameters: Parameters = {
  e0: 8979, step: null, pre1: -150, pre2: -30, norm1: 100, norm2: 300,
  nnorm: 2, flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null,
  bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1, kmin: 3, kmax: 12,
  kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05,
}

function eligibleProject(): AthenaProject {
  return {
    id: "integrated-project", name: "Read only", version: 7, journal: "",
    updated: "2026-09-16T00:00:00Z", undo: [], redo: [], history: [],
    groups: [{
      id: "sample", label: "EXAFS sample", marked: true, frozen: false,
      data_type: "mu", energy: [8960, 8980, 9000], mu: [0.1, 0.8, 1.1],
      multiplier: 1, offset: 0, notes: "", reference_id: null,
      parameters: { ...parameters }, processing_error: null, source: {},
      result: {
        arrays: {
          energy: [8960, 8980, 9000], norm: [0, 0.7, 1],
          k: [0, 1, 2, 3], chi: [0, 2, -1, 1], r: [0, 1, 2],
          chir_mag: [2, 3, 2], chir_re: [1, 1, 1], chir_im: [1, 2, 1], chir_pha: [0, 1, 2],
        },
        effective: { e0: 8979, edge_step: 1, kweight: 2 }, warnings: [],
      },
    }],
  }
}

function pointEditPreview(project: AthenaProject, body: string) {
  const request = JSON.parse(body) as { options: { mode: string, scope: string } }
  const group = project.groups[0]
  const removed = request.options.mode === "inspect" ? [] : [1]
  const kept = group.energy.map((_, index) => index).filter(index => !removed.includes(index))
  return {
    project_id: project.id, version: project.version, options: request.options,
    skipped_reasons: {}, changed_group_ids: removed.length ? [group.id] : [],
    results: [{
      group_id: group.id, label: group.label, kept_indices: kept, removed_indices: removed,
      energy: kept.map(index => group.energy[index]), mu: kept.map(index => group.mu[index]),
      selected_energy: removed.map(index => group.energy[index]), selected_mu: removed.map(index => group.mu[index]),
      input_points: group.energy.length, output_points: kept.length, snapped: null, processing_error: null, margins: null,
      original: { mu: { x: group.energy, y: group.mu }, chie: null },
      modified: { mu: { x: kept.map(index => group.energy[index]), y: kept.map(index => group.mu[index]) }, chie: null },
      selected_chie: null,
    }],
  }
}

const pointEditSession = {
  mode: "integration" as const, projectId: "integrated-project", capability: "point-edit-capability",
  allowedOperations: ["preview"], expiresAt: "2099-01-01T00:00:00Z",
}

function pointEdit(project: AthenaProject, allowedActions: { preview: boolean, deglitch: boolean, truncate: boolean, undo: boolean, redo: boolean }) {
  return <AthenaPointEdit project={project} activeId="sample" selectGroup={vi.fn()} initialMode="point" rememberDraft={vi.fn()}
    setBusy={vi.fn()} disabled={false} allowedActions={allowedActions} saved={vi.fn()} close={vi.fn()} />
}

function attemptDisabledAction(name: string) {
  const button = screen.getByRole("button", { name })
  button.removeAttribute("disabled")
  fireEvent.click(button)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AthenaWorkbench integrated request gating", () => {
  it("issues only the initial project GET for a read-project-only EXAFS session", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/athena/projects/integrated-project")) {
        return new Response(JSON.stringify(eligibleProject()), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ error: { message: `Unexpected request: ${url}` } }), {
        status: 404, headers: { "content-type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetcher)

    render(<AthenaWorkbench session={{
      mode: "integration", projectId: "integrated-project", capability: "read-only-capability",
      allowedOperations: ["read_project"], expiresAt: "2099-01-01T00:00:00Z",
    }} />)

    await screen.findByRole("button", { name: /EXAFS sample/ })
    fireEvent.click(screen.getByRole("tab", { name: /Fourier/ }))
    const viewerWeight = screen.getByRole("combobox", { name: "Viewer k-weight" })
    expect(viewerWeight).toBeDisabled()
    fireEvent.change(viewerWeight, { target: { value: "3" } })
    await new Promise(resolve => window.setTimeout(resolve, 250))

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    expect(fetcher.mock.calls[0][0]).toBe("/api/backend/api/athena/projects/integrated-project")
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET" })
    expect((fetcher.mock.calls[0][1]?.headers as Headers).get("x-xraylarch-project-capability")).toBe("read-only-capability")
  })

  it("keeps ordinary raw import available without restore", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/athena/projects/integrated-project")) return new Response(JSON.stringify(eligibleProject()))
      return new Response(JSON.stringify({ detail: "unexpected" }), { status: 404 })
    })
    vi.stubGlobal("fetch", fetcher)
    render(<AthenaWorkbench session={{
      mode: "integration", projectId: "integrated-project", capability: "raw-import", allowedOperations: ["read_project", "upload", "preview", "read_upload", "import"], expiresAt: "2099-01-01T00:00:00Z",
    }} />)
    await screen.findByRole("button", { name: /EXAFS sample/ })
    expect(screen.getByRole("button", { name: "Import spectra" })).toBeEnabled()
  })

  it("keeps reviewed project restoration inert without restore", async () => {
    const project = eligibleProject()
    const preview: ProjectPreview = {
      upload_id: "upload-project", filename: "source.prj", name: "Source project", journal: "",
      warnings: [], groups: [{ id: "source", label: "Source", data_type: "mu", points: 3,
        x: [1, 2, 3], y: [1, 2, 3], notes: "", reference_id: null }],
    }
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ detail: "unexpected" }), { status: 404 }))
    render(<AthenaProvider session={{
      mode: "integration", projectId: project.id, capability: "no-restore", allowedOperations: ["upload", "read_upload"], expiresAt: "2099-01-01T00:00:00Z",
    }} fetcher={fetcher}><AthenaProjectImport getProject={() => project} onImported={vi.fn()} onComplete={vi.fn()} onBusyChange={vi.fn()}
      initialFiles={[new File(["project"], "source.prj")]} initialPreview={preview} canRestore={false} /></AthenaProvider>)

    const restore = await screen.findByRole("button", { name: "Import all groups" })
    expect(restore).toBeDisabled()
    fireEvent.click(restore)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not send a point-edit preview through provider transport without preview", async () => {
    const project = eligibleProject()
    const fetcher = vi.fn()
    render(<AthenaProvider session={{ ...pointEditSession, allowedOperations: ["deglitch"] }} fetcher={fetcher}>
      {pointEdit(project, { preview: false, deglitch: true, truncate: false, undo: false, redo: false })}
    </AthenaProvider>)

    attemptDisabledAction("Replot selection")
    await new Promise(resolve => window.setTimeout(resolve, 400))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not send a point-edit command through provider transport without the current mutation capability", async () => {
    const project = eligibleProject()
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(pointEditPreview(project, String(init?.body)))))
    const rendered = render(<AthenaProvider session={pointEditSession} fetcher={fetcher}>
      {pointEdit(project, { preview: true, deglitch: true, truncate: false, undo: false, redo: false })}
    </AthenaProvider>)
    fireEvent.change(screen.getByLabelText("Point energy · eV", { exact: true }), { target: { value: "8980" } })
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove point" })).toBeEnabled())

    rendered.rerender(<AthenaProvider session={pointEditSession} fetcher={fetcher}>
      {pointEdit(project, { preview: true, deglitch: false, truncate: false, undo: false, redo: false })}
    </AthenaProvider>)
    attemptDisabledAction("Remove point")
    await new Promise(resolve => window.setTimeout(resolve, 50))
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/command"))).toHaveLength(0)
  })

  it("does not send undo through provider transport without undo despite available history", async () => {
    const project = eligibleProject()
    project.undo = ["edit"]
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(pointEditPreview(project, String(init?.body)))))
    render(<AthenaProvider session={pointEditSession} fetcher={fetcher}>
      {pointEdit(project, { preview: true, deglitch: true, truncate: false, undo: false, redo: false })}
    </AthenaProvider>)

    attemptDisabledAction("Undo last edit")
    await new Promise(resolve => window.setTimeout(resolve, 400))
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/command"))).toHaveLength(0)
  })

  it("does not send redo through provider transport without redo despite available history", async () => {
    const project = eligibleProject()
    project.redo = ["edit"]
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(pointEditPreview(project, String(init?.body)))))
    render(<AthenaProvider session={pointEditSession} fetcher={fetcher}>
      {pointEdit(project, { preview: true, deglitch: true, truncate: false, undo: false, redo: false })}
    </AthenaProvider>)

    attemptDisabledAction("Redo last edit")
    await new Promise(resolve => window.setTimeout(resolve, 400))
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/command"))).toHaveLength(0)
  })
})
