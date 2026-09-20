import "@testing-library/jest-dom/vitest"
import { StrictMode, useLayoutEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { athenaApi, type Analysis, type AthenaGroup, type AthenaProject, type Parameters, type E0Method } from "@/lib/athena"
import { ApiRequestError } from "@/lib/backend-client"
import type { AthenaSelectionUpdate } from "@/lib/athena-selection"
import type { InspectionResponse, ScanInspectionResponse } from "@/lib/contracts"
import { AthenaPlot } from "./athena-plot"
import { AthenaWavelet } from "./athena-wavelet"
import { ArtemisFittingPanel } from "./artemis-fitting"
import { AthenaProjectImport } from "./athena-project-import"
import { edgePolicyStorageKey } from "./athena-edge-policy"
import { AthenaWorkbench } from "./athena-workbench"
import { differenceOptions, differencePreview, differenceSaved } from "./athena-difference.fixtures"
import { mergeDefaults, mergePreview, mergeSaved } from "./athena-merge.fixtures"
import type { MergePreview } from "./athena-merge"

// Full workbench flows exercise many controls; leave time for jsdom style/accessibility
// calculation on shared CI hosts. Individual waitFor assertions stay bounded.
vi.setConfig({ testTimeout: 15000 })

vi.mock("@/lib/athena", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/athena")>(),
  athenaApi: vi.fn(),
}))
vi.mock("@/lib/athena-context", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/athena-context")>()
  const athena = await import("@/lib/athena")
  return {
    ...original,
    AthenaProvider: ({ children }: { children: React.ReactNode }) => children,
    useAthenaApi: () => athena.athenaApi,
    useAthenaTransport: () => athena.athenaTransport(),
  }
})
vi.mock("next/dynamic", () => ({ default: () => () => null }))
// Preferences use their own service boundary and have real-store/browser coverage.
// Keep the scientific API request assertions below independent of that service.
vi.mock('@/lib/athena-preferences', () => ({
  loadRebinDefaults: async () => ({ version: 0, grid: { emin: -30, emax: 50, pre: 10, xanes: .5, exafs: .05, width: 3 } }),
  saveRebinDefaults: async (value: { version: number; grid: unknown }) => ({ ...value, version: value.version + 1 }),
}))

// Observe the workbench's data handoff without loading Plotly or testing its internals.
vi.mock("./athena-plot", () => ({
  AthenaPlot: vi.fn(() => <div data-testid="athena-plot" />),
}))
// Wavelet requests and mode switching have dedicated panel tests.
vi.mock("./athena-wavelet", () => ({ AthenaWavelet: vi.fn(() => <div data-testid="athena-wavelet" />) }))
// Fitting interactions have dedicated tests; verify the current spectrum handoff here.
vi.mock("./artemis-fitting", () => ({
  ArtemisFittingPanel: vi.fn(() => <div data-testid="artemis-panel" />),
  ArtemisFitResultViewer: () => <div data-testid="artemis-results" />,
}))
vi.mock("./athena-difference-plot", () => ({ AthenaDifferencePlot: () => <div data-testid="difference-preview-plot" /> }))
// Live arithmetic and stale-response behavior have dedicated preview tests.
vi.mock("./athena-import-preview", () => ({ AthenaImportPreview: () => <div data-testid="column-preview" /> }))
// The standalone panel tests own preview/import interactions; verify its host contract here.
vi.mock("./athena-project-import", () => ({
  AthenaProjectImport: vi.fn(() => <div data-testid="project-import-panel" />),
}))

const api = vi.mocked(athenaApi)
const plot = vi.mocked(AthenaPlot)
const projectImport = vi.mocked(AthenaProjectImport)
const storageKey = "athena.project"
const integrationSession = { mode: "integration" as const, projectId: "integrated-project", capability: "browser-capability", allowedOperations: ["read_project"], expiresAt: "2099-01-01T00:00:00Z" }
const dialogDescriptors = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
}

describe("integration mode", () => {
  it("never opens the legacy project list or local project storage", async () => {
    localStorage.setItem(storageKey, "legacy-project")
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project" }) : Promise.reject(new Error(`unexpected ${path}`)))
    render(<AthenaWorkbench session={integrationSession} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    expect(api).toHaveBeenCalledWith("/projects/integrated-project")
    expect(api).toHaveBeenCalledTimes(1)
    expect(api).not.toHaveBeenCalledWith("/projects")
    expect(localStorage.getItem(storageKey)).toBe("legacy-project")
  })

  it("hides legacy project controls and shows return and selected import actions", async () => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project" }) : Promise.reject(new Error(`unexpected ${path}`)))
    render(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "export"], returnTo: "/projects/native" }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    expect(screen.queryByRole("button", { name: /open project/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    expect(screen.queryByRole("button", { name: /new project/i })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /return to dr\.xas/i })).toHaveAttribute("href", "/projects/native")
    expect(screen.getByRole("link", { name: /import 2 selected groups into dr\.xas/i })).toHaveAttribute("href", "/projects/native")
    expect(screen.getByRole("link", { name: /import 2 selected groups into dr\.xas/i })).not.toHaveAttribute("aria-disabled", "true")
  })

  it("allows a specific command action without requiring the generic command operation", async () => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project", groups: [group("foil", "Foil scan")] }) : Promise.reject(new Error(`unexpected ${path}`)))
    render(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "metadata"] }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    expect(screen.getByRole("checkbox", { name: "Mark Foil scan" })).toBeEnabled()
  })

  it("stores only bounded selected group revisions before returning for import", async () => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project", version: 7 }) : Promise.reject(new Error(`unexpected ${path}`)))
    render(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "export"], returnTo: "/projects/native" }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    const importLink = screen.getByRole("link", { name: /import 2 selected groups into dr\.xas/i })
    importLink.addEventListener("click", event => event.preventDefault(), { once: true })
    fireEvent.click(importLink)
    expect(JSON.parse(sessionStorage.getItem("xraylarch.integration.return-selection.v1")!)).toEqual({
      projectId: "integrated-project", projectVersion: 7, sessionExpiresAt: integrationSession.expiresAt,
      groups: [{ id: "sample", version: 7 }, { id: "oxide", version: 7 }],
    })
  })

  it("names each selected group's own revision, not the project's", async () => {
    // A group's revision only moves when that group changes, and the export
    // reservation resolves a selection against the exact revision it names.
    // Claiming the project version for a group that did not change in it is
    // rejected as a changed selection, which breaks the whole round trip.
    api.mockImplementation(async path => path === "/projects/integrated-project"
      ? projectFixture({ id: "integrated-project", version: 9, group_versions: { foil: 2, sample: 3, oxide: 9, unused: 4 } })
      : Promise.reject(new Error(`unexpected ${path}`)))
    render(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "export"], returnTo: "/projects/native" }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    const importLink = screen.getByRole("link", { name: /import 2 selected groups into dr\.xas/i })
    importLink.addEventListener("click", event => event.preventDefault(), { once: true })
    fireEvent.click(importLink)
    expect(JSON.parse(sessionStorage.getItem("xraylarch.integration.return-selection.v1")!).groups)
      .toEqual([{ id: "sample", version: 3 }, { id: "oxide", version: 9 }])
  })

  it.each([
    ["deconvolve", /deconvolve data/i],
    ["self_absorption", /fluorescence self-absorption/i],
  ])("uses the submitted %s command action as its capability", async (operation, label) => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project" }) : Promise.reject(new Error(`unexpected ${path}`)))
    render(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", operation] }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    fireEvent.click(screen.getByRole("button", { name: "Process" }))
    expect(screen.getByRole("button", { name: label })).toBeEnabled()
  })

  it("requires preview and mutation operations for preview-backed workflows", async () => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project" }) : Promise.reject(new Error(`unexpected ${path}`)))
    const { rerender } = render(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "smooth"] }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    fireEvent.click(screen.getByRole("button", { name: "Process" }))
    expect(screen.getByRole("button", { name: /smooth data/i })).toBeDisabled()

    rerender(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "preview", "smooth"] }} />)
    expect(screen.getByRole("button", { name: /smooth data/i })).toBeEnabled()
  })

  it("offers only the granted action in the shared parameter dialog", async () => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project" }) : Promise.reject(new Error(`unexpected ${path}`)))
    render(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "copy_parameters"] }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    fireEvent.click(screen.getByRole("button", { name: /copy \/ reset parameters/i }))
    const dialog = screen.getByRole("dialog", { name: /copy \/ reset parameters/i })
    expect(within(dialog).getByRole("button", { name: /copy parameters/i })).toBeEnabled()
    expect(within(dialog).getByRole("button", { name: /reset to defaults/i })).toBeDisabled()
  })

  it("requires read and mutation operations for XDI metadata", async () => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project" }) : Promise.reject(new Error(`unexpected ${path}`)))
    const { rerender } = render(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "xdi_comments"] }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    fireEvent.click(screen.getByRole("button", { name: "Group" }))
    expect(screen.getByRole("button", { name: /file metadata/i })).toBeDisabled()

    rerender(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "read_group", "xdi_comments"] }} />)
    expect(screen.getByRole("button", { name: /file metadata/i })).toBeEnabled()
  })

  it("gates mutation controls and selected import when operations are not granted", async () => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project", groups: [group("foil", "Foil scan")] }) : Promise.reject(new Error(`unexpected ${path}`)))
    render(<AthenaWorkbench session={{ ...integrationSession, returnTo: "/projects/native" }} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    expect(screen.queryByRole("button", { name: /^Import data$/i })).not.toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Mark Foil scan" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /edit absorber and edge/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /plot shortcuts/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /edit group information/i })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(screen.getByRole("button", { name: /excel report on all groups/i })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Plot" }))
    expect(screen.getByRole("button", { name: /diagnostic plots/i })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Energy" }))
    expect(screen.getByRole("button", { name: /select e₀/i })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Group" }))
    expect(screen.getByRole("button", { name: /mark \/ freeze groups/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /change data type/i })).toBeDisabled()
    expect(screen.getAllByRole("button", { name: /edit absorber and edge/i }).every(button => button.hasAttribute("disabled"))).toBe(true)
    expect(screen.getByRole("button", { name: /file metadata/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /duplicate current group/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /remove current group/i })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    expect(screen.getByRole("button", { name: /export column data/i })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Process" }))
    expect(screen.getByRole("button", { name: /smooth data/i })).toBeDisabled()
    expect(screen.getByRole("link", { name: /import 0 selected groups into dr\.xas/i })).toHaveAttribute("aria-disabled", "true")
  })

  it("gates reordering, bulk marking, exports, and fitting on the controls master added", async () => {
    api.mockImplementation(async path => path === "/projects/integrated-project" ? projectFixture({ id: "integrated-project", groups: [group("foil", "Foil scan"), group("oxide", "Oxide scan")] }) : Promise.reject(new Error(`unexpected ${path}`)))
    const { rerender } = render(<AthenaWorkbench session={integrationSession} />)
    await screen.findByText("SPECTRUM WORKSPACE")
    expect(screen.getByRole("button", { name: "Reorder Foil scan" })).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: "Mark all groups" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "Viewer k-weight" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: /^Save project$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "CSV" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: /EXAFS fitting/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "File" }))
    expect(screen.queryByRole("button", { name: /save athena project/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /save marked project/i })).not.toBeInTheDocument()

    rerender(<AthenaWorkbench session={{ ...integrationSession, allowedOperations: ["read_project", "reorder", "metadata", "plot", "export"] }} />)
    expect(screen.getByRole("button", { name: "Reorder Foil scan" })).toBeEnabled()
    expect(screen.getByRole("checkbox", { name: "Mark all groups" })).toBeEnabled()
    expect(screen.getByRole("combobox", { name: "Viewer k-weight" })).toBeEnabled()
    expect(screen.getByRole("button", { name: /^Save project$/ })).toBeEnabled()
    expect(screen.getByRole("button", { name: "CSV" })).toBeEnabled()
    expect(screen.queryByRole("tab", { name: /EXAFS fitting/i })).not.toBeInTheDocument()
  })
})

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
  vi.useRealTimers()
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
  await waitFor(() => expect(screen.getByRole("button", { name: "Import data" })).toBeEnabled())
  return project
}

async function waitForWorkbenchIdle() {
  await waitFor(() => expect(screen.getByText("Saved locally", { exact: true })).toBeVisible())
}

