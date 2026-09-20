import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { athenaApi, type AthenaGroup, type Parameters } from "@/lib/athena"
import { plotlyColorscale } from "@/lib/athena-colormaps"
import type { PlotWeightResult } from "./athena-plot-weight"
import type { WaveletResult } from "./athena-wavelet"
import { WaveletFigure } from "./athena-wavelet-viewer"

type Trace = {
  type: string; name?: string; x: number[]; y: number[]; z?: number[][]
  colorscale?: [number, string][]; zmin?: number; zmax?: number; cmin?: number; cmax?: number
}
type PlotProps = {
  data: Trace[]
  layout: { shapes?: { x0: number; x1: number }[] }
  onRelayout?: (event: Record<string, unknown>) => void
}
const plots = vi.hoisted(() => new WeakMap<HTMLElement, PlotProps>())
vi.mock("./themed-plot", () => ({
  ThemedPlot: (props: PlotProps) => <div data-testid="wavelet-plot" ref={node => { if (node) plots.set(node, props) }} />,
}))
vi.mock("@/lib/athena", () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)

const parameters: Parameters = {
  e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null,
  flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1,
  kmin: 0, kmax: 5, kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05,
}
function group(): AthenaGroup {
  return {
    id: "Copper", label: "Copper foil", marked: false, frozen: false, data_type: "chi", energy: [], mu: [],
    multiplier: 1, offset: 0, notes: "", reference_id: null, parameters: { ...parameters }, processing_error: null, source: {},
    result: { effective: { exafs: true, kweight: 2, kmin: 1, kmax: 4 }, warnings: [], arrays: {
      k: [0, 1, 2, 3, 4, 5], chi: [0, 2, -1, 1, 0.5, -0.5],
      weighted_chi: [0, 2, -4, 9, 8, -12.5], kwin: [0, 0.5, 1, 1, 0.5, 0], r: [0, 1, 2], chir_mag: [0, 100, 50],
    } },
  }
}
function wavelet(): WaveletResult {
  return {
    project_id: "p", version: 4, group_id: "Copper", label: "Copper foil", kweight: 3,
    k: [0, 1, 2, 3, 4, 5], r: [0, 1, 2],
    magnitude: [[0, 1, 2, 0, 1, 0], [2, 5, 3, 1, 2, 0], [1, 2, 1, 0, 0, 1]], metadata: { wavelet: "cauchy" },
  }
}
function transformed(overrides: Partial<PlotWeightResult> = {}): PlotWeightResult {
  return {
    project_id: "p", version: 4, group_id: "Copper", kweight: 3,
    arrays: {
      k: [0, 1, 2, 3, 4, 5], chi: [0, 2, -1, 1, 0.5, -0.5],
      weighted_chi: [0, 10, -20, 30, 40, 50], kwin: [0, 0.25, 1, 0.5, 0, 0],
      r: [0, 1, 2], chir_mag: [0, 7, 5], chir_re: [0, 1, 2], chir_im: [0, 2, 1], chir_pha: [0, 0.5, 1],
    },
    effective: { kweight: 3, kmin: 3, kmax: 5 }, warnings: [], ...overrides,
  }
}
function serve() {
  api.mockImplementation(async (_path, body) => {
    const { kweight, kmin, kmax } = body as { kweight: number; kmin: number; kmax: number }
    return transformed({ effective: { kweight, kmin, kmax } })
  })
}
function deferred() {
  let resolve!: (data: PlotWeightResult) => void
  const promise = new Promise<PlotWeightResult>(done => { resolve = done })
  return { promise, resolve }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function currentPlots() { return screen.queryAllByTestId("wavelet-plot").map(node => plots.get(node)!) }
function mainPlot() {
  const found = currentPlots().find(plot => ["heatmap", "surface"].includes(plot.data[0]?.type))
  if (!found) throw new Error("No main wavelet plot")
  return found
}
function lineTraces() { return currentPlots().flatMap(plot => plot.data).filter(trace => trace.type === "scatter") }
function slider(name: string) { return screen.getByRole("slider", { name }) }
async function calculate(ms = 200) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

beforeEach(() => { vi.useFakeTimers(); api.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("WaveletFigure", () => {
  it("uses the server window and Fourier magnitude for side plots without changing saved processing or the wavelet grid", async () => {
    const data = freeze(wavelet()), spectrum = freeze(group()), response = freeze(transformed())
    api.mockResolvedValue(response)
    render(<WaveletFigure data={data} group={spectrum} mode="2d" colormap="magma" />)
    expect(mainPlot().data[0].z).toEqual(data.magnitude)
    expect(api).not.toHaveBeenCalled()
    await calculate()
    expect(api).toHaveBeenCalledExactlyOnceWith("/projects/p/groups/Copper/plot-transform",
      { version: 4, kweight: 3, kmin: 3, kmax: 5 }, "POST", expect.any(AbortSignal))
    expect(lineTraces()).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: [3, 4, 5], y: [15, 0, 0] }),
      expect.objectContaining({ x: response.arrays.r, y: response.arrays.chir_mag }),
    ]))
    expect(mainPlot().data[0].z).toEqual(data.magnitude)
    expect(spectrum.parameters.kweight).toBe(2)
    expect(spectrum.result!.arrays.chir_mag).toEqual([0, 100, 50])
  })

  it("debounces changes to the k range and leaves the retained wavelet unchanged", async () => {
    serve()
    const data = wavelet(), spectrum = group(), saved = JSON.stringify(spectrum)
    render(<WaveletFigure data={data} group={spectrum} mode="2d" colormap="magma" />)
    await calculate()
    fireEvent.change(slider("k minimum"), { target: { value: "1.5" } })
    fireEvent.change(slider("k minimum"), { target: { value: "1.75" } })
    fireEvent.change(slider("k maximum"), { target: { value: "3.5" } })
    expect(api).toHaveBeenCalledTimes(1)
    expect(lineTraces()).toHaveLength(0)
    expect(mainPlot().data[0].z).toEqual(data.magnitude)
    await calculate()
    expect(api).toHaveBeenCalledTimes(2)
    expect(api.mock.calls[1][1]).toEqual({ version: 4, kweight: 3, kmin: 1.75, kmax: 3.5 })
    expect(JSON.stringify(spectrum)).toBe(saved)
  })

  it("updates the range from a dragged Plotly boundary while ignoring ordinary zoom events", async () => {
    serve()
    render(<WaveletFigure data={wavelet()} group={group()} mode="2d" colormap="magma" />)
    await calculate()
    act(() => { mainPlot().onRelayout?.({ "xaxis.range[0]": 1, "xaxis.range[1]": 3 }) })
    await calculate()
    expect(api).toHaveBeenCalledTimes(1)
    act(() => { mainPlot().onRelayout?.({ "shapes[0].x0": 1.5, "shapes[0].x1": 1.5 }) })
    expect(slider("k minimum")).toHaveValue("1.5")
    await calculate()
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 4, kweight: 3, kmin: 1.5, kmax: 5 })
  })

  it("constrains crossed and out-of-bounds dragged ranges to the measured k domain", async () => {
    serve()
    render(<WaveletFigure data={wavelet()} group={group()} mode="2d" colormap="magma" />)
    await calculate()
    act(() => { mainPlot().onRelayout?.({ shapes: [{ x0: 4 }, { x0: 1 }] }) })
    expect(slider("k minimum")).toHaveValue("1")
    expect(slider("k maximum")).toHaveValue("4")
    await calculate()
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 4, kweight: 3, kmin: 1, kmax: 4 })
    act(() => { mainPlot().onRelayout?.({ "shapes[0].x0": -10, "shapes[1].x0": 100 }) })
    expect(slider("k minimum")).toHaveValue("0")
    expect(slider("k maximum")).toHaveValue("5")
    await calculate()
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 4, kweight: 3, kmin: 0, kmax: 5 })
  })

  it("aborts the previous range request and ignores its late response", async () => {
    const previous = deferred(), next = deferred()
    api.mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise)
    render(<WaveletFigure data={wavelet()} group={group()} mode="2d" colormap="magma" />)
    await calculate()
    const previousSignal = api.mock.calls[0][3]!
    fireEvent.change(slider("k minimum"), { target: { value: "1.5" } })
    expect(previousSignal.aborted).toBe(true)
    await calculate()
    const fresh = transformed({ effective: { kweight: 3, kmin: 1.5, kmax: 5 } })
    fresh.arrays.chir_mag = [0, 17, 15]
    await act(async () => { next.resolve(fresh) })
    expect(lineTraces()).toEqual(expect.arrayContaining([expect.objectContaining({ y: [0, 17, 15] })]))
    await act(async () => { previous.resolve(transformed()) })
    expect(lineTraces()).toEqual(expect.arrayContaining([expect.objectContaining({ y: [0, 17, 15] })]))
    expect(lineTraces()).not.toEqual(expect.arrayContaining([expect.objectContaining({ y: [0, 7, 5] })]))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the heatmap available on transform failure and retries the same selected range", async () => {
    api.mockRejectedValueOnce(new Error("Fourier service unavailable")).mockResolvedValueOnce(transformed())
    render(<WaveletFigure data={wavelet()} group={group()} mode="2d" colormap="magma" />)
    await calculate()
    expect(screen.getByRole("alert")).toHaveTextContent("Fourier service unavailable")
    expect(mainPlot().data[0].type).toBe("heatmap")
    expect(lineTraces()).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: /try again|retry/i }))
    await calculate()
    expect(api).toHaveBeenCalledTimes(2)
    expect(api.mock.calls[1][1]).toEqual(api.mock.calls[0][1])
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(lineTraces()).toHaveLength(2)
  })

  it.each(["revision", "project", "group", "weight", "effective-weight", "range", "window-length", "nonfinite", "unordered-r", "negative-magnitude", "overflow"])("rejects an invalid %s transform response", async invalid => {
    const response = transformed()
    if (invalid === "revision") response.version = 5
    if (invalid === "project") response.project_id = "other-project"
    if (invalid === "group") response.group_id = "Iron"
    if (invalid === "weight") response.kweight = 2
    if (invalid === "effective-weight") response.effective.kweight = 2
    if (invalid === "range") response.effective.kmin = 1
    if (invalid === "window-length") response.arrays.kwin = [0, 1]
    if (invalid === "nonfinite") response.arrays.chir_mag[1] = Number.NaN
    if (invalid === "unordered-r") response.arrays.r = [0, 2, 1]
    if (invalid === "negative-magnitude") response.arrays.chir_mag[1] = -1
    if (invalid === "overflow") { response.arrays.weighted_chi[3] = 1e308; response.arrays.kwin[3] = 2 }
    api.mockResolvedValue(response)
    render(<WaveletFigure data={wavelet()} group={group()} mode="2d" colormap="magma" />)
    await calculate()
    expect(screen.getByRole("alert")).toBeVisible()
    expect(lineTraces()).toHaveLength(0)
    expect(mainPlot().data[0].z).toEqual(wavelet().magnitude)
  })

  it("changes only the colorscale when the colormap changes", async () => {
    serve()
    const data = wavelet(), spectrum = group()
    const view = render(<WaveletFigure data={data} group={spectrum} mode="2d" colormap="magma" />)
    await calculate()
    expect(mainPlot().data[0].colorscale).toEqual(plotlyColorscale("magma"))
    view.rerender(<WaveletFigure data={data} group={spectrum} mode="2d" colormap="viridis" />)
    expect(mainPlot().data[0].colorscale).toEqual(plotlyColorscale("viridis"))
    expect(mainPlot().data[0].z).toEqual(data.magnitude)
    await calculate()
    expect(api).toHaveBeenCalledTimes(1)
  })
})
