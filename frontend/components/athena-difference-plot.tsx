"use client"

import dynamic from "next/dynamic"
import type { DifferencePreview } from "@/lib/athena"
import styles from "./athena-difference.module.css"

const Plot = dynamic(() => import("react-plotly.js").then(module => module.default), { ssr: false, loading: () => <p>Loading difference plot…</p> })
const colors = ["#16736b", "#c37b38", "#7470b0", "#c85a65", "#467cac", "#8e9c47"]
export type DifferenceView = "E" | "k" | "area"

export function AthenaDifferencePlot({ preview, view, labels, standardLabel, picking, onPick }: {
  preview: DifferencePreview; view: DifferenceView; labels: Record<string, string>; standardLabel: string
  picking: boolean; onPick: (x: number) => void
}) {
  const data: Record<string, unknown>[] = []
  const plottedWeights: (number | null)[] = []
  const plottedInputs = new Set<string>()
  function add(x: number[], y: number[], name: string, color: string, dash = "solid") {
    if (!x.length || x.length !== y.length) return false
    data.push({ x: x.slice(), y: y.slice(), name, type: "scatter", mode: "lines", line: { color, dash, width: 1.8 } })
    return true
  }
  const results = preview.results
  if (view === "area") {
    data.push({ x: results.map((_, index) => index + 1), y: results.map(result => result.area),
      text: results.map(result => labels[result.group_id] ?? result.label), type: "scatter", mode: "lines+markers",
      connectgaps: false, name: "Integrated area", line: { color: colors[0] }, hovertemplate: "%{text}: %{y:.6g}<extra></extra>" })
  } else for (const [index, result] of results.entries()) {
    const color = colors[index % colors.length]
    if (view === "k") {
      if (!result.k_error && add(result.k, result.weighted_chi, `${result.label} · derived difference · k-weight ${result.kweight ?? "unknown"}`, color)) plottedWeights.push(result.kweight)
      if (preview.options.plot_inputs) for (const input of result.input_k ?? []) {
        const key = `${input.role}:${input.group_id}`
        if (input.error || plottedInputs.has(key)) continue
        // Each original input has its own saved k grid and weighting. Neither
        // the difference multiplier nor inversion applies to these overlays.
        if (add(input.k, input.weighted_chi, `${input.label} · original ${input.role} · k-weight ${input.kweight ?? "unknown"}`, color, input.role === "DATA" ? "dot" : "dash")) {
          plottedInputs.add(key); plottedWeights.push(input.kweight)
        }
      }
    } else {
      add(result.energy, result.difference, result.label, color)
      if (preview.options.plot_inputs) {
        add(result.energy, result.data, `${labels[result.group_id] ?? result.group_id} · DATA (${result.data_form})`, color, "dot")
        // The backend already applied the standard multiplier.
        add(result.energy, result.standard, `${standardLabel} · scaled STANDARD (${result.standard_form}) for ${labels[result.group_id] ?? result.group_id}`, color, "dash")
      }
    }
  }
  const weights = [...new Set(plottedWeights)]
  const yTitle = view === "area" ? results[0]?.area_label : view === "k"
    ? weights.length === 1 && weights[0] !== null ? `k^${weights[0]} χ(k)` : "Weighted χ(k) · weights in legend"
    : results[0]?.y_label
  const canPick = picking && view === "E" && results.length === 1
  const bounds = view === "E" && results.length === 1 ? results[0].integration : null
  return <div className={styles.plot} aria-label={view === "area" ? "Difference area sequence" : `${view}-space difference preview`}>
    {!data.length ? <p>No k-space preview is available. The energy difference and integral remain available.</p> : <Plot data={data} onClick={event => {
      const x = event.points?.[0]?.x
      if (canPick && typeof x === "number" && Number.isFinite(x)) onPick(x)
    }} layout={{ autosize: true, margin: { l: 75, r: 25, t: 20, b: view === "area" ? 120 : 100 },
      xaxis: { title: { text: view === "area" ? "DATA group (list order)" : view === "k" ? "k (Å⁻¹)" : "Energy (eV)" },
        ...(view === "area" ? { tickmode: "array", tickvals: results.map((_, index) => index + 1), ticktext: results.map(result => labels[result.group_id] ?? result.label), automargin: true } : {}) },
      yaxis: { title: { text: yTitle }, automargin: true, zeroline: true }, hovermode: "closest",
      legend: { orientation: "h", y: -0.25 }, font: { size: 11 },
      shapes: bounds ? [bounds.lower, bounds.upper].map(x => ({ type: "line", x0: x, x1: x, y0: 0, y1: 1, yref: "paper", line: { color: "#8c938b", dash: "dot", width: 1 } })) : [],
      uirevision: `${preview.version}:${view}:${results.map(result => result.group_id).join()}:${JSON.stringify(preview.options)}`,
    }} config={{ responsive: true, displaylogo: false, toImageButtonOptions: { format: "svg", filename: "athena-difference" }, modeBarButtonsToRemove: ["lasso2d", "select2d"] }} useResizeHandler style={{ width: "100%", height: "100%" }} />}
  </div>
}
