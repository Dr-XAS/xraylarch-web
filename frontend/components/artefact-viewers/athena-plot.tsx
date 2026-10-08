"use client"

import { SectionHelp } from "../section-help"
import { ThemedPlot as Plot } from "../themed-plot"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from "react"
import { isDifferenceGroup, type AthenaGroup, type Analysis } from "@/lib/athena"
import { defaultPlotColors, spectrumColors, type PlotColorSettings } from "@/lib/athena-plot-colors"
import { AthenaContextMenu } from "../athena-context-menu"
import { DEFAULT_R_PLOT_RANGE, spectrumTraceCoordinates, type PlotSpace } from "./athena-plot-range"

export type Space = PlotSpace
interface Props {
  groups: AthenaGroup[]; active?: AthenaGroup; space: Space; energyMode: string
  background: boolean; window: boolean; component: string; offset: number
  plotScope?: "selected" | "current"; preEdge?: boolean; postEdge?: boolean; showLegend?: boolean; kWeight?: number | null
  showGrid?: boolean; showDataPoints?: boolean
  onShowGridChange?: (show: boolean) => void; onShowDataPointsChange?: (show: boolean) => void; onOptionsMenuOpen?: () => void
  colorSettings?: PlotColorSettings
  analysis: Analysis | null; analysisVisible: boolean; range: [number | null, number | null]
  // The series-LCF target whose fit is drawn: one observed curve, its fit and residual.
  seriesTarget?: string
  picking?: boolean; onPickX?: (x: number, space: Space) => void
}
type PlotOptionsEvent = MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>
type PlotOptionsMenu = { anchor: { x: number; y: number }; trigger: HTMLDivElement }

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

// Place bounds at their exact energies on the displayed signal, interpolating
// between measured samples without extrapolating beyond the spectrum.
function signalAtEnergy(energy: number[], mu: number[], target: number) {
  if (!Number.isFinite(target) || !energy.length || energy.length !== mu.length) return null
  const first = energy[0], last = energy[energy.length - 1]
  const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(target), Math.abs(first), Math.abs(last))
  if (target < first - tolerance || target > last + tolerance) return null
  const x = Math.max(first, Math.min(last, target))
  const right = energy.findIndex(value => value >= x)
  if (right < 0) return null
  if (energy[right] === x) return Number.isFinite(mu[right]) ? { x, y: mu[right] } : null
  if (right === 0 || !Number.isFinite(mu[right - 1]) || !Number.isFinite(mu[right])) return null
  const fraction = (x - energy[right - 1]) / (energy[right] - energy[right - 1])
  return { x, y: mu[right - 1] + fraction * (mu[right] - mu[right - 1]) }
}

function backgroundInSplineRange(group: AthenaGroup, energy: number[], background: number[]) {
  if (!Array.isArray(energy) || !Array.isArray(background) || !energy.length || background.length !== energy.length) return null
  const effective = group.result?.effective ?? {}
  const value = (key: "e0" | "bkg_kmin" | "bkg_kmax") => {
    const resolved = key in effective ? effective[key] : group.parameters[key]
    return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : null
  }
  const e0 = value("e0"), kmin = value("bkg_kmin"), kmax = value("bkg_kmax")
  if (e0 === null || kmin === null || kmin < 0 || (kmax !== null && kmax <= kmin)) return null
  // Older automatic results may omit the effective upper bound. An explicit
  // null means AUTOBK did not run, so it must not fall back to requested values.
  const automaticMax = !("bkg_kmax" in effective) && group.parameters.bkg_kmax === null
  if (kmax === null && !automaticMax) return null
  const ktoe = 3.8099821109685847
  const lower = Math.max(energy[0], e0 + kmin * kmin * ktoe)
  const upper = Math.min(energy[energy.length - 1], kmax === null ? energy[energy.length - 1] : e0 + kmax * kmax * ktoe)
  if (lower >= upper) return null
  const first = signalAtEnergy(energy, background, lower), last = signalAtEnergy(energy, background, upper)
  if (!first || !last) return null
  const start = energy.findIndex(point => point > lower)
  const end = energy.findIndex(point => point >= upper)
  return { x: [first.x, ...energy.slice(start, end), last.x], y: [first.y, ...background.slice(start, end), last.y] }
}

