import "@testing-library/jest-dom/vitest"
import { StrictMode, useLayoutEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { athenaApi, type Analysis, type AthenaGroup, type AthenaProject, type Parameters, type E0Method } from "@/lib/athena"
import { ApiRequestError } from "@/lib/backend-client"
import type { InspectionResponse } from "@/lib/contracts"
import { AthenaPlot } from "./athena-plot"
import { AthenaProjectImport } from "./athena-project-import"
import { edgePolicyStorageKey } from "./athena-edge-policy"
import { AthenaWorkbench } from "./athena-workbench"
import { differenceOptions, differencePreview, differenceSaved } from "./athena-difference.fixtures"

// Full workbench flows exercise many controls; leave time for jsdom style/accessibility
// calculation on shared CI hosts. Individual waitFor assertions stay bounded.
vi.setConfig({ testTimeout: 15000 })

vi.mock("@/lib/athena", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/athena")>(),
  athenaApi: vi.fn(),
}))

// Observe the workbench's data handoff without loading Plotly or testing its internals.
vi.mock("./athena-plot", () => ({
  AthenaPlot: vi.fn(() => <div data-testid="athena-plot" />),
}))
vi.mock("./athena-difference-plot", () => ({ AthenaDifferencePlot: () => <div data-testid="difference-preview-plot" /> }))
// The standalone panel tests own preview/import interactions; verify its host contract here.
vi.mock("./athena-project-import", () => ({
  AthenaProjectImport: vi.fn(() => <div data-testid="project-import-panel" />),
}))

const api = vi.mocked(athenaApi)
const plot = vi.mocked(AthenaPlot)
const projectImport = vi.mocked(AthenaProjectImport)
const storageKey = "athena.project"
const dialogDescriptors = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
}

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) { this.setAttribute("open", "") },
  })
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) { this.removeAttribute("open") },
  })
})

afterAll(() => {
  for (const method of ["showModal", "close"] as const) {
    const descriptor = dialogDescriptors[method]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method)
  }
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  api.mockReset()
  api.mockRejectedValue(new Error("Unexpected Athena API request in test"))
  plot.mockClear()
  plot.mockImplementation(() => <div data-testid="athena-plot" />)
  projectImport.mockClear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})

const parameters: Parameters = {
  e0: 8979, step: null, pre1: -150, pre2: -30, norm1: 100, norm2: 300,
  nnorm: 2, flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null,
  bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1, kmin: 3, kmax: 12,
  kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05,
}

// Deliberately small synthetic arrays: these tests verify state/requests, not XAS numerics.
function group(id: string, label: string, marked = false, rbkg = 1): AthenaGroup {
  return {
    id, label, marked, frozen: false, data_type: "mu",
    energy: [8960, 8980, 9000], mu: [0.1, 0.8, 1.1],
    multiplier: 1, offset: 0, notes: "", reference_id: null,
    parameters: { ...parameters, rbkg },
    result: {
      arrays: { energy: [8960, 8980, 9000], norm: [0, 0.7, 1] },
      effective: { e0: 8979, edge_step: 1 }, warnings: [],
    },
    processing_error: null, source: { filename: `${id}.xmu` },
  }
}

function projectFixture(overrides: Partial<AthenaProject> = {}): AthenaProject {
  return {
    id: "project-cu", name: "Copper study", version: 7,
    groups: [
      group("foil", "Foil scan"),
      group("sample", "Sample scan", true, 1.2),
      group("oxide", "Oxide standard", true, 1.4),
      group("unused", "Unused reference", false, 1.6),
    ],
    journal: "Beamline notes", updated: "2026-09-07T12:00:00Z",
    undo: [], redo: [], history: [], ...overrides,
  }
}

function nextProject(project: AthenaProject, changes: Record<string, Partial<AthenaGroup>>): AthenaProject {
  return {
    ...project,
    version: project.version + 1,
    groups: project.groups.map(g => ({ ...g, ...changes[g.id] })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function plotProps() {
  const lastCall = plot.mock.calls.at(-1)
  if (!lastCall) throw new Error("AthenaPlot has not rendered")
  return lastCall[0]
}

async function openSaved(project = projectFixture()) {
  localStorage.setItem(storageKey, project.id)
  api.mockResolvedValueOnce(project)
  render(<AthenaWorkbench />)
  await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/i })).toBeEnabled())
  return project
}

function selectGroup(label: string) {
  fireEvent.click(screen.getByRole("button", { name: name => name.startsWith(label) }))
}

function openGroupMenu() {
  fireEvent.click(within(screen.getByRole("navigation", { name: /main menu/i })).getByRole("button", { name: "Group" }))
}

function editNumber(label: RegExp, value: number | "", container: HTMLElement = document.body) {
  fireEvent.change(within(container).getByRole("spinbutton", { name: label }), { target: { value: String(value) } })
}

async function openTool(menu: "Process" | "Analysis", title: RegExp) {
  fireEvent.click(within(screen.getByRole("navigation", { name: /main menu/i })).getByRole("button", { name: menu }))
  fireEvent.click(screen.getByRole("button", { name: title }))
  return screen.findByRole("dialog", { name: title })
}

async function openParameterDialog(scope = "all", target = "marked") {
  fireEvent.click(screen.getByRole("button", { name: /^Copy \/ reset parameters/i }))
  const dialog = await screen.findByRole("dialog", { name: /^Copy \/ reset parameters/i })
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Parameters to change" }), { target: { value: scope } })
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Destination groups" }), { target: { value: target } })
  return dialog
}

function fitResult(project: AthenaProject, overrides: Partial<Analysis> = {}): Analysis {
  return {
    kind: "lcf", project_version: project.version,
    group_ids: ["sample", "oxide", "foil"], options: { array: "norm" },
    result: {
      x: [8960, 8980, 9000], observed: [0, 0.7, 1], fit: [0, 0.68, 1],
      residual: [0, 0.02, 0], weights: [0.4, 0.6], labels: ["Oxide standard", "Foil scan"],
      rfactor: 0.0001,
    },
    ...overrides,
  }
}

function inspectionFixture(name: string, names = ["Energy", "It", "I0", "If1", "If2", "Ir"]): InspectionResponse {
  return {
    upload_id: `upload-${name}`, display_name: name, row_count: 3, warnings: [], issues: [],
    columns: names.map((name, index) => ({
      column_id: `col_${index}`, name, index, numeric: true, unit: null,
      role_hint: name === "Energy" ? "energy" : name === "I0" ? "i0" : null,
      preview: [1, 2, 3],
    })),
  }
}

function importedProject(project: AthenaProject, name: string): AthenaProject {
  return { ...project, version: project.version + 1, groups: [...project.groups, group(name, name, true)] }
}

async function chooseImportFiles(inspections: InspectionResponse[]) {
  api.mockResolvedValueOnce(inspections[0])
  fireEvent.click(screen.getByRole("button", { name: /^Import data$/i }))
  const dialog = await screen.findByRole("dialog", { name: /import spectra/i })
  const files = inspections.map(i => new File(["Energy It I0 If1 If2 Ir\n8.97 2 3 4 5 1"], i.display_name))
  fireEvent.change(within(dialog).getByLabelText("Choose data files"), { target: { files } })
  await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Import spectrum$/i })).toBeEnabled())
  return { dialog, files }
}

function chooseFluorescenceMapping(dialog: HTMLElement) {
  const view = within(dialog)
  fireEvent.change(view.getByRole("combobox", { name: "Measurement" }), { target: { value: "fluorescence" } })
  fireEvent.change(view.getByRole("combobox", { name: "Data type" }), { target: { value: "xanes" } })
  fireEvent.change(view.getByRole("combobox", { name: "Energy units" }), { target: { value: "keV" } })
  fireEvent.click(view.getByRole("checkbox", { name: "Numerator It" }))
  fireEvent.click(view.getByRole("checkbox", { name: "Numerator If1" }))
  fireEvent.click(view.getByRole("checkbox", { name: "Numerator If2" }))
  fireEvent.click(view.getByText("Reference channel & ordering"))
  fireEvent.change(view.getByLabelText("reference numerator"), { target: { value: "col_1" } })
  fireEvent.change(view.getByLabelText("reference denominator"), { target: { value: "col_5" } })
  fireEvent.click(view.getByRole("checkbox", { name: /sort ascending/i }))
}

const fluorescenceMapping = {
  edge_policy: null,
  energy_column: "col_0", numerator: ["col_3", "col_4"], denominator: "col_2",
  mode: "fluorescence", units: "keV", data_type: "xanes",
  reference_numerator: "col_1", reference_denominator: "col_5", sort: true,
}

function importCalls() {
  return api.mock.calls.filter(([path]) => path.endsWith("/import"))
}

function submitImport(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: /^Import spectrum$/i }))
}

function armPick(label: string) {
  const button = screen.getByRole("button", { name: `Pick ${label} from plot` })
  fireEvent.click(button)
  expect(button).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByRole("button", { name: /Cancel pick/ })).toBeVisible()
  expect(plotProps().picking).toBe(true)
  return plotProps().onPickX!
}

async function openGroupControls() {
  openGroupMenu()
  fireEvent.click(screen.getByRole("button", { name: /Mark \/ freeze groups/ }))
  return screen.findByRole("dialog", { name: "Mark / freeze groups" })
}

async function openE0Dialog() {
  fireEvent.click(within(screen.getByRole("navigation", { name: /main menu/i })).getByRole("button", { name: "Energy" }))
  fireEvent.click(screen.getByRole("button", { name: "Select E₀…" }))
  return screen.findByRole("dialog", { name: "Select E₀" })
}

function chooseE0Method(dialog: HTMLElement, method: E0Method) {
  fireEvent.change(within(dialog).getByRole("combobox", { name: "E₀ method" }), { target: { value: method } })
}

const copperPolicy = { element: "Cu", edge: "K", fraction: 0.5 }
function policyBar() { return screen.getByRole("region", { name: "Import edge policy" }) }
async function openEdgePolicyDialog() {
  fireEvent.click(within(screen.getByRole("navigation", { name: /main menu/i })).getByRole("button", { name: "Energy" }))
  fireEvent.click(screen.getByRole("button", { name: "Enforce element and edge…" }))
  return screen.findByRole("dialog", { name: "Enforce element and edge" })
}
async function enableCopperPolicy() {
  const dialog = await openEdgePolicyDialog()
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Element symbol" }), { target: { value: "cu" } })
  api.mockResolvedValueOnce({ element: "Cu", edges: [{ edge: "K", energy: 8979 }, { edge: "L3", energy: 932.7 }] })
  fireEvent.click(within(dialog).getByRole("button", { name: "Look up edges" }))
  await within(dialog).findByRole("option", { name: "K · 8979 eV" })
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Enforced edge" }), { target: { value: "K" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply enforcement" }))
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(policyBar()).toHaveTextContent("Cu K · fraction 0.5")
}

function identityBar() { return screen.getByRole("region", { name: "Current absorber and edge" }) }
async function openIdentityDialog() {
  fireEvent.click(within(identityBar()).getByRole("button", { name: "Edit absorber and edge…" }))
  return screen.findByRole("dialog", { name: "Edit absorber and edge" })
}
async function chooseIronIdentity(dialog: HTMLElement) {
  const view = within(dialog)
  fireEvent.change(view.getByRole("textbox", { name: "Element symbol" }), { target: { value: "fe" } })
  api.mockResolvedValueOnce({ element: "Fe", edges: [{ edge: "K", energy: 7112 }, { edge: "L3", energy: 706.8 }] })
  fireEvent.click(view.getByRole("button", { name: "Look up edges" }))
  await view.findByRole("option", { name: "K · 7112 eV" })
  fireEvent.change(view.getByRole("combobox", { name: "Absorption edge" }), { target: { value: "K" } })
}
function identityResponse(project: AthenaProject, id: string) {
  const saved = project.groups.find(g => g.id === id)!
  return nextProject(project, { [id]: {
    source: { ...saved.source, edge_identity: { element: "Fe", edge: "K", origin: "selected" } },
    result: saved.result ? { ...saved.result, effective: { ...saved.result.effective, element: "Fe", edge: "K" } } : null,
  } })
}

