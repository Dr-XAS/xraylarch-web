import type { AthenaProject } from './athena'

export type QualityReportScope = 'all' | 'marked'

export type QualityReportGroup = {
  id: string
  label: string
  data_type: string
  marked: boolean
  frozen: boolean
  axis: 'energy' | 'k'
  range: [number, number] | null
  points: number
  e0: number | null
  edge_step: number | null
  exafs: boolean
  available_kmax: number | null
  status: 'processed' | 'failed' | 'unprocessed'
  processing_error: string | null
  warnings: string[]
  adjustments: { parameter: string; requested: number; effective: number; unit: string }[]
  duplicate_inputs: { id: string; label: string }[]
  notes: string[]
}

export type QualityReport = {
  project_id: string
  project_name: string
  version: number
  scope: QualityReportScope
  counts: {
    groups: number
    processed: number
    failed: number
    unprocessed: number
    with_warnings: number
    with_adjustments: number
    with_duplicate_inputs: number
  }
  groups: QualityReportGroup[]
  notes: string[]
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

/** Confirm that a response describes the requested saved project revision. */
export function confirmedQualityReport(data: unknown, project: AthenaProject, scope: QualityReportScope): data is QualityReport {
  if (!record(data) || data.project_id !== project.id || data.project_name !== project.name
    || data.version !== project.version || data.scope !== scope || !strings(data.notes)
    || !record(data.counts) || !Array.isArray(data.groups)) return false
  const selected = project.groups.filter(group => scope === 'all' || group.marked)
  const all = new Map(project.groups.map(group => [group.id, group]))
  if (data.groups.length !== selected.length) return false
  for (const [index, value] of data.groups.entries()) {
    const expected = selected[index]
    if (!record(value) || value.id !== expected.id || value.label !== expected.label
      || value.data_type !== expected.data_type || value.marked !== expected.marked || value.frozen !== expected.frozen
      || !['energy', 'k'].includes(String(value.axis))
      || !(value.range === null || (Array.isArray(value.range) && value.range.length === 2
        && value.range.every(finite) && value.range[0] <= value.range[1]))
      || !Number.isSafeInteger(value.points) || Number(value.points) < 0
      || !nullableNumber(value.e0) || !nullableNumber(value.edge_step) || !nullableNumber(value.available_kmax)
      || typeof value.exafs !== 'boolean' || !['processed', 'failed', 'unprocessed'].includes(String(value.status))
      || !(value.processing_error === null || typeof value.processing_error === 'string')
      || !strings(value.warnings) || !strings(value.notes)
      || !Array.isArray(value.adjustments) || !value.adjustments.every(adjustment => record(adjustment)
        && typeof adjustment.parameter === 'string' && finite(adjustment.requested) && finite(adjustment.effective) && typeof adjustment.unit === 'string')
      || !Array.isArray(value.duplicate_inputs) || !value.duplicate_inputs.every(duplicate => record(duplicate)
        && typeof duplicate.id === 'string' && typeof duplicate.label === 'string'
        && duplicate.id !== value.id && all.get(duplicate.id)?.label === duplicate.label)
      || new Set(value.duplicate_inputs.map(duplicate => duplicate.id)).size !== value.duplicate_inputs.length) return false
  }
  const groups = data.groups as QualityReportGroup[]
  const counts: QualityReport['counts'] = {
    groups: groups.length,
    processed: groups.filter(group => group.status === 'processed').length,
    failed: groups.filter(group => group.status === 'failed').length,
    unprocessed: groups.filter(group => group.status === 'unprocessed').length,
    with_warnings: groups.filter(group => group.warnings.length).length,
    with_adjustments: groups.filter(group => group.adjustments.length).length,
    with_duplicate_inputs: groups.filter(group => group.duplicate_inputs.length).length,
  }
  return Object.entries(counts).every(([key, value]) => (data.counts as Record<string, unknown>)[key] === value)
}

export function hasReviewFindings(group: QualityReportGroup) {
  return group.status !== 'processed' || !!(group.warnings.length || group.adjustments.length || group.duplicate_inputs.length)
}

export function qualityReportFilename(report: QualityReport) {
  const id = report.project_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'project'
  return `craft-review-${id}-v${report.version}-${report.scope}.json`
}