async function waitForCommand(projectId: string, body: Record<string, unknown>) {
  await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${projectId}/command`, body), { timeout: 3500 })
  await waitForWorkbenchIdle()
}

async function finishParameterDrafts(project: AthenaProject, steps: {
  groupId: string
  options: Partial<Parameters>
  saved?: Partial<Parameters>
}[]) {
  let accepted = project
  for (const step of steps) {
    const source = accepted.groups.find(group => group.id === step.groupId)!
    accepted = nextProject(accepted, {
      [step.groupId]: { parameters: { ...source.parameters, ...(step.saved ?? step.options) } },
    })
    api.mockResolvedValueOnce(accepted)
  }
  const last = steps.at(-1)!
  await waitForCommand(project.id, {
    version: accepted.version - 1,
    action: "parameters",
    group_ids: [last.groupId],
    options: last.options,
  })
  return accepted
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

function importedBothModes(project: AthenaProject, name: string): AthenaProject {
  return { ...project, version: project.version + 1, groups: [...project.groups,
    ...(['transmission', 'fluorescence'] as const).map(mode => ({
      ...group(`${name}-${mode}`, `${name} · ${mode === 'transmission' ? 'Transmission' : 'Fluorescence'}`, true),
      source: { filename: name, mapping: { mode } },
    })),
  ] }
}

async function chooseImportFiles(inspections: InspectionResponse[], shareParameters: boolean | null = true) {
  api.mockResolvedValueOnce(inspections[0])
  fireEvent.click(screen.getByRole("button", { name: /^Import data$/i }))
  const dialog = await screen.findByRole("dialog", { name: /import spectra/i })
  const files = inspections.map(i => new File(["Energy It I0 If1 If2 Ir\n8.97 2 3 4 5 1"], i.display_name))
  fireEvent.change(within(dialog).getByLabelText("Choose data files"), { target: { files } })
  await within(dialog).findByRole("combobox", { name: "Measurement" })
  if (inspections.length > 1 && shareParameters !== null) {
    fireEvent.click(within(dialog).getByRole("radio", { name: shareParameters ? "Yes, use the same parameters" : "No, review each file" }))
  }
  if (shareParameters !== null || inspections.length === 1) {
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Import (spectrum|\d+ files)$/i })).toBeEnabled())
  }
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

function chooseBothModesMapping(dialog: HTMLElement) {
  const view = within(dialog)
  fireEvent.change(view.getByRole('combobox', { name: 'Measurement' }), { target: { value: 'both' } })
  fireEvent.change(view.getByRole('combobox', { name: 'Energy units' }), { target: { value: 'keV' } })
  fireEvent.click(view.getByRole('button', { name: 'Clear numerator' }))
  fireEvent.click(view.getByRole('checkbox', { name: 'Numerator I0' }))
  fireEvent.click(view.getByRole('button', { name: 'Clear denominator' }))
  fireEvent.click(view.getByRole('checkbox', { name: 'Denominator It' }))
  fireEvent.change(view.getByRole('spinbutton', { name: 'Multiplicative constant' }), { target: { value: '1.25' } })
  fireEvent.click(view.getByRole('button', { name: 'Clear fluorescence numerator' }))
  fireEvent.click(view.getByRole('checkbox', { name: 'Fluorescence numerator If1' }))
  fireEvent.click(view.getByRole('checkbox', { name: 'Fluorescence numerator If2' }))
  fireEvent.click(view.getByRole('button', { name: 'Clear fluorescence denominator' }))
  fireEvent.click(view.getByRole('checkbox', { name: 'Fluorescence denominator I0' }))
  fireEvent.click(view.getByRole('checkbox', { name: 'Invert fluorescence signal' }))
  fireEvent.change(view.getByRole('spinbutton', { name: 'Fluorescence multiplicative constant' }), { target: { value: '.75' } })
}

const bothModesMapping = {
  mode: 'transmission', energy_column: 'col_0', units: 'keV',
  numerator: ['col_2'], denominator: 'col_1', signal_multiplier: 1.25,
  additional_fluorescence: { numerator: ['col_3', 'col_4'], denominator: 'col_2', signal_multiplier: .75, invert: true },
}

const fluorescenceMapping = {
  rebin: null,
  rebin_grid: { emin: -30, emax: 50, pre: 10, xanes: .5, exafs: .05, width: 3 },
  preprocessing: { mark: false, standard_id: null, copy_parameters: false, align: false },
  edge_policy: null,
  energy_column: "col_0", numerator: ["col_3", "col_4"], denominator: "col_2",
  mode: "fluorescence", units: "keV", data_type: "xanes",
  reference_numerator: "col_1", reference_denominator: "col_5", sort: true,
}

function importCalls() {
  return api.mock.calls.filter(([path]) => path.endsWith("/import"))
}

function submitImport(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: /^Import (spectrum|both modes|\d+ files)$/i }))
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

describe("AthenaWorkbench EXAFS fitting", () => {
  it("accepts saved CIF revisions only for the current project without changing the active spectrum", async () => {
    const project = await openSaved()
    fireEvent.click(screen.getByRole("tab", { name: "EXAFS fitting" }))
    selectGroup("Sample scan")
    const saved = vi.mocked(ArtemisFittingPanel).mock.calls.at(-1)![0].onProjectChange!
    act(() => saved({ ...project, version: project.version + 1 }))
    expect(vi.mocked(ArtemisFittingPanel).mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: project.id, version: project.version + 1, group: { id: "sample" },
    })
    act(() => saved(project))
    act(() => saved({ ...project, id: "another-project", version: project.version + 2 }))
    expect(vi.mocked(ArtemisFittingPanel).mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: project.id, version: project.version + 1, group: { id: "sample" },
    })
  })

  it("adds a middle-panel workflow and follows the current spectrum without a project mutation", async () => {
    const project = await openSaved()
    const initialCalls = api.mock.calls.length
    const tab = screen.getByRole("tab", { name: "EXAFS fitting" })
    fireEvent.click(tab)
    expect(screen.getByRole("tabpanel", { name: "EXAFS fitting" })).toContainElement(screen.getByTestId("artemis-panel"))
    expect(screen.getByTestId("artemis-results")).toBeVisible()
    expect(screen.queryByRole("spinbutton", { name: "Rbkg" })).toBeNull()
    expect(vi.mocked(ArtemisFittingPanel).mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: project.id, version: project.version, group: { id: "foil" }, pending: false,
    })
    selectGroup("Sample scan")
    expect(vi.mocked(ArtemisFittingPanel).mock.calls.at(-1)?.[0].group?.id).toBe("sample")
    fireEvent.click(screen.getByRole("tab", { name: "Processing" }))
    expect(screen.getByRole("heading", { name: "Processing parameters" })).toBeVisible()
    expect(screen.queryByTestId("artemis-results")).toBeNull()
    expect(api.mock.calls.length).toBe(initialCalls)
  })
})

describe("AthenaWorkbench branding", () => {
  it("identifies Larch-Web and links its Xraylarch and Demeter credits", async () => {
    await openSaved()

    expect(screen.getByRole("heading", { level: 1, name: "Larch-Web" })).toBeVisible()
    const xraylarch = screen.getByRole("link", { name: "Xraylarch" })
    const demeter = screen.getByRole("link", { name: "Demeter" })
    expect(xraylarch).toHaveAttribute("href", "https://xraypy.github.io/xraylarch/")
    expect(demeter).toHaveAttribute("href", "https://bruceravel.github.io/demeter/")
    expect(xraylarch).toHaveAttribute("target", "_blank")
    expect(demeter).toHaveAttribute("target", "_blank")
    expect(xraylarch.closest("p")).toHaveTextContent("powered by Xraylarch, inspired by Demeter, and developed by the Dr. XAS team.")
  })
})

describe("AthenaWorkbench menu command search", () => {
  async function openMenuSearch(project = projectFixture()) {
    await openSaved(project)
    const navigation = screen.getByRole("navigation", { name: /main menu/i })
    const trigger = within(navigation).getByRole("button", { name: "Help" })
    fireEvent.click(trigger)
    const dialog = screen.getByRole("dialog", { name: "Search menu commands" })
    const searchbox = within(dialog).getByRole("searchbox", { name: "Search menu commands" })
    await waitFor(() => expect(searchbox).toHaveFocus())
    return { trigger, dialog, searchbox }
  }

  it("opens from Help, focuses search, and shows menu paths for keyword matches", async () => {
    const { dialog, searchbox } = await openMenuSearch()
    expect(within(dialog).getByText("Type a keyword to find a menu command.")).toBeVisible()

    fireEvent.change(searchbox, { target: { value: "smooth" } })

    expect(within(dialog).getByRole("button", { name: "Process › Smooth data" })).toBeEnabled()
    expect(within(dialog).queryByText("Type a keyword to find a menu command.")).not.toBeInTheDocument()
  })

  it("moves from search to a result and opens the command with the keyboard", async () => {
    const { dialog, searchbox } = await openMenuSearch()
    fireEvent.change(searchbox, { target: { value: "journal" } })
    const result = within(dialog).getByRole("button", { name: "File › Project journal" })

    fireEvent.keyDown(searchbox, { key: "ArrowDown" })
    expect(result).toHaveFocus()
    fireEvent.keyDown(result, { key: "Enter" })
    // jsdom does not synthesize the native button click that browsers dispatch for Enter.
    fireEvent.click(result)

    expect(await screen.findByRole("dialog", { name: "Project journal" })).toBeVisible()
  })

  it("runs the same Import data action from a search result", async () => {
    const { dialog, searchbox } = await openMenuSearch()
    fireEvent.change(searchbox, { target: { value: "import" } })

    fireEvent.click(within(dialog).getByRole("button", { name: "File › Import data…" }))

    expect(screen.queryByRole("dialog", { name: "Search menu commands" })).not.toBeInTheDocument()
    expect(await screen.findByRole("dialog", { name: "Import spectra" })).toBeVisible()
  })

  it("keeps unavailable commands visible and prevents their execution", async () => {
    const { dialog, searchbox } = await openMenuSearch(projectFixture({ groups: [] }))
    fireEvent.change(searchbox, { target: { value: "smooth" } })
    const result = within(dialog).getByRole("button", { name: "Process › Smooth data" })

    expect(result).toBeDisabled()
    fireEvent.click(result)

    expect(screen.getByRole("dialog", { name: "Search menu commands" })).toBeVisible()
    expect(screen.queryByRole("dialog", { name: "Smooth data" })).not.toBeInTheDocument()
    expect(api).toHaveBeenCalledOnce()
  })

  it("disables guarded commands while an automatic parameter update is pending", async () => {
    const project = await openSaved()
    vi.useFakeTimers()
    editNumber(/^Rbkg/, 2.2)
    const navigation = screen.getByRole("navigation", { name: /main menu/i })
    fireEvent.click(within(navigation).getByRole("button", { name: "Help" }))
    const dialog = screen.getByRole("dialog", { name: "Search menu commands" })
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search menu commands" }), { target: { value: "smooth" } })
    const result = within(dialog).getByRole("button", { name: "Process › Smooth data" })

    expect(result).toBeDisabled()
    fireEvent.click(result)
    expect(screen.queryByRole("dialog", { name: "Smooth data" })).not.toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Search menu commands" })).toBeVisible()
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])
  })

  it("closes on Escape and restores focus to Help", async () => {
    const { trigger, searchbox } = await openMenuSearch()

    fireEvent.keyDown(searchbox, { key: "Escape" })

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search menu commands" })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it("announces an empty result set", async () => {
    const { dialog, searchbox } = await openMenuSearch()

    fireEvent.change(searchbox, { target: { value: "not-a-real-command" } })

    expect(within(dialog).getByText("No menu commands found.")).toBeVisible()
  })
})

describe("AthenaWorkbench measurement mode tags", () => {
  it("labels imported transmission and fluorescence groups without guessing direct signals", async () => {
    const transmission = group("transmission", "Transmission scan")
    transmission.source = { mapping: { mode: "transmission" } }
    const fluorescence = group("fluorescence", "Fluorescence scan")
    fluorescence.source = { mapping: { mode: "fluorescence" } }
    const direct = group("direct", "Direct signal")
    direct.source = { mapping: { mode: "mu" } }
    await openSaved(projectFixture({ groups: [transmission, fluorescence, direct] }))

    const transRow = screen.getByRole("button", { name: /^Transmission scan/ })
    expect(within(transRow).getByText("trans")).toHaveAttribute("title", "Transmission")
    const fluoRow = screen.getByRole("button", { name: /^Fluorescence scan/ })
    expect(within(fluoRow).getByText("fluo")).toHaveAttribute("title", "Fluorescence")
    expect(within(screen.getByRole("button", { name: /^Direct signal/ })).queryByText(/^(trans|fluo)$/)).toBeNull()
  })
})

describe("AthenaWorkbench data group reordering", () => {
  function reorderedProject(project: AthenaProject, ids: string[]) {
    const groups = new Map(project.groups.map(group => [group.id, group]))
    return { ...project, version: project.version + 1, groups: ids.map(id => groups.get(id)!) }
  }
  function groupPointer(type: string, clientY: number, pointerId = 7) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      button: { value: 0 }, clientY: { value: clientY }, isPrimary: { value: true }, pointerId: { value: pointerId },
    })
    return event
  }

  it("replaces the toolbar arrows with row grips and drags filtered groups without moving hidden slots", async () => {
    const project = await openSaved()
    expect(screen.queryByRole("button", { name: "Move group up" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Move group down" })).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /^Reorder / })).toHaveLength(project.groups.length)

    fireEvent.change(screen.getByRole("textbox", { name: "Search groups" }), { target: { value: "scan" } })
    const rows = screen.getAllByRole("listitem")
    expect(rows.map(row => row.dataset.groupId)).toEqual(["foil", "sample"])
    rows.forEach((row, index) => vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: index * 60, bottom: (index + 1) * 60, height: 60, left: 0, right: 220, width: 220, x: 0, y: index * 60, toJSON: () => ({}),
    }))

    const handle = screen.getByRole("button", { name: "Reorder Foil scan" })
    fireEvent(handle, groupPointer("pointerdown", 20))
    fireEvent(handle, groupPointer("pointermove", 110))
    expect(rows[0]).toHaveAttribute("data-dragging", "true")
    expect(rows[1]).toHaveAttribute("data-drop-position", "after")

    const ids = ["sample", "foil", "oxide", "unused"]
    api.mockResolvedValueOnce(reorderedProject(project, ids))
    fireEvent(handle, groupPointer("pointerup", 110))
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "reorder", group_ids: [], options: { ids },
    }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Reorder Foil scan" })).toBeEnabled())

    expect(Array.from(document.querySelectorAll<HTMLElement>(".ath-group")).map(row => row.dataset.groupId)).toEqual(["sample", "foil"])
    expect(document.querySelector(".ath-group[data-dragging], .ath-group[data-drop-position]")).toBeNull()
    expect(screen.getByText("Moved Foil scan to position 2 of 2 in filtered results.")).toHaveAttribute("aria-live", "polite")
    expect(plotProps().active?.id).toBe("foil")
  })

  it("supports precise keyboard reordering, boundary no-ops, and an accessible position announcement", async () => {
    const project = await openSaved()
    const handle = screen.getByRole("button", { name: "Reorder Foil scan" })
    expect(handle).toHaveAttribute("aria-keyshortcuts", "ArrowUp ArrowDown")
    expect(handle).toHaveAccessibleDescription(/Use the Up and Down arrow keys for precise movement/)
    handle.focus()
    fireEvent.keyDown(handle, { key: "ArrowUp" })
    expect(api).toHaveBeenCalledOnce()

    const ids = ["sample", "foil", "oxide", "unused"]
    const response = deferred<AthenaProject>()
    api.mockReturnValueOnce(response.promise)
    fireEvent.keyDown(handle, { key: "ArrowDown" })
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "reorder", group_ids: [], options: { ids },
    }))
    expect(screen.getAllByRole("button", { name: /^Reorder / }).every(button => button.hasAttribute("disabled"))).toBe(true)
    expect(screen.getByText("Reordering Foil scan.")).toHaveAttribute("aria-live", "polite")
    expect(screen.queryByText("Moved Foil scan to position 2 of 4.")).not.toBeInTheDocument()

    await act(async () => response.resolve(reorderedProject(project, ids)))
    await waitFor(() => expect(screen.getByRole("button", { name: "Reorder Foil scan" })).toBeEnabled())
    expect(screen.getByText("Moved Foil scan to position 2 of 4.")).toHaveAttribute("aria-live", "polite")
    expect(screen.getByRole("button", { name: "Reorder Foil scan" })).toHaveFocus()
  })

  it("announces a failed reorder without claiming that the spectrum moved", async () => {
    await openSaved()
    api.mockRejectedValueOnce(new Error("The project version changed."))
    const handle = screen.getByRole("button", { name: "Reorder Foil scan" })
    handle.focus()
    fireEvent.keyDown(handle, { key: "ArrowDown" })

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The project version changed."))
    expect(screen.getByText("Could not move Foil scan. Position unchanged.")).toHaveAttribute("aria-live", "polite")
    expect(screen.queryByText(/^Moved Foil scan/)).not.toBeInTheDocument()
    expect(handle).toHaveFocus()
  })

  it("keeps a user's new focus target when a pending keyboard reorder finishes", async () => {
    const project = await openSaved()
    const response = deferred<AthenaProject>()
    api.mockReturnValueOnce(response.promise)
    const handle = screen.getByRole("button", { name: "Reorder Foil scan" })
    handle.focus()
    fireEvent.keyDown(handle, { key: "ArrowDown" })
    const searchbox = screen.getByRole("textbox", { name: "Search groups" })
    searchbox.focus()

    await act(async () => response.resolve(reorderedProject(project, ["sample", "foil", "oxide", "unused"])))
    await waitFor(() => expect(screen.getByRole("button", { name: "Reorder Foil scan" })).toBeEnabled())
    expect(searchbox).toHaveFocus()
  })

  it("auto-scrolls a long group list while pointer dragging near its edge", async () => {
    await openSaved()
    const list = screen.getByRole("list")
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 500 },
    })
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 120, height: 120, left: 0, right: 220, width: 220, x: 0, y: 0, toJSON: () => ({}),
    })
    const handle = screen.getByRole("button", { name: "Reorder Foil scan" })
    fireEvent(handle, groupPointer("pointerdown", 20, 8))
    fireEvent(handle, groupPointer("pointermove", 115, 8))
    expect(list.scrollTop).toBeGreaterThan(0)
    fireEvent(handle, groupPointer("pointercancel", 115, 8))
  })
})

describe("AthenaWorkbench native context actions", () => {
  function groupContext() {
    fireEvent.click(screen.getByRole('button', { name: 'Actions for current group' }))
    return screen.getByRole('menu', { name: 'Actions for Foil scan' })
  }

  function fieldContext(label: string) {
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${label}` }))
    return screen.getByRole('menu', { name: 'Actions for Foil scan' })
  }

  it('keeps the selected group when right-clicking another row and closes the menu when selection changes', async () => {
    await openSaved()
    const other = screen.getByRole('button', { name: /^Sample scan/ })
    fireEvent.contextMenu(other, { clientX: 40, clientY: 80 })
    const menu = screen.getByRole('menu', { name: 'Actions for Foil scan' })
    expect(within(menu).getByRole('menuitem', { name: 'Current group: Foil scan' })).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: 'Show the text of the current group’s data file' })).toBeDisabled()
    expect(plotProps().active?.id).toBe('foil')
    expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toHaveValue(1)
    expect(api).toHaveBeenCalledOnce()
    selectGroup('Sample scan')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(plotProps().active?.id).toBe('sample')
    expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toHaveValue(1.2)
  })

  it.each(['visible', 'Shift+F10', 'ContextMenu'])('opens group actions with %s without changing the saved selection or defaults', async method => {
    const project = await openSaved()
    const trigger = screen.getByRole('button', { name: 'Actions for current group' })
    trigger.focus()
    if (method === 'visible') fireEvent.click(trigger)
    else fireEvent.keyDown(trigger, { key: method === 'Shift+F10' ? 'F10' : 'ContextMenu', shiftKey: method === 'Shift+F10' })
    expect(screen.getByRole('menuitem', { name: 'Rename current group…' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(trigger).toHaveFocus(); expect(screen.queryByRole('menu')).toBeNull()
    expect(plotProps().active?.parameters).toEqual(project.groups[0].parameters)
    expect(api).toHaveBeenCalledOnce()
  })

  it('renames the current group with an explicit label after right-clicking a different row', async () => {
    const project = await openSaved()
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Sample scan/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename current group…' }))
    const dialog = screen.getByRole('dialog', { name: 'Rename current group' })
    expect(within(dialog).getByRole('textbox', { name: 'New group label' })).toHaveValue('Foil scan')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New group label' }), { target: { value: 'Reviewed foil' } })
    api.mockResolvedValueOnce(nextProject(project, { foil: { label: 'Reviewed foil' } }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename group' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: 'metadata', group_ids: ['foil'], options: { label: 'Reviewed foil' },
    })
    expect(plotProps().active?.label).toBe('Reviewed foil')
  })

  it.each([
    ['Copy current group', 'duplicate', ['foil']],
    ['Remove current group', 'delete', ['foil']],
    ['Remove marked groups', 'delete', ['sample', 'oxide']],
  ] as const)('sends the intended IDs for %s even if a different row was right-clicked', async (label, action, ids) => {
    const project = await openSaved()
    api.mockResolvedValueOnce(nextProject(project, {}))
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Unused reference/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    await waitForWorkbenchIdle()
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action, group_ids: [...ids], options: {},
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('copies native ALL to hidden marked groups, excludes the source, and preserves frozen skipped values', async () => {
    const initial = projectFixture()
    initial.groups[0].marked = true
    const project = await openSaved(initial)
    selectGroup('Oxide standard'); editNumber(/^Rbkg/, 4)
    const oxideApplied = await finishParameterDrafts(project, [{ groupId: 'oxide', options: { rbkg: 4 } }])
    const frozen = nextProject(oxideApplied, { oxide: { frozen: true } })
    api.mockResolvedValueOnce(frozen)
    fireEvent.click(screen.getByRole('button', { name: 'Freeze group' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unfreeze group' })).toBeEnabled())
    selectGroup('Foil scan'); editNumber(/^Rbkg/, 2.5)
    const foilApplied = await finishParameterDrafts(frozen, [{ groupId: 'foil', options: { rbkg: 2.5 } }])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), { target: { value: 'Foil' } })
    expect(screen.queryByRole('button', { name: /^Sample scan/ })).toBeNull()
    const next = nextProject(foilApplied, { sample: { parameters: { ...parameters, rbkg: 2.5 } } })
    const warning = 'Native phase correction is retained as source metadata but is not applied by Athena Web.'
    next.last_operation = { action: 'context_parameters', skipped_group_ids: ['oxide'], warnings: [warning] }
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(groupContext()).getByRole('menuitem', { name: 'Set marked groups’ values to the current' }))
    await waitForWorkbenchIdle()
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: foilApplied.version, action: 'context_parameters', group_ids: ['sample', 'oxide'],
      options: { mode: 'copy', section: 'all', source_id: 'foil', values: { ...parameters, rbkg: 2.5 } },
    })
    expect(screen.getByRole('status')).toHaveTextContent('1 group skipped')
    expect(screen.getByRole('status')).toHaveTextContent(warning)
    expect(plotProps().active?.parameters.rbkg).toBe(2.5)
    expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toHaveValue(2.5)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), { target: { value: '' } })
    selectGroup('Sample scan'); expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toHaveValue(2.5)
    selectGroup('Oxide standard'); expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toHaveValue(4)
    expect(plotProps().active?.parameters.rbkg).toBe(4)
  })

  it.each([
    ['Pre-edge start', 'Pre-edge start', ['pre1', 'pre2']],
    ['Post-edge start', 'Post-edge start', ['norm1', 'norm2']],
    ['FT k min', 'FT k min', ['kmin', 'kmax']],
  ] as const)('copies both endpoints from the %s menu and resets just that range', async (control, label, keys) => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.6)
    const applied = await finishParameterDrafts(project, [{ groupId: 'foil', options: { rbkg: 2.6 } }])
    const next = nextProject(applied, {})
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(fieldContext(control)).getByRole('menuitem', { name: `Set marked groups to current ${label}` }))
    await waitForWorkbenchIdle()
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: applied.version, action: 'copy_parameters', group_ids: ['sample', 'oxide'],
      options: { parameters: [...keys], source_id: 'foil', values: { ...parameters, step: 1, rbkg: 2.6, background_standard_id: null } },
    })
    api.mockResolvedValueOnce(nextProject(next, {}))
    fireEvent.click(within(fieldContext(control)).getByRole('menuitem', { name: `Restore default ${label}` }))
    await waitForWorkbenchIdle()
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: next.version, action: 'reset_parameters', group_ids: ['foil'], options: { parameters: [...keys] },
    })
    expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toHaveValue(2.6)
    expect(plotProps().active?.parameters.rbkg).toBe(2.6)
  })

  it('copies displayed automatic numbers as explicit values without turning the source automatic recipe into overrides', async () => {
    const initial = projectFixture()
    initial.groups[0].parameters = { ...parameters, pre1: null, pre2: null, e0: null, nnorm: null }
    initial.groups[0].result!.effective = { e0: 8979.125, edge_step: 1.3, pre1: -145.5, pre2: -72.25, nnorm: 2 }
    const project = await openSaved(initial)
    expect(screen.getByRole('spinbutton', { name: 'Pre-edge start eV relative' })).toHaveValue(-145.5)
    api.mockResolvedValueOnce(nextProject(project, {}))
    fireEvent.click(within(fieldContext('Pre-edge start')).getByRole('menuitem', { name: 'Set marked groups to current Pre-edge start' }))
    await waitForWorkbenchIdle()
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: 'copy_parameters', group_ids: ['sample', 'oxide'], options: {
        parameters: ['pre1', 'pre2'], source_id: 'foil',
        values: { ...parameters, e0: 8979.125, step: 1.3, pre1: -145.5, pre2: -72.25, nnorm: 2, background_standard_id: null },
      },
    })
    expect(plotProps().active?.parameters).toMatchObject({ e0: null, pre1: null, pre2: null, nnorm: null })
    expect(screen.queryByRole('button', { name: 'Discard parameter changes' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Polynomial degree' })).toHaveValue('')
  })

  it('allows a frozen group as the copy source while disabling reset of its own values', async () => {
    const project = await openSaved()
    const frozen = nextProject(project, { foil: { frozen: true } })
    api.mockResolvedValueOnce(frozen)
    fireEvent.click(screen.getByRole('button', { name: 'Freeze group' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unfreeze group' })).toBeEnabled())
    const trigger = screen.getByRole('button', { name: 'Actions for Rbkg' })
    expect(trigger).toBeEnabled()
    expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toBeDisabled()
    fireEvent.keyDown(trigger, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menuitem', { name: 'Restore default Rbkg' })).toBeDisabled()
    const copy = screen.getByRole('menuitem', { name: 'Set marked groups to current Rbkg' })
    expect(copy).toBeEnabled()
    api.mockResolvedValueOnce(nextProject(frozen, {}))
    fireEvent.click(copy)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: frozen.version, action: 'copy_parameters', group_ids: ['sample', 'oxide'],
      options: { parameters: ['rbkg'], source_id: 'foil', values: { ...parameters, step: 1, background_standard_id: null } },
    })
    expect(plotProps().active?.frozen).toBe(true)
  })

  it('uses the E₀ shortcut method on the current saved group and keeps unrelated drafts', async () => {
    const project = await openSaved()
    editNumber(/^E₀/, 9100); editNumber(/^Rbkg/, 2.8)
    const applied = await finishParameterDrafts(project, [{ groupId: 'foil', options: { e0: 9100, rbkg: 2.8 } }])
    api.mockResolvedValueOnce(e0Response(applied, 'zero_crossing', { foil: 8982.25 }))
    fireEvent.click(within(fieldContext('E₀')).getByRole('menuitem', { name: 'Set E₀ to the second-derivative zero crossing' }))
    await waitForWorkbenchIdle()
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: applied.version, action: 'set_e0', group_ids: ['foil'], options: { method: 'zero_crossing' },
    })
    expect(screen.getByRole('spinbutton', { name: 'E₀ eV' })).toHaveValue(8982.25)
    expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toHaveValue(2.8)
    expect(plotProps().active?.parameters.rbkg).toBe(2.8)
  })

  it('opens source text as a read-only report for the current group', async () => {
    const initial = projectFixture()
    initial.groups[0].source.mapping = { upload_id: 'upload-foil' }
    const project = await openSaved(initial)
    const text = '# Original μ 铜 <script>data</script>\n8960 0.1\n8980 0.8\n'
    api.mockResolvedValueOnce({ filename: 'foil.xmu', text })
    fireEvent.click(within(groupContext()).getByRole('menuitem', { name: 'Show the text of the current group’s data file' }))
    const dialog = await screen.findByRole('dialog', { name: 'Original data file' })
    await waitFor(() => expect(within(dialog).getByLabelText('Original data file').textContent).toBe(text))
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/groups/foil/source-text`, undefined, undefined, expect.any(AbortSignal))
    expect(api).toHaveBeenCalledTimes(2)
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(plotProps().active?.parameters).toEqual(project.groups[0].parameters)
  })

  it('requests measurement uncertainties for all marked groups including hidden and frozen groups without saving', async () => {
    const initial = projectFixture(); initial.groups[2].frozen = true
    const project = await openSaved(initial)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), { target: { value: 'Foil' } })
    api.mockResolvedValueOnce({ version: project.version, kind: 'measurement_uncertainty', results: [
      { group_id: 'sample', label: 'Sample scan', epsilon_k: 0.001, epsilon_r: 0.002 },
      { group_id: 'oxide', label: 'Oxide standard', epsilon_k: 0.003, epsilon_r: 0.004 },
    ] })
    fireEvent.click(within(groupContext()).getByRole('menuitem', { name: 'Show measurement uncertainties · marked groups' }))
    const dialog = await screen.findByRole('dialog', { name: 'Measurement uncertainties' })
    expect(await within(dialog).findByRole('heading', { name: 'Oxide standard' })).toBeVisible()
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/context-report`, {
      version: project.version, group_ids: ['sample', 'oxide'], kind: 'measurement_uncertainty',
    }, undefined, expect.any(AbortSignal))
    expect(api).toHaveBeenCalledTimes(2)
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(plotProps().active?.parameters).toEqual(project.groups[0].parameters)
  })

  it('keeps number input editing menus and field accessible names independent of action triggers', async () => {
    await openSaved()
    const rbkg = screen.getByRole('spinbutton', { name: 'Rbkg Å' })
    expect(rbkg).toHaveAccessibleName('Rbkg Å')
    expect(fireEvent.contextMenu(rbkg)).toBe(true)
    fireEvent.keyDown(rbkg, { key: 'F10', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Polynomial degree' })).toHaveAccessibleName('Polynomial degree')
    expect(screen.getByRole('checkbox', { name: 'Flatten normalized data' })).toHaveAccessibleName('Flatten normalized data')
    expect(api).toHaveBeenCalledOnce()
  })

  it.each([
    ['Sample scan', 'Foil scan is the reference for Sample scan'],
    ['Foil scan', 'Foil scan is the reference for Sample scan'],
    ['Unused reference', 'Unused reference has no linked reference'],
  ])('identifies reference direction from %s without changing the saved project', async (label, message) => {
    const initial = projectFixture()
    initial.groups[1].reference_id = 'foil'
    const project = await openSaved(initial)
    selectGroup(label)
    const selected = project.groups.find(g => g.label === label)!
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Energy shift' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Identify this group’s reference' }))
    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(plotProps().active).toEqual(selected)
    expect(project.version).toBe(7)
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])
    expect(localStorage.getItem(storageKey)).toBe(project.id)
    expect(screen.queryByRole('button', { name: 'Discard parameter changes' })).toBeNull()
  })

  it('processes a pending edit before closing and reopens the updated saved project without deleting its groups', async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.7)
    const applied = await finishParameterDrafts(project, [{ groupId: 'foil', options: { rbkg: 2.7 } }])
    const empty = projectFixture({ id: 'new-empty-project', name: 'Untitled project', version: 0, groups: [], journal: '' })
    api.mockResolvedValueOnce(empty)
    fireEvent.click(within(groupContext()).getByRole('menuitem', { name: 'Close project' }))
    await screen.findByText('A place for every scan.')
    expect(api.mock.calls.slice(-1)).toEqual([['/projects', {}]])
    expect(localStorage.getItem(storageKey)).toBe(empty.id)
    expect(screen.queryByRole('button', { name: /^Foil scan/ })).toBeNull()
    api.mockResolvedValueOnce([{ id: applied.id, name: applied.name, count: applied.groups.length, updated: applied.updated }])
    fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open a project' })
    const previous = await within(dialog).findByRole('button', { name: /^Copper study/ })
    api.mockResolvedValueOnce(applied)
    fireEvent.click(previous)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(plotProps().active).toEqual(applied.groups[0])
    expect(screen.getByRole('spinbutton', { name: 'Rbkg Å' })).toHaveValue(2.7)
    expect(screen.queryByRole('button', { name: 'Discard parameter changes' })).toBeNull()
    expect(localStorage.getItem(storageKey)).toBe(applied.id)
    expect(api.mock.calls.filter(([path]) => path.endsWith('/command'))).toHaveLength(1)
  })

  it.each(['pointer on nested row text', 'keyboard on row'])('restores context focus to the invoked row after %s without selecting it', async method => {
    await openSaved()
    const row = screen.getByRole('button', { name: /^Sample scan/ })
    row.focus()
    if (method === 'pointer on nested row text') fireEvent.contextMenu(within(row).getByText('Sample scan'))
    else fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu', { name: 'Actions for Foil scan' })).toBeVisible()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(row).toHaveFocus()
    expect(plotProps().active?.id).toBe('foil')
    expect(api).toHaveBeenCalledOnce()
  })

  it('persists edited Importance and omits it from subsequent unrelated metadata saves', async () => {
    const project = await openSaved()
    fireEvent.click(screen.getByRole('button', { name: 'Edit group information' }))
    let dialog = screen.getByRole('dialog', { name: 'Group information' })
    editNumber(/^Importance$/, 3.5, dialog)
    const next = nextProject(project, { foil: { source: { ...project.groups[0].source, importance: 3.5 } } })
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save group' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: 'metadata', group_ids: ['foil'],
      options: { label: 'Foil scan', notes: '', multiplier: 1, offset: 0, reference_id: null, importance: 3.5 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit group information' }))
    dialog = screen.getByRole('dialog', { name: 'Group information' })
    expect(within(dialog).getByRole('spinbutton', { name: 'Importance' })).toHaveValue(3.5)
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Notes' }), { target: { value: 'Reviewed metadata' } })
    api.mockResolvedValueOnce(nextProject(next, { foil: { notes: 'Reviewed metadata' } }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save group' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: next.version, action: 'metadata', group_ids: ['foil'],
      options: { label: 'Foil scan', notes: 'Reviewed metadata', multiplier: 1, offset: 0, reference_id: null },
    })
    expect(plotProps().active?.source.importance).toBe(3.5)
  })

  it('keeps frozen Importance read-only while allowing unrelated group metadata to save', async () => {
    const initial = projectFixture(); initial.groups[0].source.importance = 2
    const project = await openSaved(initial)
    const frozen = nextProject(project, { foil: { frozen: true } })
    api.mockResolvedValueOnce(frozen)
    fireEvent.click(screen.getByRole('button', { name: 'Freeze group' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unfreeze group' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Edit group information' }))
    const dialog = screen.getByRole('dialog', { name: 'Group information' })
    expect(within(dialog).getByRole('spinbutton', { name: 'Importance' })).toBeDisabled()
    expect(within(dialog).getByRole('spinbutton', { name: 'Importance' })).toHaveValue(2)
    expect(within(dialog).getByRole('button', { name: 'Actions for Importance' })).toBeEnabled()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Notes' }), { target: { value: 'Frozen spectrum annotation' } })
    api.mockResolvedValueOnce(nextProject(frozen, { foil: { notes: 'Frozen spectrum annotation' } }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save group' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: frozen.version, action: 'metadata', group_ids: ['foil'],
      options: { label: 'Foil scan', notes: 'Frozen spectrum annotation', multiplier: 1, offset: 0, reference_id: null },
    })
    expect(plotProps().active?.source.importance).toBe(2)
    expect(plotProps().active?.frozen).toBe(true)
  })

  it('refreshes reset metadata fields from the server while retaining unrelated form drafts', async () => {
    const initial = projectFixture()
    initial.groups[0] = { ...initial.groups[0], multiplier: 3, offset: 2, source: { ...initial.groups[0].source, importance: 4 } }
    const project = await openSaved(initial)
    fireEvent.click(screen.getByRole('button', { name: 'Edit group information' }))
    const dialog = screen.getByRole('dialog', { name: 'Group information' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group label' }), { target: { value: 'Draft label' } })
    editNumber(/^Importance$/, 7, dialog); editNumber(/^Plot multiplier$/, 6, dialog); editNumber(/^Plot offset$/, 5, dialog)
    const resetPlot = nextProject(project, { foil: { multiplier: 1, offset: 0 } })
    api.mockResolvedValueOnce(resetPlot)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Actions for Plot parameters' }))
    fireEvent.click(within(dialog).getByRole('menuitem', { name: 'Restore default plot parameters' }))
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: 'Plot multiplier' })).toHaveValue(1))
    expect(within(dialog).getByRole('spinbutton', { name: 'Plot offset' })).toHaveValue(0)
    expect(within(dialog).getByRole('spinbutton', { name: 'Importance' })).toHaveValue(7)
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: 'context_parameters', group_ids: ['foil'], options: { mode: 'reset', section: 'plot' },
    })
    const resetImportance = nextProject(resetPlot, { foil: { source: { ...project.groups[0].source, importance: 1 } } })
    api.mockResolvedValueOnce(resetImportance)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Actions for Importance' }))
    fireEvent.click(within(dialog).getByRole('menuitem', { name: 'Restore default Importance' }))
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: 'Importance' })).toHaveValue(1))
    expect(within(dialog).getByRole('textbox', { name: 'Group label' })).toHaveValue('Draft label')
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: resetPlot.version, action: 'context_parameters', group_ids: ['foil'], options: { mode: 'reset', field: 'importance' },
    })
    api.mockResolvedValueOnce(nextProject(resetImportance, { foil: { label: 'Draft label' } }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save group' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: resetImportance.version, action: 'metadata', group_ids: ['foil'],
      options: { label: 'Draft label', notes: '', multiplier: 1, offset: 0, reference_id: null },
    })
  })

  it.each(['set to one', 'pixel ratio'])('refreshes current Importance after %s and retains other metadata drafts', async mode => {
    const initial = projectFixture()
    initial.groups[0].marked = true; initial.groups[2].frozen = true
    initial.groups[0].source = { ...initial.groups[0].source, importance: 4, xdi_metadata: { attributes: { bla: { pixel_ratio: 0.25 } } } }
    const project = await openSaved(initial)
    fireEvent.click(screen.getByRole('button', { name: 'Edit group information' }))
    const dialog = screen.getByRole('dialog', { name: 'Group information' })
    editNumber(/^Importance$/, 9, dialog)
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Notes' }), { target: { value: 'Keep this draft' } })
    const importance = mode === 'set to one' ? 1 : 0.25
    const next = nextProject(project, { foil: { source: { ...project.groups[0].source, importance } } })
    if (mode === 'pixel ratio') next.last_operation = { action: 'context_parameters', skipped_group_ids: ['oxide'] }
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Actions for Importance' }))
    fireEvent.click(within(dialog).getByRole('menuitem', { name: mode === 'set to one'
      ? 'Set Importance to 1 for all groups' : 'Set Importance for marked data to BLA pixel ratio' }))
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: 'Importance' })).toHaveValue(importance))
    expect(within(dialog).getByRole('textbox', { name: 'Notes' })).toHaveValue('Keep this draft')
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: mode === 'set to one' ? 'metadata' : 'context_parameters',
      group_ids: mode === 'set to one' ? ['foil', 'sample', 'unused'] : ['foil', 'sample', 'oxide'],
      options: mode === 'set to one' ? { importance: 1 } : { mode: 'pixel_ratio', field: 'importance' },
    })
  })
})

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

  it("saves current-group identity after pending recipes, preserving arrays, ties, and tab enforcement", async () => {
    sessionStorage.setItem(edgePolicyStorageKey, JSON.stringify(copperPolicy))
    const initial = projectFixture()
    initial.groups[0].parameters.energy_shift = 3
    initial.groups[0].reference_id = "unused"
    initial.groups[0].source.edge_identity = { element: "Cu", edge: "K", origin: "native" }
    const project = await openSaved(initial)
    selectGroup("Sample scan"); editNumber(/^Rbkg/, 2.8)
    selectGroup("Foil scan"); editNumber(/^Rbkg/, 2.3); editNumber(/^E₀/, 8990); editNumber(/^Energy shift/, 9)
    const applied = await finishParameterDrafts(project, [
      { groupId: "sample", options: { rbkg: 2.8 } },
      { groupId: "foil", options: { e0: 8990, rbkg: 2.3, energy_shift: 9 } },
    ])
    const dialog = await openIdentityDialog()
    await chooseIronIdentity(dialog) // 7112 eV is intentionally outside the saved Cu scan.
    expect(api.mock.calls.at(-1)).toEqual(["/edges?element=Fe"])
    const next = identityResponse(applied, "foil")
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Save identity" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api.mock.calls.at(-1)).toEqual([`/projects/${project.id}/command`, {
      version: applied.version, action: "edge_identity", group_ids: ["foil"], options: { element: "Fe", edge: "K" },
    }])
    expect(identityBar()).toHaveTextContent("Fe K · selected")
    expect(screen.getByRole("status")).toHaveTextContent("Saving absorber and edge · complete")
    expect(plotProps().active?.parameters).toEqual(applied.groups[0].parameters)
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
    expect(api).toHaveBeenCalledTimes(5)
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
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { rbkg: 2.3 } }])
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
    api.mockResolvedValueOnce(identityResponse(applied, "foil"))
    fireEvent.click(view.getByRole("button", { name: "Save identity" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api.mock.calls[4]).toEqual(api.mock.calls[3])
    expect(api).toHaveBeenCalledTimes(5)
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
    await waitForWorkbenchIdle()
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
    await waitForWorkbenchIdle()
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

  it('reinspects the original file with current reader settings while retaining the batch policy and tail', async () => {
    sessionStorage.setItem(edgePolicyStorageKey, JSON.stringify(copperPolicy))
    const project = await openSaved()
    const first = inspectionFixture('first.dat'), tail = inspectionFixture('tail.dat')
    const { dialog, files } = await chooseImportFiles([first, tail])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop enforcing element and edge' }))
    const next = { ...first, upload_id: 'reinspected-upload' }
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reinspect selected file' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import 2 files' })).toBeEnabled())
    const call = api.mock.calls.at(-1)!
    expect(call[0]).toBe(`/projects/${project.id}/inspect`)
    expect((call[1] as FormData).get('file')).toBe(files[0])
    expect(importCalls()).toHaveLength(0)
    const afterFirst = importedProject(project, first.display_name)
    api.mockResolvedValueOnce(afterFirst).mockResolvedValueOnce(tail).mockResolvedValueOnce(importedProject(afterFirst, tail.display_name))
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls().map(([, body]) => (body as { upload_id: string }).upload_id)).toEqual([next.upload_id, tail.upload_id])
    expect(importCalls().map(([, body]) => (body as { edge_policy: unknown }).edge_policy)).toEqual([copperPolicy, copperPolicy])
  })

  it('removes the old import action if reinspection fails and retries the same file', async () => {
    await openSaved()
    const inspected = inspectionFixture('retry.dat')
    const { dialog, files } = await chooseImportFiles([inspected])
    api.mockRejectedValueOnce(new Error('Reader configuration needs correction'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reinspect selected file' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('configuration needs correction')
    expect(within(dialog).queryByRole('button', { name: 'Import spectrum' })).not.toBeInTheDocument()
    api.mockResolvedValueOnce({ ...inspected, upload_id: 'retry-upload' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry file inspection' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import spectrum' })).toBeEnabled())
    expect((api.mock.calls.at(-1)![1] as FormData).get('file')).toBe(files[0])
    expect(importCalls()).toHaveLength(0)
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
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { e0: 9100 } }])
    const dialog = await openE0Dialog()
    chooseE0Method(dialog, method)
    const expected = method === "fraction" ? { method, fraction: 0.5 } : method === "manual" ? { method, value: 8984.25 } : { method }
    if (method === "manual") {
      expect(within(dialog).getByRole("spinbutton", { name: /^Manual E₀/ })).toHaveValue(9100)
      editNumber(/^Manual E₀/, 8984.25, dialog)
    }
    const next = e0Response(applied, method, { foil: 8984.25 })
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: applied.version, action: "set_e0", group_ids: ["foil"], options: expected,
    })
    expect(report).toHaveTextContent("Foil scan: 8984.250 eV")
    if (method === "atomic") expect(report).toHaveTextContent("Cu K (8979 eV tabulated)")
    if (method === "fraction") expect(report).toHaveTextContent("3 iterations · converged")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8984.25)
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
    expect(plotProps().active?.parameters.energy_shift).toBe(applied.groups[0].parameters.energy_shift)
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

  it("processes queued recipes before E₀ selection and preserves non-targets and skipped consumers", async () => {
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
    const processed = await finishParameterDrafts(project, [
      { groupId: "foil", options: { e0: 9000, rbkg: 2.6, energy_shift: 9 } },
      { groupId: "sample", options: { e0: 9010, rbkg: 3.2 } },
      { groupId: "oxide", options: { e0: 9020 } },
    ])
    const dialog = await openE0Dialog()
    fireEvent.change(within(dialog).getByRole("combobox", { name: "E₀ targets" }), { target: { value: "marked" } })
    const next = e0Response(processed, "derivative", { sample: 8983 }, { oxide: "A group using it as a background standard is frozen." })
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: processed.version, action: "set_e0", group_ids: ["sample", "oxide"], options: { method: "derivative" },
    })
    expect(report).toHaveTextContent("Oxide standard: A group using it as a background standard is frozen.")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(9000)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.6)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(9)
    expect(plotProps().active?.parameters.energy_shift).toBe(9)
    selectGroup("Oxide standard")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(9020)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8983)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(3.2)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(-2)
    expect(api.mock.calls.slice(-4).map(([, body]) => body)).toEqual([
      { version: project.version, action: "parameters", group_ids: ["foil"], options: { e0: 9000, rbkg: 2.6, energy_shift: 9 } },
      { version: project.version + 1, action: "parameters", group_ids: ["sample"], options: { e0: 9010, rbkg: 3.2 } },
      { version: project.version + 2, action: "parameters", group_ids: ["oxide"], options: { e0: 9020 } },
      { version: processed.version, action: "set_e0", group_ids: ["sample", "oxide"], options: { method: "derivative" } },
    ])
    expect(plotProps().active).toEqual(next.groups[1])
  })

  it("locks input and dismissal while pending, leaves project/drafts intact on failure, and retries the same saved version", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.3)
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { rbkg: 2.3 } }])
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
    const next = e0Response(applied, "fraction", { foil: 8981 })
    next.last_operation!.e0_results![0] = { ...next.last_operation!.e0_results![0], iterations: 5, converged: false, warnings: ["Iteration limit reached; inspect this E₀."] }
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(api.mock.calls[3]).toEqual(api.mock.calls[2])
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

  it("cancels without an E₀ command and reports an all-skipped dependency result", async () => {
    const project = await openSaved()
    editNumber(/^E₀/, 8990)
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { e0: 8990 } }])
    let dialog = await openE0Dialog()
    chooseE0Method(dialog, "manual")
    editNumber(/^Manual E₀/, 9000, dialog)
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(2)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8990)
    dialog = await openE0Dialog()
    api.mockResolvedValueOnce(e0Response(applied, "derivative", {}, { foil: "A background consumer is frozen." }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply E₀" }))
    const report = await within(dialog).findByRole("region", { name: "E₀ selection results" })
    expect(report).toHaveTextContent("Foil scan: A background consumer is frozen.")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.getByRole("status")).toHaveTextContent("1 group skipped")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8990)
    expect(plotProps().active?.parameters.e0).toBe(8990)
  })
})

