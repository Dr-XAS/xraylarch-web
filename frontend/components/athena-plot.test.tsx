import "@testing-library/jest-dom/vitest"
import type { ComponentProps } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AthenaGroup, Parameters } from "@/lib/athena"
import { AthenaPlot, type Space } from "./athena-plot"
import { automaticPlotRange } from "./athena-plot-range"

type Trace = {
  name: string; x: number[]; y: number[]; yaxis?: string; line?: { color?: string; dash: string }
  mode?: string; text?: string[]; customdata?: number[]; showlegend?: boolean
  marker?: { symbol?: string[]; color?: string; size?: number }
}
type Handoff = {
  data: Trace[]
  onClick?: (event: { points?: Array<{ x?: unknown; y?: unknown }> }) => void
  layout: {
    xaxis: { title: { text: string }; showgrid?: boolean; range?: Array<number | null>; autorange?: boolean | "min" | "max" }
    yaxis: { title: { text: string }; showgrid?: boolean }
    yaxis2?: { title: { text: string } }
    uirevision: string
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

describe("AthenaPlot display options", () => {
  it("uses the spectrum-only PR palette settings", () => {
    const first = group("First")
    const second = group("Second")
    show({ groups: [first, second], active: first, colorSettings: { palette: "viridis", reversed: true } })
    expect(handoff().data.map(trace => trace.line?.color)).toEqual(["#fde725", "#440154"])
  })

  it("keeps the current line-and-grid presentation by default", () => {
    show()
    expect(handoff().data[0]).toMatchObject({ mode: "lines" })
    expect(handoff().data[0].marker).toBeUndefined()
    expect(handoff().layout.xaxis.showgrid).toBe(true)
    expect(handoff().layout.yaxis.showgrid).toBe(true)
  })

  it("shows measured data points without adding points to fitted overlays", () => {
    show({ showGrid: false, showDataPoints: true, plotScope: "current", background: true })
    const [spectrum, background] = handoff().data
    expect(spectrum).toMatchObject({ mode: "lines+markers", marker: { color: spectrum.line?.color, size: 4 } })
    expect(background).toMatchObject({ mode: "lines", name: "Background μ₀(E) · Sample" })
    expect(background.marker).toBeUndefined()
    expect(handoff().layout.xaxis.showgrid).toBe(false)
    expect(handoff().layout.yaxis.showgrid).toBe(false)
  })

  it("opens checked plot options on right-click and sends the inverse settings", () => {
    const onShowGridChange = vi.fn()
    const onShowDataPointsChange = vi.fn()
    const onOptionsMenuOpen = vi.fn()
    show({ onShowGridChange, onShowDataPointsChange, onOptionsMenuOpen })
    const plot = screen.getByTestId("athena-plot")
    fireEvent.contextMenu(plot, { clientX: 120, clientY: 160 })
    expect(onOptionsMenuOpen).toHaveBeenCalledOnce()
    expect(screen.getByRole("menu", { name: "Spectrum plot options" })).toBeVisible()
    expect(screen.getByRole("menuitemcheckbox", { name: "Show grids" })).toHaveAttribute("aria-checked", "true")
    const points = screen.getByRole("menuitemcheckbox", { name: "Show data points" })
    expect(points).toHaveAttribute("aria-checked", "false")
    fireEvent.click(points)
    expect(onShowDataPointsChange).toHaveBeenCalledWith(true)
    expect(plot).toHaveFocus()

    fireEvent.contextMenu(plot, { clientX: 130, clientY: 170 })
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show grids" }))
    expect(onShowGridChange).toHaveBeenCalledWith(false)
  })

  it("opens from the keyboard and restores plot focus on Escape", () => {
    show()
    const plot = screen.getByTestId("athena-plot")
    plot.focus()
    fireEvent.keyDown(plot, { key: "F10", shiftKey: true })
    const menu = screen.getByRole("menu", { name: "Spectrum plot options" })
    expect(menu).toBeVisible()
    fireEvent.keyDown(menu, { key: "Escape" })
    expect(screen.queryByRole("menu", { name: "Spectrum plot options" })).not.toBeInTheDocument()
    expect(plot).toHaveFocus()
  })
})

describe("AthenaPlot difference signal labels", () => {
  it.each(["mu", "norm", "flat"])("uses saved form units for an unrenormalized difference in %s", energyMode => {
    const sample = group("Normalized derivative difference")
    sample.is_difference = true
    sample.source.y_label = "Δdμnorm/dE (eV⁻¹)"
    show({ groups: [sample], active: sample, energyMode })
    expect(handoff().layout.yaxis.title.text).toBe("Δdμnorm/dE (eV⁻¹)")
  })

  it("does not carry the saved difference units into renormalized groups or new derivative plots", () => {
    const sample = group("Renormalized difference")
    sample.is_difference = false
    sample.source = { operation: "difference", y_label: "Δdμnorm/dE (eV⁻¹)" }
    const rendered = show({ groups: [sample], energyMode: "norm" })
    expect(handoff().layout.yaxis.title.text).toBe("Normalized μ(E)")
    rendered.unmount()
    sample.is_difference = true
    show({ groups: [sample], energyMode: "dmude" })
    expect(handoff().layout.yaxis.title.text).toBe("d(difference)/dE (eV⁻¹)")
  })

  it.each([
    ["mu", "Difference signal"], ["norm", "Difference signal"], ["flat", "Difference signal"],
    ["dmude", "d(difference)/dE (eV⁻¹)"], ["d2mude", "d²(difference)/dE² (eV⁻²)"],
  ])("identifies a copied difference in %s without changing signed values", (energyMode, title) => {
    const sample = group("Copied difference")
    sample.is_difference = true
    sample.source.operation = "copy_series"
    sample.result!.arrays[energyMode] = [-0.2, 0, 0.1]
    freeze(sample)
    show({ groups: [sample], energyMode, active: group("Unplotted absorption") })
    expect(handoff().layout.yaxis.title.text).toBe(title)
    expect(handoff().data[0].y).toEqual([-0.2, 0, 0.1])
    expect(handoff().data[0].name).toBe("Copied difference")
  })

  it("names both signal forms when absorption and difference traces share the plot", () => {
    const diff = group("Difference")
    diff.is_difference = true
    diff.result!.arrays.norm = [-0.2, 0, 0.1]
    show({ groups: [group("Absorption"), diff], energyMode: "norm" })
    expect(handoff().layout.yaxis.title.text).toBe("Signal (forms in legend)")
    expect(handoff().data.map(trace => trace.name)).toEqual([
      "Absorption (Normalized μ(E))", "Difference (Difference signal)",
    ])
    expect(handoff().data[1].y).toEqual([-0.2, 0, 0.1])
  })

  it.each([undefined, false])("uses legacy provenance only when the saved flag is absent (%s)", flag => {
    const sample = group()
    sample.source.operation = "difference"
    sample.is_difference = flag
    show({ groups: [sample], energyMode: "norm" })
    expect(handoff().layout.yaxis.title.text).toBe(flag === false ? "Normalized μ(E)" : "Difference signal")
  })

  it("keeps a chi difference's Fourier-space labels and signed products", () => {
    const sample = group("Chi difference")
    sample.is_difference = true
    sample.data_type = "chi"
    show({ groups: [sample], space: "R", component: "re" })
    expect(handoff().layout.yaxis.title.text).toBe("Re[χ(R)]")
    expect(handoff().data[0].y).toEqual([3, 0, -3])
  })
})

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

describe("AthenaPlot range overrides", () => {
  it.each([
    { range: [null, null], axis: { autorange: true } },
    { range: [8960, null], axis: { range: [8960, null], autorange: "max" } },
    { range: [null, 9000], axis: { range: [null, 9000], autorange: "min" } },
    { range: [8960, 9000], axis: { range: [8960, 9000] } },
  ] as const)("supports automatic and one-sided bounds: $range", ({ range, axis }) => {
    show({ range: [...range] })
    expect(handoff().layout.xaxis).toMatchObject(axis)
  })

  it("resets Plotly zoom for a new plot scope or individual spectrum while retaining comparison zoom on highlight changes", () => {
    const first = group("First"), second = group("Second")
    const comparison = show({ groups: [first, second], active: first })
    const comparisonRevision = handoff().layout.uirevision
    comparison.unmount()
    const highlight = show({ groups: [first, second], active: second })
    expect(handoff().layout.uirevision).toBe(comparisonRevision)
    highlight.unmount()
    const individual = show({ groups: [first], active: first, plotScope: "current" })
    const individualRevision = handoff().layout.uirevision
    expect(individualRevision).not.toBe(comparisonRevision)
    individual.unmount()
    show({ groups: [second], active: second, plotScope: "current" })
    expect(handoff().layout.uirevision).not.toBe(individualRevision)
  })

  it("explains an empty selection when a highlighted spectrum is available", () => {
    show({ groups: [], active: group(), plotScope: "selected" })
    expect(screen.getByRole("heading", { name: "No spectra selected" })).toBeInTheDocument()
    expect(screen.getByText("Check data groups or choose Current spectrum to plot the highlighted group.")).toBeInTheDocument()
    expect(plotly).not.toHaveBeenCalled()
  })
})

describe("AthenaPlot backgrounds and displayed groups", () => {
  it("gives only the active background the same multiplier, group offset, and stack offset as the signal", () => {
    const sample = group("Scaled")
    sample.multiplier = 2
    sample.offset = 3
    const before = structuredClone(sample)
    freeze(sample)
    show({ groups: [group("First"), sample], active: sample, background: true, offset: 10 })
    const { data } = handoff()
    expect(data.map(trace => trace.name)).toEqual([
      "First", "Scaled", "Background μ₀(E) · Scaled",
    ])
    expect(data[1].y).toEqual([15, 17, 19])
    expect(data[2].y).toEqual([14, 15, 16])
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

describe("AthenaPlot individual pre-edge and post-edge lines", () => {
  it.each([
    { preEdge: false, postEdge: false, names: [] },
    { preEdge: true, postEdge: false, names: ["Pre-edge line · Sample"] },
    { preEdge: false, postEdge: true, names: ["Post-edge line · Sample"] },
    { preEdge: true, postEdge: true, names: ["Pre-edge line · Sample", "Post-edge line · Sample"] },
  ])("independently toggles each line with background disabled: $preEdge/$postEdge", ({ preEdge, postEdge, names }) => {
    show({ plotScope: "current", preEdge, postEdge })
    expect(handoff().data.map(trace => trace.name)).toEqual(["Sample", ...names])
    handoff().data.slice(1).forEach(trace => expect(trace.line?.dash).toBe("dash"))
  })

  it("keeps the background independent of both line selections", () => {
    const rendered = show({ plotScope: "current", background: true })
    expect(handoff().data.map(trace => trace.name)).toEqual(["Sample", "Background μ₀(E) · Sample"])
    rendered.unmount()
    show({ plotScope: "current", background: true, preEdge: true, postEdge: true })
    expect(handoff().data.map(trace => trace.name)).toEqual([
      "Sample", "Background μ₀(E) · Sample", "Pre-edge line · Sample", "Post-edge line · Sample",
    ])
  })

  it("uses the displayed result's shifted energy and display scaling without changing source arrays", () => {
    const sample = group("Scaled")
    sample.multiplier = 2
    sample.offset = 3
    const staleActive = group("Scaled")
    staleActive.offset = 100
    const before = structuredClone(sample)
    freeze(sample)
    show({ groups: [group("First"), sample], active: staleActive, plotScope: "current", preEdge: true, postEdge: true, offset: 10 })
    const { data } = handoff()
    expect(data.map(trace => trace.name)).toEqual(["First", "Scaled", "Pre-edge line · Scaled", "Post-edge line · Scaled"])
    expect(data[1].y).toEqual([15, 17, 19])
    expect(data[2].y).toEqual([13.2, 13.4, 13.6])
    expect(data[3].y).toEqual([17, 19, 21])
    data.slice(1).forEach(trace => {
      expect(trace.x).toEqual([8960, 8980, 9000])
      expect(trace.x).not.toBe(sample.result!.arrays.energy)
    })
    expect(data[2].y).not.toBe(sample.result!.arrays.pre_edge)
    expect(data[3].y).not.toBe(sample.result!.arrays.post_edge)
    expect(sample).toEqual(before)
  })

  it("marks effective automatic bounds and clipped endpoints on already shifted energies", () => {
    const sample = group()
    // Outer requested bounds exceed measured support; the fit returned clipped bounds.
    sample.parameters = { ...sample.parameters, e0: null, pre2: null, norm1: null }
    sample.result!.effective = { e0: 8980, pre1: -20, pre2: -10, norm1: 10, norm2: 20 }
    show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    const markers = handoff().data.filter(trace => trace.mode === "markers")
    expect(markers).toHaveLength(2)
    expect(markers[0]).toMatchObject({
      name: "Pre-edge bounds · Sample", x: [8960, 8970], y: [1, 1.5], customdata: [-20, -10],
      text: ["Pre-edge start", "Pre-edge end"], marker: { symbol: ["circle", "diamond"] }, showlegend: false,
    })
    expect(markers[1]).toMatchObject({
      name: "Post-edge bounds · Sample", x: [8990, 9000], y: [2.5, 3], customdata: [10, 20],
      text: ["Post-edge start", "Post-edge end"], marker: { symbol: ["circle", "diamond"] }, showlegend: false,
    })
    // The saved +4 eV shift is already in both the fitted E0 and plotted energy array.
    expect(handoff().data[0].x).toEqual([8960, 8980, 9000])
  })

  it("interpolates bounds on current raw mu and applies multiplier, group offset, and stack offset once", () => {
    const sample = group("Scaled")
    sample.multiplier = 2
    sample.offset = 3
    sample.result!.arrays.mu = [2, 6, 14]
    sample.result!.effective = { e0: 8980, pre1: -15, pre2: -5, norm1: 5, norm2: 15 }
    const staleActive = group("Scaled")
    staleActive.offset = 100
    staleActive.result!.effective = { e0: 8970, pre1: -10, pre2: 0, norm1: 10, norm2: 20 }
    const before = structuredClone(sample)
    freeze(sample)
    show({ groups: [group("First"), sample], active: staleActive, plotScope: "current", preEdge: true, postEdge: true, offset: 10 })
    const markers = handoff().data.filter(trace => trace.mode === "markers")
    expect(markers.map(trace => ({ x: trace.x, y: trace.y }))).toEqual([
      { x: [8965, 8975], y: [19, 23] },
      { x: [8985, 8995], y: [29, 37] },
    ])
    expect(sample).toEqual(before)
  })

  it("omits unsupported bounds, missing metadata, and nonfinite signal values without extrapolating", () => {
    const sample = group()
    sample.result!.effective = { e0: 8980, pre1: -21, pre2: -10, norm1: Infinity, norm2: 21 }
    const rendered = show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data.filter(trace => trace.mode === "markers")).toMatchObject([
      { name: "Pre-edge bounds · Sample", x: [8970], y: [1.5], text: ["Pre-edge end"], customdata: [-10] },
    ])
    rendered.unmount()

    sample.parameters = { ...sample.parameters, e0: 8980, pre1: -20, pre2: -10, norm1: 10, norm2: 20 }
    const unfittedMetadata: Array<Record<string, number | null>> = [
      { e0: null },
      { e0: 8980, pre1: null, pre2: null, norm1: null, norm2: null },
    ]
    for (const effective of unfittedMetadata) {
      sample.result!.effective = effective
      const unfitted = show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
      expect(handoff().data.filter(trace => trace.mode === "markers")).toHaveLength(0)
      unfitted.unmount()
    }

    sample.result!.effective = {}
    sample.parameters = { ...sample.parameters, e0: null, pre1: null, pre2: null, norm1: null, norm2: null }
    const missing = show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data.map(trace => trace.name)).toEqual(["Sample", "Pre-edge line · Sample", "Post-edge line · Sample"])
    missing.unmount()

    sample.result!.effective = { e0: 8980, pre1: -20, pre2: -10, norm1: 10, norm2: 20 }
    sample.result!.arrays.mu = [NaN, 2, Infinity]
    show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data.filter(trace => trace.mode === "markers")).toHaveLength(0)
  })

  it.each<Partial<ComponentProps<typeof AthenaPlot>>>([
    { plotScope: undefined }, { plotScope: "selected" },
    ...["k", "R", "q"].map(space => ({ space: space as Space })),
    ...["norm", "flat", "dmude", "d2mude"].map(energyMode => ({ energyMode })),
  ])("hides selected lines outside individual raw-mu energy plots: %j", props => {
    show({ plotScope: "current", preEdge: true, postEdge: true, ...props })
    expect(handoff().data).toHaveLength(1)
  })

  it.each<AthenaGroup["data_type"]>(["detector", "chi"])("does not show normalization lines for %s data even with stale arrays", data_type => {
    const sample = group()
    sample.data_type = data_type
    show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data).toHaveLength(1)
  })

  it.each([true, undefined])("does not show normalization lines for a difference group (flag %s)", flag => {
    const sample = group()
    sample.is_difference = flag
    sample.source.operation = "difference"
    show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data).toHaveLength(1)
  })

  it("requires a displayed active signal and processed results", () => {
    const sample = group()
    const unplotted = show({ groups: [sample], active: group("Unplotted"), plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data).toHaveLength(1)
    unplotted.unmount()
    sample.result = null
    show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data).toHaveLength(1)
  })

  it("skips unavailable or mismatched fit arrays independently", () => {
    const sample = group()
    sample.result!.arrays.pre_edge = [0.1]
    const rendered = show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data.map(trace => trace.name)).toEqual(["Sample", "Post-edge line · Sample"])
    rendered.unmount()
    delete sample.result!.arrays.post_edge
    show({ groups: [sample], active: sample, plotScope: "current", preEdge: true, postEdge: true })
    expect(handoff().data).toHaveLength(1)
  })
})