describe("AthenaWorkbench absorber and edge identity", () => {
  it("displays saved native identity before effective fallback or Unknown, without lookups or activating import policy", async () => {
    const initial = projectFixture()
    initial.groups[0].source.edge_identity = { element: "Cu", edge: "K", origin: "native" }
    initial.groups[0].result!.effective = { ...initial.groups[0].result!.effective, element: "Fe", edge: "K" }
    initial.groups[1].result!.effective = { ...initial.groups[1].result!.effective, element: "Zn", edge: "L3" }
    await openSaved(initial)
    expect(identityBar()).toHaveTextContent("Cu K · native")
    expect(policyBar()).toHaveTextContent("Off")
    selectGroup("Sample scan")
    expect(identityBar()).toHaveTextContent("Zn L3")
    selectGroup("Oxide standard")
    expect(identityBar()).toHaveTextContent("Unknown")
    const dialog = await openIdentityDialog()
    expect(within(dialog).getByRole("textbox", { name: "Element symbol" })).toHaveValue("")
    expect(within(dialog).getByRole("button", { name: "Save identity" })).toBeDisabled()
    expect(within(dialog).queryByRole("spinbutton")).not.toBeInTheDocument()
    expect(api.mock.calls).toEqual([[`/projects/${initial.id}`]])
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(sessionStorage.getItem(edgePolicyStorageKey)).toBeNull()
  })

  it("saves current-group identity with no coverage restriction, preserving recipes, arrays, ties, drafts and tab enforcement", async () => {
    sessionStorage.setItem(edgePolicyStorageKey, JSON.stringify(copperPolicy))
    const initial = projectFixture()
    initial.groups[0].parameters.energy_shift = 3
    initial.groups[0].reference_id = "unused"
    initial.groups[0].source.edge_identity = { element: "Cu", edge: "K", origin: "native" }
    const project = await openSaved(initial)
    selectGroup("Sample scan"); editNumber(/^Rbkg/, 2.8)
    selectGroup("Foil scan"); editNumber(/^Rbkg/, 2.3); editNumber(/^E₀/, 8990); editNumber(/^Energy shift/, 9)
    const dialog = await openIdentityDialog()
    await chooseIronIdentity(dialog) // 7112 eV is intentionally outside the saved Cu scan.
    expect(api.mock.calls.at(-1)).toEqual(["/edges?element=Fe"])
    const next = identityResponse(project, "foil")
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Save identity" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api.mock.calls.at(-1)).toEqual([`/projects/${project.id}/command`, {
      version: project.version, action: "edge_identity", group_ids: ["foil"], options: { element: "Fe", edge: "K" },
    }])
    expect(identityBar()).toHaveTextContent("Fe K · selected")
    expect(screen.getByRole("status")).toHaveTextContent("Saving absorber and edge · complete")
    expect(plotProps().active?.parameters).toEqual(project.groups[0].parameters)
    expect(plotProps().active?.result?.arrays).toBe(project.groups[0].result!.arrays)
    expect(plotProps().active?.reference_id).toBe("unused")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8990)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(9)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.8)
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)
    expect(sessionStorage.getItem(edgePolicyStorageKey)).toBe(JSON.stringify(copperPolicy))
    expect(policyBar()).toHaveTextContent("Cu K")
    expect(api).toHaveBeenCalledTimes(3)
  })

  it.each(["chi", "difference"] as const)("allows %s identity metadata even though E₀ selection is unsupported", async kind => {
    const initial = projectFixture()
    if (kind === "chi") initial.groups[0].data_type = "chi"
    else initial.groups[0].is_difference = true
    const project = await openSaved(initial)
    if (kind === "difference") expect(screen.getByRole("button", { name: /Foil scan Difference \(E\)/ })).toBeEnabled()
    const e0 = await openE0Dialog()
    expect(within(e0).getByRole("button", { name: "Apply E₀" })).toBeDisabled()
    fireEvent.click(within(e0).getByRole("button", { name: "Cancel" }))
    openGroupMenu()
    fireEvent.click(within(screen.getByRole("navigation", { name: /main menu/i })).getByRole("button", { name: "Edit absorber and edge…" }))
    const dialog = await screen.findByRole("dialog", { name: "Edit absorber and edge" })
    await chooseIronIdentity(dialog)
    api.mockResolvedValueOnce(identityResponse(project, "foil"))
    fireEvent.click(within(dialog).getByRole("button", { name: "Save identity" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: project.version, action: "edge_identity", group_ids: ["foil"], options: { element: "Fe", edge: "K" } })
    expect(identityBar()).toHaveTextContent("Fe K · selected")
    expect(plotProps().active?.parameters).toEqual(project.groups[0].parameters)
    expect(plotProps().active?.data_type).toBe(project.groups[0].data_type)
  })

  it("shows frozen identity but disables both edit entry points and enables them for the next writable scan", async () => {
    const initial = projectFixture()
    initial.groups[1].frozen = true
    initial.groups[1].source.edge_identity = { element: "Cu", edge: "K", origin: "native" }
    await openSaved(initial)
    selectGroup("Sample scan")
    expect(identityBar()).toHaveTextContent("Cu K · native")
    expect(within(identityBar()).getByRole("button", { name: "Edit absorber and edge…" })).toBeDisabled()
    openGroupMenu()
    const menuEdit = within(screen.getByRole("navigation", { name: /main menu/i })).getByRole("button", { name: "Edit absorber and edge…" })
    expect(menuEdit).toBeDisabled()
    fireEvent.click(menuEdit)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    selectGroup("Oxide standard")
    expect(within(identityBar()).getByRole("button", { name: "Edit absorber and edge…" })).toBeEnabled()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("locks pending saves and retries a backend failure with the same accepted version and catalog selection", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.3)
    const saved = plotProps().active
    const dialog = await openIdentityDialog()
    const view = within(dialog)
    await chooseIronIdentity(dialog)
    const pending = deferred<AthenaProject>()
    api.mockReturnValueOnce(pending.promise)
    fireEvent.click(view.getByRole("button", { name: "Save identity" }))
    expect(view.getByRole("textbox", { name: "Element symbol" })).toBeDisabled()
    expect(view.getByRole("combobox", { name: "Absorption edge" })).toBeDisabled()
    expect(view.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(view.getByRole("button", { name: "Saving identity…" })).toBeDisabled()
    fireEvent.click(view.getByRole("button", { name: "Close dialog" }))
    fireEvent(dialog, new Event("cancel", { cancelable: true }))
    selectGroup("Sample scan") // Busy workbench controls must also retain the target.
    expect(plotProps().active?.id).toBe("foil")
    expect(dialog).toBeInTheDocument()
    await act(async () => pending.reject(new Error("Identity save failed; retry this group")))
    expect(view.getByRole("alert")).toHaveTextContent("Identity save failed; retry this group")
    expect(plotProps().active).toBe(saved)
    expect(identityBar()).toHaveTextContent("Unknown")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)
    expect(view.getByRole("textbox", { name: "Element symbol" })).toHaveValue("Fe")
    expect(view.getByRole("combobox", { name: "Absorption edge" })).toHaveValue("K")
    api.mockResolvedValueOnce(identityResponse(project, "foil"))
    fireEvent.click(view.getByRole("button", { name: "Save identity" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api.mock.calls[3]).toEqual(api.mock.calls[2])
    expect(api).toHaveBeenCalledTimes(4)
    expect(identityBar()).toHaveTextContent("Fe K · selected")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)
  })

  it("invalidates old catalog responses and editor choices when the active scan changes", async () => {
    const initial = projectFixture()
    initial.groups[0].source.edge_identity = { element: "Cu", edge: "K", origin: "native" }
    initial.groups[1].source.edge_identity = { element: "Fe", edge: "L3", origin: "native" }
    const project = await openSaved(initial)
    let dialog = await openIdentityDialog()
    const pending = deferred<unknown>()
    api.mockReturnValueOnce(pending.promise)
    fireEvent.click(within(dialog).getByRole("button", { name: "Look up edges" }))
    // Simulate an external active-group change while the native dialog is open.
    selectGroup("Sample scan")
    dialog = await screen.findByRole("dialog", { name: "Edit absorber and edge" })
    expect(within(dialog).getByRole("textbox", { name: "Element symbol" })).toHaveValue("Fe")
    expect(within(dialog).getByRole("button", { name: "Save identity" })).toBeDisabled()
    await act(async () => pending.resolve({ element: "Cu", edges: [{ edge: "K", energy: 8979 }] }))
    expect(within(dialog).queryByRole("option", { name: "K · 8979 eV" })).not.toBeInTheDocument()
    await chooseIronIdentity(dialog)
    api.mockResolvedValueOnce(identityResponse(project, "sample"))
    fireEvent.click(within(dialog).getByRole("button", { name: "Save identity" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: project.version, action: "edge_identity", group_ids: ["sample"], options: { element: "Fe", edge: "K" } })
    selectGroup("Foil scan")
    expect(identityBar()).toHaveTextContent("Cu K · native")
  })

  it.each([
    { flag: true, legacy: false, supported: false },
    { flag: false, legacy: true, supported: true },
    { flag: undefined, legacy: true, supported: false },
    { flag: undefined, legacy: false, supported: true },
  ])("uses is_difference=$flag before legacy operation=$legacy for E₀ eligibility", async ({ flag, legacy, supported }) => {
    const initial = projectFixture()
    initial.groups[0].is_difference = flag
    if (legacy) initial.groups[0].source.operation = "difference"
    await openSaved(initial)
    const dialog = await openE0Dialog()
    const apply = within(dialog).getByRole("button", { name: "Apply E₀" })
    if (supported) expect(apply).toBeEnabled()
    else {
      expect(apply).toBeDisabled()
      fireEvent.click(apply)
    }
    expect(api).toHaveBeenCalledTimes(1)
  })
})

describe("AthenaWorkbench import edge policy", () => {
  it("starts off without a catalog request, enables without mutating the project, and cancels edits", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.7)
    expect(policyBar()).toHaveTextContent("Off")
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])
    await enableCopperPolicy()
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`], ["/edges?element=Cu"]])
    expect(JSON.parse(sessionStorage.getItem(edgePolicyStorageKey)!)).toEqual(copperPolicy)
    expect(plotProps().active).toBe(project.groups[0])
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.7)
    const dialog = await openEdgePolicyDialog()
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Element symbol" }), { target: { value: "Fe" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(policyBar()).toHaveTextContent("Cu K · fraction 0.5")
    expect(JSON.parse(sessionStorage.getItem(edgePolicyStorageKey)!)).toEqual(copperPolicy)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it.each(["empty", "frozen"] as const)("can enable and stop enforcement with %s groups and no marks", async kind => {
    const project = projectFixture({ groups: kind === "empty" ? [] : [{ ...group("frozen", "Frozen foil"), frozen: true }] })
    localStorage.setItem(storageKey, project.id)
    api.mockResolvedValueOnce(project)
    render(<AthenaWorkbench />)
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Opening project · complete"))
    await enableCopperPolicy()
    fireEvent.click(within(screen.getByRole("navigation", { name: /main menu/i })).getByRole("button", { name: "Energy" }))
    // The Energy menu has its own Stop action; the persistent bar is also available.
    const stop = screen.getAllByRole("button", { name: "Stop enforcing element and edge" }).find(button => !policyBar().contains(button))!
    expect(stop).toBeEnabled()
    fireEvent.click(stop)
    expect(policyBar()).toHaveTextContent("Off")
    expect(sessionStorage.getItem(edgePolicyStorageKey)).toBeNull()
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`], ["/edges?element=Cu"]])
  })

  it("survives a same-tab remount and remains independent of project switches and Undo", async () => {
    const project = await openSaved()
    await enableCopperPolicy()
    cleanup()
    api.mockResolvedValueOnce(project)
    render(<AthenaWorkbench />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply parameters" })).toBeEnabled())
    expect(policyBar()).toHaveTextContent("Cu K · fraction 0.5")
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`], ["/edges?element=Cu"], [`/projects/${project.id}`]])
    const loaded = projectFixture({ id: "different-project", name: "Different project", version: 2, undo: ["Before edit"] })
    loaded.groups[0].source.edge_policy = { element: "Fe", edge: "K", fraction: 1 }
    api.mockResolvedValueOnce([{ id: loaded.id, name: loaded.name, updated: loaded.updated, count: loaded.groups.length }]).mockResolvedValueOnce(loaded)
    fireEvent.click(screen.getByRole("button", { name: "Open project" }))
    const dialog = await screen.findByRole("dialog", { name: "Open a project" })
    const recent = await within(dialog).findByRole("button", { name: new RegExp(loaded.name) })
    await waitFor(() => expect(recent).toBeEnabled())
    fireEvent.click(recent)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(policyBar()).toHaveTextContent("Cu K · fraction 0.5")
    api.mockResolvedValueOnce({ ...loaded, version: 3, undo: [] })
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply parameters" })).toBeEnabled())
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 2, action: "undo", group_ids: [], options: {} })
    expect(policyBar()).toHaveTextContent("Cu K · fraction 0.5")
    expect(JSON.parse(sessionStorage.getItem(edgePolicyStorageKey)!)).toEqual(copperPolicy)
  })

  it.each(["", "{broken", "null", "[]", '{"element":"","edge":"K","fraction":0.5}', '{"element":"Cu","edge":"K","fraction":0}', '{"element":"Cu","edge":"K","fraction":1.1}', '{"element":"Cu","edge":"K","fraction":"0.5"}'])("recovers malformed stored policy %j as off without a lookup", async stored => {
    sessionStorage.setItem(edgePolicyStorageKey, stored)
    const project = await openSaved()
    expect(policyBar()).toHaveTextContent("Off")
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])
  })

  it.each([false, true])("ignores saved and imported project policy provenance with tab enforcement %s", async enabled => {
    if (enabled) sessionStorage.setItem(edgePolicyStorageKey, JSON.stringify(copperPolicy))
    const project = projectFixture()
    project.groups[0].source.edge_policy = { element: "Fe", edge: "K", fraction: 1 }
    await openSaved(project)
    expect(policyBar()).toHaveTextContent(enabled ? "Cu K · fraction 0.5" : "Off")
    api.mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole("button", { name: "Open project" }))
    const dialog = await screen.findByRole("dialog", { name: "Open a project" })
    const panelProps = () => projectImport.mock.calls.at(-1)![0]
    await waitFor(() => expect(panelProps().disabled).toBe(false))
    const restored = importedProject(project, "Native enforced foil")
    restored.groups.at(-1)!.source.edge_policy = { element: "Zn", edge: "L3", fraction: 0.7 }
    act(() => { panelProps().onImported(restored); panelProps().onComplete() })
    expect(dialog).not.toBeInTheDocument()
    expect(policyBar()).toHaveTextContent(enabled ? "Cu K · fraction 0.5" : "Off")
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`], ["/projects"]])
  })

  it("keeps one policy across sample/reference batch requests and failed retries after Stop, then uses off for a new batch", async () => {
    const project = await openSaved()
    await enableCopperPolicy()
    const inspections = ["first.dat", "second.dat", "third.dat"].map(name => inspectionFixture(name))
    const { dialog } = await chooseImportFiles(inspections)
    chooseFluorescenceMapping(dialog)
    const afterFirst = importedProject(project, "first.dat"), afterSecond = importedProject(afterFirst, "second.dat"), afterThird = importedProject(afterSecond, "third.dat")
    const first = deferred<AthenaProject>()
    api.mockReturnValueOnce(first.promise).mockResolvedValueOnce(inspections[1]).mockRejectedValueOnce(new Error("Second sample normalization failed"))
    submitImport(dialog)
    // Stopping is local, so it remains usable during an import. The accepted batch keeps its snapshot.
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop enforcing element and edge" }))
    expect(policyBar()).toHaveTextContent("Off")
    await act(async () => first.resolve(afterFirst))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Second sample normalization failed")
    expect(plotProps().active).toEqual(afterFirst.groups.at(-1))
    expect(within(dialog).getByRole("region", { name: "Import batch edge policy" })).toHaveTextContent("This batch: Cu K · fraction 0.5")
    api.mockResolvedValueOnce(afterSecond).mockResolvedValueOnce(inspections[2]).mockResolvedValueOnce(afterThird)
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls()).toEqual([
      [inspections[0], project.version], [inspections[1], afterFirst.version], [inspections[1], afterFirst.version], [inspections[2], afterSecond.version],
    ].map(([inspection, version]) => [`/projects/${project.id}/import`, { ...fluorescenceMapping, edge_policy: copperPolicy, upload_id: (inspection as InspectionResponse).upload_id, version }]))
    const nextInspection = inspectionFixture("new-intent.dat")
    const next = await chooseImportFiles([nextInspection])
    api.mockResolvedValueOnce(importedProject(afterThird, nextInspection.display_name))
    submitImport(next.dialog)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls().at(-1)?.[1]).toEqual(expect.objectContaining({ edge_policy: null, version: afterThird.version, upload_id: nextInspection.upload_id }))
    expect(importCalls().filter(([, body]) => (body as { upload_id: string }).upload_id === inspections[0].upload_id)).toHaveLength(1)
  })

  it("keeps the batch policy through an incompatible layout review", async () => {
    sessionStorage.setItem(edgePolicyStorageKey, JSON.stringify(copperPolicy))
    const project = await openSaved()
    const first = inspectionFixture("first.dat"), second = inspectionFixture("different.dat", ["Energy", "Signal"])
    const { dialog } = await chooseImportFiles([first, second])
    const afterFirst = importedProject(project, first.display_name)
    api.mockResolvedValueOnce(afterFirst).mockResolvedValueOnce(second)
    submitImport(dialog)
    await within(dialog).findByText(second.display_name)
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Import spectrum" })).toBeEnabled())
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop enforcing element and edge" }))
    api.mockResolvedValueOnce(importedProject(afterFirst, second.display_name))
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls().map(([, body]) => (body as { edge_policy: unknown }).edge_policy)).toEqual([copperPolicy, copperPolicy])
  })

  it("retries an inspection using the original batch policy and reference mapping", async () => {
    sessionStorage.setItem(edgePolicyStorageKey, JSON.stringify(copperPolicy))
    const project = await openSaved()
    const first = inspectionFixture("first.dat"), second = inspectionFixture("second.dat")
    const { dialog } = await chooseImportFiles([first, second])
    chooseFluorescenceMapping(dialog)
    const afterFirst = importedProject(project, first.display_name)
    api.mockResolvedValueOnce(afterFirst).mockRejectedValueOnce(new Error("Inspection unavailable"))
    submitImport(dialog)
    await within(dialog).findByRole("alert")
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop enforcing element and edge" }))
    api.mockResolvedValueOnce(second)
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry file inspection" }))
    await within(dialog).findByText(second.display_name)
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Import spectrum" })).toBeEnabled())
    api.mockResolvedValueOnce(importedProject(afterFirst, second.display_name))
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls().at(-1)?.[1]).toEqual({ ...fluorescenceMapping, edge_policy: copperPolicy, version: afterFirst.version, upload_id: second.upload_id })
    expect(importCalls()).toHaveLength(2)
  })

  it("includes the policy snapshot in a single χ(k) import so the backend can ignore it by data type", async () => {
    sessionStorage.setItem(edgePolicyStorageKey, JSON.stringify(copperPolicy))
    const project = await openSaved()
    const inspection = inspectionFixture("chi.dat")
    const { dialog } = await chooseImportFiles([inspection])
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Data type" }), { target: { value: "chi" } })
    expect(within(dialog).getByRole("region", { name: "Import batch edge policy" })).toHaveTextContent("χ(k) ignores it")
    api.mockResolvedValueOnce(importedProject(project, inspection.display_name))
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls().at(-1)?.[1]).toEqual(expect.objectContaining({ edge_policy: copperPolicy, data_type: "chi" }))
  })
})

