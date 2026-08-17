export interface ColumnInfo {
  name: string
  index: number
  numeric: boolean
  unit: string | null
  role_hint: string | null
  preview: number[]
}

export interface FieldIssue {
  code: string
  message: string
  fields: string[]
  recovery: string
}

export interface ErrorEnvelope {
  code: string
  message: string
  fields: string[]
  recovery: string
}

export interface InspectionResponse {
  upload_id: string
  display_name: string
  row_count: number
  columns: ColumnInfo[]
  warnings: string[]
  issues: FieldIssue[]
}

export interface RecipeDraft {
  e0: number | null
  step: number | null
  nnorm: number | null
  pre1: number | null
  pre2: number | null
  norm1: number | null
  norm2: number | null
  rbkg: number
  kmin: number
  kmax: number | null
  kweight: number
  autobk_dk: number | null
  autobk_window: string | null
  ft_dk: number
  ft_dk2: number | null
  ft_window: string
  nfft: number
  kstep: number
  rmax_out: number
}

export const DEFAULT_RECIPE: RecipeDraft = {
  e0: null,
  step: null,
  nnorm: null,
  pre1: null,
  pre2: null,
  norm1: null,
  norm2: null,
  rbkg: 1,
  kmin: 0,
  kmax: null,
  kweight: 2,
  autobk_dk: null,
  autobk_window: null,
  ft_dk: 1,
  ft_dk2: null,
  ft_window: "kaiser",
  nfft: 2048,
  kstep: 0.05,
  rmax_out: 10,
}

export interface EffectiveRecipe {
  e0: number
  edge_step: number
  rbkg: number
  kmin: number
  kmax: number
  kweight: number
  autobk_dk: number
  autobk_window: string
  ft_dk: number
  ft_dk2: number | null
  ft_window: string
  nfft: number
  kstep: number
  rmax_out: number
}

export type PlotId = "raw_mu" | "norm_mu" | "chi_k" | "chi_r"

export interface PlotTrace {
  id: PlotId
  label: string
  x_label: string
  y_label: string
  x_unit: string
  y_unit: string
  x: number[]
  y: number[]
}

export interface ProcessingResult {
  plots: PlotTrace[]
  effective: EffectiveRecipe
}

export interface RevisionSummary {
  revision_id: number
  kind: "mapping" | "applied"
  parent_revision_id?: number | null
  source_revision_id?: number | null
  restored_from_revision_id?: number | null
  recipe?: RecipeDraft | null
  effective?: EffectiveRecipe | null
}

export interface WorkspaceSnapshot {
  workspace_id: string
  active_revision_id: number | null
  revisions: RevisionSummary[]
  active_result: ProcessingResult | null
}

export interface MappingRequest {
  upload_id: string
  energy_column: string
  signal_column: string
}

export interface PreviewRequest {
  source_revision_id: number
  recipe: RecipeDraft
}

export interface ApplyRequest extends PreviewRequest {
  expected_parent_revision: number | null
}

export interface RestoreRequest {
  revision_id: number
  expected_parent_revision: number | null
}
