import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState, type ReactNode } from "react"
import { athenaApi, type AthenaGroup, type AthenaProject, type Parameters } from "@/lib/athena"
import { artemisApi, type ArtemisModelDraft, type ArtemisExample, type ArtemisExampleSetup, type ArtemisFitRequest, type ArtemisFitResult, type ArtemisInspectedPath } from "@/lib/artemis"
import type { ArtemisStructureAttachment } from "@/lib/artemis-structures"
import { ApiRequestError } from "@/lib/backend-client"
import { ArtemisFittingPanel, type ArtemisModelActions } from "./artemis-fitting"
import { ArtemisFitResultViewer } from "./artefact-viewers/artemis-fit-result-viewer"
import type { ArtemisPlotWeightResult } from "./artefact-viewers/artemis-plot-weight"

type PlotProps = { data: { x: number[]; y: number[]; name: string; visible?: boolean | "legendonly"; customdata: number[][]; hovertemplate: string; line: { color: string } }[]; layout: { xaxis: { title: { text: string } }; yaxis: { title: { text: string } }; shapes: { x0: number; x1: number }[]; uirevision: string }; onError: () => void }
const plot = vi.hoisted(() => vi.fn((_props: PlotProps) => <div data-testid="fit-plot" />))
vi.mock("next/dynamic", () => ({ default: () => plot }))
// Structure persistence and its modal lifecycle are covered in artemis-structures.test.tsx.
vi.mock("./artemis-structures", () => ({ ArtemisStructures: ({ children }: { children?: (sections: { structures: ReactNode; feff: ReactNode }) => ReactNode }) => children?.({ structures: <div data-testid="structures-launcher" />, feff: <div data-testid="feff-launcher" /> }) ?? <div data-testid="structures-launcher" /> }))
vi.mock("@/lib/artemis", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/artemis")>(), artemisApi: vi.fn() }))
vi.mock("@/lib/athena", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/athena")>(), athenaApi: vi.fn() }))
const api = vi.mocked(artemisApi)

const parameters: Parameters = {
  e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null,
  flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1,
  kmin: 3, kmax: 12, kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05,
}
function group(id = "copper"): AthenaGroup {
  return { id, label: `${id} foil`, marked: false, frozen: false, data_type: "mu", energy: [10, 20, 30], mu: [1, 2, 3],
    multiplier: 1, offset: 0, notes: "", reference_id: null, parameters: { ...parameters }, processing_error: null, source: {},
    result: { effective: { kweight: 2 }, warnings: [], arrays: { k: [0, 3, 6, 9, 12, 15], chi: [0, 2, -1, 1, -0.5, 0] } } }
}
function path(filename = "feff0001.dat", content = "real FEFF contents from selected file"): ArtemisInspectedPath {
  return { filename, content, metadata: { reff: 2.5527, degen: 12, nleg: 2, absorber: "Cu", edge: "K", geometry: [], kmin: 0, kmax: 20 } }
}
const cupriteAttachment: ArtemisStructureAttachment = {
  id: "cuprite-cif", amcsd_id: 15851, attached_at: "2026-09-22T00:00:00Z", sha256: "a".repeat(64),
  structure: {
    id: 15851, mineral: "Cuprite", formula: "Cu2 O", space_group: "P n 3 m", authors: "", year: 1930,
    journal: "", title: "Cuprite structure", cif: "data_Cuprite\n_cell_length_a 4.27", elements: ["Cu", "O"],
    sites: [{ index: 1, element: "Cu", species: "Cu", multiplicity: 4, wyckoff: "4b", x: 0.25, y: 0.25, z: 0.25, occupancy: 1 }],
    cell: { a: 4.27, b: 4.27, c: 4.27, alpha: 90, beta: 90, gamma: 90 }, ordered: true, supported: true, warnings: [],
  },
}
function attachedProject(version = 4): AthenaProject {
  return { id: "p", name: "Cuprite", version, groups: [group()], journal: "", updated: "now", undo: [], redo: [], history: [],
    artemis_structures: [cupriteAttachment] }
}
function acceptProject(_project: AthenaProject) {}
function example(): ArtemisExample {
  return { amcsd_id: 15851, cif_sha256: cupriteAttachment.sha256, feff_input: "TITLE Cuprite AMCSD 15851\nEDGE K",
    paths: [1, 2, 3, 4].map(index => path(`feff000${index}.dat`, `Cuprite FEFF path ${index}`)),
    description: "Cuprite Cu K-edge starter model with the first four FEFF paths.",
    parameters: [
      { name: "amp", kind: "guess", value: 1, expression: "", min: 0, max: 2 },
      { name: "del_e0", kind: "guess", value: 0, expression: "", min: -20, max: 20 },
      { name: "del_r", kind: "guess", value: 0, expression: "", min: -0.2, max: 0.2 },
      { name: "sig2", kind: "guess", value: 0.003, expression: "", min: 0, max: 0.1 },
    ], transform: { fitspace: "r", kmin: 3, kmax: 12, kweight: [0, 1, 2, 3], dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0 } }
}
function exampleSetup(): ArtemisExampleSetup {
  const model = example()
  return { projectId: "p", groupId: "cuprite", attachmentId: cupriteAttachment.id,
    example: { ...model, parameters: model.parameters.map(parameter => parameter.name === "amp" ? { ...parameter, value: 0.82 } : parameter),
      transform: { ...model.transform, kmin: 2, kmax: 10, rmin: 1.2, rmax: 3.4 } } }
}
function preparedExample(): ArtemisExampleSetup {
  return { projectId: "p", groupId: "copper", attachmentId: cupriteAttachment.id, example: example() }
}
function fitResult(overrides: Partial<ArtemisFitResult> = {}): ArtemisFitResult {
  return { project_id: "p", group_id: "copper", group_label: "copper foil", version: 4, success: true, message: "Fit succeeded.", report: "[[Fit Statistics]]\nR-factor = 0.003", warnings: [],
    statistics: { n_varys: 4, n_independent: 12.5, n_data: 40, nfev: 25, chi_square: 50, reduced_chi_square: 5.8, r_factor: 0.003, aic: 20, bic: 25, errorbars: true },
    parameters: example().parameters.map(parameter => ({ ...parameter, initial: parameter.value, stderr: 0.01 })),
    correlations: [{ left: "amp", right: "sig2", value: 0.9 }], paths: [{ id: "a", label: "Cu–Cu", filename: "feff0001.dat", metadata: path().metadata }],
    k: { x: [0, 3, 6, 9, 12, 15], data: [0, 2, -1, 1, -0.5, 0], model: [0, 1.9, -1.1, 1, -0.6, 0], residual: [0, 0.1, 0.1, 0, 0.1, 0], weight: 2 },
    r: { x: [0, 1, 2, 3], data_mag: [0, 2, 3, 1], model_mag: [0, 1.9, 2.9, 1], residual_mag: [0, 0.1, 0.2, 0],
      data_re: [0, 1, -2, 1], model_re: [0, 0.9, -1.9, 1], residual_re: [0, 0.1, -0.1, 0],
      data_im: [0, 2, -1, 0], model_im: [0, 1.9, -0.9, 0], residual_im: [0, 0.1, -0.1, 0] },
    transform: example().transform, ...overrides }
}
function resultWithPaths(): ArtemisFitResult {
  const result = fitResult()
  return { ...result, paths: [
    { ...result.paths[0], k: { chi: result.k.model.map(value => value * 0.6) },
      r: { mag: [0, 2.5, 2, 0.5], re: [0, 1.5, -1.2, 0.4], im: [0, 2, -0.6, 0.3] } },
    { ...result.paths[0], id: "b", filename: "feff0002.dat", k: { chi: result.k.model.map(value => value * 0.4) },
      r: { mag: [0, 0.6, 0.8, 0.7], re: [0, -0.6, -0.7, 0.6], im: [0, -0.1, -0.3, -0.3] } },
  ] }
}
function plotWeightResult(result: ArtemisFitResult, weight: number, version = 8): ArtemisPlotWeightResult {
  const shifted = (values: number[]) => values.map(value => value * 3)
  return { project_id: result.project_id, group_id: result.group_id, version, kweight: weight,
    k: { ...result.k, weight, data: shifted(result.k.data), model: shifted(result.k.model), residual: shifted(result.k.residual) },
    r: Object.fromEntries(Object.entries(result.r).map(([key, values]) => [key, key === "x" ? values : shifted(values)])) as ArtemisFitResult["r"],
    paths: result.paths.map(path => ({ id: path.id, k: path.k && { chi: shifted(path.k.chi) }, r: path.r && {
      mag: shifted(path.r.mag), re: shifted(path.r.re), im: shifted(path.r.im),
    } })), warnings: [] }
}
function file(name: string, contents: string) {
  const value = new File([contents], name)
  Object.defineProperty(value, "text", { value: () => Promise.resolve(contents) })
  return value
}
function savedFit(body: unknown, result = fitResult()) {
  const { version, model } = body as { version: number; model: ArtemisModelDraft }
  const project = attachedProject(version + 1)
  project.groups[0].artemis = { schema_version: 1, model, current_input_sha256: "a".repeat(64), history: [{
    id: "fit-one", created: "2026-09-28T12:00:00Z", input_sha256: "a".repeat(64), imported: false, model, result,
    origin: { project_id: "p", group_id: "copper", project_version: version, larch_version: "test" },
  }] }
  return { project, fit_id: "fit-one" }
}
function submittedModel() { return (api.mock.calls.at(-1)![1] as { model: ArtemisModelDraft }).model }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function runFit() {
  fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
  await screen.findByText("Fit completed. Results are in the plot panel.")
}

beforeEach(() => {
  api.mockReset(); vi.mocked(athenaApi).mockReset(); plot.mockClear(); localStorage.clear()
  api.mockImplementation(async (url, body) => {
    if (url === "/paths/inspect") { const input = body as { filename: string; content: string }; return path(input.filename, input.content) }
    if (url.endsWith("/fit-saved")) return savedFit(body)
    if (url.endsWith("/model")) {
      const { model, version } = body as { model: ArtemisModelDraft; version: number }
      return { ...attachedProject(version + 1), groups: [{ ...group(), artemis: { schema_version: 1, model, history: [], current_input_sha256: null } }] }
    }
    return fitResult()
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe("ArtemisFittingPanel", () => {
  it("prepares the supplied Cu₂O model while the foil stays selected, without requests or fitting", () => {
    const setup = exampleSetup()
    const onFitResult = vi.fn()
    const onViewStructure = vi.fn()
    const onPathsChange = vi.fn()
    const view = render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={setup}
      onFitResult={onFitResult} onPathsChange={onPathsChange} onViewStructure={onViewStructure} />)
    expect(screen.queryByLabelText("Path 1 S₀²")).not.toBeInTheDocument()

    // A later command may clear the transient setup prop before Cu₂O is selected.
    view.rerender(<ArtemisFittingPanel projectId="p" version={5} group={group("cuprite")}
      onFitResult={onFitResult} onPathsChange={onPathsChange} onViewStructure={onViewStructure} />)
    expect(screen.getAllByRole("checkbox", { name: /^Include path \d+$/ })).toHaveLength(4)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.82")
    expect(screen.getByLabelText("k min (Å⁻¹)")).toHaveValue("2")
    expect(screen.getByLabelText("k max (Å⁻¹)")).toHaveValue("10")
    expect(screen.getByRole("button", { name: "Run EXAFS fit" })).toBeEnabled()
    expect(onPathsChange.mock.calls.at(-1)?.[0].map((item: { filename: string }) => item.filename)).toEqual(setup.example.paths.map(item => item.filename))
    expect(onFitResult.mock.calls.every(([result]) => result === null)).toBe(true)
    expect(onViewStructure).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it("does not replace an existing edited Cu₂O draft when a supplied setup arrives", () => {
    const view = render(<ArtemisFittingPanel projectId="p" version={4} group={group("cuprite")} />)
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.67" } })
    view.rerender(<ArtemisFittingPanel projectId="p" version={5} group={group()} exampleSetup={exampleSetup()} />)
    view.rerender(<ArtemisFittingPanel projectId="p" version={5} group={group("cuprite")} exampleSetup={exampleSetup()} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.67")
    expect(screen.queryByLabelText("Path 1 S₀²")).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  it("preserves model edits and removal of every supplied path across spectrum switches", () => {
    const setup = exampleSetup()
    const view = render(<ArtemisFittingPanel projectId="p" version={4} group={group("cuprite")} exampleSetup={setup} />)
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.71" } })
    for (let remaining = 4; remaining > 0; remaining--) fireEvent.click(screen.getByRole("button", { name: "Remove path 1" }))
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={setup} />)
    view.rerender(<ArtemisFittingPanel projectId="p" version={5} group={group("cuprite")} exampleSetup={exampleSetup()} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.71")
    expect(screen.queryByLabelText("Path 1 S₀²")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run EXAFS fit" })).toBeDisabled()
    expect(api).not.toHaveBeenCalled()
  })

  it("scopes supplied Cu₂O models to their project even when group IDs match", () => {
    const setup = exampleSetup()
    const view = render(<ArtemisFittingPanel projectId="other-project" version={4} group={group("cuprite")} exampleSetup={setup} />)
    expect(screen.queryByLabelText("Path 1 S₀²")).not.toBeInTheDocument()
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={group("cuprite")} exampleSetup={setup} />)
    expect(screen.getAllByRole("checkbox", { name: /^Include path \d+$/ })).toHaveLength(4)
    view.rerender(<ArtemisFittingPanel projectId="other-project" version={4} group={group("cuprite")} exampleSetup={setup} />)
    expect(screen.queryByLabelText("Path 1 S₀²")).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  it("requires a processed spectrum and explicit fit action", async () => {
    const view = render(<ArtemisFittingPanel />)
    expect(screen.getByRole("status")).toHaveTextContent("Select a spectrum")
    expect(screen.queryByRole("button", { name: "Cu₂O example" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sync parameters" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Run EXAFS fit" })).toBeDisabled()
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={{ ...group(), result: null }} exampleSetup={preparedExample()} onProjectChange={acceptProject} />)
    expect(screen.getByRole("status")).toHaveTextContent("requires processed χ(k)")
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={group()} onProjectChange={acceptProject} />)
    expect(api).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.9" } })
    expect(api).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Run EXAFS fit" })).toBeEnabled()
  })

  it("opens four prepared Cuprite paths without an extra example action, then fits at the current project revision", async () => {
    const onProjectChange = vi.fn()
    const onViewStructure = vi.fn()
    const onPathsChange = vi.fn()
    api.mockImplementation(async (_url, body) => savedFit(body, fitResult({ version: 5 })))
    function Harness() {
      const [project, setProject] = useState(attachedProject(5))
      return <ArtemisFittingPanel projectId="p" version={project.version} group={project.groups[0]} exampleSetup={preparedExample()}
        onProjectChange={project => { onProjectChange(project); setProject(project) }}
        onViewStructure={onViewStructure} onPathsChange={onPathsChange} />
    }
    render(<Harness />)
    expect(screen.queryByRole("button", { name: "Cu₂O example" })).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onViewStructure).not.toHaveBeenCalled()
    expect(screen.getAllByRole("checkbox", { name: /^Include path \d+$/ })).toHaveLength(4)
    for (const [index, source] of example().paths.entries()) {
      expect(screen.getByLabelText(`Path ${index + 1} S₀²`)).not.toBeVisible()
      expect(screen.getByText(source.filename)).toBeVisible()
    }
    fireEvent.click(screen.getByRole("button", { name: "Expand all path details" }))
    for (const index of [1, 2, 3, 4]) expect(screen.getByLabelText(`Path ${index} S₀²`)).toBeVisible()
    expect(api).not.toHaveBeenCalled()
    expect(onPathsChange.mock.calls.at(-1)?.[0]).toHaveLength(4)
    await runFit()
    const submitted = submittedModel()
    expect(api).toHaveBeenCalledOnce()
    expect(api.mock.calls[0][0]).toBe("/projects/p/groups/copper/fit-saved")
    expect(api.mock.calls[0][1]).toMatchObject({ version: 5 })
    expect(submitted.paths.map(item => [item.filename, item.content])).toEqual(example().paths.map(item => [item.filename, item.content]))
  })

  it("reads selected FEFF file contents, retains degeneracy, and saves complete FEFF metadata, expressions and objective weights", async () => {
    const result = vi.fn()
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} onFitResult={result} onProjectChange={acceptProject} />)
    fireEvent.change(screen.getByLabelText("Upload FEFF path files"), { target: { files: [file("feff0002.dat", "contents not a file path")] } })
    await screen.findByLabelText("Path 1 S₀²")
    expect(api).toHaveBeenCalledWith("/paths/inspect", { filename: "feff0002.dat", content: "contents not a file path" }, expect.any(AbortSignal))
    expect(screen.getByText(/N 12/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Path 1 S₀²"), { target: { value: "amp * 0.5" } })
    for (const weight of [0, 1, 2, 3]) expect(screen.getByRole("checkbox", { name: `Fit k-weight ${weight}` })).toBeChecked()
    fireEvent.click(screen.getByRole("checkbox", { name: "Fit k-weight 0" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Fit k-weight 3" }))
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    await runFit()
    const request = submittedModel()
    expect(request).toMatchObject({ transform: { kweight: [1, 2], fitspace: "k" }, paths: [{ filename: "feff0002.dat", content: "contents not a file path", s02: "amp * 0.5" }] })
    expect(request.paths[0].metadata.degen).toBe(12)
    // The status text renders in the commit that sets the result; onFitResult runs in that
    // commit's passive effect, which can flush after findByText has already resolved.
    await waitFor(() => expect(result.mock.calls.at(-1)?.[0]).toMatchObject({ ...fitResult(), request: { transform: { kweight: [1, 2] } } }))
  })

  it("saves Set and Def draft text with editable bounds", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onProjectChange={acceptProject} />)
    fireEvent.change(screen.getByLabelText("Parameter 2 kind"), { target: { value: "set" } })
    fireEvent.change(screen.getByLabelText("Parameter 2 value"), { target: { value: "3.5" } })
    fireEvent.change(screen.getByLabelText("Parameter 3 kind"), { target: { value: "def" } })
    fireEvent.change(screen.getByLabelText("Parameter 3 expression"), { target: { value: "sig2 * 2" } })
    await runFit()
    const request = submittedModel()
    expect(request.parameters[1]).toMatchObject({ name: "del_e0", kind: "set", value: "3.5", expression: "", min: "-20", max: "20" })
    expect(request.parameters[2]).toMatchObject({ name: "del_r", kind: "def", expression: "sig2 * 2" })
  })

  it("syncs one path's renamed parameters while preserving the other paths' shared settings", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onProjectChange={acceptProject} />)
    for (const weight of [0, 1, 2, 3]) expect(screen.getByRole("checkbox", { name: `Fit k-weight ${weight}` })).toBeChecked()
    fireEvent.change(screen.getByLabelText("Parameter 1 kind"), { target: { value: "set" } })
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.85" } })
    fireEvent.change(screen.getByLabelText("Parameter 2 minimum"), { target: { value: "-10" } })
    fireEvent.change(screen.getByLabelText("Path 1 ΔR (Å)"), { target: { value: "del_r1" } })
    fireEvent.change(screen.getByLabelText("Path 1 σ² (Å²)"), { target: { value: "sig2_1" } })
    fireEvent.click(screen.getByRole("button", { name: "Sync parameters" }))
    expect(screen.getByRole("status")).toHaveTextContent("Added: del_r1, sig2_1.")
    expect(screen.getByLabelText("Parameter 3 name")).toHaveValue("del_r")
    expect(screen.getByLabelText("Parameter 4 name")).toHaveValue("sig2")
    expect(screen.getByLabelText("Parameter 5 name")).toHaveValue("del_r1")
    expect(screen.getByLabelText("Parameter 6 name")).toHaveValue("sig2_1")
    expect(screen.getByLabelText("Parameter 6 value")).toHaveValue("0.003")
    expect(screen.getByLabelText("Parameter 1 kind")).toHaveValue("set")
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.85")
    expect(screen.getByLabelText("Parameter 2 minimum")).toHaveValue("-10")
    expect(api).not.toHaveBeenCalled()
    await runFit()
    const request = submittedModel()
    expect(request.parameters.map(parameter => parameter.name)).toEqual(["amp", "del_e0", "del_r", "sig2", "del_r1", "sig2_1"])
    expect(request.paths[0]).toMatchObject({ deltar: "del_r1", sigma2: "sig2_1" })
    expect(request.paths.slice(1).every(item => item.deltar === "del_r" && item.sigma2 === "sig2")).toBe(true)
    expect(request.transform.kweight).toEqual([0, 1, 2, 3])
    fireEvent.click(screen.getByRole("button", { name: "Sync parameters" }))
    expect(screen.getByText("Parameters are already in sync with the included paths.")).toBeInTheDocument()
    expect(screen.getByText("Fit completed. Results are in the plot panel.")).toBeInTheDocument()
    expect(screen.getAllByLabelText(/^Parameter \d+ name$/)).toHaveLength(6)
  })

  it("keeps the entire draft when a path expression is incomplete and allows retrying sync", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onProjectChange={acceptProject} />)
    fireEvent.change(screen.getByLabelText("Path 1 ΔR (Å)"), { target: { value: "new_r +" } })
    fireEvent.click(screen.getByRole("button", { name: "Sync parameters" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot sync expression")
    expect(screen.getByLabelText("Parameter 3 name")).toHaveValue("del_r")
    expect(screen.getAllByLabelText(/^Parameter \d+ name$/)).toHaveLength(4)
    fireEvent.change(screen.getByLabelText("Path 1 ΔR (Å)"), { target: { value: "new_r" } })
    fireEvent.click(screen.getByRole("button", { name: "Sync parameters" }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Parameter 5 name")).toHaveValue("new_r")
  })

  it("keeps incomplete numeric drafts and explains invalid ranges before a request", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onProjectChange={acceptProject} />)
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("amp value must be a finite number")
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("")
    expect(api).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("k min (Å⁻¹)"), { target: { value: "14" } })
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("k range")
    expect(api).not.toHaveBeenCalled()
  })

  it("retains editable model after backend failure and retries without re-upload", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onProjectChange={acceptProject} />)
    api.mockRejectedValueOnce(new Error("Unknown symbol bad_sigma in path sigma2."))
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown symbol")
    expect(screen.getByLabelText("Path 1 σ² (Å²)")).toHaveValue("sig2")
    fireEvent.click(screen.getByRole("button", { name: "Retry fit" }))
    await screen.findByText("Fit completed. Results are in the plot panel.")
    expect(api.mock.calls[1][1]).toEqual(api.mock.calls[0][1])
  })

  it("preserves separate drafts and completed results while switching spectra; editing invalidates the result", async () => {
    const onFitResult = vi.fn()
    const view = render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onFitResult={onFitResult} onProjectChange={acceptProject} />)
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.85" } })
    await runFit()
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={group("iron")} onFitResult={onFitResult} onProjectChange={acceptProject} />)
    expect(screen.queryByLabelText("Path 1 S₀²")).not.toBeInTheDocument()
    expect(onFitResult.mock.calls.at(-1)?.[0]).toBeNull()
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={group()} onFitResult={onFitResult} onProjectChange={acceptProject} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.85")
    expect(onFitResult.mock.calls.at(-1)?.[0]).toMatchObject({ group_id: "copper", version: 4 })
    fireEvent.change(screen.getByLabelText("Path 1 ΔR (Å)"), { target: { value: "del_r + 0.001" } })
    expect(onFitResult.mock.calls.at(-1)?.[0]).toBeNull()
    expect(api).toHaveBeenCalledOnce()
  })

  it.each(["version", "group", "pending"] as const)("ignores a late fit response when %s changes", async change => {
    const onFitResult = vi.fn()
    const view = render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onFitResult={onFitResult} onProjectChange={acceptProject} />)
    const response = deferred<ReturnType<typeof savedFit>>()
    api.mockReturnValueOnce(response.promise)
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    await waitFor(() => expect(api.mock.calls.at(-1)?.[0]).toMatch(/fit-saved$/))
    const signal = api.mock.calls.at(-1)?.[2]
    view.rerender(<ArtemisFittingPanel projectId="p" version={change === "version" ? 5 : 4} group={group(change === "group" ? "iron" : "copper")} pending={change === "pending"} onFitResult={onFitResult} onProjectChange={acceptProject} />)
    expect(signal).toBeUndefined()
    await act(async () => { response.resolve(savedFit(api.mock.calls.at(-1)?.[1])) })
    expect(onFitResult.mock.calls.at(-1)?.[0]).toBeNull()
    expect(screen.queryByText("Fit completed. Results are in the plot panel.")).not.toBeInTheDocument()
  })

  it("rejects mismatched and invalid curves instead of forwarding a fit result", async () => {
    const onFitResult = vi.fn()
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onFitResult={onFitResult} onProjectChange={acceptProject} />)
    api.mockImplementationOnce(async (_url, body) => savedFit(body, fitResult({ version: 3 })))
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("alert")).toHaveTextContent("does not match this spectrum")
    api.mockImplementationOnce(async (_url, body) => savedFit(body, fitResult({ k: { ...fitResult().k, model: [Number.NaN] } })))
    fireEvent.click(screen.getByRole("button", { name: "Retry fit" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry fit" })).toBeEnabled())
    expect(onFitResult.mock.calls.every(([result]) => result === null)).toBe(true)
  })

  it("imports a saved model by validating its FEFF contents and requires a new fit", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} onProjectChange={acceptProject} />)
    const request: ArtemisFitRequest = { version: 99, parameters: example().parameters, transform: { ...example().transform, kweight: [1, 3] }, paths: [{ id: "saved", label: "Imported copper", filename: "feff0001.dat", content: "exported FEFF bytes", enabled: true, s02: "amp", e0: "del_e0", deltar: "del_r", sigma2: "sig2" }] }
    const imported = { ...request, transform: { ...request.transform, dr: 99, unknown_transform_field: 1 }, paths: request.paths.map(path => ({ ...path, unknown_path_field: "extra" })) }
    fireEvent.change(screen.getByLabelText("Import Artemis model JSON"), { target: { files: [file("model.json", JSON.stringify({ schema: "artemis-web/v1", request: imported, result: fitResult({ version: 99 }) }))] } })
    await screen.findByLabelText("Path 1 S₀²")
    expect(screen.getByLabelText("Path 1 label")).toHaveValue("Imported copper")
    expect(api).toHaveBeenCalledExactlyOnceWith("/paths/inspect", { filename: "feff0001.dat", content: "exported FEFF bytes" }, expect.any(AbortSignal))
    expect(screen.getByRole("checkbox", { name: "Fit k-weight 3" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Fit k-weight 0" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Fit k-weight 2" })).not.toBeChecked()
    expect(screen.queryByText("Fit completed. Results are in the plot panel.")).not.toBeInTheDocument()
    await runFit()
    const submitted = submittedModel()
    expect(submitted).toMatchObject({ transform: { kweight: [1, 3], dr: "0" } })
    expect(submitted.transform).not.toHaveProperty("unknown_transform_field")
    expect(submitted.paths[0]).not.toHaveProperty("unknown_path_field")
  })

  it("exports the exact fitting request, FEFF content and numerical result together", async () => {
    let actions: ArtemisModelActions | null = null
    let blob: Blob | undefined
    vi.stubGlobal("URL", class extends URL { static createObjectURL(value: Blob) { blob = value; return "blob:test" } static revokeObjectURL() {} })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} exampleSetup={preparedExample()} onProjectChange={acceptProject} onActionsChange={value => { actions = value }} />)
    await runFit()
    act(() => actions!.exportModel())
    const saved = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob!) })
    const bundle = JSON.parse(saved)
    expect(bundle.schema).toBe("artemis-web/v1")
    expect(bundle.request.paths.map((p: { content: string }) => p.content)).toEqual(submittedModel().paths.map(p => p.content))
    expect(bundle.request.parameters).toEqual(example().parameters)
    expect(bundle.request.paths[0].content).toBe(example().paths[0].content)
    expect(bundle.result).toEqual(fitResult())
    vi.unstubAllGlobals()
  })
})