function e0Response(project: AthenaProject, method: E0Method, values: Record<string, number>, skipped: Record<string, string> = {}): AthenaProject {
  const updated = nextProject(project, Object.fromEntries(project.groups.filter(g => g.id in values).map(g => [g.id, {
    parameters: { ...g.parameters, e0: values[g.id] },
    result: g.result && { ...g.result, effective: { ...g.result.effective, e0: values[g.id] } },
  }])))
  updated.last_operation = {
    action: "set_e0", skipped_group_ids: Object.keys(skipped), skipped_reasons: skipped,
    e0_results: Object.entries(values).map(([group_id, e0]) => ({
      group_id, method, e0, seed_e0: method === "manual" || method === "derivative" ? null : 8979, element: method === "atomic" ? "Cu" : null,
      edge: method === "atomic" ? "K" : null, tabulated_e0: method === "atomic" ? 8979 : null,
      iterations: method === "fraction" ? 3 : 0, converged: true, warnings: [],
    })),
  }
  return updated
}

describe("AthenaWorkbench E₀ selection", () => {
  it.each(["derivative", "atomic", "fraction", "zero_crossing", "white_line", "manual"] as const)("applies %s to the current saved spectrum with only relevant options and reports accepted E₀", async method => {
    const project = await openSaved()
    editNumber(/^E₀/, 9100)
    const dialog = await openE0Dialog()
    chooseE0Method(dialog, method)
    const expected = method === "fraction" ? { method, fraction: 0.5 } : method === "manual" ? { method, value: 8984.25 } : { method }
    if (method === "manual") {
      // Initial manual value comes from the saved recipe, never the unapplied E₀.
      expect(within(dialog).getByRole("spinbutton", { name: /^Manual E₀/ })).toHaveValue(8979)
      editNumber(/^Manual E₀/, 8984.25, dialog)
    }
    const next = e0Response(project, method, { foil: 8984.25 })
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "set_e0", group_ids: ["foil"], options: expected,
    })
    expect(report).toHaveTextContent("Foil scan: 8984.250 eV")
    if (method === "atomic") expect(report).toHaveTextContent("Cu K (8979 eV tabulated)")
    if (method === "fraction") expect(report).toHaveTextContent("3 iterations · converged")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8984.25)
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
    expect(plotProps().active?.parameters.energy_shift).toBe(project.groups[0].parameters.energy_shift)
  })

  it("rejects fractions outside (0, 1] and nonpositive manual values before sending, then recovers", async () => {
    const project = await openSaved()
    const dialog = await openE0Dialog()
    chooseE0Method(dialog, "fraction")
    for (const value of ["", 0, 1.1, -0.1, 1.2] as const) {
      editNumber(/^Edge-step fraction$/, value, dialog)
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
      expect(within(dialog).getByRole("alert")).toHaveTextContent(/greater than 0 and at most 1/)
      expect(api).toHaveBeenCalledTimes(1)
    }
    chooseE0Method(dialog, "manual")
    for (const value of ["", 0, -1] as const) {
      editNumber(/^Manual E₀/, value, dialog)
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
      expect(within(dialog).getByRole("alert")).toHaveTextContent(/finite, positive/)
      expect(api).toHaveBeenCalledTimes(1)
    }
    // Native number inputs sanitize nonfinite text to empty; it must still be rejected.
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: /^Manual E₀/ }), { target: { value: "Infinity" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    expect(api).toHaveBeenCalledTimes(1)
    chooseE0Method(dialog, "fraction")
    editNumber(/^Edge-step fraction$/, 0.37, dialog)
    api.mockResolvedValueOnce(e0Response(project, "fraction", { foil: 8980 }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 7, action: "set_e0", group_ids: ["foil"], options: { method: "fraction", fraction: 0.37 } })
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("accepts fraction 1 for the full edge step and sends that exact value", async () => {
    const project = await openSaved()
    const dialog = await openE0Dialog()
    chooseE0Method(dialog, "fraction")
    editNumber(/^Edge-step fraction$/, 1, dialog)
    api.mockResolvedValueOnce(e0Response(project, "fraction", { foil: 8992 }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "set_e0", group_ids: ["foil"], options: { method: "fraction", fraction: 1 },
    })
    expect(report).toHaveTextContent("Foil scan: 8992.000 eV")
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("requires an atomic element/edge pair and omits previous method inputs", async () => {
    const project = await openSaved()
    const dialog = await openE0Dialog()
    chooseE0Method(dialog, "fraction")
    editNumber(/^Edge-step fraction$/, 0.75, dialog)
    chooseE0Method(dialog, "manual")
    editNumber(/^Manual E₀/, 8982, dialog)
    chooseE0Method(dialog, "atomic")
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Absorbing element/ }), { target: { value: " Cu " } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/both element and edge/)
    expect(api).toHaveBeenCalledTimes(1)
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Absorption edge/ }), { target: { value: " K " } })
    api.mockResolvedValueOnce(e0Response(project, "atomic", { foil: 8979 }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 7, action: "set_e0", group_ids: ["foil"], options: { method: "atomic", element: "Cu", edge: "K" } })
  })

  it.each(["marked", "all"] as const)("sends explicit %s IDs in list order including skipped groups, independent of search", async scope => {
    const initial = projectFixture()
    initial.groups[2].frozen = true
    initial.groups[3].data_type = "chi"
    const project = await openSaved(initial)
    fireEvent.change(screen.getByRole("textbox", { name: "Search groups" }), { target: { value: "Foil" } })
    const dialog = await openE0Dialog()
    fireEvent.change(within(dialog).getByRole("combobox", { name: "E₀ targets" }), { target: { value: scope } })
    const values: Record<string, number> = scope === "all" ? { foil: 8981, sample: 8982 } : { sample: 8982 }
    const skips: Record<string, string> = { oxide: "The group is frozen." }
    if (scope === "all") skips.unused = "E₀ requires an absorption spectrum on an energy axis."
    const next = e0Response(project, "derivative", values, skips)
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 7, action: "set_e0", group_ids: scope === "all" ? ["foil", "sample", "oxide", "unused"] : ["sample", "oxide"], options: { method: "derivative" } })
    expect(report).toHaveTextContent("Sample scan: 8982.000 eV")
    expect(report).toHaveTextContent("Oxide standard: The group is frozen.")
    if (scope === "all") expect(report).toHaveTextContent("Unused reference: E₀ requires an absorption spectrum")
    expect(plotProps().active?.id).toBe("foil")
    expect(project.groups[2].parameters).toEqual(next.groups[2].parameters)
    expect(within(dialog).getByText(/Energy shifts are preserved/)).toBeVisible()
  })

  it("reconciles only accepted E₀ drafts, preserving other edits, non-targets, skipped consumers and saved shifts", async () => {
    const initial = projectFixture()
    initial.groups[0].parameters.energy_shift = 3
    initial.groups[1].parameters.energy_shift = -2
    const project = await openSaved(initial)
    editNumber(/^Rbkg/, 2.6); editNumber(/^E₀/, 9000); editNumber(/^Energy shift/, 9)
    selectGroup("Sample scan")
    editNumber(/^Rbkg/, 3.2); editNumber(/^E₀/, 9010)
    selectGroup("Oxide standard")
    editNumber(/^E₀/, 9020)
    selectGroup("Foil scan")
    const dialog = await openE0Dialog()
    fireEvent.change(within(dialog).getByRole("combobox", { name: "E₀ targets" }), { target: { value: "marked" } })
    const next = e0Response(project, "derivative", { sample: 8983 }, { oxide: "A group using it as a background standard is frozen." })
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(report).toHaveTextContent("Oxide standard: A group using it as a background standard is frozen.")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(9000)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.6)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(9)
    expect(plotProps().active?.parameters.energy_shift).toBe(3)
    selectGroup("Oxide standard")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(9020)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8983)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(3.2)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(-2)
    api.mockResolvedValueOnce(nextProject(next, { sample: { parameters: { ...next.groups[1].parameters, rbkg: 3.2 } } }))
    fireEvent.click(screen.getByRole("button", { name: "Apply parameters" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply parameters" })).toBeEnabled())
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: next.version, action: "parameters", group_ids: ["sample"], options: { rbkg: 3.2 } })
  })

  it("locks input and dismissal while pending, leaves project/drafts intact on failure, and retries the same saved version", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.3)
    const saved = plotProps().active
    const dialog = await openE0Dialog()
    chooseE0Method(dialog, "fraction")
    editNumber(/^Edge-step fraction$/, 0.6, dialog)
    const pending = deferred<AthenaProject>()
    api.mockReturnValueOnce(pending.promise)
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    expect(within(dialog).getByRole("combobox", { name: "E₀ method" })).toBeDisabled()
    expect(within(dialog).getByRole("combobox", { name: "E₀ targets" })).toBeDisabled()
    expect(within(dialog).getByRole("combobox", { name: "Current group" })).toBeDisabled()
    expect(within(dialog).getByRole("spinbutton", { name: "Edge-step fraction" })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: "Applying E₀…" })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }))
    fireEvent(dialog, new Event("cancel", { cancelable: true }))
    expect(dialog).toBeInTheDocument()
    await act(async () => pending.reject(new Error("Fraction normalization failed for Foil scan")))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Fraction normalization failed for Foil scan")
    expect(plotProps().active).toBe(saved)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)
    expect(within(dialog).getByRole("spinbutton", { name: "Edge-step fraction" })).toHaveValue(0.6)
    expect(within(dialog).queryByRole("region", { name: "E₀ selection results" })).not.toBeInTheDocument()
    const next = e0Response(project, "fraction", { foil: 8981 })
    next.last_operation!.e0_results![0] = { ...next.last_operation!.e0_results![0], iterations: 5, converged: false, warnings: ["Iteration limit reached; inspect this E₀."] }
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api.mock.calls[2]).toEqual(api.mock.calls[1])
    expect(report).toHaveTextContent("5 iterations · not converged")
    expect(report).toHaveTextContent("Iteration limit reached; inspect this E₀.")
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8981)
  })

  it("resets method inputs when switching scans and sends the new scan's explicit ID", async () => {
    const initial = projectFixture()
    initial.groups[1].parameters.e0 = 8986
    const project = await openSaved(initial)
    let dialog = await openE0Dialog()
    chooseE0Method(dialog, "manual")
    editNumber(/^Manual E₀/, 9200, dialog)
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Current group" }), { target: { value: "sample" } })
    dialog = await screen.findByRole("dialog", { name: "Select E₀" })
    expect(within(dialog).getByRole("combobox", { name: "E₀ method" })).toHaveValue("derivative")
    chooseE0Method(dialog, "manual")
    expect(within(dialog).getByRole("spinbutton", { name: /^Manual E₀/ })).toHaveValue(8986)
    api.mockResolvedValueOnce(e0Response(project, "manual", { sample: 8986 }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 7, action: "set_e0", group_ids: ["sample"], options: { method: "manual", value: 8986 } })
  })

  it.each(["empty", "chi", "difference", "frozen", "unmarked"] as const)("disables Apply for %s selections without sending an empty or unsupported request", async kind => {
    const initial = projectFixture()
    if (kind === "empty") initial.groups = []
    else {
      if (kind === "chi") initial.groups.forEach(g => { g.data_type = "chi" })
      if (kind === "difference") initial.groups.forEach(g => { g.source.operation = "difference" })
      if (kind === "frozen") initial.groups.forEach(g => { g.frozen = true })
      if (kind === "unmarked") initial.groups.forEach(g => { g.marked = false })
    }
    localStorage.setItem(storageKey, initial.id)
    api.mockResolvedValueOnce(initial)
    render(<AthenaWorkbench />)
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Opening project · complete"))
    const dialog = await openE0Dialog()
    if (kind === "unmarked") fireEvent.change(within(dialog).getByRole("combobox", { name: "E₀ targets" }), { target: { value: "marked" } })
    const button = within(dialog).getByRole("button", { name: "Apply E₀" })
    expect(button).toBeDisabled()
    expect(within(dialog).getByText(/No supported, unfrozen groups/)).toBeVisible()
    fireEvent.click(button)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("cancels without commands or draft changes and reports an all-skipped dependency result", async () => {
    const project = await openSaved()
    editNumber(/^E₀/, 8990)
    let dialog = await openE0Dialog()
    chooseE0Method(dialog, "manual")
    editNumber(/^Manual E₀/, 9000, dialog)
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8990)
    dialog = await openE0Dialog()
    api.mockResolvedValueOnce(e0Response(project, "derivative", {}, { foil: "A background consumer is frozen." }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(report).toHaveTextContent("Foil scan: A background consumer is frozen.")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.getByRole("status")).toHaveTextContent("1 group skipped")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8990)
    expect(plotProps().active?.parameters.e0).toBe(8979)
  })
})

