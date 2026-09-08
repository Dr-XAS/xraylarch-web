import "@testing-library/jest-dom/vitest"
import { StrictMode } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { athenaApi, type Analysis, type AthenaGroup, type AthenaProject, type Parameters } from "@/lib/athena"
import { ApiRequestError } from "@/lib/backend-client"
import type { InspectionResponse } from "@/lib/contracts"
import { AthenaPlot } from "./athena-plot"
import { AthenaWorkbench } from "./athena-workbench"

vi.mock("@/lib/athena", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/athena")>(),
  athenaApi: vi.fn(),
}))

// Observe the workbench's data handoff without loading Plotly or testing its internals.
vi.mock("./athena-plot", () => ({
  AthenaPlot: vi.fn(() => <div data-testid="athena-plot" />),
}))

const api = vi.mocked(athenaApi)
const plot = vi.mocked(AthenaPlot)
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
  api.mockReset()
  api.mockRejectedValue(new Error("Unexpected Athena API request in test"))
  plot.mockClear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
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

describe("AthenaWorkbench group selection and drafts", () => {
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
    api.mockResolvedValueOnce(importedProject(project, "difference"))
    fireEvent.click(within(difference).getByRole("button", { name: /^Apply$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(api).toHaveBeenLastCalledWith(`/projects/${project.id}/command`, {
      version: project.version, action: "difference", group_ids: ["sample", "oxide"], options: {},
    })
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
