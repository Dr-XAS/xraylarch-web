import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { ApiRequestError } from '@/lib/backend-client'
import { confirmedQualityReport, type QualityReport, type QualityReportScope } from '@/lib/athena-quality-report'
import { AthenaQualityReport } from './athena-quality-report'

vi.mock('@/lib/athena', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/athena')>(), athenaApi: vi.fn(),
}))
const api = vi.mocked(athenaApi)
const project = { id: 'p', name: 'Copper study', version: 4, groups: [
  { id: 'a', label: 'Sample', marked: true, frozen: true, data_type: 'mu' },
  { id: 'b', label: 'Repeated input', marked: false, frozen: false, data_type: 'mu' },
] } as AthenaProject

function report(scope: QualityReportScope = 'all', current = project): QualityReport {
  const groups = current.groups.filter(group => scope === 'all' || group.marked).map(group => ({
    id: group.id, label: group.label, data_type: group.data_type, marked: group.marked, frozen: group.frozen,
    axis: 'energy' as const, range: [8960, 9200] as [number, number], points: 90, e0: 8979, edge_step: 1,
    exafs: true, available_kmax: 7.6, status: 'processed' as const, processing_error: null,
    warnings: group.id === 'a' ? ['Short post-edge range.'] : [],
    adjustments: group.id === 'a' ? [{ parameter: 'kmax', requested: 12, effective: 7.6, unit: 'Å⁻¹' }] : [],
    duplicate_inputs: group.id === 'a' ? [{ id: 'b', label: 'Repeated input' }] : [],
    notes: ['Range includes the saved energy shift.'],
  }))
  return { project_id: current.id, project_name: current.name, version: current.version, scope,
    counts: { groups: groups.length, processed: groups.length, failed: 0, unprocessed: 0,
      with_warnings: groups.filter(group => group.warnings.length).length,
      with_adjustments: groups.filter(group => group.adjustments.length).length,
      with_duplicate_inputs: groups.filter(group => group.duplicate_inputs.length).length },
    groups, notes: ['This review is not a quality score.'] }
}
const props = () => ({ project, close: vi.fn(), inspect: vi.fn(), reloadProject: vi.fn().mockResolvedValue(false) })
async function ready() { await waitFor(() => expect(screen.getByRole('button', { name: 'Download review JSON' })).toBeEnabled()) }
function openGroup(label = 'Sample') {
  const summary = screen.getByText(label, { selector: 'summary strong' }).closest('summary')!
  fireEvent.click(summary)
  return within(summary.closest('details')!)
}