describe("AthenaWorkbench plot picking", () => {
  it("picks absolute E₀ and relative limits using draft E₀, with no processing before Apply", async () => {
    const project = await openSaved()
    const savedArrays = plotProps().active!.result!.arrays
    const pickE0 = armPick("E₀")
    act(() => pickE0(8985, "E"))
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8985)
    expect(plotProps().picking).toBe(false)
    // The same queued click cannot overwrite a completed pick.
    act(() => pickE0(9999, "E"))
    const picks = [
      ["Pre-edge start", 8960, -25], ["Pre-edge end", 8970, -15],
      ["Post-edge start", 8990, 5], ["Post-edge end", 9000, 15],
    ] as const
    for (const [label, x, expected] of picks) {
      const pickX = armPick(label)
      act(() => pickX(x, "E"))
      expect(screen.getByRole("spinbutton", { name: new RegExp(`^${label}`) })).toHaveValue(expected)
    }
    expect(api).toHaveBeenCalledTimes(1)
    expect(plotProps().active!.parameters).toEqual(project.groups[0].parameters)
    expect(plotProps().active!.result!.arrays).toBe(savedArrays)
    const changes = { e0: 8985, pre1: -25, pre2: -15, norm1: 5, norm2: 15 }
    api.mockResolvedValueOnce(nextProject(project, { foil: { parameters: { ...parameters, ...changes } } }))
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/ }))
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: changes,
    }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/ })).toBeEnabled())
  })

  it("uses effective automatic E₀ and refuses a relative pick when no E₀ is available", async () => {
    const project = projectFixture()
    project.groups[0].parameters.e0 = null
    project.groups[1].parameters.e0 = null
    project.groups[1].result = null
    await openSaved(project)
    const pickX = armPick("Post-edge end")
    act(() => pickX(9000, "E"))
    expect(screen.getByRole("spinbutton", { name: /^Post-edge end/ })).toHaveValue(21)
    selectGroup("Sample scan")
    fireEvent.click(screen.getByRole("button", { name: "Pick Pre-edge start from plot" }))
    expect(screen.getByRole("alert")).toHaveTextContent(/E₀/)
    expect(plotProps().picking).toBe(false)
    editNumber(/^E₀/, 8980)
    const retry = armPick("Pre-edge start")
    act(() => retry(8960, "E"))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("spinbutton", { name: /^Pre-edge start/ })).toHaveValue(-20)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("updates spline k and relative energy reciprocally for typed and picked values", async () => {
    await openSaved()
    const conversion = 3.8099821109685847
    const pickK = armPick("Spline k min")
    expect(plotProps().space).toBe("k")
    act(() => pickK(2, "k"))
    expect(screen.getByRole("spinbutton", { name: /^Spline energy min/ })).toHaveValue(4 * conversion)
    editNumber(/^Spline energy max/, 25 * conversion)
    expect(screen.getByRole("spinbutton", { name: /^Spline k max/ })).toHaveValue(5)
    editNumber(/^Spline k max/, 4)
    expect(screen.getByRole("spinbutton", { name: /^Spline energy max/ })).toHaveValue(16 * conversion)
    const pickEnergy = armPick("Spline energy max")
    expect(plotProps().space).toBe("E")
    act(() => pickEnergy(8979 + 9 * conversion, "E"))
    expect(Number((screen.getByRole("spinbutton", { name: /^Spline k max/ }) as HTMLInputElement).value)).toBeCloseTo(3, 10)
    editNumber(/^Spline energy max/, "")
    expect(screen.getByRole("spinbutton", { name: /^Spline k max/ })).toHaveValue(null)
    expect(screen.getByRole("spinbutton", { name: /^Spline energy max/ })).toHaveValue(null)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("rejects below-edge spline picks and negative typed limits without losing the draft, then recovers", async () => {
    await openSaved()
    editNumber(/^Spline k min/, 2)
    const pickEnergy = armPick("Spline energy min")
    act(() => pickEnergy(8978, "E"))
    expect(screen.getByRole("alert")).toHaveTextContent(/at or above E₀/)
    expect(screen.getByRole("spinbutton", { name: /^Spline k min/ })).toHaveValue(2)
    expect(plotProps().picking).toBe(true)
    act(() => pickEnergy(8979, "E"))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("spinbutton", { name: /^Spline k min/ })).toHaveValue(0)
    editNumber(/^Spline energy min/, -1)
    expect(screen.getByRole("alert")).toHaveTextContent(/nonnegative/)
    expect(screen.getByRole("spinbutton", { name: /^Spline k min/ })).toHaveValue(0)
    editNumber(/^Spline energy min/, 3.8099821109685847)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("spinbutton", { name: /^Spline k min/ })).toHaveValue(1)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("picks k/R transform limits directly and ignores mismatched spaces and nonfinite coordinates", async () => {
    const project = await openSaved()
    fireEvent.click(screen.getByText("Backward Fourier transform"))
    for (const [label, space, value] of [["FT k min", "k", 4], ["FT k max", "k", 11], ["R min", "R", 1.4], ["R max", "R", 3.4]] as const) {
      const pickX = armPick(label)
      expect(plotProps().space).toBe(space)
      act(() => { pickX(8888, "q"); pickX(NaN, space) })
      expect(plotProps().picking).toBe(true)
      act(() => pickX(value, space))
      expect(screen.getByRole("spinbutton", { name: new RegExp(`^${label}`) })).toHaveValue(value)
    }
    expect(api).toHaveBeenCalledTimes(1)
    const changes = { kmin: 4, kmax: 11, rmin: 1.4, rmax: 3.4 }
    api.mockResolvedValueOnce(nextProject(project, { foil: { parameters: { ...parameters, ...changes } } }))
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/ }))
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: changes,
    }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/ })).toBeEnabled())
  })

  it("keeps a new arm when a previous render's context effect is still pending", async () => {
    let pickOnNextCommit = false
    // Force the event ordering without timers or mocked React effects: the group
    // change commits, a native pick click occurs, then parent passive effects run.
    plot.mockImplementation(function PlotWithEarlyClick() {
      useLayoutEffect(() => {
        if (!pickOnNextCommit) return
        pickOnNextCommit = false
        const button = screen.getByRole("button", { name: "Pick FT k min from plot" })
        expect(button).toBeEnabled()
        button.click()
      })
      return <div data-testid="athena-plot" />
    })
    await openSaved()
    const oldPick = armPick("E₀")
    pickOnNextCommit = true
    selectGroup("Sample scan")

    expect(plotProps().space).toBe("k")
    expect(plotProps().active?.id).toBe("sample")
    expect(screen.getByRole("button", { name: "Pick FT k min from plot" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /Cancel pick/ })).toBeVisible()
    expect(plotProps().picking).toBe(true)
    const newPick = plotProps().onPickX!
    act(() => oldPick(9999, "E"))
    expect(plotProps().picking).toBe(true)
    act(() => newPick(4, "k"))
    expect(screen.getByRole("spinbutton", { name: /^FT k min/ })).toHaveValue(4)
    expect(plotProps().picking).toBe(false)
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8979)
    expect(screen.getByRole("spinbutton", { name: /^FT k min/ })).toHaveValue(3)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it.each(["cancel", "escape", "group", "space", "plotted groups", "draft", "dialog"])("disarms on %s and ignores stale plot callbacks", async reason => {
    await openSaved()
    const stalePick = armPick("E₀")
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: /Cancel pick/ }))
    if (reason === "escape") fireEvent.keyDown(document, { key: "Escape" })
    if (reason === "group") selectGroup("Sample scan")
    if (reason === "space") fireEvent.click(screen.getByRole("tab", { name: /EXAFS/ }))
    if (reason === "plotted groups") fireEvent.click(screen.getByRole("checkbox", { name: "Plot marked" }))
    if (reason === "draft") editNumber(/^Rbkg/, 1.7)
    if (reason === "dialog") await openGroupControls()
    expect(plotProps().picking).toBe(false)
    act(() => stalePick(9999, "E"))
    if (reason === "dialog") fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8979)
    // Re-arming must not revive a previously queued click for the same field.
    const freshPick = armPick("E₀")
    act(() => stalePick(9999, "E"))
    expect(plotProps().picking).toBe(true)
    act(() => freshPick(8980, "E"))
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8980)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("keeps keyboard-editable fields and prevents picking for frozen groups", async () => {
    const project = projectFixture()
    project.groups[1].frozen = true
    await openSaved(project)
    const field = screen.getByRole("spinbutton", { name: /^Pre-edge start/ })
    field.focus()
    expect(field).toHaveFocus()
    editNumber(/^Pre-edge start/, -175)
    expect(field).toHaveValue(-175)
    selectGroup("Sample scan")
    expect(screen.getByRole("button", { name: "Pick E₀ from plot" })).toBeDisabled()
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toBeDisabled()
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Pre-edge start/ })).toHaveValue(-175)
    expect(api).toHaveBeenCalledTimes(1)
  })
})

