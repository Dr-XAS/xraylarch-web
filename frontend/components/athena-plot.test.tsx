import "@testing-library/jest-dom/vitest"
import type { ComponentProps } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AthenaGroup, Parameters } from "@/lib/athena"
import { AthenaPlot, type Space } from "./athena-plot"

type Trace = { name: string; x: number[]; y: number[]; yaxis?: string }
type Handoff = {
  data: Trace[]
  onClick?: (event: { points?: Array<{ x?: unknown; y?: unknown }> }) => void
  layout: {
    xaxis: { title: { text: string }; range?: number[] }
    yaxis: { title: { text: string } }
    yaxis2?: { title: { text: string } }
  }
}

// Render the real AthenaPlot; replace only its dynamically loaded Plotly view.
const plotly = vi.hoisted(() => vi.fn((_props: Handoff) => null))
vi.mock("next/dynamic", () => ({ default: () => plotly }))

beforeEach(() => plotly.mockClear())
afterEach(cleanup)

const parameters: Parameters = {
  e0: 8980, step: null, pre1: -150, pre2: -30, norm1: 100, norm2: 300,
  nnorm: 2, flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null,
  bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1, kmin: 3, kmax: 12,
  kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 4, nfft: 2048, kstep: 0.05,
}

function group(id = "Sample", weight = 2): AthenaGroup {
  return {
    id, label: id, marked: true, frozen: false, data_type: "mu",
    energy: [8956, 8976, 8996], mu: [1, 2, 3],
    multiplier: 1, offset: 0, notes: "", reference_id: null,
    parameters: { ...parameters, kweight: weight }, processing_error: null, source: {},
    result: {
      effective: { kweight: weight }, warnings: [],
      arrays: {
        energy: [8960, 8980, 9000], mu: [1, 2, 3], norm: [0, 0.7, 1], flat: [0, 0.8, 1],
        dmude: [0.01, 0.1, 0.02], d2mude: [0.001, 0, -0.001],
        pre_edge: [0.1, 0.2, 0.3], post_edge: [2, 3, 4], bkg: [0.5, 1, 1.5],
        k: [0, 1, 2, 3, 4], chi: [0.2, -0.1, 0.3, -0.2, 0.1],
        weighted_chi: [0.2, -0.1, 0.3, -0.2, 0.1].map((v, k) => v * k ** weight),
        kwin: [0, 0.5, 1, 0.5, 0],
        r: [0, 1, 2], rwin: [0, 1, 0], chir_re: [3, 0, -3], chir_im: [4, 5, 4],
        chir_mag: [5, 5, 5], chir_pha: [Math.atan2(4, 3), Math.PI / 2, Math.atan2(4, -3)],
        q: [1, 1.5, 2.5, 3], chiq_re: [3, 0, -3, 0], chiq_im: [-4, -5, -4, 5],
        chiq_mag: [5, 5, 5, 5], chiq_pha: [Math.atan2(-4, 3), -Math.PI / 2, Math.atan2(-4, -3), -3 * Math.PI / 2],
      },
    },
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function show(props: Partial<ComponentProps<typeof AthenaPlot>> = {}) {
  const sample = group()
  return render(<AthenaPlot groups={[sample]} active={sample} space="E" energyMode="mu"
    component="mag" background={false} window={false} offset={0}
    analysis={null} analysisVisible={false} range={[null, null]} {...props} />)
}

function handoff(): Handoff {
  const call = plotly.mock.calls.at(-1)
  if (!call) throw new Error("No Plotly handoff was rendered")
  return call[0]
}

describe("AthenaPlot coordinate picking", () => {
  it.each<Space>(["E", "k", "R"])("reports the finite plotted x in %s space without applying offsets to it", space => {
    const onPickX = vi.fn()
    const active = group()
    active.multiplier = 7; active.offset = 20
    show({ groups: [active], active, space, picking: true, onPickX, offset: 100 })
    const x = { E: 8980, k: 2, R: 1, q: 2 }[space]
    handoff().onClick!({ points: [{ x, y: -10000 }] })
    expect(onPickX).toHaveBeenCalledExactlyOnceWith(x, space)
    expect(screen.getByTestId("athena-plot")).toHaveClass("ath-picking")
  })

  it("ignores ordinary clicks, analysis plots and q coordinates", () => {
    const onPickX = vi.fn()
    const { unmount } = show({ onPickX })
    handoff().onClick!({ points: [{ x: 8980 }] })
    unmount()
    const q = show({ space: "q", picking: true, onPickX })
    handoff().onClick!({ points: [{ x: 2 }] })
    q.unmount()
    show({ picking: true, onPickX, analysisVisible: true, analysis: {
      kind: "pca", project_version: 1, group_ids: [], options: {}, result: { explained_variance_ratio: [0.9, 0.1] },
    } })
    handoff().onClick!({ points: [{ x: 1 }] })
    expect(onPickX).not.toHaveBeenCalled()
    expect(screen.getByTestId("athena-plot")).not.toHaveClass("ath-picking")
  })

  it("ignores missing, string and nonfinite coordinates while armed", () => {
    const onPickX = vi.fn()
    show({ picking: true, onPickX })
    handoff().onClick!({})
    handoff().onClick!({ points: [] })
    for (const x of [undefined, null, "8980", NaN, Infinity, -Infinity]) handoff().onClick!({ points: [{ x }] })
    expect(onPickX).not.toHaveBeenCalled()
    handoff().onClick!({ points: [{ x: 0 }] })
    expect(onPickX).toHaveBeenCalledExactlyOnceWith(0, "E")
  })
})

describe("AthenaPlot backgrounds and displayed groups", () => {
  it("gives active background curves the same multiplier, group offset, and stack offset as the signal", () => {
    const sample = group("Scaled")
    sample.multiplier = 2
    sample.offset = 3
    const before = structuredClone(sample)
    freeze(sample)
    show({ groups: [group("First"), sample], active: sample, background: true, offset: 10 })
    const { data } = handoff()
    expect(data.map(trace => trace.name)).toEqual([
      "First", "Scaled", "Pre-edge line · Scaled", "Post-edge polynomial · Scaled", "Background μ₀(E) · Scaled",
    ])
    expect(data[1].y).toEqual([15, 17, 19])
    expect(data[2].y).toEqual([13.2, 13.4, 13.6])
    expect(data[3].y).toEqual([17, 19, 21])
    expect(data[4].y).toEqual([14, 15, 16])
    data.slice(1).forEach(trace => expect(trace.x).toEqual([8960, 8980, 9000]))
    expect(sample).toEqual(before)
    expect(data[1].x).not.toBe(sample.result!.arrays.energy)
    expect(data[1].y).not.toBe(sample.result!.arrays.mu)
  })

  it.each<Space>(["E", "k", "R", "q"])("does not add an unplotted active group's overlays in %s space", space => {
    const marked = group("Marked")
    const active = group("Unmarked", 3)
    active.marked = false
    show({ groups: [marked], active, space, background: true, window: true })
    expect(handoff().data.map(trace => trace.name)).toEqual(["Marked"])
  })

  it("does not add windows for an active group whose selected signal is unavailable", () => {
    const active = group("Unavailable", 3)
    active.result!.arrays.weighted_chi = []
    show({ groups: [active, group("Visible", 1.75)], active, space: "k", window: true })
    expect(handoff().data.map(trace => trace.name)).toEqual(["Visible"])
    expect(handoff().layout.yaxis.title.text).toBe("k<sup>1.75</sup> χ(k)")
  })

  it("uses the plotted group's snapshot for overlay values and scaling", () => {
    const current = group()
    current.multiplier = 2
    const staleActive = group()
    staleActive.offset = 100
    show({ groups: [current], active: staleActive, background: true })
    expect(handoff().data.find(trace => trace.name.startsWith("Background"))?.y).toEqual([1, 2, 3])
  })

  it.each(["norm", "flat", "dmude", "d2mude"])("does not overlay raw-mu backgrounds on %s", energyMode => {
    show({ energyMode, background: true })
    expect(handoff().data).toHaveLength(1)
  })
})

describe("AthenaPlot weight labels and complex components", () => {
  it("labels the actual displayed effective weight independently of the active group's recipe", () => {
    const displayed = group("Displayed", 1.75)
    displayed.parameters.kweight = 3
    show({ groups: [displayed], active: group("Unmarked", 4), space: "k" })
    expect(handoff().layout.yaxis.title.text).toBe("k<sup>1.75</sup> χ(k)")
    expect(handoff().data[0].y).toEqual(displayed.result!.arrays.weighted_chi)
  })

  it("uses saved recipe weights for older results without effective kweight", () => {
    const sample = group("Older", 0.75)
    delete sample.result!.effective.kweight
    show({ groups: [sample], active: undefined, space: "k" })
    expect(handoff().layout.yaxis.title.text).toBe("k<sup>0.75</sup> χ(k)")
  })

  it.each<Space>(["k", "R", "q"])("identifies each displayed weight when %s traces use mixed weights", space => {
    const first = group("First", 1.25), second = group("Second", 3)
    show({ groups: [first, second], active: group("Unmarked", 4), space })
    expect(handoff().data.map(trace => trace.name)).toEqual(["First (k-weight 1.25)", "Second (k-weight 3)"])
    if (space === "k") expect(handoff().layout.yaxis.title.text).toBe("k-weighted χ(k) (weights in legend)")
  })

  it.each(["R", "q"] as const)("preserves %s complex values and axes with only cosmetic scaling", space => {
    const sample = group("Complex", 3.5)
    sample.multiplier = 2
    sample.offset = 3
    const before = structuredClone(sample)
    freeze(sample)
    const a = sample.result!.arrays
    const view = show({ groups: [sample], active: sample, space })
    for (const component of ["mag", "re", "im", "pha"]) {
      view.rerender(<AthenaPlot groups={[sample]} active={sample} space={space} energyMode="mu"
        component={component} background={false} window={false} offset={0}
        analysis={null} analysisVisible={false} range={[null, null]} />)
      const key = `${space === "R" ? "chir" : "chiq"}_${component}`
      expect(handoff().data[0].x).toEqual(a[space === "R" ? "r" : "q"])
      expect(handoff().data[0].y).toEqual(a[key].map(value => 2 * value + 3))
      expect(handoff().layout.xaxis.title.text).toBe(space === "R" ? "R (Å)" : "q (Å⁻¹)")
      if (component === "pha") expect(handoff().layout.yaxis.title.text).toContain("(rad)")
    }
    expect(sample).toEqual(before)
  })
})

describe("AthenaPlot transform windows", () => {
  it.each(["k", "R"] as const)("pairs the %s window with its own axis and identifies its plotted owner", space => {
    const sample = group("Window owner")
    sample.multiplier = 7
    sample.offset = 20
    freeze(sample)
    show({ groups: [sample], active: sample, space, window: true })
    const window = handoff().data[1]
    expect(window.name).toBe(`${space === "R" ? "R" : "Forward"} window · Window owner`)
    expect(window.x).toEqual(sample.result!.arrays[space === "R" ? "r" : "k"])
    expect(window.y).toEqual(sample.result!.arrays[space === "R" ? "rwin" : "kwin"])
    expect(window.x).toHaveLength(window.y.length)
  })

  it("maps the forward window onto q without extrapolation or using the R window", () => {
    const sample = group("Filtered")
    Object.assign(sample.result!.arrays, {
      k: [1, 2, 4], kwin: [0, 1, 0], rwin: [0.9, 0.9, 0.9],
      q: [0.5, 1, 1.5, 2, 3, 4, 4.5], chiq_im: [-3, -2, -1, 0, 1, 2, 3],
    })
    const before = structuredClone(sample)
    freeze(sample)
    show({ groups: [sample], active: sample, space: "q", component: "im", window: true })
    expect(handoff().data[0].y).toEqual([-3, -2, -1, 0, 1, 2, 3])
    expect(handoff().data[1]).toMatchObject({
      name: "Forward window · Filtered", x: [1, 1.5, 2, 3, 4], y: [0, 0.5, 1, 0.5, 0],
    })
    expect(sample).toEqual(before)
  })

  it("limits q interpolation to paired k/window support when window values end before k", () => {
    const sample = group()
    Object.assign(sample.result!.arrays, {
      k: [0, 1, 2, 3], kwin: [0.2, 0.8], q: [0, 0.5, 1, 1.5, 2], chiq_mag: [1, 2, 3, 4, 5],
    })
    show({ groups: [sample], active: sample, space: "q", window: true })
    expect(handoff().data[1].x).toEqual([0, 0.5, 1])
    expect(handoff().data[1].y).toEqual([0.2, 0.5, 0.8])
  })

  it.each([
    { k: [10, 11], kwin: [0, 1] },
    { k: [0, 1], kwin: [] },
    { k: [], kwin: [] },
    { k: [1], kwin: [1] },
  ])("omits q windows without sufficient overlapping support: %j", arrays => {
    const sample = group()
    Object.assign(sample.result!.arrays, arrays)
    show({ groups: [sample], active: sample, space: "q", window: true })
    expect(handoff().data).toHaveLength(1)
  })

  it("never sends unequal R/window array lengths to Plotly", () => {
    const sample = group()
    sample.result!.arrays.rwin = [0, 1, 0, 0]
    show({ groups: [sample], active: sample, space: "R", window: true })
    expect(handoff().data[1].x).toEqual([0, 1, 2])
    expect(handoff().data[1].y).toEqual([0, 1, 0])
  })
})

describe("AthenaPlot failed processing and analysis axes", () => {
  function failedChi() {
    const sample = group("Failed χ", 2.5)
    Object.assign(sample, { data_type: "chi", energy: [4, 4.5, 5], mu: [0.1, -0.2, 0.3], result: null, processing_error: "Invalid FT range" })
    return sample
  }

  it.each(["mu", "norm", "flat", "dmude", "d2mude"])("does not misrepresent failed chi as E-space %s", energyMode => {
    const sample = failedChi()
    show({ groups: [sample], active: sample, energyMode })
    expect(plotly).not.toHaveBeenCalled()
    expect(screen.getByText("No data in this plot space")).toBeInTheDocument()
  })

  it("shows failed chi as unweighted chi on the native k grid, without an energy shift", () => {
    const sample = freeze(failedChi())
    show({ groups: [sample], active: sample, space: "k", window: true })
    expect(handoff().data).toHaveLength(1)
    expect(handoff().data[0]).toMatchObject({ name: "Failed χ (unprocessed χ(k))", x: [4, 4.5, 5], y: [0.1, -0.2, 0.3] })
    expect(handoff().layout.xaxis.title.text).toBe("k (Å⁻¹)")
    expect(handoff().layout.yaxis.title.text).toBe("χ(k)")
  })

  it("identifies the zero weight of raw chi when shown with processed weighted chi", () => {
    show({ groups: [failedChi(), group("Processed", 1.5)], space: "k" })
    expect(handoff().data.map(trace => trace.name)).toEqual([
      "Failed χ (unprocessed χ(k)) (k-weight 0)", "Processed (k-weight 1.5)",
    ])
    expect(handoff().layout.yaxis.title.text).toContain("weights in legend")
  })

  it.each<Space>(["R", "q"])("does not invent %s products for failed chi", space => {
    const sample = failedChi()
    show({ groups: [sample], active: sample, space, window: true })
    expect(plotly).not.toHaveBeenCalled()
  })

  it("retains shifted raw mu fallback for failed energy processing", () => {
    const sample = group()
    sample.result = null
    freeze(sample)
    show({ groups: [sample], active: sample })
    expect(handoff().data[0]).toMatchObject({ x: [8960, 8980, 9000], y: [1, 2, 3] })
    expect(handoff().layout.xaxis.title.text).toBe("Energy (eV)")
  })

  it.each(["chi", "weighted_chi", "norm", "flat", "dmude", "mu"])("labels the supported %s analysis coordinates correctly", array => {
    const result = freeze({ x: [4, 5], observed: [1, 2], fit: [1.1, 1.9], residual: [-0.1, 0.1] })
    show({ analysisVisible: true, background: true, window: true,
      analysis: { kind: "lcf", project_version: 1, group_ids: ["Sample"], options: { array }, result } })
    const { data, layout } = handoff()
    expect(data.map(trace => trace.name)).toEqual(["Observed", "Fit", "Residual"])
    expect(layout.xaxis.title.text).toBe(["chi", "weighted_chi"].includes(array) ? "k (Å⁻¹)" : "Energy (eV)")
    expect(data[0].y).toEqual(result.observed)
    expect(data[0].y).not.toBe(result.observed)
  })

  it("skips malformed imported report arrays and assigns the phase axis only to an added phase trace", () => {
    const sample = group()
    const props = {
      groups: [sample], active: sample, space: "k" as const, energyMode: "mu", component: "mag",
      background: false, window: false, offset: 0, analysisVisible: true, range: [null, null] as [null, null],
    }
    const report = (result: Record<string, unknown>) => ({
      kind: "log_ratio", project_version: 1, group_ids: [sample.id], options: {}, result,
    })
    const view = render(<AthenaPlot {...props} analysis={report({ k: [3, 4], log_amplitude_ratio: [0.1, 0.2] })} />)
    expect(handoff().data).toHaveLength(1)
    expect(handoff().data[0]).toMatchObject({ name: "ln(A target / A reference)", y: [0.1, 0.2] })
    expect(handoff().data[0].yaxis).toBeUndefined()

    view.rerender(<AthenaPlot {...props} analysis={report({
      k: [3, 4], log_amplitude_ratio: { invalid: true }, phase_difference: [0.3, 0.4],
    })} />)
    expect(handoff().data).toHaveLength(1)
    expect(handoff().data[0]).toMatchObject({ name: "Phase difference (rad)", y: [0.3, 0.4], yaxis: "y2" })

    for (const result of [
      { k: [3, 4], log_amplitude_ratio: [0.1], phase_difference: "invalid" },
      { log_amplitude_ratio: [0.1, 0.2], phase_difference: [0.3, 0.4] },
      { k: { invalid: true }, log_amplitude_ratio: [0.1, 0.2] },
    ]) {
      plotly.mockClear()
      view.rerender(<AthenaPlot {...props} analysis={report(result)} />)
      expect(plotly).not.toHaveBeenCalled()
      expect(screen.getByText("No data in this plot space")).toBeInTheDocument()
    }
  })
})
