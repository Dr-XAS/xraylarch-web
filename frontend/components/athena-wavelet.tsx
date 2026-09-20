"use client"

import { useEffect, useRef, useState } from "react"
import { Box, Download, Grid2X2, Waves } from "lucide-react"
import { type AthenaGroup } from "@/lib/athena"
import { useAthenaApi } from "@/lib/athena-context"
import { DEFAULT_COLORMAP, type AthenaColormap } from "@/lib/athena-colormaps"
import { WaveletFigure } from "./athena-wavelet-viewer"
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
  /** May stay stable only when a confirmed project update leaves scientific data unchanged. */
  dataVersion?: number
  kWeight: number | null
  colormap?: AthenaColormap
}

function validGrid(data: WaveletResult) {
  const axis = (values: number[]) => Array.isArray(values) && values.length >= 2 &&
    values.every((v, i) => Number.isFinite(v) && v >= 0 && (i === 0 || v > values[i - 1]))
  return axis(data.k) && axis(data.r) && Array.isArray(data.magnitude) && data.magnitude.length === data.r.length &&
    data.magnitude.every(row => Array.isArray(row) && row.length === data.k.length && row.every(v => Number.isFinite(v) && v >= 0))
}

function exportWavelet(data: WaveletResult) {
  const lines = [
    `# Cauchy wavelet; k-weight = ${data.kweight}; R is not phase corrected`,
    '# Rows: R (Å); columns: k (Å⁻¹); values: |WT|',
    ['R / k', ...data.k].join(','),
    ...data.r.map((r, i) => [r, ...data.magnitude[i]].join(',')),
  ]
  const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${data.label.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'spectrum'}-wavelet-k${data.kweight}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function AthenaWavelet({ projectId, version, dataVersion = version, group, pending = false, kWeight, colormap = DEFAULT_COLORMAP }: Props) {
  const athenaApi = useAthenaApi()
  const [mode, setMode] = useState<"2d" | "3d">("2d")
  const [retry, setRetry] = useState(0)
  const [response, setResponse] = useState<{ key: string; abort: AbortController; data?: WaveletResult; error?: string } | null>(null)
  const arrays = group?.result?.arrays
  const effectiveWeight = group?.result?.effective.kweight
  const defaultWeight = typeof effectiveWeight === "number" ? effectiveWeight : group?.parameters.kweight ?? 2
  const selectedWeight = kWeight ?? defaultWeight
  const reason = !projectId || !group ? "Select a spectrum to explore its wavelet transform."
    : pending ? "Waiting for spectrum processing…"
    : group.processing_error ? "Resolve this spectrum’s processing error to view its wavelet transform."
    : !arrays?.k?.length || arrays.k.length !== arrays.chi?.length ? "Wavelets require processed EXAFS χ(k). Select an EXAFS spectrum to begin."
    : ""
  const key = JSON.stringify([projectId, dataVersion, group?.id, selectedWeight, retry, reason])
  const latest = useRef({ key, version })
  latest.current = { key, version }
  const current = response?.key === key && !response.abort.signal.aborted && !reason ? response : null
  const groupId = group?.id

  useEffect(() => {
    if (reason || !projectId || !groupId || version === undefined) return
    // Keep completed scientific results through confirmed metadata-only updates.
    // Unfinished requests restart below with the current concurrency version.
    if (current?.data) return () => { if (latest.current.key !== key) current.abort.abort() }
    const abort = new AbortController()
    let completed = false
    const timer = window.setTimeout(async () => {
      try {
        const data = await athenaApi<WaveletResult>(`/projects/${projectId}/groups/${groupId}/wavelet`, {
          version, kweight: selectedWeight, rmax: 6,
        }, "POST", abort.signal)
        if (abort.signal.aborted || latest.current.key !== key || latest.current.version !== version) return
        if (!data || data.project_id !== projectId || data.version !== version || data.group_id !== groupId ||
          data.kweight !== selectedWeight || !validGrid(data)) throw new Error("The wavelet data does not match this spectrum. Try again.")
        completed = true
        setResponse({ key, abort, data })
      } catch (error) {
        if (!abort.signal.aborted && latest.current.key === key && latest.current.version === version) setResponse({ key, abort, error: error instanceof Error ? error.message : "Could not calculate the wavelet transform." })
      }
    }, 150)
    return () => { window.clearTimeout(timer); if (!completed || latest.current.key !== key) abort.abort() }
  }, [key, projectId, version, groupId, selectedWeight, reason])

  return <section aria-labelledby="ath-wavelet-title">
    <ResizablePlotCard className={styles.panel} storageKey={athenaWaveletHeightKey}
      plotSelector="[data-wavelet-main-plot], [data-wavelet-placeholder]" defaultHeight={430}
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
        <button type="button" disabled={!current?.data} onClick={() => current?.data && exportWavelet(current.data)}><Download size={14} />Export CSV</button>
      </div>
      <div id="athena-wavelet-viewer" className={styles.viewport}>
        {reason ? <div data-wavelet-placeholder className={styles.empty} role="status"><Waves size={30} strokeWidth={1} /><p>{reason}</p></div>
          : current?.error ? <div data-wavelet-placeholder className={styles.empty} role="alert"><p>{current.error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>
          : current?.data ? <WaveletFigure key={key} data={current.data} version={version} dataVersion={dataVersion} group={group!} mode={mode} colormap={colormap} />
          : <div data-wavelet-placeholder className={styles.empty} role="status">Calculating wavelet transform…</div>}
      </div>
      <footer className={styles.footer}><span>Cauchy wavelet · |WT|{current?.data && ` · k-weight ${current.data.kweight}`}</span><span>R is not phase corrected</span></footer>
    </ResizablePlotCard>
  </section>
}
