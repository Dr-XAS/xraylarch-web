import { decodeApiError } from "./backend-client"

export type Parameters = {
  e0: number | null; step: number | null; pre1: number | null; pre2: number | null
  norm1: number | null; norm2: number | null; nnorm: number | null; flatten: boolean
  rbkg: number; bkg_kmin: number; bkg_kmax: number | null; bkg_kweight: number
  bkg_dk?: number; bkg_window?: string; nclamp?: number; fnorm?: boolean
  clamp_lo: number; clamp_hi: number; kmin: number; kmax: number | null; kweight: number
  dk: number; window: string; rmin: number; rmax: number; dr: number; rwindow: string
  energy_shift: number; nfft: number; kstep: number
}
export interface AthenaResult {
  arrays: Record<string, number[]>
  effective: Record<string, number | string | boolean | null>
  warnings: string[]
}
export interface AthenaGroup {
  id: string; label: string; energy: number[]; mu: number[]; data_type: "mu" | "xanes" | "norm" | "chi"
  marked: boolean; frozen: boolean; multiplier: number; offset: number; notes: string
  reference_id: string | null; parameters: Parameters; result: AthenaResult | null
  background_standard_id?: string | null
  processing_error: string | null; source: Record<string, unknown>
}
export type E0Method = "derivative" | "atomic" | "fraction" | "zero_crossing" | "white_line" | "manual"
export type EdgePolicy = Readonly<{ element: string; edge: string; fraction: number }>
export interface EdgeCatalog { element: string; edges: { edge: string; energy: number }[] }
export type E0Options =
  | { method: "derivative" | "zero_crossing" | "white_line" }
  | { method: "atomic"; element?: string; edge?: string }
  | { method: "fraction"; fraction: number }
  | { method: "manual"; value: number }
export interface E0SelectionResult {
  group_id: string; method: E0Method; e0: number; seed_e0: number | null
  element: string | null; edge: string | null; tabulated_e0: number | null
  iterations: number; converged: boolean; warnings: string[]
}
export interface AthenaProject {
  id: string; name: string; version: number; groups: AthenaGroup[]; journal: string
  updated: string; undo: string[]; redo: string[]; history: { time: string; message: string }[]
  analyses?: Analysis[]
  last_operation?: { action: string; skipped_group_ids: string[]; skipped_reasons?: Record<string, string>; e0_results?: E0SelectionResult[] }
}
export interface Analysis {
  id?: string; created?: string
  kind: string; project_version: number; group_ids: string[]; options: Record<string, unknown>
  result: Record<string, unknown>
}
export const apiBase = "/api/backend/api/athena"
export async function athenaApi<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(apiBase + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    ...(body instanceof FormData ? { body } : body !== undefined ? {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    } : {}),
  })
  const data = await response.json().catch(() => undefined)
  if (!response.ok) throw decodeApiError(response.status, data)
  return data as T
}

export const resources = [
  { title: "Athena users’ guide", author: "Bruce Ravel", kind: "Manual", url: "https://bruceravel.github.io/demeter/documents/Athena/index.html", description: "The reference for Athena’s processing, plotting, and analysis tools." },
  { title: "Basic data processing", author: "Bruce Ravel", kind: "Tutorial", url: "https://bruceravel.github.io/demeter/documents/Athena/examples/data.html", description: "Follow an iron-foil example through calibration, alignment, merging, and EXAFS." },
  { title: "EXAFS & XANES with Athena", author: "Bruce Ravel · IXAS video collection", kind: "YouTube course", url: "https://www.youtube.com/playlist?list=PLyzX_pouV65vbohf_puwlg9fGNjJGpKpd", description: "A collection of lectures and demonstrations linked by the International X-ray Absorption Society." },
  { title: "Athena: Fe–S dataset, part 1", author: "Shelly Kelly", kind: "YouTube", url: "https://www.youtube.com/watch?v=xWq-8OCxXEE", description: "A practical Athena demonstration using iron–sulfur data." },
  { title: "Athena: Fe–S dataset, part 2", author: "Shelly Kelly", kind: "YouTube", url: "https://www.youtube.com/watch?v=nBm19RncBu0", description: "Continue the Fe–S analysis demonstration." },
  { title: "XAS education & example data", author: "Bruce Ravel", kind: "Examples", url: "https://bruceravel.github.io/XAS-Education/", description: "Teaching materials and datasets to practice with." },
]
