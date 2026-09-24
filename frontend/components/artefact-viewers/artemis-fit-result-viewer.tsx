"use client"

import { useEffect, useState } from "react"
import type { AthenaGroup } from "@/lib/athena"
import type { ArtemisFitResult } from "@/lib/artemis"
import { download, exportBundle, format } from "@/lib/artemis-fit-utils"
import { ThemedPlot as Plot } from "../themed-plot"
import { ResizablePlotCard } from "./athena-plot-card"
import { ViewerPanel } from "./viewer-panel"
import { ViewerControlField, ViewerControlGroup, ViewerDisplayControls, ViewerToggle } from "./viewer-display-controls"
import styles from "../artemis-fitting.module.css"

export function ArtemisFitResultViewer({ result, group, pending = false }: { result?: ArtemisFitResult | null; group?: AthenaGroup; pending?: boolean }) {
  const [space, setSpace] = useState<"k" | "r">("r")
  const [component, setComponent] = useState<"mag" | "re" | "im">("mag")
  const [showPaths, setShowPaths] = useState(false)
  const [offsetPlot, setOffsetPlot] = useState(false)
  const [offsetDraft, setOffsetDraft] = useState<{ result: ArtemisFitResult; space: "k" | "r"; component: "mag" | "re" | "im"; value: string } | null>(null)
  const [plotError, setPlotError] = useState(false)
  const visible = !pending && result?.group_id === group?.id ? result : null
  useEffect(() => { setPlotError(false) }, [visible, space, component, showPaths, offsetPlot])
  const series = visible ? space === "k" ? { x: visible.k.x, data: visible.k.data, model: visible.k.model, residual: visible.k.residual }
    : { x: visible.r.x, data: visible.r[`data_${component}`], model: visible.r[`model_${component}`], residual: visible.r[`residual_${component}`] } : null
  const paths = visible?.paths ?? []
  const pathCurves = paths.map(path => space === "k" ? path.k?.chi : path.r?.[component])
  const pathsAvailable = paths.length > 0 && pathCurves.every(values => Array.isArray(values) && values.length === series?.x.length && values.every(Number.isFinite))
  const pathsShown = showPaths && pathsAvailable
  const curves = series ? [
    { name: "Data", y: series.data, color: "#166d8d", dash: "solid", tier: 0 },
    { name: "Model", y: series.model, color: "#db7835", dash: "solid", tier: 0 },
    { name: "Residual", y: series.residual, color: "#8d5bab", dash: "dot", tier: 1 },
    ...(pathsShown ? paths.map((path, i) => ({ name: `Path ${i + 1} · ${path.label || path.filename}`, y: pathCurves[i]!,
      color: `hsl(${((i * 137.508 + 145) % 360).toFixed(1)}, 58%, 40%)`, dash: "solid", tier: i + 2 })) : []),
  ] : []
  // Use the full vertical excursion, including zero, so signed and magnitude curves both separate clearly.
  const largestSpan = curves.reduce((span, curve) => {
    let low = 0, high = 0
    for (const value of curve.y) { low = Math.min(low, value); high = Math.max(high, value) }
    return Math.max(span, high - low)
  }, 0)
  const automaticSpacing = largestSpan > 0 && Number.isFinite(largestSpan * 1.15) ? Number((largestSpan * 1.15).toPrecision(4)) : 1
  const offsetText = offsetDraft && offsetDraft.result === visible && offsetDraft.space === space && offsetDraft.component === component ? offsetDraft.value : String(automaticSpacing)
  const validSpacing = offsetText.trim() !== "" && Number.isFinite(Number(offsetText)) && Number(offsetText) >= 0 && Number(offsetText) <= Number.MAX_VALUE / Math.max(curves.length, 1)
  const spacing = validSpacing ? Number(offsetText) : automaticSpacing
  const traces = series ? curves.map(curve => {
    const offset = offsetPlot ? -curve.tier * spacing : 0
    return { type: "scatter", mode: "lines", name: curve.name, x: series.x.slice(), y: curve.y.map(value => value + offset),
      visible: curve.name === "Residual" ? "legendonly" : true,
      customdata: curve.y.map(value => [value, offset]),
      hovertemplate: `${space === "k" ? "k" : "R"} = %{x:.3f} ${space === "k" ? "Å⁻¹" : "Å"}<br>Unshifted value = %{customdata[0]:.5g}<br>Display offset = %{customdata[1]:+.5g}<extra>%{fullData.name}</extra>`,
      line: { color: curve.color, width: curve.tier > 0 ? 1.4 : 1.8, dash: curve.dash } }
  }) : []
  return <ViewerPanel title="EXAFS fit" label="EXAFS fit results" viewerId="fit" className={styles.viewer} actions={<div className={styles.resultActions}>
    <div className={styles.choice} role="group" aria-label="Fit plot space">{(["k", "r"] as const).map(value => <button type="button" key={value} aria-pressed={space === value} onClick={() => setSpace(value)}>{value === "r" ? "R space" : "k space"}</button>)}</div>
    {visible && space === "r" && <div className={styles.choice} role="group" aria-label="R plot component">{([ ["mag", "Magnitude"], ["re", "Real"], ["im", "Imaginary"] ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={component === value} onClick={() => setComponent(value)}>{label}</button>)}</div>}
  </div>}>
    <ResizablePlotCard storageKey="artemis.fit.height.v1" defaultHeight={380} plotSelector="#artemis-fit-plot" resizeLabel="Resize EXAFS fit plot height" controlsId="artemis-fit-plot">
      {visible && <p className={styles.resultSummary}>{visible.group_label} · fit in {visible.transform.fitspace.toUpperCase()} · k-weights {visible.transform.kweight.join(", ")}</p>}
      <div id="artemis-fit-plot" className={styles.plot}>
        {!visible || !series ? <p className={styles.empty} role="status">{pending ? "Waiting for spectrum processing…" : "Build a FEFF path model in the EXAFS fitting tab, then run the fit to compare data and model."}</p>
          : plotError ? <p className={styles.empty} role="alert">Could not render the fit plot. The numerical results and report remain available below.</p>
            : <Plot data={traces}
              layout={{ autosize: true, margin: { l: 65, r: 22, t: 18, b: 56 }, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
                font: { color: "#52665b" },
                xaxis: { title: { text: space === "k" ? "k (Å⁻¹)" : "R (Å, not phase corrected)" }, gridcolor: "#e6ece4", ...(space === "r" ? { range: [0, Math.max(6, visible.transform.rmax + 1)] } : {}) },
                yaxis: { title: { text: (space === "k" ? `k<sup>${visible.k.weight}</sup>χ(k) (Å<sup>−${visible.k.weight}</sup>)` : `${component === "mag" ? "|χ(R)|" : component === "re" ? "Re χ(R)" : "Im χ(R)"} (Å<sup>−${visible.k.weight + 1}</sup>)`) + (offsetPlot ? " + display offset" : "") }, gridcolor: "#e6ece4", zerolinecolor: "#cbd7cf" },
                legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", maxheight: 0.24, ...(pathsShown ? { entrywidth: 0.49, entrywidthmode: "fraction" } : {}) }, uirevision: `${visible.project_id}:${visible.group_id}:${visible.version}:${space}:${component}:${pathsShown}:${offsetPlot}:${offsetPlot ? spacing : 0}`,
                shapes: [{ type: "rect", xref: "x", yref: "paper", x0: space === "k" ? visible.transform.kmin : visible.transform.rmin,
                  x1: space === "k" ? visible.transform.kmax : visible.transform.rmax, y0: 0, y1: 1, fillcolor: "#25844c", opacity: 0.06, line: { width: 0 }, layer: "below" }],
              }} config={{ responsive: true, displaylogo: false, toImageButtonOptions: { filename: `artemis-fit-${space}`, scale: 2 } }} useResizeHandler style={{ width: "100%", height: "100%" }} onError={() => setPlotError(true)} />}
      </div>
      {visible && <ViewerDisplayControls label="Fit plot display options">
        <ViewerControlGroup>
          <ViewerToggle label="Offset plot" checked={offsetPlot} onChange={setOffsetPlot} />
          {offsetPlot && <>
            <ViewerControlField label="Spacing"><input type="number" min="0" step="any" aria-label="Offset spacing" aria-invalid={!validSpacing} value={offsetText}
              onChange={event => setOffsetDraft({ result: visible, space, component, value: event.target.value })} /></ViewerControlField>
            <button type="button" onClick={() => setOffsetDraft(null)} title="Use automatic spacing for the visible curves">Auto</button>
          </>}
        </ViewerControlGroup>
        <ViewerControlGroup>
          <ViewerToggle label="Show paths" checked={pathsShown} disabled={!pathsAvailable} onChange={setShowPaths} title={pathsAvailable ? "Display the individual FEFF paths evaluated at the fitted parameters." : "Run the fit again to include individual path curves in its results."} />
          {!pathsAvailable && <span className={styles.optionHint}>Run the fit again to include path curves.</span>}
        </ViewerControlGroup>
        {offsetPlot && !validSpacing && <span className={styles.optionHint} role="status">Enter a finite, nonnegative spacing. Automatic spacing is shown until the value is valid.</span>}
      </ViewerDisplayControls>}
      {visible && <p className={styles.plotNote}>{space === "r" && component === "mag" ? "Residual is |FT(data − model)|, not the difference of magnitudes. " : "Residual = data − model. "}{pathsShown && space === "r" && component === "mag" && "Individual path magnitudes do not add to the model magnitude; the complex path contributions add before taking the magnitude. "}{offsetPlot && "Offsets affect display only: Data and Model share zero offset; Residual and each path use successively lower baselines. "}Plot k-weight {visible.k.weight}; fit weights {visible.transform.kweight.join(", ")}.</p>}
    </ResizablePlotCard>
    {visible && <div className={styles.results}>
      {!visible.success && <p className={styles.error} role="alert">Fit did not converge: {visible.message}</p>}
      {visible.warnings.length > 0 && <ul className={styles.warnings}>{visible.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      <dl className={styles.statistics}>
        {([
          ["R factor", visible.statistics.r_factor], ["Reduced χ²", visible.statistics.reduced_chi_square], ["χ²", visible.statistics.chi_square],
          ["Independent points", visible.statistics.n_independent], ["Free parameters", visible.statistics.n_varys], ["Fit evaluations", visible.statistics.nfev],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(value)}</dd></div>)}
      </dl>
      <div className={styles.tableScroll}><table><caption>Fitted parameters</caption><thead><tr><th>Name</th><th>Kind</th><th>Value</th><th>Uncertainty</th><th>Expression</th></tr></thead><tbody>{visible.parameters.map(parameter => <tr key={parameter.name}><th scope="row">{parameter.name}</th><td>{parameter.kind}</td><td>{format(parameter.value, 7)}</td><td>{format(parameter.stderr, 3)}</td><td>{parameter.expression || "—"}</td></tr>)}</tbody></table></div>
      {!visible.statistics.errorbars && <p className={styles.help}>Parameter uncertainties could not be estimated for this fit.</p>}
      {visible.correlations.length > 0 && <details><summary>Parameter correlations ({visible.correlations.length})</summary><div className={styles.tableScroll}><table><thead><tr><th>Parameter pair</th><th>Correlation</th></tr></thead><tbody>{visible.correlations.map(pair => <tr key={`${pair.left}:${pair.right}`}><td>{pair.left} / {pair.right}</td><td>{format(pair.value, 4)}</td></tr>)}</tbody></table></div></details>}
      <details><summary>Larch fit report</summary><pre className={styles.report}>{visible.report}</pre></details>
      <div className={styles.toolbar}>{visible.request && <button type="button" onClick={() => download("artemis-fit.json", exportBundle(visible.request!, visible, { project_id: visible.project_id, group_id: visible.group_id, group_label: visible.group_label }))}>Download fit + model JSON</button>}<button type="button" onClick={() => download("artemis-fit-report.txt", visible.report, "text/plain")}>Download report</button></div>
    </div>}
  </ViewerPanel>
}
