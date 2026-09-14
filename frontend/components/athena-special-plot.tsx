"use client"

import dynamic from "next/dynamic"
import { useEffect, useState } from "react"
import { athenaApi, isDifferenceGroup, type AthenaGroup } from "@/lib/athena"
import { AthenaPlot, type Space } from "./athena-plot"
import styles from "./athena-special-plot.module.css"

const Plot = dynamic(() => import("react-plotly.js").then(module => module.default), { ssr: false, loading: () => <p>Loading plot…</p> })
const colors = ["#16736b", "#c37b38", "#7470b0", "#c85a65", "#467cac", "#8e9c47"]

export type AthenaSpecialPlotKind = "i0sig" | "normderiv" | "k123" | "r123" | "quad" | "i0" | "e00" | "normscaled" | "biquad"
export const athenaSpecialPlotLabels: Record<AthenaSpecialPlotKind, string> = {
  i0sig: "Data + I₀ + signal", normderiv: "Normalized μ(E) + derivative", k123: "k-space · weights 1, 2, 3",
  r123: "R-space · weights 1, 2, 3", quad: "Quad plot", i0: "Marked I₀", e00: "Marked E − E₀",
  normscaled: "Marked normalized data × edge step", biquad: "Bi-quad plot · two marked groups",
}

type Props = {
  kind: AthenaSpecialPlotKind; groups: AthenaGroup[]; active?: AthenaGroup
  projectId?: string; version?: number; energyMode?: string; component?: string; offset?: number
}
type Trace = { x: number[]; y: number[]; name: string; line: { color: string; dash?: string; width: number }; type: "scatter"; mode: "lines" }
type R123Result = {
  version: number; group_id: string
  curves: { kweight: number; arrays: Record<string, number[]> }[]
  warnings: string[]
}

function numbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "number" && Number.isFinite(item))
}
function pair(x: unknown, y: unknown): x is number[] {
  return numbers(x) && numbers(y) && x.length === y.length
}
function effective(group: AthenaGroup, key: "e0" | "edge_step") {
  const value = group.result?.effective[key] ?? group.parameters[key === "edge_step" ? "step" : "e0"]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
function energyArrays(group: AthenaGroup) {
  return group.result?.arrays ?? { energy: group.energy.map(value => value + group.parameters.energy_shift), mu: group.mu }
}
const energyTitles: Record<string, string> = { mu: "μ(E)", norm: "Normalized μ(E)", flat: "Flattened μ(E)", dmude: "dμnorm/dE (eV⁻¹)", d2mude: "d²μnorm/dE² (eV⁻²)" }

export function AthenaSpecialPlot({ kind, groups, active, projectId, version, energyMode = "norm", component = "mag", offset = 0 }: Props) {
  const [remote, setRemote] = useState<{ key: string; result?: R123Result; error?: string } | null>(null)
  const requestKey = `${projectId}:${version}:${active?.id}:${kind}`
  useEffect(() => {
    if (kind !== "r123" || !active || !projectId || version === undefined) return
    const controller = new AbortController()
    void athenaApi<R123Result>(`/projects/${projectId}/context-plot`, { version, group_id: active.id, kind: "r123" }, "POST", controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        if (result.version !== version || result.group_id !== active.id || !Array.isArray(result.curves) || result.curves.length !== 3
          || [1, 2, 3].some(weight => result.curves.filter(plot => plot.kweight === weight).length !== 1)
          || result.curves.some(plot => !pair(plot.arrays?.r, plot.arrays?.chir_mag))) throw new Error("The R-space comparison does not match this spectrum. Reopen the plot to retry.")
        setRemote({ key: requestKey, result })
      }).catch(error => { if (!controller.signal.aborted) setRemote({ key: requestKey, error: error instanceof Error ? error.message : "Could not calculate the R-space comparison." }) })
    return () => controller.abort()
  }, [kind, active?.id, projectId, version, requestKey])

  const markedKind = ["i0", "e00", "normscaled", "biquad"].includes(kind)
  const selected = markedKind ? groups.filter(group => group.marked) : active ? [active] : []
  const messages: string[] = []
  const traces: Trace[] = []
  let xTitle = "Energy (eV)", yTitle = "μ(E)"
  let plotRange: number[] | undefined
  function add(x: number[], y: number[], name: string, index: number, dash?: string) {
    if (!pair(x, y)) return false
    traces.push({ x: x.slice(), y: y.slice(), name, type: "scatter", mode: "lines", line: { color: colors[index % colors.length], width: 1.8, dash } })
    return true
  }
  if (!selected.length) return <p role="status">{markedKind ? "Mark groups to use this plot shortcut." : "Select a current group to use this plot shortcut."}</p>
  if (kind === "biquad" && selected.length !== 2) return <p role="status">Mark exactly two groups for Athena’s bi-quad plot.</p>

  if (kind === "quad" || kind === "biquad") {
    if (selected.some(group => group.data_type === "chi" || group.data_type === "detector" || isDifferenceGroup(group))) return <p role="status">Quad plots require absorption spectra with energy data and EXAFS processing.</p>
    return <div className={styles.grid} aria-label={athenaSpecialPlotLabels[kind]}>
      {(["E", "k", "R", "q"] as Space[]).map(space => <section key={space} className={styles.panel} aria-label={`${space}-space panel`}>
        <h4>{space === "E" ? "Normalized μ(E)" : `${space}-space`}</h4>
        <AthenaPlot groups={selected} active={active} space={space} energyMode="norm" background={false} window={false}
          component={component} offset={offset} analysis={null} analysisVisible={false} range={[null, null]} />
      </section>)}
    </div>
  }

  if (kind === "k123") {
    const group = selected[0], arrays = group.result?.arrays ?? (group.data_type === "chi" ? { k: group.energy, chi: group.mu } : {})
    xTitle = "k (Å⁻¹)"; yTitle = "k-weighted χ(k) · weights in legend"
    if (!pair(arrays.k, arrays.chi)) messages.push(`${group.label}: processed χ(k) is unavailable. Process an EXAFS spectrum or select χ(k) data.`)
    else {
      const weighted = [1, 2, 3].map(weight => arrays.chi.map((value, index) => value * arrays.k[index] ** weight))
      // Data::plotk123 and process/larch/k123.tmpl use signed maxima,
      // replace saved display multipliers, and offset around weight two.
      const maxima = weighted.map(values => values.reduce((max, value) => Math.max(max, value), -Infinity))
      for (const [index, y] of weighted.entries()) {
        const scale = index === 1 ? 1 : maxima[index] === 0 ? null : Number((maxima[1] / maxima[index]).toFixed(3))
        if (scale === null || !Number.isFinite(scale)) { messages.push(`k-weight ${index + 1}: a zero maximum prevents Athena’s comparison scaling.`); continue }
        const shift = (1 - index) * 1.2 * maxima[1]
        add(arrays.k, y.map(value => value * scale + shift), `${group.label} · k-weight ${index + 1}${index === 1 ? " · unscaled" : ` · scaled by ${scale.toFixed(3)}`}`, index)
      }
    }
  } else if (kind === "r123") {
    const current = remote?.key === requestKey ? remote : null
    if (!projectId || version === undefined) return <p role="status">Open this plot from a saved project to calculate Fourier transforms at k-weights 1, 2, and 3.</p>
    if (current?.error) return <p role="alert">{current.error}</p>
    if (!current?.result) return <p role="status">Calculating Fourier transforms at k-weights 1, 2, and 3…</p>
    xTitle = "R (Å)"; yTitle = component === "mag" ? "|χ(R)| · k-weights in legend" : component === "pha" ? "Phase χ(R) (rad)" : `${component === "re" ? "Re" : "Im"}[χ(R)] · k-weights in legend`
    const maxima = [1, 2, 3].map(weight => current.result!.curves.find(curve => curve.kweight === weight)!.arrays.chir_mag.reduce((max, value) => Math.max(max, value), -Infinity))
    for (const plot of current.result.curves) {
      const y = plot.arrays[`chir_${component}`]
      const index = plot.kweight - 1
      const scale = index === 1 ? 1 : maxima[index] === 0 ? null : Number((maxima[1] / maxima[index]).toFixed(3))
      if (scale === null || !Number.isFinite(scale)) { messages.push(`k-weight ${plot.kweight}: a zero magnitude prevents Athena’s comparison scaling.`); continue }
      if (!numbers(y) || !add(plot.arrays.r, y.map(value => value * scale + (1 - index) * maxima[1]), `${selected[0].label} · k-weight ${plot.kweight}${index === 1 ? " · unscaled" : ` · scaled by ${scale.toFixed(3)}`}`, index)) messages.push(`k-weight ${plot.kweight}: the requested R-space component is unavailable.`)
    }
    messages.push(...(current.result.warnings ?? []))
  } else for (const [index, group] of selected.entries()) {
    if (group.data_type === "chi") { messages.push(`${group.label}: this shortcut requires energy data; the group contains χ(k).`); continue }
    const arrays = energyArrays(group), x = arrays.energy
    const display = (values: number[]) => values.map(value => value * group.multiplier + group.offset + index * offset)
    if (kind === "i0sig" || kind === "i0") {
      const raw = group.source.raw_arrays as Record<string, unknown> | undefined
      const rawX = group.energy.map(value => value + group.parameters.energy_shift)
      if (kind === "i0sig") {
        yTitle = "μ(E) and scaled detector signals"
        if (!pair(x, arrays.mu) || !add(x, display(arrays.mu), `${group.label} · ${group.data_type === "detector" ? "Detector signal" : "μ(E)"}`, 0)) messages.push(`${group.label}: μ(E) is unavailable.`)
      } else yTitle = "I₀ (source units)"
      for (const channel of kind === "i0sig" ? ["i0", "signal"] : ["i0"]) {
        const values = raw?.[channel]
        const label = channel === "i0" ? "I₀" : "Signal"
        if (!numbers(values) || !pair(rawX, values)) { messages.push(`${group.label}: no aligned ${label} channel was retained with this group. Reimport the original detector columns to show it.`); continue }
        const maximum = values.reduce((max, value) => Math.max(max, value), -Infinity)
        const scale = kind === "i0sig" ? Math.abs(group.mu.reduce((max, value) => Math.max(max, value), -Infinity)) / maximum : 1
        if (!Number.isFinite(scale)) { messages.push(`${group.label}: a zero ${label} maximum prevents Athena’s detector display scaling.`); continue }
        add(rawX, display(values.map(value => value * scale)), `${group.label} · ${label}${kind === "i0sig" ? ` · scaled by ${Number(scale.toPrecision(6))}` : ""}`, kind === "i0sig" ? channel === "i0" ? 1 : 2 : index)
      }
    } else if (kind === "normderiv") {
      if (isDifferenceGroup(group) || group.data_type === "detector") { messages.push(`${group.label}: normalization and derivative comparison requires an absorption spectrum.`); continue }
      yTitle = "Normalized μ(E) and scaled derivative"
      const e0 = effective(group, "e0")
      if (e0 !== null) plotRange = [e0 - 30, e0 + 70]
      if (!pair(x, arrays.norm) || !add(x, display(arrays.norm), `${group.label} · normalized μ(E)`, 0)) messages.push(`${group.label}: normalized μ(E) is unavailable.`)
      if (!pair(x, arrays.dmude)) messages.push(`${group.label}: the normalized derivative is unavailable. Process the energy spectrum first.`)
      else {
        const maximum = arrays.dmude.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
        // Data::plot_ed and plot.demeter_conf.in: default peak 0.5,
        // three-decimal display multiplier, and E0-relative -30…70 eV.
        const scale = maximum > 0 ? Number((0.5 / maximum).toFixed(3)) : null
        if (scale === null) messages.push(`${group.label}: a zero derivative prevents Athena’s comparison scaling.`)
        else add(x, arrays.dmude.map(value => value * scale + group.offset), `${group.label} · normalized derivative · scaled by ${scale.toFixed(3)}`, 1)
      }
    } else if (kind === "e00") {
      xTitle = "E − E₀ (eV)"; yTitle = energyTitles[energyMode] ?? "Signal"
      const e0 = effective(group, "e0"), y = arrays[energyMode]
      if (e0 === null) messages.push(`${group.label}: E₀ is unavailable. Determine the absorption edge first.`)
      else if (!pair(x, y) || !add(x.map(value => value - e0), display(y), group.label, index)) messages.push(`${group.label}: the selected energy signal is unavailable.`)
    } else if (kind === "normscaled") {
      yTitle = "Normalized μ(E) × edge step"
      const step = effective(group, "edge_step")
      if (step === null) messages.push(`${group.label}: the edge step is unavailable. Normalize an absorption spectrum first.`)
      else if (!pair(x, arrays.norm) || !add(x, arrays.norm.map(value => value * step + group.offset + index * offset), `${group.label} · edge step ${step}`, index)) messages.push(`${group.label}: normalized μ(E) is unavailable.`)
    }
  }
  return <section aria-label={athenaSpecialPlotLabels[kind]}>
    {traces.length > 0 && <div className={styles.plot}><Plot data={traces} layout={{ autosize: true,
      margin: { l: 75, r: 25, t: 20, b: 105 },
      xaxis: { title: { text: xTitle }, automargin: true, ...(plotRange ? { range: plotRange } : {}) }, yaxis: { title: { text: yTitle }, automargin: true },
      font: { family: "Arial, sans-serif", color: "#586661", size: 12 }, paper_bgcolor: "#fff", plot_bgcolor: "#fff",
      legend: { orientation: "h", y: -0.24 }, hovermode: "closest", uirevision: `${kind}:${selected.map(group => group.id).join()}:${version}:${energyMode}:${component}`,
    }} config={{ responsive: true, displaylogo: false, toImageButtonOptions: { format: "svg", filename: `athena-${kind}` }, modeBarButtonsToRemove: ["lasso2d", "select2d"] }} useResizeHandler style={{ width: "100%", height: "100%" }} /></div>}
    {kind === "i0sig" && traces.length > 0 && <p className={styles.note}>Athena scales retained I₀ and signal channels to the μ(E) maximum for comparison. Scale factors are shown in the legend.</p>}
    {kind === "normderiv" && traces.length > 0 && <p className={styles.note}>Athena scales the normalized derivative for comparison with normalized μ(E). Its scale factor is shown in the legend.</p>}
    {(kind === "k123" || kind === "r123") && traces.length > 0 && <p className={styles.note}>Athena’s comparison scales weights 1 and 3 to weight 2 and offsets the curves vertically. Scale factors are shown in the legend.</p>}
    {messages.length > 0 && <ul className={styles.notes}>{messages.map((message, index) => <li key={index}>{message}</li>)}</ul>}
  </section>
}
