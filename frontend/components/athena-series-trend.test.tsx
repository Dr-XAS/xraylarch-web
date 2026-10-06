import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { lcfSeriesTrend, peakSeriesTrend, SeriesTrend } from "./athena-series-trend"

type Trace = { name: string; y: number[]; error_y: { array: number[]; visible: boolean } }
const plot = vi.hoisted(() => vi.fn((_props: { data: Trace[] }) => <div data-testid="trend-plot" />))
vi.mock("next/dynamic", () => ({ default: () => plot }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const lcf = {
  labels: ["Cu foil", "Cu2O"],
  targets: [
    { label: "scan 3", weights: [0.8, 0.2], weight_stderr: [0.01, 0.01], rfactor: 1e-4 },
    { label: "scan 17", weights: [0.6, 0.4], weight_stderr: [0.02, 0.02], rfactor: 2e-4 },
    { label: "scan 31", error: "scan 31: The fit range must lie inside every spectrum's measured overlap" },
  ],
}

describe("series trends", () => {
  it("plots each standard's weight against the scan, leaving a gap where a scan could not be fitted", () => {
    // A failed scan drawn as zero would read as "this standard vanished".
    const trend = lcfSeriesTrend(lcf)
    expect(trend.labels).toEqual(["scan 3", "scan 17", "scan 31"])
    expect(trend.panels[0].traces.map(trace => [trace.name, trace.y])).toEqual([
      ["Cu foil", [0.8, 0.6, null]], ["Cu2O", [0.2, 0.4, null]]])
    render(<SeriesTrend title="Series LCF trend" {...trend} />)
    const weights = plot.mock.calls[0][0].data
    expect(Number.isNaN(weights[0].y[2])).toBe(true)
    expect(weights[0].error_y.array).toEqual([0.01, 0.02, 0])
    expect(screen.getByRole("region", { name: "Series LCF trend" })).toHaveTextContent(/lower bounds/)
  })

  it("trends a centre only when it was fitted per spectrum, not when the series shared it", () => {
    // A shared centre is one number; plotting it per scan would show a flat line
    // that looks like a finding.
    const spectrum = (area: number, centre: number) => ({ parameters: {
      peak_1_amplitude: { value: area, stderr: 0.01 }, peak_1_center: { value: centre, stderr: 0.05 },
      peak_1_fwhm: { value: 2.8, stderr: 0.1 } } })
    const result = { labels: ["RT", "500 C"], spectra: [spectrum(0.2, 6540.4), spectrum(0.3, 6540.9)],
      details: { peak_kinds: ["gaussian"], shared_across_series: ["sigma"] } }
    expect(peakSeriesTrend(result).panels.map(panel => panel.title)).toEqual(["Area", "Centre"])
    const both = { ...result, details: { ...result.details, shared_across_series: ["center", "sigma"] } }
    expect(peakSeriesTrend(both).panels.map(panel => panel.title)).toEqual(["Area"])
    expect(peakSeriesTrend(result).panels[1].traces[0].y).toEqual([6540.4, 6540.9])
  })

  it("sets a shared centre beside the one-at-a-time centres, so a shift the sharing hid is visible", () => {
    const spectrum = (centre: number) => ({ parameters: {
      peak_1_amplitude: { value: 0.2, stderr: 0.01 }, peak_1_center: { value: centre, stderr: 0.05 }, peak_1_fwhm: { value: 2.8, stderr: 0.1 } } })
    const result = { labels: ["RT", "500 C"], spectra: [spectrum(6540.84), spectrum(6540.84)],
      independent: [spectrum(6541.25), spectrum(6540.38)],
      details: { peak_kinds: ["gaussian"], shared_across_series: ["center"] } }
    const panel = peakSeriesTrend(result).panels.find(item => item.title.startsWith("Centre"))!
    expect(panel.title).toBe("Centre: each spectrum alone vs shared")
    expect(panel.traces.map(trace => [trace.name, trace.y])).toEqual([
      ["fitted alone", [6541.25, 6540.38]], ["shared", [6540.84, 6540.84]]])
  })
})
