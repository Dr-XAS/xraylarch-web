import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { athenaApi, type AthenaGroup, type Parameters } from "@/lib/athena"
import { athenaPlotHeightKey } from "./athena-plot-card"
import { AthenaWavelet, athenaWaveletHeightKey, type WaveletResult } from "./athena-wavelet"

type Trace = {
  type: string; x: number[]; y: number[]; z: number[][]; colorscale: [number, string][]
  zmin?: number; zmax?: number; cmin?: number; cmax?: number
}
type Axis = { title: { text: string }; tickfont: { family: string; size: number } }
type PlotProps = {
  data: Trace[]
  layout: { width?: number; height?: number; xaxis: Axis; yaxis: Axis; scene: { xaxis: Axis; yaxis: Axis; zaxis: Axis } }
  onError: () => void
}
const plot = vi.hoisted(() => vi.fn((_props: PlotProps) => <div data-testid="wavelet-plot" />))
vi.mock("next/dynamic", () => ({ default: () => plot }))
vi.mock("@/lib/athena", () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)

const parameters: Parameters = {
  e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null,
  flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1,
  kmin: 0, kmax: 3, kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05,
}
function group(id = "Copper"): AthenaGroup {
  return {
    id, label: `${id} foil`, marked: false, frozen: false, data_type: "mu", energy: [10, 20, 30], mu: [1, 2, 3],
    multiplier: 1, offset: 0, notes: "", reference_id: null, parameters: { ...parameters }, processing_error: null, source: {},
    result: { effective: { kweight: 3 }, warnings: [], arrays: { k: [0, 1, 2, 3], chi: [0, 2, -1, 1] } },
  }
}
function result(overrides: Partial<WaveletResult> = {}): WaveletResult {
  return {
    project_id: "p", version: 4, group_id: "Copper", label: "Copper foil", kweight: 3,
    k: [0, 1, 2, 3], r: [0, 1, 2], magnitude: [[0, 1, 2, 0], [2, 5, 3, 1], [1, 2, 1, 0]],
    metadata: { wavelet: "cauchy" }, ...overrides,
  }
}
function serve() {
  api.mockImplementation(async (path, body) => {
    const { version, kweight } = body as { version: number; kweight: number }
    return result({ project_id: path.split("/")[2], group_id: path.split("/")[4], version, kweight })
  })
}
function deferred() {
  let resolve!: (value: WaveletResult) => void
  const promise = new Promise<WaveletResult>(done => { resolve = done })
  return { promise, resolve }
}
async function calculate() {
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
}
function handoff() {
  const props = plot.mock.calls.at(-1)?.[0]
  if (!props) throw new Error("No wavelet Plotly handoff")
  return props
}

beforeEach(() => { vi.useFakeTimers(); api.mockReset(); plot.mockClear(); localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear() })

