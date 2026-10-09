import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createHash, webcrypto } from "node:crypto"
import { useState, type ComponentProps, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { artemisApi } from "@/lib/artemis"
import type { ArtemisFeffJob, ArtemisFeffRequest, ArtemisGeneratedPath, ArtemisStructure, ArtemisStructureAttachment } from "@/lib/artemis-structures"
import type { AthenaGroup, AthenaProject } from "@/lib/athena"
import { simulationFixture, simulationJob } from "@/tests/fixtures/artemis-simulation"
import type { FirstShell } from "@/lib/first-shell"
import { ArtemisStructures } from "./artemis-structures"
import { radialFixture } from "@/tests/fixtures/radial-shells"

vi.mock("@/lib/artemis", () => ({ artemisApi: vi.fn() }))
const firstShell = vi.hoisted(() => ({ shell: null as FirstShell | null }))
vi.mock("@/lib/use-first-shell", () => ({ useFirstShell: () => ({ shell: firstShell.shell, loading: false, error: "", retry: () => {} }) }))
const radialAnalysis = vi.hoisted(() => vi.fn())
vi.mock("@/lib/use-radial-shells", () => ({ useRadialShells: radialAnalysis }))
vi.mock("./artefact-viewers/cif-viewer", () => ({
  CifViewer: ({ structure }: { structure: ArtemisStructure }) => <section aria-label="CIF structure viewer" data-testid="cif-viewer" data-cif={structure.cif} data-structure-id={structure.id} data-provider={structure.provider ?? "amcsd"} />,
}))
vi.mock("./artefact-viewers/artemis-simulation-viewer", () => ({ ArtemisSimulationViewer: ({ actions }: { actions?: ReactNode }) => <div data-testid="simulation-result">{actions}</div> }))
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
function attachment(): ArtemisStructureAttachment { return { id: "cif1", amcsd_id: 13088, attached_at: "2026-09-16T00:00:00Z", sha256: "a".repeat(64), structure: structure() } }
function tungstenAttachment(): ArtemisStructureAttachment {
  return { ...attachment(), structure: structure({ mineral: "Tungsten oxide", formula: "W O3", elements: ["O", "W"],
    sites: structure().sites.map(site => ({ ...site, element: site.index === 3 ? "W" : "O", species: site.index === 3 ? "W" : "O" })) }) }
}
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
  fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: "amcsd" } })
  fireEvent.change(screen.getByLabelText("AMCSD search query"), { target: { value: "copper" } })
  await click("Search AMCSD")
  await click(/Copper.*AMCSD/)
  if (attach) {
    await click("Attach to project")
    await openFeff()
  }
}
async function openFeff() {
  if (screen.queryByRole("dialog", { name: "Crystal structures" })) await click("Close")
  await click("Generate FEFF paths")
}
async function generate() {
  fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
  await click("Run FEFF calculation")
}
function selectGeneratedPaths(...filenames: string[]) {
  for (const checkbox of screen.getAllByRole("checkbox", { name: /^Select generated / }) as HTMLInputElement[]) {
    const wanted = filenames.includes(checkbox.getAttribute("aria-label")!.replace("Select generated ", ""))
    if (checkbox.checked !== wanted) fireEvent.click(checkbox)
  }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

function cifFile(name = "my-copper.cif", text = structure().cif) {
  const file = new File([text], name, { type: "chemical/x-cif" })
  Object.defineProperty(file, "text", { configurable: true, value: async () => text })
  return file
}
async function chooseCif(file: File, inDialog = true) {
  await act(async () => { fireEvent.change(screen.getByLabelText(inDialog ? "Upload CIF file in dialog" : "Upload CIF file"), { target: { files: [file] } }) })
}

beforeEach(() => {
  api.mockReset()
  firstShell.shell = null
  radialAnalysis.mockReturnValue({ contextKey: "test", data: null, loading: false, error: "", retry: () => {}, settings: { radius: 6, tolerance: 0.05 }, setSettings: () => {} })
  savedAttachments = []
  savedVersion = 1
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", "") } })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")) } })
  api.mockImplementation(async (url, body) => {
    if (url.startsWith("/projects/p/structures/") && url.endsWith("/rename")) {
      const id = url.split("/").at(-2)
      savedAttachments = savedAttachments.map(item => item.id === id ? { ...item, label: (body as { label: string }).label } : item)
      savedVersion += 1
      return project()
    }
    if (url.startsWith("/projects/p/structures/") && url.endsWith("/remove")) {
      const id = url.split("/").at(-2)
      savedAttachments = savedAttachments.filter(item => item.id !== id)
      savedVersion += 1
      return project()
    }
    if (url.includes("/projects/") && url.endsWith("/structures")) {
      if (body && (body as { provider?: string }).provider === "uploaded") {
        const upload = body as { filename: string; cif: string }
        savedAttachments = [{ id: "upload1", provider: "uploaded", sha256: "upload-hash", attached_at: "2026-10-06T00:00:00Z", structure: structure({ id: "cif-upload-hash", provider: "uploaded", filename: upload.filename, cif: upload.cif }) }]
        savedVersion = 2
        return project()
      }
      if (body) { savedAttachments = [attachment()]; savedVersion = 2; return project() }
      return { project_id: "p", version: savedVersion, structures: savedAttachments }
    }
    if (url.startsWith("/structures?")) return { query: "copper", source: "Local AMCSD snapshot", results: [structure()], count: 1, limited: false }
    if (url.startsWith("/structures/")) return structure()
    if (url === "/feff/jobs") return job("complete", { request: body as ArtemisFeffRequest })
    return job()
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("ArtemisStructures", () => {
  it("opens a separate simulation form for the chosen CIF and automatically includes all paths", async () => {
    const copper = attachment()
    const cuprite = { ...attachment(), id: "cif2", amcsd_id: 13089, structure: structure({ id: 13089, mineral: "Cuprite", formula: "Cu2O", cif: "data_Cu2O" }) }
    savedAttachments = [copper, cuprite]
    const onViewStructure = vi.fn(), onAddPaths = addPathsMock()
    render(<Harness contextKey="p:cu" spectrumEdge={{ element: "Cu", edge: "K" }} availableSlots={0} onAddPaths={onAddPaths} onViewStructure={onViewStructure} />)
    const region = screen.getByRole("region", { name: "Project CIF structures" })
    const launch = await within(region).findByRole("button", { name: "Simulate EXAFS from Cuprite CIF" })
    await act(async () => { fireEvent.click(launch) })
    expect(screen.getByRole("dialog", { name: "Simulate EXAFS" })).toBeVisible()
    expect(screen.getByLabelText("Simulation crystal structure")).toHaveValue("cif2")
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", cuprite.structure.cif)
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).toBeChecked()
    expect(onViewStructure).toHaveBeenLastCalledWith("cif2", 3)
    expect(api.mock.calls.filter(([, body]) => body !== undefined)).toEqual([])
    expect(screen.queryByRole("button", { name: "Run FEFF calculation" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("FEFF maximum paths")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Simulation paths")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Simulation maximum R"), { target: { value: "5.5" } })
    await click("Run EXAFS simulation")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ attachment_id: "cif2", absorber: "Cu", site_index: 3, cluster_radius: 5.5, path_radius: 5.5, max_paths: null, max_legs: 4 }), expect.any(AbortSignal))
    expect(api).toHaveBeenCalledWith(expect.stringMatching(/\/simulate$/), expect.objectContaining({ path_ids: null }), expect.any(AbortSignal))
    expect(screen.queryByRole("checkbox", { name: /^Select generated / })).not.toBeInTheDocument()
    expect(onAddPaths).not.toHaveBeenCalled()
    await click("Close EXAFS simulation")
    await act(async () => { fireEvent.click(within(region).getByRole("button", { name: "Simulate EXAFS from Copper CIF" })) })
    expect(screen.getByLabelText("Simulation crystal structure")).toHaveValue("cif1")
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", copper.structure.cif)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(api.mock.calls.filter(([url]) => url === "/feff/jobs")).toHaveLength(1)
    fireEvent.change(screen.getByLabelText("Simulation maximum R"), { target: { value: "" } })
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeDisabled()
  })

  it("keeps an unsupported CIF's simulation action visible but disabled", async () => {
    savedAttachments = [{ ...attachment(), structure: structure({ supported: false, ordered: false }) }]
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} />)
    const region = screen.getByRole("region", { name: "Project CIF structures" })
    const simulate = await within(region).findByRole("button", { name: "Simulate EXAFS from Copper CIF" })
    expect(simulate).toBeVisible()
    expect(simulate).toBeDisabled()
    expect(within(region).getByRole("button", { name: "Open attached Copper CIF" })).toBeEnabled()
    expect(api.mock.calls.filter(([, body]) => body !== undefined)).toEqual([])
  })

  it("keeps fitting path selection across reopening without exposing simulation controls", async () => {
    setup()
    await findAndSelect()
    await generate()
    for (const checkbox of screen.getAllByRole("checkbox", { name: /^Select generated / })) expect(checkbox).toBeChecked()
    expect(screen.getByRole("button", { name: "Add selected paths (2)" })).toBeEnabled()

    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0002.dat" }))
    await click("Close")
    await openFeff()
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Select generated feff0002.dat" })).not.toBeChecked()

    selectGeneratedPaths("feff0001.dat")
    await generate()
    for (const checkbox of screen.getAllByRole("checkbox", { name: /^Select generated / })) expect(checkbox).toBeChecked()
    expect(api.mock.calls.some(([url]) => url.endsWith("/simulate"))).toBe(false)
  })

  it("guards Add and Replace independently for generated fitting paths", async () => {
    const existing = [{ filename: "uploaded.dat", content: "uploaded path", enabled: true }]
    const onAddPaths = addPathsMock()
    render(<Harness contextKey="p:cu" availableSlots={23} existingPaths={existing} onAddPaths={onAddPaths} />)
    await click("Search / attach CIF")
    await findAndSelect()
    const paths = Array.from({ length: 25 }, (_, index) => ({ ...job().paths[0], id: `path${index + 1}`, filename: `feff${String(index + 1).padStart(4, "0")}.dat`, content: `path ${index + 1}` }))
    api.mockResolvedValueOnce(job("complete", { paths, total_paths: paths.length }))
    await generate()
    expect(screen.getAllByRole("checkbox", { name: /^Select generated / })).toHaveLength(25)
    for (const checkbox of screen.getAllByRole("checkbox", { name: /^Select generated / })) expect(checkbox).toBeChecked()
    expect(screen.queryByRole("button", { name: "Run EXAFS simulation" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add selected paths (25)" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Replace the model’s 1 path with selected \(25\)/ })).toBeDisabled()

    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0025.dat" }))
    expect(screen.getByRole("checkbox", { name: "Select generated feff0025.dat" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Add selected paths (24)" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Replace the model’s 1 path with selected \(24\)/ })).toBeEnabled()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0024.dat" }))
    expect(screen.getByRole("button", { name: "Add selected paths (23)" })).toBeEnabled()
    expect(onAddPaths).not.toHaveBeenCalled()
  })

  it("adds the completed theory spectrum using the settled project version and receives the updated list", async () => {
    const preparation = deferred<{ version: number; finish: () => void }>()
    const finish = vi.fn(), onProjectChange = vi.fn()
    const generated = job("complete", { paths: simulationJob.paths, total_paths: 1 })
    const simulation = simulationFixture()
    simulation.simulation.feff_job_id = generated.id
    simulation.source.request = generated.request
    simulation.source.provenance = generated.provenance
    const group: AthenaGroup = { id: "theory1", label: "Copper theory", data_type: "chi", energy: simulation.k.x, mu: simulation.k.chi,
      source: { tags: ["theory"] }, marked: true, frozen: false, multiplier: 1, offset: 0, notes: "", reference_id: null,
      parameters: {} as AthenaGroup["parameters"], result: null, processing_error: null }
    const defaultApi = api.getMockImplementation()!
    api.mockImplementation(async (url, body, signal, options) => {
      if (url === "/feff/jobs") { simulation.source.request = body as ArtemisFeffRequest; return { ...generated, request: body as ArtemisFeffRequest } }
      if (url.endsWith("/simulate")) return simulation
      if (url === "/projects/p/simulation") return { ...project(), version: 8, groups: [group], last_operation: { action: "simulation", skipped_group_ids: [], simulation: { group_id: group.id } } }
      return defaultApi(url, body, signal, options)
    })
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} onProjectChange={onProjectChange}
      prepareMutation={vi.fn().mockResolvedValueOnce({ version: 1, finish: () => {} }).mockImplementationOnce(() => preparation.promise)} />)
    fireEvent.click(screen.getByRole("button", { name: "Search / attach CIF" }))
    await findAndSelect(); await click("Close FEFF paths"); await click("Simulate EXAFS from CIF"); fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
    await click("Run EXAFS simulation")
    await screen.findByTestId("simulation-result")
    await click("Add to data list")
    expect(screen.getByRole("button", { name: "Close EXAFS simulation" })).toBeDisabled()
    expect(api.mock.calls.filter(([url]) => url.endsWith("/simulation"))).toHaveLength(0)
    await act(async () => preparation.resolve({ version: 7, finish }))
    await screen.findByRole("button", { name: "Added to data list" })
    expect(api).toHaveBeenCalledWith("/projects/p/simulation", { version: 7, feff_job_id: generated.id, simulation: simulation.simulation.request }, undefined, { idempotencyKey: expect.any(String) })
    expect(onProjectChange).toHaveBeenLastCalledWith(expect.objectContaining({ version: 8, groups: [group] }))
    expect(finish).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Close EXAFS simulation" })).toBeEnabled()
  })
  it("renames only the chosen CIF and retains the generated paths and source metadata", async () => {
    const original = attachment()
    savedAttachments = [original, { ...attachment(), id: "cif2", amcsd_id: 13089, structure: structure({ id: 13089 }) }]
    const onProjectChange = vi.fn()
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} onProjectChange={onProjectChange} />)
    await screen.findAllByRole("button", { name: "Rename Copper CIF" })
    const region = screen.getByRole("region", { name: "Project CIF structures" })
    fireEvent.click(within(region).getAllByRole("button", { name: "Open attached Copper CIF" })[0])
    await openFeff()
    await generate()
    await click("Close FEFF paths")
    fireEvent.click(within(region).getAllByRole("button", { name: "Rename Copper CIF" })[0])
    const input = screen.getByRole("textbox", { name: "CIF name" })
    expect(input).toHaveFocus()
    expect(input).toHaveValue("Copper")
    fireEvent.change(input, { target: { value: "  Copper at 300 K  " } })
    await click("Save CIF name")
    expect(api).toHaveBeenCalledWith("/projects/p/structures/cif1/rename", { version: 1, label: "Copper at 300 K" })
    expect(savedAttachments[0]).toEqual({ ...original, label: "Copper at 300 K" })
    expect(savedAttachments[1].label).toBeUndefined()
    expect(within(region).getByRole("button", { name: "Rename Copper at 300 K CIF" })).toBeEnabled()
    expect(onProjectChange).toHaveBeenCalledOnce()
    await openFeff()
    expect(screen.getByRole("option", { name: "Copper at 300 K · AMCSD 0013088" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeInTheDocument()
    expect(api.mock.calls.filter(([url]) => url === "/feff/jobs")).toHaveLength(1)
  })

  it("supports cancelling a rename and refuses blank names without sending a mutation", async () => {
    savedAttachments = [attachment()]
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} />)
    await screen.findByRole("button", { name: "Rename Copper CIF" })
    await click("Rename Copper CIF")
    fireEvent.change(screen.getByRole("textbox", { name: "CIF name" }), { target: { value: "   " } })
    expect(screen.getByRole("button", { name: "Save CIF name" })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "CIF name" }), { key: "Enter" })
    await click("Cancel CIF rename")
    expect(screen.queryByRole("textbox", { name: "CIF name" })).not.toBeInTheDocument()
    await click("Rename Copper CIF")
    expect(screen.getByRole("textbox", { name: "CIF name" })).toHaveValue("Copper")
    fireEvent.keyDown(screen.getByRole("textbox", { name: "CIF name" }), { key: "Escape" })
    expect(screen.queryByRole("textbox", { name: "CIF name" })).not.toBeInTheDocument()
    expect(api.mock.calls.filter(([url]) => url.endsWith("/rename"))).toHaveLength(0)
  })

  it("renames from the CIF dialog with Enter and keeps that dialog open on Escape", async () => {
    savedAttachments = [attachment()]
    setup()
    const dialog = screen.getByRole("dialog", { name: "Crystal structures" })
    await within(dialog).findByRole("button", { name: "Rename Copper CIF" })
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Copper CIF" }))
    fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "CIF name" }), { key: "Escape" })
    expect(dialog).toBeVisible()
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Copper CIF" }))
    fireEvent.change(within(dialog).getByRole("textbox", { name: "CIF name" }), { target: { value: "Foil reference" } })
    await act(async () => { fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "CIF name" }), { key: "Enter" }) })
    expect(within(dialog).getByRole("button", { name: "Use attached Foil reference CIF" })).toBeInTheDocument()
    expect(within(dialog).queryByRole("textbox", { name: "CIF name" })).not.toBeInTheDocument()
  })

  it("retains a failed rename for correction and retry", async () => {
    savedAttachments = [attachment()]
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} />)
    await screen.findByRole("button", { name: "Rename Copper CIF" })
    await click("Rename Copper CIF")
    fireEvent.change(screen.getByRole("textbox", { name: "CIF name" }), { target: { value: "Copper reference" } })
    api.mockRejectedValueOnce(new Error("Project changed; reload and retry."))
    await click("Save CIF name")
    expect(screen.getByRole("alert")).toHaveTextContent("Project changed")
    expect(screen.getByRole("textbox", { name: "CIF name" })).toHaveValue("Copper reference")
    expect(screen.getByRole("button", { name: "Rename Copper CIF" })).toBeEnabled()
    await click("Save CIF name")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Rename Copper reference CIF" })).toBeEnabled()
  })

  it("waits for pending fit edits and releases the mutation queue after renaming", async () => {
    savedAttachments = [attachment()]
    const pending = deferred<{ version: number; finish: () => void }>()
    const finish = vi.fn()
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} prepareMutation={() => pending.promise} />)
    await screen.findByRole("button", { name: "Rename Copper CIF" })
    await click("Rename Copper CIF")
    fireEvent.change(screen.getByRole("textbox", { name: "CIF name" }), { target: { value: "Reference" } })
    await click("Save CIF name")
    expect(screen.getByRole("button", { name: "Save CIF name" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Remove Copper CIF from project" })).toBeDisabled()
    expect(api.mock.calls.filter(([url]) => url.endsWith("/rename"))).toHaveLength(0)
    savedVersion = 2
    await act(async () => { pending.resolve({ version: 2, finish }) })
    expect(api).toHaveBeenCalledWith("/projects/p/structures/cif1/rename", { version: 2, label: "Reference" })
    expect(finish).toHaveBeenCalledOnce()
  })

  it("abandons an unsent rename if the spectrum changes while flushing fit edits", async () => {
    savedAttachments = [attachment()]
    const pending = deferred<{ version: number; finish: () => void }>()
    const finish = vi.fn()
    const props = { contextKey: "p:cu", availableSlots: 24, onAddPaths: addPathsMock(), prepareMutation: () => pending.promise }
    const view = render(<Harness {...props} />)
    await screen.findByRole("button", { name: "Rename Copper CIF" })
    await click("Rename Copper CIF")
    fireEvent.change(screen.getByRole("textbox", { name: "CIF name" }), { target: { value: "Reference" } })
    await click("Save CIF name")
    view.rerender(<Harness {...props} contextKey="p:other" />)
    await act(async () => { pending.resolve({ version: 2, finish }) })
    expect(api.mock.calls.filter(([url]) => url.endsWith("/rename"))).toHaveLength(0)
    expect(finish).toHaveBeenCalledOnce()
    expect(screen.queryByRole("textbox", { name: "CIF name" })).not.toBeInTheDocument()
  })

  it("uploads and displays a custom CIF, then generates FEFF from its saved attachment", async () => {
    const onViewStructure = vi.fn()
    render(<Harness contextKey="p:cu" spectrumEdge={{ element: "Cu", edge: "K" }} availableSlots={24} onAddPaths={addPathsMock()} onViewStructure={onViewStructure} />)
    expect(screen.getByRole("button", { name: "Upload CIF" })).toBeEnabled()
    const file = cifFile()
    await chooseCif(file, false)
    expect(api).toHaveBeenCalledWith("/projects/p/structures", { version: 1, provider: "uploaded", filename: file.name, cif: structure().cif })
    expect(screen.getByRole("dialog", { name: "Crystal structures" })).toBeVisible()
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", structure().cif)
    expect(screen.getByRole("button", { name: "Attached to project" })).toBeDisabled()
    expect(screen.getAllByText("Uploaded CIF · my-copper.cif").length).toBeGreaterThan(0)
    expect(onViewStructure).toHaveBeenCalledWith("upload1", 3)
    await openFeff()
    await click("Run FEFF calculation")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ project_id: "p", attachment_id: "upload1", version: 2, absorber: "Cu", site_index: 3 }), expect.any(AbortSignal))
  })

  it("rejects oversized CIFs before sending and allows a subsequent upload", async () => {
    setup()
    await chooseCif(cifFile("large.cif", "x".repeat(500_001)))
    expect(screen.getByRole("alert")).toHaveTextContent("at most 500 KB")
    expect(api.mock.calls.filter(([url, body]) => url === "/projects/p/structures" && body)).toHaveLength(0)
    await chooseCif(cifFile())
    expect(screen.getByRole("button", { name: "Attached to project" })).toBeDisabled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("shows backend validation errors and permits retrying the same file", async () => {
    setup()
    await act(async () => {})
    api.mockRejectedValueOnce(new Error("The uploaded CIF does not contain a readable periodic crystal structure with atomic sites."))
    const file = cifFile()
    await chooseCif(file)
    expect(screen.getByRole("alert")).toHaveTextContent("readable periodic crystal structure")
    expect(within(screen.getByRole("dialog", { name: "Crystal structures" })).getByRole("button", { name: "Upload CIF" })).toBeEnabled()
    await chooseCif(file)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", structure().cif)
  })

  it("does not submit an upload whose project context changed while reading the file", async () => {
    const props = { contextKey: "p:cu", availableSlots: 24, onAddPaths: addPathsMock() }
    const view = render(<Harness {...props} />)
    const text = deferred<string>()
    const file = cifFile()
    Object.defineProperty(file, "text", { value: () => text.promise })
    await chooseCif(file, false)
    view.rerender(<Harness {...props} contextKey="p:other" />)
    await act(async () => { text.resolve(structure().cif) })
    expect(api.mock.calls.filter(([url, body]) => url === "/projects/p/structures" && body)).toHaveLength(0)
  })

  it("waits for pending model edits before uploading at the resulting project version", async () => {
    const pending = deferred<{ version: number; finish: () => void }>()
    const finish = vi.fn()
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} prepareMutation={() => pending.promise} />)
    await chooseCif(cifFile(), false)
    expect(screen.getByRole("button", { name: "Search / attach CIF" })).toBeDisabled()
    expect(api.mock.calls.filter(([url, body]) => url === "/projects/p/structures" && body)).toHaveLength(0)
    await act(async () => { pending.resolve({ version: 2, finish }) })
    expect(api).toHaveBeenCalledWith("/projects/p/structures", expect.objectContaining({ version: 2, provider: "uploaded" }))
    expect(finish).toHaveBeenCalledOnce()
  })

  it("defaults to Materials Project then AMCSD and preserves the server's formula ranking when opening either source", async () => {
    const exact = structure({ mineral: "", formula: "LiMnNiO2" })
    const broad = structure({ id: "mp-123", provider: "materials_project", mineral: "", formula: "LiMn0.5Ni0.5O2" })
    const fallback = api.getMockImplementation()!
    api.mockImplementation(async (url, body, signal) => {
      if (url.startsWith("/structures?")) return { query: "LiMnNiO2", source: "Materials Project and AMCSD", results: [exact, broad], count: 2, limited: false }
      if (url === "/structures/13088") return exact
      if (url === "/structures/mp-123?provider=materials_project") return broad
      return fallback(url, body, signal)
    })
    setup()
    const source = screen.getByLabelText("Structure source")
    expect(source).toHaveValue("auto")
    expect(within(source).getAllByRole("option").map(option => option.textContent)).toEqual(["Materials Project, then AMCSD", "Materials Project", "AMCSD"])
    fireEvent.change(screen.getByLabelText("CIF search query"), { target: { value: "LiMnNiO2" } })
    await click("Search structures")
    expect(api).toHaveBeenCalledWith("/structures?q=LiMnNiO2&limit=25&provider=auto", undefined, expect.any(AbortSignal))
    const results = screen.getAllByRole("button", { name: /^LiMn/ })
    expect(results[0]).toHaveTextContent("LiMnNiO2")
    expect(results[1]).toHaveTextContent("LiMn0.5Ni0.5O2")
    await click(/LiMnNiO2.*AMCSD/)
    expect(api).toHaveBeenCalledWith("/structures/13088", undefined, expect.any(AbortSignal))
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-provider", "amcsd")
    await click(/LiMn0.5Ni0.5O2.*Materials Project/)
    expect(api).toHaveBeenCalledWith("/structures/mp-123?provider=materials_project", undefined, expect.any(AbortSignal))
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-provider", "materials_project")
    expect(results[0]).toHaveAttribute("aria-pressed", "false")
    expect(results[1]).toHaveAttribute("aria-pressed", "true")
  })

  it("reuses the correct attached snapshot for each provider in combined search results", async () => {
    const amcsd = attachment()
    const mp: ArtemisStructureAttachment = { ...attachment(), id: "mp-cif", provider: "materials_project", material_id: "mp-30", structure: structure({ id: "mp-30", provider: "materials_project", cif: "data_saved_mp" }) }
    savedAttachments = [amcsd, mp]
    const fallback = api.getMockImplementation()!
    api.mockImplementation(async (url, body, signal) => {
      if (url.startsWith("/structures?")) return { query: "Cu", source: "Materials Project and AMCSD", results: [mp.structure, amcsd.structure], count: 2, limited: false }
      return fallback(url, body, signal)
    })
    const onViewStructure = vi.fn()
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} onViewStructure={onViewStructure} />)
    await click("Search / attach CIF")
    fireEvent.change(screen.getByLabelText("CIF search query"), { target: { value: "Cu" } })
    await click("Search structures")
    await click(/Copper.*Materials Project mp-30/)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", "data_saved_mp")
    expect(onViewStructure).toHaveBeenLastCalledWith("mp-cif", undefined)
    await click(/Copper.*AMCSD 0013088/)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", amcsd.structure.cif)
    expect(onViewStructure).toHaveBeenLastCalledWith("cif1", undefined)
    expect(api.mock.calls.some(([url]) => url.startsWith("/structures/"))).toBe(false)
  })

  it("displays fallback warnings with usable AMCSD results and clears them on a new search or source change", async () => {
    setup()
    const warning = "Materials Project is unavailable. Showing AMCSD results."
    const response = { query: "Cu", source: "AMCSD", results: [structure()], count: 1, limited: false, warnings: [warning] }
    fireEvent.change(screen.getByLabelText("CIF search query"), { target: { value: "Cu" } })
    api.mockResolvedValueOnce(response)
    await click("Search structures")
    expect(screen.getByRole("status")).toHaveTextContent(warning)
    expect(screen.getByRole("button", { name: /Copper.*AMCSD/ })).toBeEnabled()
    const next = deferred<unknown>()
    api.mockReturnValueOnce(next.promise)
    await click("Search structures")
    expect(screen.queryByText(warning)).not.toBeInTheDocument()
    await act(async () => next.resolve(response))
    expect(screen.getByText(warning)).toBeVisible()
    fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: "amcsd" } })
    expect(screen.queryByText(warning)).not.toBeInTheDocument()
  })

  it.each(["auto", "materials_project"])("searches, attaches and generates paths with Materials Project identity from %s search", async provider => {
    const mp = structure({ id: "mp-aaaaaaft", provider: "materials_project", mineral: "Cu", formula: "Cu",
      provenance: { database_version: "2026.04.13", retrieved_at: "2026-10-02T00:00:00Z", task_id: "task-Cu", structure_type: "dft_relaxed" } })
    const mpAttachment: ArtemisStructureAttachment = { id: "mp-cif", provider: "materials_project", material_id: String(mp.id), attached_at: "2026-10-02T00:00:00Z", sha256: "mp-hash", structure: mp }
    const fallback = api.getMockImplementation()!
    api.mockImplementation(async (url, body, signal) => {
      if (url.startsWith("/structures?")) return { query: "Cu", source: "Materials Project", results: [mp], count: 1, limited: false }
      if (url.startsWith("/structures/mp-")) return mp
      if (url === "/projects/p/structures" && body) { savedAttachments = [mpAttachment]; savedVersion = 2; return project() }
      if (url === "/feff/jobs") return job("complete", { request: body as ArtemisFeffRequest, provenance: { ...job().provenance, structure: mp, cif: mp.cif } })
      return fallback(url, body, signal)
    })
    const { onAddPaths } = setup()
    fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: provider } })
    fireEvent.change(screen.getByLabelText(provider === "auto" ? "CIF search query" : "Materials Project search query"), { target: { value: "Cu" } })
    await click(provider === "auto" ? "Search structures" : "Search Materials Project")
    expect(api).toHaveBeenCalledWith(`/structures?q=Cu&limit=25&provider=${provider}`, undefined, expect.any(AbortSignal))
    await click(/Cu.*Materials Project mp-aaaaaaft/)
    expect(api).toHaveBeenCalledWith("/structures/mp-aaaaaaft?provider=materials_project", undefined, expect.any(AbortSignal))
    expect(screen.getByText(/Database version: 2026.04.13/)).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "CIF structure viewer" })).toBeVisible()
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-structure-id", mp.id)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-provider", "materials_project")
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", mp.cif)
    expect(screen.getByRole("button", { name: "Attach to project" })).toBeEnabled()
    expect(api.mock.calls.some(([url, body]) => url === "/projects/p/structures" && body)).toBe(false)
    await click("Attach to project")
    expect(api).toHaveBeenCalledWith("/projects/p/structures", { version: 1, provider: "materials_project", material_id: "mp-aaaaaaft" })
    await openFeff()
    await generate()
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ attachment_id: "mp-cif", version: 2 }), expect.any(AbortSignal))
    selectGeneratedPaths("feff0001.dat")
    await click(/Add selected paths/)
    expect(onAddPaths.mock.calls[0][0][0].label).toContain("Materials Project mp-aaaaaaft")
    expect(screen.queryByText(/AMCSD undefined/)).not.toBeInTheDocument()
  })

  it("discards a pending search when the structure source changes", async () => {
    setup()
    fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: "amcsd" } })
    const late = deferred<unknown>()
    api.mockReturnValueOnce(late.promise)
    fireEvent.change(screen.getByLabelText("AMCSD search query"), { target: { value: "copper" } })
    await click("Search AMCSD")
    const signal = api.mock.calls.at(-1)?.[2]
    fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: "materials_project" } })
    expect(signal?.aborted).toBe(true)
    await act(async () => { late.resolve({ query: "copper", source: "AMCSD", results: [structure()], count: 1, limited: false }) })
    expect(screen.queryByRole("button", { name: /Copper.*AMCSD/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Search Materials Project" })).toBeEnabled()
  })

  it("shows actionable Materials Project connection errors", async () => {
    setup()
    fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: "materials_project" } })
    fireEvent.change(screen.getByLabelText("Materials Project search query"), { target: { value: "Cu2O" } })
    api.mockRejectedValueOnce(new Error("Materials Project search needs an API key. Set MP_API_KEY in the backend environment."))
    await click("Search Materials Project")
    expect(screen.getByRole("alert")).toHaveTextContent("MP_API_KEY")
    expect(screen.getByRole("button", { name: "Search Materials Project" })).toBeEnabled()
  })

  it("uses the spectrum's L3 edge for a matching W absorber in the actual FEFF request", async () => {
    savedAttachments = [tungstenAttachment()]
    const onViewStructure = vi.fn()
    render(<Harness contextKey="p:w" spectrumEdge={{ element: "W", edge: "L3" }} availableSlots={24} onAddPaths={addPathsMock()} onViewStructure={onViewStructure} />)
    await click("Search / attach CIF")
    await click("Use attached Tungsten oxide CIF")
    await openFeff()
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("W")
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L3")
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).toBeChecked()
    expect(screen.getByRole("button", { name: "Run FEFF calculation" })).toBeEnabled()
    expect(onViewStructure).toHaveBeenLastCalledWith("cif1", 3)
    await click("Run FEFF calculation")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ absorber: "W", edge: "L3", site_index: 3 }), expect.any(AbortSignal))
  })

  it("matches the spectrum absorber and edge but requires an explicit choice among inequivalent matching sites", async () => {
    const saved = tungstenAttachment()
    saved.structure.sites.push({ ...saved.structure.sites[0], index: 9, x: 0.5, wyckoff: "4b" })
    savedAttachments = [saved]
    await act(async () => { render(<Harness contextKey="p:w" spectrumEdge={{ element: "W", edge: "L3" }} availableSlots={24} onAddPaths={addPathsMock()} />) })
    await openFeff()
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("W")
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L3")
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).not.toBeChecked()
    expect(screen.getByRole("radio", { name: "Absorber site 9" })).not.toBeChecked()
    expect(screen.getByRole("button", { name: "Run FEFF calculation" })).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 9" }))
    await click("Run FEFF calculation")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ absorber: "W", edge: "L3", site_index: 9 }), expect.any(AbortSignal))
  })

  it("applies late spectrum identity to untouched defaults and invalidates an old calculation when its absorber changes", async () => {
    savedAttachments = [tungstenAttachment()]
    const onViewStructure = vi.fn()
    const props = { contextKey: "p:w", availableSlots: 24, onAddPaths: addPathsMock(), onViewStructure }
    const view = render(<Harness {...props} spectrumEdge={null} />)
    await screen.findByRole("button", { name: "Open attached Tungsten oxide CIF" })
    await openFeff()
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("O")
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("K")
    expect(screen.getByRole("radio", { name: "Absorber site 7" })).not.toBeChecked()
    view.rerender(<Harness {...props} spectrumEdge={{ element: "W", edge: "L3" }} />)
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("W")
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L3")
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).toBeChecked()
    expect(onViewStructure).toHaveBeenLastCalledWith("cif1", 3)
    const late = deferred<ArtemisFeffJob>()
    api.mockReturnValueOnce(late.promise)
    await click("Run FEFF calculation")
    const signal = api.mock.calls.at(-1)?.[2]
    view.rerender(<Harness {...props} spectrumEdge={{ element: "O", edge: "K" }} />)
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("O")
    expect(screen.getByRole("radio", { name: "Absorber site 7" })).toBeChecked()
    expect(onViewStructure).toHaveBeenLastCalledWith("cif1", 7)
    expect(signal?.aborted).toBe(true)
    await act(async () => { late.resolve(job("complete", { request: { ...request, absorber: "W", edge: "L3" } })) })
    expect(screen.queryByText("FEFF calculation complete")).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /Select generated/ })).not.toBeInTheDocument()
    await click("Run FEFF calculation")
    expect(api).toHaveBeenLastCalledWith("/feff/jobs", expect.objectContaining({ absorber: "O", edge: "K", site_index: 7 }), expect.any(AbortSignal))
  })

  it("uses the latest spectrum identity when a structure lookup completes after the metadata changes", async () => {
    const saved = tungstenAttachment()
    const fallback = api.getMockImplementation()!
    const late = deferred<ArtemisStructure>()
    api.mockImplementation(async (url, body, signal) => {
      if (url === "/structures/13088") return late.promise
      if (url === "/projects/p/structures" && body) { savedAttachments = [saved]; savedVersion = 2; return project() }
      return fallback(url, body, signal)
    })
    const props = { contextKey: "p:w", availableSlots: 24, onAddPaths: addPathsMock() }
    const view = render(<Harness {...props} spectrumEdge={{ element: "O", edge: "K" }} />)
    await click("Search / attach CIF")
    await findAndSelect(false)
    view.rerender(<Harness {...props} spectrumEdge={{ element: "W", edge: "L3" }} />)
    await act(async () => { late.resolve(saved.structure) })
    await click("Attach to project")
    await openFeff()
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("W")
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L3")
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).toBeChecked()
    await click("Run FEFF calculation")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ absorber: "W", edge: "L3", site_index: 3, version: 2 }), expect.any(AbortSignal))
  })

  it("updates the attached viewer to the latest automatic site when spectrum metadata changes during attachment", async () => {
    const saved = tungstenAttachment()
    const late = deferred<AthenaProject>()
    const fallback = api.getMockImplementation()!
    api.mockImplementation(async (url, body, signal) => {
      if (url === "/structures/13088") return saved.structure
      if (url === "/projects/p/structures" && body) return late.promise
      return fallback(url, body, signal)
    })
    const onViewStructure = vi.fn()
    const props = { contextKey: "p:w", availableSlots: 24, onAddPaths: addPathsMock(), onViewStructure }
    const view = render(<Harness {...props} spectrumEdge={{ element: "W", edge: "L3" }} />)
    await click("Search / attach CIF")
    await findAndSelect(false)
    await click("Attach to project")
    expect(onViewStructure).not.toHaveBeenCalled()
    view.rerender(<Harness {...props} spectrumEdge={{ element: "O", edge: "K" }} />)
    savedAttachments = [saved]; savedVersion = 2
    await act(async () => { late.resolve(project()) })
    expect(onViewStructure).toHaveBeenLastCalledWith("cif1", 7)
    await openFeff()
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("O")
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("K")
    expect(screen.getByRole("radio", { name: "Absorber site 7" })).toBeChecked()
    await click("Run FEFF calculation")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ absorber: "O", edge: "K", site_index: 7, version: 2 }), expect.any(AbortSignal))
  })

  it("preserves a manual absorber and site through metadata updates but resets them for another CIF", async () => {
    const first = tungstenAttachment()
    const second = { ...tungstenAttachment(), id: "cif2", amcsd_id: 9994, structure: { ...tungstenAttachment().structure, id: 9994, cif: "data_other_tungsten" } }
    savedAttachments = [first, second]
    const props = { contextKey: "p:w", availableSlots: 24, onAddPaths: addPathsMock() }
    const view = render(<Harness {...props} spectrumEdge={{ element: "W", edge: "L3" }} />)
    await screen.findAllByRole("button", { name: "Open attached Tungsten oxide CIF" })
    await openFeff()
    fireEvent.change(screen.getByLabelText("FEFF crystal structure"), { target: { value: "cif1" } })
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "O" } })
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 7" }))
    view.rerender(<Harness {...props} spectrumEdge={{ element: "W", edge: "L2" }} />)
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("O")
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("K")
    expect(screen.getByRole("radio", { name: "Absorber site 7" })).toBeChecked()
    await click("Close")
    await openFeff()
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("O")
    expect(screen.getByRole("radio", { name: "Absorber site 7" })).toBeChecked()
    fireEvent.change(screen.getByLabelText("FEFF crystal structure"), { target: { value: "cif2" } })
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("W")
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L2")
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).toBeChecked()
  })

  it.each([false, true])("does not substitute another absorber when the spectrum element has no matching CIF site (listed element: %s)", async listed => {
    const saved = attachment()
    if (listed) saved.structure.elements.push("W")
    savedAttachments = [saved]
    await act(async () => { render(<Harness contextKey="p:w" spectrumEdge={{ element: "W", edge: "L3" }} availableSlots={24} onAddPaths={addPathsMock()} />) })
    await openFeff()
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("")
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run FEFF calculation" })).toBeDisabled()
    expect(api.mock.calls.some(([url]) => url === "/feff/jobs")).toBe(false)
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "Cu" } })
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
    await click("Run FEFF calculation")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ absorber: "Cu", edge: "K", site_index: 3 }), expect.any(AbortSignal))
  })

  it("requires an explicit supported edge instead of silently replacing the spectrum's unsupported edge with K", async () => {
    savedAttachments = [tungstenAttachment()]
    await act(async () => { render(<Harness contextKey="p:w" spectrumEdge={{ element: "W", edge: "M5" }} availableSlots={24} onAddPaths={addPathsMock()} />) })
    await openFeff()
    expect(screen.getByLabelText("FEFF absorber")).toHaveValue("W")
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).toBeChecked()
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("")
    expect(screen.getByRole("button", { name: "Run FEFF calculation" })).toBeDisabled()
    expect(api.mock.calls.some(([url]) => url === "/feff/jobs")).toBe(false)
    fireEvent.change(screen.getByLabelText("FEFF absorption edge"), { target: { value: "L3" } })
    await click("Run FEFF calculation")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ absorber: "W", edge: "L3", site_index: 3 }), expect.any(AbortSignal))
  })

  it("preserves a chosen edge for its absorber across reopening and spectrum metadata updates", async () => {
    savedAttachments = [tungstenAttachment()]
    const props = { contextKey: "p:w", spectrumEdge: { element: "W", edge: "L3" }, availableSlots: 24, onAddPaths: addPathsMock() }
    const view = render(<Harness {...props} />)
    await click("Search / attach CIF")
    await click("Use attached Tungsten oxide CIF")
    await openFeff()
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "W" } })
    fireEvent.change(screen.getByLabelText("FEFF absorption edge"), { target: { value: "L1" } })
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
    await click("Close")
    view.rerender(<Harness {...props} spectrumEdge={{ element: "W", edge: "L2" }} />)
    await click("Search / attach CIF")
    const crystalDialog = screen.getByRole("dialog", { name: "Crystal structures" })
    expect(within(crystalDialog).queryByLabelText("FEFF absorption edge")).not.toBeInTheDocument()
    await openFeff()
    expect(screen.getByRole("radio", { name: "Absorber site 3" })).toBeChecked()
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L1")
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "O" } })
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("K")
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "W" } })
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L1")
    await generate()
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ absorber: "W", edge: "L1" }), expect.any(AbortSignal))
  })

  it("resets edge overrides when switching spectra and does not carry an L edge into unknown data", async () => {
    savedAttachments = [tungstenAttachment()]
    const props = { contextKey: "p:w", spectrumEdge: { element: "W", edge: "L3" }, availableSlots: 24, onAddPaths: addPathsMock() }
    const view = render(<Harness {...props} />)
    await click("Search / attach CIF")
    await click("Use attached Tungsten oxide CIF")
    await openFeff()
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "W" } })
    fireEvent.change(screen.getByLabelText("FEFF absorption edge"), { target: { value: "L1" } })
    view.rerender(<Harness {...props} contextKey="p:w2" spectrumEdge={{ element: "W", edge: "L2" }} />)
    await click("Search / attach CIF")
    await click("Use attached Tungsten oxide CIF")
    await openFeff()
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "W" } })
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L2")
    view.rerender(<Harness {...props} contextKey="p:unknown" spectrumEdge={null} />)
    await click("Search / attach CIF")
    await click("Use attached Tungsten oxide CIF")
    await openFeff()
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "W" } })
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("K")
  })

  it("invalidates an in-flight calculation when the default spectrum edge changes", async () => {
    savedAttachments = [tungstenAttachment()]
    const props = { contextKey: "p:w", spectrumEdge: { element: "W", edge: "L3" }, availableSlots: 24, onAddPaths: addPathsMock() }
    const view = render(<Harness {...props} />)
    await click("Search / attach CIF")
    await click("Use attached Tungsten oxide CIF")
    await openFeff()
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "W" } })
    const late = deferred<ArtemisFeffJob>()
    api.mockReturnValueOnce(late.promise)
    await generate()
    const signal = api.mock.calls.at(-1)?.[2]
    view.rerender(<Harness {...props} spectrumEdge={{ element: "W", edge: "L2" }} />)
    expect(screen.getByLabelText("FEFF absorption edge")).toHaveValue("L2")
    expect(signal?.aborted).toBe(true)
    await act(async () => { late.resolve(job("complete", { request: { ...request, absorber: "W", edge: "L3" } })) })
    expect(screen.queryByText("FEFF calculation complete")).not.toBeInTheDocument()
  })

  it("shows explicit removal beside Open and removes only that CIF without changing fit paths", async () => {
    const other = { ...attachment(), id: "cif2", amcsd_id: 9994, structure: structure({ id: 9994, mineral: "Cuprite" }) }
    savedAttachments = [attachment(), other]
    const onProjectChange = vi.fn(), onAddPaths = addPathsMock()
    await act(async () => { render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} />) })
    const remove = screen.getByRole("button", { name: "Remove Copper CIF from project" })
    expect(remove).toBeVisible()
    expect(remove).toHaveTextContent("Remove CIF")
    expect(remove.querySelector("svg")).toBeInTheDocument()
    expect(within(remove.closest("li")!).getByRole("button", { name: "Open attached Copper CIF" })).toBeVisible()
    await click("Remove Copper CIF from project")
    expect(api).toHaveBeenCalledWith("/projects/p/structures/cif1/remove", { version: 1 })
    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 2, artemis_structures: [other] }))
    expect(screen.queryByRole("button", { name: "Open attached Copper CIF" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Remove Cuprite CIF from project" })).toBeEnabled()
    expect(screen.getByRole("status")).toHaveTextContent("Existing FEFF paths are kept. Undo restores the CIF.")
    expect(onAddPaths).not.toHaveBeenCalled()
  })

  it("removes the open CIF from the dialog and clears its viewer, selected site and generated candidates", async () => {
    const onFirstShellChange = vi.fn(), onRadialContextChange = vi.fn(), onAddPaths = addPathsMock()
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={onAddPaths} onFirstShellChange={onFirstShellChange} onRadialContextChange={onRadialContextChange} />)
    await click("Search / attach CIF")
    await findAndSelect()
    await generate()
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeVisible()
    for (const filename of ["feff0001.dat", "feff0002.dat"]) {
      const candidate = screen.getByRole("checkbox", { name: `Select generated ${filename}` }).closest("label")!
      expect(within(candidate).getByText("Shell unavailable")).toBeVisible()
    }
    await click("Close")
    await click("Search / attach CIF")
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove Copper CIF from project" })) })
    expect(screen.getByRole("dialog")).toBeVisible()
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "Absorber site 3" })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: "Select generated feff0001.dat" })).not.toBeInTheDocument()
    expect(onFirstShellChange).toHaveBeenLastCalledWith(null)
    expect(onRadialContextChange).toHaveBeenLastCalledWith(null)
    expect(onAddPaths).not.toHaveBeenCalled()
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent("Undo restores the CIF")
  })

  it("retains the attachment on removal failure and allows retry from the project list", async () => {
    savedAttachments = [attachment()]
    await act(async () => { render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} />) })
    api.mockRejectedValueOnce(new Error("Project changed. Refresh and retry."))
    await click("Remove Copper CIF from project")
    expect(screen.getByRole("alert")).toHaveTextContent("Project changed")
    expect(screen.getByRole("button", { name: "Open attached Copper CIF" })).toBeEnabled()
    await click("Remove Copper CIF from project")
    expect(screen.queryByRole("button", { name: "Open attached Copper CIF" })).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("blocks duplicate removal and dismissal and receives a committed response after switching spectra", async () => {
    savedAttachments = [attachment()]
    const onProjectChange = vi.fn(), onAddPaths = addPathsMock()
    const view = render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} />)
    await click("Search / attach CIF")
    await click("Use attached Copper CIF")
    await openFeff()
    await generate()
    selectGeneratedPaths("feff0001.dat")
    await click("Close")
    await click("Search / attach CIF")
    const late = deferred<AthenaProject>()
    api.mockReturnValueOnce(late.promise)
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove Copper CIF from project" })) })
    expect(api.mock.calls.at(-1)?.[2]).toBeUndefined()
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove Copper CIF from project" })).toBeDisabled()
    expect(screen.queryByRole("checkbox", { name: "Select generated feff0001.dat" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add selected paths (1)" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled()
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }))
    expect(screen.getByRole("dialog")).toBeVisible()
    view.rerender(<Harness contextKey="p:fe" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} />)
    savedAttachments = []; savedVersion = 2
    await act(async () => { late.resolve(project()) })
    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 2, artemis_structures: [] }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("waits for model autosave before removing at its latest revision and releases the mutation queue", async () => {
    savedAttachments = [attachment()]
    const preparation = deferred<{ version: number; finish: () => void }>()
    const finish = vi.fn(), prepareMutation = vi.fn(() => preparation.promise)
    await act(async () => { render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} prepareMutation={prepareMutation} />) })
    await click("Remove Copper CIF from project")
    expect(prepareMutation).toHaveBeenCalledExactlyOnceWith()
    expect(api.mock.calls.some(([url]) => url.endsWith("/remove"))).toBe(false)
    expect(screen.getByRole("button", { name: "Remove Copper CIF from project" })).toBeDisabled()
    savedVersion = 7
    await act(async () => { preparation.resolve({ version: 7, finish }) })
    expect(api).toHaveBeenCalledWith("/projects/p/structures/cif1/remove", { version: 7 })
    expect(finish).toHaveBeenCalledExactlyOnceWith()
    expect(screen.getByRole("status")).toHaveTextContent("Undo restores the CIF")
  })

  it("cancels a queued removal before it is sent when the context changes and releases the queue", async () => {
    savedAttachments = [attachment()]
    const preparation = deferred<{ version: number; finish: () => void }>()
    const finish = vi.fn(), prepareMutation = vi.fn(() => preparation.promise), onProjectChange = vi.fn(), onAddPaths = addPathsMock()
    const view = render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} prepareMutation={prepareMutation} />)
    await click("Search / attach CIF")
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove Copper CIF from project" })) })
    view.rerender(<Harness contextKey="p:fe" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} prepareMutation={prepareMutation} />)
    await act(async () => { preparation.resolve({ version: 7, finish }) })
    expect(api.mock.calls.some(([url]) => url.endsWith("/remove"))).toBe(false)
    expect(finish).toHaveBeenCalledExactlyOnceWith()
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it("unions fitting shell selections while enforcing capacity on Add", async () => {
    const generated = job()
    for (const path of generated.paths) path.metadata.geometry.push({ atom: "Cu", ipot: 1, x: path.metadata.reff, y: 0, z: 0 })
    const analysis = { ...radialFixture, cif: structure().cif, absorber: "Cu", site_index: 3,
      neighbors: generated.paths.map((path, i) => ({ ...radialFixture.neighbors[i], id: i, element: "Cu", distance: path.metadata.reff, shell_index: i + 1, group_id: `${i + 1}.1`, cartesian_offset: [path.metadata.reff, 0, 0] })),
      shells: radialFixture.shells.map((shell, i) => ({ ...shell, r_min: generated.paths[i].metadata.reff, r_max: generated.paths[i].metadata.reff })),
    }
    radialAnalysis.mockImplementation((_structure, site) => ({ contextKey: "test", data: site ? analysis : null, loading: false, error: "", retry: () => {}, settings: { radius: 6, tolerance: 0.05 }, setSettings: () => {} }))
    setup(1)
    await findAndSelect()
    api.mockResolvedValueOnce(generated)
    await generate()
    for (const [index, filename] of ["feff0001.dat", "feff0002.dat"].entries()) {
      const candidate = screen.getByRole("checkbox", { name: `Select generated ${filename}` }).closest("label")!
      expect(within(candidate).getByText(`Shell ${index + 1}`)).toBeVisible()
    }
    selectGeneratedPaths()
    await click("Select shell 1 paths")
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeChecked()
    await click("Select shell 2 paths")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Select generated feff0002.dat" })).toBeChecked()
    expect(screen.queryByRole("button", { name: "Run EXAFS simulation" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add selected paths (2)" })).toBeDisabled()
    await click("Deselect shell 1 paths")
    expect(screen.getByRole("checkbox", { name: "Select generated feff0002.dat" })).toBeChecked()
    expect(screen.getByRole("button", { name: "Add selected paths (1)" })).toBeEnabled()
  })

  it("opens an accessible popup, preserves selection across Escape/reopen, and restores launcher focus", async () => {
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "AMCSD search query" })).not.toBeInTheDocument()
    const launcher = screen.getByRole("button", { name: "Search / attach CIF" })
    launcher.focus()
    await click("Search / attach CIF")
    expect(screen.getByRole("dialog", { name: "Crystal structures" })).toBeVisible()
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

  it("attaches the selected CIF explicitly before choosing the FEFF site at the updated project revision", async () => {
    const onProjectChange = vi.fn()
    const onViewStructure = vi.fn()
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} onProjectChange={onProjectChange} onViewStructure={onViewStructure} />)
    await click("Search / attach CIF")
    await findAndSelect(false)
    const crystalDialog = screen.getByRole("dialog", { name: "Crystal structures" })
    expect(within(crystalDialog).queryByRole("radio", { name: "Absorber site 3" })).not.toBeInTheDocument()
    expect(within(crystalDialog).queryByRole("button", { name: "Run FEFF calculation" })).not.toBeInTheDocument()
    expect(within(crystalDialog).getByRole("region", { name: "CIF structure viewer" })).toBeVisible()
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", structure().cif)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-structure-id", "13088")
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-provider", "amcsd")
    expect(screen.getByText("View CIF").closest("details")).not.toHaveAttribute("open")
    expect(onViewStructure).not.toHaveBeenCalled()
    expect(api.mock.calls.some(([url, body]) => url === "/projects/p/structures" && body)).toBe(false)
    await click("Attach to project")
    expect(api).toHaveBeenCalledWith("/projects/p/structures", { version: 1, amcsd_id: 13088 })
    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "p", version: 2, artemis_structures: [attachment()] }))
    expect(onViewStructure).toHaveBeenCalledExactlyOnceWith("cif1", undefined)
    expect(crystalDialog).toBeVisible()
    expect(screen.getByRole("region", { name: "CIF structure viewer" })).toBeVisible()
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", attachment().structure.cif)
    await openFeff()
    expect(screen.getByRole("dialog", { name: "FEFF paths" })).toBeVisible()
    expect(screen.getByLabelText("FEFF crystal structure")).toHaveValue("cif1")
    expect(screen.getByRole("button", { name: "Run FEFF calculation" })).toBeDisabled()
    await generate()
    expect(api.mock.calls.at(-1)?.[1]).toEqual(request)
    expect(api.mock.calls.at(-1)?.[1]).not.toHaveProperty("amcsd_id")
  })

  it("replaces the candidate preview and clears it while the next CIF loads or fails", async () => {
    const cuprite = structure({ id: 13089, mineral: "Cuprite", formula: "Cu2O", cif: "data_Cu2O\n_cell_length_a 4.27" })
    const next = deferred<ArtemisStructure>()
    const fallback = api.getMockImplementation()!
    api.mockImplementation(async (url, body, signal) => {
      if (url.startsWith("/structures?")) return { query: "copper", source: "AMCSD", results: [structure(), cuprite], count: 2, limited: false }
      if (url === "/structures/13089") return next.promise
      return fallback(url, body, signal)
    })
    const onProjectChange = vi.fn(), onViewStructure = vi.fn()
    render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={addPathsMock()} onProjectChange={onProjectChange} onViewStructure={onViewStructure} />)
    await click("Search / attach CIF")
    await findAndSelect(false)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", structure().cif)
    await click(/Cuprite.*AMCSD/)
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Reading CIF")
    expect(screen.queryByRole("button", { name: "Attach to project" })).not.toBeInTheDocument()
    await act(async () => { next.resolve(cuprite) })
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-structure-id", "13089")
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", cuprite.cif)
    await click(/Copper.*AMCSD/)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", structure().cif)
    api.mockRejectedValueOnce(new Error("Could not retrieve the selected CIF. Try again."))
    await click(/Cuprite.*AMCSD/)
    expect(screen.getByRole("alert")).toHaveTextContent("Could not retrieve the selected CIF")
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Attach to project" })).not.toBeInTheDocument()
    await click(/Cuprite.*AMCSD/)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", cuprite.cif)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onViewStructure).not.toHaveBeenCalled()
    expect(api.mock.calls.some(([url, body]) => url === "/projects/p/structures" && body)).toBe(false)
    expect(api.mock.calls.some(([url]) => url === "/feff/jobs")).toBe(false)
  })

  it("ignores a late CIF response after another candidate was selected", async () => {
    const cuprite = structure({ id: 13089, mineral: "Cuprite", formula: "Cu2O", cif: "data_Cu2O" })
    const next = deferred<ArtemisStructure>()
    const fallback = api.getMockImplementation()!
    api.mockImplementation(async (url, body, signal) => {
      if (url.startsWith("/structures?")) return { query: "copper", source: "AMCSD", results: [structure(), cuprite], count: 2, limited: false }
      if (url === "/structures/13089") return next.promise
      return fallback(url, body, signal)
    })
    setup()
    await findAndSelect(false)
    await click(/Cuprite.*AMCSD/)
    const signal = api.mock.calls.at(-1)?.[2]
    expect(screen.queryByTestId("cif-viewer")).not.toBeInTheDocument()
    await click(/Copper.*AMCSD/)
    expect(signal?.aborted).toBe(true)
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-structure-id", "13088")
    await act(async () => { next.resolve(cuprite) })
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-structure-id", "13088")
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", structure().cif)
    expect(screen.getByRole("button", { name: /Copper.*AMCSD/ })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /Cuprite.*AMCSD/ })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "Attach to project" })).toBeEnabled()
  })

  it("blocks dismissal during attachment and receives the committed project after the context changes", async () => {
    const onProjectChange = vi.fn(), onAddPaths = addPathsMock()
    const view = render(<Harness contextKey="p:cu" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} />)
    await click("Search / attach CIF")
    await findAndSelect(false)
    const late = deferred<AthenaProject>()
    api.mockReturnValueOnce(late.promise)
    await click("Attach to project")
    expect(api.mock.calls.at(-1)?.[2]).toBeUndefined()
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled()
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }))
    expect(screen.getByRole("dialog")).toBeVisible()
    view.rerender(<Harness contextKey="p:fe" availableSlots={24} onAddPaths={onAddPaths} onProjectChange={onProjectChange} />)
    savedAttachments = [attachment()]; savedVersion = 2
    await act(async () => { late.resolve(project()) })
    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 2, artemis_structures: [attachment()] }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("retains the chosen CIF after attach failure and retries the same explicit operation", async () => {
    setup()
    await findAndSelect(false)
    api.mockRejectedValueOnce(new Error("Project changed. Refresh and retry."))
    await click("Attach to project")
    expect(screen.getByRole("alert")).toHaveTextContent("Project changed")
    expect(screen.getByRole("button", { name: "Attach to project" })).toBeEnabled()
    expect(screen.getByText(/Copper structure/)).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About CIF citation" }))
    expect(screen.getByText(/Copper structure/)).toBeVisible()
    expect(screen.getByRole("region", { name: "CIF structure viewer" })).toBeVisible()
    expect(screen.getByTestId("cif-viewer")).toHaveAttribute("data-cif", structure().cif)
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
    expect(onViewStructure).toHaveBeenCalledExactlyOnceWith("cif1", undefined)
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
    expect(screen.getByText("Upload a CIF, select a search result, or open a CIF already attached to this project.")).toBeVisible()
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
    fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: "amcsd" } })
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
    expect(screen.getByLabelText("FEFF crystal structure")).toHaveValue("cif1")
    expect(screen.getByText("Cu · site 3 · Wyckoff 4a")).toBeVisible()
    expect(screen.getByRole("button", { name: "Run FEFF calculation" })).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
    fireEvent.change(screen.getByLabelText("FEFF absorber"), { target: { value: "Fe" } })
    expect(screen.queryByRole("radio", { name: "Absorber site 3" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run FEFF calculation" })).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 7" }))
    fireEvent.change(screen.getByLabelText("FEFF absorption edge"), { target: { value: "L3" } })
    await click("Run FEFF calculation")
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ ...request, absorber: "Fe", site_index: 7, edge: "L3" })
  })

  it("keeps unsupported CIF view/attachment available even when cell metadata is missing", async () => {
    setup()
    fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: "amcsd" } })
    fireEvent.change(screen.getByLabelText("AMCSD search query"), { target: { value: "copper" } })
    await click("Search AMCSD")
    api.mockResolvedValueOnce(structure({ supported: false, ordered: false, cell: {}, sites: [], elements: [], warnings: ["The CIF cannot be parsed."] }))
    await click(/Copper.*AMCSD/)
    expect(screen.getByRole("button", { name: "Attach to project" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Download CIF" })).not.toBeInTheDocument()
    expect(screen.getByText("The CIF cannot be parsed.")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Run FEFF calculation" })).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("cannot be used for FEFF")
  })

  it("validates cluster/path bounds before launching FEFF", async () => {
    setup()
    await findAndSelect()
    fireEvent.click(screen.getByRole("radio", { name: "Absorber site 3" }))
    fireEvent.change(screen.getByLabelText("FEFF maximum path radius"), { target: { value: "6" } })
    await click("Run FEFF calculation")
    expect(screen.getByRole("alert")).toHaveTextContent("path radius of 2 Å up to the cluster radius")
    expect(api.mock.calls.some(([url]) => url === "/feff/jobs")).toBe(false)
  })

  it("polls running jobs, defaults all paths checked, and appends only a subset that fits", async () => {
    const { onAddPaths } = setup(1)
    await findAndSelect()
    api.mockResolvedValueOnce(job("running"))
    vi.useFakeTimers()
    await generate()
    expect(screen.getByRole("button", { name: "Calculating FEFF…" })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(screen.getByText("FEFF calculation complete")).toBeVisible()
    for (const checkbox of screen.getAllByRole("checkbox", { name: /^Select generated / })) expect(checkbox).toBeChecked()
    expect(screen.getByRole("button", { name: "Add selected paths (2)" })).toBeDisabled()
    selectGeneratedPaths("feff0001.dat")
    expect(screen.getByRole("checkbox", { name: "Select generated feff0002.dat" })).toBeEnabled()
    await click("Add selected paths (1)")
    expect(onAddPaths).toHaveBeenCalledExactlyOnceWith([{ ...job().paths[0], id: undefined,
      metadata: { ...job().paths[0].metadata, sourceCif: { sha256: attachment().sha256, attachmentId: "cif1", label: "Copper · AMCSD 0013088", siteIndex: 3 } },
      label: "Copper · AMCSD 0013088 · Cu site 3 · feff0001.dat" }].map(({ id: _id, ...path }) => path))
    for (const checkbox of screen.getAllByRole("checkbox", { name: /^Select generated / })) expect(checkbox).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeEnabled()
    selectGeneratedPaths("feff0001.dat")
    expect(screen.getByRole("button", { name: "Add selected paths (0)" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Run EXAFS simulation" })).not.toBeInTheDocument()
    expect(screen.getByText(/Added 1 generated path/)).toBeVisible()
    expect(screen.getByText("FEFF input")).toBeVisible()
  })

  it("says an uploaded path stays in the fit after adding generated ones, and offers to replace it", async () => {
    // Adding generated feff0001.dat beside an uploaded feffcu01.dat of the
    // same shell left both included, and the refit fitted the shell twice.
    const onAddPaths = vi.fn<(paths: ArtemisGeneratedPath[], replace?: boolean) => string | null>(() => null)
    const uploaded = [{ filename: "feffcu01.dat", content: "uploaded path", enabled: true }]
    render(<Harness contextKey="p:cu" availableSlots={23} existingPaths={uploaded} onAddPaths={onAddPaths} />)
    fireEvent.click(screen.getByRole("button", { name: "Search / attach CIF" }))
    await findAndSelect()
    await generate()
    selectGeneratedPaths("feff0001.dat")
    expect(screen.getByText(/already includes feffcu01\.dat/)).toBeVisible()
    await click("Add selected paths (1)")
    expect(screen.getByText(/feffcu01\.dat is still included/)).toBeVisible()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0002.dat" }))
    await click(/Replace the model’s 1 path with selected \(1\)/)
    expect(onAddPaths).toHaveBeenLastCalledWith([expect.objectContaining({ filename: "feff0002.dat" })], true)
    expect(screen.getByText(/Replaced the fit model's paths/)).toBeVisible()
  })

  it("lets a full model choose its replacement: Replace is not limited to Add's open slots", async () => {
    // With 24 paths and no open slot, every generated checkbox was disabled.
    const onAddPaths = vi.fn<(paths: ArtemisGeneratedPath[], replace?: boolean) => string | null>(() => null)
    const existing = Array.from({ length: 24 }, (_, i) => ({ filename: `old-${i}.dat`, content: `old-${i}`, enabled: true }))
    render(<Harness contextKey="p:cu" availableSlots={0} existingPaths={existing} onAddPaths={onAddPaths} />)
    fireEvent.click(screen.getByRole("button", { name: "Search / attach CIF" }))
    await findAndSelect()
    await generate()
    selectGeneratedPaths("feff0001.dat")
    expect(screen.getByRole("button", { name: "Add selected paths (1)" })).toBeDisabled()
    await click(/Replace the model’s 24 paths with selected \(1\)/)
    expect(onAddPaths).toHaveBeenLastCalledWith([expect.objectContaining({ filename: "feff0001.dat" })], true)
  })

  it("lets a replacement keep a generated path already in the model, which Add skips", async () => {
    // An added generated path was disabled, so Replace could only discard it.
    const onAddPaths = vi.fn<(paths: ArtemisGeneratedPath[], replace?: boolean) => string | null>(() => null)
    const existing = [job().paths[0], { filename: "uploaded.dat", content: "old", enabled: true }]
    render(<Harness contextKey="p:cu" availableSlots={22} existingPaths={existing} onAddPaths={onAddPaths} />)
    fireEvent.click(screen.getByRole("button", { name: "Search / attach CIF" }))
    await findAndSelect()
    await generate()
    selectGeneratedPaths("feff0001.dat")
    expect(screen.getByRole("button", { name: "Add selected paths (0)" })).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select generated feff0002.dat" }))
    await click(/Replace the model’s 2 paths with selected \(2\)/)
    expect(onAddPaths).toHaveBeenLastCalledWith([expect.objectContaining({ filename: "feff0001.dat" }), expect.objectContaining({ filename: "feff0002.dat" })], true)
  })

  it("lets the first-shell shortcut fill a replacement of a full model that already holds the shell path", async () => {
    // The shortcut skipped paths already in the model and checked Add's open
    // slots, so with a full model it stayed disabled although Replace could take it.
    const onAddPaths = vi.fn<(paths: ArtemisGeneratedPath[], replace?: boolean) => string | null>(() => null)
    firstShell.shell = { method: "CrystalNN", pymatgen_version: "test", cif: structure().cif, cif_sha256: "abc", absorber: "Cu", site_index: 3, coordination_number: 12, coordination_weight: 1, alternatives: [], warnings: [],
      neighbors: [{ element: "Cu", structure_index: 3, image: [0, 0, 0], fractional_offset: [0.5, 0.5, 0], cartesian_offset: [2.55, 0, 0], distance: 2.55, weight: 1 }] }
    const generated = job()
    generated.paths[0].metadata.geometry = [{ atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }, { atom: "Cu", x: 2.55, y: 0, z: 0, ipot: 1 }]
    const existing = [generated.paths[0], ...Array.from({ length: 23 }, (_, i) => ({ filename: `old-${i}.dat`, content: `old-${i}`, enabled: true }))]
    render(<Harness contextKey="p:cu" availableSlots={0} existingPaths={existing} onAddPaths={onAddPaths} />)
    fireEvent.click(screen.getByRole("button", { name: "Search / attach CIF" }))
    await findAndSelect()
    api.mockResolvedValueOnce(generated)
    await generate()
    await click("Select first-shell paths")
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeChecked()
    await click(/Replace the model’s 24 paths with selected \(1\)/)
    expect(onAddPaths).toHaveBeenLastCalledWith([expect.objectContaining({ filename: "feff0001.dat" })], true)
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
    await openFeff()
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
    selectGeneratedPaths("feff0001.dat")
    await click("Add selected paths (1)")
    expect(onAddPaths.mock.calls[0][0][0].metadata.viewerCluster).toEqual({ source: "feff.inp", atoms: [
      { atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 },
      { atom: "Cu", x: 2.55, y: 0, z: 0, ipot: 1 },
      { atom: "Cu", x: -2.55, y: 0, z: 0, ipot: 1 },
    ] })
    expect(onAddPaths.mock.calls[0][0][0].metadata.degen).toBe(12)
    expect(onAddPaths.mock.calls[0][0][0].metadata.sourceCif).toEqual({ sha256: attachment().sha256,
      attachmentId: "cif1", label: "Copper · AMCSD 0013088", siteIndex: 3 })
    expect(completed.paths[0].metadata).not.toHaveProperty("viewerCluster")
    expect(completed.paths[0].metadata).not.toHaveProperty("sourceCif")
  })

  it("identifies a completed job by its actual CIF when the saved attachment snapshot differs", async () => {
    vi.stubGlobal("crypto", webcrypto)
    const { onAddPaths } = setup()
    await findAndSelect()
    const completed = job()
    completed.provenance.cif = "data_completed_snapshot\n_cell_length_a 3.62"
    api.mockResolvedValueOnce(completed)
    await generate()
    selectGeneratedPaths("feff0001.dat")
    await click("Add selected paths (1)")
    await waitFor(() => expect(onAddPaths).toHaveBeenCalledOnce())
    expect(onAddPaths.mock.calls[0][0][0].metadata.sourceCif).toEqual({
      sha256: createHash("sha256").update(completed.provenance.cif).digest("hex"),
      label: "Copper · AMCSD 0013088", siteIndex: 3,
    })
  })

  it("does not add paths to another spectrum after hashing their CIF finishes", async () => {
    const hashed = deferred<ArrayBuffer>()
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(() => hashed.promise) } })
    const { onAddPaths, rerender } = setup()
    await findAndSelect()
    const completed = job()
    completed.provenance.cif = "data_completed_snapshot"
    api.mockResolvedValueOnce(completed)
    await generate()
    selectGeneratedPaths("feff0001.dat")
    await click("Add selected paths (1)")
    expect(screen.getByRole("button", { name: "Add selected paths (1)" })).toBeDisabled()
    rerender(<Harness contextKey="p:fe" availableSlots={24} onAddPaths={onAddPaths} />)
    await act(async () => { hashed.resolve(new Uint8Array(32).buffer) })
    expect(onAddPaths).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Generate FEFF paths" })).toBeEnabled()
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
    expect(screen.getByRole("button", { name: "Run FEFF calculation" })).toBeEnabled()
  })

  it("ignores an old structure lookup after another result or spectrum is selected", async () => {
    const { rerender, onAddPaths } = setup()
    fireEvent.change(screen.getByLabelText("Structure source"), { target: { value: "amcsd" } })
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
    selectGeneratedPaths("feff0001.dat")
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
    selectGeneratedPaths("feff0001.dat")
    await click("Add selected paths (1)")
    const paths = onAddPaths.mock.calls[0][0]
    expect(paths[0].label).toHaveLength(120)
    expect(paths[0].label).toMatch(/AMCSD 0013088 · Cu site 3 · feff0001.dat$/)
    view.rerender(<Harness contextKey="p:cu" availableSlots={23} existingPaths={paths} onAddPaths={onAddPaths} />)
    // Already in the model: Add cannot take it again (Replace may keep it).
    expect(screen.getByText(/feff0001\.dat · added/)).toBeVisible()
    selectGeneratedPaths("feff0001.dat")
    expect(screen.getByRole("button", { name: "Add selected paths (0)" })).toBeDisabled()
    selectGeneratedPaths()
    view.rerender(<Harness contextKey="p:cu" availableSlots={24} existingPaths={[]} onAddPaths={onAddPaths} />)
    expect(screen.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeEnabled()
  })
})
