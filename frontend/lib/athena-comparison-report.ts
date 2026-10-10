import type { AthenaProject } from './athena'

export type ComparisonScope = 'all' | 'marked'
export type ComparisonMetric = 'energy_shift' | 'xanes' | 'chi_amplitude' | 'e0_difference' | 'edge_step_ratio'
type Range = [number, number]
type Identity = { id: string; label: string; data_type: string; axis: 'energy' | 'k'; range: Range | null; points: number; processing_error: string | null }
export type ComparisonReference = Identity & { e0: number | null; edge_step: number | null; exafs: boolean; available_kmax: number | null }
export type ComparisonGroup = Identity & {
  common_range: Range | null
  e0_difference: number | null
  edge_step_ratio: number | null
  energy_shift: { value: number; stderr: number | null; range: Range } | null
  xanes: { max_difference: number; range: Range; points: number } | null
  chi_amplitude: { kweight: number; range: Range; bins: { k: Range; ratio: number }[] } | null
  duplicate_inputs: { id: string; label: string }[]
  unavailable: Partial<Record<ComparisonMetric, string>>
  notes: string[]
}
export type ComparisonReport = {
  project_id: string
  project_name: string
  version: number
  reference_id: string
  scope: ComparisonScope
  reference: ComparisonReference
  groups: ComparisonGroup[]
  notes: string[]
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const range = (value: unknown): value is Range => Array.isArray(value) && value.length === 2 && value.every(finite) && value[0] < value[1]
const nullableRange = (value: unknown) => value === null || range(value)
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const metrics: ComparisonMetric[] = ['energy_shift', 'xanes', 'chi_amplitude', 'e0_difference', 'edge_step_ratio']

export function comparisonTargets(project: AthenaProject, referenceId: string, scope: ComparisonScope) {
  return project.groups.filter(group => group.id !== referenceId && (scope === 'all' || group.marked))
}

export function comparisonGroupLabel(project: AthenaProject, id: string) {
  const index = project.groups.findIndex(group => group.id === id), group = project.groups[index]
  if (!group) return id
  return project.groups.filter(other => other.label === group.label).length > 1 ? `${group.label} · group ${index + 1}` : group.label
}

export function confirmedComparisonReport(data: unknown, project: AthenaProject, referenceId: string, scope: ComparisonScope): data is ComparisonReport {
  const all = new Map(project.groups.map(group => [group.id, group]))
  const expectedReference = all.get(referenceId)
  const identity = (value: unknown, id: string): value is Record<string, unknown> => {
    const expected = all.get(id)
    return !!expected && record(value) && value.id === id && value.label === expected.label && value.data_type === expected.data_type
      && value.axis === (expected.data_type === 'chi' ? 'k' : 'energy') && nullableRange(value.range) && count(value.points)
      && (value.processing_error === null || typeof value.processing_error === 'string')
  }
  if (!expectedReference || !record(data) || data.project_id !== project.id || data.project_name !== project.name
    || data.version !== project.version || data.reference_id !== referenceId || data.scope !== scope || !strings(data.notes)
    || !identity(data.reference, referenceId) || !nullableNumber(data.reference.e0) || !nullableNumber(data.reference.edge_step)
    || !nullableNumber(data.reference.available_kmax) || typeof data.reference.exafs !== 'boolean' || !Array.isArray(data.groups)) return false
  const targets = comparisonTargets(project, referenceId, scope)
  if (data.groups.length !== targets.length) return false
  for (const [index, value] of data.groups.entries()) {
    if (!identity(value, targets[index].id) || !record(value.unavailable)) return false
    const unavailable = value.unavailable
    if (!nullableRange(value.common_range) || !nullableNumber(value.e0_difference)
      || !nullableNumber(value.edge_step_ratio) || !strings(value.notes)
      || Object.entries(unavailable).some(([key, reason]) => !metrics.includes(key as ComparisonMetric) || typeof reason !== 'string' || !reason.trim())
      || metrics.some(key => value[key] === null ? !unavailable[key] : unavailable[key] !== undefined)
      || !(value.energy_shift === null || (record(value.energy_shift) && finite(value.energy_shift.value)
        && nullableNumber(value.energy_shift.stderr) && (value.energy_shift.stderr === null || Number(value.energy_shift.stderr) >= 0) && range(value.energy_shift.range)))
      || !(value.xanes === null || (record(value.xanes) && finite(value.xanes.max_difference) && value.xanes.max_difference >= 0
        && range(value.xanes.range) && count(value.xanes.points) && Number(value.xanes.points) >= 3))
      || !(value.chi_amplitude === null || (record(value.chi_amplitude) && finite(value.chi_amplitude.kweight)
        && range(value.chi_amplitude.range) && Array.isArray(value.chi_amplitude.bins) && value.chi_amplitude.bins.length > 0
        && value.chi_amplitude.bins.every(bin => record(bin) && range(bin.k) && finite(bin.ratio) && bin.ratio >= 0
          && bin.k[0] >= (value.chi_amplitude as { range: Range }).range[0] && bin.k[1] <= (value.chi_amplitude as { range: Range }).range[1])))
      || !Array.isArray(value.duplicate_inputs) || !value.duplicate_inputs.every(duplicate => record(duplicate)
        && typeof duplicate.id === 'string' && typeof duplicate.label === 'string' && duplicate.id !== value.id
        && all.get(duplicate.id)?.label === duplicate.label)
      || new Set(value.duplicate_inputs.map(duplicate => duplicate.id)).size !== value.duplicate_inputs.length) return false
  }
  return true
}

export function comparisonReportFilename(report: ComparisonReport) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'group'
  return `craft-comparison-${safe(report.project_id)}-v${report.version}-${report.scope}-ref-${safe(report.reference_id)}.json`
}