describe("ArtemisFitResultViewer", () => {
  it("changes this viewer's k/R/path curves from saved-fit transforms without changing fit settings or statistics", async () => {
    const result = resultWithPaths()
    const original = JSON.stringify(result)
    const preview = plotWeightResult(result, 4)
    api.mockResolvedValueOnce(preview)
    render(<ArtemisFitResultViewer result={result} group={group()} projectId="p" version={8} />)
    expect(screen.getByLabelText("EXAFS fit k-weight")).toHaveValue("2")
    fireEvent.click(screen.getByRole("checkbox", { name: "Show paths" }))
    fireEvent.change(screen.getByLabelText("EXAFS fit k-weight"), { target: { value: "4" } })
    expect(screen.queryByTestId("fit-plot")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Updating fit plot")
    await screen.findByTestId("fit-plot")
    expect(api).toHaveBeenCalledExactlyOnceWith("/projects/p/groups/copper/plot-transform", {
      version: 8, kweight: 4, result,
    }, expect.any(AbortSignal))
    expect(plot.mock.calls.at(-1)![0].data[0].y).toEqual(preview.r.data_mag)
    expect(plot.mock.calls.at(-1)![0].data[3].y).toEqual(preview.paths[0].r!.mag)
    expect(plot.mock.calls.at(-1)![0].layout.yaxis.title.text).toContain("−5")
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    expect(plot.mock.calls.at(-1)![0].data[0].y).toEqual(preview.k.data)
    expect(plot.mock.calls.at(-1)![0].data[3].y).toEqual(preview.paths[0].k!.chi)
    expect(screen.getByText(/Plot k-weight 4; fit weights 0, 1, 2, 3/)).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About EXAFS fit" }))
    expect(screen.getByText(/Plot k-weight 4; fit weights 0, 1, 2, 3/)).toBeVisible()
    expect(screen.getByText("0.003", { selector: "dd" })).toBeVisible()
    fireEvent.change(screen.getByLabelText("EXAFS fit k-weight"), { target: { value: "2" } })
    expect(plot.mock.calls.at(-1)![0].data[0].y).toEqual(result.k.data)
    expect(api).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).toBe(original)
  })

  it("uses a stale archive's saved curves and the current project version without sending UI metadata or refitting", async () => {
    const result = resultWithPaths()
    result.archive = { id: "old-fit", created: "2026-09-20T00:00:00Z", imported: true, stale: true,
      modelChanged: true, origin: { project_id: "imported", group_id: "old-group", project_version: 1, larch_version: "test" } }
    result.request = { version: 1, parameters: [], paths: [], transform: result.transform }
    const changed = group()
    changed.result!.arrays.chi = [900, 800, 700]
    api.mockResolvedValueOnce(plotWeightResult(result, 1, 20))
    render(<ArtemisFitResultViewer result={result} group={changed} projectId="p" version={20} />)
    fireEvent.change(screen.getByLabelText("EXAFS fit k-weight"), { target: { value: "1" } })
    await screen.findByTestId("fit-plot")
    const request = api.mock.calls[0][1] as { result: ArtemisFitResult; version: number }
    expect(request.version).toBe(20)
    expect(request.result.k.data).toEqual(result.k.data)
    expect(request.result.archive).toBeUndefined()
    expect(request.result.request).toBeUndefined()
    expect(screen.getByText("Outdated input")).toBeVisible()
    expect(screen.getByText(/This spectrum has changed since the fit/)).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About Outdated fit input" }))
    expect(screen.getByText(/This spectrum has changed since the fit/)).toBeVisible()
    expect(api.mock.calls[0][0]).toContain("/plot-transform")
  })

  it("rejects mismatched previews and preserves saved reports while a weight is unavailable", async () => {
    const result = resultWithPaths()
    api.mockResolvedValueOnce({ ...plotWeightResult(result, 3), kweight: 1 })
    render(<ArtemisFitResultViewer result={result} group={group()} projectId="p" version={8} />)
    fireEvent.change(screen.getByLabelText("EXAFS fit k-weight"), { target: { value: "3" } })
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match this saved result")
    expect(screen.queryByTestId("fit-plot")).not.toBeInTheDocument()
    expect(screen.getByText("Larch fit report")).toBeInTheDocument()
    api.mockRejectedValueOnce(new Error("This saved fit does not retain unweighted χ(0)."))
    fireEvent.change(screen.getByLabelText("EXAFS fit k-weight"), { target: { value: "0" } })
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("does not retain unweighted χ(0)"))
    fireEvent.change(screen.getByLabelText("EXAFS fit k-weight"), { target: { value: "2" } })
    expect(screen.getByTestId("fit-plot")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("ignores a superseded weight response and retains independent manual offsets for the new display", async () => {
    const result = resultWithPaths()
    const old = deferred<ArtemisPlotWeightResult>()
    api.mockReturnValueOnce(old.promise).mockResolvedValueOnce(plotWeightResult(result, 1))
    render(<ArtemisFitResultViewer result={result} group={group()} projectId="p" version={8} />)
    fireEvent.change(screen.getByLabelText("EXAFS fit k-weight"), { target: { value: "3" } })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByLabelText("EXAFS fit k-weight"), { target: { value: "1" } })
    await screen.findByTestId("fit-plot")
    await act(async () => { old.resolve(plotWeightResult(result, 3)) })
    expect(screen.getByText(/Plot k-weight 1;/)).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About EXAFS fit" }))
    expect(screen.getByText(/Plot k-weight 1;/)).toBeVisible()
    expect((api.mock.calls[0][2] as AbortSignal).aborted).toBe(true)
    fireEvent.click(screen.getByRole("checkbox", { name: "Offset plot" }))
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offset spacing" }), { target: { value: "7" } })
    expect(screen.getByRole("spinbutton", { name: "Offset spacing" })).toHaveValue(7)
    expect(plot.mock.calls.at(-1)![0].data[2].customdata[0][1]).toBe(-7)
  })

  it("shows fitted path curves only on request in k and every R component, using distinct path labels and colors", () => {
    const result = resultWithPaths()
    render(<ArtemisFitResultViewer result={result} group={group()} />)
    expect(screen.getByRole("checkbox", { name: "Show paths" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Offset plot" })).not.toBeChecked()
    expect(plot.mock.calls.at(-1)![0].data).toHaveLength(3)
    fireEvent.click(screen.getByRole("checkbox", { name: "Show paths" }))
    let props = plot.mock.calls.at(-1)![0]
    expect(props.data).toHaveLength(5)
    expect(props.data[3]).toMatchObject({ name: "Path 1 · Cu–Cu", x: result.r.x, y: result.paths[0].r!.mag })
    expect(props.data[4].name).toBe("Path 2 · Cu–Cu")
    expect(new Set(props.data.map(trace => trace.line.color)).size).toBe(5)
    expect(screen.getByText(/Individual path magnitudes do not add to the model magnitude/)).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About EXAFS fit" }))
    expect(screen.getByText(/Individual path magnitudes do not add to the model magnitude/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Real" }))
    expect(plot.mock.calls.at(-1)![0].data[3].y).toEqual(result.paths[0].r!.re)
    fireEvent.click(screen.getByRole("button", { name: "Imaginary" }))
    expect(plot.mock.calls.at(-1)![0].data[4].y).toEqual(result.paths[1].r!.im)
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    props = plot.mock.calls.at(-1)![0]
    expect(props.data[3]).toMatchObject({ x: result.k.x, y: result.paths[0].k!.chi })
    expect(screen.queryByText(/Individual path magnitudes/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Show paths" }))
    expect(plot.mock.calls.at(-1)![0].data).toHaveLength(3)
    expect(api).not.toHaveBeenCalled()
  })

  it("offsets residual and paths while keeping data/model aligned and hover values unshifted", () => {
    const result = resultWithPaths()
    const original = JSON.stringify(result)
    render(<ArtemisFitResultViewer result={result} group={group()} />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Show paths" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Offset plot" }))
    expect(Number((screen.getByRole("spinbutton", { name: "Offset spacing" }) as HTMLInputElement).value)).toBeGreaterThan(0)
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offset spacing" }), { target: { value: "4" } })
    const props = plot.mock.calls.at(-1)![0]
    expect(props.data[0].y).toEqual(result.r.data_mag)
    expect(props.data[1].y).toEqual(result.r.model_mag)
    expect(props.data[2].y).toEqual(result.r.residual_mag.map(value => value - 4))
    expect(props.data[3].y).toEqual(result.paths[0].r!.mag.map(value => value - 8))
    expect(props.data[4].y).toEqual(result.paths[1].r!.mag.map(value => value - 12))
    expect(props.data[3].customdata[1]).toEqual([2.5, -8])
    expect(props.data[3].hovertemplate).toContain("Unshifted value = %{customdata[0]")
    expect(props.data[3].hovertemplate).toContain("Display offset = %{customdata[1]")
    expect(props.layout.yaxis.title.text).toContain("display offset")
    expect(screen.getByText(/Data and Model share zero offset/)).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About EXAFS fit" }))
    expect(screen.getByText(/Data and Model share zero offset/)).toBeVisible()
    props.data[3].y[1] = 999
    props.data[3].customdata[1][0] = 999
    expect(JSON.stringify(result)).toBe(original)
    fireEvent.click(screen.getByRole("checkbox", { name: "Offset plot" }))
    expect(plot.mock.calls.at(-1)![0].data[3].y).toEqual(result.paths[0].r!.mag)
    expect(screen.queryByRole("spinbutton", { name: "Offset spacing" })).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  it("recomputes automatic spacing per displayed component and supports manual/Auto reset without changing fit statistics", () => {
    const result = resultWithPaths()
    render(<ArtemisFitResultViewer result={result} group={group()} />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Offset plot" }))
    expect(screen.getByRole("spinbutton", { name: "Offset spacing" })).toHaveValue(3.45)
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offset spacing" }), { target: { value: "8" } })
    expect(plot.mock.calls.at(-1)![0].data[2].customdata[0][1]).toBe(-8)
    fireEvent.click(screen.getByRole("button", { name: "Real" }))
    expect(screen.getByRole("spinbutton", { name: "Offset spacing" })).toHaveValue(3.45)
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offset spacing" }), { target: { value: "6" } })
    fireEvent.click(screen.getByRole("button", { name: "Auto" }))
    expect(screen.getByRole("spinbutton", { name: "Offset spacing" })).toHaveValue(3.45)
    expect(screen.getByText("0.003", { selector: "dd" })).toBeVisible()
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offset spacing" }), { target: { value: "-1" } })
    expect(screen.getByRole("spinbutton", { name: "Offset spacing" })).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("status")).toHaveTextContent("Invalid spacing · using automatic")
    expect(plot.mock.calls.at(-1)![0].data.every(trace => trace.y.every(Number.isFinite))).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Auto" }))
    expect(screen.getByRole("spinbutton", { name: "Offset spacing" })).toHaveAttribute("aria-invalid", "false")
  })

  it("disables path overlays for older or malformed curves while preserving the data/model plot", () => {
    const result = fitResult()
    const view = render(<ArtemisFitResultViewer result={result} group={group()} />)
    expect(screen.getByRole("checkbox", { name: "Show paths" })).toBeDisabled()
    expect(screen.getByText("Run the fit again to include path curves.")).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About Unavailable path curves" }))
    expect(screen.getByText("Run the fit again to include path curves.")).toBeVisible()
    expect(plot.mock.calls.at(-1)![0].data).toHaveLength(3)
    const malformed = resultWithPaths()
    malformed.paths[1].r!.mag = [0, Number.NaN]
    view.rerender(<ArtemisFitResultViewer result={malformed} group={group()} />)
    expect(screen.getByRole("checkbox", { name: "Show paths" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    expect(screen.getByRole("checkbox", { name: "Show paths" })).toBeEnabled()
    fireEvent.click(screen.getByRole("checkbox", { name: "Show paths" }))
    expect(plot.mock.calls.at(-1)![0].data).toHaveLength(5)
    fireEvent.click(screen.getByRole("button", { name: "R space" }))
    expect(screen.getByRole("checkbox", { name: "Show paths" })).not.toBeChecked()
    expect(plot.mock.calls.at(-1)![0].data).toHaveLength(3)
  })

  it("does not retain previous path data or manual offsets when the result context changes", () => {
    const result = resultWithPaths()
    const view = render(<ArtemisFitResultViewer result={result} group={group()} />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Show paths" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Offset plot" }))
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offset spacing" }), { target: { value: "99" } })
    view.rerender(<ArtemisFitResultViewer result={result} group={group("iron")} />)
    expect(screen.queryByTestId("fit-plot")).not.toBeInTheDocument()
    const next = { ...resultWithPaths(), group_id: "iron", group_label: "Iron foil", version: 5 }
    next.paths[0].label = "Fe–Fe"
    view.rerender(<ArtemisFitResultViewer result={next} group={group("iron")} />)
    expect(screen.getByRole("spinbutton", { name: "Offset spacing" })).toHaveValue(3.45)
    expect(plot.mock.calls.at(-1)![0].data[3].name).toBe("Path 1 · Fe–Fe")
    expect(plot.mock.calls.at(-1)![0].layout.uirevision).toContain(":iron:5:")
    view.rerender(<ArtemisFitResultViewer result={next} group={group("iron")} pending />)
    expect(screen.queryByTestId("fit-plot")).not.toBeInTheDocument()
  })

  it("shows complex residual magnitude, switches real/k views, and does not mutate cached data", () => {
    const result = fitResult()
    render(<ArtemisFitResultViewer result={result} group={group()} />)
    expect(plot.mock.calls.at(-1)?.[0].data[2]).toMatchObject({ name: "Residual", visible: "legendonly" })
    expect(plot.mock.calls.at(-1)?.[0].data[2].y).toEqual(result.r.residual_mag)
    expect(screen.getByText(/Residual is \|FT\(data − model\)\|/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Real" }))
    expect(plot.mock.calls.at(-1)?.[0].data[0].y).toEqual(result.r.data_re)
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    const props = plot.mock.calls.at(-1)![0]
    expect(props.data[2].y).toEqual(result.k.residual)
    expect(props.layout.shapes[0]).toMatchObject({ x0: 3, x1: 12 })
    props.data[0].y[1] = 999
    expect(result.k.data[1]).toBe(2)
    expect(screen.getByText("Independent points")).toBeInTheDocument()
    expect(screen.getByText("12.5")).toBeInTheDocument()
    expect(screen.getByText("Parameter correlations (1)")).toBeInTheDocument()
  })

  it("hides results for a different group or during processing and keeps reports after a plot error", () => {
    const result = fitResult()
    const view = render(<ArtemisFitResultViewer result={result} group={group("iron")} />)
    expect(screen.queryByTestId("fit-plot")).not.toBeInTheDocument()
    view.rerender(<ArtemisFitResultViewer result={result} group={group()} pending />)
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for spectrum processing")
    view.rerender(<ArtemisFitResultViewer result={result} group={group()} />)
    act(() => { plot.mock.calls.at(-1)![0].onError() })
    expect(screen.getByRole("alert")).toHaveTextContent("Could not render")
    expect(screen.getByText("Larch fit report")).toBeInTheDocument()
  })
})

function persistedGroup(value = "0.8"): AthenaGroup {
  const e = example()
  const model: ArtemisModelDraft = { revision: 0,
    parameters: e.parameters.map((p, i) => ({ ...p, id: `parameter-${i}`, value: i === 0 ? value : String(p.value), min: p.min === null ? "" : String(p.min), max: p.max === null ? "" : String(p.max) })),
    paths: e.paths.map((p, i) => ({ ...p, id: `path-${i}`, label: p.filename, enabled: true, s02: "amp", e0: "del_e0", deltar: "del_r", sigma2: "sig2" })),
    transform: { ...e.transform, kmin: "3", kmax: "12", dk: "1", rmin: "1", rmax: "3", dr: "0" },
  }
  return savedFit({ version: 4, model }).project.groups[0]
}

describe("project-owned Artemis models", () => {
  it("restores a saved history without refitting and labels scientific staleness and imported results", () => {
    const source = persistedGroup()
    const receive = vi.fn()
    const view = render(<ArtemisFittingPanel projectId="p" version={20} group={source} onFitResult={receive} onProjectChange={acceptProject} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.8")
    expect(screen.getByLabelText("Saved fit history")).toHaveValue("fit-one")
    expect(receive.mock.calls.at(-1)?.[0].archive).toMatchObject({ stale: false, modelChanged: false, imported: false })
    const changed = structuredClone(source)
    changed.artemis!.current_input_sha256 = "b".repeat(64)
    changed.artemis!.history[0].imported = true
    view.rerender(<ArtemisFittingPanel projectId="p" version={21} group={changed} onFitResult={receive} onProjectChange={acceptProject} />)
    const result = receive.mock.calls.at(-1)?.[0]
    expect(result.archive).toMatchObject({ stale: true, imported: true })
    render(<ArtemisFitResultViewer group={changed} result={result} />)
    expect(screen.getByText("Outdated input", { exact: true })).toBeVisible()
    expect(screen.getByText("Imported fit · unverified", { exact: true })).toBeVisible()
    expect(screen.getByText(/has not been verified by a new fit here/)).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About Imported fit" }))
    expect(screen.getByRole("tooltip")).toHaveTextContent(/has not been verified by a new fit here/)
    expect(api).not.toHaveBeenCalled()
  })

  it("saves an unfinished numeric draft and restores it after a remount", async () => {
    const source = persistedGroup()
    const receive = vi.fn()
    api.mockImplementationOnce(async (_url, body) => ({ ...attachedProject(6), groups: [{ ...source, artemis: { ...source.artemis!, model: (body as { model: ArtemisModelDraft }).model } }] }))
    const view = render(<ArtemisFittingPanel projectId="p" version={5} group={source} onProjectChange={receive} />)
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "-" } })
    await waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(api.mock.calls[0][0]).toBe("/projects/p/groups/copper/model")
    const saved = receive.mock.calls[0][0] as AthenaProject
    view.unmount()
    render(<ArtemisFittingPanel projectId="p" version={saved.version} group={saved.groups[0]} onProjectChange={acceptProject} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("-")
    expect(screen.queryByText(/Model saved automatically in this project/)).not.toBeInTheDocument()
  })

  it("follows external saves and Undo for clean cached groups, while preserving dirty drafts", () => {
    const view = render(<ArtemisFittingPanel projectId="p" version={5} group={persistedGroup()} />)
    view.rerender(<ArtemisFittingPanel projectId="p" version={5} group={group("iron")} />)
    view.rerender(<ArtemisFittingPanel projectId="p" version={6} group={persistedGroup("0.9")} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.9")
    view.rerender(<ArtemisFittingPanel projectId="p" version={7} group={persistedGroup("0.7")} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.7")
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.55" } })
    view.rerender(<ArtemisFittingPanel projectId="p" version={8} group={persistedGroup("0.6")} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.55")
    fireEvent.click(screen.getByRole("button", { name: "Use this fit’s model" }))
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.6")
    view.rerender(<ArtemisFittingPanel projectId="p" version={8} group={group("iron")} />)
    view.rerender(<ArtemisFittingPanel projectId="p" version={9} group={group()} />)
    expect(screen.queryByLabelText("Path 1 label")).not.toBeInTheDocument()
  })

  it("selects history without overwriting the draft, and exports no mismatched numerical result", async () => {
    let actions: ArtemisModelActions | null = null
    const source = persistedGroup()
    const old = persistedGroup("0.6").artemis!.history[0]
    old.id = "older-fit"
    source.artemis!.history.unshift(old)
    let blob: Blob | undefined
    vi.stubGlobal("URL", class extends URL { static createObjectURL(value: Blob) { blob = value; return "blob:test" } static revokeObjectURL() {} })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<ArtemisFittingPanel projectId="p" version={5} group={source} onProjectChange={acceptProject} onActionsChange={value => { actions = value }} />)
    fireEvent.change(screen.getByLabelText("Saved fit history"), { target: { value: "older-fit" } })
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.8")
    act(() => actions!.exportModel())
    const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob!) })
    expect(JSON.parse(text).result).toBeNull()
    expect(JSON.parse(text).request.parameters[0].value).toBe(0.8)
    fireEvent.click(screen.getByRole("button", { name: "Use this fit’s model" }))
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.6")
    vi.unstubAllGlobals()
  })

  it("refreshes after a version conflict without losing the unfinished draft, then retries at the new version", async () => {
    function Harness() {
      const [project, setProject] = useState({ ...attachedProject(5), groups: [persistedGroup()] })
      return <ArtemisFittingPanel projectId="p" version={project.version} group={project.groups[0]} onProjectChange={setProject} />
    }
    api.mockRejectedValueOnce(new ApiRequestError({ code: "stale_revision", message: "Project changed", fields: [], recovery: "Reload" }, 409))
    vi.mocked(athenaApi).mockResolvedValueOnce({ ...attachedProject(6), groups: [persistedGroup("0.9")] })
    api.mockImplementationOnce(async (_url, body) => ({ ...attachedProject(7), groups: [{ ...persistedGroup(), artemis: { ...persistedGroup().artemis!, model: (body as { model: ArtemisModelDraft }).model } }] }))
    render(<Harness />)
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "-" } })
    await screen.findByText(/This project changed elsewhere/)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("-")
    fireEvent.click(screen.getByRole("button", { name: "Retry saving model" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry saving model" })).not.toBeInTheDocument())
    expect(api.mock.calls[1][1]).toMatchObject({ version: 6 })
    expect((api.mock.calls[1][1] as { model: ArtemisModelDraft }).model.parameters[0].value).toBe("-")
  })

  it("receives a committed fit after switching groups without applying it to the new spectrum", async () => {
    const onProjectChange = vi.fn()
    const response = deferred<ReturnType<typeof savedFit>>()
    api.mockReturnValueOnce(response.promise)
    const view = render(<ArtemisFittingPanel projectId="p" version={5} group={persistedGroup()} onProjectChange={onProjectChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    const body = api.mock.calls[0][1]
    view.rerender(<ArtemisFittingPanel projectId="p" version={5} group={group("iron")} onProjectChange={onProjectChange} />)
    const saved = savedFit(body, fitResult({ version: 5 }))
    await act(async () => response.resolve(saved))
    expect(onProjectChange).toHaveBeenCalledWith(saved.project)
    expect(screen.queryByLabelText("Path 1 label")).not.toBeInTheDocument()
  })
})

describe("automatic model persistence", () => {
  function workspace() {
    let server: AthenaProject = { ...attachedProject(5), groups: [persistedGroup(), group("iron")] }
    let current = server
    let actions: ArtemisModelActions | null = null
    const dirty = vi.fn()
    function saved(url: string, body: unknown) {
      const { model, version } = body as { model: ArtemisModelDraft; version: number }
      const id = url.split("/").at(-2)
      server = { ...server, version: version + 1, groups: server.groups.map(item => item.id === id ? {
        ...item, artemis: { schema_version: 1, model, history: item.artemis?.history ?? [], current_input_sha256: item.artemis?.current_input_sha256 ?? null },
      } : item) }
      return server
    }
    api.mockImplementation(async (url, body) => saved(url, body))
    function Harness() {
      const [project, setProject] = useState(server)
      const [activeId, setActiveId] = useState("copper")
      return <><button onClick={() => setActiveId(id => id === "copper" ? "iron" : "copper")}>Switch spectrum</button>
        <button onClick={() => { const next = { ...project, version: project.version + 1, groups: project.groups.map(item => item.id === "copper" ? group() : item) }; current = next; setProject(next) }}>Undo model</button>
        <ArtemisFittingPanel projectId="p" version={project.version} groups={project.groups} group={project.groups.find(item => item.id === activeId)}
          onProjectChange={next => { current = next; setProject(next) }} onDirtyChange={dirty} onActionsChange={value => { actions = value }} /></>
    }
    render(<Harness />)
    return { saved, dirty, project: () => current, actions: () => actions! }
  }

  it("flushes edits from multiple spectra and clears each dirty flag", async () => {
    const state = workspace()
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "-" } })
    fireEvent.click(screen.getByRole("button", { name: "Switch spectrum" }))
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.6" } })
    await act(async () => state.actions().flush())
    expect(api.mock.calls.map(([url, body]) => [url.split("/").at(-2), (body as { version: number }).version])).toEqual([["copper", 5], ["iron", 6]])
    expect(state.project().groups.map(item => item.artemis!.model.parameters[0].value)).toEqual(["-", "0.6"])
    expect(state.actions().status).toBe("saved")
    expect(state.dirty).toHaveBeenCalledWith("copper", false)
    expect(state.dirty).toHaveBeenCalledWith("iron", false)
    fireEvent.click(screen.getByRole("button", { name: "Switch spectrum" }))
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("-")
  })

  it.each(["0.95", "0.8"])("keeps the latest edit %s when an older save finishes", async value => {
    const state = workspace()
    const first = deferred<AthenaProject>()
    api.mockReturnValueOnce(first.promise)
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.9" } })
    let flushing!: Promise<void>
    act(() => { flushing = state.actions().flush() })
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    const [url, body] = api.mock.calls[0]
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value } })
    await act(async () => { first.resolve(state.saved(url, body)); await flushing })
    expect(api).toHaveBeenCalledTimes(2)
    expect((api.mock.calls[1][1] as { model: ArtemisModelDraft }).model.parameters[0].value).toBe(value)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue(value)
    expect(state.project().groups[0].artemis!.model.parameters[0].value).toBe(value)
    fireEvent.click(screen.getByRole("button", { name: "Switch spectrum" }))
    fireEvent.click(screen.getByRole("button", { name: "Switch spectrum" }))
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue(value)
  })

  it("keeps a clean Undo result without saving the old or empty model again", async () => {
    const state = workspace()
    fireEvent.click(screen.getByRole("button", { name: "Undo model" }))
    expect(screen.queryByLabelText("Path 1 label")).not.toBeInTheDocument()
    await act(async () => state.actions().flush())
    expect(api).not.toHaveBeenCalled()
    expect(state.project().groups[0].artemis).toBeUndefined()
    expect(state.actions().status).toBe("saved")
  })

  it("waits for a running fit after switching spectra before a project flush saves another model", async () => {
    const state = workspace()
    const fitting = deferred<ReturnType<typeof savedFit>>()
    api.mockReturnValueOnce(fitting.promise)
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    const fitBody = api.mock.calls[0][1]
    fireEvent.click(screen.getByRole("button", { name: "Switch spectrum" }))
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.6" } })
    let flushing!: Promise<void>
    let finished = false
    act(() => { flushing = state.actions().flush().then(() => { finished = true }) })
    await act(async () => { await Promise.resolve() })
    expect(api).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    const result = savedFit(fitBody, fitResult({ version: 5 }))
    result.project.groups.push(group("iron"))
    await act(async () => { fitting.resolve(result); await flushing })
    expect(api).toHaveBeenCalledTimes(2)
    expect(api.mock.calls[1][0]).toBe("/projects/p/groups/iron/model")
    expect(api.mock.calls[1][1]).toMatchObject({ version: 6 })
    expect(finished).toBe(true)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.6")
  })
})