describe("AthenaWorkbench plot picking", () => {
  it("picks absolute E₀ and relative limits using draft E₀, with no processing before the debounce", async () => {
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
    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: changes,
    })
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
    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: changes,
    })
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
    if (reason === "space") fireEvent.click(within(screen.getByRole("tablist", { name: "Plot space" })).getByRole("tab", { name: /EXAFS/ }))
    if (reason === "plotted groups") fireEvent.click(screen.getByRole("radio", { name: "Current spectrum" }))
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
  it("defaults energy-dependent normalization off and automatically submits only its changed flag", async () => {
    const project = await openSaved()
    const control = screen.getByRole("checkbox", { name: "Energy-dependent normalization" })
    expect(control).not.toBeChecked()
    api.mockResolvedValueOnce(nextProject(project, { foil: { parameters: { ...parameters, fnorm: true } } }))
    fireEvent.click(control)
    expect(control).toBeChecked()
    expect(api).toHaveBeenCalledTimes(1)
    expect(plotProps().active!.result).toBe(project.groups[0].result)
    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { fnorm: true },
    })
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
    await waitForWorkbenchIdle()
    expect(apply()).toBeDisabled()
    fireEvent.change(selector(), { target: { value: "" } })
    api.mockResolvedValueOnce(nextProject(accepted, { foil: { background_standard_id: null } }))
    fireEvent.click(apply())
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: 8, action: "background_standard", group_ids: ["foil"], options: { standard_id: null },
    }))
    await waitForWorkbenchIdle()
    selectGroup("Unused reference")
    expect(selector()).toHaveValue("foil")
  })

  it("preserves the standard choice and processed parameters on failure and surfaces frozen skips", async () => {
    const project = projectFixture()
    project.groups[1].result!.arrays.chi = [0.2, -0.2]
    await openSaved(project)
    editNumber(/^Rbkg/, 1.7)
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { rbkg: 1.7 } }])
    const selector = screen.getByRole("combobox", { name: "Background removal standard" })
    fireEvent.change(selector, { target: { value: "sample" } })
    api.mockRejectedValueOnce(new Error("Background standard would create a cycle"))
    fireEvent.click(screen.getByRole("button", { name: "Apply standard" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/create a cycle/)
    expect(selector).toHaveValue("sample")
    expect(plotProps().active!.background_standard_id).toBeUndefined()
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.7)
    const skipped = nextProject(applied, { foil: { frozen: true } })
    skipped.last_operation = { action: "background_standard", skipped_group_ids: ["foil"] }
    api.mockResolvedValueOnce(skipped)
    fireEvent.click(screen.getByRole("button", { name: "Apply standard" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 group skipped"))
    expect(api.mock.calls[2]).toEqual(api.mock.calls[3])
    expect(selector).toHaveValue("sample")
    expect(selector).toBeDisabled()
    expect(screen.getByRole("button", { name: "Apply standard" })).toBeDisabled()
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.7)
    expect(plotProps().active!.result).toEqual(project.groups[0].result)
  })
})

