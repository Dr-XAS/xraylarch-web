"use client"

import { useEffect, useRef, useState } from "react"
import { artemisApi, type ArtemisParameter, type ArtemisPath, type ArtemisPathMetadata, type ArtemisTransform } from "./artemis"

/** The model the preview endpoint takes: no fit, no measured spectrum, no version. */
export interface ArtemisPreviewRequest {
  parameters: ArtemisParameter[]
  paths: Omit<ArtemisPath, "metadata">[]
  transform: ArtemisTransform
}
/** How large a path is, in the two places a user judges it. */
export interface ArtemisPathMetrics {
  /** Tallest |χ(R)| of this path alone, in Å⁻ⁿ⁻¹ for plot k-weight n. */
  amplitude: number
  /** R at that peak, in Å; not phase corrected, so below the true distance. */
  r_at_amplitude: number
  /** |χ(R)| integrated over the fit R range: what the fit actually sees. */
  window_area: number
  /** Tallest weighted |χ(k)| inside the fit k range. */
  chi_k_peak: number
}
export interface ArtemisPreviewPath {
  id: string
  label: string
  filename: string
  metadata: ArtemisPathMetadata
  values: { s02: number; e0: number; deltar: number; sigma2: number }
  k: { chi: number[] }
  r: { mag: number[]; re: number[]; im: number[] }
  metrics: ArtemisPathMetrics
}
export interface ArtemisPreview {
  paths: ArtemisPreviewPath[]
  warnings: string[]
  transform: ArtemisTransform
  k: { x: number[]; weight: number; total: number[] }
  r: { x: number[]; total_mag: number[]; total_re: number[]; total_im: number[] }
  metadata: { engine: string; kstep: number; nfft: number; rwindow: string; note: string; metrics: string }
}

/** Reject curves that do not describe the model that was sent, rather than plotting them. */
export function validArtemisPreview(preview: ArtemisPreview, request: Partial<Omit<ArtemisPreviewRequest, "paths">> & { paths: readonly Pick<ArtemisPath, "id" | "enabled">[] }) {
  const series = (values: number[], length: number) => Array.isArray(values) && values.length === length && values.every(Number.isFinite)
  const axis = (values: number[]) => Array.isArray(values) && values.length > 1 &&
    values.every((value, i) => Number.isFinite(value) && (i === 0 || value > values[i - 1]))
  if (!preview?.k || !preview?.r || !Array.isArray(preview.paths) || !axis(preview.k.x) || !axis(preview.r.x)) return false
  if (preview.paths.map(path => path.id).join("\u0000") !== request.paths.filter(path => path.enabled).map(path => path.id).join("\u0000")) return false
  return series(preview.k.total, preview.k.x.length) &&
    [preview.r.total_mag, preview.r.total_re, preview.r.total_im].every(values => series(values, preview.r.x.length)) &&
    preview.paths.every(path => series(path.k?.chi, preview.k.x.length) &&
      [path.r?.mag, path.r?.re, path.r?.im].every(values => series(values, preview.r.x.length)) &&
      Object.values(path.metrics ?? {}).every(Number.isFinite))
}

/** One row of the path list: what is known from the FEFF header, plus the
 *  preview metrics once they exist. */
export interface PathRow {
  id: string
  filename: string
  label: string
  enabled: boolean
  metadata: Pick<ArtemisPathMetadata, "reff" | "degen" | "nleg">
  metrics?: ArtemisPathMetrics
}
export type PathSortKey = "model" | "reff" | "amplitude" | "legs" | "degen"
export interface PathFilter {
  /** "single" keeps two-leg paths, "multiple" keeps three legs or more. */
  legs: "all" | "single" | "multiple"
  /** Drop paths whose Reff exceeds this, in Å. */
  reffMax: number | null
  /** Drop paths peaking below this fraction of the tallest |χ(R)|. */
  minAmplitude: number
}
export const ALL_PATHS: PathFilter = { legs: "all", reffMax: null, minAmplitude: 0 }

export function filterPathRows(rows: readonly PathRow[], filter: PathFilter): PathRow[] {
  const tallest = Math.max(0, ...rows.map(row => row.metrics?.amplitude ?? 0))
  return rows.filter(row => {
    if (filter.legs === "single" && row.metadata.nleg !== 2) return false
    if (filter.legs === "multiple" && row.metadata.nleg < 3) return false
    if (filter.reffMax !== null && row.metadata.reff > filter.reffMax) return false
    // Amplitude is unknown until the curves are computed; a path is never hidden
    // for a size nobody has measured yet.
    if (filter.minAmplitude > 0 && tallest > 0 && row.metrics) return row.metrics.amplitude >= filter.minAmplitude * tallest
    return true
  })
}

/** Sort stably, keeping paths without preview metrics in model order at the end. */
export function sortPathRows(rows: readonly PathRow[], key: PathSortKey, descending: boolean): PathRow[] {
  if (key === "model") return rows.slice()
  const rank = (row: PathRow) => key === "reff" ? row.metadata.reff : key === "legs" ? row.metadata.nleg
    : key === "degen" ? row.metadata.degen : row.metrics?.amplitude
  return rows.map((row, index) => ({ row, index, rank: rank(row) }))
    .sort((left, right) => {
      if (left.rank === undefined || right.rank === undefined) return (left.rank === undefined ? 1 : 0) - (right.rank === undefined ? 1 : 0) || left.index - right.index
      return (descending ? right.rank - left.rank : left.rank - right.rank) || left.index - right.index
    })
    .map(entry => entry.row)
}

/** Identify a request cheaply. FEFF contents are large and change only when the
 *  editor replaces a file, which also gives that path a new id, so the content
 *  enters the key by length alone. */
export function previewRequestKey(request: ArtemisPreviewRequest | null) {
  if (!request) return ""
  return JSON.stringify([request.parameters, request.transform, request.paths.map(path =>
    [path.id, path.filename, path.enabled, path.s02, path.e0, path.deltar, path.sigma2, path.content.length])])
}

export interface ArtemisPreviewState { preview: ArtemisPreview | null; loading: boolean; error: string; retry: () => void }

/** Ask the server what each enabled path contributes at the model's starting values. */
export function useArtemisPathPreview(request: ArtemisPreviewRequest | null, enabled: boolean): ArtemisPreviewState {
  const latest = useRef(request)
  latest.current = request
  const key = previewRequestKey(request)
  const runnable = enabled && !!request?.paths.some(path => path.enabled)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; attempt: number; preview?: ArtemisPreview; error?: string } | null>(null)
  useEffect(() => {
    const current = latest.current
    if (!runnable || !current) return
    const abort = new AbortController()
    const body = { parameters: current.parameters, paths: current.paths, transform: current.transform }
    artemisApi<ArtemisPreview>("/paths/preview", body, abort.signal)
      .then(preview => {
        if (abort.signal.aborted) return
        if (!validArtemisPreview(preview, current)) throw new Error("The server returned path curves that do not match this model. Try again.")
        setState({ key, attempt, preview })
      })
      .catch(error => {
        if (!abort.signal.aborted) setState({ key, attempt, error: error instanceof Error ? error.message : "The path preview failed." })
      })
    return () => abort.abort()
  }, [key, attempt, runnable])
  const current = runnable && state?.key === key && state.attempt === attempt ? state : null
  return { preview: current?.preview ?? null, error: current?.error ?? "", loading: runnable && !current,
    retry: () => setAttempt(value => value + 1) }
}