describe("AthenaWorkbench background science controls", () => {
  it("defaults energy-dependent normalization off and submits only its changed flag on Apply", async () => {
    const project = await openSaved()
    const control = screen.getByRole("checkbox", { name: "Energy-dependent normalization" })
    expect(control).not.toBeChecked()
    fireEvent.click(control)
    expect(control).toBeChecked()
    expect(api).toHaveBeenCalledTimes(1)
    expect(plotProps().active!.result).toBe(project.groups[0].result)
    api.mockResolvedValueOnce(nextProject(project, { foil: { parameters: { ...parameters, fnorm: true } } }))
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/ }))
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { fnorm: true },
    }))
    await waitFor(() => expect(control).toBeEnabled())
    expect(control).toBeChecked()
  })

  it.each(["norm", "chi", "xanes"] as const)("disables energy-dependent normalization for %s groups", async data_type => {
    const project = projectFixture()
    project.groups[0].data_type = data_type
    await openSaved(project)
    const control = screen.getByRole("checkbox", { name: "Energy-dependent normalization" })
    expect(control).toBeDisabled()
    // Native click respects disabled inputs; dispatchEvent can toggle them in jsdom.
    act(() => control.click())
    expect(control).not.toBeChecked()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("keeps standard choices per group, excludes self/unprocessed sources, and applies or removes explicitly", async () => {
    const project = projectFixture()
    project.groups[0].result!.arrays.chi = [0.1, -0.1]
    project.groups[1].result!.arrays.chi = [0.2, -0.2]
    await openSaved(project)
    const selector = () => screen.getByRole("combobox", { name: "Background removal standard" })
    const apply = () => screen.getByRole("button", { name: "Apply standard" })
    expect(within(selector()).getAllByRole("option").map(option => option.textContent)).toEqual(["None", "Sample scan"])
    expect(apply()).toBeDisabled()
    fireEvent.change(selector(), { target: { value: "sample" } })
    selectGroup("Unused reference")
    expect(selector()).toHaveValue("")
    fireEvent.change(selector(), { target: { value: "foil" } })
    selectGroup("Foil scan")
    expect(selector()).toHaveValue("sample")
    expect(api).toHaveBeenCalledTimes(1)
    const accepted = nextProject(project, { foil: { background_standard_id: "sample" } })
    api.mockResolvedValueOnce(accepted)
    fireEvent.click(apply())
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: 7, action: "background_standard", group_ids: ["foil"], options: { standard_id: "sample" },
    }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/ })).toBeEnabled())
    expect(apply()).toBeDisabled()
    fireEvent.change(selector(), { target: { value: "" } })
    api.mockResolvedValueOnce(nextProject(accepted, { foil: { background_standard_id: null } }))
    fireEvent.click(apply())
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: 8, action: "background_standard", group_ids: ["foil"], options: { standard_id: null },
    }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/ })).toBeEnabled())
    selectGroup("Unused reference")
    expect(selector()).toHaveValue("foil")
  })

  it("preserves standard and parameter drafts on failure and surfaces frozen skips from the backend", async () => {
    const project = projectFixture()
    project.groups[1].result!.arrays.chi = [0.2, -0.2]
    await openSaved(project)
    editNumber(/^Rbkg/, 1.7)
    const selector = screen.getByRole("combobox", { name: "Background removal standard" })
    fireEvent.change(selector, { target: { value: "sample" } })
    api.mockRejectedValueOnce(new Error("Background standard would create a cycle"))
    fireEvent.click(screen.getByRole("button", { name: "Apply standard" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/create a cycle/)
    expect(selector).toHaveValue("sample")
    expect(plotProps().active!.background_standard_id).toBeUndefined()
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.7)
    const skipped = nextProject(project, { foil: { frozen: true } })
    skipped.last_operation = { action: "background_standard", skipped_group_ids: ["foil"] }
    api.mockResolvedValueOnce(skipped)
    fireEvent.click(screen.getByRole("button", { name: "Apply standard" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 group skipped"))
    expect(api.mock.calls[1]).toEqual(api.mock.calls[2])
    expect(selector).toHaveValue("sample")
    expect(selector).toBeDisabled()
    expect(screen.getByRole("button", { name: "Apply standard" })).toBeDisabled()
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.7)
    expect(plotProps().active!.result).toEqual(project.groups[0].result)
  })
})

describe("AthenaWorkbench bulk marking and freezing", () => {
  it.each(["Mark all", "Mark none", "Invert marks"])("%s uses all IDs in list order, including frozen and search-hidden groups", async label => {
    const project = projectFixture()
    project.groups[2].frozen = true
    await openSaved(project)
    editNumber(/^Rbkg/, 1.8)
    fireEvent.change(screen.getByRole("textbox", { name: "Search groups" }), { target: { value: "Foil" } })
    const dialog = await openGroupControls()
    const updated = nextProject(project, Object.fromEntries(project.groups.map(g => [g.id, { marked: label === "Invert marks" ? !g.marked : label === "Mark all" }])))
    api.mockResolvedValueOnce(updated)
    fireEvent.click(within(dialog).getByRole("button", { name: label }))
    await waitFor(() => expect(within(dialog).getByRole("button", { name: label })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: label === "Invert marks" ? "selection" : "metadata",
      group_ids: ["foil", "sample", "oxide", "unused"],
      options: label === "Invert marks" ? { field: "marked", mode: "invert" } : { marked: label === "Mark all" },
    })
    expect(plotProps().active!.id).toBe("foil")
    expect(plotProps().active!.result).toEqual(project.groups[0].result)
    expect(plotProps().groups.map(g => g.id)).toEqual(label === "Mark all" ? ["foil", "sample", "oxide", "unused"] : label === "Mark none" ? ["foil"] : ["foil", "unused"])
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.8)
  })

  it("recovers from invalid JavaScript patterns, targets matching labels only, and skips empty matches", async () => {
    const project = await openSaved()
    const dialog = await openGroupControls()
    const view = within(dialog)
    const pattern = view.getByRole("textbox", { name: "JavaScript regular expression" })
    const mark = view.getByRole("button", { name: "Mark matching" })
    expect(mark).toBeDisabled()
    fireEvent.change(pattern, { target: { value: "[" } })
    expect(view.getByRole("alert")).toHaveTextContent(/Invalid JavaScript/)
    fireEvent.click(mark)
    expect(api).toHaveBeenCalledTimes(1)
    fireEvent.change(pattern, { target: { value: "^not-present$" } })
    expect(view.queryByRole("alert")).not.toBeInTheDocument()
    expect(mark).toBeDisabled()
    fireEvent.change(pattern, { target: { value: "^foil|reference$" } })
    fireEvent.click(view.getByRole("checkbox", { name: "Ignore case" }))
    const accepted = nextProject(project, { foil: { marked: true }, unused: { marked: true } })
    api.mockResolvedValueOnce(accepted)
    fireEvent.click(mark)
    await waitFor(() => expect(mark).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: 7, action: "metadata", group_ids: ["foil", "unused"], options: { marked: true },
    })
    api.mockResolvedValueOnce(nextProject(accepted, { foil: { marked: false }, unused: { marked: false } }))
    fireEvent.click(view.getByRole("button", { name: "Unmark matching" }))
    await waitFor(() => expect(mark).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: 8, action: "metadata", group_ids: ["foil", "unused"], options: { marked: false },
    })
    expect(plotProps().active!.id).toBe("foil")
    expect(plotProps().groups.map(g => g.id)).toEqual(["sample", "oxide"])
  })

  it.each(["current", "marked", "all", "matching"] as const)("freezes and unfreezes %s targets without changing numerical state", async target => {
    const project = projectFixture()
    project.groups[2].frozen = true
    await openSaved(project)
    const dialog = await openGroupControls()
    const view = within(dialog)
    fireEvent.change(view.getByRole("textbox", { name: "JavaScript regular expression" }), { target: { value: "scan$" } })
    fireEvent.change(view.getByRole("combobox", { name: "Freeze targets" }), { target: { value: target } })
    const ids = { current: ["foil"], marked: ["sample", "oxide"], all: ["foil", "sample", "oxide", "unused"], matching: ["foil", "sample"] }[target]
    let accepted = project
    for (const [label, frozen] of [["Freeze targets", true], ["Unfreeze targets", false]] as const) {
      const before = accepted
      accepted = nextProject(before, Object.fromEntries(ids.map(id => [id, { frozen }])))
      api.mockResolvedValueOnce(accepted)
      fireEvent.click(view.getByRole("button", { name: label }))
      await waitFor(() => expect(view.getByRole("button", { name: label })).toBeEnabled())
      expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
        version: before.version, action: "metadata", group_ids: ids, options: { frozen },
      })
      expect(plotProps().active!.id).toBe("foil")
      expect(plotProps().active!.parameters).toEqual(project.groups[0].parameters)
      expect(plotProps().active!.result).toEqual(project.groups[0].result)
    }
  })

  it("keeps flags and drafts on command failure, retries the accepted version, and makes no request for empty targets", async () => {
    const project = projectFixture()
    project.groups.forEach(g => { g.marked = false })
    await openSaved(project)
    editNumber(/^Rbkg/, 1.9)
    const dialog = await openGroupControls()
    const view = within(dialog)
    expect(view.getByRole("button", { name: "Freeze targets" })).toBeDisabled()
    fireEvent.click(view.getByRole("button", { name: "Freeze targets" }))
    expect(api).toHaveBeenCalledTimes(1)
    const failure = deferred<AthenaProject>()
    api.mockReturnValueOnce(failure.promise)
    fireEvent.click(view.getByRole("button", { name: "Invert marks" }))
    expect(view.getByRole("button", { name: "Invert marks" })).toBeDisabled()
    await act(async () => failure.reject(new Error("Selection could not be saved")))
    expect(view.getByRole("alert")).toHaveTextContent("Selection could not be saved")
    expect(plotProps().active!.marked).toBe(false)
    expect(plotProps().active!.id).toBe("foil")
    api.mockResolvedValueOnce(nextProject(project, Object.fromEntries(project.groups.map(g => [g.id, { marked: true }]))))
    fireEvent.click(view.getByRole("button", { name: "Invert marks" }))
    await waitFor(() => expect(view.queryByRole("alert")).not.toBeInTheDocument())
    await waitFor(() => expect(view.getByRole("button", { name: "Invert marks" })).toBeEnabled())
    expect(api.mock.calls[1]).toEqual(api.mock.calls[2])
    expect(plotProps().groups.map(g => g.id)).toEqual(["foil", "sample", "oxide", "unused"])
    fireEvent.click(view.getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.9)
  })
})

describe("AthenaWorkbench batch import", () => {
  it("reuses the chosen detector and reference mapping for matching layouts with each accepted revision", async () => {
    const project = await openSaved()
    const inspections = ["scan-1.dat", "scan-2.dat", "scan-3.dat"].map(name => inspectionFixture(name))
    const { dialog, files } = await chooseImportFiles(inspections)
    chooseFluorescenceMapping(dialog)
    expect(within(dialog).getByRole("checkbox", { name: /reuse this mapping/i })).toBeChecked()
    let accepted = project
    const results = inspections.map(i => (accepted = importedProject(accepted, i.display_name)))
    api.mockResolvedValueOnce(results[0]).mockResolvedValueOnce(inspections[1])
      .mockResolvedValueOnce(results[1]).mockResolvedValueOnce(inspections[2]).mockResolvedValueOnce(results[2])

    submitImport(dialog)

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls()).toEqual(inspections.map((i, index) => [`/projects/${project.id}/import`, {
      ...fluorescenceMapping, upload_id: i.upload_id, version: project.version + index,
    }]))
    const inspectionsSent = api.mock.calls.filter(([path]) => path.endsWith("/inspect"))
    expect(inspectionsSent.map(([, body]) => (body as FormData).get("file"))).toEqual(files)
    expect(plotProps().active).toEqual(results[2].groups.at(-1))
    expect(plotProps().groups).toEqual(results[2].groups.filter(g => g.marked))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it.each([
    ["reordered columns", ["Energy", "I0", "It", "If1", "If2", "Ir"]],
    ["different column count", ["Energy", "Signal", "I0"]],
  ])("pauses for a new mapping when the next file has %s", async (_description, names) => {
    const project = await openSaved()
    const first = inspectionFixture("scan-1.dat")
    const second = inspectionFixture("changed-layout.dat", names)
    const { dialog } = await chooseImportFiles([first, second])
    chooseFluorescenceMapping(dialog)
    const afterFirst = importedProject(project, first.display_name)
    const afterSecond = importedProject(afterFirst, second.display_name)
    api.mockResolvedValueOnce(afterFirst).mockResolvedValueOnce(second)

    submitImport(dialog)

    await within(dialog).findByText(second.display_name)
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Import spectrum$/i })).toBeEnabled())
    expect(importCalls()).toHaveLength(1)
    expect(plotProps().active).toEqual(afterFirst.groups.at(-1))
    expect(within(dialog).getByRole("checkbox", { name: `Numerator ${names[1]}` })).toBeChecked()
    // Review the newly presented layout and choose its direct signal explicitly.
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Measurement" }), { target: { value: "mu" } })
    api.mockResolvedValueOnce(afterSecond)
    submitImport(dialog)

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls()[1]).toEqual([`/projects/${project.id}/import`, expect.objectContaining({
      upload_id: second.upload_id, version: afterFirst.version, numerator: ["col_1"], mode: "mu",
      reference_numerator: null, reference_denominator: null,
    })])
    expect(plotProps().active).toEqual(afterSecond.groups.at(-1))
  })

  it("keeps the first imported file and existing drafts when importing the second file fails", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.7)
    const inspections = ["scan-1.dat", "scan-2.dat", "scan-3.dat"].map(name => inspectionFixture(name))
    const { dialog } = await chooseImportFiles(inspections)
    chooseFluorescenceMapping(dialog)
    const afterFirst = importedProject(project, inspections[0].display_name)
    api.mockResolvedValueOnce(afterFirst).mockResolvedValueOnce(inspections[1])
      .mockRejectedValueOnce(new Error("Second file could not be imported"))

    submitImport(dialog)

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Second file could not be imported")
    expect(importCalls()).toHaveLength(2)
    expect(api.mock.calls.filter(([path]) => path.endsWith("/inspect"))).toHaveLength(2)
    expect(plotProps().active).toEqual(afterFirst.groups.at(-1))
    expect(plotProps().groups).toEqual(afterFirst.groups.filter(g => g.marked))
    expect(localStorage.getItem(storageKey)).toBe(project.id)
    expect(within(dialog).getByRole("button", { name: /^Import spectrum$/i })).toBeEnabled()
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }))
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.7)
  })

  it("retries only the failed import with the chosen mapping and resumes the remaining batch", async () => {
    const project = await openSaved()
    const inspections = ["scan-1.dat", "scan-2.dat", "scan-3.dat"].map(name => inspectionFixture(name))
    const { dialog } = await chooseImportFiles(inspections)
    chooseFluorescenceMapping(dialog)
    const afterFirst = importedProject(project, inspections[0].display_name)
    const afterSecond = importedProject(afterFirst, inspections[1].display_name)
    const afterThird = importedProject(afterSecond, inspections[2].display_name)
    api.mockResolvedValueOnce(afterFirst).mockResolvedValueOnce(inspections[1])
      .mockRejectedValueOnce(new Error("Temporary import failure"))
    submitImport(dialog)
    await within(dialog).findByRole("alert")
    expect(within(dialog).getByRole("checkbox", { name: "Numerator If1" })).toBeChecked()
    expect(within(dialog).getByRole("checkbox", { name: "Numerator If2" })).toBeChecked()
    expect(within(dialog).getByLabelText("reference numerator")).toHaveValue("col_1")
    expect(within(dialog).getByLabelText("reference denominator")).toHaveValue("col_5")
    api.mockResolvedValueOnce(afterSecond).mockResolvedValueOnce(inspections[2]).mockResolvedValueOnce(afterThird)

    submitImport(dialog)

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls()).toEqual([
      [`/projects/${project.id}/import`, { ...fluorescenceMapping, upload_id: inspections[0].upload_id, version: project.version }],
      [`/projects/${project.id}/import`, { ...fluorescenceMapping, upload_id: inspections[1].upload_id, version: afterFirst.version }],
      [`/projects/${project.id}/import`, { ...fluorescenceMapping, upload_id: inspections[1].upload_id, version: afterFirst.version }],
      [`/projects/${project.id}/import`, { ...fluorescenceMapping, upload_id: inspections[2].upload_id, version: afterSecond.version }],
    ])
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(plotProps().active).toEqual(afterThird.groups.at(-1))
  })

  it("requires mapping review for a compatible file when reuse is turned off", async () => {
    const project = await openSaved()
    const first = inspectionFixture("scan-1.dat")
    const second = inspectionFixture("scan-2.dat")
    const { dialog } = await chooseImportFiles([first, second])
    chooseFluorescenceMapping(dialog)
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /reuse this mapping/i }))
    api.mockResolvedValueOnce(importedProject(project, first.display_name)).mockResolvedValueOnce(second)

    submitImport(dialog)

    await within(dialog).findByText(second.display_name)
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Import spectrum$/i })).toBeEnabled())
    expect(importCalls()).toHaveLength(1)
    expect(within(dialog).getByRole("checkbox", { name: "Numerator It" })).toBeChecked()
    expect(within(dialog).getByLabelText("reference numerator")).toHaveValue("")
    expect(within(dialog).getByLabelText("reference denominator")).toHaveValue("")
  })

  it("recovers from a second-file inspection failure by reselecting that file without losing the first import", async () => {
    const project = await openSaved()
    const first = inspectionFixture("scan-1.dat")
    const second = inspectionFixture("scan-2.dat")
    const { dialog, files } = await chooseImportFiles([first, second])
    const afterFirst = importedProject(project, first.display_name)
    const afterSecond = importedProject(afterFirst, second.display_name)
    api.mockResolvedValueOnce(afterFirst).mockRejectedValueOnce(new Error("Second file inspection failed"))
    submitImport(dialog)

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Second file inspection failed")
    expect(importCalls()).toHaveLength(1)
    expect(plotProps().active).toEqual(afterFirst.groups.at(-1))
    expect(within(dialog).queryByRole("button", { name: /^Import spectrum$/i })).not.toBeInTheDocument()
    api.mockResolvedValueOnce(second)
    fireEvent.change(within(dialog).getByLabelText("Choose data files"), { target: { files: [files[1]] } })
    await within(dialog).findByText(second.display_name)
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Import spectrum$/i })).toBeEnabled())
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
    api.mockResolvedValueOnce(afterSecond)
    submitImport(dialog)

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(importCalls()).toHaveLength(2)
    expect(importCalls()[1]).toEqual([`/projects/${project.id}/import`, expect.objectContaining({
      upload_id: second.upload_id, version: afterFirst.version,
    })])
    expect(plotProps().groups).toEqual(afterSecond.groups.filter(g => g.marked))
  })
})