describe("AthenaWorkbench bulk marking and freezing", () => {
  function selectionUpdate(project: AthenaProject, marked: boolean): AthenaSelectionUpdate {
    return { kind: "selection", id: project.id, base_version: project.version, version: project.version + 1,
      name: project.name, analyses: project.analyses ?? [],
      updated: project.updated, groups: project.groups.map(g => ({ id: g.id, marked, frozen: g.frozen })),
      undo: ["undo-7.json"], redo: [], history: [{ time: project.updated, message: "metadata" }],
      group_versions: Object.fromEntries(project.groups.map(g => [g.id, project.version + 1])),
      last_operation: { action: "metadata", skipped_group_ids: [] } }
  }

  it("merges a compact mark-all response, preserves scientific data and wavelet cache, then sends the latest revision", async () => {
    const project = await openSaved()
    const original = plotProps().active!
    const wavelet = vi.mocked(AthenaWavelet)
    expect(wavelet.mock.calls.at(-1)?.[0].dataVersion).toBe(project.version)
    const update = selectionUpdate(project, true)
    // These can be updated by another client without changing the source revision.
    update.name = "Renamed from Dr.XAS"
    update.analyses = [{ kind: "pca", project_version: project.version, group_ids: ["foil"], options: {}, result: { explained_variance_ratio: [1] } }]
    api.mockResolvedValueOnce(update)
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark all groups" }))
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Mark all groups" })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "metadata", group_ids: project.groups.map(g => g.id),
      options: { marked: true }, response_mode: "selection",
    })
    expect(screen.getByRole("checkbox", { name: "Mark all groups" })).toBeChecked()
    expect(screen.getByRole("button", { name: "Renamed from Dr.XAS" })).toBeInTheDocument()
    expect(screen.getByText(/Explained variance:/)).toBeInTheDocument()
    expect(plotProps().groups).toHaveLength(project.groups.length)
    expect(plotProps().active!.result).toBe(original.result)
    expect(plotProps().active!.parameters).toBe(original.parameters)
    expect(wavelet.mock.calls.at(-1)?.[0]).toMatchObject({ version: project.version + 1, dataVersion: project.version })
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled()
    api.mockResolvedValueOnce({ ...project, version: project.version + 2, redo: ["redo-8.json"] })
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version + 1, action: "undo", group_ids: [], options: {},
    })
    expect(wavelet.mock.calls.at(-1)?.[0].dataVersion).toBe(project.version + 2)
    expect(screen.getByRole("checkbox", { name: "Mark all groups" })).not.toBeChecked()
  })

  it.each(["stale", "missing group", "wrong order", "invalid flag"])("rejects a %s compact response without replacing current data", async kind => {
    const project = await openSaved()
    const update = selectionUpdate(project, true)
    if (kind === "stale") update.base_version -= 1
    if (kind === "missing group") update.groups.pop()
    if (kind === "wrong order") update.groups.reverse()
    if (kind === "invalid flag") update.groups[0].marked = "true" as unknown as boolean
    api.mockResolvedValueOnce(update)
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark all groups" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("selection response does not match"))
    expect(plotProps().groups.map(g => g.id)).toEqual(["sample", "oxide"])
    expect(vi.mocked(AthenaWavelet).mock.calls.at(-1)?.[0]).toMatchObject({ version: project.version, dataVersion: project.version })
  })

  it.each(["Mark all", "Mark none", "Invert marks"])("%s uses all IDs in list order, including frozen and search-hidden groups", async label => {
    const project = projectFixture()
    project.groups[2].frozen = true
    await openSaved(project)
    editNumber(/^Rbkg/, 1.8)
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { rbkg: 1.8 } }])
    fireEvent.change(screen.getByRole("textbox", { name: "Search groups" }), { target: { value: "Foil" } })
    const dialog = await openGroupControls()
    const updated = nextProject(applied, Object.fromEntries(applied.groups.map(g => [g.id, { marked: label === "Invert marks" ? !g.marked : label === "Mark all" }])))
    api.mockResolvedValueOnce(updated)
    fireEvent.click(within(dialog).getByRole("button", { name: label }))
    await waitFor(() => expect(within(dialog).getByRole("button", { name: label })).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: applied.version, action: label === "Invert marks" ? "selection" : "metadata",
      group_ids: ["foil", "sample", "oxide", "unused"],
      options: label === "Invert marks" ? { field: "marked", mode: "invert" } : { marked: label === "Mark all" },
      response_mode: "selection",
    })
    expect(plotProps().active!.id).toBe("foil")
    expect(plotProps().active!.result).toEqual(project.groups[0].result)
    expect(plotProps().groups.map(g => g.id)).toEqual(label === "Mark all" ? ["foil", "sample", "oxide", "unused"] : label === "Mark none" ? [] : ["foil", "unused"])
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
      response_mode: "selection",
    })
    api.mockResolvedValueOnce(nextProject(accepted, { foil: { marked: false }, unused: { marked: false } }))
    fireEvent.click(view.getByRole("button", { name: "Unmark matching" }))
    await waitFor(() => expect(mark).toBeEnabled())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: 8, action: "metadata", group_ids: ["foil", "unused"], options: { marked: false },
      response_mode: "selection",
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
        response_mode: "selection",
      })
      expect(plotProps().active!.id).toBe("foil")
      expect(plotProps().active!.parameters).toEqual(project.groups[0].parameters)
      expect(plotProps().active!.result).toEqual(project.groups[0].result)
    }
  })

  it("keeps flags and processed parameters on command failure, retries the accepted version, and skips empty targets", async () => {
    const project = projectFixture()
    project.groups.forEach(g => { g.marked = false })
    await openSaved(project)
    editNumber(/^Rbkg/, 1.9)
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { rbkg: 1.9 } }])
    const dialog = await openGroupControls()
    const view = within(dialog)
    expect(view.getByRole("button", { name: "Freeze targets" })).toBeDisabled()
    fireEvent.click(view.getByRole("button", { name: "Freeze targets" }))
    expect(api).toHaveBeenCalledTimes(2)
    const failure = deferred<AthenaProject>()
    api.mockReturnValueOnce(failure.promise)
    fireEvent.click(view.getByRole("button", { name: "Invert marks" }))
    expect(view.getByRole("button", { name: "Invert marks" })).toBeDisabled()
    await act(async () => failure.reject(new Error("Selection could not be saved")))
    expect(view.getByRole("alert")).toHaveTextContent("Selection could not be saved")
    expect(plotProps().active!.marked).toBe(false)
    expect(plotProps().active!.id).toBe("foil")
    api.mockResolvedValueOnce(nextProject(applied, Object.fromEntries(applied.groups.map(g => [g.id, { marked: true }]))))
    fireEvent.click(view.getByRole("button", { name: "Invert marks" }))
    await waitFor(() => expect(view.queryByRole("alert")).not.toBeInTheDocument())
    await waitFor(() => expect(view.getByRole("button", { name: "Invert marks" })).toBeEnabled())
    expect(api.mock.calls[2]).toEqual(api.mock.calls[3])
    expect(plotProps().groups.map(g => g.id)).toEqual(["foil", "sample", "oxide", "unused"])
    fireEvent.click(view.getByRole("button", { name: "Close" }))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.9)
  })
})

describe('AthenaWorkbench multi-scan files', () => {
  function collection(): ScanInspectionResponse {
    return { kind: 'scan_list', display_name: 'multiple.spec',
      file_plugin: { id: 'SPEC', description: 'ESRF SPEC', source_sha256: 'hash', total_points: 6, skipped_scans: [] },
      scans: ['first-scan', 'second-scan'].map(name => ({ ...inspectionFixture(name),
        athena_suggestion: { energy_column: 'col_0', numerator: ['col_2'], denominator: 'col_1', mode: 'transmission', units: 'eV', data_type: 'mu' } })) }
  }
  async function openCollection(value = collection(), tail: File[] = []) {
    api.mockResolvedValueOnce(value)
    fireEvent.click(screen.getByRole('button', { name: 'Import data' }))
    const dialog = await screen.findByRole('dialog', { name: /import spectra/i })
    fireEvent.change(within(dialog).getByLabelText('Choose data files'), { target: { files: [new File(['SPEC'], 'multiple.spec'), ...tail] } })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review selected scans' })).toBeEnabled())
    return dialog
  }
  it('reviews a selected subset without uploading scan bytes or importing excluded scans', async () => {
    const p = await openSaved(); const value = collection(); const dialog = await openCollection(value)
    fireEvent.click(within(dialog).getByLabelText('Include Scan 1 · entry 1'))
    api.mockResolvedValueOnce(value.scans[1])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review selected scans' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import spectrum' })).toBeEnabled())
    expect(importCalls()).toHaveLength(0)
    expect(api.mock.calls.at(-1)?.[0]).toBe(`/projects/${p.id}/uploads/${value.scans[1].upload_id}/inspection`)
    api.mockResolvedValueOnce(importedProject(p, 'second-scan')); submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls()).toHaveLength(1)
    expect(importCalls()[0][1]).toMatchObject({ upload_id: value.scans[1].upload_id, version: p.version })
    expect(api.mock.calls.filter(([path]) => path.endsWith('/inspect'))).toHaveLength(1)
  })
  it('reuses explicit detector choices for compatible staged scans with fresh project versions', async () => {
    const p = await openSaved(); const value = collection(); const dialog = await openCollection(value)
    api.mockResolvedValueOnce(value.scans[0]); fireEvent.click(within(dialog).getByRole('button', { name: 'Review selected scans' }))
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Yes, use the same parameters' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import 2 files' })).toBeEnabled())
    fireEvent.click(within(dialog).getByLabelText('Invert signal'))
    const first = importedProject(p, 'first'); const second = importedProject(first, 'second')
    api.mockResolvedValueOnce(first).mockResolvedValueOnce(value.scans[1]).mockResolvedValueOnce(second)
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls().map(([, body]) => body)).toMatchObject([
      { upload_id: value.scans[0].upload_id, version: p.version, invert: true },
      { upload_id: value.scans[1].upload_id, version: first.version, invert: true } ])
  })
  it('can retry a staged inspection failure without importing the first scan again', async () => {
    const p = await openSaved(); const value = collection(); const dialog = await openCollection(value)
    api.mockResolvedValueOnce(value.scans[0]); fireEvent.click(within(dialog).getByRole('button', { name: 'Review selected scans' }))
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Yes, use the same parameters' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import 2 files' })).toBeEnabled())
    const first = importedProject(p, 'first')
    api.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('Temporary staged inspection failure'))
    submitImport(dialog)
    await within(dialog).findByRole('alert')
    expect(importCalls()).toHaveLength(1)
    api.mockResolvedValueOnce(value.scans[1]); fireEvent.click(within(dialog).getByRole('button', { name: 'Retry file inspection' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import spectrum' })).toBeEnabled())
    api.mockResolvedValueOnce(importedProject(first, 'second')); submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls().map(([, body]) => (body as { upload_id: string }).upload_id)).toEqual(value.scans.map(scan => scan.upload_id))
  })
  it('pauses on changed scan columns even when reuse is enabled', async () => {
    const p = await openSaved(); const value = collection()
    value.scans[1] = inspectionFixture('different', ['Energy', 'I0', 'It', 'Ir'])
    const dialog = await openCollection(value)
    api.mockResolvedValueOnce(value.scans[0]); fireEvent.click(within(dialog).getByRole('button', { name: 'Review selected scans' }))
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Yes, use the same parameters' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import 2 files' })).toBeEnabled())
    api.mockResolvedValueOnce(importedProject(p, 'first')).mockResolvedValueOnce(value.scans[1]); submitImport(dialog)
    await within(dialog).findByText('different')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import spectrum' })).toBeEnabled())
    expect(importCalls()).toHaveLength(1)
  })
  it('hands the remaining original project files to the project panel after selected scans finish', async () => {
    const p = await openSaved(); const value = collection(); const tail = [new File(['PRJ'], 'next.prj'), new File(['raw'], 'last.dat')]
    const dialog = await openCollection(value, tail)
    fireEvent.click(within(dialog).getByLabelText('Include Scan 2 · entry 2'))
    api.mockResolvedValueOnce(value.scans[0]); fireEvent.click(within(dialog).getByRole('button', { name: 'Review selected scans' }))
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Yes, use the same parameters' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import 3 files' })).toBeEnabled())
    api.mockResolvedValueOnce(importedProject(p, 'first')); submitImport(dialog)
    await screen.findByTestId('project-import-panel')
    expect(projectImport.mock.calls.at(-1)?.[0].initialFiles).toEqual(tail)
    expect(importCalls()).toHaveLength(1)
  })
})

