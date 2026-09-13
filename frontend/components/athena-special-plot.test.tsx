import "@testing-library/jest-dom/vitest"

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { athenaApi, type AthenaGroup, type Parameters } from "@/lib/athena"
import { AthenaSpecialPlot, type AthenaSpecialPlotKind } from "./athena-special-plot"

type Trace = { x: number[]; y: number[]; name: string; yaxis?: string }
type Handoff = { data: Trace[]; layout: { xaxis: { title: { text: string }; range?: number[] }; yaxis: { title: { text: string } } } }
const plotly = vi.hoisted(() => vi.fn((_props: Handoff) => null))
vi.mock("next/dynamic", () => ({ default: () => plotly }))
vi.mock("@/lib/athena", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/athena")>(), athenaApi: vi.fn() }))

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

const parameters: Parameters = {
  e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null,
  flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1,
  kmin: 0, kmax: 3, kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 2, nfft: 2048, kstep: 0.05,
}

function group(id = "Copper", marked = true): AthenaGroup {
  return { id, label: id, marked, frozen: false, data_type: "mu", energy: [10, 20, 30], mu: [1, 2, 3],
    multiplier: 1, offset: 0, notes: "", reference_id: null, parameters: { ...parameters }, processing_error: null,
    source: { raw_arrays: { i0: [100, 200, 300], signal: [10, 20, 30] } },
    result: { effective: { e0: 22, edge_step: 2, kweight: 2 }, warnings: [], arrays: {
      energy: [12, 22, 32], mu: [1, 2, 3], norm: [0, 0.5, 1], dmude: [0.01, 0.2, -0.05],
      k: [0, 1, 2, 3], chi: [0, 2, -1, 1], weighted_chi: [0, 2, -4, 9],
      r: [0, 1, 2], chir_mag: [2, 4, 2], chir_re: [-2, 4, -2],
      q: [0, 1, 2], chiq_mag: [1, 3, 1], chiq_re: [-1, 3, -1],
    } },
  }
}

function show(kind: AthenaSpecialPlotKind, groups = [group()], active = groups[0]) {
  return render(<AthenaSpecialPlot kind={kind} groups={groups} active={active} />)
}
function handoff() {
  const props = plotly.mock.calls.at(-1)?.[0]
  if (!props) throw new Error("No Plotly handoff")
  return props
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function r123(id = "Copper", version = 5) {
  return { group_id: id, version, warnings: [], curves: [1, 2, 3].map(kweight => ({ kweight,
    arrays: { r: [0, 1, 2], chir_mag: [kweight, 2 * kweight, kweight], chir_re: [-kweight, 2 * kweight, -kweight], chir_im: [0, 0, 0], chir_pha: [Math.PI, 0, Math.PI] },
  })) }
}

describe("AthenaSpecialPlot", () => {
  it("plots only the current group’s retained channels, aligned to shifted source energy and scaled as Athena", () => {
    const current = group("Current", false)
    current.multiplier = 2; current.offset = 4
    freeze(current)
    show("i0sig", [group("Other"), current], current)
    expect(handoff().data.map(trace => trace.name)).toEqual(["Current · μ(E)", "Current · I₀ · scaled by 0.01", "Current · Signal · scaled by 0.1"])
    for (const trace of handoff().data) {
      expect(trace.x).toEqual([12, 22, 32])
      expect(trace.y).toEqual([6, 8, 10])
    }
    expect(athenaApi).not.toHaveBeenCalled()
  })

  it("explains missing or mismatched detector channels without fabricating counts", () => {
    const current = group()
    current.source.raw_arrays = { i0: [1, 2] }
    show("i0sig", [current])
    expect(handoff().data).toHaveLength(1)
    expect(screen.getByText(/no aligned I₀ channel/)).toBeInTheDocument()
    expect(screen.getByText(/no aligned Signal channel/)).toBeInTheDocument()
  })

  it("keeps marked I₀ in source units with saved display multipliers and group offsets", () => {
    const first = group("First"), second = group("Second"), hidden = group("Unmarked", false)
    first.multiplier = 2; second.offset = 3
    show("i0", [first, hidden, second], hidden)
    expect(handoff().data.map(trace => trace.name)).toEqual(["First · I₀", "Second · I₀"])
    expect(handoff().data[0].y).toEqual([200, 400, 600])
    expect(handoff().data[1].y).toEqual([103, 203, 303])
    expect(handoff().layout.yaxis.title.text).toBe("I₀ (source units)")
  })

  it("shows normalized data and the stored normalized derivative with explicit native comparison scaling", () => {
    const current = group(); current.multiplier = 2; current.offset = 1
    show("normderiv", [current])
    const [norm, derivative] = handoff().data
    expect(norm.y).toEqual([1, 2, 3])
    expect(derivative.name).toMatch(/normalized derivative · scaled by 2.500/)
    expect(derivative.y).toEqual([1.025, 1.5, 0.875])
    expect(handoff().layout.xaxis.range).toEqual([-8, 92])
    expect(screen.getByText(/scales the normalized derivative/)).toBeInTheDocument()
  })

  it("does not label difference data as normalized absorption in the derivative shortcut", () => {
    const current = group(); current.is_difference = true
    show("normderiv", [current])
    expect(plotly).not.toHaveBeenCalled()
    expect(screen.getByText(/requires an absorption spectrum/)).toBeInTheDocument()
  })

  it("calculates k123 from unweighted χ with native signed maxima, scales and offsets without modifying the group", () => {
    const current = group(); current.multiplier = 9; current.offset = 99
    freeze(current)
    show("k123", [current])
    const [one, two, three] = handoff().data
    expect(one.name).toContain("k-weight 1 · scaled by 3.000")
    expect(three.name).toContain("k-weight 3 · scaled by 0.333")
    expect(two.y).toEqual([0, 2, -4, 9])
    expect(one.y[1]).toBeCloseTo(16.8)
    expect(three.y[3]).toBeCloseTo(-1.809)
    expect(current.result!.arrays.weighted_chi).toEqual([0, 2, -4, 9])
  })

  it("can compare raw χ(k) and explains unavailable EXAFS data", () => {
    const raw = group(); raw.result = null; raw.data_type = "chi"; raw.energy = [0, 1, 2]; raw.mu = [0, 1, 2]
    const rendered = show("k123", [raw])
    expect(handoff().data).toHaveLength(3)
    rendered.unmount(); plotly.mockClear()
    raw.data_type = "xanes"
    show("k123", [raw])
    expect(plotly).not.toHaveBeenCalled()
    expect(screen.getByText(/processed χ\(k\) is unavailable/)).toBeInTheDocument()
  })

  it("subtracts each marked group’s effective E₀ from its own shifted energy", () => {
    const first = group("First"), second = group("Second"), hidden = group("Unmarked", false)
    second.result!.effective.e0 = 20
    show("e00", [first, hidden, second], hidden)
    expect(handoff().data.map(trace => trace.x)).toEqual([[-10, 0, 10], [-8, 2, 12]])
    expect(handoff().layout.xaxis.title.text).toBe("E − E₀ (eV)")
    expect(handoff().data[0].y).toEqual([0, 0.5, 1])
  })

  it("replaces the display multiplier with each marked group’s own edge step for the native scaled normalization", () => {
    const first = group("First"), second = group("Second")
    first.multiplier = 100; first.offset = 3; second.result!.effective.edge_step = 4
    freeze(first); freeze(second)
    show("normscaled", [first, second])
    expect(handoff().data.map(trace => trace.y)).toEqual([[3, 4, 5], [0, 2, 4]])
    expect(first.multiplier).toBe(100)
  })

  it("reports missing edge values instead of silently shifting or scaling by zero", () => {
    const current = group(); current.result!.effective = {}
    const rendered = show("e00", [current])
    expect(plotly).not.toHaveBeenCalled()
    expect(screen.getByText(/E₀ is unavailable/)).toBeInTheDocument()
    rendered.unmount()
    show("normscaled", [current])
    expect(plotly).not.toHaveBeenCalled()
    expect(screen.getByText(/edge step is unavailable/)).toBeInTheDocument()
  })

  it("shows four current-group panels, and overlays exactly two marked groups in biquad", () => {
    const current = group("Current", false), first = group("First"), second = group("Second")
    const rendered = show("quad", [first, current, second], current)
    expect(plotly).toHaveBeenCalledTimes(4)
    expect(plotly.mock.calls.every(([props]) => props.data.length === 1 && props.data[0].name === "Current")).toBe(true)
    rendered.unmount(); plotly.mockClear()
    show("biquad", [first, current, second], current)
    expect(plotly).toHaveBeenCalledTimes(4)
    expect(plotly.mock.calls.every(([props]) => props.data.map(trace => trace.name).join() === "First,Second")).toBe(true)
  })

  it("requires exactly two marked groups for biquad and a selection for other shortcuts", () => {
    const rendered = show("biquad")
    expect(screen.getByRole("status")).toHaveTextContent("Mark exactly two groups")
    expect(plotly).not.toHaveBeenCalled()
    rendered.unmount()
    show("i0", [group("Unmarked", false)])
    expect(screen.getByRole("status")).toHaveTextContent("Mark groups")
  })

  it("requests separate read-only R transforms and applies native comparison scaling to the returned arrays", async () => {
    vi.mocked(athenaApi).mockResolvedValue(r123())
    const current = group(); freeze(current)
    render(<AthenaSpecialPlot kind="r123" groups={[current]} active={current} projectId="project" version={5} component="re" />)
    expect(screen.getByRole("status")).toHaveTextContent("Calculating Fourier transforms")
    await waitFor(() => expect(plotly).toHaveBeenCalled())
    expect(athenaApi).toHaveBeenCalledWith("/projects/project/context-plot", { version: 5, group_id: "Copper", kind: "r123" }, "POST", expect.any(AbortSignal))
    expect(handoff().data[0].y).toEqual([2, 8, 2])
    expect(handoff().data[1].y).toEqual([-2, 4, -2])
    expect(handoff().data[2].y[1]).toBeCloseTo(0.002)
    expect(current.result!.effective.kweight).toBe(2)
  })

  it("rejects stale or incomplete R comparison results", async () => {
    vi.mocked(athenaApi).mockResolvedValue(r123("Other"))
    const current = group()
    render(<AthenaSpecialPlot kind="r123" groups={[current]} active={current} projectId="project" version={5} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match this spectrum")
    expect(plotly).not.toHaveBeenCalled()
  })

  it("ignores an in-flight R result after switching to another shortcut", async () => {
    let resolve: (value: ReturnType<typeof r123>) => void = () => {}
    vi.mocked(athenaApi).mockReturnValue(new Promise(done => { resolve = done }))
    const current = group()
    const rendered = render(<AthenaSpecialPlot kind="r123" groups={[current]} active={current} projectId="project" version={5} />)
    rendered.rerender(<AthenaSpecialPlot kind="i0sig" groups={[current]} active={current} projectId="project" version={5} />)
    await act(async () => { resolve(r123()) })
    expect(handoff().data[0].name).toBe("Copper · μ(E)")
    const signal = vi.mocked(athenaApi).mock.calls[0][3]!
    expect(signal.aborted).toBe(true)
  })
})
