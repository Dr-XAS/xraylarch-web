import { decodeApiError } from "./backend-client"
import type { FeffViewerCluster } from "./feff-cluster"

export type ArtemisParameterKind = "guess" | "set" | "def"
export interface ArtemisParameter {
  name: string
  kind: ArtemisParameterKind
  value: number
  expression: string
  min: number | null
  max: number | null
}
export interface ArtemisTransform {
  fitspace: "r" | "k"
  kmin: number
  kmax: number
  kweight: number[]
  dk: number
  window: "hanning" | "kaiser" | "parzen" | "welch"
  rmin: number
  rmax: number
  dr: number
}
export interface ArtemisPathMetadata {
  reff: number
  degen: number
  nleg: number
  absorber: string
  edge: string
  geometry: { atom: string; x: number; y: number; z: number; ipot: number }[]
  /** Actual FEFF input atoms for the structure preview, saved with the model. */
  viewerCluster?: FeffViewerCluster
  /** CIF snapshot used to calculate this path; retained even if its attachment is removed. */
  sourceCif?: { sha256: string; label: string; siteIndex: number; attachmentId?: string }
  kmin: number
  kmax: number
}
export interface ArtemisInspectedPath {
  filename: string
  content: string
  metadata: ArtemisPathMetadata
}
export interface ArtemisPath extends ArtemisInspectedPath {
  id: string
  label: string
  enabled: boolean
  s02: string
  e0: string
  deltar: string
  sigma2: string
}
export interface ArtemisExample {
  amcsd_id: number
  cif_sha256: string
  feff_input: string
  paths: ArtemisInspectedPath[]
  /** Each path's S₀², ΔE₀, ΔR and σ² expressions, in the order of `paths`. */
  path_parameters?: Pick<ArtemisPath, "s02" | "e0" | "deltar" | "sigma2">[]
  parameters: ArtemisParameter[]
  transform: ArtemisTransform
  description: string
}
export interface ArtemisExampleSetup {
  projectId: string
  groupId: string
  attachmentId: string
  example: ArtemisExample
}

export function validCupriteExample(example: ArtemisExample) {
  return example.amcsd_id === 15851 && /^[0-9a-f]{64}$/.test(example.cif_sha256) &&
    Array.isArray(example.paths) && example.paths.length === 4 &&
    example.paths.every((path, index) => path.filename === `feff${String(index + 1).padStart(4, "0")}.dat`)
}
export interface ArtemisFitRequest {
  version: number
  parameters: ArtemisParameter[]
  paths: Omit<ArtemisPath, "metadata">[]
  transform: ArtemisTransform
}
export interface ArtemisFitResult {
  /** Presentation context for a project archive; the stored result retains its original identity. */
  archive?: { id: string; created: string; imported: boolean; stale: boolean; modelChanged: boolean; origin: ArtemisFitArchive["origin"] }
  /** Browser-retained request for reproducible result export; not supplied by the API. */
  request?: ArtemisFitRequest
  project_id: string
  group_id: string
  group_label: string
  version: number
  success: boolean
  message: string
  report: string
  warnings: string[]
  statistics: {
    n_varys: number; n_independent: number; n_data: number; nfev: number
    chi_square: number; reduced_chi_square: number; r_factor: number
    aic: number; bic: number; errorbars: boolean
    /** Uncertainty in chi(k) the fit was weighted by; chi-square scales with 1/epsilon_k². Fits saved before it was reported lack it. */
    epsilon_k?: number
    /** Fast backend only: rank and condition number of the column-scaled Jacobian at the solution. */
    jacobian_rank?: number; jacobian_condition?: number | null
  }
  parameters: (ArtemisParameter & { initial: number; stderr: number | null })[]
  correlations: { left: string; right: string; value: number }[]
  paths: {
    id: string; label: string; filename: string; metadata: ArtemisPathMetadata
    values?: { s02: number; e0: number; deltar: number; sigma2: number }
    sigma2_expression?: string
    /** Optimized path curves on the shared result axes; absent from older results. */
    k?: { chi: number[] }
    r?: { mag: number[]; re: number[]; im: number[] }
  }[]
  k: { x: number[]; data: number[]; model: number[]; residual: number[]; weight: number }
  r: {
    x: number[]; data_mag: number[]; model_mag: number[]; residual_mag: number[]
    data_re: number[]; model_re: number[]; residual_re: number[]
    data_im: number[]; model_im: number[]; residual_im: number[]
  }
  transform: ArtemisTransform
  /** How this fit was produced. Older saved results carry only some of these fields. */
  metadata?: {
    engine: string
    /** Fast backend only: largest absolute difference from Larch's own residual at the fitted
     *  parameters. Order 1e-13 means the two forward models are the same function. */
    engine_parity?: number
    /** Server-side seconds, the same phases for both engines: `total` is the whole fit on the
     *  server, `fit` the fit call (set-up, minimization, uncertainties, output arrays), and
     *  `optimizer` the minimization loop alone. `compile` is the fast backend's per-request JAX
     *  compilation. Fits saved before these phases existed carry only `solve`, which is not
     *  comparable between engines and is not shown. */
    seconds?: { total?: number; fit?: number; optimizer?: number; compile?: number; covariance?: number; solve?: number }
    [key: string]: unknown
  }
}

