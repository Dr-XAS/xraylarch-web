import type { ArtemisFitArchive } from './artemis'

export type SettingValue = string | number | number[] | null
export type TransformField = 'fitspace' | 'kmin' | 'kmax' | 'kweight' | 'dk' | 'window' | 'rmin' | 'rmax' | 'dr'
export type StatisticField = 'n_varys' | 'n_independent' | 'n_data' | 'nfev' | 'chi_square' | 'reduced_chi_square' | 'r_factor' | 'aic' | 'bic' | 'epsilon_k'
export type HistoryComparisonContext = { projectId: string; projectName: string; version: number; groupId: string; groupLabel: string; currentInputSha256: string | null }
export type FitSnapshot = {
  id: string; created: string | null; imported: boolean | null; input_current: boolean | null; input_sha256: string | null
  origin: { project_id: string | null; group_id: string | null; project_version: number | null; larch_version: string | null }
  success: boolean | null; message: string | null; engine: string | null
  transform: Record<TransformField, SettingValue>
  statistics: Record<StatisticField, number | null> & { errorbars: boolean | null }
  warnings: string[]
}
export type ParameterSnapshot = { kind: 'guess' | 'set' | 'def' | null; value: number | null; initial: number | null; stderr: number | null; min: number | null; max: number | null; expression: string | null }
export type PathSnapshot = {
  id: string; label: string; filename: string | null
  reff: number | null; r: number | null; sigma2: number | null; e0: number | null; s02: number | null; degen: number | null; nleg: number | null
  distance_kind: 'single_scattering' | 'half_path_length' | 'unknown'
}
export type ParameterChange = { name: string; baseline: ParameterSnapshot | null; comparison: ParameterSnapshot | null; delta: number | null; bounds_changed: boolean; initial_changed: boolean; notes: string[] }
export type PathChange = {
  id: string; label: string; match: 'same_feff' | 'changed_feff' | 'baseline_only' | 'comparison_only' | 'unavailable'
  baseline: PathSnapshot | null; comparison: PathSnapshot | null; delta_r: number | null; delta_sigma2: number | null; notes: string[]
}
export type HistoryComparisonReport = {
  schema_version: 1; project_id: string; project_name: string; version: number; group_id: string; group_label: string
  baseline_fit_id: string; comparison_fit_id: string; baseline: FitSnapshot; comparison: FitSnapshot; same_input: boolean | null
  transform_changes: { field: TransformField; label: string; unit: string; baseline: SettingValue; comparison: SettingValue }[]
  parameter_changes: ParameterChange[]; path_changes: PathChange[]; notes: string[]
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const rows = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) : []
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const positive = (value: unknown): number | null => finite(value) !== null && Number(value) > 0 ? Number(value) : null
const nonnegative = (value: unknown): number | null => finite(value) !== null && Number(value) >= 0 ? Number(value) : null
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const flag = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null
const digest = (value: unknown): string | null => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null
const difference = (a: number | null, b: number | null) => a === null || b === null ? null : finite(b - a)
const equivalent = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const transformFields: { field: TransformField; label: string; unit: string }[] = [
  { field: 'fitspace', label: 'Fit space', unit: '' }, { field: 'kmin', label: 'k minimum', unit: 'Å⁻¹' },
  { field: 'kmax', label: 'k maximum', unit: 'Å⁻¹' }, { field: 'kweight', label: 'k weights', unit: '' },
  { field: 'dk', label: 'k taper width', unit: 'Å⁻¹' }, { field: 'window', label: 'k window', unit: '' },
  { field: 'rmin', label: 'R minimum', unit: 'Å' }, { field: 'rmax', label: 'R maximum', unit: 'Å' },
  { field: 'dr', label: 'R taper width', unit: 'Å' },
]
const statisticFields: StatisticField[] = ['n_varys', 'n_independent', 'n_data', 'nfev', 'chi_square', 'reduced_chi_square', 'r_factor', 'aic', 'bic', 'epsilon_k']

