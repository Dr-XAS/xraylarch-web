"use client"

import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react"
import { type AthenaGroup } from "@/lib/athena"
import { useAthenaApi } from "@/lib/athena-context"
import { plotlyColorscale, type AthenaColormap } from "@/lib/athena-colormaps"
import { PLOT_AXIS_TITLE_FONT, PLOT_FONT } from "@/lib/plot-typography"
import { ThemedPlot as Plot } from "./themed-plot"
import type { PlotWeightResult } from "./athena-plot-weight"
import type { WaveletResult } from "./athena-wavelet"
import styles from "./athena-wavelet-viewer.module.css"

const leftMargin = 55
const rightMargin = 20
const font = { ...PLOT_FONT, color: "#52665b" }
const titleFont = { ...PLOT_AXIS_TITLE_FONT, color: "#52665b" }
const axis = (text: string) => ({
  title: { text, font: titleFont }, tickfont: font, showgrid: false, zeroline: false,
  ticks: "outside", ticklen: 4, showline: true, linecolor: "#cbd5cd",
})

type Range = { min: number; max: number }

function fitRange(min: number, max: number, domainMin: number, domainMax: number, gap: number): Range {
  const lower = Math.max(domainMin, Math.min(Math.min(min, max), domainMax - gap))
  const upper = Math.min(domainMax, Math.max(Math.max(min, max), lower + gap))
  return { min: lower, max: upper }
}

function finiteArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item))
}

function validPreview(preview: PlotWeightResult, data: WaveletResult, range: Range, version: number) {
  if (!preview || preview.project_id !== data.project_id || preview.group_id !== data.group_id ||
    preview.version !== version || preview.kweight !== data.kweight || !preview.arrays ||
    preview.effective?.kweight !== data.kweight) return false
  const { k, weighted_chi, kwin, r, chir_mag } = preview.arrays
  if (!finiteArray(k) || k.length < 2 || !finiteArray(weighted_chi) || weighted_chi.length !== k.length ||
    !finiteArray(kwin) || kwin.length !== k.length || !finiteArray(r) || r.length < 2 ||
    !finiteArray(chir_mag) || chir_mag.length !== r.length) return false
  if (![k, r].every(values => values.every((value, index) => value >= 0 && (index === 0 || value > values[index - 1]))) ||
    chir_mag.some(value => value < 0) || weighted_chi.some((value, index) => !Number.isFinite(value * kwin[index]))) return false
  return typeof preview.effective.kmin === "number" && typeof preview.effective.kmax === "number" &&
    Math.abs(preview.effective.kmin - range.min) < 1e-6 && Math.abs(preview.effective.kmax - range.max) < 1e-6
}

function MeasuredPlot({ label, className, main = false, plotKey, ...props }: ComponentProps<typeof Plot> & {
  label: string; className: string; main?: boolean; plotKey: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [failedKey, setFailedKey] = useState<string | null>(null)
  useEffect(() => {
    const measure = () => {
      const rect = ref.current?.getBoundingClientRect()
      const next = { width: Math.round(rect?.width ?? 0), height: Math.round(rect?.height ?? 0) }
      setSize(previous => previous.width === next.width && previous.height === next.height ? previous : next)
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    if (ref.current) observer?.observe(ref.current)
    window.addEventListener("resize", measure)
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure) }
  }, [])
  return <div ref={ref} className={className} aria-label={label} data-wavelet-main-plot={main || undefined}>
    {failedKey === plotKey ? <div className={styles.notice} role="alert">
      Could not render the {label.toLowerCase()}.{label === "3D wavelet surface" && " Try the 2D heatmap if 3D graphics are unavailable."}
    </div> : <Plot {...props} layout={{ ...props.layout, autosize: true,
      ...(size.width > 0 ? { width: size.width } : {}), ...(size.height > 0 ? { height: size.height } : {}),
    }} useResizeHandler style={{ width: "100%", height: "100%" }} onError={() => setFailedKey(plotKey)} />}
  </div>
}

