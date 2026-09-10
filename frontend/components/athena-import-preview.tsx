"use client"

import dynamic from "next/dynamic"
import { useEffect, useState } from "react"
import { athenaApi } from "@/lib/athena"
import { columnPayload, type ColumnMapping, type ColumnPreview } from "@/lib/athena-import"
import styles from "./athena-column-selection.module.css"

const Plot = dynamic(() => import("react-plotly.js").then(m => m.default), { ssr: false })
const colors = ["#16736b", "#c37b38", "#7470b0", "#467cac", "#c85a65"]

export function AthenaImportPreview({ projectId, version, uploadId, mapping, disabled = false }: {
  projectId: string; version: number; uploadId: string; mapping: ColumnMapping; disabled?: boolean
}) {
  const [paused, setPaused] = useState(false)
  const [showReference, setShowReference] = useState(true)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ key: string; value?: ColumnPreview; error?: string } | null>(null)
  const key = JSON.stringify({ projectId, version, uploadId, mapping: columnPayload(mapping) })
  const [manualKey, setManualKey] = useState("")
  useEffect(() => {
    if (disabled || (paused && manualKey !== key) || !mapping.numerator.length) return
    const controller = new AbortController()
    let current = true
    const timeout = setTimeout(() => {
      void athenaApi<ColumnPreview>(`/projects/${projectId}/preview-columns`,
        { version, upload_id: uploadId, ...columnPayload(mapping) }, "POST", controller.signal)
        .then(value => { if (current) setState({ key, value }) })
        .catch(error => { if (current) setState({ key, error: error instanceof Error ? error.message : "Column preview failed." }) })
    }, 180)
    return () => { current = false; clearTimeout(timeout); controller.abort() }
    // key contains the complete immutable request; changing any column cancels stale work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, paused, manualKey, retry, disabled])
  const isCurrent = state?.key === key
  const value = isCurrent ? state?.value : paused ? state?.value : undefined
  const error = isCurrent ? state?.error : undefined
  const traces = value?.traces.filter(t => showReference || t.role !== "reference") ?? []
  const hasReference = !!(mapping.reference_numerator && mapping.reference_denominator)
  return <section className={styles.previewPanel} aria-label="Column selection preview">
    <div className={styles.previewTools}><strong>Preview selected columns</strong>
      <label className="ath-check"><input type="checkbox" checked={paused} onChange={e => { setPaused(e.target.checked); setManualKey("") }} />Pause plotting</label>
      <button type="button" disabled={disabled || !mapping.numerator.length} onClick={() => { setManualKey(key); setRetry(n => n + 1); setState(null) }}>Replot</button>
      {hasReference && <label className="ath-check"><input type="checkbox" checked={showReference} onChange={e => setShowReference(e.target.checked)} />Plot reference</label>}
    </div>
    <p className="ath-hint">The selected detector signals before normalization or background removal.</p>
    {paused && <p role="status">Plotting paused{!isCurrent ? " — the displayed curve uses the previous column selection." : "."} Replot updates once.</p>}
    <div className={styles.plot} aria-label="Imported signal preview plot" aria-busy={!paused && !isCurrent && !!mapping.numerator.length}>
      {value ? <Plot data={traces.map((trace, index) => ({ x: trace.x.slice(), y: trace.y.slice(), name: trace.label,
        type: "scatter", mode: "lines", line: { color: trace.role === "reference" ? "#b96342" : colors[index % colors.length], dash: trace.role === "reference" ? "dash" : "solid", width: 1.8 },
        yaxis: trace.role === "reference" ? "y2" : "y", hovertemplate: "%{x:.4f}, %{y:.6g}<extra>%{fullData.name}</extra>" }))}
        layout={{ autosize: true, margin: { l: 60, r: hasReference && showReference ? 60 : 25, t: 15, b: 65 },
          paper_bgcolor: "white", plot_bgcolor: "white", font: { family: "Arial, sans-serif", size: 11, color: "#43513d" },
          xaxis: { title: { text: value.x_label }, zeroline: false }, yaxis: { title: { text: value.y_label }, zeroline: false },
          yaxis2: { title: { text: "Reference" }, overlaying: "y", side: "right", showgrid: false, zeroline: false },
          showlegend: traces.length > 1, legend: { orientation: "h", y: -0.25 },
          uirevision: key, hovermode: "closest" }}
        config={{ responsive: true, displaylogo: false, modeBarButtonsToRemove: ["select2d", "lasso2d"], toImageButtonOptions: { filename: "athena-column-preview" } }}
        style={{ width: "100%", height: "100%" }} useResizeHandler />
        : <p>{!mapping.numerator.length ? "Select at least one numerator channel to preview." : error ? "Correct the selection or use Replot to retry." : paused ? "Choose Replot to display the selected columns." : "Updating preview…"}</p>}
    </div>
    {error && <p role="alert" className="ath-error">{error}</p>}
    {value && <p className="ath-hint">{value.points.toLocaleString()} source points{value.traces.some(t => t.x.length < value.points) ? " · display preserves local minima and maxima; every point is imported." : " · all points displayed."}</p>}
    {value?.warnings.map(note => <p key={note} className="ath-warning">{note}</p>)}
  </section>
}
