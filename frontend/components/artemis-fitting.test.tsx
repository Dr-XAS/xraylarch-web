import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AthenaGroup, Parameters } from "@/lib/athena"
import { artemisApi, type ArtemisExample, type ArtemisFitRequest, type ArtemisFitResult, type ArtemisInspectedPath } from "@/lib/artemis"
import { ArtemisFittingPanel, ArtemisFitResultViewer } from "./artemis-fitting"

type PlotProps = { data: { x: number[]; y: number[]; name: string }[]; layout: { xaxis: { title: { text: string } }; shapes: { x0: number; x1: number }[] }; onError: () => void }
const plot = vi.hoisted(() => vi.fn((_props: PlotProps) => <div data-testid="fit-plot" />))
vi.mock("next/dynamic", () => ({ default: () => plot }))
// Structure persistence and its modal lifecycle are covered in artemis-structures.test.tsx.
vi.mock("./artemis-structures", () => ({ ArtemisStructures: () => <div data-testid="structures-launcher" /> }))
vi.mock("@/lib/artemis", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/artemis")>(), artemisApi: vi.fn() }))
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
function example(): ArtemisExample {
  return { path: path(), description: "A Cu–Cu first-shell model for copper foil.",
    parameters: [
      { name: "amp", kind: "guess", value: 1, expression: "", min: 0, max: 2 },
      { name: "del_e0", kind: "guess", value: 0, expression: "", min: -20, max: 20 },
      { name: "del_r", kind: "guess", value: 0, expression: "", min: -0.2, max: 0.2 },
      { name: "sig2", kind: "guess", value: 0.003, expression: "", min: 0, max: 0.1 },
    ], transform: { fitspace: "r", kmin: 3, kmax: 12, kweight: [2], dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0 } }
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
function file(name: string, contents: string) {
  const value = new File([contents], name)
  Object.defineProperty(value, "text", { value: () => Promise.resolve(contents) })
  return value
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function loadExample() {
  fireEvent.click(screen.getByRole("button", { name: "Cu first-shell example" }))
  await screen.findByLabelText("Path 1 S₀²")
}
async function runFit() {
  fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
  await screen.findByText("Fit completed. Results are in the plot panel.")
}

beforeEach(() => {
  api.mockReset(); plot.mockClear(); localStorage.clear()
  api.mockImplementation(async (url, body) => {
    if (url === "/examples/copper") return example()
    if (url === "/paths/inspect") { const input = body as { filename: string; content: string }; return path(input.filename, input.content) }
    return fitResult()
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe("ArtemisFittingPanel", () => {
  it("requires a processed spectrum and explicit fit action", async () => {
    const view = render(<ArtemisFittingPanel />)
    expect(screen.getByRole("status")).toHaveTextContent("Select a spectrum")
    expect(screen.getByRole("button", { name: "Run EXAFS fit" })).toBeDisabled()
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={{ ...group(), result: null }} />)
    expect(screen.getByRole("status")).toHaveTextContent("requires processed χ(k)")
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={group()} />)
    expect(api).not.toHaveBeenCalled()
    await loadExample()
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.9" } })
    expect(api).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Run EXAFS fit" })).toBeEnabled()
  })

  it("reads selected FEFF file contents, retains degeneracy, and sends expressions and objective weights without metadata", async () => {
    const result = vi.fn()
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} onFitResult={result} />)
    fireEvent.change(screen.getByLabelText("Upload FEFF path files"), { target: { files: [file("feff0002.dat", "contents not a file path")] } })
    await screen.findByLabelText("Path 1 S₀²")
    expect(api).toHaveBeenCalledWith("/paths/inspect", { filename: "feff0002.dat", content: "contents not a file path" }, expect.any(AbortSignal))
    expect(screen.getByText(/N 12/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Path 1 S₀²"), { target: { value: "amp * 0.5" } })
    fireEvent.click(screen.getByRole("checkbox", { name: "Fit k-weight 1" }))
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    await runFit()
    const request = api.mock.calls.at(-1)?.[1] as ArtemisFitRequest
    expect(request).toMatchObject({ version: 4, transform: { kweight: [1, 2], fitspace: "k" }, paths: [{ filename: "feff0002.dat", content: "contents not a file path", s02: "amp * 0.5" }] })
    expect(request.paths[0]).not.toHaveProperty("metadata")
    expect(result.mock.calls.at(-1)?.[0]).toMatchObject({ ...fitResult(), request })
  })

  it("serializes Set and Def parameters without irrelevant bounds", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} />)
    await loadExample()
    fireEvent.change(screen.getByLabelText("Parameter 2 kind"), { target: { value: "set" } })
    fireEvent.change(screen.getByLabelText("Parameter 2 value"), { target: { value: "3.5" } })
    fireEvent.change(screen.getByLabelText("Parameter 3 kind"), { target: { value: "def" } })
    fireEvent.change(screen.getByLabelText("Parameter 3 expression"), { target: { value: "sig2 * 2" } })
    await runFit()
    const request = api.mock.calls.at(-1)?.[1] as ArtemisFitRequest
    expect(request.parameters[1]).toEqual({ name: "del_e0", kind: "set", value: 3.5, expression: "", min: null, max: null })
    expect(request.parameters[2]).toEqual({ name: "del_r", kind: "def", value: 0, expression: "sig2 * 2", min: null, max: null })
  })

  it("keeps incomplete numeric drafts and explains invalid ranges before a request", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} />)
    await loadExample()
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("amp value must be a finite number")
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("")
    expect(api).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("k min (Å⁻¹)"), { target: { value: "14" } })
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("k range")
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("retains editable model after backend failure and retries without re-upload", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} />)
    await loadExample()
    api.mockRejectedValueOnce(new Error("Unknown symbol bad_sigma in path sigma2."))
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown symbol")
    expect(screen.getByLabelText("Path 1 σ² (Å²)")).toHaveValue("sig2")
    fireEvent.click(screen.getByRole("button", { name: "Retry fit" }))
    await screen.findByText("Fit completed. Results are in the plot panel.")
    expect(api.mock.calls[2][1]).toEqual(api.mock.calls[1][1])
  })

  it("preserves separate drafts and completed results while switching spectra; editing invalidates the result", async () => {
    const onFitResult = vi.fn()
    const view = render(<ArtemisFittingPanel projectId="p" version={4} group={group()} onFitResult={onFitResult} />)
    await loadExample()
    fireEvent.change(screen.getByLabelText("Parameter 1 value"), { target: { value: "0.85" } })
    await runFit()
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={group("iron")} onFitResult={onFitResult} />)
    expect(screen.queryByLabelText("Path 1 S₀²")).not.toBeInTheDocument()
    expect(onFitResult.mock.calls.at(-1)?.[0]).toBeNull()
    view.rerender(<ArtemisFittingPanel projectId="p" version={4} group={group()} onFitResult={onFitResult} />)
    expect(screen.getByLabelText("Parameter 1 value")).toHaveValue("0.85")
    expect(onFitResult.mock.calls.at(-1)?.[0]).toMatchObject({ group_id: "copper", version: 4 })
    fireEvent.change(screen.getByLabelText("Path 1 ΔR (Å)"), { target: { value: "del_r + 0.001" } })
    expect(onFitResult.mock.calls.at(-1)?.[0]).toBeNull()
    expect(api).toHaveBeenCalledTimes(2)
  })

  it.each(["version", "group", "pending"] as const)("ignores a late fit response when %s changes", async change => {
    const onFitResult = vi.fn()
    const view = render(<ArtemisFittingPanel projectId="p" version={4} group={group()} onFitResult={onFitResult} />)
    await loadExample()
    const response = deferred<ArtemisFitResult>()
    api.mockReturnValueOnce(response.promise)
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    const signal = api.mock.calls.at(-1)?.[2]
    view.rerender(<ArtemisFittingPanel projectId="p" version={change === "version" ? 5 : 4} group={group(change === "group" ? "iron" : "copper")} pending={change === "pending"} onFitResult={onFitResult} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => { response.resolve(fitResult()) })
    expect(onFitResult.mock.calls.at(-1)?.[0]).toBeNull()
    expect(screen.queryByText("Fit completed. Results are in the plot panel.")).not.toBeInTheDocument()
  })

  it("rejects mismatched and invalid curves instead of forwarding a fit result", async () => {
    const onFitResult = vi.fn()
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} onFitResult={onFitResult} />)
    await loadExample()
    api.mockResolvedValueOnce(fitResult({ version: 3 }))
    fireEvent.click(screen.getByRole("button", { name: "Run EXAFS fit" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("alert")).toHaveTextContent("does not match this spectrum")
    api.mockResolvedValueOnce(fitResult({ k: { ...fitResult().k, model: [Number.NaN] } }))
    fireEvent.click(screen.getByRole("button", { name: "Retry fit" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry fit" })).toBeEnabled())
    expect(onFitResult.mock.calls.every(([result]) => result === null)).toBe(true)
  })

  it("imports a saved model by validating its FEFF contents and requires a new fit", async () => {
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} />)
    const request: ArtemisFitRequest = { version: 99, parameters: example().parameters, transform: { ...example().transform, kweight: [1, 3] }, paths: [{ id: "saved", label: "Imported copper", filename: "feff0001.dat", content: "exported FEFF bytes", enabled: true, s02: "amp", e0: "del_e0", deltar: "del_r", sigma2: "sig2" }] }
    const imported = { ...request, transform: { ...request.transform, dr: 99, unknown_transform_field: 1 }, paths: request.paths.map(path => ({ ...path, unknown_path_field: "extra" })) }
    fireEvent.change(screen.getByLabelText("Import Artemis model JSON"), { target: { files: [file("model.json", JSON.stringify({ schema: "artemis-web/v1", request: imported, result: fitResult({ version: 99 }) }))] } })
    await screen.findByLabelText("Path 1 S₀²")
    expect(screen.getByLabelText("Path 1 label")).toHaveValue("Imported copper")
    expect(api).toHaveBeenCalledExactlyOnceWith("/paths/inspect", { filename: "feff0001.dat", content: "exported FEFF bytes" }, expect.any(AbortSignal))
    expect(screen.getByRole("checkbox", { name: "Fit k-weight 3" })).toBeChecked()
    expect(screen.queryByText("Fit completed. Results are in the plot panel.")).not.toBeInTheDocument()
    await runFit()
    const submitted = api.mock.calls.at(-1)?.[1] as ArtemisFitRequest
    expect(submitted).toMatchObject({ version: 4, transform: { kweight: [1, 3], dr: 0 } })
    expect(submitted.transform).not.toHaveProperty("unknown_transform_field")
    expect(submitted.paths[0]).not.toHaveProperty("unknown_path_field")
  })

  it("exports the exact fitting request, FEFF content and numerical result together", async () => {
    let blob: Blob | undefined
    vi.stubGlobal("URL", class extends URL { static createObjectURL(value: Blob) { blob = value; return "blob:test" } static revokeObjectURL() {} })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<ArtemisFittingPanel projectId="p" version={4} group={group()} />)
    await loadExample()
    await runFit()
    fireEvent.click(screen.getByRole("button", { name: "Export model JSON" }))
    const saved = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob!) })
    const bundle = JSON.parse(saved)
    expect(bundle.schema).toBe("artemis-web/v1")
    expect(bundle.request).toEqual(api.mock.calls.at(-1)?.[1])
    expect(bundle.request.paths[0].content).toBe(path().content)
    expect(bundle.result).toEqual(fitResult())
    vi.unstubAllGlobals()
  })
})

describe("ArtemisFitResultViewer", () => {
  it("shows complex residual magnitude, switches real/k views, and does not mutate cached data", () => {
    const result = fitResult()
    render(<ArtemisFitResultViewer result={result} group={group()} />)
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