export function WaveletFigure({ data, version = data.version, dataVersion = version, mode, colormap, group }: {
  data: WaveletResult; mode: "2d" | "3d"; colormap: AthenaColormap; group: AthenaGroup
  version?: number; dataVersion?: number
}) {
  const athenaApi = useAthenaApi()
  const sliderId = useId()
  const context = `${data.project_id}:${data.group_id}:${dataVersion}:${data.kweight}`
  const domainMin = data.k[0]
  const domainMax = data.k[data.k.length - 1]
  const effective = group.result?.effective
  const kstep = typeof effective?.kstep === "number" ? effective.kstep : group.parameters.kstep
  const dk = typeof effective?.dk === "number" ? effective.dk : group.parameters.dk
  const windowType = String(effective?.window ?? group.parameters.window).toLowerCase()
  const gap = Math.min(Math.max(2 * (kstep || 0.05), ["kaiser", "gaussian"].includes(windowType) ? 0 : dk / 2, 0.001), domainMax - domainMin)
  const initialRange = fitRange(3, 13, domainMin, domainMax, gap)
  const [selection, setSelection] = useState<{ context: string; range: Range }>({ context, range: initialRange })
  const range = selection.context === context ? selection.range : initialRange
  const [focusedHandle, setFocusedHandle] = useState<"min" | "max" | null>(null)
  const [shapeRevision, setShapeRevision] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [response, setResponse] = useState<{
    key: string; abort: AbortController; data?: PlotWeightResult; error?: string
  } | null>(null)
  const previewKey = JSON.stringify([context, range.min, range.max, attempt])
  const latest = useRef({ key: previewKey, version })
  latest.current = { key: previewKey, version }
  const current = response?.key === previewKey && !response.abort.signal.aborted ? response : null
  const maximum = useMemo(() => data.magnitude.reduce((max, row) => row.reduce((m, value) => Math.max(m, value), max), 0) || 1, [data])
  const surface = mode === "3d"

  useEffect(() => {
    if (surface) return
    if (current?.data) return () => { if (latest.current.key !== previewKey) current.abort.abort() }
    const abort = new AbortController()
    let completed = false
    const timer = window.setTimeout(async () => {
      try {
        const preview = await athenaApi<PlotWeightResult>(`/projects/${data.project_id}/groups/${data.group_id}/plot-transform`, {
          version, kweight: data.kweight, kmin: range.min, kmax: range.max,
        }, "POST", abort.signal)
        if (abort.signal.aborted || latest.current.key !== previewKey || latest.current.version !== version) return
        if (!validPreview(preview, data, range, version)) throw new Error("The Fourier preview does not match this spectrum and k range. Try again.")
        completed = true
        setResponse({ key: previewKey, abort, data: preview })
      } catch (error) {
        if (!abort.signal.aborted && latest.current.key === previewKey && latest.current.version === version) setResponse({ key: previewKey, abort,
          error: error instanceof Error ? error.message : "Could not calculate the selected k-range transform." })
      }
    }, 150)
    return () => { window.clearTimeout(timer); if (!completed || latest.current.key !== previewKey) abort.abort() }
  }, [previewKey, surface, data.project_id, data.group_id, version, data.kweight, range.min, range.max])

  function updateRange(min: number, max: number) {
    const next = fitRange(min, max, domainMin, domainMax, gap)
    setSelection(previous => previous.context === context && previous.range.min === next.min && previous.range.max === next.max
      ? previous : { context, range: next })
  }

  function moveBoundary(event: Record<string, unknown>) {
    if (!Object.keys(event).some(key => key === "shapes" || key.startsWith("shapes["))) return
    const shapes = Array.isArray(event.shapes) ? event.shapes as Array<Record<string, unknown>> : []
    const position = (index: number, fallback: number) => {
      const value = event[`shapes[${index}].x0`] ?? event[`shapes[${index}].x1`] ?? shapes[index]?.x0 ?? shapes[index]?.x1
      return typeof value === "number" && Number.isFinite(value) ? value : fallback
    }
    updateRange(position(0, range.min), position(1, range.max))
    // Force dragged lines back to their full vertical extent, including y-only drags.
    setShapeRevision(value => value + 1)
  }

  const trace = {
    type: surface ? "surface" : "heatmap", x: data.k.slice(), y: data.r.slice(), z: data.magnitude.map(row => row.slice()),
    colorscale: plotlyColorscale(colormap), ...(surface ? { cmin: 0, cmax: maximum } : { zmin: 0, zmax: maximum, zsmooth: false }),
    showscale: surface,
    colorbar: { title: { text: "|WT|", font: titleFont }, tickfont: font, thickness: 12, len: 0.6, outlinewidth: 0, xpad: 8 },
    hovertemplate: "k = %{x:.2f} Å⁻¹<br>R = %{y:.2f} Å<br>|WT| = %{z:.4g}<extra></extra>",
  }
  const baseLayout = { font, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff", showlegend: false, uirevision: context }
  const config = { responsive: true, displaylogo: false, toImageButtonOptions: { filename: `wavelet-k${data.kweight}-${mode}`, scale: 2 } }

  if (surface) return <div className={styles.viewer}>
    <MeasuredPlot label="3D wavelet surface" main className={styles.mainPlot} plotKey={`${context}:3d`} data={[trace]}
      layout={{ ...baseLayout, title: { text: `Wavelet Surface (Cauchy, k-weight = ${data.kweight})` },
        margin: { l: 0, r: 90, t: 50, b: 0 }, scene: {
          xaxis: { ...axis("k (Å⁻¹)"), mirror: true },
          yaxis: { ...axis("R (Å)"), range: [0, 6], mirror: true },
          zaxis: { ...axis("|WT|"), range: [0, maximum], mirror: true },
          camera: { eye: { x: -2, y: -1, z: 1 } },
        },
      }} config={{ ...config, modeBarButtonsToRemove: ["pan2d", "lasso2d", "select2d"] }} />
  </div>

  const percent = (value: number) => (value - domainMin) / (domainMax - domainMin) * 100
  const kLabel = data.kweight === 0 ? "χ(k)" : `k<sup>${data.kweight}</sup>χ(k)`
  const arrays = current?.data?.arrays
  const selectedIndices = arrays?.k.map((k, index) => k >= range.min && k <= range.max ? index : -1).filter(index => index >= 0) ?? []

  return <div className={styles.viewer}>
    <div className={styles.analysis}>
      <div className={styles.heatmapColumn}>
        <fieldset className={styles.range}>
          <legend className={styles.srOnly}>k range</legend>
          <div className={styles.alignedRange} style={{ marginLeft: leftMargin, marginRight: rightMargin }}>
            <span aria-hidden="true" className={styles.rangeLabel}>k</span>
            <span aria-hidden="true" className={styles.rangeUnit}>Å⁻¹</span>
            <div className={styles.track}>
              <span aria-hidden="true" className={styles.rail} />
              <span aria-hidden="true" className={styles.selectedRange} style={{ left: `${percent(range.min)}%`, right: `${100 - percent(range.max)}%` }} />
              {(["min", "max"] as const).map(handle => <span key={handle}>
                <label className={styles.srOnly} htmlFor={`${sliderId}-${handle}`}>k {handle === "min" ? "minimum" : "maximum"}</label>
                <input id={`${sliderId}-${handle}`} className={styles.rangeInput} type="range"
                  aria-label={`k ${handle === "min" ? "minimum" : "maximum"}`} aria-valuetext={`${range[handle].toFixed(2)} Å⁻¹`}
                  min={domainMin} max={domainMax} step="any" value={range[handle]}
                  onChange={event => handle === "min"
                    ? updateRange(Math.min(Number(event.target.value), range.max - gap), range.max)
                    : updateRange(range.min, Math.max(Number(event.target.value), range.min + gap))}
                  onFocus={() => setFocusedHandle(handle)} onBlur={() => setFocusedHandle(null)} />
                <span aria-hidden="true" className={`${styles.marker} ${focusedHandle === handle ? styles.focusedMarker : ""}`}
                  style={{ left: `${percent(range[handle])}%` }} />
                <output htmlFor={`${sliderId}-${handle}`} className={styles.rangeValue} style={{ left: `${percent(range[handle])}%` }}>{range[handle].toFixed(2)}</output>
              </span>)}
            </div>
          </div>
        </fieldset>
        <MeasuredPlot label="2D wavelet heatmap" main className={styles.mainPlot} plotKey={`${context}:2d`} data={[trace]}
          layout={{ ...baseLayout, title: { text: `Wavelet Transform (Cauchy, k-weight = ${data.kweight})` },
            margin: { l: leftMargin, r: rightMargin, t: 50, b: 55, autoexpand: false },
            xaxis: { ...axis("k (Å⁻¹)"), range: [domainMin, domainMax], fixedrange: true },
            yaxis: { ...axis("R (Å)"), range: [0, 6] }, editrevision: `${range.min}:${range.max}:${shapeRevision}`,
            shapes: [range.min, range.max].map(k => ({ type: "line", xref: "x", yref: "y", x0: k, x1: k, y0: 0, y1: 6,
              editable: true, line: { color: "rgba(255,255,255,0.85)", width: 1.2, dash: "dot" },
            })),
            annotations: [range.min, range.max].map((k, index) => ({ x: k, y: 5.7, xref: "x", yref: "y",
              text: `k_${index === 0 ? "min" : "max"} = ${k.toFixed(2)}`, showarrow: false, xanchor: "center",
              font: { ...font, color: "#ffffff" }, bgcolor: "rgba(30,35,40,0.45)", borderpad: 4,
            })),
          }} config={{ ...config, scrollZoom: true, editable: false, edits: { shapePosition: true } }} onRelayout={moveBoundary} />
      </div>
      <div className={styles.companions} aria-label="Selected k-range Fourier preview" aria-busy={!current}>
        {!current ? <div className={styles.notice} role="status">Calculating selected k-range transform…</div>
          : current.error ? <div className={styles.notice} role="alert"><p>{current.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>
          : arrays && <>
            <MeasuredPlot label="Windowed χ(k)" className={styles.sidePlot} plotKey={`${previewKey}:k`}
              data={[{ type: "scatter", mode: "lines", name: kLabel,
                x: selectedIndices.map(index => arrays.k[index]), y: selectedIndices.map(index => arrays.weighted_chi[index] * arrays.kwin[index]),
                line: { width: 1.5, color: "#6d28d9" }, hovertemplate: `k = %{x:.2f} Å⁻¹<br>${kLabel} = %{y:.4g}<extra></extra>`,
              }]}
              layout={{ ...baseLayout, title: { text: "Windowed χ(k)" }, margin: { l: 65, r: 20, t: 40, b: 45 },
                xaxis: { ...axis("k (Å⁻¹)"), range: [range.min, range.max] }, yaxis: axis(kLabel), uirevision: previewKey,
              }} config={{ ...config, toImageButtonOptions: { filename: `wavelet-windowed-k${data.kweight}`, scale: 2 } }} />
            <MeasuredPlot label="Fourier magnitude |χ(R)|" className={styles.sidePlot} plotKey={`${previewKey}:r`}
              data={[{ type: "scatter", mode: "lines", name: "|χ(R)|", x: arrays.r.slice(), y: arrays.chir_mag.slice(),
                line: { width: 1.5, color: "#6d28d9" }, hovertemplate: "R = %{x:.2f} Å<br>|χ(R)| = %{y:.4g}<extra></extra>",
              }]}
              layout={{ ...baseLayout, title: { text: "Fourier magnitude" }, margin: { l: 65, r: 20, t: 40, b: 45 },
                xaxis: { ...axis("R (Å)"), range: [0, 6] }, yaxis: axis("|χ(R)|"), uirevision: previewKey,
              }} config={{ ...config, toImageButtonOptions: { filename: `wavelet-fourier-k${data.kweight}`, scale: 2 } }} />
          </>}
      </div>
    </div>
    <p className={styles.hint}>Drag the k-range handles or dotted lines to update χ(k) and |χ(R)|.</p>
  </div>
}
