"use client"

import dynamic from "next/dynamic"
import type { AthenaGroup, Analysis } from "@/lib/athena"

const Plot = dynamic(() => import("react-plotly.js").then(m => m.default), { ssr: false, loading: () => <div className="ath-plot-loading">Loading plot…</div> })
const colors = ["#16736b", "#c37b38", "#7470b0", "#c85a65", "#467cac", "#8e9c47", "#967055"]
export type Space = "E" | "k" | "R" | "q"
interface Props {
  groups: AthenaGroup[]; active?: AthenaGroup; space: Space; energyMode: string
  background: boolean; window: boolean; component: string; offset: number
  analysis: Analysis | null; analysisVisible: boolean; range: [number | null, number | null]
}

// Window values are dimensionless. Interpolate only within the paired k/kwin
// support: q and k need not have identical spacing or endpoints.
function windowOnGrid(k: number[], window: number[], q: number[]) {
  const count = Math.min(k.length, window.length)
  if (count < 2) return { x: [], y: [] }
  const x = q.filter(value => value >= k[0] && value <= k[count - 1])
  let left = 0
  const y = x.map(value => {
    while (left < count - 2 && k[left + 1] < value) left++
    const fraction = (value - k[left]) / (k[left + 1] - k[left])
    return window[left] * (1 - fraction) + window[left + 1] * fraction
  })
  return { x, y }
}