describe("AthenaWorkbench project loading", () => {
  it("creates and remembers one initial project even under StrictMode", async () => {
    const project = projectFixture({ groups: [] })
    const request = deferred<AthenaProject>()
    api.mockReturnValueOnce(request.promise)
    render(<StrictMode><AthenaWorkbench /></StrictMode>)

    expect(api).toHaveBeenCalledExactlyOnceWith("/projects", {})
    expect(screen.getByRole("button", { name: /^Import data$/i })).toBeDisabled()
    await act(async () => request.resolve(project))

    await waitFor(() => expect(screen.getByRole("button", { name: /^Import data$/i })).toBeEnabled())
    expect(localStorage.getItem(storageKey)).toBe(project.id)
    expect(plotProps().groups).toEqual([])
    expect(plotProps().active).toBeUndefined()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("loads the saved project without creating a replacement", async () => {
    const project = await openSaved()

    expect(api).toHaveBeenCalledExactlyOnceWith(`/projects/${project.id}`)
    expect(screen.getByRole("button", { name: project.name })).toBeVisible()
    expect(plotProps().active).toEqual(project.groups[0])
    expect(plotProps().groups).toEqual(project.groups.filter(g => g.marked))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1)
  })

  it("retries the saved project after a load failure instead of creating a new workspace", async () => {
    const project = projectFixture()
    localStorage.setItem(storageKey, project.id)
    api.mockRejectedValueOnce(new Error("Saved project could not be reached"))
    api.mockResolvedValueOnce(project)
    render(<AthenaWorkbench />)

    expect(await screen.findByRole("alert")).toHaveTextContent("Saved project could not be reached")
    expect(localStorage.getItem(storageKey)).toBe(project.id)
    fireEvent.click(screen.getByRole("button", { name: /reload workspace/i }))

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`], [`/projects/${project.id}`]])
    expect(plotProps().active).toEqual(project.groups[0])
  })

  it("opens a recent project and clears drafts belonging to the previous project", async () => {
    const original = await openSaved()
    editNumber(/^Rbkg/, 2.5)
    const loaded = projectFixture({ id: "project-fe", name: "Iron study", version: 3 })
    loaded.groups[0] = { ...loaded.groups[0], parameters: { ...parameters, rbkg: 1.8 } }
    api.mockResolvedValueOnce([{ id: loaded.id, name: loaded.name, updated: loaded.updated, count: loaded.groups.length }])
    api.mockResolvedValueOnce(loaded)

    fireEvent.click(screen.getByRole("button", { name: /^Open project$/i }))
    const dialog = await screen.findByRole("dialog", { name: /open.*project/i })
    const recent = await within(dialog).findByRole("button", { name: new RegExp(loaded.name) })
    await waitFor(() => expect(recent).toBeEnabled())
    fireEvent.click(recent)

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api.mock.calls).toEqual([[`/projects/${original.id}`], ["/projects"], [`/projects/${loaded.id}`]])
    expect(localStorage.getItem(storageKey)).toBe(loaded.id)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.8)
    expect(plotProps().active).toEqual(loaded.groups[0])
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
  })
})

describe("AthenaWorkbench project import integration", () => {
  it("passes the latest accepted project to the panel and guards closing while imports are busy", async () => {
    const project = await openSaved()
    api.mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole("button", { name: /^Open project$/ }))
    const dialog = await screen.findByRole("dialog", { name: "Open a project" })
    const panelProps = () => projectImport.mock.calls.at(-1)![0]
    await waitFor(() => expect(panelProps().disabled).toBe(false))
    expect(panelProps().getProject()).toBe(project)
    act(() => panelProps().onBusyChange("Importing project groups"))
    expect(panelProps().disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }))
    const escape = new Event("cancel", { bubbles: false, cancelable: true })
    fireEvent(dialog, escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(dialog).toBeInTheDocument()
    const accepted = importedProject(project, "Imported foil")
    act(() => panelProps().onImported(accepted))
    expect(panelProps().getProject()).toBe(accepted)
    expect(plotProps().active!.id).toBe("Imported foil")
    act(() => { panelProps().onBusyChange(""); panelProps().onComplete() })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Project import · complete")
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`], ["/projects"]])
  })

  it.each([true, false])("offers marked-only export only when marked groups exist (%s)", async hasMarks => {
    const project = projectFixture()
    if (!hasMarks) project.groups.forEach(g => { g.marked = false })
    await openSaved(project)
    fireEvent.click(within(screen.getByRole("navigation", { name: /Main menu/ })).getByRole("button", { name: "File" }))
    if (hasMarks) expect(screen.getByRole("link", { name: /Save marked project/ })).toHaveAttribute("href", expect.stringContaining(`/projects/${project.id}/export?format=prj&marked_only=true`))
    else {
      expect(screen.queryByRole("link", { name: /Save marked project/ })).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Save marked project/ })).toBeDisabled()
    }
  })
})

describe("AthenaWorkbench group selection and drafts", () => {
  it("keeps restored scalar drafts clean across reordered standard and undo recipes, preserving other groups' edits", async () => {
    const project = projectFixture()
    project.groups[0].parameters = { ...parameters, e0: null, fnorm: false }
    project.groups[1].result!.arrays.chi = [0.2, -0.2]
    await openSaved(project)
    selectGroup("Sample scan")
    editNumber(/^Rbkg/, 2.7)
    selectGroup("Foil scan")
    const pickE0 = armPick("E₀")
    act(() => pickE0(8985, "E"))
    editNumber(/^E₀/, "")
    editNumber(/^Spline energy min/, 100)
    editNumber(/^Spline k min/, 0)

    const expectCleanFoil = () => {
      expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
      expect(screen.getByText("Up to date")).toBeVisible()
      expect(within(screen.getByRole("button", { name: name => name.startsWith("Foil scan") })).queryByTitle("Unapplied parameters")).not.toBeInTheDocument()
    }
    expectCleanFoil()
    const reordered = Object.fromEntries(Object.entries(project.groups[0].parameters).reverse()) as Parameters
    expect(Object.keys(reordered)).not.toEqual(Object.keys(project.groups[0].parameters))
    const applied = nextProject(project, { foil: { background_standard_id: "sample", parameters: reordered } })
    applied.undo = ["before-standard"]
    api.mockResolvedValueOnce(applied)
    fireEvent.change(screen.getByRole("combobox", { name: "Background removal standard" }), { target: { value: "sample" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply standard" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled())
    expectCleanFoil()

    // A restored older recipe can omit the false default as well as reorder keys.
    const restored = Object.fromEntries(Object.entries(reordered).filter(([key]) => key !== "fnorm")) as Parameters
    api.mockResolvedValueOnce(nextProject(applied, { foil: { background_standard_id: null, parameters: restored } }))
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/ })).toBeEnabled())
    expectCleanFoil()
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(null)
    expect(screen.getByRole("spinbutton", { name: /^Spline k min/ })).toHaveValue(0)
    expect(screen.getByRole("combobox", { name: "Background removal standard" })).toHaveValue("")
    expect(api.mock.calls.slice(1).map(([, body]) => (body as { action: string }).action)).toEqual(["background_standard", "undo"])

    // Automatic E0 is still different from an explicit value equal to its readout.
    editNumber(/^E₀/, 8979)
    expect(screen.getByRole("button", { name: /Discard parameter changes/ })).toBeVisible()
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.7)
    expect(within(screen.getByRole("button", { name: name => name.startsWith("Sample scan") })).getByTitle("Unapplied parameters")).toBeInTheDocument()
  })

  it("treats an omitted fnorm and a reverted false draft as equal in dirty indicators and the Apply patch", async () => {
    const project = await openSaved()
    expect(project.groups[0].parameters.fnorm).toBeUndefined()
    const control = screen.getByRole("checkbox", { name: "Energy-dependent normalization" })
    fireEvent.click(control)
    expect(screen.getByRole("button", { name: /Discard parameter changes/ })).toBeVisible()
    expect(screen.getByTitle("Unapplied parameters")).toBeInTheDocument()
    fireEvent.click(control)
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
    expect(screen.queryByTitle("Unapplied parameters")).not.toBeInTheDocument()
    api.mockResolvedValueOnce(nextProject(project, { foil: { parameters: { fnorm: false, ...Object.fromEntries(Object.entries(parameters).reverse()) } as Parameters } }))
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/ })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: {},
    })
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
  })

  it("removes an applied draft after reordered copy responses so Undo reveals the restored server recipe", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2)
    selectGroup("Sample scan")
    const copied = nextProject(project, Object.fromEntries(project.groups.map(g => [g.id, {
      parameters: Object.fromEntries(Object.entries({ ...g.parameters, rbkg: 1.2, fnorm: false }).reverse()) as Parameters,
    }])))
    copied.undo = ["before-copy"]
    api.mockResolvedValueOnce(copied)
    const dialog = await openParameterDialog("background", "all")
    fireEvent.click(within(dialog).getByRole("button", { name: /^Copy parameters$/ }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.2)
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()

    api.mockResolvedValueOnce({ ...project, version: copied.version + 1 })
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/ })).toBeEnabled())
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1)
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
    expect(screen.queryByTitle("Unapplied parameters")).not.toBeInTheDocument()
  })

  it("keeps active selection independent of marks and the plot target", async () => {
    const project = await openSaved()
    selectGroup("Unused reference")

    expect(plotProps().active?.id).toBe("unused")
    expect(plotProps().groups.map(g => g.id)).toEqual(["sample", "oxide"])
    expect(screen.getByRole("checkbox", { name: "Mark Unused reference" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Mark Sample scan" })).toBeChecked()
    expect(api).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("checkbox", { name: /^Plot marked$/i }))
    expect(plotProps().groups.map(g => g.id)).toEqual(["unused"])
    selectGroup("Foil scan")
    expect(plotProps().groups.map(g => g.id)).toEqual(["foil"])

    fireEvent.click(screen.getByRole("checkbox", { name: /^Plot marked$/i }))
    const next = nextProject(project, { sample: { marked: false } })
    api.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark Sample scan" }))
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Mark Sample scan" })).toBeEnabled())

    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "metadata", group_ids: ["sample"], options: { marked: false },
    })
    expect(plotProps().active?.id).toBe("foil")
    expect(plotProps().groups.map(g => g.id)).toEqual(["oxide"])
  })

  it("restores each group's draft on selection and discards only the active draft", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.1)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.2)
    editNumber(/^Rbkg/, 2.7)
    selectGroup("Foil scan")

    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.1)
    expect(plotProps().active).toEqual(project.groups[0])
    fireEvent.click(screen.getByRole("button", { name: /discard parameter changes/i }))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.7)
    expect(plotProps().active).toEqual(project.groups[1])
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("applies only the selected draft, accepts the response, and preserves other drafts", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.3)
    selectGroup("Sample scan")
    editNumber(/^Rbkg/, 1.9)
    editNumber(/^E₀/, "")
    const applied = { ...project.groups[1].parameters, rbkg: 1.9, e0: null }
    const result = { arrays: { energy: [8960, 8980, 9000], norm: [0, 0.6, 1] }, effective: { e0: 8981, edge_step: 0.9 }, warnings: [] }
    const next = nextProject(project, { sample: { parameters: applied, result } })
    const request = deferred<AthenaProject>()
    api.mockReturnValueOnce(request.promise)
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/i }))

    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["sample"], options: { rbkg: 1.9, e0: null },
    })
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toBeDisabled()
    expect(plotProps().active).toEqual(project.groups[1])
    await act(async () => request.resolve(next))

    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/i })).toBeEnabled())
    expect(plotProps().active).toEqual(next.groups[1])
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)

    // The next mutation must use the accepted revision, not the startup revision.
    api.mockResolvedValueOnce(nextProject(next, { unused: { marked: true } }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark Unused reference" }))
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Mark Unused reference" })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: next.version, action: "metadata", group_ids: ["unused"], options: { marked: true },
    })
  })

  it("copies the active draft to marked IDs with destination shifts preserved and frozen groups skipped", async () => {
    const initial = projectFixture()
    initial.groups[0].parameters.energy_shift = 7
    initial.groups[1].parameters.energy_shift = -3
    initial.groups[2].parameters.energy_shift = 5
    initial.groups[2].frozen = true
    const project = await openSaved(initial)
    selectGroup("Sample scan")
    editNumber(/^Rbkg/, 4)
    selectGroup("Foil scan")
    editNumber(/^Rbkg/, 2.2)
    editNumber(/^Energy shift/, 9)
    const applied = { ...project.groups[0].parameters, rbkg: 2.2, energy_shift: 9 }
    const next = nextProject(project, { sample: { parameters: { ...applied, energy_shift: -3 } } })
    next.last_operation = { action: "copy_parameters", skipped_group_ids: ["oxide"] }
    api.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole("checkbox", { name: /^Apply to marked groups/i }))
    expect(screen.getByText(/Frozen groups are skipped.*Energy shifts are preserved/i)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/i }))

    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/i })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "copy_parameters", group_ids: ["sample", "oxide"],
      options: { source_id: "foil", section: "all", values: applied },
    })
    expect(plotProps().active).toEqual(project.groups[0])
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.2)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(9)
    expect(screen.getByRole("button", { name: /discard parameter changes/i })).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent("1 group skipped")
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.2)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(-3)
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
    selectGroup("Oxide standard")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.4)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(5)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toBeDisabled()
    expect(plotProps().active).toEqual(project.groups[2])
  })

  it("shows a failed apply without overwriting accepted data or drafts, and permits retry", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.4)
    const applied = { ...parameters, rbkg: 2.4 }
    const request = deferred<AthenaProject>()
    api.mockReturnValueOnce(request.promise)
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/i }))
    await act(async () => request.reject(new ApiRequestError({
      code: "invalid_parameters", message: "Spline range cannot be processed", fields: ["rbkg"],
      recovery: "Review the spline settings.",
    }, 422)))

    expect(await screen.findByRole("alert")).toHaveTextContent("Spline range cannot be processed")
    expect(plotProps().active).toEqual(project.groups[0])
    expect(plotProps().groups).toEqual(project.groups.filter(g => g.marked))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.4)
    expect(screen.getByRole("button", { name: /discard parameter changes/i })).toBeEnabled()
    expect(localStorage.getItem(storageKey)).toBe(project.id)

    const next = nextProject(project, { foil: { parameters: applied } })
    api.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/i }))
    await waitFor(() => expect(plotProps().active).toEqual(next.groups[0]))
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { rbkg: 2.4 },
    })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("AthenaWorkbench single-parameter patches", () => {
  it("omits unchanged explicit E0 on a shift-only edit and accepts the backend-adjusted E0", async () => {
    const initial = projectFixture()
    initial.groups[0].parameters = { ...parameters, e0: 8980, energy_shift: 2 }
    const project = await openSaved(initial)
    editNumber(/^Energy shift/, 5)
    const next = nextProject(project, {
      foil: { parameters: { ...project.groups[0].parameters, energy_shift: 5, e0: 8983 } },
    })
    api.mockResolvedValueOnce(next)

    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/i }))

    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/i })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { energy_shift: 5 },
    })
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8983)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(5)
    expect(plotProps().active).toEqual(next.groups[0])
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
  })

  it("includes a deliberately changed E0 with the energy shift in the same patch", async () => {
    const project = await openSaved()
    editNumber(/^Energy shift/, 5)
    editNumber(/^E₀/, 8990)
    const next = nextProject(project, { foil: { parameters: { ...parameters, energy_shift: 5, e0: 8990 } } })
    api.mockResolvedValueOnce(next)

    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/i }))

    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/i })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { e0: 8990, energy_shift: 5 },
    })
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8990)
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
  })

  it("sends an empty patch when applying an unchanged group", async () => {
    const project = await openSaved()
    const next = nextProject(project, {})
    api.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole("button", { name: /^Apply parameters$/i }))

    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply parameters$/i })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: {},
    })
    expect(plotProps().active).toEqual(next.groups[0])
  })
})