describe("AthenaPlot weight labels and complex components", () => {
  it.each([0, 1, 3, 4])("uses raw chi for viewer k-weight %s without changing saved arrays", kWeight => {
    const sample = group("Saved at 2", 2)
    sample.multiplier = 2
    sample.offset = 1
    const before = structuredClone(sample)
    freeze(sample)
    show({ groups: [sample], space: "k", kWeight })
    expect(handoff().data[0].y).toEqual(sample.result!.arrays.chi.map((chi, index) => 2 * chi * sample.result!.arrays.k[index] ** kWeight + 1))
    expect(handoff().layout.yaxis.title.text).toBe(kWeight === 0 ? "χ(k)" : `k<sup>${kWeight}</sup> χ(k)`)
    expect(sample).toEqual(before)
  })

  it("restores saved weighting on Auto and keeps unavailable chi from showing the wrong weight", () => {
    const sample = group()
    const view = show({ groups: [sample], space: "k", kWeight: 3 })
    view.rerender(<AthenaPlot groups={[sample]} space="k" energyMode="mu" component="mag" background={false} window={false} offset={0} analysis={null} analysisVisible={false} range={[null, null]} kWeight={null} />)
    expect(handoff().data[0].y).toEqual(sample.result!.arrays.weighted_chi)
    delete sample.result!.arrays.chi
    view.rerender(<AthenaPlot groups={[sample]} space="k" energyMode="mu" component="mag" background={false} window={false} offset={0} analysis={null} analysisVisible={false} range={[null, null]} kWeight={3} />)
    expect(screen.getByText("No data in this plot space")).toBeVisible()
  })

  it("weights unprocessed chi once and leaves R products untouched by the display prop", () => {
    const raw = { ...group(), data_type: "chi" as const, result: null, energy: [0, 1, 2], mu: [0.1, 0.2, -0.3] }
    const view = show({ groups: [raw], space: "k", kWeight: 3 })
    expect(handoff().data[0].y).toEqual([0, 0.2, -2.4])
    expect(handoff().data[0].name).toContain("unprocessed χ(k)")
    const sample = group()
    view.rerender(<AthenaPlot groups={[sample]} space="R" energyMode="mu" component="mag" background={false} window={false} offset={0} analysis={null} analysisVisible={false} range={[null, null]} kWeight={3} />)
    expect(handoff().data[0].y).toEqual(sample.result!.arrays.chir_mag)
  })

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
      expect(handoff().layout.xaxis.title.text).toBe(space === "R" ? "R (Å)" : component === "re" ? "k, q (Å⁻¹)" : "q (Å⁻¹)")
      if (component === "pha") expect(handoff().layout.yaxis.title.text).toContain("(rad)")
    }
    expect(sample).toEqual(before)
  })
})