describe("AthenaWavelet", () => {
  it("explains empty, unprocessed and failed spectra without calculating", async () => {
    const view = render(<AthenaWavelet kWeight={null} />)
    expect(screen.getByRole("status")).toHaveTextContent("Select a spectrum")
    expect(screen.queryByLabelText("Wavelet k-weight")).not.toBeInTheDocument()
    view.rerender(<AthenaWavelet kWeight={null} projectId="p" version={4} group={{ ...group(), result: null }} />)
    expect(screen.getByRole("status")).toHaveTextContent("require processed EXAFS")
    view.rerender(<AthenaWavelet kWeight={null} projectId="p" version={4} group={{ ...group(), processing_error: "No edge" }} />)
    expect(screen.getByRole("status")).toHaveTextContent("Resolve this spectrum’s processing error")
    await calculate()
    expect(api).not.toHaveBeenCalled()
    expect(plot).not.toHaveBeenCalled()
  })

  it("requests the current spectrum and revision using the effective Auto k-weight", async () => {
    serve()
    render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    expect(screen.getByText("Copper foil")).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent("Calculating wavelet transform")
    await calculate()
    expect(api).toHaveBeenCalledExactlyOnceWith("/projects/p/groups/Copper/wavelet", { version: 4, kweight: 3, rmax: 6 }, "POST", expect.any(AbortSignal))
    expect(screen.getByLabelText("2D wavelet heatmap")).toBeVisible()
    expect(handoff().data[0].z).toEqual(result().magnitude)
    expect(screen.getByText(/Cauchy wavelet.*k-weight 3/)).toBeVisible()
  })

  it("uses saved k-weight when effective weight is absent and supports an explicit override and Auto reset", async () => {
    serve()
    const current = group()
    delete current.result!.effective.kweight
    const view = render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={current} />)
    await calculate()
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 4, kweight: 2, rmax: 6 })
    view.rerender(<AthenaWavelet kWeight={0} projectId="p" version={4} group={current} />)
    expect(screen.queryByTestId("wavelet-plot")).not.toBeInTheDocument()
    await calculate()
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 4, kweight: 0, rmax: 6 })
    view.rerender(<AthenaWavelet kWeight={null} projectId="p" version={4} group={current} />)
    await calculate()
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 4, kweight: 2, rmax: 6 })
  })

  it("switches the same grid and color range between 2D and 3D in one panel without recalculating", async () => {
    const data = result()
    api.mockResolvedValue(data)
    render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    await calculate()
    const heatmap = handoff().data[0]
    expect(heatmap).toMatchObject({ type: "heatmap", zmin: 0, zmax: 5 })
    fireEvent.click(screen.getByRole("button", { name: "3D surface" }))
    const surface = handoff().data[0]
    expect(surface).toMatchObject({ type: "surface", cmin: heatmap.zmin, cmax: heatmap.zmax })
    expect(surface.x).toEqual(heatmap.x)
    expect(surface.y).toEqual(heatmap.y)
    expect(surface.z).toEqual(heatmap.z)
    expect(surface.colorscale).toEqual(heatmap.colorscale)
    expect(screen.getAllByTestId("wavelet-plot")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "3D surface" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByLabelText("2D wavelet heatmap")).not.toBeInTheDocument()
    const scene = handoff().layout.scene
    for (const axis of [scene.xaxis, scene.yaxis, scene.zaxis]) {
      expect(axis.tickfont.family).not.toContain("var(")
      expect(axis.tickfont.size).toBeGreaterThanOrEqual(12)
    }
    // Plotly may mutate its inputs; mode changes must start from the retained result.
    surface.z[1][1] = 999
    expect(data.magnitude[1][1]).toBe(5)
    fireEvent.click(screen.getByRole("button", { name: "2D heatmap" }))
    expect(handoff().data[0].z).toEqual(data.magnitude)
    await calculate()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("resizes the Plotly viewport and keeps a separate saved height across modes and spectrum revisions", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const card = this.closest<HTMLElement>(".ath-plot-card")
      const height = Number.parseFloat(card?.style.getPropertyValue("--ath-plot-height") ?? "") || 430
      return { width: 800, height } as DOMRect
    })
    function pointer(type: string, clientY: number) {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        button: { value: 0 }, clientY: { value: clientY }, pointerId: { value: 7 }, isPrimary: { value: true },
      })
      return event
    }
    localStorage.setItem(athenaPlotHeightKey, "720")
    serve()
    const view = render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    const grip = screen.getByRole("separator", { name: "Resize wavelet plot height" })
    expect(grip).toHaveAttribute("aria-controls", "athena-wavelet-viewer")
    await calculate()
    expect(handoff().layout).toMatchObject({ width: 800, height: 430 })

    fireEvent(grip, pointer("pointerdown", 500))
    fireEvent(window, pointer("pointermove", 680))
    fireEvent(window, new Event("resize"))
    expect(handoff().layout.height).toBe(610)
    expect(localStorage.getItem(athenaWaveletHeightKey)).toBeNull()
    fireEvent(window, pointer("pointerup", 680))
    expect(localStorage.getItem(athenaWaveletHeightKey)).toBe("610")
    expect(localStorage.getItem(athenaPlotHeightKey)).toBe("720")

    fireEvent.click(screen.getByRole("button", { name: "3D surface" }))
    expect(handoff().layout.height).toBe(610)
    expect(api).toHaveBeenCalledTimes(1)
    view.rerender(<AthenaWavelet kWeight={null} projectId="p" version={5} group={group()} />)
    expect(grip).toHaveAttribute("aria-valuenow", "610")
    await calculate()
    expect(handoff().layout.height).toBe(610)

    view.unmount()
    render(<AthenaWavelet kWeight={null} projectId="p" version={5} group={group()} />)
    await calculate()
    expect(handoff().layout.height).toBe(610)
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize wavelet plot height" }))
    fireEvent(window, new Event("resize"))
    expect(handoff().layout.height).toBe(430)
    expect(localStorage.getItem(athenaWaveletHeightKey)).toBeNull()
    expect(localStorage.getItem(athenaPlotHeightKey)).toBe("720")
  })

  it.each(["group", "version", "project", "weight"] as const)("ignores a late response after the %s changes", async change => {
    const previous = deferred(), next = deferred()
    api.mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise)
    const view = render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    await calculate()
    const previousSignal = api.mock.calls[0][3]!
    const nextId = change === "group" ? "Iron" : "Copper"
    const nextVersion = change === "version" ? 5 : 4
    const nextProject = change === "project" ? "other-project" : "p"
    const nextWeight = change === "weight" ? 1 : null
    view.rerender(<AthenaWavelet kWeight={nextWeight} projectId={nextProject} version={nextVersion} group={group(nextId)} />)
    expect(previousSignal.aborted).toBe(true)
    await calculate()
    await act(async () => { next.resolve(result({ project_id: nextProject, group_id: nextId, version: nextVersion, kweight: nextWeight ?? 3, magnitude: [[7, 8, 9, 8], [8, 9, 8, 7], [7, 8, 7, 6]] })) })
    expect(handoff().data[0].z[0][0]).toBe(7)
    await act(async () => { previous.resolve(result()) })
    expect(handoff().data[0].z[0][0]).toBe(7)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("hides the previous revision's result immediately while the new transform is pending", async () => {
    api.mockResolvedValueOnce(result()).mockReturnValueOnce(deferred().promise)
    const view = render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    await calculate()
    expect(screen.getByTestId("wavelet-plot")).toBeVisible()
    view.rerender(<AthenaWavelet kWeight={null} projectId="p" version={5} group={group()} />)
    expect(screen.queryByTestId("wavelet-plot")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Calculating")
    await calculate()
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 5, kweight: 3, rmax: 6 })
  })

  it("cancels an in-flight request while spectrum processing is pending and calculates the completed revision", async () => {
    const pending = deferred()
    api.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result({ version: 5 }))
    const view = render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    await calculate()
    const signal = api.mock.calls[0][3]!
    view.rerender(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} pending />)
    expect(signal.aborted).toBe(true)
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for spectrum processing")
    await act(async () => { pending.resolve(result()) })
    await calculate()
    expect(api).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("wavelet-plot")).not.toBeInTheDocument()
    view.rerender(<AthenaWavelet kWeight={null} projectId="p" version={5} group={group()} />)
    await calculate()
    expect(screen.getByTestId("wavelet-plot")).toBeVisible()
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 5, kweight: 3, rmax: 6 })
  })

  it("shows the API error and retries the current request", async () => {
    api.mockRejectedValueOnce(new Error("Project changed in another tab.")).mockResolvedValueOnce(result())
    render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    await calculate()
    expect(screen.getByRole("alert")).toHaveTextContent("Project changed in another tab.")
    expect(screen.queryByTestId("wavelet-plot")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(screen.getByRole("status")).toHaveTextContent("Calculating")
    await calculate()
    expect(screen.getByTestId("wavelet-plot")).toBeVisible()
    expect(api).toHaveBeenCalledTimes(2)
    expect(api.mock.calls[1].slice(0, 3)).toEqual(api.mock.calls[0].slice(0, 3))
  })

  it.each([
    ["revision", { version: 3 }],
    ["group", { group_id: "Iron" }],
    ["weight", { kweight: 2 }],
    ["unordered axis", { k: [0, 2, 1, 3] }],
    ["ragged grid", { magnitude: [[0, 1], [2], [3, 4]] }],
    ["nonfinite grid", { magnitude: [[0, 1, 2, 0], [2, Number.NaN, 3, 1], [1, 2, 1, 0]] }],
    ["negative magnitude", { magnitude: [[0, 1, 2, 0], [2, -5, 3, 1], [1, 2, 1, 0]] }],
  ] satisfies [string, Partial<WaveletResult>][])("rejects an invalid %s response instead of plotting it", async (_name, overrides) => {
    api.mockResolvedValueOnce(result(overrides))
    render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    await calculate()
    expect(screen.getByRole("alert")).toHaveTextContent("does not match this spectrum")
    expect(plot).not.toHaveBeenCalled()
  })

  it("can recover from a 3D rendering error by switching to the heatmap", async () => {
    serve()
    render(<AthenaWavelet kWeight={null} projectId="p" version={4} group={group()} />)
    await calculate()
    fireEvent.click(screen.getByRole("button", { name: "3D surface" }))
    act(() => { handoff().onError() })
    expect(screen.getByRole("alert")).toHaveTextContent("Try the 2D heatmap")
    fireEvent.click(screen.getByRole("button", { name: "2D heatmap" }))
    expect(screen.getByTestId("wavelet-plot")).toBeVisible()
    expect(handoff().data[0].type).toBe("heatmap")
    expect(api).toHaveBeenCalledTimes(1)
  })
})