export type ArtemisParameterDraft = Omit<ArtemisParameter, "value" | "min" | "max"> & { value: string; min: string; max: string; id: string }
export type ArtemisTransformDraft = Omit<ArtemisTransform, "kmin" | "kmax" | "dk" | "rmin" | "rmax" | "dr"> &
  Record<"kmin" | "kmax" | "dk" | "rmin" | "rmax" | "dr", string>
export interface ArtemisModelDraft { parameters: ArtemisParameterDraft[]; paths: ArtemisPath[]; transform: ArtemisTransformDraft; revision: number }
export interface ArtemisFitArchive {
  id: string
  created: string
  input_sha256: string
  imported: boolean
  origin: { project_id: string; group_id: string; project_version: number; larch_version: string }
  model: ArtemisModelDraft
  result: ArtemisFitResult
}
export interface ArtemisProjectState {
  schema_version: 1
  model: ArtemisModelDraft
  history: ArtemisFitArchive[]
  current_input_sha256: string | null
}

/** Ignore the editor revision and JSON property order when comparing saved models. */
export function artemisModelKey(model: ArtemisModelDraft) {
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]))
    return value
  }
  const { revision: _revision, ...content } = model
  return JSON.stringify(sorted(content))
}

export async function artemisApi<T>(path: string, body?: unknown, signal?: AbortSignal, options?: { idempotencyKey?: string }): Promise<T> {
  const response = await fetch(`/api/backend/api/artemis${path}`, {
    signal,
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json", ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) }, body: JSON.stringify(body) }),
  })
  const data = await response.json().catch(() => undefined)
  if (!response.ok) throw decodeApiError(response.status, data)
  return data as T
}

export function validArtemisResult(result: ArtemisFitResult, projectId: string, groupId: string, version: number) {
  if (!result || result.project_id !== projectId || result.group_id !== groupId || result.version !== version) return false
  const axis = (values: number[]) => Array.isArray(values) && values.length > 1 &&
    values.every((value, i) => Number.isFinite(value) && (i === 0 || value > values[i - 1]))
  const series = (values: number[], length: number) => Array.isArray(values) && values.length === length && values.every(Number.isFinite)
  return Boolean(result.k && result.r && axis(result.k.x) && axis(result.r.x) &&
    [result.k.data, result.k.model, result.k.residual].every(values => series(values, result.k.x.length)) &&
    [result.r.data_mag, result.r.model_mag, result.r.residual_mag, result.r.data_re, result.r.model_re,
      result.r.residual_re, result.r.data_im, result.r.model_im, result.r.residual_im].every(values => series(values, result.r.x.length)))
}