describe("AthenaPlot k and q comparison", () => {
  it("overlays unwindowed weighted k and real q on their full native grids with identical scaling", () => {
    const first = group("First", 1.75), second = group("Second", 3)
    first.multiplier = 2
    first.offset = 1
    second.multiplier = 0.5
    second.offset = -2
    // Saved weighted arrays describe the transform, even if the recipe changed.
    first.parameters.kweight = 4
    const groups = freeze([first, second])
    show({ groups, active: first, space: "q", component: "re", offset: 5, showDataPoints: true })
    const traces = handoff().data
    expect(traces).toHaveLength(4)
    for (const [index, sample] of groups.entries()) {
      const [q, k] = traces.slice(index * 2, index * 2 + 2)
      const a = sample.result!.arrays
      const scale = (values: number[]) => values.map(v => v * sample.multiplier + sample.offset + index * 5)
      expect(q.x).toEqual(a.q)
      expect(q.y).toEqual(scale(a.chiq_re))
      expect(q.name).toContain("Re[χ(q)]")
      expect(q.line?.dash).toBe("solid")
      expect(q.mode).toBe("lines")
      expect(k.x).toEqual(a.k)
      expect(k.y).toEqual(scale(a.weighted_chi))
      expect(k.name).toContain("χ(k)")
      expect(k.name).toContain(`k-weight ${sample.result!.effective.kweight}`)
      expect(k.line).toMatchObject({ color: q.line?.color, dash: "dash" })
      expect(k.mode).toBe("lines+markers")
      expect(k.yaxis).toBeUndefined()
    }
    expect(handoff().layout.xaxis.title.text).toBe("k, q (Å⁻¹)")
    expect(handoff().layout.yaxis.title.text).toContain("weights in legend")
    expect(automaticPlotRange(groups, "q", "mu", "re")).toEqual([0, 4])
    expect(automaticPlotRange(groups, "q", "mu", "im")).toEqual([1, 3])
  })

  it("uses the k-weight of the returned q transform once for both curves", () => {
    const sample = group("Weight override", 4)
    sample.parameters.kweight = 2
    show({ groups: [sample], active: sample, space: "q", component: "re", kWeight: 4 })
    expect(handoff().data[0].y).toEqual(sample.result!.arrays.chiq_re)
    expect(handoff().data[1].y).toEqual(sample.result!.arrays.chi.map((v, i) => v * sample.result!.arrays.k[i] ** 4))
    expect(handoff().layout.yaxis.title.text).toBe("k<sup>4</sup> χ(k), Re[χ(q)]")
  })

  it("keeps the q curve usable without inventing missing k data", () => {
    const sample = group()
    delete sample.result!.arrays.weighted_chi
    show({ groups: [sample], active: sample, space: "q", component: "re" })
    expect(handoff().data).toHaveLength(1)
    expect(handoff().data[0].y).toEqual(sample.result!.arrays.chiq_re)
    expect(automaticPlotRange([sample], "q", "mu", "re")).toEqual([1, 3])
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

describe('Detector signal plots', () => {
  it('labels detector counts distinctly from absorption and applies presentation scaling only', () => {
    const detector = group('I0'); detector.data_type = 'detector'; detector.multiplier = 2; detector.offset = 3
    freeze(detector)
    show({ groups: [detector, group('Absorption')], active: detector, offset: 0 })
    const props = handoff()
    expect(props.layout.yaxis.title.text).toBe('Signal (forms in legend)')
    expect(props.data[0].name).toBe('I0 (Detector signal)')
    expect(props.data[0].y).toEqual([5, 7, 9])
    expect(props.data[1].name).toBe('Absorption (μ(E))')
  })
  it.each(['norm','flat','dmude','d2mude','k','R','q'])('does not render a detector as %s even if stale arrays are present', mode => {
    const detector = group('I0'); detector.data_type = 'detector'
    const space = ['k','R','q'].includes(mode) ? mode as Space : 'E'
    show({ groups: [detector], active: detector, space, energyMode: space === 'E' ? mode : 'mu' })
    expect(plotly).not.toHaveBeenCalled()
    expect(screen.getByText('No data in this plot space')).toBeVisible()
  })
})