function fitSnapshot(archive: ArtemisFitArchive, currentInput: string | null): FitSnapshot {
  const source = record(archive), result = record(source.result), origin = record(source.origin)
  const savedTransform = record(result.transform), savedStatistics = record(result.statistics)
  const input = digest(source.input_sha256), current = digest(currentInput)
  const transform = Object.fromEntries(transformFields.map(({ field }) => {
    const value = savedTransform[field]
    if (field === 'kweight') return [field, Array.isArray(value) && value.length > 0 && value.length <= 4
      && value.every(item => Number.isInteger(item) && item >= 0 && item <= 3) && new Set(value).size === value.length ? [...value] : null]
    return [field, field === 'fitspace' || field === 'window' ? text(value) : finite(value)]
  })) as Record<TransformField, SettingValue>
  const statistics = Object.fromEntries(statisticFields.map(field => [field,
    field === 'aic' || field === 'bic' ? finite(savedStatistics[field]) : field === 'epsilon_k' ? positive(savedStatistics[field]) : nonnegative(savedStatistics[field]),
  ])) as Record<StatisticField, number | null>
  return {
    id: archive.id, created: text(source.created), imported: flag(source.imported), input_current: input === null || current === null ? null : input === current, input_sha256: input,
    origin: { project_id: text(origin.project_id), group_id: text(origin.group_id), project_version: nonnegative(origin.project_version), larch_version: text(origin.larch_version) },
    success: flag(result.success), message: text(result.message), engine: text(record(result.metadata).engine), transform,
    statistics: { ...statistics, errorbars: flag(savedStatistics.errorbars) },
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((value): value is string => typeof value === 'string') : [],
  }
}

function indexRows(values: unknown, key: string) {
  const result = new Map<string, RecordValue[]>()
  for (const row of rows(values)) {
    const name = text(row[key])
    if (!name?.trim()) continue
    result.set(name, [...(result.get(name) ?? []), row])
  }
  return result
}

function parameterSnapshot(row: RecordValue, errorbars: boolean | null): ParameterSnapshot {
  return {
    kind: ['guess', 'set', 'def'].includes(String(row.kind)) ? row.kind as ParameterSnapshot['kind'] : null,
    value: finite(row.value), initial: finite(row.initial), stderr: errorbars === true && (row.kind === 'guess' || row.kind === 'def') ? nonnegative(row.stderr) : null,
    min: finite(row.min), max: finite(row.max), expression: text(row.expression),
  }
}

function parameters(a: ArtemisFitArchive, b: ArtemisFitArchive, snapshots: [FitSnapshot, FitSnapshot]): ParameterChange[] {
  const left = indexRows(record(a.result).parameters, 'name'), right = indexRows(record(b.result).parameters, 'name')
  return [...new Set([...left.keys(), ...right.keys()])].map(name => {
    const aa = left.get(name) ?? [], bb = right.get(name) ?? [], notes: string[] = []
    const baseline = aa.length === 1 ? parameterSnapshot(aa[0], snapshots[0].statistics.errorbars) : null
    const comparison = bb.length === 1 ? parameterSnapshot(bb[0], snapshots[1].statistics.errorbars) : null
    const boundsChanged = !!baseline && !!comparison && (baseline.min !== comparison.min || baseline.max !== comparison.max)
    const initialChanged = !!baseline && !!comparison && baseline.initial !== null && comparison.initial !== null && baseline.initial !== comparison.initial
    let delta: number | null = null
    if (aa.length > 1 || bb.length > 1) notes.push('Repeated parameter names make this match ambiguous; no difference is calculated.')
    else if (!baseline || !comparison) notes.push('This parameter is present in only one saved result.')
    else if (baseline.kind === null || comparison.kind === null || baseline.expression === null || comparison.expression === null) notes.push('The saved parameter definition is incomplete; no difference is calculated.')
    else if (baseline.kind !== comparison.kind || baseline.expression !== comparison.expression) notes.push('The parameter kind or expression changed; the values are shown without a numerical difference.')
    else {
      delta = difference(baseline.value, comparison.value)
      if (delta === null) notes.push('Finite saved values are required to calculate a difference.')
    }
    if (boundsChanged) notes.push('The saved parameter bounds changed; the two fits used different constraints.')
    if (initialChanged) notes.push('The saved initial value changed.')
    return { name, baseline, comparison, delta, bounds_changed: boundsChanged, initial_changed: initialChanged, notes }
  })
}

function pathSnapshot(row: RecordValue): PathSnapshot {
  const metadata = record(row.metadata), values = record(row.values)
  const reff = positive(metadata.reff), deltar = finite(values.deltar), nleg = positive(metadata.nleg)
  return {
    id: String(row.id), label: text(row.label) || text(row.filename) || String(row.id), filename: text(row.filename),
    reff, r: reff === null || deltar === null ? null : finite(reff + deltar), sigma2: finite(values.sigma2),
    e0: finite(values.e0), s02: finite(values.s02), degen: positive(metadata.degen), nleg,
    distance_kind: nleg === 2 ? 'single_scattering' : nleg !== null && Number.isInteger(nleg) && nleg > 2 ? 'half_path_length' : 'unknown',
  }
}

