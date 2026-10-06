"use client"

import { ThemedPlot as Plot } from "./themed-plot"

/** One fitted quantity across a series: a value and its nominal error per scan. */
export interface TrendTrace { name: string; y: (number | null)[]; error: (number | null)[] }
export interface TrendPanel { title: string; unit?: string; traces: TrendTrace[] }

const COLORS = ["#16736b", "#c37b38", "#7470b0", "#b5466b", "#5a7d2a", "#3b6fa8", "#8a6a3f", "#6a6a6a"]

type Parameter = { value: number; stderr: number | null }
type LcfRow = { label?: string; weights?: number[]; weight_stderr?: (number | null)[]; rfactor?: number; error?: string }

/** Weights of each standard, and the R-factor, against position in the series. */
export function lcfSeriesTrend(result: Record<string, unknown>): { labels: string[]; panels: TrendPanel[] } {
  const rows = (result.targets ?? []) as LcfRow[]
  const standards = (result.labels ?? []) as string[]
  return {
    labels: rows.map((row, i) => row.label ?? `Scan ${i + 1}`),
    panels: [
      { title: "Weight", traces: standards.map((name, s) => ({ name,
        y: rows.map(row => row.error ? null : row.weights?.[s] ?? null),
        error: rows.map(row => row.error ? null : row.weight_stderr?.[s] ?? null) })) },
      { title: "R-factor", traces: [{ name: "R-factor", y: rows.map(row => row.error ? null : row.rfactor ?? null), error: rows.map(() => null) }] },
    ],
  }
}

/** Peak areas, and any centre or width that was not shared, against position in the series. */
export function peakSeriesTrend(result: Record<string, unknown>, unit = "eV"): { labels: string[]; panels: TrendPanel[] } {
  const spectra = (result.spectra ?? []) as { parameters?: Record<string, Parameter> }[]
  const independent = (result.independent ?? []) as { parameters?: Record<string, Parameter>; error?: string }[]
  const details = (result.details ?? {}) as { peak_kinds?: string[]; shared_across_series?: string[] }
  const kinds = details.peak_kinds ?? []
  const shared = details.shared_across_series ?? []
  const labels = ((result.labels ?? []) as string[]).slice(0, spectra.length)
  const trace = (index: number, key: string) => ({
    name: kinds.length === 1 ? "Peak 1" : `Peak ${index}`,
    y: spectra.map(spectrum => spectrum.parameters?.[`peak_${index}_${key}`]?.value ?? null),
    error: spectra.map(spectrum => spectrum.parameters?.[`peak_${index}_${key}`]?.stderr ?? null) })
  const peaks = kinds.map((_, i) => i + 1)
  // A shared quantity is one number, so it is drawn as a flat line beside what
  // each spectrum gives when fitted alone: the picture that says whether
  // sharing it was justified.
  const checked = (key: string, title: string) => independent.length === spectra.length ? [{
    title: `${title}: each spectrum alone vs shared`, unit,
    traces: peaks.flatMap(index => {
      const name = kinds.length === 1 ? "" : `Peak ${index} · `
      return [{ name: `${name}fitted alone`,
        y: independent.map(row => row.parameters?.[`peak_${index}_${key}`]?.value ?? null),
        error: independent.map(row => row.parameters?.[`peak_${index}_${key}`]?.stderr ?? null) },
      { name: `${name}shared`, y: spectra.map(spectrum => spectrum.parameters?.[`peak_${index}_${key}`]?.value ?? null), error: spectra.map(() => null) }]
    }) }] : []
  return {
    labels: spectra.map((_, i) => labels[i] ?? `Spectrum ${i + 1}`),
    panels: [
      { title: "Area", unit: `signal × ${unit}`, traces: peaks.map(index => trace(index, "amplitude")) },
      ...(shared.includes("center") ? checked("center", "Centre") : [{ title: "Centre", unit, traces: peaks.map(index => trace(index, "center")) }]),
      ...(shared.includes("sigma") ? checked("fwhm", "FWHM") : [{ title: "FWHM", unit, traces: peaks.map(index => trace(index, "fwhm")) }]),
    ],
  }
}

/** Fitted quantities against position in the series, with their nominal error bars.
 *
 * The scans are placed in the order they were fitted -- the order of the list
 * the user ticked -- and labelled by name; scan number is a position, not a
 * temperature or time, unless the user's naming makes it one.
 */
export function SeriesTrend({ labels, panels, title }: { labels: string[]; panels: TrendPanel[]; title: string }) {
  const x = labels.map((_, i) => i + 1)
  return <section className="ath-series-trend" aria-label={title}>
    {panels.map(panel => <div key={panel.title} className="ath-series-trend-panel">
      <Plot data={panel.traces.map((trace, i) => ({
        type: "scatter", mode: "lines+markers", name: trace.name, x, y: trace.y.map(value => value ?? NaN),
        text: labels, marker: { color: COLORS[i % COLORS.length], size: 7 }, line: { color: COLORS[i % COLORS.length], width: 1.5 },
        error_y: { type: "data", array: trace.error.map(value => value ?? 0), visible: trace.error.some(value => value !== null), thickness: 1.2, width: 3 },
        hovertemplate: `%{text}<br>${trace.name} = %{y:.5g}<extra></extra>`,
      }))} layout={{
        autosize: true, height: 220, margin: { l: 64, r: 16, t: 26, b: 70 }, showlegend: panel.traces.length > 1,
        legend: { orientation: "h", x: 0, y: 1.18 },
        title: { text: panel.title + (panel.unit ? ` (${panel.unit})` : ""), x: 0, xanchor: "left", font: { size: 13 } },
        xaxis: { tickmode: "array", tickvals: x, ticktext: labels, tickangle: labels.length > 6 ? -40 : 0, automargin: true },
        yaxis: { automargin: true, zeroline: false },
      }} config={{ responsive: true, displaylogo: false }} useResizeHandler style={{ width: "100%" }} />
    </div>)}
    <p className="ath-hint">Error bars are the nominal standard errors of each fit: lower bounds that assume the model and independent residuals. Scans are in the order fitted.</p>
  </section>
}
