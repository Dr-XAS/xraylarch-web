import "@testing-library/jest-dom/vitest"
import { useLayoutEffect, type ComponentProps } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type Plot from "react-plotly.js"
import { AthenaDifferencePlot } from "./athena-difference-plot"
import { differenceInputs, differencePreview, differenceProject } from "./athena-difference.fixtures"

type PlotlyProps = ComponentProps<typeof Plot>
const plotted = vi.hoisted(() => vi.fn<(props: PlotlyProps) => void>())
vi.mock("next/dynamic", () => ({ default: () => (props: PlotlyProps) => {
  useLayoutEffect(() => { plotted(props) })
  return <div />
} }))
beforeEach(() => plotted.mockClear())
afterEach(cleanup)
function handoff() { return plotted.mock.calls.at(-1)![0] }

describe("Athena Difference Plotly preview", () => {
  it("plots calibrated server arrays and scaled standard without rescaling or mutating the response", () => {
    const preview = differencePreview(undefined, undefined, { multiplier: 2 })
    const before = structuredClone(preview)
    render(<AthenaDifferencePlot preview={preview} view="E" labels={{ data: "DATA foil" }} standardLabel="Reference foil" picking={false} onPick={vi.fn()} />)
    const { data, layout } = handoff()
    expect(data.map(trace => [trace.x, trace.y])).toEqual([
      [preview.results[0].energy, preview.results[0].difference], [preview.results[0].energy, preview.results[0].data], [preview.results[0].energy, preview.results[0].standard],
    ])
    expect(data[2].name).toContain("scaled STANDARD")
    expect(layout?.shapes).toEqual([
      expect.objectContaining({ x0: 8959, x1: 8959 }), expect.objectContaining({ x0: 9009, x1: 9009 }),
    ])
    expect(layout?.yaxis).toEqual(expect.objectContaining({ title: { text: "Difference signal" } }))
    ;(data[0].x as number[]).push(10000)
    ;(data[2].y as number[])[0] = 999
    expect(preview).toEqual(before)
  })

  it("overlays every marked difference and plots signed areas with list-order DATA labels", () => {
    const preview = differencePreview(differenceProject(), ["other", "data"], { plot_inputs: false })
    const labels = { other: "Second, scan", data: "First scan" }
    const props = { preview, labels, standardLabel: "Standard", picking: false, onPick: vi.fn() }
    const { rerender } = render(<AthenaDifferencePlot {...props} view="E" />)
    expect(handoff().data.map(trace => trace.name)).toEqual(preview.results.map(result => result.label))
    expect(handoff().layout?.shapes).toEqual([])
    rerender(<AthenaDifferencePlot {...props} view="area" />)
    expect(handoff().data[0]).toEqual(expect.objectContaining({ x: [1, 2], y: [-0.25, 0.75], text: ["Second, scan", "First scan"], connectgaps: false }))
    expect(handoff().layout?.xaxis).toEqual(expect.objectContaining({ tickvals: [1, 2], ticktext: ["Second, scan", "First scan"] }))
  })

  it("uses server weighted χ arrays and weights, omitting failed k traces", () => {
    const preview = differencePreview(differenceProject(), ["data", "other"], { plot_space: "k" })
    preview.results[1].k_error = "No EXAFS"
    const props = { preview, labels: { data: "Data", other: "Other" }, standardLabel: "Standard", picking: false, onPick: vi.fn() }
    const { rerender } = render(<AthenaDifferencePlot {...props} view="k" />)
    expect(handoff().data).toHaveLength(1)
    expect(handoff().data[0]).toEqual(expect.objectContaining({ x: [1, 2, 3], y: [0.2, -0.4, 0.3] }))
    expect(handoff().layout?.yaxis).toEqual(expect.objectContaining({ title: { text: "k^2 χ(k)" } }))
    preview.results[1].k_error = null; preview.results[1].kweight = 3
    rerender(<AthenaDifferencePlot {...props} view="k" />)
    expect(handoff().data.map(trace => trace.name)).toEqual([expect.stringContaining("k-weight 2"), expect.stringContaining("k-weight 3")])
    expect(handoff().layout?.yaxis).toEqual(expect.objectContaining({ title: { text: "Weighted χ(k) · weights in legend" } }))
  })

  it("forwards only finite numeric coordinates while armed on a single E spectrum", () => {
    const onPick = vi.fn()
    const preview = differencePreview()
    const props = { preview, labels: { data: "Data" }, standardLabel: "Standard", picking: true, onPick }
    const { rerender } = render(<AthenaDifferencePlot {...props} view="E" />)
    for (const x of [undefined, "8980", Infinity, NaN]) handoff().onClick?.({ points: [{ x }] })
    handoff().onClick?.({ points: [{ x: 8980.25 }] })
    expect(onPick).toHaveBeenCalledExactlyOnceWith(8980.25)
    for (const view of ["k", "area"] as const) {
      rerender(<AthenaDifferencePlot {...props} preview={differencePreview(undefined, undefined, { plot_space: "k" })} view={view} />)
      handoff().onClick?.({ points: [{ x: 8980 }] })
    }
    rerender(<AthenaDifferencePlot {...props} picking={false} view="E" />)
    handoff().onClick?.({ points: [{ x: 8980 }] })
    rerender(<AthenaDifferencePlot {...props} preview={differencePreview(undefined, ["data", "other"])} view="E" />)
    handoff().onClick?.({ points: [{ x: 8980 }] })
    expect(onPick).toHaveBeenCalledOnce()
  })

  it("overlays original DATA and STANDARD on independent k grids without applying difference scaling or inversion", () => {
    const preview = differencePreview(undefined, undefined, { plot_space: "k", multiplier: 3, invert: true })
    preview.results[0].input_k = differenceInputs()
    const before = structuredClone(preview)
    const props = { preview, labels: { data: "DATA foil" }, standardLabel: "STANDARD foil", picking: false, onPick: vi.fn() }
    const { rerender } = render(<AthenaDifferencePlot {...props} view="k" />)
    expect(handoff().data.map(trace => [trace.x, trace.y])).toEqual([
      [[1, 2, 3], [0.2, -0.4, 0.3]], [[0.5, 1.5], [0.4, -0.8]], [[1, 2.5, 4], [2, -3, 4]],
    ])
    expect(handoff().data.map(trace => trace.name)).toEqual([
      expect.stringContaining("derived difference · k-weight 2"), "DATA foil · original DATA · k-weight 1", "STANDARD foil · original STANDARD · k-weight 3",
    ])
    expect(handoff().layout?.yaxis).toEqual(expect.objectContaining({ title: { text: "Weighted χ(k) · weights in legend" } }))
    ;(handoff().data[1].x as number[]).push(99)
    ;(handoff().data[2].y as number[])[0] = 100
    expect(preview).toEqual(before)
    rerender(<AthenaDifferencePlot {...props} preview={{ ...preview, options: { ...preview.options, plot_inputs: false } }} view="k" />)
    expect(handoff().data).toHaveLength(1)
    expect(handoff().layout?.yaxis).toEqual(expect.objectContaining({ title: { text: "k^2 χ(k)" } }))
  })

  it("computes the k-axis weight from successful nonempty input curves when the derived preview fails", () => {
    const preview = differencePreview(undefined, undefined, { plot_space: "k" })
    preview.results[0].k_error = "No difference background fit"
    preview.results[0].input_k = differenceInputs()
    preview.results[0].input_k[1].error = "No standard EXAFS"
    const props = { preview, labels: { data: "Data" }, standardLabel: "Standard", picking: false, onPick: vi.fn() }
    const { rerender } = render(<AthenaDifferencePlot {...props} view="k" />)
    expect(handoff().data).toHaveLength(1)
    expect(handoff().data[0].name).toBe("DATA foil · original DATA · k-weight 1")
    expect(handoff().layout?.yaxis).toEqual(expect.objectContaining({ title: { text: "k^1 χ(k)" } }))
    preview.results[0].input_k[0].kweight = null
    rerender(<AthenaDifferencePlot {...props} view="k" />)
    expect(handoff().layout?.yaxis).toEqual(expect.objectContaining({ title: { text: "Weighted χ(k) · weights in legend" } }))
    preview.results[0].input_k[0].k = []; preview.results[0].input_k[0].weighted_chi = []
    rerender(<AthenaDifferencePlot {...props} view="k" />)
    expect(screen.getByText(/No k-space preview is available/)).toBeVisible()
  })

  it("plots a shared original STANDARD once alongside every marked DATA and derived curve", () => {
    const preview = differencePreview(undefined, ["data", "other"], { plot_space: "k" })
    preview.results[0].input_k = differenceInputs()
    preview.results[1].input_k = differenceInputs("other", "Other scan")
    render(<AthenaDifferencePlot preview={preview} view="k" labels={{ data: "DATA foil", other: "Other scan" }} standardLabel="STANDARD foil" picking={false} onPick={vi.fn()} />)
    expect(handoff().data).toHaveLength(5)
    expect(handoff().data.filter(trace => String(trace.name).includes("original STANDARD"))).toHaveLength(1)
    expect(handoff().data.filter(trace => String(trace.name).includes("original DATA"))).toHaveLength(2)
  })
})
