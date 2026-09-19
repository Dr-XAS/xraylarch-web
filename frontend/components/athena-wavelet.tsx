"use client"

import { ThemedPlot as Plot } from "./themed-plot"
import { useEffect, useRef, useState } from "react"
import { Box, Grid2X2, Waves } from "lucide-react"
import { type AthenaGroup } from "@/lib/athena"
import { useAthenaApi } from "@/lib/athena-context"
import { DEFAULT_COLORMAP, plotlyColorscale, type AthenaColormap } from "@/lib/athena-colormaps"
import { ResizablePlotCard } from "./athena-plot-card"
import styles from "./athena-wavelet.module.css"

export const athenaWaveletHeightKey = "athena.wavelet.height.v1"

export interface WaveletResult {
  project_id: string; version: number; group_id: string; label: string; kweight: number
  k: number[]; r: number[]; magnitude: number[][]
  metadata: Record<string, unknown>
}

interface Props {
  projectId?: string; version?: number; group?: AthenaGroup; pending?: boolean
  kWeight: number | null
  colormap?: AthenaColormap
  reverseColormap?: boolean
}

function validGrid(data: WaveletResult) {
  const axis = (values: number[]) => Array.isArray(values) && values.length >= 2 &&
    values.every((v, i) => Number.isFinite(v) && v >= 0 && (i === 0 || v > values[i - 1]))
  return axis(data.k) && axis(data.r) && Array.isArray(data.magnitude) && data.magnitude.length === data.r.length &&
    data.magnitude.every(row => Array.isArray(row) && row.length === data.k.length && row.every(v => Number.isFinite(v) && v >= 0))
}