export function AthenaPlot({ groups, active, space, energyMode, background, window: showWindow, component, offset, analysis, analysisVisible, range }: Props) {
  const data: Record<string, unknown>[] = []
  const add = (x: number[], y: number[], name: string, color: string, dash = "solid") => {
    if (!Array.isArray(x) || !Array.isArray(y) || !x.length || x.length !== y.length) return
    const trace: Record<string, unknown> = { x: x.slice(), y: y.slice(), name, type: "scatter", mode: "lines", line: { color, width: 1.8, dash }, hovertemplate: "%{x:.3f}, %{y:.5f}<extra>%{fullData.name}</extra>" }
    data.push(trace)
    return trace
  }
  const xKey = { E: "energy", k: "k", R: "r", q: "q" }[space]
  const yKey = { E: energyMode, k: "weighted_chi", R: `chir_${component}`, q: `chiq_${component}` }[space]
  const displayed = groups.flatMap((g, index) => {
    const rawChi = !g.result && g.data_type === "chi"
    const arrays: Record<string, number[]> = g.result?.arrays ?? (rawChi
      ? { k: g.energy, chi: g.mu }
      : { energy: g.energy.map(e => e + g.parameters.energy_shift), mu: g.mu })
    const x = arrays[xKey], y = arrays[rawChi && space === "k" ? "chi" : yKey]
    if (!x?.length || !y?.length || x.length !== y.length) return []
    const effectiveWeight = g.result?.effective.kweight
    const weight = rawChi ? 0 : typeof effectiveWeight === "number" ? effectiveWeight : g.parameters.kweight
    const transform = (values: number[]) => values.map(v => v * g.multiplier + g.offset + index * offset)
    return [{ g, index, arrays, x, y, weight, rawChi, transform }]
  })
  const weights = [...new Set(displayed.map(trace => trace.weight))]
  const mixedWeights = space !== "E" && weights.length > 1
  for (const trace of displayed) {
    const { g, index, x, y, rawChi, weight, transform } = trace
    const name = g.label + (rawChi ? " (unprocessed χ(k))" : "") + (mixedWeights ? ` (k-weight ${weight})` : "")
    // R/q products already include the forward k-weight. Apply display
    // multiplier/offset only, never another k- or q-dependent weighting.
    add(x, transform(y), name, colors[index % colors.length])
  }
  const current = displayed.find(trace => trace.g.id === active?.id)
  const a = current?.arrays
  if (current && a && background && space === "E" && energyMode === "mu") {
    for (const [key, name, color] of [["pre_edge", "Pre-edge line", "#b29874"], ["post_edge", "Post-edge polynomial", "#8f87aa"], ["bkg", "Background μ₀(E)", "#ddaa58"]]) {
      if (a[key]?.length === a.energy.length) add(a.energy, current.transform(a[key]), `${name} · ${current.g.label}`, color, "dash")
    }
  }
  if (current && a && showWindow && space !== "E") {
    const key = space === "R" ? "rwin" : "kwin"
    const nativeX = a[space === "R" ? "r" : "k"] ?? []
    const window = a[key] ?? []
    const count = Math.min(nativeX.length, window.length)
    const values = space === "q" ? windowOnGrid(nativeX, window, a.q)
      : { x: nativeX.slice(0, count), y: window.slice(0, count) }
    if (values.x.length) add(values.x, values.y, `${space === "R" ? "R" : "Forward"} window · ${current.g.label}`, "#a8ad9d", "dot")
  }
  let xTitle = { E: "Energy (eV)", k: "k (Å⁻¹)", R: "R (Å)", q: "q (Å⁻¹)" }[space]
  const kTitle = mixedWeights ? "k-weighted χ(k) (weights in legend)" : weights[0] === 0 ? "χ(k)" : `k<sup>${weights[0] ?? 2}</sup> χ(k)`
  let yTitle = { E: ({ mu: "μ(E)", norm: "Normalized μ(E)", flat: "Flattened μ(E)", dmude: "dμ/dE (eV⁻¹)", d2mude: "d²μ/dE² (eV⁻²)" } as Record<string, string>)[energyMode], k: kTitle, R: component === "mag" ? "|χ(R)|" : component === "pha" ? "Phase χ(R) (rad)" : `${component === "re" ? "Re" : "Im"}[χ(R)]`, q: component === "mag" ? "|χ(q)|" : component === "pha" ? "Phase χ(q) (rad)" : `${component === "re" ? "Re" : "Im"}[χ(q)]` }[space]
  if (analysis && analysisVisible) {
    data.length = 0
    const result = analysis.result
    if (analysis.kind === "pca") {
      const variances = (result.explained_variance_ratio ?? []) as number[]
      data.push({ x: variances.map((_, i) => i + 1), y: variances.map(v => v * 100), type: "bar", marker: { color: "#16736b" }, name: "Explained variance" })
      xTitle = "Principal component"; yTitle = "Explained variance (%)"
    } else if (analysis.kind === "log_ratio") {
      add(result.k as number[], result.log_amplitude_ratio as number[], "ln(A target / A reference)", "#16736b")
      const phase = add(result.k as number[], result.phase_difference as number[], "Phase difference (rad)", "#c37b38")
      if (phase) phase.yaxis = "y2"
      xTitle = "k (Å⁻¹)"; yTitle = "Log amplitude ratio"
    } else {
      const x = (result.x ?? []) as number[]
      add(x, (result.observed ?? []) as number[], "Observed", "#16736b")
      add(x, (result.fit ?? []) as number[], "Fit", "#c37b38", "dash")
      add(x, (result.residual ?? []) as number[], "Residual", "#7470b0")
      xTitle = analysis.options.array === "chi" || analysis.options.array === "weighted_chi" ? "k (Å⁻¹)" : "Energy (eV)"
      yTitle = "Signal / fit"
    }
  }
  const hasData = data.some(d => (d.x as number[])?.length)
  if (!hasData) return <div className="ath-no-plot"><span>{space}</span><h3>{groups.length ? "No data in this plot space" : "Your spectra, in perspective."}</h3><p>{groups.length ? "Check the data type and processing parameters, or select another plot space." : "Import a spectrum or open the copper foil example to begin."}</p></div>
  return <div className="ath-plot" data-testid="athena-plot" aria-label={`${space}-space spectrum plot`}><Plot data={data} layout={{
    autosize: true, margin: { l: 72, r: 25, t: 24, b: 86 }, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
    font: { family: "Arial, sans-serif", color: "#586661", size: 12 },
    xaxis: { title: { text: xTitle, standoff: 16 }, gridcolor: "#edf0ed", zerolinecolor: "#d8ded8", showline: true, linecolor: "#bdc8c0", ticks: "outside", ...(range[0] !== null && range[1] !== null && !analysisVisible ? { range } : { autorange: true }) },
    yaxis: { title: { text: yTitle, standoff: 15 }, gridcolor: "#edf0ed", zerolinecolor: "#d8ded8", showline: true, linecolor: "#bdc8c0", ticks: "outside", automargin: true },
    ...(analysisVisible && analysis?.kind === "log_ratio" ? { yaxis2: { title: {text: "Phase difference (rad)"}, overlaying: "y", side: "right", showgrid: false, automargin: true } } : {}),
    legend: { orientation: "h", y: -0.22, x: 0 }, hovermode: "closest", uirevision: `${space}-${energyMode}-${component}-${analysisVisible}-${range.join()}`,
  }} config={{ displaylogo: false, responsive: true, toImageButtonOptions: { format: "svg", filename: "athena-spectrum" }, modeBarButtonsToRemove: ["lasso2d", "select2d"] }} useResizeHandler style={{ width: "100%", height: "100%" }} /></div>
}