function physicalMetadata(value: unknown) {
  const source = record(value)
  const reff = positive(source.reff), degen = positive(source.degen), nleg = positive(source.nleg)
  const kmin = nonnegative(source.kmin), kmax = positive(source.kmax), absorber = text(source.absorber), edge = text(source.edge)
  if (reff === null || degen === null || nleg === null || !Number.isInteger(nleg) || nleg < 2
    || kmin === null || kmax === null || kmax < kmin || absorber === null || edge === null
    || !Array.isArray(source.geometry) || source.geometry.length === 0) return null
  const geometry = source.geometry.map(value => {
    const atom = record(value)
    return { atom: text(atom.atom), x: finite(atom.x), y: finite(atom.y), z: finite(atom.z), ipot: nonnegative(atom.ipot) }
  })
  if (geometry.some(atom => Object.values(atom).some(value => value === null))) return null
  return { reff, degen, nleg, kmin, kmax, absorber, edge, geometry }
}

function pathSource(archive: ArtemisFitArchive, resultRow: RecordValue) {
  const matches = rows(record(archive.model).paths).filter(path => path.id === resultRow.id)
  if (matches.length !== 1 || matches[0].enabled !== true || typeof matches[0].content !== 'string' || !matches[0].content
    || typeof resultRow.filename !== 'string' || matches[0].filename !== resultRow.filename) return null
  const modelMetadata = physicalMetadata(matches[0].metadata), resultMetadata = physicalMetadata(resultRow.metadata)
  // An imported result can disagree with its model metadata even when its IDs match.
  if (modelMetadata === null || resultMetadata === null || !equivalent(modelMetadata, resultMetadata)
    || resultRow.sigma2_expression !== undefined && resultRow.sigma2_expression !== matches[0].sigma2) return null
  return matches[0]
}

function paths(a: ArtemisFitArchive, b: ArtemisFitArchive): PathChange[] {
  const left = indexRows(record(a.result).paths, 'id'), right = indexRows(record(b.result).paths, 'id')
  return [...new Set([...left.keys(), ...right.keys()])].map(id => {
    const aa = left.get(id) ?? [], bb = right.get(id) ?? [], notes: string[] = []
    const baseline = aa.length === 1 ? pathSnapshot(aa[0]) : null, comparison = bb.length === 1 ? pathSnapshot(bb[0]) : null
    let match: PathChange['match'] = 'unavailable', deltaR: number | null = null, deltaSigma2: number | null = null
    if (aa.length > 1 || bb.length > 1) notes.push('Repeated saved path IDs make this match ambiguous; no path differences are calculated.')
    else if (!baseline || !comparison) {
      match = baseline ? 'baseline_only' : 'comparison_only'
      notes.push('This path ID occurs in only one saved result. Filenames and labels are not used to infer a match.')
    } else {
      const sourceA = pathSource(a, aa[0]), sourceB = pathSource(b, bb[0])
      if (!sourceA || !sourceB) notes.push('The saved result cannot be matched to one enabled model path with consistent filename and metadata; no differences are calculated.')
      else if (sourceA.content !== sourceB.content) {
        match = 'changed_feff'
        notes.push('The FEFF file contents changed for this path ID; no path differences are calculated.')
      } else if (baseline.distance_kind === 'unknown' || comparison.distance_kind === 'unknown'
        || !equivalent(physicalMetadata(aa[0].metadata), physicalMetadata(bb[0].metadata))) {
        notes.push('Saved path geometry or metadata differ despite identical FEFF text; no differences are calculated.')
      } else {
        match = 'same_feff'
        deltaR = difference(baseline.r, comparison.r)
        deltaSigma2 = difference(baseline.sigma2, comparison.sigma2)
        if (deltaR === null || deltaSigma2 === null) notes.push('Some fitted path values are unavailable; only differences with two finite values are calculated.')
        for (const field of ['s02', 'e0', 'deltar', 'sigma2']) {
          if (sourceA[field] !== sourceB[field]) notes.push(`The path's ${field} expression changed between the saved models.`)
        }
      }
    }
    if ([baseline, comparison].some(path => path && (path.r !== null && path.r <= 0 || path.sigma2 !== null && path.sigma2 < 0 || path.s02 !== null && path.s02 < 0))) {
      notes.push('A saved path has nonpositive R or negative sigma2 or amplitude factor. Its value is preserved; inspect the model before giving it a physical interpretation.')
    }
    return { id, label: baseline?.label ?? comparison?.label ?? id, match, baseline, comparison, delta_r: deltaR, delta_sigma2: deltaSigma2, notes }
  })
}