describe("AthenaWorkbench parameter copy and reset", () => {
  it("copies a section to all groups while preserving unrelated drafts and server-reported skipped groups", async () => {
    const initial = projectFixture()
    initial.groups[2].frozen = true
    initial.groups[3].reference_id = "oxide"
    const project = await openSaved(initial)
    selectGroup("Unused reference")
    editNumber(/^Rbkg/, 4)
    selectGroup("Sample scan")
    editNumber(/^E₀/, "")
    editNumber(/^Energy shift/, 6)
    selectGroup("Foil scan")
    editNumber(/^Rbkg/, 2.3)
    editNumber(/^E₀/, 8982)
    const draft = { ...parameters, rbkg: 2.3, e0: 8982 }
    const next = nextProject(project, {
      foil: { parameters: { ...project.groups[0].parameters, rbkg: 2.3 } },
      sample: { parameters: { ...project.groups[1].parameters, rbkg: 2.3 } },
    })
    next.last_operation = { action: "copy_parameters", skipped_group_ids: ["oxide", "unused"] }
    const dialog = await openParameterDialog("background", "all")
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /^Copy parameters$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "copy_parameters", group_ids: project.groups.map(g => g.id),
      options: { source_id: "foil", section: "background", values: draft },
    })
    expect(screen.getByRole("status")).toHaveTextContent("2 groups skipped")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8982)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(null)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(6)
    selectGroup("Unused reference")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(4)
    expect(plotProps().active).toEqual(project.groups[3])
    selectGroup("Oxide standard")
    expect(plotProps().active).toEqual(project.groups[2])
  })

  it("copies an explicitly selected energy shift to marked groups without applying other draft fields", async () => {
    const project = await openSaved()
    selectGroup("Sample scan")
    editNumber(/^Rbkg/, 4)
    editNumber(/^Energy shift/, 6)
    selectGroup("Foil scan")
    editNumber(/^Rbkg/, 2.4)
    editNumber(/^Energy shift/, 9)
    const dialog = await openParameterDialog("single")
    fireEvent.change(within(dialog).getByRole("combobox", { name: /^Parameter$/ }), { target: { value: "energy_shift" } })
    expect(within(dialog).getByText(/Energy shift is explicitly selected and will change/i)).toBeVisible()
    const next = nextProject(project, {
      sample: { parameters: { ...project.groups[1].parameters, energy_shift: 9 } },
      oxide: { parameters: { ...project.groups[2].parameters, energy_shift: 9 } },
    })
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /^Copy parameters$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "copy_parameters", group_ids: ["sample", "oxide"],
      options: { source_id: "foil", parameter: "energy_shift", values: { ...parameters, rbkg: 2.4, energy_shift: 9 } },
    })
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(9)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(4)
    expect(plotProps().active?.parameters.rbkg).toBe(1.2)
  })

  it("resets all parameters on the current group using returned defaults while preserving its shift draft", async () => {
    const initial = projectFixture()
    initial.groups[0].parameters.energy_shift = 4.5
    const project = await openSaved(initial)
    editNumber(/^Rbkg/, 2.9)
    editNumber(/^Energy shift/, 6)
    const dialog = await openParameterDialog("all", "current")
    const defaults = { ...project.groups[0].parameters, e0: null, rbkg: 1 }
    const next = nextProject(project, { foil: { parameters: defaults } })
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /reset to defaults/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "reset_parameters", group_ids: ["foil"], options: { section: "all" },
    })
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(null)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(6)
    expect(plotProps().active?.parameters.energy_shift).toBe(4.5)
    expect(screen.getByRole("button", { name: /discard parameter changes/i })).toBeVisible()
  })

  it("resets a single parameter on marked groups without using the source draft or clearing frozen drafts", async () => {
    const project = await openSaved()
    selectGroup("Oxide standard")
    editNumber(/^Rbkg/, 4)
    const frozen = nextProject(project, { oxide: { frozen: true } })
    api.mockResolvedValueOnce(frozen)
    fireEvent.click(screen.getByRole("button", { name: /^Freeze group$/i }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Unfreeze group$/i })).toBeEnabled())
    selectGroup("Foil scan")
    editNumber(/^Rbkg/, 2.9)
    const dialog = await openParameterDialog("single")
    const next = nextProject(frozen, { sample: { parameters: { ...frozen.groups[1].parameters, rbkg: 1 } } })
    next.last_operation = { action: "reset_parameters", skipped_group_ids: ["oxide"] }
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /reset to defaults/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: frozen.version, action: "reset_parameters", group_ids: ["sample", "oxide"], options: { parameter: "rbkg" },
    })
    expect(screen.getByRole("status")).toHaveTextContent("1 group skipped")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.9)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1)
    selectGroup("Oxide standard")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(4)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toBeDisabled()
    expect(plotProps().active?.parameters.rbkg).toBe(1.4)
  })

  it("keeps section reset inputs and drafts after a failure and retries the same revision", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.9)
    const dialog = await openParameterDialog("normalization", "all")
    api.mockRejectedValueOnce(new Error("Reset could not be processed"))
    fireEvent.click(within(dialog).getByRole("button", { name: /reset to defaults/i }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Reset could not be processed")
    expect(within(dialog).getByRole("combobox", { name: "Parameters to change" })).toHaveValue("normalization")
    expect(within(dialog).getByRole("combobox", { name: "Destination groups" })).toHaveValue("all")
    expect(plotProps().active).toEqual(project.groups[0])
    const next = { ...project, version: project.version + 1, groups: project.groups.map(g => ({
      ...g, parameters: { ...g.parameters, e0: null },
    })) }
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: /reset to defaults/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    const expected = [`/projects/${project.id}/command`, {
      version: project.version, action: "reset_parameters", group_ids: project.groups.map(g => g.id), options: { section: "normalization" },
    }]
    expect(api.mock.calls.slice(-2)).toEqual([expected, expected])
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.9)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(null)
  })

  it.each(["none marked", "all marked frozen"])("disables copy and reset for %s and allows choosing other destinations", async condition => {
    const project = projectFixture()
    for (const g of project.groups) {
      if (condition === "none marked") g.marked = false
      else if (g.marked) g.frozen = true
    }
    await openSaved(project)
    const dialog = await openParameterDialog()
    expect(within(dialog).getByRole("button", { name: /^Copy parameters$/i })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: /reset to defaults/i })).toBeDisabled()
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Destination groups" }), { target: { value: "all" } })
    expect(within(dialog).getByRole("button", { name: /^Copy parameters$/i })).toBeEnabled()
    expect(within(dialog).getByRole("button", { name: /reset to defaults/i })).toBeEnabled()
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }))
    expect(api).toHaveBeenCalledTimes(1)
  })
})