describe("AthenaWorkbench batch import", () => {
  it('requires an explicit parameter-sharing choice before importing multiple files', async () => {
    await openSaved()
    const { dialog } = await chooseImportFiles(['one.dat', 'two.dat'].map(name => inspectionFixture(name)), null)
    const view = within(dialog)
    expect(view.getByRole('group', { name: 'Use the same import parameters for all files?' })).toBeVisible()
    expect(view.getByRole('radio', { name: 'Yes, use the same parameters' })).not.toBeChecked()
    expect(view.getByRole('radio', { name: 'No, review each file' })).not.toBeChecked()
    expect(view.getByRole('button', { name: 'Import spectrum' })).toBeDisabled()
    submitImport(dialog)
    expect(importCalls()).toHaveLength(0)
    fireEvent.click(view.getByRole('radio', { name: 'Yes, use the same parameters' }))
    expect(view.getByRole('button', { name: 'Import 2 files' })).toBeEnabled()
    fireEvent.click(view.getByRole('radio', { name: 'No, review each file' }))
    expect(view.getByRole('button', { name: 'Import spectrum' })).toBeEnabled()
    expect(importCalls()).toHaveLength(0)
  })

  it.each([true, false])('asks again when a new file batch replaces the shared-choice %s batch', async shareParameters => {
    await openSaved()
    const { dialog } = await chooseImportFiles(['one.dat', 'two.dat'].map(name => inspectionFixture(name)), shareParameters)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose another file' }))
    api.mockResolvedValueOnce(inspectionFixture('new-one.dat'))
    fireEvent.change(within(dialog).getByLabelText('Choose data files'), { target: { files: [
      new File(['data'], 'new-one.dat'), new File(['data'], 'new-two.dat'),
    ] } })
    await within(dialog).findByText('new-one.dat')
    expect(within(dialog).getByRole('radio', { name: 'Yes, use the same parameters' })).not.toBeChecked()
    expect(within(dialog).getByRole('radio', { name: 'No, review each file' })).not.toBeChecked()
    expect(within(dialog).getByRole('button', { name: 'Import spectrum' })).toBeDisabled()
    expect(importCalls()).toHaveLength(0)
  })

  it('imports a single file without asking about shared parameters', async () => {
    const project = await openSaved()
    const { dialog } = await chooseImportFiles([inspectionFixture('single.dat')])
    expect(within(dialog).queryByRole('group', { name: 'Use the same import parameters for all files?' })).not.toBeInTheDocument()
    api.mockResolvedValueOnce(importedProject(project, 'single.dat'))
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls()).toHaveLength(1)
  })

  it('imports both modes in one request and shows both accepted groups', async () => {
    const project = await openSaved()
    const inspected = inspectionFixture('both-modes.dat')
    const { dialog } = await chooseImportFiles([inspected])
    chooseBothModesMapping(dialog)
    expect(within(dialog).getByRole('button', { name: 'Import both modes' })).toBeEnabled()
    const accepted = importedBothModes(project, inspected.display_name)
    api.mockResolvedValueOnce(accepted)

    submitImport(dialog)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls()).toEqual([[`/projects/${project.id}/import`, expect.objectContaining({
      ...bothModesMapping, additional_fluorescence: expect.objectContaining(bothModesMapping.additional_fluorescence),
      upload_id: inspected.upload_id, version: project.version,
    })]])
    expect(plotProps().groups).toEqual(accepted.groups.filter(g => g.marked))
    expect(within(screen.getByRole('button', { name: /^both-modes.dat · Transmission/ })).getByText('trans')).toHaveAttribute('title', 'Transmission')
    expect(within(screen.getByRole('button', { name: /^both-modes.dat · Fluorescence/ })).getByText('fluo')).toHaveAttribute('title', 'Fluorescence')
  })

  it('reuses both modes across renamed columns with one request per file', async () => {
    const project = await openSaved()
    const inspections = [inspectionFixture('both-first.dat'), inspectionFixture('both-renamed.dat',
      ['axis', 'transmitted', 'monitor', 'detector_a', 'detector_b', 'reference'])]
    const { dialog } = await chooseImportFiles(inspections)
    chooseBothModesMapping(dialog)
    const first = importedBothModes(project, inspections[0].display_name)
    const second = importedBothModes(first, inspections[1].display_name)
    api.mockResolvedValueOnce(first).mockResolvedValueOnce(inspections[1]).mockResolvedValueOnce(second)

    submitImport(dialog)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls()).toEqual(inspections.map((inspection, index) => [`/projects/${project.id}/import`, expect.objectContaining({
      ...bothModesMapping, additional_fluorescence: expect.objectContaining(bothModesMapping.additional_fluorescence),
      upload_id: inspection.upload_id, version: project.version + index,
    })]))
    expect(plotProps().groups).toEqual(second.groups.filter(g => g.marked))
    expect(second.groups).toHaveLength(project.groups.length + 4)
  })

  it('retries the failed file in both modes without reimporting an accepted pair', async () => {
    const project = await openSaved()
    const inspections = ['both-one.dat', 'both-two.dat', 'both-three.dat'].map(name => inspectionFixture(name))
    const { dialog } = await chooseImportFiles(inspections)
    chooseBothModesMapping(dialog)
    const first = importedBothModes(project, inspections[0].display_name)
    const second = importedBothModes(first, inspections[1].display_name)
    const third = importedBothModes(second, inspections[2].display_name)
    api.mockResolvedValueOnce(first).mockResolvedValueOnce(inspections[1]).mockRejectedValueOnce(new Error('Both-mode import failed'))
    submitImport(dialog)

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Both-mode import failed')
    expect(importCalls()).toHaveLength(2)
    expect(plotProps().groups).toEqual(first.groups.filter(g => g.marked))
    expect(within(dialog).getByRole('combobox', { name: 'Measurement' })).toHaveValue('both')
    expect(within(dialog).getByRole('checkbox', { name: 'Fluorescence numerator If2' })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: 'Invert fluorescence signal' })).toBeChecked()
    expect(within(dialog).getByRole('spinbutton', { name: 'Fluorescence multiplicative constant' })).toHaveValue(.75)
    api.mockResolvedValueOnce(second).mockResolvedValueOnce(inspections[2]).mockResolvedValueOnce(third)
    submitImport(dialog)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const calls = importCalls()
    expect(calls.map(([, body]) => (body as { upload_id: string }).upload_id)).toEqual([
      inspections[0].upload_id, inspections[1].upload_id, inspections[1].upload_id, inspections[2].upload_id,
    ])
    expect(calls[1]).toEqual(calls[2])
    expect(calls.at(-1)?.[1]).toMatchObject({ version: second.version, ...bothModesMapping })
    expect(plotProps().groups).toEqual(third.groups.filter(g => g.marked))
    expect(third.groups).toHaveLength(project.groups.length + 6)
    expect(new Set(third.groups.map(g => g.id)).size).toBe(third.groups.length)
  })

  it('restores remembered choices into the actual controls and sends them with the live revision', async () => {
    const project = await openSaved()
    const inspected = inspectionFixture('remembered.dat')
    inspected.remembered_columns = { version: 5, matching_columns: true, warnings: [], mapping: {
      energy_column: 'col_0', numerator: ['col_3', 'col_4'], denominator: ['col_1', 'col_2'],
      mode: 'fluorescence', units: 'keV', data_type: 'xanes', reference_numerator: 'col_1', reference_denominator: 'col_5',
      reference_log: false, reference_same_element: false, sort: true, individual_channels: true,
      signal_multiplier: 2, invert: true, preprocessing: { mark: true, standard_id: null, copy_parameters: false, align: false },
      rebin: { enabled: true, e0: null, emin: -20, emax: 60, pre: 7, xanes: .2, exafs: .1, width: 4 },
    } }
    const { dialog } = await chooseImportFiles([inspected])
    const view = within(dialog)
    expect(view.getByRole('region', { name: 'Remembered import choices' })).toHaveTextContent('previous successful import')
    expect(view.getByLabelText('Numerator If1')).toBeChecked()
    expect(view.getByLabelText('Denominator It')).toBeChecked()
    fireEvent.click(view.getByText('Rebin quick scans', { exact: true }))
    expect(view.getByLabelText('Perform rebinning')).toBeChecked()
    expect(view.getByLabelText('Rebin pre-edge step · eV')).toHaveValue(7)
    fireEvent.click(view.getByText('Preprocess imported groups', { exact: true }))
    expect(view.getByLabelText('Mark each imported sample')).toBeChecked()
    api.mockResolvedValueOnce({ ...importedProject(project, 'remembered.dat'),
      import_preferences_warning: 'Spectra imported, but column choices could not be remembered for the next import.' })
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls()).toHaveLength(1)
    expect(importCalls()[0][1]).toMatchObject({ version: project.version, numerator: ['col_3', 'col_4'],
      denominator: ['col_1', 'col_2'], rebin: { pre: 7, e0: null }, rebin_grid: { pre: 7 }, preprocessing: { mark: true } })
    expect(screen.getByRole('status')).toHaveTextContent('Spectra imported, but column choices could not be remembered')
    expect(plotProps().active?.label).toBe('remembered.dat')
  })

  it('lets file suggestions replace remembered choices without importing or changing saved groups', async () => {
    const project = await openSaved()
    const inspected = inspectionFixture('suggested.dat')
    inspected.athena_suggestion = { energy_column: 'col_0', numerator: ['col_2'], denominator: 'col_1', mode: 'transmission', units: 'eV', data_type: 'mu' }
    inspected.remembered_columns = { version: 1, matching_columns: true, warnings: ['Previous standard unavailable.'], mapping: {
      energy_column: 'col_0', numerator: ['col_3'], denominator: 'col_2', mode: 'fluorescence', units: 'keV', data_type: 'xanes',
      reference_numerator: 'col_2', reference_denominator: 'col_5', sort: false,
      preprocessing: { mark: true, standard_id: null, copy_parameters: false, align: false },
      rebin: { enabled: true, e0: null, emin: -30, emax: 50, pre: 7, xanes: .5, exafs: .05, width: 3 },
    } }
    const { dialog } = await chooseImportFiles([inspected]); const view = within(dialog)
    expect(view.getByText('Previous standard unavailable.')).toBeInTheDocument()
    fireEvent.click(view.getByRole('button', { name: 'Use suggested columns' }))
    expect(view.getByRole('combobox', { name: 'Measurement' })).toHaveValue('transmission')
    expect(view.getByLabelText('Numerator I0')).toBeChecked()
    fireEvent.click(view.getByText('Rebin quick scans', { exact: true }))
    expect(view.getByLabelText('Perform rebinning')).not.toBeChecked()
    expect(importCalls()).toHaveLength(0)
    expect(plotProps().active?.id).toBe(project.groups[0].id)
  })

  it('retains rebin choices through a matching batch failure and retries the failed file', async () => {
    const project = await openSaved()
    const inspections = ['quick-1.dat', 'quick-2.dat'].map(name => inspectionFixture(name))
    const { dialog } = await chooseImportFiles(inspections)
    fireEvent.click(within(dialog).getByText('Rebin quick scans', { exact: true }))
    fireEvent.click(within(dialog).getByLabelText('Perform rebinning'))
    fireEvent.change(within(dialog).getByLabelText('Rebin smoothing width · points'), { target: { value: '4' } })
    fireEvent.change(within(dialog).getByLabelText('Rebin grid E₀ · eV'), { target: { value: '8980' } })
    const first = importedProject(project, inspections[0].display_name)
    const second = importedProject(first, inspections[1].display_name)
    api.mockResolvedValueOnce(first).mockResolvedValueOnce(inspections[1]).mockRejectedValueOnce(new Error('Temporary import failure'))
    submitImport(dialog)
    await within(dialog).findByText('Temporary import failure')
    expect(importCalls()).toHaveLength(2)
    expect(within(dialog).getByLabelText('Perform rebinning')).toBeChecked()
    expect(within(dialog).getByLabelText('Rebin smoothing width · points')).toHaveValue(4)
    api.mockResolvedValueOnce(second)
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const calls = importCalls()
    expect(calls[1]).toEqual(calls[2])
    for (const [, payload] of calls) expect(payload).toMatchObject({ rebin: { e0: 8980, width: 4, pre: 10, xanes: .5, exafs: .05 } })
    const next = await chooseImportFiles([inspectionFixture('new-selection.dat')])
    expect(within(next.dialog).getByLabelText('Perform rebinning')).not.toBeChecked()
    expect(within(next.dialog).getByLabelText('Rebin smoothing width · points')).toHaveValue(4)
  })

  it("imports all files once with shared detector and reference parameters despite renamed column labels", async () => {
    const project = await openSaved()
    const inspections = [
      inspectionFixture("scan-1.dat"),
      inspectionFixture("scan-2.dat", ["Energy (eV)", "transmitted", "incident", "detector_a", "detector_b", "reference"]),
      inspectionFixture("scan-3.dat", ["energy_axis", "transmission", "monitor", "channel_1", "channel_2", "foil"]),
    ]
    // Recommendations on later matching files must not override the
    // mapping explicitly chosen for this batch (including its keV units).
    for (const inspected of inspections.slice(1)) inspected.athena_suggestion = {
      energy_column: "col_0", numerator: ["col_2"], denominator: "col_1", mode: "transmission", units: "eV", data_type: "mu",
    }
    const { dialog, files } = await chooseImportFiles(inspections)
    chooseFluorescenceMapping(dialog)
    expect(within(dialog).getByRole("radio", { name: "Yes, use the same parameters" })).toBeChecked()
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
    expect(within(dialog).getByText(/^Batch import paused:/)).toHaveAttribute("role", "status")
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Import spectrum$/i })).toBeEnabled())
    expect(screen.getByText('Imported 1 file · 1 awaiting review')).toBeVisible()
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

  it("keeps the first imported file and processed parameters when importing the second file fails", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.7)
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { rbkg: 2.7 } }])
    const inspections = ["scan-1.dat", "scan-2.dat", "scan-3.dat"].map(name => inspectionFixture(name))
    const { dialog } = await chooseImportFiles(inspections)
    chooseFluorescenceMapping(dialog)
    const afterFirst = importedProject(applied, inspections[0].display_name)
    api.mockResolvedValueOnce(afterFirst).mockResolvedValueOnce(inspections[1])
      .mockRejectedValueOnce(new Error("Second file could not be imported"))

    submitImport(dialog)

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Second file could not be imported")
    expect(importCalls()).toHaveLength(2)
    expect(api.mock.calls.filter(([path]) => path.endsWith("/inspect"))).toHaveLength(2)
    expect(plotProps().active).toEqual(afterFirst.groups.at(-1))
    expect(plotProps().groups).toEqual(afterFirst.groups.filter(g => g.marked))
    expect(localStorage.getItem(storageKey)).toBe(project.id)
    expect(within(dialog).getByRole("button", { name: "Import 2 files" })).toBeEnabled()
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

  it("reviews every file separately after choosing not to share parameters", async () => {
    const project = await openSaved()
    const inspections = ['scan-1.dat', 'scan-2.dat', 'scan-3.dat'].map(name => inspectionFixture(name))
    const { dialog } = await chooseImportFiles(inspections, false)
    chooseFluorescenceMapping(dialog)
    let accepted = project
    for (let index = 0; index < inspections.length; index++) {
      const next = importedProject(accepted, inspections[index].display_name)
      api.mockResolvedValueOnce(next)
      if (index + 1 < inspections.length) api.mockResolvedValueOnce(inspections[index + 1])
      submitImport(dialog)
      if (index + 1 < inspections.length) {
        await within(dialog).findByText(inspections[index + 1].display_name)
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Import spectrum' })).toBeEnabled())
        expect(importCalls()).toHaveLength(index + 1)
        expect(within(dialog).getByRole('checkbox', { name: 'Numerator It' })).toBeChecked()
        expect(within(dialog).getByLabelText('reference numerator')).toHaveValue('')
        expect(within(dialog).getByLabelText('reference denominator')).toHaveValue('')
        if (index === 0) expect(within(dialog).getByRole('radio', { name: 'No, review each file' })).toBeChecked()
      }
      accepted = next
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importCalls().map(([, body]) => (body as { upload_id: string }).upload_id)).toEqual(inspections.map(i => i.upload_id))
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

  it("places project actions above the data-group controls", async () => {
    await openSaved()
    const sidebar = document.querySelector<HTMLElement>("#athena-data-groups")!
    const actions = within(sidebar).getByRole("group", { name: "Project actions" })
    const search = within(sidebar).getByRole("textbox", { name: "Search groups" })

    expect(within(actions).getByRole("button", { name: "Open project" })).toBeEnabled()
    expect(within(actions).getByRole("button", { name: "Project journal" })).toBeEnabled()
    expect(actions.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it("omits the spectrum summary readouts and workflow guide", async () => {
    await openSaved()
    expect(screen.getByRole("tablist", { name: "Plot space" })).toBeVisible()
    for (const label of [
      "EDGE ENERGY", "EDGE STEP", "ENERGY RANGE", "PROCESSING",
      "Import & inspect", "Normalize & remove background", "Transform & compare",
    ]) expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument()
  })

  it("shows energy ranges relative to E₀ by default and preserves absolute plot limits", async () => {
    const project = projectFixture()
    for (const group of project.groups) Object.assign(group.result!.arrays, {
      k: [0, 4, 8, 12], weighted_chi: [0, 1, -1, 0],
    })
    await openSaved(project)
    const minimum = () => screen.getByRole("spinbutton", { name: "Plot minimum" })
    const maximum = () => screen.getByRole("spinbutton", { name: "Plot maximum" })
    const relative = () => screen.getByRole("checkbox", { name: "Relative to E₀" })

    expect(relative()).toBeChecked()
    expect(relative().closest("label")).toHaveAttribute("title", "Use the current spectrum’s E₀ (8979 eV) as zero")
    expect(minimum()).toHaveValue(-19)
    expect(maximum()).toHaveValue(21)
    expect(minimum()).toHaveAttribute("step", "any")
    expect(maximum()).toHaveAttribute("step", "any")
    expect(plotProps().range).toEqual([null, null])

    fireEvent.change(minimum(), { target: { value: "-9" } })
    expect(minimum()).toHaveValue(-9)
    expect(maximum()).toHaveValue(21)
    expect(plotProps().range).toEqual([8970, null])

    fireEvent.click(relative())
    expect(minimum()).toHaveValue(8970)
    expect(maximum()).toHaveValue(9000)
    expect(plotProps().range).toEqual([8970, null])
    fireEvent.click(relative())
    expect(minimum()).toHaveValue(-9)
    expect(plotProps().range).toEqual([8970, null])

    fireEvent.change(minimum(), { target: { value: "" } })
    expect(minimum()).toHaveValue(null)
    expect(plotProps().range).toEqual([null, null])
    fireEvent.blur(minimum())
    expect(minimum()).toHaveValue(-19)

    fireEvent.click(within(screen.getByRole("tablist", { name: "Plot space" })).getByRole("tab", { name: /EXAFS/ }))
    expect(screen.queryByRole("checkbox", { name: "Relative to E₀" })).not.toBeInTheDocument()
    expect(minimum()).toHaveValue(0)
    expect(maximum()).toHaveValue(12)
    expect(plotProps().range).toEqual([null, null])

    fireEvent.click(screen.getByRole("tab", { name: /Energy/ }))
    expect(relative()).toBeChecked()
    expect(minimum()).toHaveValue(-19)
    expect(maximum()).toHaveValue(21)
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

  it("opens a recent project and shows its saved parameter recipe", async () => {
    const original = await openSaved()
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

  it("does not let a stale automatic-parameter response replace a newly imported project", async () => {
    const original = await openSaved()
    api.mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole("button", { name: /^Open project$/i }))
    const dialog = await screen.findByRole("dialog", { name: /open.*project/i })
    await waitFor(() => expect(projectImport.mock.calls.at(-1)![0].disabled).toBe(false))

    const stale = deferred<AthenaProject>()
    api.mockReturnValueOnce(stale.promise)
    vi.useFakeTimers()
    editNumber(/^Rbkg/, 2.5)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(api).toHaveBeenLastCalledWith(`/projects/${original.id}/command`, {
      version: original.version, action: "parameters", group_ids: ["foil"], options: { rbkg: 2.5 },
    })

    const loaded = projectFixture({ id: "project-fe", name: "Iron study", version: 3 })
    act(() => projectImport.mock.calls.at(-1)![0].onImported(loaded))
    expect(localStorage.getItem(storageKey)).toBe(loaded.id)
    expect(screen.getByRole("button", { name: loaded.name })).toBeVisible()

    await act(async () => {
      stale.resolve(nextProject(original, { foil: { parameters: { ...parameters, rbkg: 2.5 } } }))
      await stale.promise
      await Promise.resolve()
    })

    expect(localStorage.getItem(storageKey)).toBe(loaded.id)
    expect(screen.getByRole("button", { name: loaded.name })).toBeVisible()
    expect(plotProps().active).toEqual(loaded.groups.at(-1))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The active project changed while this operation was running")
  })
})

describe("AthenaWorkbench project import integration", () => {
  it.each(["file picker", "drag and drop"])("routes .prj files from %s to project preview, preserving the queue", async entry => {
    await openSaved()
    const files = [new File(["project"], "copper.PRJ"), new File(["data"], "scan.xmu")]
    if (entry === "file picker") {
      fireEvent.click(screen.getByRole("button", { name: "Import data" }))
      fireEvent.change(screen.getByLabelText("Choose data files"), { target: { files } })
    } else {
      fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files } })
    }
    expect(await screen.findByRole("dialog", { name: "Open a project" })).toBeVisible()
    const panelProps = () => projectImport.mock.calls.at(-1)![0]
    expect(panelProps().initialFiles).toBeDefined()
    expect(panelProps().initialFiles).toEqual(files)
    expect(panelProps().canRestore).toBe(true)
    expect(api.mock.calls.some(([path]) => path.endsWith("/inspect"))).toBe(false)
  })

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
    if (hasMarks) expect(screen.getByRole("button", { name: /Save marked project/ })).toBeEnabled()
    else {
      expect(screen.queryByRole("link", { name: /Save marked project/ })).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Save marked project/ })).toBeDisabled()
    }
  })
})