function WaveletFigure({ data, mode, colormap, reverseColormap }: { data: WaveletResult; mode: "2d" | "3d"; colormap: AthenaColormap; reverseColormap: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [error, setError] = useState(false)
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

  // Canvas/WebGL text needs a concrete font family, as in Dr.XAS's wavelet viewer.
  const font = { family: "Arial, Helvetica, sans-serif", size: 12, color: "#52665b" }
  const maximum = data.magnitude.reduce((max, row) => row.reduce((m, v) => Math.max(m, v), max), 0) || 1
  const surface = mode === "3d"
  const axis = (text: string) => ({ title: { text, font }, tickfont: font, gridcolor: "#e6ece4", zeroline: false })
  const context = `${data.project_id}:${data.group_id}:${data.version}:${data.kweight}:${mode}`
  return <div ref={ref} className={styles.figure} aria-label={surface ? "3D wavelet surface" : "2D wavelet heatmap"}>
    {error ? <div className={styles.empty} role="alert">Could not render the wavelet plot.{surface && " Try the 2D heatmap if 3D graphics are unavailable."}</div> : <Plot
      data={[{
        type: surface ? "surface" : "heatmap", x: data.k.slice(), y: data.r.slice(), z: data.magnitude.map(row => row.slice()),
        colorscale: plotlyColorscale(colormap, reverseColormap), ...(surface ? { cmin: 0, cmax: maximum } : { zmin: 0, zmax: maximum, zsmooth: false }),
        colorbar: { title: { text: "|WT|", font }, tickfont: font, thickness: 12, len: 0.78, outlinewidth: 0, xpad: 8 },
        hovertemplate: "k = %{x:.2f} Å⁻¹<br>R = %{y:.2f} Å<br>|WT| = %{z:.4g}<extra></extra>",
      }]}
      layout={{
        autosize: true, ...(size.width > 0 ? { width: size.width } : {}), ...(size.height > 0 ? { height: size.height } : {}),
        font, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
        margin: surface ? { l: 12, r: 80, t: 20, b: 24 } : { l: 60, r: 80, t: 25, b: 55 },
        xaxis: { ...axis("k (Å⁻¹)"), range: [data.k[0], data.k[data.k.length - 1]], constrain: "domain" },
        yaxis: { ...axis("R (Å)"), range: [0, 6] },
        scene: {
          xaxis: axis("k (Å⁻¹)"), yaxis: { ...axis("R (Å)"), range: [0, 6] },
          zaxis: { ...axis("|WT|"), range: [0, maximum] },
          camera: { eye: { x: -1.7, y: -1.4, z: 1.2 } }, aspectratio: { x: 1.35, y: 1, z: 0.7 },
        }, showlegend: false, uirevision: context,
      }}
      config={{ responsive: true, displaylogo: false, toImageButtonOptions: { filename: `wavelet-k${data.kweight}-${mode}`, scale: 2 } }}
      useResizeHandler style={{ width: "100%", height: "100%" }} onError={() => setError(true)}
    />}
  </div>
}

export function AthenaWavelet({ projectId, version, group, pending = false, kWeight, colormap = DEFAULT_COLORMAP, reverseColormap = false }: Props) {
  const athenaApi = useAthenaApi()
  const [mode, setMode] = useState<"2d" | "3d">("2d")
  const [retry, setRetry] = useState(0)
  const [response, setResponse] = useState<{ key: string; data?: WaveletResult; error?: string } | null>(null)
  const arrays = group?.result?.arrays
  const effectiveWeight = group?.result?.effective.kweight
  const defaultWeight = typeof effectiveWeight === "number" ? effectiveWeight : group?.parameters.kweight ?? 2
  const selectedWeight = kWeight ?? defaultWeight
  const reason = !projectId || !group ? "Select a spectrum to explore its wavelet transform."
    : pending ? "Waiting for spectrum processing…"
    : group.processing_error ? "Resolve this spectrum’s processing error to view its wavelet transform."
    : !arrays?.k?.length || arrays.k.length !== arrays.chi?.length ? "Wavelets require processed EXAFS χ(k). Select an EXAFS spectrum to begin."
    : ""
  const key = JSON.stringify([projectId, version, group?.id, selectedWeight, retry, reason])
  const current = response?.key === key && !reason ? response : null
  const groupId = group?.id

  useEffect(() => {
    if (reason || !projectId || !groupId || version === undefined) return
    const abort = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const data = await athenaApi<WaveletResult>(`/projects/${projectId}/groups/${groupId}/wavelet`, {
          version, kweight: selectedWeight, rmax: 6,
        }, "POST", abort.signal)
        if (abort.signal.aborted) return
        if (!data || data.project_id !== projectId || data.version !== version || data.group_id !== groupId ||
          data.kweight !== selectedWeight || !validGrid(data)) throw new Error("The wavelet data does not match this spectrum. Try again.")
        setResponse({ key, data })
      } catch (error) {
        if (!abort.signal.aborted) setResponse({ key, error: error instanceof Error ? error.message : "Could not calculate the wavelet transform." })
      }
    }, 150)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [key, projectId, version, groupId, selectedWeight, reason])

  return <section aria-labelledby="ath-wavelet-title">
    <ResizablePlotCard className={styles.panel} storageKey={athenaWaveletHeightKey}
      plotSelector="#athena-wavelet-viewer" defaultHeight={430}
      resizeLabel="Resize wavelet plot height" controlsId="athena-wavelet-viewer">
      <header className={styles.heading}>
        <h3 id="ath-wavelet-title"><Waves size={17} />Wavelet plotter</h3>
        <div className={styles.modes} role="group" aria-label="Wavelet view">
          <button type="button" aria-pressed={mode === "2d"} onClick={() => setMode("2d")}><Grid2X2 size={14} />2D heatmap</button>
          <button type="button" aria-pressed={mode === "3d"} onClick={() => setMode("3d")}><Box size={14} />3D surface</button>
        </div>
      </header>
      <div className={styles.controls}>
        <span className={styles.group} title={group?.label}><span>Current spectrum</span><strong>{group?.label ?? "None selected"}</strong></span>
      </div>
      <div id="athena-wavelet-viewer" className={styles.viewport}>
        {reason ? <div className={styles.empty} role="status"><Waves size={30} strokeWidth={1} /><p>{reason}</p></div>
          : current?.error ? <div className={styles.empty} role="alert"><p>{current.error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>
          : current?.data ? <WaveletFigure key={`${key}:${mode}`} data={current.data} mode={mode} colormap={colormap} reverseColormap={reverseColormap} />
          : <div className={styles.empty} role="status">Calculating wavelet transform…</div>}
      </div>
      <footer className={styles.footer}><span>Cauchy wavelet · |WT|{current?.data && ` · k-weight ${current.data.kweight}`}</span><span>R is not phase corrected</span></footer>
    </ResizablePlotCard>
  </section>
}
