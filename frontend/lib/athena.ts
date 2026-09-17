import type { ArtemisStructureAttachment } from "./artemis-structures"
import { backendUrl } from "./app-url"
import { createAthenaTransport, type AthenaSession } from "./athena-transport"

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
  id: string; label: string; energy: number[]; mu: number[]; data_type: "mu" | "xanes" | "norm" | "chi" | "xmudat" | "detector"
  marked: boolean; frozen: boolean; multiplier: number; offset: number; notes: string
  reference_id: string | null; parameters: Parameters; result: AthenaResult | null
  background_standard_id?: string | null
  is_difference?: boolean
  is_normalized?: boolean
  processing_error: string | null; source: Record<string, unknown>
}
export function dataTypeLabel(group: AthenaGroup) {
  if (group.data_type === 'xanes' && group.is_normalized) return 'Normalized XANES'
  return { mu: 'μ(E)', xanes: 'XANES', norm: 'Normalized μ(E)', chi: 'χ(k)', xmudat: 'FEFF μ(E)', detector: 'Detector signal' }[group.data_type]
}
export function measurementModeLabel(group: AthenaGroup): "trans" | "fluo" | null {
  const mapping = group.source.mapping
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return null
  const mode = (mapping as Record<string, unknown>).mode
  return mode === "transmission" ? "trans" : mode === "fluorescence" ? "fluo" : null
}
export function isDifferenceGroup(group: AthenaGroup) {
  return group.is_difference ?? (group.source.operation === "difference")
}
export function savedMergeSpace(group: AthenaGroup):'mu'|'norm'|'chi'|null {
  const source=group.source, native=source.native as {args?:{is_merge?:unknown}}|undefined
  const merge=source.merge as {details?:{method?:unknown;array?:unknown}}|undefined
  if(merge?.details?.method==='demeter-larch'&&['mu','norm','chi'].includes(String(merge.details.array)))return merge.details.array as 'mu'|'norm'|'chi'
  if(['e','n','k'].includes(String(native?.args?.is_merge)))return ({e:'mu',n:'norm',k:'chi'} as const)[native!.args!.is_merge as 'e'|'n'|'k']
  if(source.operation==='merge'&&Array.isArray(source.stddev))return ['mu','norm','chi'].includes(String(source.array))?source.array as 'mu'|'norm'|'chi':group.data_type==='chi'?'chi':'mu'
  return null
}
export const hasSavedMerge=(group:AthenaGroup)=>savedMergeSpace(group)!==null
export function rebinUnavailable(group: AthenaGroup): string | null {
  if (group.data_type === 'detector') return 'Three-region rebinning needs an absorption edge; correct the detector data type first.'
  if (group.data_type === 'chi') return 'Three-region rebinning requires energy data, not χ(k).'
  const native = group.source.native as { args?: { rebinned?: unknown } } | undefined
  if (group.source.rebin || group.source.operation === 'rebin' || ['1', 'true'].includes(String(native?.args?.rebinned).toLowerCase())) {
    return 'This group is already rebinned. Choose its original source to change the grid.'
  }
  return null
}
export type E0Method = "derivative" | "atomic" | "fraction" | "zero_crossing" | "white_line" | "manual"
export type EdgePair = Readonly<{ element: string; edge: string }>
export type EdgeIdentity = EdgePair & { readonly origin?: "native" | "enforced" | "inferred" | "selected" }
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
export type DifferenceForm = "xmu" | "norm" | "der" | "nder" | "sec" | "nsec"
export interface DifferenceOptions {
  standard_id: string; form: DifferenceForm; multiplier: number; invert: boolean
  integrate: boolean; xmin: number; xmax: number; renormalize: boolean
  name_template: string; plot_inputs: boolean; plot_space: "E" | "k"
}
export interface DifferenceInputK {
  role: "DATA" | "STANDARD"; group_id: string; label: string
  k: number[]; weighted_chi: number[]; kweight: number | null; error: string | null
}
export interface DifferenceResult {
  group_id: string; label: string; energy: number[]; difference: number[]
  data: number[]; standard: number[]; form: DifferenceForm; data_form: string; standard_form: string
  area: number | null; e0: number | null
  integration: null | { xmin: number; xmax: number; lower: number; upper: number; converged: boolean; iterations: number }
  warnings: string[]; y_label: string; area_label: string
  extrapolated_points: number
  k: number[]; weighted_chi: number[]; kweight: number | null; k_error: string | null
  input_k?: DifferenceInputK[]
}
export interface DifferencePreview { version: number; options: DifferenceOptions; results: DifferenceResult[] }
export interface DifferenceSavedResult { group_id: string; source_group_id: string; label: string; area: number | null }
export interface RebinPreview {
  version: number; options: Record<string, unknown>; skipped_reasons: Record<string, string>
  results: {
    source_group_id: string; label: string; kweight: number; processing_error: string | null; errors: string[]
    details: { e0: number; emin: number; emax: number; source_points: number; output_points: number; width: number; warnings: string[] }
    traces: { id: string; role: 'original' | 'rebinned'; label: string; x: number[]; y: number[] }[]
  }[]
}
export interface AthenaProject {
  artemis_structures?: ArtemisStructureAttachment[]
  import_preferences_warning?: string
  id: string; name: string; version: number; groups: AthenaGroup[]; journal: string
  /** Project version in which each group last changed, keyed by group id. */
  group_versions?: Record<string, number>
  updated: string; undo: string[]; redo: string[]; history: { time: string; message: string }[]
  analyses?: Analysis[]
  last_operation?: { action: string; warnings?: string[]; skipped_group_ids: string[]; skipped_reasons?: Record<string, string>; e0_results?: E0SelectionResult[]; difference_results?: DifferenceSavedResult[]; rebin_results?: Omit<DifferenceSavedResult, 'area'>[]; datatype_results?: { group_id: string; label: string; previous_type: string; data_type: string; is_normalized: boolean }[]; processing_errors?: Record<string, string> }
}
export interface Analysis {
  id?: string; created?: string
  kind: string; project_version: number; group_ids: string[]; options: Record<string, unknown>
  result: Record<string, unknown>
}
export const apiBase = backendUrl("/api/athena")
export function athenaClient(session: AthenaSession = { mode: "legacy" }) {
  const transport = createAthenaTransport(session)
  return <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> => transport.api<T>(`/api/athena${path}`, {
    signal,
    method: method ?? (body === undefined ? "GET" : "POST"),
    ...(body instanceof FormData ? { body } : body !== undefined ? {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    } : {}),
  })
}
export function athenaApi<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  return athenaClient()<T>(path, body, method, signal)
}
export function athenaTransport() { return createAthenaTransport({ mode: "legacy" }) }
export function athenaDownload(path: string, filename?: string) { return athenaTransport().download(`/api/athena${path}`, filename) }
export const resources = [
  { title: "Athena users’ guide", author: "Bruce Ravel", kind: "Manual", url: "https://bruceravel.github.io/demeter/documents/Athena/index.html", description: "The reference for Athena’s processing, plotting, and analysis tools." },
  { title: "Basic data processing", author: "Bruce Ravel", kind: "Tutorial", url: "https://bruceravel.github.io/demeter/documents/Athena/examples/data.html", description: "Follow an iron-foil example through calibration, alignment, merging, and EXAFS." },
  { title: "EXAFS & XANES with Athena", author: "Bruce Ravel · IXAS video collection", kind: "YouTube course", url: "https://www.youtube.com/playlist?list=PLyzX_pouV65vbohf_puwlg9fGNjJGpKpd", description: "A collection of lectures and demonstrations linked by the International X-ray Absorption Society." },
  { title: "Athena: Fe–S dataset, part 1", author: "Shelly Kelly", kind: "YouTube", url: "https://www.youtube.com/watch?v=xWq-8OCxXEE", description: "A practical Athena demonstration using iron–sulfur data." },
  { title: "Athena: Fe–S dataset, part 2", author: "Shelly Kelly", kind: "YouTube", url: "https://www.youtube.com/watch?v=nBm19RncBu0", description: "Continue the Fe–S analysis demonstration." },
  { title: "XAS education & example data", author: "Bruce Ravel", kind: "Examples", url: "https://bruceravel.github.io/XAS-Education/", description: "Teaching materials and datasets to practice with." },
]