describe("AthenaWorkbench automatic normalization values", () => {
  function automaticProject() {
    const project = projectFixture()
    project.groups[0].parameters = { ...parameters, e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null }
    project.groups[0].result!.effective = { e0: 8979.125, edge_step: 0.0000123456789, pre1: -145, pre2: -72.5, norm1: 25, norm2: 620, nnorm: 2 }
    return project
  }

  it("shows calculated background and Fourier limits directly without creating overrides", async () => {
    const initial = automaticProject()
    initial.groups[0].parameters.kmax = null
    initial.groups[0].result!.effective = { ...initial.groups[0].result!.effective, bkg_kmax: 25.019, kmax: 12.5 }
    await openSaved(initial)
    expect(screen.getByRole("spinbutton", { name: /^Spline k max/ })).toHaveValue(25.019)
    expect(Number((screen.getByRole("spinbutton", { name: /^Spline energy max/ }) as HTMLInputElement).value)).toBeCloseTo(25.019 ** 2 * 3.8099821109685847, 5)
    expect(screen.getByRole("spinbutton", { name: /^FT k max/ })).toHaveValue(12.5)
    expect(screen.queryByText(/^Auto:/)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText("Auto")).not.toBeInTheDocument()
    expect(plotProps().active!.parameters).toMatchObject({ bkg_kmax: null, kmax: null })
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("shows calculated normalization values without changing the automatic recipe or creating a draft", async () => {
    const project = await openSaved(automaticProject())
    for (const [label, value] of [
      [/^E₀/, 8979.125], [/^Edge step/, 0.0000123456789],
      [/^Pre-edge start/, -145], [/^Pre-edge end/, -72.5],
      [/^Post-edge start/, 25], [/^Post-edge end/, 620],
    ] as const) {
      const input = screen.getByRole("spinbutton", { name: label })
      expect(input).toHaveValue(value)
      fireEvent.focus(input)
      fireEvent.blur(input)
      expect(input).toHaveValue(value)
    }
    const degree = screen.getByRole("combobox", { name: "Polynomial degree" })
    expect(degree).toHaveValue("")
    expect(degree.querySelector('option[value=""]')).toHaveTextContent("2")
    expect(degree.querySelector('option[value=""]')).toHaveProperty("selected", true)
    expect(degree.querySelector('option[value=""]')).toHaveAttribute("hidden")
    expect(screen.queryByText("Automatic", { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText("Auto")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
    for (const key of ["e0", "step", "pre1", "pre2", "norm1", "norm2", "nnorm"] as const) {
      expect(plotProps().active!.parameters[key]).toBeNull()
    }
    expect(plotProps().active!.parameters).toEqual(project.groups[0].parameters)
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])
  })

  it("applies only edited parameters and refreshes automatic numbers from the returned result", async () => {
    const project = await openSaved(automaticProject())
    const saved = project.groups[0]
    const next = nextProject(project, { foil: {
      parameters: { ...saved.parameters, energy_shift: 2 },
      result: { ...saved.result!, effective: { ...saved.result!.effective, e0: 8981.125, norm2: 200, nnorm: 1 } },
    } })
    api.mockResolvedValueOnce(next)
    editNumber(/^Energy shift/, 2)
    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { energy_shift: 2 },
    })
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8981.125)
    expect(screen.getByRole("spinbutton", { name: /^Post-edge end/ })).toHaveValue(200)
    const degree = screen.getByRole("combobox", { name: "Polynomial degree" })
    expect(degree).toHaveValue("")
    expect(degree.querySelector('option[value=""]')).toHaveTextContent("1")
    expect(degree.querySelector('option[value=""]')).toHaveProperty("selected", true)
    expect(plotProps().active!.parameters).toMatchObject({ e0: null, norm2: null, nnorm: null })
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
  })

  it("keeps a cleared override empty during editing, restores automatic display on blur, and saves null", async () => {
    const initial = automaticProject()
    initial.groups[0].parameters.pre1 = -150
    const project = await openSaved(initial)
    const input = screen.getByRole("spinbutton", { name: /^Pre-edge start/ })
    const saved = project.groups[0]
    api.mockResolvedValueOnce(nextProject(project, { foil: {
      parameters: { ...saved.parameters, pre1: null },
      result: { ...saved.result!, effective: { ...saved.result!.effective, pre1: -140 } },
    } }))
    expect(input).toHaveValue(-150)
    expect(screen.getByText("Used in saved result: -145")).toBeVisible()
    fireEvent.focus(input)
    editNumber(/^Pre-edge start/, "")
    expect(input).toHaveValue(null)
    expect(screen.getByRole("button", { name: /Discard parameter changes/ })).toBeVisible()
    fireEvent.blur(input)
    expect(input).toHaveValue(-145)
    expect(screen.queryByText("Used in saved result: -145")).not.toBeInTheDocument()

    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { pre1: null },
    })
    expect(screen.getByRole("spinbutton", { name: /^Pre-edge start/ })).toHaveValue(-140)
    expect(plotProps().active!.parameters.pre1).toBeNull()
  })

  it("keeps explicit overrides distinct even when they equal the displayed automatic values", async () => {
    const project = await openSaved(automaticProject())
    const input = screen.getByRole("spinbutton", { name: /^E₀/ })
    api.mockResolvedValueOnce(nextProject(project, { foil: {
      parameters: { ...project.groups[0].parameters, e0: 8979.125, nnorm: 2 },
    } }))
    fireEvent.focus(input)
    editNumber(/^E₀/, "")
    editNumber(/^E₀/, 8979.125)
    fireEvent.blur(input)
    fireEvent.change(screen.getByRole("combobox", { name: "Polynomial degree" }), { target: { value: "2" } })
    expect(screen.getByRole("button", { name: /Discard parameter changes/ })).toBeVisible()
    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { e0: 8979.125, nnorm: 2 },
    })
  })

  it("does not carry a temporarily empty field across groups and restores automatic display on discard", async () => {
    const initial = automaticProject()
    initial.groups[1].parameters.e0 = null
    initial.groups[1].result!.effective.e0 = 7112.5
    await openSaved(initial)
    fireEvent.focus(screen.getByRole("spinbutton", { name: /^E₀/ }))
    editNumber(/^E₀/, "")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(null)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(7112.5)
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8979.125)
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
    editNumber(/^Pre-edge start/, -130)
    fireEvent.click(screen.getByRole("button", { name: /Discard parameter changes/ }))
    expect(screen.getByRole("spinbutton", { name: /^Pre-edge start/ })).toHaveValue(-145)
    expect(plotProps().active!.parameters.pre1).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("keeps zero automatic degree visible and leaves unavailable automatic values blank", async () => {
    const project = automaticProject()
    project.groups[0].result!.effective = { nnorm: 0 }
    await openSaved(project)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(null)
    expect(screen.getByRole("spinbutton", { name: /^Edge step/ })).toHaveValue(null)
    const degree = screen.getByRole("combobox", { name: "Polynomial degree" })
    expect(degree).toHaveValue("")
    expect(degree.querySelector('option[value=""]')).toHaveTextContent("0")
    expect(degree.querySelector('option[value=""]')).toHaveProperty("selected", true)
    expect(plotProps().active!.parameters.nnorm).toBeNull()
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
    fireEvent.blur(screen.getByRole("spinbutton", { name: /^E₀/ }))
    editNumber(/^Spline energy min/, 100)
    editNumber(/^Spline k min/, 0)
    const parametersApplied = await finishParameterDrafts(project, [{ groupId: "sample", options: { rbkg: 2.7 } }])

    const expectCleanFoil = () => {
      expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
      expect(within(screen.getByRole("button", { name: name => name.startsWith("Foil scan") })).queryByTitle("Pending automatic processing")).not.toBeInTheDocument()
    }
    expectCleanFoil()
    const reordered = Object.fromEntries(Object.entries(project.groups[0].parameters).reverse()) as Parameters
    expect(Object.keys(reordered)).not.toEqual(Object.keys(project.groups[0].parameters))
    const applied = nextProject(parametersApplied, { foil: { background_standard_id: "sample", parameters: reordered } })
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
    await waitForWorkbenchIdle()
    expectCleanFoil()
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8979)
    expect(plotProps().active!.parameters.e0).toBeNull()
    expect(screen.getByRole("spinbutton", { name: /^Spline k min/ })).toHaveValue(0)
    expect(screen.getByRole("combobox", { name: "Background removal standard" })).toHaveValue("")
    expect(api.mock.calls.slice(1).map(([, body]) => (body as { action: string }).action)).toEqual(["parameters", "background_standard", "undo"])

    // Automatic E0 is still different from an explicit value equal to its readout.
    editNumber(/^E₀/, "")
    editNumber(/^E₀/, 8979)
    expect(screen.getByRole("button", { name: /Discard parameter changes/ })).toBeVisible()
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.7)
    expect(within(screen.getByRole("button", { name: name => name.startsWith("Foil scan") })).getByTitle("Pending automatic processing")).toBeInTheDocument()
  })

  it("treats an omitted fnorm and a reverted false draft as equal without auto-submitting", async () => {
    const project = await openSaved()
    expect(project.groups[0].parameters.fnorm).toBeUndefined()
    vi.useFakeTimers()
    const control = screen.getByRole("checkbox", { name: "Energy-dependent normalization" })
    fireEvent.click(control)
    expect(screen.getByRole("button", { name: /Discard parameter changes/ })).toBeVisible()
    expect(screen.getByTitle("Pending automatic processing")).toBeInTheDocument()
    fireEvent.click(control)
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
    expect(screen.queryByTitle("Pending automatic processing")).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
  })

  it("keeps an automatically applied edit through a reordered copy response and its Undo", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2)
    selectGroup("Sample scan")
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { rbkg: 2 } }])
    const copied = nextProject(applied, Object.fromEntries(applied.groups.map(g => [g.id, {
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

    api.mockResolvedValueOnce({ ...applied, version: copied.version + 1 })
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitForWorkbenchIdle()
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2)
    expect(screen.queryByRole("button", { name: /Discard parameter changes/ })).not.toBeInTheDocument()
    expect(screen.queryByTitle("Pending automatic processing")).not.toBeInTheDocument()
  })

  it("shares the viewer k-weight selector with spectra and wavelet without modifying the project", async () => {
    const project = await openSaved()
    const before = structuredClone(project)
    const selector = screen.getByRole("combobox", { name: "Viewer k-weight" })
    expect(selector).toHaveValue("2")
    expect(plotProps().kWeight).toBeNull()
    expect(within(selector).getAllByRole("option").map(option => option.textContent)).toEqual(["0", "1", "2", "3", "4"])
    expect(document.querySelector(".ath-center-heading")).toContainElement(selector)
    expect(screen.queryByRole("combobox", { name: "Wavelet k-weight" })).not.toBeInTheDocument()
    for (const value of ["3", "0", "2"]) {
      fireEvent.change(selector, { target: { value } })
      const kWeight = value === "2" ? null : Number(value)
      expect(plotProps().kWeight).toBe(kWeight)
      expect(vi.mocked(AthenaWavelet).mock.calls.at(-1)?.[0].kWeight).toBe(kWeight)
    }
    expect(api).toHaveBeenCalledTimes(1)
    expect(project).toEqual(before)
  })

  it("retains per-spectrum saved viewer weights when selected groups have different weights", async () => {
    const initial = projectFixture()
    initial.groups[1].result!.effective.kweight = 1
    initial.groups[2].result!.effective.kweight = 3
    const project = await openSaved(initial)
    const before = structuredClone(project)
    const selector = screen.getByRole("combobox", { name: "Viewer k-weight" })
    expect(selector).toHaveValue("")
    expect(within(selector).getByRole("option", { name: "Per spectrum" })).toHaveProperty("selected", true)
    expect(within(selector).queryByRole("option", { name: /Auto/ })).not.toBeInTheDocument()
    fireEvent.change(selector, { target: { value: "2" } })
    expect(plotProps().kWeight).toBe(2)
    fireEvent.change(selector, { target: { value: "" } })
    expect(plotProps().kWeight).toBeNull()
    expect(vi.mocked(AthenaWavelet).mock.calls.at(-1)?.[0].kWeight).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
    expect(project).toEqual(before)
  })

  it("keeps active selection independent of marks and the plot target", async () => {
    const project = await openSaved()
    const scope = within(screen.getByRole("radiogroup", { name: "Plot spectra" }))
    expect(scope.getByRole("radio", { name: "All selected" })).toBeChecked()
    expect(plotProps().plotScope).toBe("selected")
    selectGroup("Unused reference")

    expect(plotProps().active?.id).toBe("unused")
    expect(plotProps().groups.map(g => g.id)).toEqual(["sample", "oxide"])
    expect(screen.getByRole("checkbox", { name: "Mark Unused reference" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Mark Sample scan" })).toBeChecked()
    expect(api).toHaveBeenCalledTimes(1)

    fireEvent.click(scope.getByRole("radio", { name: "Current spectrum" }))
    expect(scope.getByRole("radio", { name: "Current spectrum" })).toBeChecked()
    expect(plotProps().plotScope).toBe("current")
    expect(plotProps().groups.map(g => g.id)).toEqual(["unused"])
    selectGroup("Foil scan")
    expect(plotProps().groups.map(g => g.id)).toEqual(["foil"])
    expect(screen.getByRole("checkbox", { name: "Mark Foil scan" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Mark Sample scan" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Mark Oxide standard" })).toBeChecked()
    expect(api).toHaveBeenCalledTimes(1)

    fireEvent.click(scope.getByRole("radio", { name: "All selected" }))
    expect(plotProps().groups.map(g => g.id)).toEqual(["sample", "oxide"])
    const next = nextProject(project, { sample: { marked: false } })
    api.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark Sample scan" }))
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Mark Sample scan" })).toBeEnabled())

    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "metadata", group_ids: ["sample"], options: { marked: false },
      response_mode: "selection",
    })
    expect(plotProps().active?.id).toBe("foil")
    expect(plotProps().groups.map(g => g.id)).toEqual(["oxide"])
  })

  it("removes the Apply button and discards a pending edit before its debounce expires", async () => {
    const project = await openSaved()
    expect(screen.queryByRole("button", { name: /^Apply parameters$/i })).not.toBeInTheDocument()
    vi.useFakeTimers()

    editNumber(/^Rbkg/, 2.1)
    expect(screen.getByRole("button", { name: /discard parameter changes/i })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /discard parameter changes/i }))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })

    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])
    expect(screen.queryByTitle("Pending automatic processing")).not.toBeInTheDocument()
  })

  it("debounces rapid edits into one sparse automatic patch", async () => {
    const project = await openSaved()
    const next = nextProject(project, { foil: { parameters: { ...parameters, rbkg: 2.3, e0: null } } })
    api.mockResolvedValueOnce(next)
    vi.useFakeTimers()

    editNumber(/^Rbkg/, 2.1)
    editNumber(/^Rbkg/, 2.3)
    editNumber(/^E₀/, "")
    expect(api).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(399) })
    expect(api).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { e0: null, rbkg: 2.3 },
    })
    expect(plotProps().active).toEqual(next.groups[0])
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
  })

  it.each(["blur", "Enter"] as const)("waits for a focused numeric field to commit with %s before starting the debounce", async commit => {
    const project = await openSaved()
    const next = nextProject(project, { foil: { parameters: { ...parameters, rbkg: 2.3 } } })
    api.mockResolvedValueOnce(next)
    vi.useFakeTimers()
    const input = screen.getByRole("spinbutton", { name: /^Rbkg/ })

    act(() => input.focus())
    editNumber(/^Rbkg/, 2.3)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])

    if (commit === "Enter") fireEvent.keyDown(input, { key: "Enter" })
    else fireEvent.blur(input)
    await act(async () => { await vi.advanceTimersByTimeAsync(399) })
    expect(api).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { rbkg: 2.3 },
    })
    expect(plotProps().active).toEqual(next.groups[0])
  })

  it("blocks project-changing actions while an automatic parameter update is pending", async () => {
    const project = await openSaved(projectFixture({ undo: ["before edit"] }))
    vi.useFakeTimers()
    editNumber(/^Rbkg/, 2.2)

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled()
    expect(screen.getByRole("button", { name: project.name })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^Open project$/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Import data" })).toBeDisabled()
    fireEvent.click(within(screen.getByRole("navigation", { name: /main menu/i })).getByRole("button", { name: "File" }))
    expect(screen.getByRole("button", { name: "New project" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^Open project…$/i })).toBeDisabled()
    expect(api.mock.calls).toEqual([[`/projects/${project.id}`]])

    fireEvent.click(screen.getByRole("button", { name: /discard parameter changes/i }))
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled()
    expect(screen.getByRole("button", { name: /^Open project$/i })).toBeEnabled()
  })

  it("keeps each switched group's target and rebases queued edits against the accepted revision", async () => {
    const project = await openSaved()
    const first = deferred<AthenaProject>()
    const afterFoil = nextProject(project, {
      foil: { parameters: { ...parameters, rbkg: 2.3 } },
      sample: { parameters: { ...project.groups[1].parameters, e0: 8991 } },
    })
    const afterSample = nextProject(afterFoil, {
      sample: { parameters: { ...afterFoil.groups[1].parameters, rbkg: 1.9 } },
    })
    api.mockReturnValueOnce(first.promise).mockResolvedValueOnce(afterSample)
    vi.useFakeTimers()

    editNumber(/^Rbkg/, 2.3)
    selectGroup("Sample scan")
    editNumber(/^Rbkg/, 1.9)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    expect(api).toHaveBeenCalledTimes(2)
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { rbkg: 2.3 },
    })
    await act(async () => { first.resolve(afterFoil); await Promise.resolve() })
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8991)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.9)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    expect(api).toHaveBeenCalledTimes(3)
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: afterFoil.version, action: "parameters", group_ids: ["sample"], options: { rbkg: 1.9 },
    })
    expect(plotProps().active).toEqual(afterSample.groups[1])
  })

  it("snapshots marked IDs and the source when automatic copying is queued", async () => {
    const initial = projectFixture()
    initial.groups[0].parameters.energy_shift = 7
    initial.groups[1].parameters.energy_shift = -3
    initial.groups[2].parameters.energy_shift = 5
    initial.groups[2].frozen = true
    const project = await openSaved(initial)
    const applied = { ...project.groups[0].parameters, rbkg: 2.2, energy_shift: 9 }
    const next = nextProject(project, { sample: { parameters: { ...applied, energy_shift: -3 } } })
    next.last_operation = { action: "copy_parameters", skipped_group_ids: ["oxide"] }
    api.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole("checkbox", { name: /^Apply to marked groups/i }))
    expect(screen.getByText(/Frozen groups are skipped.*Energy shifts are preserved/i)).toBeVisible()
    editNumber(/^Rbkg/, 2.2)
    editNumber(/^Energy shift/, 9)
    selectGroup("Unused reference")

    await waitForCommand(project.id, {
      version: project.version, action: "copy_parameters", group_ids: ["sample", "oxide"],
      options: { source_id: "foil", section: "all", values: applied },
    })
    expect(plotProps().active).toEqual(next.groups[3])
    expect(screen.getByRole("status")).toHaveTextContent("1 group skipped")
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.2)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(-3)
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.2)
    expect(screen.getByRole("button", { name: /discard parameter changes/i })).toBeVisible()
    selectGroup("Oxide standard")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1.4)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(5)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toBeDisabled()
    expect(plotProps().active).toEqual(project.groups[2])
  })

  it("retains a failed draft without a retry loop and retries it explicitly without another edit", async () => {
    const project = await openSaved()
    api.mockRejectedValueOnce(new ApiRequestError({
      code: "invalid_parameters", message: "Spline range cannot be processed", fields: ["rbkg"],
      recovery: "Review the spline settings.",
    }, 422))
    vi.useFakeTimers()
    editNumber(/^Rbkg/, 2.4)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    expect(screen.getByRole("alert")).toHaveTextContent("Spline range cannot be processed")
    expect(plotProps().active).toEqual(project.groups[0])
    expect(plotProps().groups).toEqual(project.groups.filter(g => g.marked))
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.4)
    expect(screen.getByRole("button", { name: /discard parameter changes/i })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Retry processing" })).toBeEnabled()
    expect(localStorage.getItem(storageKey)).toBe(project.id)
    expect(api).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(api).toHaveBeenCalledTimes(2)

    const next = nextProject(project, { foil: { parameters: { ...parameters, rbkg: 2.4 } } })
    api.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole("button", { name: "Retry processing" }))
    await act(async () => { await vi.advanceTimersByTimeAsync(399) })
    expect(api).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(plotProps().active).toEqual(next.groups[0])
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
    const next = nextProject(project, {
      foil: { parameters: { ...project.groups[0].parameters, energy_shift: 5, e0: 8983 } },
    })
    api.mockResolvedValueOnce(next)
    editNumber(/^Energy shift/, 5)
    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { energy_shift: 5 },
    })
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8983)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(5)
    expect(plotProps().active).toEqual(next.groups[0])
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
  })

  it("includes a deliberately changed E0 with the energy shift in the same patch", async () => {
    const project = await openSaved()
    const next = nextProject(project, { foil: { parameters: { ...parameters, energy_shift: 5, e0: 8990 } } })
    api.mockResolvedValueOnce(next)
    editNumber(/^Energy shift/, 5)
    editNumber(/^E₀/, 8990)
    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: { e0: 8990, energy_shift: 5 },
    })
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8990)
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
  })

  it("offers explicit empty-patch reprocessing only for a spectrum with a processing error", async () => {
    const initial = projectFixture()
    initial.groups[0].processing_error = "A removed background standard requires reprocessing."
    const project = await openSaved(initial)
    const next = nextProject(project, { foil: { processing_error: null } })
    api.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole("button", { name: "Reprocess spectrum" }))

    await waitForCommand(project.id, {
      version: project.version, action: "parameters", group_ids: ["foil"], options: {},
    })
    expect(plotProps().active).toEqual(next.groups[0])
    expect(screen.queryByRole("button", { name: "Reprocess spectrum" })).not.toBeInTheDocument()
  })
})