afterEach(() => { cleanup(); api.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('requests the saved revision and displays warnings, adjustments, support and duplicates outside marked scope', async () => {
  api.mockResolvedValueOnce(report()).mockResolvedValueOnce(report('marked'))
  const p = props()
  render(<AthenaQualityReport {...p} />)
  expect(screen.getByRole('status')).toHaveTextContent('Reviewing saved spectra')
  await ready()
  expect(api).toHaveBeenCalledWith('/projects/p/quality-report', { version: 4, scope: 'all' }, 'POST', expect.any(AbortSignal))
  fireEvent.change(screen.getByLabelText('Review groups'), { target: { value: 'marked' } })
  await ready()
  const group = openGroup()
  expect(group.getByText('Short post-edge range.')).toBeVisible()
  expect(group.getByText(/12 → 7.6 Å⁻¹/)).toBeVisible()
  expect(group.getByText('Repeated input')).toBeVisible()
  expect(group.getByText(/outside this review scope/)).toBeVisible()
  expect(group.getByText('8960 to 9200 eV')).toBeVisible()
  expect(group.getByText('7.6 Å⁻¹')).toBeVisible()
  expect(group.getByText(/Frozen/)).toBeVisible()
  fireEvent.click(group.getByRole('button', { name: 'View spectrum' }))
  expect(p.inspect).toHaveBeenCalledWith('a')
  expect(api).toHaveBeenCalledTimes(2)
})

it('filters findings without requesting again and exports every scoped group from the confirmed snapshot', async () => {
  const original = report()
  api.mockResolvedValueOnce(original)
  const createUrl = vi.fn().mockReturnValue('blob:review')
  const revokeUrl = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<AthenaQualityReport {...props()} />)
  await ready()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Only groups with findings' }))
  expect(screen.queryByText('Repeated input', { selector: 'summary strong' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Download review JSON' }))
  expect(api).toHaveBeenCalledOnce()
  expect(click.mock.instances[0]).toHaveAttribute('download', 'craft-review-p-v4-all.json')
  const blob = createUrl.mock.calls[0][0] as Blob
  const contents = await new Promise<string>(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
  expect(JSON.parse(contents)).toEqual(original)
  expect(screen.getByRole('status')).toHaveTextContent('Downloaded craft-review-p-v4-all.json')
})

it('shows empty marked scope from the server and can return to all groups', async () => {
  const current = { ...project, groups: project.groups.map(group => ({ ...group, marked: false })) }
  api.mockResolvedValueOnce(report('all', current)).mockResolvedValueOnce(report('marked', current)).mockResolvedValueOnce(report('all', current))
  render(<AthenaQualityReport {...props()} project={current} />)
  await ready()
  fireEvent.change(screen.getByLabelText('Review groups'), { target: { value: 'marked' } })
  await ready()
  expect(screen.getByRole('status')).toHaveTextContent('No marked groups')
  fireEvent.change(screen.getByLabelText('Review groups'), { target: { value: 'all' } })
  await ready()
  expect(screen.getByText('Sample', { selector: 'summary strong' })).toBeInTheDocument()
})

it('does not describe a snapshot without findings as proof of quality', async () => {
  const current = { ...project, groups: [project.groups[1]] }
  api.mockResolvedValueOnce(report('all', current))
  render(<AthenaQualityReport {...props()} project={current} />)
  await ready()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Only groups with findings' }))
  expect(screen.getByRole('status')).toHaveTextContent('Inspect the spectra before drawing scientific conclusions')
})

it('shows failed and unprocessed groups as findings, including their explicit failure', async () => {
  const result = report()
  Object.assign(result.groups[0], { status: 'failed', processing_error: 'Normalization failed.', e0: null, edge_step: null, available_kmax: null, exafs: false })
  result.groups[1].status = 'unprocessed'
  Object.assign(result.counts, { failed: 1, unprocessed: 1, processed: 0 })
  api.mockResolvedValueOnce(result)
  render(<AthenaQualityReport {...props()} />)
  await ready()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Only groups with findings' }))
  expect(screen.getByText('Processing failed')).toBeInTheDocument()
  expect(screen.getByText('No processed result')).toBeInTheDocument()
  expect(openGroup().getByText('Normalization failed.')).toBeVisible()
})

it('retries an error while preserving scope and does not offer an unconfirmed download', async () => {
  api.mockResolvedValueOnce(report()).mockRejectedValueOnce(new Error('Connection lost.')).mockResolvedValueOnce(report('marked'))
  render(<AthenaQualityReport {...props()} />)
  await ready()
  fireEvent.change(screen.getByLabelText('Review groups'), { target: { value: 'marked' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost.')
  expect(screen.getByRole('button', { name: 'Download review JSON' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh review' }))
  await ready()
  expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 4, scope: 'marked' })
})

it('aborts and ignores late responses when scope changes or the component unmounts', async () => {
  let resolve!: (value: unknown) => void
  api.mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce(report('marked'))
  const rendered = render(<AthenaQualityReport {...props()} />)
  const firstSignal = api.mock.calls[0][3]!
  fireEvent.change(screen.getByLabelText('Review groups'), { target: { value: 'marked' } })
  await ready()
  expect(firstSignal.aborted).toBe(true)
  await act(async () => { resolve(report()) })
  expect(screen.queryByText('Repeated input', { selector: 'summary strong' })).not.toBeInTheDocument()
  const lastSignal = api.mock.calls.at(-1)![3]!
  rendered.unmount()
  expect(lastSignal.aborted).toBe(true)
})

it('discards a snapshot and aborts its request when the project revision or identity changes', async () => {
  const next = { ...project, version: 5 }
  const other = { ...project, id: 'other', name: 'Other study' }
  api.mockResolvedValueOnce(report()).mockResolvedValueOnce(report('all', next)).mockResolvedValueOnce(report('all', other))
  const p = props()
  const rendered = render(<AthenaQualityReport {...p} />)
  await ready()
  const signal = api.mock.calls[0][3]!
  rendered.rerender(<AthenaQualityReport {...p} project={next} />)
  expect(screen.getByRole('button', { name: 'Download review JSON' })).toBeDisabled()
  await ready()
  expect(signal.aborted).toBe(true)
  expect(screen.getByText(/Revision 5/)).toBeInTheDocument()
  rendered.rerender(<AthenaQualityReport {...p} project={other} />)
  await ready()
  expect(api.mock.calls.at(-1)?.[0]).toBe('/projects/other/quality-report')
  expect(screen.getByText(/Other study/)).toBeInTheDocument()
})

it('offers explicit project reload on 409 and preserves the chosen scope after revision recovery', async () => {
  const p = props()
  const next = { ...project, version: 5 }
  api.mockResolvedValueOnce(report()).mockRejectedValueOnce(new ApiRequestError({ code: 'stale_revision', message: 'Changed elsewhere.', fields: [], recovery: 'Reload' }, 409))
  const rendered = render(<AthenaQualityReport {...p} />)
  await ready()
  fireEvent.change(screen.getByLabelText('Review groups'), { target: { value: 'marked' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('Reload the project')
  expect(screen.getByRole('button', { name: 'Download review JSON' })).toBeDisabled()
  p.reloadProject.mockImplementationOnce(async () => {
    api.mockResolvedValueOnce(report('marked', next))
    rendered.rerender(<AthenaQualityReport {...p} project={next} />)
    return true
  })
  fireEvent.click(screen.getByRole('button', { name: 'Reload project' }))
  await ready()
  expect(screen.getByLabelText('Review groups')).toHaveValue('marked')
  expect(screen.getByText(/Revision 5/)).toBeInTheDocument()
  expect(p.reloadProject).toHaveBeenCalledOnce()
})

it('keeps reload failures actionable without a stale download', async () => {
  api.mockRejectedValueOnce(new ApiRequestError({ code: 'stale_revision', message: 'Changed elsewhere.', fields: [], recovery: 'Reload' }, 409))
  render(<AthenaQualityReport {...props()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reload project' }))
  expect(await screen.findByText('The latest project revision could not be loaded. Check the connection and try again.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Reload project' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Download review JSON' })).toBeDisabled()
})

it.each([
  ['wrong project', (value: QualityReport) => { value.project_id = 'other' }],
  ['wrong revision', (value: QualityReport) => { value.version++ }],
  ['wrong scope', (value: QualityReport) => { value.scope = 'marked' }],
  ['wrong group order', (value: QualityReport) => { value.groups.reverse() }],
  ['wrong counts', (value: QualityReport) => { value.counts.processed++ }],
  ['invalid finite number', (value: QualityReport) => { value.groups[0].adjustments[0].effective = Infinity }],
  ['unknown duplicate', (value: QualityReport) => { value.groups[0].duplicate_inputs[0].id = 'missing' }],
] as const)('rejects %s before displaying or downloading a report', async (_name, alter) => {
  const invalid = report()
  alter(invalid)
  expect(confirmedQualityReport(invalid, project, 'all')).toBe(false)
  api.mockResolvedValueOnce(invalid)
  render(<AthenaQualityReport {...props()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
  expect(screen.getByRole('button', { name: 'Download review JSON' })).toBeDisabled()
})