export function AthenaPlot({ groups, active, space, energyMode, background, window: showWindow, component, offset, plotScope = "selected", preEdge = false, postEdge = false, showLegend = true, showGrid = true, showDataPoints = false, onShowGridChange, onShowDataPointsChange, onOptionsMenuOpen, kWeight = null, colorSettings = defaultPlotColors, analysis, analysisVisible, range, picking = false, onPickX, seriesTarget }: Props) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotWidth, setPlotWidth] = useState(0)
  const [optionsMenu, setOptionsMenu] = useState<PlotOptionsMenu | null>(null)
  const activeId = active?.id
  const { palette, reversed, vmin, vmax } = colorSettings
  // Plotly uses data/layout identities to decide whether to redraw. Keep the
  // spectrum transforms stable during unrelated workbench and menu updates.
  const { data, xTitle, yTitle, e0 } = useMemo(() => {
    const compareK = space === "q" && component === "re"
    const data: Record<string, unknown>[] = []
    // Assign before filtering by plot space so a group keeps its color across E/k/R/q.
    const colors = spectrumColors(groups.length, { palette, reversed, vmin, vmax })
    const add = (x: number[], y: number[], name: string, color: string, dash = "solid", measured = false) => {
      if (!Array.isArray(x) || !Array.isArray(y) || !x.length || x.length !== y.length) return
      const points = measured && showDataPoints
      const trace: Record<string, unknown> = { x: x.slice(), y: y.slice(), name, type: "scatter", mode: points ? "lines+markers" : "lines", line: { color, width: 1.8, dash }, ...(points ? { marker: { color, size: 4 } } : {}), hovertemplate: "%{x:.3f}, %{y:.5f}<extra>%{fullData.name}</extra>" }
      data.push(trace)
      return trace
    }
    const displayed = groups.flatMap((g, index) => {
      const coordinates = spectrumTraceCoordinates(g, space, energyMode, component, kWeight)
      if (!coordinates) return []
      const { arrays, rawChi, x, y } = coordinates
      const effectiveWeight = g.result?.effective.kweight
      const weight = space === "k" && kWeight !== null ? kWeight : rawChi ? 0 : typeof effectiveWeight === "number" ? effectiveWeight : g.parameters.kweight
      const transform = (values: number[]) => values.map(v => v * g.multiplier + g.offset + index * offset)
      return [{ g, index, arrays, x, y, weight, rawChi, transform }]
    })
    const weights = [...new Set(displayed.map(trace => trace.weight))]
    const mixedWeights = space !== "E" && weights.length > 1
    const energyTitle = ({ mu: "μ(E)", norm: "Normalized μ(E)", flat: "Flattened μ(E)", dmude: "dμ/dE (eV⁻¹)", d2mude: "d²μ/dE² (eV⁻²)" } as Record<string, string>)[energyMode]
    const differenceTitle = energyMode === "dmude" ? "d(difference)/dE (eV⁻¹)" : energyMode === "d2mude" ? "d²(difference)/dE² (eV⁻²)" : "Difference signal"
    const energyForm = (group: AthenaGroup) => {
      if (group.data_type === 'detector') return 'Detector signal'
      if (!isDifferenceGroup(group)) return energyTitle
      const label = group.source.y_label
      return ["mu", "norm", "flat"].includes(energyMode) && typeof label === "string" && label.trim() ? label : differenceTitle
    }
    const energyForms = [...new Set(displayed.map(trace => energyForm(trace.g)))]
    const mixedEnergyForms = space === "E" && energyForms.length > 1
    for (const trace of displayed) {
      const { g, x, y, rawChi, weight, transform } = trace
      const name = g.label + (rawChi ? " (unprocessed χ(k))" : "") + (mixedWeights ? ` (k-weight ${weight})` : "") + (mixedEnergyForms ? ` (${energyForm(g)})` : "")
      // R/q products already include the forward k-weight. Apply display
      // multiplier/offset only, never another k- or q-dependent weighting.
      const color = colors[trace.index]
      add(x, transform(y), compareK ? `Re[χ(q)] · ${name}` : name, color, "solid", !compareK)
      if (compareK) {
        // Compare with the unwindowed input on its own full k grid, including
        // data beyond the FT cutoff. Both curves use the transform's k-weight
        // and identical display scaling; q is already weighted by the FFT.
        const kTrace = spectrumTraceCoordinates(g, "k", energyMode)
        if (kTrace) add(kTrace.x, transform(kTrace.y), `χ(k) · ${name}`, color, "dash", true)
      }
    }
    const current = displayed.find(trace => trace.g.id === activeId)
    const a = current?.arrays
    // E0 belongs to the displayed result and already uses the shifted energy axis.
    const effectiveE0 = current?.g.result?.effective.e0
    const e0 = current && plotScope === "current" && space === "E" && !analysisVisible
      && current.g.data_type !== "detector" && current.g.data_type !== "chi" && !isDifferenceGroup(current.g)
      && typeof effectiveE0 === "number" && Number.isFinite(effectiveE0)
      && effectiveE0 >= current.x[0] && effectiveE0 <= current.x[current.x.length - 1]
      ? effectiveE0 : null
    if (current && a && background && space === "E" && energyMode === "mu") {
      // Larch fills bkg outside its fitted support with mu. Show only the
      // selected spline interval, on the already shifted result energy axis.
      const fitted = a.bkg && backgroundInSplineRange(current.g, a.energy, a.bkg)
      if (fitted) add(fitted.x, current.transform(fitted.y), `Background μ₀(E) · ${current.g.label}`, "#ddaa58", "dash")
    }
    if (current && a && current.g.result && plotScope === "current" && space === "E" && energyMode === "mu"
      && current.g.data_type !== "detector" && current.g.data_type !== "chi" && !isDifferenceGroup(current.g)) {
      // Effective values describe the fitted arrays, including automatic values
      // and bounds clipped to measured support. Energy is already shifted.
      const effective = current.g.result.effective
      const value = (key: "e0" | "pre1" | "pre2" | "norm1" | "norm2") => {
        const resolved = key in effective ? effective[key] : current.g.parameters[key]
        return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : null
      }
      const e0 = value("e0")
      for (const [enabled, key, label, color, start, end] of [
        [preEdge, "pre_edge", "Pre-edge", "#b29874", "pre1", "pre2"],
        [postEdge, "post_edge", "Post-edge", "#8f87aa", "norm1", "norm2"],
      ] as const) {
        if (!enabled || a[key]?.length !== a.energy.length) continue
        const legendgroup = `${current.g.id}:${key}`
        const line = add(a.energy, current.transform(a[key]), `${label} line · ${current.g.label}`, color, "dash")
        if (line) line.legendgroup = legendgroup
        if (e0 === null) continue
        const points = ([start, end] as const).flatMap((bound, index) => {
          const relative = value(bound)
          if (relative === null) return []
          const point = signalAtEnergy(current.x, current.y, e0 + relative)
          return point ? [{ ...point, relative, label: `${label} ${index === 0 ? "start" : "end"}`, symbol: index === 0 ? "circle" : "diamond" }] : []
        })
        if (points.length) data.push({
          type: "scatter", mode: "markers", name: `${label} bounds · ${current.g.label}`, legendgroup, showlegend: false,
          x: points.map(point => point.x), y: current.transform(points.map(point => point.y)),
          text: points.map(point => point.label), customdata: points.map(point => point.relative),
          marker: { color, size: 11, symbol: points.map(point => point.symbol), line: { color: "#ffffff", width: 1.5 } },
          cliponaxis: false,
          hovertemplate: "%{text}<br>Energy = %{x:.3f} eV<br>E − E₀ = %{customdata:.3f} eV<br>μ(E) = %{y:.5f}<extra></extra>",
        })
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
    let xTitle = { E: "Energy (eV)", k: "k (Å⁻¹)", R: "R (Å)", q: compareK ? "k, q (Å⁻¹)" : "q (Å⁻¹)" }[space]
    const kTitle = mixedWeights ? "k-weighted χ(k) (weights in legend)" : weights[0] === 0 ? "χ(k)" : `k<sup>${weights[0] ?? 2}</sup> χ(k)`
    let yTitle = { E: mixedEnergyForms ? "Signal (forms in legend)" : energyForms[0] ?? energyTitle, k: kTitle, R: component === "mag" ? "|χ(R)|" : component === "pha" ? "Phase χ(R) (rad)" : `${component === "re" ? "Re" : "Im"}[χ(R)]`, q: component === "mag" ? "|χ(q)|" : component === "pha" ? "Phase χ(q) (rad)" : `${component === "re" ? "Re" : "Im"}[χ(q)]` }[space]
    if (compareK) yTitle = `${kTitle}, Re[χ(q)]`
    if (analysis && analysisVisible) {
      data.length = 0
      // A combination search keeps the winning fit's arrays under `best`.
      const result = (analysis.kind === "lcf_search" ? analysis.result.best ?? {} : analysis.result) as Record<string, unknown>
      if (analysis.kind === "pca") {
        const variances = (result.explained_variance_ratio ?? []) as number[]
        data.push({ x: variances.map((_, i) => i + 1), y: variances.map(v => v * 100), type: "bar", marker: { color: "#16736b" }, name: "Explained variance" })
        xTitle = "Principal component"; yTitle = "Explained variance (%)"
      } else if (analysis.kind === "lcf_series") {
        // Each target is its own fit: draw one, with its residual. Overlaying
        // every target gave dozens of curves and no residual to judge.
        const rows = ((result.targets ?? []) as Record<string, unknown>[]).filter(row => Array.isArray(row.x))
        const row = rows.find(r => r.group_id === seriesTarget) ?? rows[0]
        if (row) {
          const x = row.x as number[], label = String(row.label ?? "")
          add(x, (row.observed ?? []) as number[], `Observed · ${label}`, "#16736b", "solid", true)
          add(x, (row.fit ?? []) as number[], `Fit · ${label}`, "#c37b38", "dash")
          add(x, (row.residual ?? []) as number[], `Residual · ${label}`, "#7470b0")
        }
        xTitle = analysis.options.array === "chi" || analysis.options.array === "weighted_chi" ? "k (Å⁻¹)" : "Energy (eV)"
        yTitle = "Signal / fit"
      } else if (analysis.kind === "peaks_series") {
        // One fit over several spectra: each keeps its own curve, and the
        // colours separate the spectra rather than observed from fit.
        const rows = (result.spectra ?? []) as Record<string, unknown>[]
        const fitted = rows.filter(row => Array.isArray(row.x))
        const names = (result.labels ?? []) as string[]
        const seriesColors = spectrumColors(fitted.length, { palette, reversed, vmin, vmax })
        fitted.forEach((spectrum, index) => {
          const label = names[index] ?? `Spectrum ${index + 1}`
          const x = (spectrum.x ?? []) as number[]
          add(x, (spectrum.observed ?? []) as number[], `Observed · ${label}`, seriesColors[index], "solid", true)
          add(x, (spectrum.fit ?? []) as number[], `Fit · ${label}`, seriesColors[index], "dash")
        })
        xTitle = analysis.options.array === "chi" || analysis.options.array === "weighted_chi" ? "k (Å⁻¹)" : "Energy (eV)"
        yTitle = "Signal / fit"
      } else if (analysis.kind === "log_ratio") {
        add(result.k as number[], result.log_amplitude_ratio as number[], "ln(A target / A reference)", "#16736b")
        const phase = add(result.k as number[], result.phase_difference as number[], "Phase difference (rad)", "#c37b38")
        if (phase) phase.yaxis = "y2"
        xTitle = "k (Å⁻¹)"; yTitle = "Log amplitude ratio"
      } else {
        const x = (result.x ?? []) as number[]
        add(x, (result.observed ?? []) as number[], "Observed", "#16736b", "solid", true)
        add(x, (result.fit ?? []) as number[], "Fit", "#c37b38", "dash")
        add(x, (result.residual ?? []) as number[], "Residual", "#7470b0")
        xTitle = analysis.options.array === "chi" || analysis.options.array === "weighted_chi" ? "k (Å⁻¹)" : "Energy (eV)"
        yTitle = "Signal / fit"
      }
    }
    return { data, xTitle, yTitle, e0 }
  }, [groups, activeId, space, energyMode, background, showWindow, component, offset, plotScope, preEdge, postEdge, showDataPoints, kWeight, palette, reversed, vmin, vmax, analysis, analysisVisible, seriesTarget])
  const hasData = data.some(d => (d.x as number[])?.length)
  useEffect(() => {
    const element = plotRef.current
    if (!element) return
    const measure = () => setPlotWidth(element.clientWidth)
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [hasData])

  // Keep filenames readable without letting the legend consume a narrow plot.
  // Only display names wrap; hover labels retain the original full name.
  const legendLineLength = Math.max(10, Math.floor((plotWidth * 0.4 - 48) / 7))
  const plotData = useMemo(() => !showLegend || !plotWidth ? data : data.map(trace => {
    const name = String(trace.name ?? "")
    if (name.length <= legendLineLength) return trace
    const characters = Array.from(name)
    const lines: string[] = []
    for (let index = 0; index < characters.length; index += legendLineLength) lines.push(characters.slice(index, index + legendLineLength).join(""))
    return { ...trace, name: lines.join("<br>"), meta: { legendLabel: name },
      hovertemplate: typeof trace.hovertemplate === "string" ? trace.hovertemplate.replace("%{fullData.name}", "%{meta.legendLabel}") : undefined }
  }), [data, showLegend, plotWidth, legendLineLength])
  const noSelection = !groups.length && active && plotScope === "selected" && !analysisVisible
  function openOptionsMenu(event: PlotOptionsEvent) {
    event.preventDefault()
    event.stopPropagation()
    const trigger = event.currentTarget
    const bounds = trigger.getBoundingClientRect()
    const pointer = event.type === "contextmenu" && "clientX" in event && (event.clientX || event.clientY)
    onOptionsMenuOpen?.()
    setOptionsMenu({ trigger, anchor: pointer ? { x: event.clientX, y: event.clientY } : { x: bounds.left, y: bounds.bottom } })
  }
  const plotInteraction = {
    tabIndex: 0,
    role: "group" as const,
    "aria-haspopup": "menu" as const,
    "aria-expanded": !!optionsMenu,
    "aria-keyshortcuts": "Shift+F10",
    onContextMenu: openOptionsMenu,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openOptionsMenu(event)
    },
  }
  const options = optionsMenu && <AthenaContextMenu key={`${optionsMenu.anchor.x}:${optionsMenu.anchor.y}`} label="Spectrum plot options" anchor={optionsMenu.anchor} returnFocus={optionsMenu.trigger} onClose={() => setOptionsMenu(null)} items={[
    { id: "grid", label: "Show grids", checked: showGrid, onSelect: () => onShowGridChange?.(!showGrid) },
    { id: "points", label: "Show data points", checked: showDataPoints, onSelect: () => onShowDataPointsChange?.(!showDataPoints) },
  ]} />
  const rangeStart = range[0] ?? (space === "R" ? DEFAULT_R_PLOT_RANGE[0] : null)
  const rangeEnd = range[1] ?? (space === "R" ? DEFAULT_R_PLOT_RANGE[1] : null)
  const layout = useMemo(() => {
    const xRange = analysisVisible || (rangeStart === null && rangeEnd === null)
      ? { autorange: true as const }
      : rangeStart !== null && rangeEnd !== null
        ? { range: [rangeStart, rangeEnd] }
        : rangeStart !== null
          ? { range: [rangeStart, null], autorange: "max" as const }
          : { range: [null, rangeEnd], autorange: "min" as const }
    const showE0 = e0 !== null
    return {
      shapes: showE0 ? [{ type: "line", xref: "x", yref: "paper", x0: e0, x1: e0, y0: 0, y1: 1,
        line: { color: "#64748b", width: 1.5, dash: "dot" }, layer: "below" }] : [],
      annotations: showE0 ? [{ x: e0, xref: "x", y: 1, yref: "paper", text: `E₀ = ${e0.toFixed(3)} eV`,
        showarrow: false, xanchor: "auto", yanchor: "bottom", yshift: 3, font: { size: 12, color: "#64748b" } }] : [],
      autosize: true, margin: { l: 72, r: 25, t: 24, b: 60 }, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
      font: { color: "#586661" },
      hoverlabel: { namelength: -1 },
      xaxis: { title: { text: xTitle, standoff: 16 }, showgrid: showGrid, gridcolor: "#edf0ed", zerolinecolor: "#d8ded8", showline: true, linecolor: "#bdc8c0", ticks: "outside", ...xRange },
      yaxis: { title: { text: yTitle, standoff: 15 }, showgrid: showGrid, gridcolor: "#edf0ed", zerolinecolor: "#d8ded8", showline: true, linecolor: "#bdc8c0", ticks: "outside", automargin: true },
      ...(analysisVisible && analysis?.kind === "log_ratio" ? { yaxis2: { title: {text: "Phase difference (rad)"}, overlaying: "y", tickmode: "auto", side: "right", showgrid: false, automargin: true } } : {}),
      showlegend: showLegend, legend: { orientation: "v", x: 0.99, xanchor: "right", y: 0.99, yanchor: "top", maxheight: 1, bgcolor: "rgba(0,0,0,0)" },
      hovermode: "closest", uirevision: `${space}-${energyMode}-${component}-${analysisVisible}-${[rangeStart, rangeEnd].join()}-${plotScope}-${plotScope === "current" ? activeId ?? "" : ""}-${kWeight ?? "auto"}`,
    }
  }, [xTitle, yTitle, e0, showGrid, analysisVisible, analysis?.kind, showLegend, space, energyMode, component, rangeStart, rangeEnd, plotScope, activeId, kWeight])
  const config = useMemo(() => ({ displaylogo: false, responsive: true, toImageButtonOptions: { format: "svg", filename: "athena-spectrum" }, modeBarButtonsToRemove: ["lasso2d", "select2d"] }), [])
  const canPick = picking && !analysisVisible && space !== "q"
  // react-plotly.js only refreshes listeners when the figure changes. Arming a
  // picker need not redraw it, so the retained listener reads committed state.
  const pickState = useRef({ canPick, onPickX, space, data: plotData })
  useLayoutEffect(() => { pickState.current = { canPick, onPickX, space, data: plotData } }, [canPick, onPickX, space, plotData])
  const onPlotClick = useCallback<NonNullable<ComponentProps<typeof Plot>["onClick"]>>(event => {
    const x = event.points?.[0]?.x
    const current = pickState.current
    // Plotly redraws asynchronously; ignore the old figure's queued clicks.
    if (current.data !== plotData || current.space !== space) return
    if (current.canPick && typeof x === "number" && Number.isFinite(x)) current.onPickX?.(x, space)
  }, [plotData, space])
  if (!hasData) return <><div ref={plotRef} className="ath-no-plot" data-testid="athena-plot" aria-label={`${space}-space spectrum plot`} {...plotInteraction}><span>{space}</span><h3>{noSelection ? "No spectra selected" : groups.length ? "No data in this plot space" : "Your spectra, in perspective."}<SectionHelp label="Spectrum plot">{noSelection ? "Check data groups to compare spectra. The Single spectrum viewer shows the highlighted group." : groups.length ? "Check the data type and processing parameters, or select another plot space." : "Import a spectrum or load the copper examples to begin."}</SectionHelp></h3></div>{options}</>
  return <><div ref={plotRef} className={`ath-plot${canPick ? " ath-picking" : ""}`} data-testid="athena-plot" aria-label={`${space}-space spectrum plot`} {...plotInteraction}><Plot data={plotData} onClick={onPlotClick} layout={layout} config={config} useResizeHandler style={{ width: "100%", height: "100%" }} /></div>{options}</>
}