describe("AthenaWorkbench parameter copy and reset", () => {
  it("serializes pending edits before copying a section and preserves skipped-group values", async () => {
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
    const processed = await finishParameterDrafts(project, [
      { groupId: "unused", options: { rbkg: 4 } },
      { groupId: "sample", options: { e0: null, energy_shift: 6 } },
      { groupId: "foil", options: { e0: 8982, rbkg: 2.3 } },
    ])
    const draft = processed.groups[0].parameters
    const next = nextProject(processed, {
      sample: { parameters: { ...processed.groups[1].parameters, rbkg: 2.3 } },
    })
    next.last_operation = { action: "copy_parameters", skipped_group_ids: ["oxide", "unused"] }
    const dialog = await openParameterDialog("background", "all")
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /^Copy parameters$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: processed.version, action: "copy_parameters", group_ids: project.groups.map(g => g.id),
      options: { source_id: "foil", section: "background", values: draft },
    })
    expect(screen.getByRole("status")).toHaveTextContent("2 groups skipped")
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8982)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.3)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8979)
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(6)
    expect(plotProps().active!.parameters.e0).toBeNull()
    selectGroup("Unused reference")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(4)
    expect(plotProps().active).toEqual(next.groups[3])
    selectGroup("Oxide standard")
    expect(plotProps().active).toEqual(next.groups[2])
  })

  it("copies an explicitly selected energy shift without changing other processed fields", async () => {
    const project = await openSaved()
    selectGroup("Sample scan")
    editNumber(/^Rbkg/, 4)
    editNumber(/^Energy shift/, 6)
    selectGroup("Foil scan")
    editNumber(/^Rbkg/, 2.4)
    editNumber(/^Energy shift/, 9)
    const processed = await finishParameterDrafts(project, [
      { groupId: "sample", options: { rbkg: 4, energy_shift: 6 } },
      { groupId: "foil", options: { rbkg: 2.4, energy_shift: 9 } },
    ])
    const dialog = await openParameterDialog("single")
    fireEvent.change(within(dialog).getByRole("combobox", { name: /^Parameter$/ }), { target: { value: "energy_shift" } })
    expect(within(dialog).getByText(/Energy shift is explicitly selected and will change/i)).toBeVisible()
    const next = nextProject(processed, {
      sample: { parameters: { ...processed.groups[1].parameters, energy_shift: 9 } },
      oxide: { parameters: { ...processed.groups[2].parameters, energy_shift: 9 } },
    })
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /^Copy parameters$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: processed.version, action: "copy_parameters", group_ids: ["sample", "oxide"],
      options: { source_id: "foil", parameter: "energy_shift", values: { ...parameters, rbkg: 2.4, energy_shift: 9 } },
    })
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(9)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(4)
    expect(plotProps().active?.parameters.rbkg).toBe(4)
  })

  it("processes pending values before resetting all parameters to returned defaults", async () => {
    const initial = projectFixture()
    initial.groups[0].parameters.energy_shift = 4.5
    const project = await openSaved(initial)
    editNumber(/^Rbkg/, 2.9)
    editNumber(/^Energy shift/, 6)
    const processed = await finishParameterDrafts(project, [{ groupId: "foil", options: { energy_shift: 6, rbkg: 2.9 } }])
    const dialog = await openParameterDialog("all", "current")
    const defaults = { ...processed.groups[0].parameters, e0: null, rbkg: 1, energy_shift: 4.5 }
    const next = nextProject(processed, { foil: { parameters: defaults } })
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /reset to defaults/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: processed.version, action: "reset_parameters", group_ids: ["foil"], options: { section: "all" },
    })
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8979)
    expect(plotProps().active!.parameters.e0).toBeNull()
    expect(screen.getByRole("spinbutton", { name: /^Energy shift/ })).toHaveValue(4.5)
    expect(plotProps().active?.parameters.energy_shift).toBe(4.5)
    expect(screen.queryByRole("button", { name: /discard parameter changes/i })).not.toBeInTheDocument()
  })

  it("resets a single parameter on marked groups without changing the source or frozen saved values", async () => {
    const project = await openSaved()
    selectGroup("Oxide standard")
    editNumber(/^Rbkg/, 4)
    const oxideApplied = await finishParameterDrafts(project, [{ groupId: "oxide", options: { rbkg: 4 } }])
    const frozen = nextProject(oxideApplied, { oxide: { frozen: true } })
    api.mockResolvedValueOnce(frozen)
    fireEvent.click(screen.getByRole("button", { name: /^Freeze group$/i }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Unfreeze group$/i })).toBeEnabled())
    selectGroup("Foil scan")
    editNumber(/^Rbkg/, 2.9)
    const processed = await finishParameterDrafts(frozen, [{ groupId: "foil", options: { rbkg: 2.9 } }])
    const dialog = await openParameterDialog("single")
    const next = nextProject(processed, { sample: { parameters: { ...processed.groups[1].parameters, rbkg: 1 } } })
    next.last_operation = { action: "reset_parameters", skipped_group_ids: ["oxide"] }
    api.mockResolvedValueOnce(next)

    fireEvent.click(within(dialog).getByRole("button", { name: /reset to defaults/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: processed.version, action: "reset_parameters", group_ids: ["sample", "oxide"], options: { parameter: "rbkg" },
    })
    expect(screen.getByRole("status")).toHaveTextContent("1 group skipped")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.9)
    selectGroup("Sample scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(1)
    selectGroup("Oxide standard")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(4)
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toBeDisabled()
    expect(plotProps().active?.parameters.rbkg).toBe(4)
  })

  it("keeps section reset inputs after a failure and retries the same accepted revision", async () => {
    const project = await openSaved()
    editNumber(/^Rbkg/, 2.9)
    const applied = await finishParameterDrafts(project, [{ groupId: "foil", options: { rbkg: 2.9 } }])
    const dialog = await openParameterDialog("normalization", "all")
    api.mockRejectedValueOnce(new Error("Reset could not be processed"))
    fireEvent.click(within(dialog).getByRole("button", { name: /reset to defaults/i }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Reset could not be processed")
    expect(within(dialog).getByRole("combobox", { name: "Parameters to change" })).toHaveValue("normalization")
    expect(within(dialog).getByRole("combobox", { name: "Destination groups" })).toHaveValue("all")
    expect(plotProps().active).toEqual(applied.groups[0])
    const next = { ...applied, version: applied.version + 1, groups: applied.groups.map(g => ({
      ...g, parameters: { ...g.parameters, e0: null },
    })) }
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: /reset to defaults/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    const expected = [`/projects/${project.id}/command`, {
      version: applied.version, action: "reset_parameters", group_ids: project.groups.map(g => g.id), options: { section: "normalization" },
    }]
    expect(api.mock.calls.slice(-2)).toEqual([expected, expected])
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.9)
    expect(screen.getByRole("spinbutton", { name: /^E₀/ })).toHaveValue(8979)
    expect(plotProps().active!.parameters.e0).toBeNull()
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

function serveMerge(project:AthenaProject){
  api.mockImplementation(async(path,body)=>{
    if(path==='/preferences/merge')return mergeDefaults
    const r=body as {group_ids:string[];options:MergePreview['options']}
    const v=mergePreview(project,r.group_ids,r.options)
    return path.endsWith('/command')?mergeSaved(project,v):v
  })
}
async function readyMerge(dialog:HTMLElement){await waitFor(()=>expect(within(dialog).getByRole('button',{name:'Save merged groups'})).toBeEnabled(),{timeout:2500})}
async function saveMerge(dialog:HTMLElement){fireEvent.click(within(dialog).getByRole('button',{name:'Save merged groups'}));await within(dialog).findByText('Merge saved. The source spectra are unchanged.');fireEvent.click(within(dialog).getByRole('button',{name:'Close merge result'}))}

describe("AthenaWorkbench weighted combinations", () => {
  it('opens each native merge shortcut in its requested space and ignores text editing',async()=>{
    const project=await openSaved();serveMerge(project)
    fireEvent.keyDown(screen.getByRole('textbox',{name:'Search groups'}),{key:'M',ctrlKey:true,shiftKey:true})
    expect(screen.queryByRole('dialog',{name:'Merge marked groups'})).not.toBeInTheDocument()
    for(const [key,array] of [['M','mu'],['N','norm'],['C','chi']]){
      fireEvent.keyDown(document.body,{key,ctrlKey:true,shiftKey:true})
      const dialog=await screen.findByRole('dialog',{name:'Merge marked groups'})
      expect(within(dialog).getByLabelText('Merge as')).toHaveValue(array)
      fireEvent.keyDown(document.body,{key:'M',ctrlKey:true,shiftKey:true})
      expect(within(dialog).getByLabelText('Merge as')).toHaveValue(array)
      fireEvent.click(within(dialog).getByRole('button',{name:'Cancel merge'}))
    }
  })
  it("keeps relative merge weights paired with marked IDs in the saved list order", async () => {
    const initial=projectFixture();initial.groups=[initial.groups[0],initial.groups[2],initial.groups[1],initial.groups[3]]
    const project=await openSaved(initial);serveMerge(project);selectGroup('Unused reference')
    const dialog=await openTool('Process',/merge marked groups/i)
    fireEvent.change(within(dialog).getByLabelText('Merge as'),{target:{value:'norm'}})
    editNumber(/^Importance: Oxide standard$/,3,dialog);editNumber(/^Importance: Sample scan$/,1,dialog);await readyMerge(dialog)
    await saveMerge(dialog)
    expect(api.mock.calls.findLast(([path])=>path.endsWith('/command'))?.[1]).toEqual(expect.objectContaining({action:'merge',group_ids:['oxide','sample'],options:expect.objectContaining({method:'demeter-larch',array:'norm',weights:{oxide:3,sample:1}})}))
    expect(plotProps().active?.id).toBe('merged-0')
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

  it.each([{weights:[-1,1]},{weights:[0,0]}])('rejects invalid merge weights $weights and preserves inputs for retry',async({weights})=>{
    const project=await openSaved()
    const applied=nextProject(project,{foil:{parameters:{...project.groups[0].parameters,rbkg:2.9}}})
    api.mockResolvedValueOnce(applied);editNumber(/^Rbkg/,2.9)
    await waitForCommand(project.id,{version:project.version,action:'parameters',group_ids:['foil'],options:{rbkg:2.9}})
    serveMerge(applied)
    const dialog=await openTool('Process',/merge marked groups/i)
    editNumber(/^Importance: Sample scan$/,weights[0],dialog);editNumber(/^Importance: Oxide standard$/,weights[1],dialog)
    if(weights[0]===0)expect(await within(dialog).findByRole('alert')).toHaveTextContent('positive total')
    expect(within(dialog).getByRole('button',{name:'Save merged groups'})).toBeDisabled()
    expect(within(dialog).getByLabelText('Importance: Sample scan')).toHaveValue(weights[0])
    expect(api.mock.calls.some(([path,body])=>path.endsWith('/command')&&(body as {action?:string}|undefined)?.action==='merge')).toBe(false)
    editNumber(/^Importance: Sample scan$/,3,dialog);editNumber(/^Importance: Oxide standard$/,1,dialog);await readyMerge(dialog);await saveMerge(dialog)
    selectGroup('Foil scan');expect(screen.getByRole('spinbutton',{name:/^Rbkg/})).toHaveValue(2.9)
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

  it('offers chi for marked processed EXAFS with overlapping grids, including mixed input types',async()=>{
    const initial=withExafs(projectFixture());initial.groups[2].data_type='chi'
    const project=await openSaved(initial);serveMerge(project);const dialog=await openTool('Process',/merge marked groups/i)
    fireEvent.change(within(dialog).getByLabelText('Merge as'),{target:{value:'chi'}});await readyMerge(dialog);await saveMerge(dialog)
    expect(api.mock.calls.findLast(([path])=>path.endsWith('/command'))?.[1]).toEqual(expect.objectContaining({group_ids:['sample','oxide'],options:expect.objectContaining({array:'chi',weights:{sample:1,oxide:1}})}))
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

  it("previews marked differences after processing edits and preserves source data on save", async () => {
    const initial = projectFixture()
    initial.groups[1].frozen = true
    const project = await openSaved(initial)
    editNumber(/^Rbkg/, 2.7)
    selectGroup("Oxide standard"); editNumber(/^Rbkg/, 3.1)
    const processed = await finishParameterDrafts(project, [
      { groupId: "foil", options: { rbkg: 2.7 } },
      { groupId: "oxide", options: { rbkg: 3.1 } },
    ])
    const dialog = await openTool("Process", /difference spectrum/i)
    const view = within(dialog)
    fireEvent.change(view.getByRole("combobox", { name: "STANDARD" }), { target: { value: "unused" } })
    fireEvent.change(view.getByRole("combobox", { name: "DATA targets" }), { target: { value: "marked" } })
    const preview = differencePreview(processed, ["sample", "oxide"], { standard_id: "unused" })
    api.mockResolvedValueOnce(preview)
    fireEvent.click(view.getByRole("button", { name: "Preview difference" }))
    await waitFor(() => expect(view.getByRole("button", { name: "Save difference groups" })).toBeEnabled())
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: processed.version, action: "difference", group_ids: ["sample", "oxide"], options: preview.options })
    expect(plotProps().active?.parameters.rbkg).toBe(3.1)
    const next = differenceSaved(processed, preview)
    api.mockResolvedValueOnce(next)
    fireEvent.click(view.getByRole("button", { name: "Save difference groups" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(plotProps().active?.id).toBe("diff-oxide")
    selectGroup("Sample scan")
    expect(plotProps().active).toBe(processed.groups[1])
    expect(plotProps().active?.frozen).toBe(true)
    selectGroup("Oxide standard")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(3.1)
    expect(plotProps().active?.result?.arrays).toBe(project.groups[2].result?.arrays)
    selectGroup("Foil scan")
    expect(screen.getByRole("spinbutton", { name: /^Rbkg/ })).toHaveValue(2.7)
    expect(api).toHaveBeenCalledTimes(5)
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
    editNumber(/^Calibrate to/, 8980, dialog)
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel calibration$/i }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(1)

    dialog = await openTool("Process", /calibrate energy/i)
    editNumber(/^Observed reference/, 8978, dialog)
    editNumber(/^Calibrate to/, 8979, dialog)
    const options={coordinate:'displayed',observed:8978,target:8979,display:'derivative',smoothing:0,smoothing_method:'three_point'}
    api.mockResolvedValueOnce({project_id:project.id,version:project.version,group_id:'unused',options,requested_options:options,
      curve:{x:project.groups[3].energy,y:[0,.1,0],unsmoothed:[0,.1,0],marker:{x:8978,y:.09},range:[8948,9028],smoothing:{}},
      energy_shift:1,shift_delta:1,actual_reference:8979,zero_crossing:null,atomic_target:null,
      changes:[{group_id:'unused',label:'Unused reference',e0:8979,energy_shift:1}],processing_errors:{}})
    await waitFor(()=>expect(within(dialog).getByRole('button',{name:'Calibrate'})).toBeEnabled())
    const next = nextProject(project, { unused: { parameters: { ...parameters, rbkg: 1.6, e0:8979, energy_shift: 1 } } })
    api.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole("button", { name: /^Calibrate$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, expect.objectContaining({
      version: project.version, action: "calibrate", group_ids: ["unused"],
      options: expect.objectContaining({ observed: 8978, target: 8979 }),
    }))
    expect(plotProps().active).toEqual(next.groups[3])
  })

  it('merges marked groups in list order and selects the returned derived group',async()=>{
    const project=await openSaved();serveMerge(project);const dialog=await openTool('Process',/merge marked groups/i)
    expect(within(dialog).getByLabelText('Merge as')).toHaveValue('mu')
    expect(within(dialog).getByLabelText('Importance: Sample scan')).toHaveValue(1)
    await readyMerge(dialog);await saveMerge(dialog)
    expect(api.mock.calls.findLast(([path])=>path.endsWith('/command'))?.[1]).toEqual(expect.objectContaining({version:project.version,action:'merge',group_ids:['sample','oxide'],options:expect.objectContaining({method:'demeter-larch',array:'mu'})}))
    expect(plotProps().active?.id).toBe('merged-0')
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


describe("AthenaWorkbench import preprocessing", () => {
  it("retains standard choices and marking across a failed batch retry, then resets marking for a new selection", async () => {
    const project = await openSaved()
    const inspections = ['one.dat', 'two.dat'].map(name => inspectionFixture(name))
    const { dialog } = await chooseImportFiles(inspections)
    fireEvent.change(within(dialog).getByLabelText('Preprocessing standard'), { target: { value: 'foil' } })
    fireEvent.click(within(dialog).getByLabelText('Set parameters to the standard'))
    fireEvent.click(within(dialog).getByLabelText('Align to the standard'))
    fireEvent.click(within(dialog).getByLabelText('Mark each imported sample'))
    const afterFirst = importedProject(project, 'one.dat'), afterSecond = importedProject(afterFirst, 'two.dat')
    api.mockResolvedValueOnce(afterFirst).mockResolvedValueOnce(inspections[1]).mockRejectedValueOnce(new Error('Alignment needs overlap'))
    submitImport(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Alignment needs overlap')
    expect(within(dialog).getByLabelText('Mark each imported sample')).toBeChecked()
    expect(within(dialog).getByLabelText('Preprocessing standard')).toHaveValue('foil')
    api.mockResolvedValueOnce(afterSecond)
    submitImport(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const expected = { standard_id: 'foil', copy_parameters: true, align: true, mark: true }
    expect(importCalls()).toHaveLength(3)
    for (const [, body] of importCalls()) expect(body).toMatchObject({ preprocessing: expected })
    expect(importCalls()[1]).toEqual(importCalls()[2])
    const fresh = await chooseImportFiles([inspectionFixture('fresh.dat')])
    expect(within(fresh.dialog).getByLabelText('Mark each imported sample')).not.toBeChecked()
    expect(within(fresh.dialog).getByLabelText('Preprocessing standard')).toHaveValue('foil')
    expect(within(fresh.dialog).getByLabelText('Set parameters to the standard')).toBeChecked()
    expect(within(fresh.dialog).getByLabelText('Align to the standard')).toBeChecked()
  })
})

describe('Athena data-type correction', () => {
  async function dialog() {
    openGroupMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Change data type…' }))
    return screen.findByRole('dialog', { name: 'Change data type' })
  }
  it.each([
    ['current', ['foil']], ['marked', ['sample', 'oxide']], ['all', ['foil', 'sample', 'oxide', 'unused']],
  ] as const)('changes %s groups after processing pending recipe edits', async (scope, ids) => {
    const p = await openSaved()
    editNumber(/^Rbkg/, 1.9)
    const applied = await finishParameterDrafts(p, [{ groupId: 'foil', options: { rbkg: 1.9 } }])
    const next = nextProject(applied, Object.fromEntries(ids.map(id => [id, { data_type: 'xanes' }])))
    api.mockResolvedValueOnce(next)
    const panel = await dialog()
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Change data type for' }), { target: { value: scope } })
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Change data type to' }), { target: { value: 'xanes' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Change data type' }))
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${p.id}/command`, {
      version: applied.version, action: 'change_datatype', group_ids: [...ids], options: { data_type: 'xanes' },
    }))
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Close' })).toBeEnabled())
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('spinbutton', { name: /^Rbkg/ })).toHaveValue(1.9)
    expect(plotProps().active?.data_type).toBe(scope === 'marked' ? 'mu' : 'xanes')
    expect(plotProps().space).toBe('E')
  })
  it.each(['xanes', 'chi'] as const)('disables only the parameter sections unavailable for %s', async type => {
    const p = projectFixture(); p.groups[0].data_type = type
    await openSaved(p)
    const e0 = screen.getByRole('spinbutton', { name: /^E₀/ })
    const rbkg = screen.getByRole('spinbutton', { name: /^Rbkg/ })
    const kmin = screen.getByRole('spinbutton', { name: /^FT k min/ })
    if (type === 'chi') { expect(e0).toBeDisabled(); expect(kmin).toBeEnabled() }
    else { expect(e0).toBeEnabled(); expect(kmin).toBeDisabled() }
    expect(rbkg).toBeDisabled()
  })
  it('cancels without writes and lets the user choose another current group', async () => {
    await openSaved()
    const panel = await dialog(); const calls = api.mock.calls.length
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Current group' }), { target: { value: 'sample' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    expect(api).toHaveBeenCalledTimes(calls)
    expect(plotProps().active?.id).toBe('sample')
  })
  it('lists unsupported groups, blocks empty scopes, and includes frozen energy records', async () => {
    const p = projectFixture(); p.groups[0].data_type = 'chi'; p.groups[1].data_type = 'xmudat'
    p.groups.forEach(g => { g.marked = false }); p.groups[2].frozen = true
    await openSaved(p); const panel = await dialog()
    const apply = within(panel).getByRole('button', { name: 'Change data type' })
    expect(apply).toBeDisabled()
    expect(within(panel).getByText(/skipped: χ\(k\) and FEFF/)).toBeVisible()
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Change data type for' }), { target: { value: 'marked' } })
    expect(apply).toBeDisabled()
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Change data type for' }), { target: { value: 'all' } })
    expect(within(panel).getByText('2 eligible of 4 selected groups')).toBeVisible()
    expect(apply).toBeEnabled()
  })
  it('shows a rejected request and retains the form for correction', async () => {
    await openSaved(); api.mockRejectedValueOnce(new Error('Project changed; reload first.'))
    const panel = await dialog()
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Change data type to' }), { target: { value: 'norm' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Change data type' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Project changed; reload first.')
    expect(within(panel).getByRole('combobox', { name: 'Change data type to' })).toHaveValue('norm')
    expect(plotProps().active?.data_type).toBe('mu')
  })
  it('reports dependent processing errors and prevents duplicate writes while processing', async () => {
    const p = await openSaved(); const response = deferred<AthenaProject>(); api.mockReturnValueOnce(response.promise)
    const panel = await dialog(); const button = within(panel).getByRole('button', { name: 'Change data type' })
    const before = api.mock.calls.length
    fireEvent.click(button); fireEvent.click(button)
    expect(api).toHaveBeenCalledTimes(before + 1)
    expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    const next = nextProject(p, { foil: { data_type: 'xanes' } })
    next.last_operation = { action: 'change_datatype', skipped_group_ids: [],
      datatype_results: [{ group_id: 'foil', label: 'Foil scan', previous_type: 'mu', data_type: 'xanes', is_normalized: false }],
      processing_errors: { sample: 'Background standard Foil scan has no usable chi(k).' } }
    await act(async () => response.resolve(next))
    expect(within(panel).getByText(/Sample scan: Background standard/)).toBeVisible()
  })
  it('Ctrl+Alt-click toggles a frozen normalized record without discarding its recipe', async () => {
    const p = projectFixture(); p.groups[0].data_type = 'norm'; p.groups[0].is_normalized = true; p.groups[0].frozen = true
    localStorage.setItem(storageKey, p.id); api.mockResolvedValueOnce(p)
    render(<AthenaWorkbench />)
    const label = await screen.findByRole('button', { name: 'Data type: Normalized μ(E)' })
    await waitFor(() => expect(label).toBeEnabled())
    api.mockResolvedValueOnce(nextProject(p, { foil: { data_type: 'xanes', is_normalized: true } }))
    fireEvent.click(label, { ctrlKey: true, altKey: true })
    await waitFor(() => expect(api).toHaveBeenLastCalledWith(`/projects/${p.id}/command`, {
      version: p.version, action: 'change_datatype', group_ids: ['foil'], options: { toggle: true },
    }))
    expect(await screen.findByRole('button', { name: 'Data type: Normalized XANES' })).toBeVisible()
    expect(plotProps().active?.frozen).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('AthenaWorkbench plot scope and processing lines', () => {
  function processedProject() {
    const project = projectFixture()
    for (const g of project.groups) Object.assign(g.result!.arrays, {
      mu: [...g.mu], pre_edge: [0.05, 0.06, 0.07], post_edge: [1, 1.1, 1.2], bkg: [0.1, 0.7, 1.05],
    })
    return project
  }

  it.each([
    ['classic', 'rgb(195, 123, 56)'],
    ['viridis', 'rgb(253, 231, 37)'],
  ] as const)('preserves the plotted color in the %s sidebar when an earlier group has no R data', async (palette, expectedColor) => {
    const missing = group('missing-r', 'Missing R', true)
    const visible = group('visible-r', 'Visible R', true)
    Object.assign(visible.result!.arrays, { r: [0, 1, 2], chir_mag: [0, 0.8, 0.2] })
    const project = projectFixture({ groups: [missing, visible] })
    const original = JSON.stringify(project)
    await openSaved(project)
    fireEvent.change(screen.getByRole('combobox', { name: 'Color legend' }), { target: { value: palette } })
    const swatch = (label: string) => screen.getByRole('checkbox', { name: `Mark ${label}` })
      .closest('.ath-group')!.querySelector<HTMLElement>('.ath-swatch')!
    expect(swatch('Visible R').style.background).toBe(expectedColor)

    fireEvent.click(screen.getByRole('tab', { name: /Fourier/ }))
    expect(plotProps().groups.map(g => g.id)).toEqual(['missing-r', 'visible-r'])
    expect(plotProps().colorSettings).toEqual({ palette, reversed: false })
    expect(swatch('Visible R').style.background).toBe(expectedColor)
    expect(swatch('Missing R').style.background).toBe('var(--ath-line)')
    expect(JSON.stringify(project)).toBe(original)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('defaults the q comparison to real while retaining independent R and q component choices', async () => {
    await openSaved()
    const chooseSpace = (name: RegExp) => fireEvent.click(within(screen.getByRole('tablist', { name: 'Plot space' })).getByRole('tab', { name }))
    const component = () => screen.getByRole('combobox', { name: 'Complex component' })

    chooseSpace(/Fourier/)
    expect(component()).toHaveValue('mag')
    expect(plotProps()).toMatchObject({ space: 'R', component: 'mag' })

    chooseSpace(/Back transform/)
    expect(component()).toHaveValue('re')
    expect(within(component()).getByRole('option', { name: 'Real part + χ(k)' })).toHaveProperty('selected', true)
    expect(plotProps()).toMatchObject({ space: 'q', component: 're' })
    fireEvent.change(component(), { target: { value: 'im' } })

    chooseSpace(/Fourier/)
    expect(component()).toHaveValue('mag')
    fireEvent.change(component(), { target: { value: 'pha' } })
    chooseSpace(/Back transform/)
    expect(component()).toHaveValue('im')
    expect(plotProps()).toMatchObject({ space: 'q', component: 'im' })
    fireEvent.change(component(), { target: { value: 're' } })
    chooseSpace(/Fourier/)
    expect(component()).toHaveValue('pha')
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('shows the full measured k extent in automatic q comparison limits', async () => {
    const spectrum = group('foil', 'Foil scan')
    Object.assign(spectrum.result!.arrays, {
      k: [0, 4, 8, 14], weighted_chi: [0, 1, -1, 2],
      q: [2, 4, 8], chiq_re: [0, 1, -1], chiq_im: [1, 0, -1],
    })
    await openSaved(projectFixture({ groups: [spectrum] }))
    fireEvent.click(screen.getByRole('tab', { name: /Back transform/ }))
    const minimum = () => screen.getByRole('spinbutton', { name: 'Plot minimum' })
    const maximum = () => screen.getByRole('spinbutton', { name: 'Plot maximum' })
    const component = screen.getByRole('combobox', { name: 'Complex component' })

    expect(minimum()).toHaveValue(0)
    expect(maximum()).toHaveValue(14)
    expect(plotProps().range).toEqual([null, null])

    fireEvent.change(component, { target: { value: 'im' } })
    expect(minimum()).toHaveValue(2)
    expect(maximum()).toHaveValue(8)
    fireEvent.change(component, { target: { value: 're' } })
    expect(maximum()).toHaveValue(14)

    fireEvent.change(maximum(), { target: { value: '11' } })
    expect(plotProps().range).toEqual([null, 11])
    fireEvent.change(maximum(), { target: { value: '' } })
    fireEvent.blur(maximum())
    expect(maximum()).toHaveValue(14)
    expect(plotProps().range).toEqual([null, null])
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('keeps spectrum display preferences while changing plot spaces', async () => {
    await openSaved()
    expect(plotProps()).toMatchObject({ showGrid: true, showDataPoints: false })
    act(() => plotProps().onShowGridChange?.(false))
    act(() => plotProps().onShowDataPointsChange?.(true))
    expect(plotProps()).toMatchObject({ showGrid: false, showDataPoints: true })
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Plot space' })).getByRole('tab', { name: /EXAFS/ }))
    expect(plotProps()).toMatchObject({ space: 'k', showGrid: false, showDataPoints: true })
  })

  it('places Show legend underneath Stack offset and keeps the toggle functional', async () => {
    await openSaved()
    const legend = screen.getByRole('checkbox', { name: 'Show legend' })
    const stackOffset = screen.getByRole('spinbutton', { name: 'Stack offset' })
    const controls = legend.closest('.ath-plot-display-controls')
    expect(controls).toBeInTheDocument()
    expect(Array.from(controls!.children)).toEqual([stackOffset.closest('label'), legend.closest('label')])
    expect(screen.getByRole('button', { name: 'Plot shortcuts…' }).closest('.ath-plot-top')).not.toContainElement(legend)
    expect(plotProps().showLegend).toBe(true)
    fireEvent.click(legend)
    expect(plotProps().showLegend).toBe(false)
  })

  it.each([
    { count: 0, scope: 'current', label: 'Current spectrum' },
    { count: 1, scope: 'current', label: 'Current spectrum' },
    { count: 2, scope: 'selected', label: 'All selected' },
  ] as const)('defaults to $label with $count imported spectra', async ({ count, scope, label }) => {
    const project = projectFixture()
    project.groups = project.groups.slice(0, count)
    await openSaved(project)

    expect(screen.getByRole('radio', { name: label })).toBeChecked()
    expect(plotProps().plotScope).toBe(scope)
  })

  it('switches from Current spectrum to All selected as a second spectrum is imported', async () => {
    const initial = projectFixture({ groups: [] })
    await openSaved(initial)
    expect(screen.getByRole('radio', { name: 'Current spectrum' })).toBeChecked()

    const first = inspectionFixture('first.dat')
    const second = inspectionFixture('second.dat')
    const { dialog } = await chooseImportFiles([first, second])
    const afterFirst = importedProject(initial, first.display_name)
    const afterSecond = importedProject(afterFirst, second.display_name)
    const secondInspection = deferred<InspectionResponse>()
    api.mockResolvedValueOnce(afterFirst).mockReturnValueOnce(secondInspection.promise)
    submitImport(dialog)

    await waitFor(() => expect(plotProps().active?.id).toBe(first.display_name))
    expect(screen.getByRole('radio', { name: 'Current spectrum' })).toBeChecked()
    expect(plotProps().plotScope).toBe('current')

    api.mockResolvedValueOnce(afterSecond)
    await act(async () => secondInspection.resolve(second))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /import spectra/i })).not.toBeInTheDocument())
    expect(screen.getByRole('radio', { name: 'All selected' })).toBeChecked()
    expect(plotProps().plotScope).toBe('selected')
  })

  it('leaves All selected empty when no groups are marked and can still plot the current spectrum', async () => {
    const project = projectFixture()
    for (const g of project.groups) g.marked = false
    await openSaved(project)

    expect(screen.getByRole('radio', { name: 'All selected' })).toBeChecked()
    expect(plotProps().groups).toEqual([])
    expect(plotProps().active?.id).toBe('foil')
    expect(screen.getByRole('spinbutton', { name: 'Plot minimum' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Plot maximum' })).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Current spectrum' }))
    expect(plotProps().groups.map(g => g.id)).toEqual(['foil'])
    expect(screen.getByRole('spinbutton', { name: 'Plot minimum' })).toHaveValue(-19)
    selectGroup('Unused reference')
    expect(plotProps().groups.map(g => g.id)).toEqual(['unused'])
    fireEvent.click(screen.getByRole('radio', { name: 'All selected' }))
    expect(plotProps().groups).toEqual([])
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('refreshes automatic plot limits for the scope and current spectrum while preserving explicit limits', async () => {
    const project = projectFixture()
    project.groups[0].result!.arrays.energy = [8900, 8980, 9050]
    project.groups[1].result!.arrays.energy = [8950, 8980, 9060]
    project.groups[2].result!.arrays.energy = [8920, 8980, 9080]
    await openSaved(project)
    const minimum = () => screen.getByRole('spinbutton', { name: 'Plot minimum' })
    const maximum = () => screen.getByRole('spinbutton', { name: 'Plot maximum' })

    expect(minimum()).toHaveValue(-59)
    expect(maximum()).toHaveValue(101)
    fireEvent.click(screen.getByRole('radio', { name: 'Current spectrum' }))
    expect(minimum()).toHaveValue(-79)
    expect(maximum()).toHaveValue(71)
    selectGroup('Sample scan')
    expect(minimum()).toHaveValue(-29)
    expect(maximum()).toHaveValue(81)
    expect(plotProps().range).toEqual([null, null])

    fireEvent.change(minimum(), { target: { value: '-14' } })
    fireEvent.click(screen.getByRole('radio', { name: 'All selected' }))
    expect(minimum()).toHaveValue(-14)
    expect(maximum()).toHaveValue(101)
    expect(plotProps().range).toEqual([8965, null])
  })

  it('controls pre-edge, post-edge and background independently and restores preferences when individual raw plotting resumes', async () => {
    await openSaved(processedProject())
    const pre = screen.getByRole('checkbox', { name: 'Pre-edge line' })
    const post = screen.getByRole('checkbox', { name: 'Post-edge line' })
    const background = screen.getByRole('checkbox', { name: 'Background' })
    for (const control of [pre, post, background]) {
      expect(control).not.toBeChecked()
      expect(control).toBeDisabled()
    }

    fireEvent.click(screen.getByRole('radio', { name: 'μ(E) · raw' }))
    expect(pre).toBeDisabled()
    expect(post).toBeDisabled()
    expect(background).toBeDisabled() // The active, unmarked foil is outside the selected plot.
    fireEvent.click(screen.getByRole('radio', { name: 'Current spectrum' }))
    for (const control of [pre, post, background]) expect(control).toBeEnabled()
    fireEvent.click(pre)
    expect(plotProps()).toMatchObject({ preEdge: true, postEdge: false, background: false })
    fireEvent.click(post)
    expect(plotProps()).toMatchObject({ preEdge: true, postEdge: true, background: false })
    fireEvent.click(pre)
    expect(plotProps()).toMatchObject({ preEdge: false, postEdge: true, background: false })
    fireEvent.click(background)
    expect(plotProps()).toMatchObject({ preEdge: false, postEdge: true, background: true })

    fireEvent.click(screen.getByRole('radio', { name: 'μ(E) · normalized' }))
    for (const control of [pre, post, background]) expect(control).toBeDisabled()
    expect(post).not.toBeChecked()
    expect(background).not.toBeChecked()
    expect(plotProps()).toMatchObject({ preEdge: false, postEdge: false, background: false })
    fireEvent.click(screen.getByRole('radio', { name: 'μ(E) · raw' }))
    expect(post).toBeChecked()
    expect(background).toBeChecked()
    expect(plotProps()).toMatchObject({ preEdge: false, postEdge: true, background: true })

    fireEvent.click(screen.getByRole('radio', { name: 'All selected' }))
    expect(post).toBeDisabled()
    expect(post).not.toBeChecked()
    expect(plotProps()).toMatchObject({ preEdge: false, postEdge: false, background: false })
    selectGroup('Sample scan')
    expect(background).toBeEnabled()
    expect(plotProps()).toMatchObject({ preEdge: false, postEdge: false, background: true })
    fireEvent.click(screen.getByRole('radio', { name: 'Current spectrum' }))
    expect(post).toBeEnabled()
    expect(post).toBeChecked()
    expect(plotProps()).toMatchObject({ preEdge: false, postEdge: true, background: true })
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('enables each processing line only when its current processed array is usable', async () => {
    const project = processedProject()
    delete project.groups[1].result!.arrays.pre_edge
    project.groups[1].result!.arrays.post_edge = [1, 2]
    project.groups[1].result!.arrays.bkg = []
    project.groups[2].result = null
    await openSaved(project)
    fireEvent.click(screen.getByRole('radio', { name: 'Current spectrum' }))
    fireEvent.click(screen.getByRole('radio', { name: 'μ(E) · raw' }))
    for (const label of ['Pre-edge line', 'Post-edge line', 'Background']) {
      const control = screen.getByRole('checkbox', { name: label })
      expect(control).toBeEnabled()
      fireEvent.click(control)
    }
    for (const label of ['Sample scan', 'Oxide standard']) {
      selectGroup(label)
      for (const line of ['Pre-edge line', 'Post-edge line', 'Background']) {
        expect(screen.getByRole('checkbox', { name: line })).toBeDisabled()
      }
      expect(plotProps()).toMatchObject({ preEdge: false, postEdge: false, background: false })
    }
    selectGroup('Foil scan')
    expect(plotProps()).toMatchObject({ preEdge: true, postEdge: true, background: true })
  })
})

it('lists every energy view directly beneath the plot and switches each plotted signal', async () => {
  await openSaved()
  const choices = screen.getByRole('radiogroup', { name: 'Energy plot' })
  expect(screen.queryByRole('combobox', { name: 'Energy plot' })).not.toBeInTheDocument()
  expect(screen.getByTestId('athena-plot').nextElementSibling).toBe(choices)
  expect(within(choices).getAllByRole('radio').map(radio => radio.getAttribute('value'))).toEqual(['mu', 'norm', 'flat', 'dmude', 'd2mude'])
  expect(within(choices).getByRole('radio', { name: 'μ(E) · normalized' })).toBeChecked()
  for (const [name, value] of [
    ['μ(E) · raw', 'mu'],
    ['μ(E) · normalized', 'norm'],
    ['μ(E) · flattened', 'flat'],
    ['Derivative dμ/dE', 'dmude'],
    ['Second derivative d²μ/dE²', 'd2mude'],
  ]) {
    const radio = within(choices).getByRole('radio', { name })
    fireEvent.click(radio)
    expect(radio).toBeChecked()
    expect(plotProps().energyMode).toBe(value)
  }
})

describe('Legacy detector records in the workbench', () => {
  it('uses raw count plots and keeps energy shifts editable without exposing absorption controls', async () => {
    const p = projectFixture(); p.groups[0].data_type = 'detector'
    p.groups[0].result = { arrays: { energy: p.groups[0].energy, mu: p.groups[0].mu }, effective: { e0: null, edge_step: null }, warnings: [] }
    await openSaved(p)
    expect(screen.getByRole('button', { name: 'Data type: Detector signal' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Detector signal' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Detector signal' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: /^E₀/ })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: /^Rbkg/ })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: /^FT k min/ })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: /^Energy shift/ })).toBeEnabled()
    expect(plotProps().energyMode).toBe('mu')
    selectGroup('Sample scan')
    expect(screen.getByRole('radio', { name: 'μ(E) · normalized' })).toBeChecked()
    expect(plotProps().energyMode).toBe('norm')
  })
  it('offers energy-type correction for a detector while retaining the three native destinations', async () => {
    const p = projectFixture(); p.groups[0].data_type = 'detector'; await openSaved(p)
    fireEvent.click(screen.getByRole('button', { name: 'Data type: Detector signal' }))
    const panel = await screen.findByRole('dialog', { name: 'Change data type' })
    expect(within(panel).getByText('1 eligible of 1 selected groups')).toBeVisible()
    expect(within(panel).getByRole('button', { name: 'Change data type' })).toBeEnabled()
    const select = within(panel).getByRole('combobox', { name: 'Change data type to' })
    expect(within(select).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['mu', 'xanes', 'norm'])
  })
})

it('hands the complete raw-file queue and staged native project to group selection without a second conversion', async () => {
  const project = await openSaved()
  fireEvent.click(screen.getByRole('button', { name: 'Import data' }))
  const files = [new File(['XDAC'], 'native.000'), new File(['next'], 'next.dat'), new File(['project'], 'last.prj')]
  const staged = { upload_id: 'native-project', filename: 'native.000', name: 'native', journal: '', warnings: [], groups: [] }
  api.mockResolvedValueOnce({ kind: 'project', preview: staged })
  fireEvent.change(screen.getByLabelText('Choose data files'), { target: { files } })
  await screen.findByTestId('project-import-panel')
  const props = projectImport.mock.calls.at(-1)![0]
  expect(props.initialFiles).toEqual(files)
  expect(props.initialPreview).toEqual(staged)
  expect(props.getProject()).toBe(project)
  expect(api.mock.calls.filter(([path]) => path.endsWith('/inspect'))).toHaveLength(1)
  expect(importCalls()).toHaveLength(0)
  expect(props.disabled).toBe(false)
})

it('stops raw batch reuse at a native project and forwards only the unimported tail', async () => {
  const project = await openSaved(), first = inspectionFixture('first.dat'), native = inspectionFixture('native.000'), tail = inspectionFixture('later.dat')
  const { dialog, files } = await chooseImportFiles([first, native, tail])
  const after = importedProject(project, first.display_name)
  const staged = { upload_id: 'native-project', filename: 'native.000', name: 'native', journal: '', warnings: [], groups: [] }
  api.mockResolvedValueOnce(after).mockResolvedValueOnce({ kind: 'project', preview: staged })
  submitImport(dialog)
  await screen.findByTestId('project-import-panel')
  const props = projectImport.mock.calls.at(-1)![0]
  expect(props.initialFiles).toEqual(files.slice(1))
  expect(props.initialPreview).toEqual(staged)
  expect(props.getProject()).toEqual(after)
  expect(importCalls()).toHaveLength(1)
  expect(props.disabled).toBe(false)
})

describe('Athena ZIP queue', () => {
  const archive = { kind: 'archive_list', upload_id: 'zip-upload', display_name: 'source.zip',
    file_plugin: { id: 'Zip', expanded_bytes: 30, directory_count: 0 },
    members: [{ index: 0, name: 'ignore.dat', bytes: 10, sha256: 'a' },
      { index: 1, name: 'projects/chosen.prj', bytes: 20, sha256: 'b' }] }
  async function choose(value = archive, tail: File[] = []) {
    fireEvent.click(screen.getByRole('button', { name: 'Import data' }))
    api.mockResolvedValueOnce(value)
    fireEvent.change(screen.getByLabelText('Choose data files'), { target: { files: [new File(['zip'], 'source.zip'), ...tail] } })
    const dialog = screen.getByRole('dialog', { name: 'Import spectra' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review selected files' })).toBeEnabled())
    return dialog
  }
  it('downloads only chosen members, in archive order, and hands projects and the external tail to group preview', async () => {
    const project = await openSaved(), tail = new File(['tail'], 'later.dat')
    const download = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('project'))
    try {
      const dialog = await choose(archive, [tail])
      fireEvent.click(within(dialog).getByLabelText('Include ignore.dat · entry 1'))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Review selected files' }))
      await screen.findByTestId('project-import-panel')
      expect(download).toHaveBeenCalledTimes(1)
      expect(download.mock.calls[0][0]).toContain(`/projects/${project.id}/archives/zip-upload/members/1`)
      const props = projectImport.mock.calls.at(-1)![0]
      expect(props.initialFiles?.map(f => f.name)).toEqual(['projects/chosen.prj', tail.name])
      expect(props.initialFiles?.[1]).toBe(tail)
      expect(props.disabled).toBe(false)
      expect(importCalls()).toHaveLength(0)
    } finally { download.mockRestore() }
  })
  it('retains selection after a failed member download and never stages a partially downloaded batch', async () => {
    await openSaved()
    const download = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('first')).mockResolvedValueOnce(new Response('', { status: 400 }))
    try {
      const dialog = await choose()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Review selected files' }))
      await within(dialog).findByRole('alert')
      expect(within(dialog).getByLabelText('Include ignore.dat · entry 1')).toBeChecked()
      expect(within(dialog).getByRole('button', { name: 'Review selected files' })).toBeEnabled()
      expect(api.mock.calls.filter(([p]) => p.endsWith('/inspect'))).toHaveLength(1)
      expect(importCalls()).toHaveLength(0)
      fireEvent.click(within(dialog).getByLabelText('Include ignore.dat · entry 1'))
      download.mockResolvedValueOnce(new Response('project'))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Review selected files' }))
      await screen.findByTestId('project-import-panel')
      expect(projectImport.mock.calls.at(-1)![0].initialFiles?.map(f => f.name)).toEqual(['projects/chosen.prj'])
    } finally { download.mockRestore() }
  })
  it('skips a failed raw file while keeping the following project and raw file', async () => {
    await openSaved()
    fireEvent.click(screen.getByRole('button', { name: 'Import data' }))
    const files = [new File(['notes'], 'readme.txt'), new File(['prj'], 'data.prj'), new File(['raw'], 'last.dat')]
    api.mockRejectedValueOnce(new Error('No numeric observations'))
    fireEvent.change(screen.getByLabelText('Choose data files'), { target: { files } })
    const dialog = screen.getByRole('dialog', { name: 'Import spectra' })
    await within(dialog).findByRole('alert')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip this file' }))
    await screen.findByTestId('project-import-panel')
    expect(projectImport.mock.calls.at(-1)![0].initialFiles).toEqual(files.slice(1))
    expect(importCalls()).toHaveLength(0)
  })
})
