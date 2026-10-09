"use client"

import { SectionHelp } from "../section-help"
import { useEffect, useRef, useState } from "react"
import { isTheoryGroup, type AthenaGroup } from "@/lib/athena"
import type { ArtemisFitResult } from "@/lib/artemis"
import { ThemedPlot as Plot } from "../themed-plot"
import { ResizablePlotCard } from "./athena-plot-card"
import { ViewerPanel } from "./viewer-panel"
import { ViewerControlField, ViewerControlGroup, ViewerDisplayControls, ViewerToggle } from "./viewer-display-controls"
import { ViewerKWeightControl } from "./viewer-kweight-control"
import { useArtemisPlotWeight } from "./artemis-plot-weight"
import { ArtemisFitReport } from "./artemis-fit-report"
import { useArtemisTheoryResult, type ArtemisTheoryResult } from "./artemis-theory-result"
import { ArtemisTheorySummary } from "./artemis-theory-summary"
import styles from "../artemis-fitting.module.css"

export function ArtemisFitResultViewer({ result, group, projectId, version, pending = false }: {
  result?: ArtemisFitResult | null; group?: AthenaGroup; projectId?: string; version?: number; pending?: boolean
}) {
  const [space, setSpace] = useState<"k" | "r">("r")
  const [component, setComponent] = useState<"mag" | "re" | "im">("mag")
  const [showPaths, setShowPaths] = useState(true)
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotWidth, setPlotWidth] = useState(0)
  const [offsetPlot, setOffsetPlot] = useState(true)
  const [offsetDraft, setOffsetDraft] = useState<{ result: ArtemisFitResult | ArtemisTheoryResult; space: "k" | "r"; component: "mag" | "re" | "im"; value: string } | null>(null)
  const [plotError, setPlotError] = useState(false)
  const [kWeight, setKWeight] = useState<number | null>(null)
  const [theoryChoice, setTheoryChoice] = useState<ArtemisFitResult | null>(null)
  const theoryGroup = !!group && isTheoryGroup(group)
  const matchingFit = result?.group_id === group?.id ? result ?? null : null
  const isTheory = theoryGroup && (!matchingFit || theoryChoice === matchingFit)
  const fit = !isTheory && !pending ? matchingFit : null
  const weightedPlot = useArtemisPlotWeight({ projectId, version, result: fit, kWeight })
  const theoryPlot = useArtemisTheoryResult({ projectId, version, group: isTheory && !pending ? group : undefined, kWeight })
  const theory = isTheory ? theoryPlot.result : null
  const visible = theory ?? fit
  const plotted = theory ?? weightedPlot.result
  const loading = isTheory ? theoryPlot.loading : weightedPlot.loading
  const error = isTheory ? theoryPlot.error : weightedPlot.error
  const retry = isTheory ? theoryPlot.retry : weightedPlot.retry
  const warnings = theory?.warnings ?? weightedPlot.warnings
  const plottedWeight = plotted?.k.weight ?? visible?.k.weight ?? 0
  useEffect(() => { setPlotError(false) }, [visible, space, component, showPaths, offsetPlot, kWeight])
  useEffect(() => {
    const element = plotRef.current
    if (!element) return
    const measure = () => setPlotWidth(element.clientWidth)
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [])
  const fitted = weightedPlot.result
  const series = theory ? space === "k" ? { x: theory.k.x, model: theory.k.total, data: null, residual: null }
    : { x: theory.r.x, model: theory.r[`total_${component}`], data: null, residual: null }
    : fitted ? space === "k" ? { x: fitted.k.x, data: fitted.k.data, model: fitted.k.model, residual: fitted.k.residual }
    : { x: fitted.r.x, data: fitted.r[`data_${component}`], model: fitted.r[`model_${component}`], residual: fitted.r[`residual_${component}`] } : null
  const paths = plotted?.paths ?? []
  const pathCurves = paths.map(path => space === "k" ? path.k?.chi : path.r?.[component])
  const pathsAvailable = paths.length > 0 && pathCurves.every(values => Array.isArray(values) && values.length === series?.x.length && values.every(Number.isFinite))
  const pathsShown = showPaths && pathsAvailable
  const curves = series ? [
    ...(series.data ? [{ name: "Data", y: series.data, color: "#166d8d", dash: "solid", width: 2.4, tier: 0 }] : []),
    { name: isTheory ? "Total theory" : "Model", y: series.model, color: "#db7835", dash: "solid", width: 2.4, tier: 0 },
    ...(series.residual ? [{ name: "Residual", y: series.residual, color: "#8d5bab", dash: "dot", width: 1.4, tier: 1 }] : []),
    ...(pathsShown ? paths.map((path, i) => ({ name: `Path ${i + 1} · ${path.label || path.filename}`, y: pathCurves[i]!,
      color: `hsl(${((i * 137.508 + 145) % 360).toFixed(1)}, 58%, 40%)`, dash: "solid", width: 1, tier: i + (isTheory ? 1 : 2) })) : []),
  ] : []
  // Include zero when measuring signed/magnitude curves, then use a compact
  // baseline step: a 0.14-high peak gets about 0.01 spacing at any plot weight.
  const largestSpan = curves.reduce((span, curve) => {
    let low = 0, high = 0
    for (const value of curve.y) { low = Math.min(low, value); high = Math.max(high, value) }
    return Math.max(span, high - low)
  }, 0)
  const automaticSpacing = largestSpan > 0 && Number.isFinite(largestSpan * 0.07) ? Number((largestSpan * 0.07).toPrecision(4)) : 1
  const offsetText = offsetDraft && offsetDraft.result === plotted && offsetDraft.space === space && offsetDraft.component === component ? offsetDraft.value : String(automaticSpacing)
  const validSpacing = offsetText.trim() !== "" && Number.isFinite(Number(offsetText)) && Number(offsetText) >= 0 && Number(offsetText) <= Number.MAX_VALUE / Math.max(curves.length, 1)
  const spacing = validSpacing ? Number(offsetText) : automaticSpacing
  // Match the spectrum viewers' right-side legend and label wrapping.
  // Only display names wrap; hover labels retain the original full name.
  const legendLineLength = Math.max(10, Math.floor((plotWidth * 0.4 - 48) / 7))
  const traces = series ? curves.map(curve => {
    const offset = offsetPlot ? -curve.tier * spacing : 0
    const characters = Array.from(curve.name)
    const lines: string[] = []
    if (plotWidth) {
      for (let index = 0; index < characters.length; index += legendLineLength) lines.push(characters.slice(index, index + legendLineLength).join(""))
    }
    // The residual is drawn by default: a misfit is the first thing a reader of
    // an EXAFS fit should be able to see, not something to find in the legend.
    return { type: "scatter", mode: "lines", name: lines.length ? lines.join("<br>") : curve.name, meta: { legendLabel: curve.name }, x: series.x.slice(), y: curve.y.map(value => value + offset),
      visible: true,
      customdata: curve.y.map(value => [value, offset]),
      hovertemplate: `${space === "k" ? "k" : "R"} = %{x:.3f} ${space === "k" ? "Å⁻¹" : "Å"}<br>Unshifted value = %{customdata[0]:.5g}<br>Display offset = %{customdata[1]:+.5g}<extra>%{meta.legendLabel}</extra>`,
      line: { color: curve.color, width: curve.width, dash: curve.dash } }
  }) : []
  return <ViewerPanel title={isTheory ? "EXAFS theory" : "EXAFS fit"} label={isTheory ? "EXAFS theory results" : "EXAFS fit results"} viewerId="fit" className={styles.viewer} help={<>
    {isTheory ? "The saved FEFF paths are summed at the supplied simulation parameters. No measured data or fit is involved. The original simulation Fourier settings are used. " : "Build a FEFF path model in the EXAFS fitting tab, then run the fit to compare data and model."}
    {visible && <>{!isTheory && (space === "r" && component === "mag" ? "Residual is |FT(data − model)|, not the difference of magnitudes. " : "Residual = data − model. ")}
      {pathsShown && space === "r" && component === "mag" && (isTheory ? "Individual path magnitudes do not add to the total magnitude; the complex path contributions add before taking the magnitude. " : "Individual path magnitudes do not add to the model magnitude; the complex path contributions add before taking the magnitude. ")}
      {offsetPlot && (isTheory ? "Offsets affect display only: Total theory stays at zero offset and each path uses a successively lower baseline. " : "Offsets affect display only: Data and Model share zero offset; Residual and each path use successively lower baselines. ")}
      Plot k-weight {plottedWeight}{fit && <>; fit weights {fit.transform.kweight.join(", ")}</>}.</>}
  </>} actions={<div className={styles.resultActions}>
    {theoryGroup && matchingFit && <div className={styles.choice} role="group" aria-label="EXAFS result type">
      <button type="button" aria-pressed={!isTheory} onClick={() => setTheoryChoice(null)}>Fit result</button>
      <button type="button" aria-pressed={isTheory} onClick={() => setTheoryChoice(matchingFit)}>Theory</button>
    </div>}
    <div className={styles.choice} role="group" aria-label={isTheory ? "Theory plot space" : "Fit plot space"}>{(["k", "r"] as const).map(value => <button type="button" key={value} aria-pressed={space === value} onClick={() => setSpace(value)}>{value === "r" ? "R space" : "k space"}</button>)}<SectionHelp label={isTheory ? "Theory plot space" : "Fit plot space"}>{isTheory ? "View the theoretical total and its paths in k space or after the Fourier transform in R space." : "Compare the saved data and model in k space or after the Fourier transform in R space. Changing the plot space does not repeat the fit."}</SectionHelp></div>
    {visible && space === "r" && <div className={styles.choice} role="group" aria-label="R plot component">{([ ["mag", "Magnitude"], ["re", "Real"], ["im", "Imaginary"] ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={component === value} onClick={() => setComponent(value)}>{label}</button>)}<SectionHelp label="R plot component">Magnitude shows |χ(R)|; Real and Imaginary show its signed complex components. Use the signed components to inspect how paths interfere before their complex sum is converted to magnitude.</SectionHelp></div>}
  </div>}>
    <ResizablePlotCard storageKey="artemis.fit.height.v1" defaultHeight={380} plotSelector="#artemis-fit-plot" resizeLabel={isTheory ? "Resize EXAFS theory plot height" : "Resize EXAFS fit plot height"} controlsId="artemis-fit-plot">
      {fit?.archive && <div className={styles.message} role="status">
        <p>{fit.archive.imported ? "Imported fit archive" : "Saved fit"} · {new Date(fit.archive.created).toLocaleString()} · Larch {fit.archive.origin.larch_version}</p>
        {fit.archive.stale && <p>Outdated input<SectionHelp label="Outdated fit input">This spectrum has changed since the fit. These curves show the saved data and model. Run a new fit for the current spectrum.</SectionHelp></p>}
        {fit.archive.modelChanged && <p>The current model differs from this saved fit.</p>}
        {fit.archive.imported && <p>Imported fit · unverified<SectionHelp label="Imported fit">This result was imported with the project and has not been verified by a new fit here.</SectionHelp></p>}
      </div>}
      {visible && <p className={styles.resultSummary}>{visible.group_label} · {isTheory ? `theory · ${paths.length} paths · no fit` : `fit in ${visible.transform.fitspace.toUpperCase()} · k-weights ${visible.transform.kweight.join(", ")}`}</p>}
      <div id="artemis-fit-plot" ref={plotRef} className={styles.plot}>
        {loading ? <p className={styles.empty} role="status">{isTheory ? "Loading theory path contributions…" : "Updating fit plot transform…"}</p>
          : error ? <div className={styles.empty} role="alert"><p>{error}</p><button type="button" onClick={retry}>Try again</button></div>
          : !visible || !series ? <p className={styles.empty} role="status">{pending ? "Waiting for spectrum processing…" : isTheory ? "No saved theory result" : "No fit result"}</p>
          : plotError ? <p className={styles.empty} role="alert">Could not render the {isTheory ? "theory" : "fit"} plot. The numerical {isTheory ? "calculation details" : "results and report"} remain available below.</p>
            : <Plot data={traces}
              layout={{ autosize: true, margin: { l: 65, r: 22, t: 18, b: 56 }, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
                font: { color: "#52665b" },
                xaxis: { title: { text: space === "k" ? "k (Å⁻¹)" : "R (Å, not phase corrected)" }, gridcolor: "#e6ece4", ...(space === "r" ? { range: [0, Math.max(6, visible.transform.rmax + 1)] } : {}) },
                yaxis: { title: { text: (space === "k" ? `k<sup>${plottedWeight}</sup>χ(k) (Å<sup>−${plottedWeight}</sup>)` : `${component === "mag" ? "|χ(R)|" : component === "re" ? "Re χ(R)" : "Im χ(R)"} (Å<sup>−${plottedWeight + 1}</sup>)`) + (offsetPlot ? " + display offset" : "") }, gridcolor: "#e6ece4", zerolinecolor: "#cbd7cf" },
                legend: { orientation: "v", x: 0.99, xanchor: "right", y: 0.99, yanchor: "top", maxheight: 1, bgcolor: "rgba(0,0,0,0)" }, uirevision: `${visible.project_id}:${visible.group_id}:${visible.version}:${space}:${component}:${pathsShown}:${offsetPlot}:${offsetPlot ? spacing : 0}:${plottedWeight}`,
                shapes: isTheory && space === "r" ? [] : [{ type: "rect", xref: "x", yref: "paper", x0: space === "k" ? visible.transform.kmin : visible.transform.rmin,
                  x1: space === "k" ? visible.transform.kmax : visible.transform.rmax, y0: 0, y1: 1, fillcolor: "#25844c", opacity: 0.06, line: { width: 0 }, layer: "below" }],
              }} config={{ responsive: true, displaylogo: false, toImageButtonOptions: { filename: `artemis-${isTheory ? "theory" : "fit"}-${space}-k${plottedWeight}`, scale: 2 } }} useResizeHandler style={{ width: "100%", height: "100%" }} onError={() => setPlotError(true)} />}
      </div>
      {visible && <ViewerDisplayControls label={isTheory ? "Theory plot display options" : "Fit plot display options"}>
        <ViewerControlGroup>
          <ViewerToggle label="Offset plot" help={isTheory ? "Separate the individual paths vertically below the total theory. Offsets only change the display." : "Separate the residual and individual paths vertically. Data and model keep the same baseline; offsets only change the display."} checked={offsetPlot} onChange={setOffsetPlot} />
          {offsetPlot && <>
            <ViewerControlField label="Spacing" help="Set the nonnegative vertical distance between curves, or use Auto to restore automatic spacing. This does not change the calculated amplitudes."><input type="number" min="0" step="any" aria-label="Offset spacing" aria-invalid={!validSpacing} value={offsetText}
              onChange={event => setOffsetDraft({ result: plotted!, space, component, value: event.target.value })} /></ViewerControlField>
            <button type="button" onClick={() => setOffsetDraft(null)} title="Use automatic spacing for the visible curves">Auto</button>
          </>}
        </ViewerControlGroup>
        <ViewerControlGroup>
          <ViewerKWeightControl label={isTheory ? "EXAFS theory k-weight" : "EXAFS fit k-weight"} value={kWeight} savedWeight={theory?.simulation.request.transform.kweight[0] ?? visible.k.weight}
            onChange={setKWeight} disabled={!projectId || version === undefined} />
          <ViewerToggle label="Show paths" checked={pathsShown} disabled={!pathsAvailable} onChange={setShowPaths} title={isTheory ? "Display the individual FEFF paths evaluated at the saved simulation parameters." : pathsAvailable ? "Display the individual FEFF paths evaluated at the fitted parameters." : "Run the fit again to include individual path curves in its results."} />
          {!pathsAvailable && <SectionHelp label="Unavailable path curves">{isTheory ? "The saved simulation needs its original FEFF path files to show contributions." : "Run the fit again to include path curves."}</SectionHelp>}
        </ViewerControlGroup>
        {offsetPlot && !validSpacing && <span className={styles.optionHint} role="status">Invalid spacing · using automatic<SectionHelp label="Offset spacing validation">Enter a finite, nonnegative spacing. Automatic spacing is shown until the value is valid.</SectionHelp></span>}
      </ViewerDisplayControls>}
      {warnings.length > 0 && <ul className={styles.warnings}>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    </ResizablePlotCard>
    {theory ? <ArtemisTheorySummary result={theory} /> : fit && <ArtemisFitReport result={fit} savedPaths={fit.archive ? group?.artemis?.history.find(record => record.id === fit.archive!.id)?.model.paths : undefined} />}
  </ViewerPanel>
}