describe("AthenaWorkbench weighted combinations", () => {
  it("keeps relative merge weights paired with marked IDs in the saved list order", async () => {
    const initial = projectFixture()
    initial.groups = [initial.groups[0], initial.groups[2], initial.groups[1], initial.groups[3]]
    const project = await openSaved(initial)
    selectGroup("Unused reference")
    const dialog = await openTool("Process", /merge marked groups/i)
    fireEvent.change(within(dialog).getByRole("combobox", { name: /signal to combine/i }), { target: { value: "norm" } })
    editNumber(/^Weight: Oxide standard$/, 3, dialog)
    editNumber(/^Weight: Sample scan$/, 1, dialog)
    const next = importedProject(project, "weighted-merge")
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "merge", group_ids: ["oxide", "sample"], options: { weights: [3, 1], array: "norm" },
    })
    expect(plotProps().active).toEqual(next.groups.at(-1))
  })

  it("sends signed sum coefficients unchanged and resets the controls when reopened", async () => {
    const initial = projectFixture()
    initial.groups[0].marked = true
    const project = await openSaved(initial)
    const dialog = await openTool("Process", /sum marked groups/i)
    expect(within(dialog).getAllByRole("spinbutton").map(input => (input as HTMLInputElement).value)).toEqual(["1", "1", "1"])
    expect(within(dialog).getByRole("combobox", { name: /signal to combine/i })).toHaveValue("")
    editNumber(/^Coefficient: Foil scan$/, 2, dialog)
    editNumber(/^Coefficient: Sample scan$/, -1.5, dialog)
    editNumber(/^Coefficient: Oxide standard$/, 0, dialog)
    fireEvent.change(within(dialog).getByRole("combobox", { name: /signal to combine/i }), { target: { value: "mu" } })
    const next = importedProject(project, "signed-sum")
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "sum", group_ids: ["foil", "sample", "oxide"], options: { weights: [2, -1.5, 0], array: "mu" },
    })
    const reopened = await openTool("Process", /sum marked groups/i)
    for (const input of within(reopened).getAllByRole("spinbutton")) expect(input).toHaveValue(1)
    expect(within(reopened).getByRole("combobox", { name: /signal to combine/i })).toHaveValue("")
    api.mockResolvedValueOnce(importedProject(next, "default-sum"))
    fireEvent.click(within(reopened).getByRole("button", { name: /^Apply$/i }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: next.version, action: "sum", group_ids: next.groups.filter(g => g.marked).map(g => g.id),
      options: { weights: next.groups.filter(g => g.marked).map(() => 1) },
    })
  })

  it.each([{ weights: [-1, 1] }, { weights: [0, 0] }])("shows backend rejection for merge weights $weights and preserves inputs for retry", async ({ weights }) => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.9)
    const dialog = await openTool("Process", /merge marked groups/i)
    editNumber(/^Weight: Sample scan$/, weights[0], dialog)
    editNumber(/^Weight: Oxide standard$/, weights[1], dialog)
    api.mockRejectedValueOnce(new ApiRequestError({
      code: "invalid_weights", message: "Merge weights must be nonnegative with a positive total.",
      fields: ["weights"], recovery: "Review the relative weights.",
    }, 422))
    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply$/i }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Merge weights must be nonnegative with a positive total.")
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "merge", group_ids: ["sample", "oxide"], options: { weights },
    })
    expect(within(dialog).getByRole("spinbutton", { name: /^Weight: Sample scan$/ })).toHaveValue(weights[0])
    expect(within(dialog).getByRole("spinbutton", { name: /^Weight: Oxide standard$/ })).toHaveValue(weights[1])
    expect(plotProps().active).toEqual(project.groups[0])
    expect(plotProps().groups).toEqual(project.groups.filter(g => g.marked))
    const next = importedProject(project, "recovered-merge")
    api.mockResolvedValueOnce(next)
    editNumber(/^Weight: Sample scan$/, 3, dialog)
    editNumber(/^Weight: Oxide standard$/, 1, dialog)
    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply$/i }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "merge", group_ids: ["sample", "oxide"], options: { weights: [3, 1] },
    })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.9)
  })

  it("reports an empty coefficient instead of silently treating it as zero or one", async () => {
    await openSaved()
    const dialog = await openTool("Process", /sum marked groups/i)
    editNumber(/^Coefficient: Sample scan$/, "", dialog)
    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply$/i }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Enter a finite coefficient for Sample scan/i)
    expect(within(dialog).getByRole("spinbutton", { name: /^Coefficient: Sample scan$/ })).toHaveValue(null)
    expect(api).toHaveBeenCalledTimes(1)
  })

  function withExafs(project: AthenaProject) {
    return { ...project, groups: project.groups.map(g => g.marked ? {
      ...g, result: { ...g.result!, arrays: { ...g.result!.arrays, k: [1, 2, 3], chi: [0.1, -0.1, 0.05] } },
    } : g) }
  }

  it("offers chi for marked processed EXAFS with overlapping grids, including mixed input types", async () => {
    const initial = withExafs(projectFixture())
    initial.groups[2].data_type = "chi"
    initial.groups[2].energy = [2, 2.5, 3.5]
    initial.groups[2].mu = initial.groups[2].result!.arrays.chi
    initial.groups[2].result!.arrays.k = initial.groups[2].energy
    const project = await openSaved(initial)
    const dialog = await openTool("Process", /merge marked groups/i)
    expect(within(dialog).getByRole("option", { name: "χ(k)" })).toBeEnabled()
    fireEvent.change(within(dialog).getByRole("combobox", { name: /signal to combine/i }), { target: { value: "chi" } })
    api.mockResolvedValueOnce(importedProject(project, "merged-chi"))

    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "merge", group_ids: ["sample", "oxide"], options: { weights: [1, 1], array: "chi" },
    })
  })

  it.each(["missing chi", "disjoint grids", "XANES data"])("disables chi when a marked group has %s", async condition => {
    const project = withExafs(projectFixture())
    if (condition === "missing chi") project.groups[2].result!.arrays.chi = []
    if (condition === "disjoint grids") project.groups[2].result!.arrays.k = [4, 5, 6]
    if (condition === "XANES data") project.groups[2].data_type = "xanes"
    await openSaved(project)
    const dialog = await openTool("Process", /sum marked groups/i)

    expect(within(dialog).getByRole("option", { name: "χ(k)" })).toBeDisabled()
    expect(within(dialog).getByText(/χ\(k\) requires processed EXAFS/i)).toBeVisible()
    expect(within(dialog).getByRole("option", { name: "Normalized μ(E)" })).toBeEnabled()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("keeps difference options independent of a previously edited sum dialog", async () => {
    const project = await openSaved()
    const sum = await openTool("Process", /sum marked groups/i)
    editNumber(/^Coefficient: Sample scan$/, -2, sum)
    fireEvent.change(within(sum).getByRole("combobox", { name: /signal to combine/i }), { target: { value: "norm" } })
    fireEvent.click(within(sum).getByRole("button", { name: /cancel/i }))
    const difference = await openTool("Process", /difference spectrum/i)
    expect(within(difference).queryByRole("combobox", { name: /signal to combine/i })).not.toBeInTheDocument()
    fireEvent.change(within(difference).getByRole("combobox", { name: "STANDARD" }), { target: { value: "oxide" } })
    const preview = differencePreview(project, ["foil"], { standard_id: "oxide" })
    api.mockResolvedValueOnce(preview)
    fireEvent.click(within(difference).getByRole("button", { name: "Preview difference" }))
    await waitFor(() => expect(within(difference).getByRole("button", { name: "Save difference groups" })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/difference/preview`, {
      version: project.version, action: "difference", group_ids: ["foil"], options: { ...differenceOptions, standard_id: "oxide" },
    })
    expect(plotProps().active?.id).toBe("foil")
    const next = differenceSaved(project, preview)
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(difference).getByRole("button", { name: "Save difference groups" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "difference", group_ids: ["foil"], options: preview.options,
    })
    expect(plotProps().active?.id).toBe("diff-foil")
    expect(screen.getByRole("status")).toHaveTextContent("Difference groups saved · 1 created")
  })

  it("previews marked differences from saved recipes and preserves source data and independent drafts on save", async () => {
    const initial = projectFixture()
    initial.groups[1].frozen = true
    const project = await openSaved(initial)
    editNumber(/^Rbkg/, 2.7)
    selectGroup("Oxide standard"); editNumber(/^Rbkg/, 3.1)
    const dialog = await openTool("Process", /difference spectrum/i)
    const view = within(dialog)
    fireEvent.change(view.getByRole("combobox", { name: "STANDARD" }), { target: { value: "unused" } })
    fireEvent.change(view.getByRole("combobox", { name: "DATA targets" }), { target: { value: "marked" } })
    const preview = differencePreview(project, ["sample", "oxide"], { standard_id: "unused" })
    api.mockResolvedValueOnce(preview)
    fireEvent.click(view.getByRole("button", { name: "Preview difference" }))
    await waitFor(() => expect(view.getByRole("button", { name: "Save difference groups" })).toBeEnabled())
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 7, action: "difference", group_ids: ["sample", "oxide"], options: preview.options })
    expect(plotProps().active?.parameters.rbkg).toBe(1.4)
    const next = differenceSaved(project, preview)
    api.mockResolvedValueOnce(next)
    fireEvent.click(view.getByRole("button", { name: "Save difference groups" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(plotProps().active?.id).toBe("diff-oxide")
    selectGroup("Sample scan")
    expect(plotProps().active).toBe(project.groups[1])
    expect(plotProps().active?.frozen).toBe(true)
    selectGroup("Oxide standard")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(3.1)
    expect(plotProps().active?.result?.arrays).toBe(project.groups[2].result?.arrays)
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.7)
    expect(api).toHaveBeenCalledTimes(3)
  })
})

describe("AthenaWorkbench reference ties", () => {
  it("ties exactly two marked groups in list order and unties the active reference using the accepted revision", async () => {
    const initial = projectFixture()
    initial.groups = [initial.groups[0], initial.groups[2], initial.groups[1], initial.groups[3]]
    initial.groups[1].parameters.energy_shift = 2.5
    initial.groups[2].parameters.energy_shift = -1
    const project = await openSaved(initial)
    const tied = nextProject(project, {
      oxide: { reference_id: "sample" },
      sample: { parameters: { ...project.groups[2].parameters, energy_shift: 2.5 } },
    })
    api.mockResolvedValueOnce(tied)
    openGroupMenu()
    expect(screen.getByText(/keeps both shifts linked when either is edited/i)).toBeVisible()
    expect(screen.getByText(/Sample: Oxide standard/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /^Tie marked sample and reference$/i }))

    await waitFor(() => expect(plotProps().groups).toEqual(tied.groups.filter(g => g.marked)))
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "tie_reference", group_ids: ["oxide", "sample"], options: {},
    })
    expect(plotProps().active).toEqual(project.groups[0])
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(2.5)
    const untied = nextProject(tied, { oxide: { reference_id: null } })
    api.mockResolvedValueOnce(untied)
    openGroupMenu()
    fireEvent.click(screen.getByRole("button", { name: /^Untie current reference$/i }))

    await waitFor(() => expect(plotProps().groups).toEqual(untied.groups.filter(g => g.marked)))
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: tied.version, action: "untie_reference", group_ids: ["sample"], options: {},
    })
    expect(plotProps().active).toEqual(untied.groups[2])
  })

  it.each([0, 1, 3])("does not allow tying %i marked groups", async count => {
    const project = projectFixture()
    project.groups.forEach((g, index) => { g.marked = index < count })
    await openSaved(project)
    openGroupMenu()
    const tie = screen.getByRole("button", { name: /^Tie marked sample and reference$/i })
    expect(tie).toBeDisabled()
    fireEvent.click(tie)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("shows rejected reference ties without changing accepted groups or parameter drafts", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.9)
    api.mockRejectedValueOnce(new Error("Unfreeze the reference before changing its energy shift."))
    openGroupMenu()
    fireEvent.click(screen.getByRole("button", { name: /^Tie marked sample and reference$/i }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Unfreeze the reference before changing its energy shift.")
    expect(plotProps().groups).toEqual(project.groups.filter(g => g.marked))
    expect(plotProps().active).toEqual(project.groups[0])
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.9)
  })
})

describe("AthenaWorkbench tools and analysis dialogs", () => {
  it("cancels a processing dialog without submitting and applies calibration to the active group", async () => {
    const project = await openSaved()
    selectGroup("Unused reference")
    let dialog = await openTool("Process", /calibrate energy/i)
    editNumber(/^Calibrated energy/, 8980, dialog)
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel$/i }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(1)

    dialog = await openTool("Process", /calibrate energy/i)
    editNumber(/^Observed edge/, 8978, dialog)
    editNumber(/^Calibrated energy/, 8979, dialog)
    const next = nextProject(project, { unused: { parameters: { ...parameters, rbkg: 1.6, energy_shift: 1 } } })
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, expect.objectContaining({
      version: project.version, action: "calibrate", group_ids: ["unused"],
      options: expect.objectContaining({ observed: 8978, target: 8979 }),
    }))
    expect(plotProps().active).toEqual(next.groups[3])
  })

  it("merges marked groups in list order and selects the returned derived group", async () => {
    const project = await openSaved()
    const derived = group("merged", "Merged scan")
    const next = { ...project, version: project.version + 1, groups: [...project.groups, derived] }
    const dialog = await openTool("Process", /merge marked groups/i)
    expect(within(dialog).getByRole("combobox", { name: /signal to combine/i })).toHaveValue("")
    expect(within(dialog).getAllByRole("spinbutton").map(input => (input as HTMLInputElement).value)).toEqual(["1", "1"])
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "merge", group_ids: ["sample", "oxide"],
      options: { weights: [1, 1] },
    })
    expect(plotProps().active).toEqual(derived)
  })

  it("sends the LCF target first and only the explicitly selected standards", async () => {
    const project = await openSaved()
    selectGroup("Sample scan") // The target is not first in the group list.
    const dialog = await openTool("Analysis", /linear combination fitting/i)
    expect(within(dialog).queryByRole("checkbox", { name: "Sample scan" })).not.toBeInTheDocument()
    expect(within(dialog).getByRole("checkbox", { name: "Oxide standard" })).toBeChecked()
    expect(within(dialog).getByRole("checkbox", { name: "Foil scan" })).not.toBeChecked()
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Foil scan" }))
    fireEvent.change(within(dialog).getByRole("combobox", { name: /fit signal/i }), { target: { value: "flat" } })
    editNumber(/^Range minimum/, 8965, dialog)
    editNumber(/^Range maximum/, 9000, dialog)
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /non-negative weights/i }))
    const analysis = fitResult(project)
    api.mockResolvedValueOnce(analysis)
    fireEvent.click(within(dialog).getByRole("button", { name: /run analysis/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/analyze`, expect.objectContaining({
      version: project.version, action: "lcf", group_ids: ["sample", "oxide", "foil"],
      options: { array: "flat", xmin: 8965, xmax: 9000, nonnegative: false, sum_to_one: true },
    }))
    expect(plotProps().analysis).toEqual(analysis)
    expect(plotProps().analysisVisible).toBe(true)
    expect(plotProps().active).toEqual(project.groups[1])
    expect(screen.getByRole("checkbox", { name: "Mark Foil scan" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Mark Unused reference" })).not.toBeChecked()
  })

  it("uses the PCA dialog selection independently of project marks", async () => {
    const project = await openSaved()
    const dialog = await openTool("Analysis", /principal component analysis/i)
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Foil scan" }))
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Unused reference" }))
    const analysis = fitResult(project, {
      kind: "pca", group_ids: ["sample", "oxide", "unused"],
      result: { explained_variance_ratio: [0.8, 0.2] },
    })
    api.mockResolvedValueOnce(analysis)
    fireEvent.click(within(dialog).getByRole("button", { name: /run analysis/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/analyze`, expect.objectContaining({
      version: project.version, action: "pca", group_ids: ["sample", "oxide", "unused"],
    }))
    expect(plotProps().analysis).toEqual(analysis)
    expect(screen.getByRole("checkbox", { name: "Mark Unused reference" })).not.toBeChecked()
  })

  it("adds, edits and removes peaks, then submits the remaining model for only the current group", async () => {
    const project = await openSaved()
    const dialog = await openTool("Analysis", /xanes peak fitting/i)
    expect(within(dialog).getByRole("button", { name: /remove peak 1/i })).toBeDisabled()
    editNumber(/^Peak 1 center/i, 8982, dialog)
    fireEvent.click(within(dialog).getByRole("button", { name: /add peak/i }))
    editNumber(/^Peak 2 center/i, 8991, dialog)
    editNumber(/^Peak 2 sigma/i, 2.2, dialog)
    editNumber(/^Peak 2 amplitude/i, 0.3, dialog)
    fireEvent.change(within(dialog).getByRole("combobox", { name: /peak 2 shape/i }), { target: { value: "lorentzian" } })
    fireEvent.click(within(dialog).getByRole("button", { name: /remove peak 1/i }))
    expect(within(dialog).getByRole("spinbutton", { name: /^Peak 1 center/i })).toHaveValue(8991)
    expect(within(dialog).queryByRole("spinbutton", { name: /^Peak 2 center/i })).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole("button", { name: /add peak/i }))
    editNumber(/^Peak 2 center/i, 9000, dialog)
    editNumber(/^Peak 2 sigma/i, 1.5, dialog)
    editNumber(/^Peak 2 amplitude/i, 0.8, dialog)
    fireEvent.change(within(dialog).getByRole("combobox", { name: /peak 2 shape/i }), { target: { value: "voigt" } })
    const peaks = [
      { center: 8991, sigma: 2.2, amplitude: 0.3, kind: "lorentzian" },
      { center: 9000, sigma: 1.5, amplitude: 0.8, kind: "voigt" },
    ]
    const analysis = fitResult(project, { kind: "peaks", group_ids: ["foil"], result: { parameters: peaks } })
    api.mockResolvedValueOnce(analysis)
    fireEvent.click(within(dialog).getByRole("button", { name: /run analysis/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/analyze`, expect.objectContaining({
      version: project.version, action: "peaks", group_ids: ["foil"],
      options: expect.objectContaining({ peaks }),
    }))
    expect(plotProps().analysis).toEqual(analysis)
  })

  it("retains the previous analysis and dialog inputs when a new fit fails", async () => {
    const project = await openSaved()
    selectGroup("Sample scan")
    let dialog = await openTool("Analysis", /linear combination fitting/i)
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Foil scan" }))
    const analysis = fitResult(project)
    api.mockResolvedValueOnce(analysis)
    fireEvent.click(within(dialog).getByRole("button", { name: /run analysis/i }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    dialog = await openTool("Analysis", /linear combination fitting/i)
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Foil scan" }))
    editNumber(/^Range minimum/, 8990, dialog)
    api.mockRejectedValueOnce(new Error("Fit range has too few overlapping points"))
    fireEvent.click(within(dialog).getByRole("button", { name: /run analysis/i }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Fit range has too few overlapping points")
    expect(dialog).toHaveAttribute("open")
    expect(within(dialog).getByRole("spinbutton", { name: /^Range minimum/ })).toHaveValue(8990)
    expect(within(dialog).getByRole("checkbox", { name: "Foil scan" })).toBeChecked()
    expect(within(dialog).getByRole("button", { name: /run analysis/i })).toBeEnabled()
    expect(plotProps().analysis).toEqual(analysis)
    expect(plotProps().analysisVisible).toBe(true)
    expect(plotProps().active).toEqual(project.groups[1])
    expect(plotProps().groups).toEqual(project.groups.filter(g => g.marked))
    expect(localStorage.getItem(storageKey)).toBe(project.id)
  })
})