/** Read archived scalars only. No expression, FEFF file, current draft or solver is evaluated. */
export function buildHistoryComparison(context: HistoryComparisonContext, baselineArchive: ArtemisFitArchive, comparisonArchive: ArtemisFitArchive): HistoryComparisonReport {
  if (!text(baselineArchive?.id)?.trim() || !text(comparisonArchive?.id)?.trim() || baselineArchive.id === comparisonArchive.id) throw new Error('Choose two different saved fits.')
  const baseline = fitSnapshot(baselineArchive, context.currentInputSha256), comparison = fitSnapshot(comparisonArchive, context.currentInputSha256)
  const sameInput = baseline.input_sha256 === null || comparison.input_sha256 === null ? null : baseline.input_sha256 === comparison.input_sha256
  const transformChanges = transformFields.filter(({ field }) => !equivalent(baseline.transform[field], comparison.transform[field]))
    .map(descriptor => ({ ...descriptor, baseline: baseline.transform[descriptor.field], comparison: comparison.transform[descriptor.field] }))
  const notes = [
    'This is a snapshot of two saved fits. It does not change the model, rerun a fit or evaluate archived expressions.',
    'Differences are comparison minus baseline. They describe the saved outcomes, not confidence intervals or statistical significance. Standard errors are not combined.',
    'Statistics belong to each fit and are not ranked. Changing input, transform, k weights, constraints or noise scale changes their interpretation.',
    'Saved epsilon(k) describes the first plotted k weight, not every weight in a multi-weight fit. Older archives may omit it.',
    'Parameter units are defined by the model and are not inferred from names. A matching name and definition do not establish the same physical interpretation.',
    'R is reff plus fitted deltar. For single scattering it is the absorber-scatterer distance; for multiple scattering it is half the total path length. FEFF degeneracy is not a fitted coordination number.',
  ]
  if (sameInput === false) notes.push('These fits used different processed inputs; their differences also include the input change.')
  if (sameInput === null) notes.push('An input fingerprint is unavailable; identical fit inputs cannot be confirmed.')
  if (baseline.input_current === false || comparison.input_current === false) notes.push('At least one archive differs from the current processed input. Its saved values remain available for historical comparison.')
  if (baseline.input_current === null || comparison.input_current === null) notes.push('Whether both archives match the current processed input is unknown because a fingerprint is unavailable.')
  if (baseline.imported || comparison.imported) notes.push('At least one fit is an imported archive. Original project, group and Larch provenance are retained.')
  if (baseline.engine !== comparison.engine || baseline.origin.larch_version !== comparison.origin.larch_version) notes.push('The saved engine or Larch version differs between these fits.')
  if (baseline.engine === null || comparison.engine === null) notes.push('At least one archive does not identify its fitting engine.')
  if (baseline.success !== true || comparison.success !== true) notes.push('At least one fit did not report successful convergence. Inspect its message and residual before interpreting values.')
  if (baseline.statistics.errorbars !== true || comparison.statistics.errorbars !== true) notes.push('At least one fit did not report available error bars; its parameter standard errors are shown as unavailable.')
  if (baseline.statistics.epsilon_k === null || comparison.statistics.epsilon_k === null) notes.push('A saved noise scale is unavailable; it is not reconstructed from the current data.')
  if ([baseline, comparison].some(fit => Object.values(fit.transform).some(value => value === null))) notes.push('Some archived transform settings are unavailable. Missing values do not establish identical settings.')
  if ([baselineArchive, comparisonArchive].some(archive => ['parameters', 'paths'].some(field => {
    const values = record(archive.result)[field]
    return !Array.isArray(values) || values.some(value => !text(record(value)[field === 'parameters' ? 'name' : 'id'])?.trim())
  }))) notes.push('Some saved parameter or path identities are missing. Entries without an identity cannot be included in the comparison.')
  return {
    schema_version: 1, project_id: context.projectId, project_name: context.projectName, version: context.version, group_id: context.groupId, group_label: context.groupLabel,
    baseline_fit_id: baseline.id, comparison_fit_id: comparison.id, baseline, comparison, same_input: sameInput,
    transform_changes: transformChanges, parameter_changes: parameters(baselineArchive, comparisonArchive, [baseline, comparison]),
    path_changes: paths(baselineArchive, comparisonArchive), notes,
  }
}

export function historyComparisonFilename(report: HistoryComparisonReport) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'unknown'
  return `craft-fit-comparison-${safe(report.group_id)}-v${report.version}-${safe(report.baseline_fit_id)}-${safe(report.comparison_fit_id)}.json`
}
