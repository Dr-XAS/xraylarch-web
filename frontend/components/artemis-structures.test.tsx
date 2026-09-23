import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState, type ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { artemisApi } from "@/lib/artemis"
import type { ArtemisFeffJob, ArtemisFeffRequest, ArtemisGeneratedPath, ArtemisStructure, ArtemisStructureAttachment } from "@/lib/artemis-structures"
import type { AthenaProject } from "@/lib/athena"
import { ArtemisStructures } from "./artemis-structures"

vi.mock("@/lib/artemis", () => ({ artemisApi: vi.fn() }))
vi.mock("./cif-viewer", () => ({
  CifViewer: ({ structure }: { structure: ArtemisStructure }) => <section aria-label="CIF structure viewer" data-testid="cif-viewer" data-cif={structure.cif} />,
}))
const api = vi.mocked(artemisApi)
const request: ArtemisFeffRequest = { project_id: "p", attachment_id: "cif1", version: 2, absorber: "Cu", edge: "K", site_index: 3, cluster_radius: 5, path_radius: 4, max_legs: 4, max_paths: 60 }
let savedAttachments: ArtemisStructureAttachment[] = []
let savedVersion = 1
function structure(overrides: Partial<ArtemisStructure> = {}): ArtemisStructure {
  return { id: 13088, mineral: "Copper", formula: "Cu", space_group: "F m -3 m", authors: "Example author", year: 1978, journal: "Example journal", title: "Copper structure", cif: "data_Cu\n_cell_length_a 3.61", elements: ["Cu", "Fe"], ordered: true, supported: true, warnings: [],
    cell: { a: 3.61, b: 3.61, c: 3.61, alpha: 90, beta: 90, gamma: 90 },
    sites: [
      { index: 3, element: "Cu", species: "Cu", multiplicity: 4, wyckoff: "4a", x: 0, y: 0, z: 0, occupancy: 1 },
      { index: 7, element: "Fe", species: "Fe", multiplicity: 8, wyckoff: "8b", x: 0.25, y: 0.25, z: 0.25, occupancy: 1 },
    ], ...overrides }
}
function attachment(): ArtemisStructureAttachment { return { id: "cif1", amcsd_id: 13088, attached_at: "2026-09-16T00:00:00Z", sha256: "abc", structure: structure() } }
function project(): AthenaProject { return { id: "p", name: "Copper", version: savedVersion, groups: [], journal: "", updated: "now", undo: [], redo: [], history: [], artemis_structures: savedAttachments } }
function job(status: ArtemisFeffJob["status"] = "complete", overrides: Partial<ArtemisFeffJob> = {}): ArtemisFeffJob {
  return { id: "job123", status, stage: "paths", message: status === "complete" ? "Generated 2 paths." : "Running FEFF8L.", elapsed_seconds: 4.4, log: "FEFF log", request,
    provenance: { cif: structure().cif, feff_input: "TITLE Copper\nEDGE K\nRPATH 4", structure: structure() },
    paths: status === "complete" ? [1, 2].map(index => ({ id: `path${index}`, filename: `feff000${index}.dat`, content: `FEFF path ${index} contents`,
      metadata: { reff: index + 1.55, degen: 12, nleg: 2, absorber: "Cu", edge: "K", kmin: 0, kmax: 20, geometry: [{ atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }] } })) : [], total_paths: 2, truncated: false, warnings: [], ...overrides }
}
async function click(name: string | RegExp) { await act(async () => { fireEvent.click(screen.getByRole("button", { name })) }) }
const addPathsMock = (result: string | null = null) => vi.fn<(paths: ArtemisGeneratedPath[]) => string | null>(() => result)
function Harness(props: Omit<ComponentProps<typeof ArtemisStructures>, "version">) {
  const [revision, setRevision] = useState(1)
  return <ArtemisStructures {...props} projectId={props.projectId ?? "p"} version={revision} onProjectChange={project => { props.onProjectChange?.(project); setRevision(project.version) }} />
}
function setup(availableSlots = 24, onAddPaths = addPathsMock()) {
  const view = render(<Harness contextKey="p:cu" availableSlots={availableSlots} onAddPaths={onAddPaths} />)
  fireEvent.click(screen.getByRole("button", { name: "Search / attach CIF" }))
  return { ...view, onAddPaths }
}
async function findAndSelect(attach = true) {
  fireEvent.change(screen.getByLabelText("AMCSD search query"), { target: { value: "copper" } })
  await click("Search AMCSD")
  await click(/Copper.*AMCSD/)
  if (attach) await click("Attach to project")
}
async function generate() {
  fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
  await click("Generate FEFF paths")
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

beforeEach(() => {
  api.mockReset()
  savedAttachments = []
  savedVersion = 1
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", "") } })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")) } })
  api.mockImplementation(async (url, body) => {
    if (url.includes("/projects/") && url.endsWith("/structures")) {
      if (body) { savedAttachments = [attachment()]; savedVersion = 2; return project() }
      return { project_id: "p", version: savedVersion, structures: savedAttachments }
    }
    if (url.startsWith("/structures?")) return { query: "copper", source: "Local AMCSD snapshot", results: [structure()], count: 1, limited: false }
    if (url.startsWith("/structures/")) return structure()
    if (url === "/feff/jobs") return job("complete", { request: body as ArtemisFeffRequest })
    return job()
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("ArtemisStructures", () => {
  it("opens an accessible popup, preserves selection across Escape/reopen, and restores launcher focus", async () => {
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "AMCSD search query" })).not.toBeInTheDocument()
    const launcher = screen.getByRole("button", { name: "Search / attach CIF" })
    launcher.focus()
    await click("Search / attach CIF")
    expect(screen.getByRole("dialog", { name: "Crystal structures & FEFF paths" })).toBeVisible()
    await findAndSelect(false)
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(launcher).toHaveFocus()
    await click("Search / attach CIF")
    expect(screen.getByRole("button", { name: "Attach to project" })).toBeEnabled()
    expect(screen.getByLabelText("AMCSD search query")).toHaveValue("copper")
    expect(api.mock.calls.filter(([url]) => url === "/structures/13088")).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Download CIF" })).not.toBeInTheDocument()
  })

  it("attaches the selected CIF explicitly and retains the active site across the project revision update", async () => {
    const onProjectChange = vi.fn()
    const onViewStructure = vi.fn()
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} onProjectChange={onProjectChange} onViewStructure={onViewStructure} />)
    await click("Search / attach CIF")
    await findAndSelect(false)
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    expect(onViewStructure).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Generate FEFF paths" })).toBeDisabled()
    expect(api.mock.calls.some(([url, body]) => url === "/projects/p/structures" && body)).toBe(false)
    await click("Attach to project")
    expect(api).toHaveBeenCalledWith("/projects/p/structures", { version: 1, amcsd_id: 13088 }, expect.any(AbortSignal))
    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "p", version: 2, artemis_structures: [attachment()] }))
    expect(onViewStructure).toHaveBeenCalledExactlyOnceWith("cif1")
    expect(screen.getByRole("dialog")).toBeVisible()
    expect(screen.getByRole("region", { name: "CIF structure viewer" })).toBeVisible()
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", attachment().structure.cif)
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).toBeChecked()
    await click("Generate FEFF paths")
    expect(api.mock.calls.at(-1)?.[1]).toEqual(request)
    expect(api.mock.calls.at(-1)?.[1]).not.toHaveProperty("amcsd_id")
  })

  it("blocks dismissal during attachment and ignores a late attachment after the context changes", async () => {
    const onProjectChange = vi.fn(), onAddPaths = addPathsMock()
    const view = render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} />)
    await click("Search / attach CIF")
    await findAndSelect(false)
    const late = deferred<AthenaProject>()
    api.mockReturnValueOnce(late.promise)
    await click("Attach to project")
    const signal = api.mock.calls.at(-1)?.[2]
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled()
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }))
    expect(screen.getByRole("dialog")).toBeVisible()
    view.rerender(<Harness contextKey="p:fe" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} />)
    expect(signal?.aborted).toBe(true)
    savedAttachments = [attachment()]; savedVersion = 2
    await act(async () => { late.resolve(project()) })
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("retains the chosen CIF after attach failure and retries the same explicit operation", async () => {
    setup()
    await findAndSelect(false)
    api.mockRejectedValueOnce(new Error("Project changed. Refresh and retry."))
    await click("Attach to project")
    expect(screen.getByRole("alert")).toHaveTextContent("Project changed")
    expect(screen.getByRole("button", { name: "Attach to project" })).toBeEnabled()
    expect(screen.getByText(/Copper structure/)).toBeVisible()
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    await click("Attach to project")
    expect(screen.getByRole("button", { name: "Attached to project" })).toBeDisabled()
    expect(screen.getByRole("region", { name: "CIF structure viewer" })).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("reopens an attached snapshot without AMCSD lookup and refreshes the compact project list", async () => {
    savedAttachments = [{ ...attachment(), structure: { ...structure(), cif: "data_saved_snapshot" } }]
    const onViewStructure = vi.fn()
    await act(async () => { render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} onViewStructure={onViewStructure} />) })
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    await click("Open attached Copper CIF")
    expect(onViewStructure).toHaveBeenCalledExactlyOnceWith("cif1")
    expect(screen.getByRole("button", { name: "Attached to project" })).toBeDisabled()
    expect(screen.getByRole("region", { name: "CIF structure viewer" })).toBeVisible()
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", "data_saved_snapshot")
    fireEvent.click(screen.getByText("View CIF"))
    expect(screen.getByText("data_saved_snapshot")).toBeVisible()
    expect(api.mock.calls.some(([url]) => url.startsWith("/structures/"))).toBe(false)
    await click("Close")
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    savedAttachments = []
    await click("Search / attach CIF")
    expect(screen.queryByRole("button", { name: "Open attached Copper CIF" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Attach to project" })).toBeEnabled()
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
  })

  it("shows a saved CIF from the attached picker and unmounts the viewer when the spectrum changes", async () => {
    savedAttachments = [{ ...attachment(), structure: structure({ cif: "data_attached_picker_snapshot" }) }]
    const onAddPaths = addPathsMock()
    const view = render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={onAddPaths} />)
    await click("Search / attach CIF")
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    await click("Use attached Copper CIF")
    expect(screen.getByRole("region", { name: "CIF structure viewer" })).toBeVisible()
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", "data_attached_picker_snapshot")
    expect(api.mock.calls.some(([url]) => url.startsWith("/structures/"))).toBe(false)
    view.rerender(<Harness contextKey="p:fe" availableSlots={24} onAddPaths={onAddPaths} />)
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("searches only on request and supports an element filter with literal URL encoding", async () => {
    setup()
    expect(api.mock.calls.some(([url]) => url.startsWith("/structures?"))).toBe(false)
    expect(screen.getByRole("button", { name: "Search AMCSD" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("AMCSD search query"), { target: { value: "Cu & iron" } })
    fireEvent.change(screen.getByLabelText("AMCSD element filter"), { target: { value: "Cu" } })
    await click("Search AMCSD")
    expect(api.mock.calls.filter(([url]) => url.startsWith("/structures?"))).toEqual([["/structures?q=Cu+%26+iron&limit=25&element=Cu", undefined, expect.any(AbortSignal)]])
    expect(screen.getByText("Local AMCSD snapshot")).toBeVisible()
  })

  it("shows CIF metadata and requires explicit global site selection, resetting it when the absorber changes", async () => {
    setup()
    await findAndSelect()
    expect(screen.queryByRole("button", { name: "Download CIF" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Attached to project" })).toBeDisabled()
    expect(screen.getByText("Cu · site 3 · Wyckoff 4a")).toBeVisible()
    expect(screen.getByRole("button", { name: "Generate FEFF paths" })).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "Fe" } })
    expect(screen.queryByRole("radio", { name: "Absorber site 3" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Generate FEFF paths" })).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 7" }))
    fireEvent.change(screen.getByLabelText("FEFF absorption edge"), { target: { value: "L3" } })
    await click("Generate FEFF paths")
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ ...request, absorber: "Fe", site_index: 7, edge: "L3" })
  })

  it("keeps unsupported CIF view/attachment available even when cell metadata is missing", async () => {
    setup()
    fireEvent.change(screen.getByLabelText("AMCSD search query"), { target: { value: "copper" } })
    await click("Search AMCSD")
    api.mockResolvedValueOnce(structure({ supported: false, ordered: false, cell: {}, sites: [], elements: [], warnings: ["The CIF cannot be parsed."] }))
    await click(/Copper.*AMCSD/)
    expect(screen.getByRole("button", { name: "Attach to project" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Download CIF" })).not.toBeInTheDocument()
    expect(screen.getByText("The CIF cannot be parsed.")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Generate FEFF paths" })).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("cannot be used for FEFF")
  })

  it("validates cluster/path bounds before launching FEFF", async () => {
    setup()
    await findAndSelect()
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
    fireEvent.change(screen.getByLabelText("FEFF maximum path radius"), { target: { value: "6" } })
    await click("Generate FEFF paths")
    expect(screen.getByRole("alert")).toHaveTextContent("path radius of 2 Å up to the cluster radius")
    expect(api.mock.calls.some(([url]) => url === "/feff/jobs")).toBe(false)
  })

  it("polls running jobs, selects within the fit capacity, and appends verified paths with structure labels", async () => {
    const { onAddPaths } = setup(1)
    await findAndSelect()
    api.mockResolvedValueOnce(job("running"))
    vi.useFakeTimers()
    await generate()
    expect(screen.getByRole("button", { name: "Calculating FEFF…" })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(screen.getByText("FEFF calculation complete")).toBeVisible()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" }))
    expect(screen.getByRole("checkbox", { name: "Select generated feff0002.dat" })).toBeDisabled()
    await click("Add selected paths (1)")
    expect(onAddPaths).toHaveBeenCalledExactlyOnceWith([{ ...job().paths[0], id: undefined, label: "Copper · AMCSD 0013088 · Cu site 3 · feff0001.dat" }].map(({ id: _id, ...path }) => path))
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeDisabled()
    expect(screen.getByText(/Added 1 generated path/)).toBeVisible()
    expect(screen.getByText("FEFF input")).toBeVisible()
  })

  it("keeps a FEFF calculation running while the popup is closed and restores its completed paths", async () => {
    setup()
    await findAndSelect()
    api.mockResolvedValueOnce(job("running"))
    vi.useFakeTimers()
    await generate()
    await click("Close")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    await click("Search / attach CIF")
    expect(screen.getByText("FEFF calculation complete")).toBeVisible()
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeEnabled()
    expect(api.mock.calls.filter(([url]) => url === "/feff/jobs")).toHaveLength(1)
  })

  it("retains the completed calculation's real FEFF atom cluster when adding paths", async () => {
    const { onAddPaths } = setup()
    await findAndSelect()
    const completed = job()
    completed.provenance.feff_input = "TITLE Copper\nPOTENTIALS\n0 29 Cu\n1 29 Cu\nATOMS\n0 0 0 0 Cu\n2.55 0 0 1 Cu\n-2.55 0 0 1 Cu\nEND"
    api.mockResolvedValueOnce(completed)
    await generate()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" }))
    await click("Add selected paths (1)")
    expect(onAddPaths.mock.calls[0][0][0].metadata.viewerCluster).toEqual({ source: "feff.inp", atoms: [
      { atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 },
      { atom: "Cu", x: 2.55, y: 0, z: 0, ipot: 1 },
      { atom: "Cu", x: -2.55, y: 0, z: 0, ipot: 1 },
    ] })
    expect(onAddPaths.mock.calls[0][0][0].metadata.degen).toBe(12)
    expect(completed.paths[0].metadata).not.toHaveProperty("viewerCluster")
  })

  it("recovers from polling failure without restarting FEFF, then ignores a late status after context changes", async () => {
    const { rerender, onAddPaths } = setup()
    await findAndSelect()
    api.mockResolvedValueOnce(job("running"))
    vi.useFakeTimers()
    await generate()
    api.mockRejectedValueOnce(new Error("Temporary connection failure."))
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(screen.getByRole("alert")).toHaveTextContent("Temporary connection failure")
    const late = deferred<ArtemisFeffJob>()
    api.mockReturnValueOnce(late.promise)
    await click("Check status")
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    const signal = api.mock.calls.at(-1)?.[2]
    rerender(<Harness contextKey="p:fe" availableSlots={24} onAddPaths={onAddPaths} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => { late.resolve(job()) })
    expect(screen.queryByText("FEFF calculation complete")).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /Select generated/ })).not.toBeInTheDocument()
    expect(api.mock.calls.filter(([url]) => url === "/feff/jobs")).toHaveLength(1)
  })

  it("discards delayed generated paths when the selected site or generation settings change", async () => {
    setup()
    await findAndSelect()
    const late = deferred<ArtemisFeffJob>()
    api.mockReturnValueOnce(late.promise)
    await generate()
    const signal = api.mock.calls.at(-1)?.[2]
    fireEvent.change(screen.getByLabelText("FEFF cluster radius"), { target: { value: "6" } })
    expect(signal?.aborted).toBe(true)
    await act(async () => { late.resolve(job()) })
    expect(screen.queryByText("FEFF calculation complete")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Generate FEFF paths" })).toBeEnabled()
  })

  it("ignores an old structure lookup after another result or spectrum is selected", async () => {
    const { rerender, onAddPaths } = setup()
    fireEvent.change(screen.getByLabelText("AMCSD search query"), { target: { value: "copper" } })
    await click("Search AMCSD")
    const late = deferred<ArtemisStructure>()
    api.mockReturnValueOnce(late.promise)
    await click(/Copper.*AMCSD/)
    const signal = api.mock.calls.at(-1)?.[2]
    rerender(<Harness contextKey="p:new" availableSlots={24} onAddPaths={onAddPaths} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => { late.resolve(structure()) })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("keeps generated selection when the parent rejects an addition and displays the reason", async () => {
    const onAddPaths = addPathsMock("Remove unused parameters first.")
    setup(24, onAddPaths)
    await findAndSelect()
    await generate()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" }))
    await click("Add selected paths (1)")
    expect(screen.getByRole("alert")).toHaveTextContent("Remove unused parameters")
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeChecked()
  })

  it("bounds generated labels and makes a removed fit path available to add again", async () => {
    const onAddPaths = addPathsMock()
    const view = render(<Harness contextKey="p:cu" availableSlots={24} existingPaths={[]} onAddPaths={onAddPaths} />)
    fireEvent.click(screen.getByRole("button", { name: "Search / attach CIF" }))
    await findAndSelect()
    api.mockResolvedValueOnce(job("complete", { provenance: { ...job().provenance, structure: structure({ mineral: "Long crystal name ".repeat(20) }) } }))
    await generate()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" }))
    await click("Add selected paths (1)")
    const paths = onAddPaths.mock.calls[0][0]
    expect(paths[0].label).toHaveLength(120)
    expect(paths[0].label).toMatch(/AMCSD 0013088 · Cu site 3 · feff0001.dat$/)
    view.rerender(<Harness contextKey="p:cu" availableSlots={23} existingPaths={paths} onAddPaths={onAddPaths} />)
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeDisabled()
    view.rerender(<Harness contextKey="p:cu" availableSlots={24} existingPaths={[]} onAddPaths={onAddPaths} />)
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeEnabled()
  })
})
