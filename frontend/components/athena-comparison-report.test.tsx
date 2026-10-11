import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { ApiRequestError } from '@/lib/backend-client'
import { confirmedComparisonReport, type ComparisonReport, type ComparisonScope } from '@/lib/athena-comparison-report'
import { AthenaComparisonReport } from './athena-comparison-report'

vi.mock('@/lib/athena', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/athena')>(), athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const project = { id: 'p', name: 'Copper study', version: 4, groups: [
  { id: 'r', label: 'Reference', marked: false, data_type: 'mu' },
  { id: 'a', label: 'Sample', marked: true, data_type: 'mu' },
  { id: 'b', label: 'Repeated input', marked: false, data_type: 'mu' },
] } as AthenaProject
function report(referenceId = 'r', scope: ComparisonScope = 'marked', current = project): ComparisonReport {
  const identity = (group: AthenaProject['groups'][number]) => ({ id: group.id, label: group.label, data_type: group.data_type,
    axis: 'energy' as const, range: [8900, 9300] as [number, number], points: 90, processing_error: null })
  const reference = current.groups.find(group => group.id === referenceId)!
  return { project_id: current.id, project_name: current.name, version: current.version, reference_id: referenceId, scope,
    reference: { ...identity(reference), e0: 8979, edge_step: 1, exafs: true, available_kmax: 9.1 },
    groups: current.groups.filter(group => group.id !== referenceId && (scope === 'all' || group.marked)).map(group => ({
      ...identity(group), common_range: [8900, 9300], e0_difference: 0.4, edge_step_ratio: 1.2,
      energy_shift: { value: -0.3, stderr: 0.02, range: [8960, 9028] },
      xanes: { max_difference: 0.03, range: [8959, 9029], points: 30 },
      chi_amplitude: { kweight: 2, range: [3, 7], bins: [{ k: [3, 5], ratio: 0.8 }, { k: [5, 7], ratio: 0.7 }] },
      duplicate_inputs: group.id === 'a' ? [{ id: 'b', label: 'Repeated input' }] : [], unavailable: {}, notes: ['Saved energy shifts are included.'],
    })), notes: ['Chemical differences can affect the fitted shift.'] }
}
const props = () => ({ project, activeId: 'r', close: vi.fn(), inspect: vi.fn(), reloadProject: vi.fn().mockResolvedValue(false) })
async function ready() { await waitFor(() => expect(screen.getByRole('button', { name: 'Download comparison JSON' })).toBeEnabled()) }
function openGroup(label = 'Sample') {
  const summary = screen.getByText(label, { selector: 'summary strong' }).closest('summary')!
  fireEvent.click(summary)
  return within(summary.closest('details')!)
}
afterEach(() => { cleanup(); api.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('compares marked targets with the current group and displays actual intervals, units and reference-weighted ratios', async () => {
  api.mockResolvedValueOnce(report())
  const p = props()
  render(<AthenaComparisonReport {...p} />)
  expect(screen.getByRole('status')).toHaveTextContent('Comparing saved spectra')
  await ready()
  expect(api).toHaveBeenCalledWith('/projects/p/comparison-report', { version: 4, reference_id: 'r', scope: 'marked' }, 'POST', expect.any(AbortSignal))
  expect(screen.getByLabelText('Comparison reference')).toHaveValue('r')
  expect(screen.getByLabelText('Comparison groups')).toHaveValue('marked')
  const card = openGroup()
  expect(card.getByText('-0.3 eV')).toBeVisible()
  expect(card.getByText(/Fit standard error: 0.02 eV.*8960 to 9028 eV/)).toBeVisible()
  expect(card.getByText(/8959 to 9029 eV.*upper bound excluded.*30 reference points/)).toBeVisible()
  expect(card.getByText(/reference k weight 2/)).toBeVisible()
  expect(card.getByText('3 to 5 Å⁻¹')).toBeVisible()
  expect(card.getByText('Repeated input')).toBeVisible()
  fireEvent.click(card.getByRole('button', { name: 'View spectrum' }))
  expect(p.inspect).toHaveBeenCalledWith('a')
  expect(api).toHaveBeenCalledOnce()
})

it('defaults to all when the marked set contains only the reference', async () => {
  const current = { ...project, groups: project.groups.map(group => ({ ...group, marked: group.id === 'r' })) }
  api.mockResolvedValueOnce(report('r', 'all', current))
  render(<AthenaComparisonReport {...props()} project={current} />)
  await ready()
  expect(screen.getByLabelText('Comparison groups')).toHaveValue('all')
  expect(screen.queryByText('Reference', { selector: 'summary strong' })).not.toBeInTheDocument()
})

it('switches reference and scope independently without modifying the project', async () => {
  api.mockResolvedValueOnce(report()).mockResolvedValueOnce(report('b')).mockResolvedValueOnce(report('b', 'all'))
  render(<AthenaComparisonReport {...props()} />)
  await ready()
  fireEvent.change(screen.getByLabelText('Comparison reference'), { target: { value: 'b' } })
  await ready()
  expect(screen.getByRole('heading', { name: 'Compared with Repeated input' })).toBeVisible()
  fireEvent.change(screen.getByLabelText('Comparison groups'), { target: { value: 'all' } })
  await ready()
  expect(screen.getByText('Reference', { selector: 'summary strong' })).toBeInTheDocument()
  expect(screen.queryByText('Repeated input', { selector: 'summary strong' })).not.toBeInTheDocument()
  expect(api.mock.calls.map(call => call[1])).toEqual([
    { version: 4, reference_id: 'r', scope: 'marked' }, { version: 4, reference_id: 'b', scope: 'marked' }, { version: 4, reference_id: 'b', scope: 'all' },
  ])
})

it('explains an empty target scope without requesting or retaining an old download', async () => {
  api.mockResolvedValueOnce(report())
  render(<AthenaComparisonReport {...props()} />)
  await ready()
  fireEvent.change(screen.getByLabelText('Comparison reference'), { target: { value: 'a' } })
  expect(screen.getByRole('status')).toHaveTextContent('No other marked groups')
  expect(screen.getByRole('button', { name: 'Download comparison JSON' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Refresh comparison' })).toBeDisabled()
  expect(api).toHaveBeenCalledOnce()
})

it('distinguishes duplicate labels by project group number while sending the exact group ID', async () => {
  const current = { ...project, groups: project.groups.map(group => ({ ...group, label: group.id === 'b' ? group.label : 'Cu foil' })) }
  api.mockResolvedValueOnce(report('r', 'marked', current))
  render(<AthenaComparisonReport {...props()} project={current} />)
  await ready()
  expect(screen.getByRole('option', { name: 'Cu foil · group 1' })).toHaveValue('r')
  expect(screen.getByRole('option', { name: 'Cu foil · group 2' })).toHaveValue('a')
  expect(screen.getByRole('heading', { name: 'Compared with Cu foil · group 1' })).toBeVisible()
  expect(screen.getByText('Cu foil · group 2', { selector: 'summary strong' })).toBeVisible()
  fireEvent.change(screen.getByLabelText('Comparison reference'), { target: { value: 'a' } })
  expect(screen.getByRole('status')).toHaveTextContent('No other marked groups')
  expect(api.mock.calls[0][1]).toEqual({ version: 4, reference_id: 'r', scope: 'marked' })
})

it('explains the 100-target bound without sending an oversized report request', () => {
  const current = { ...project, groups: [project.groups[0], ...Array.from({ length: 101 }, (_, index) => ({ ...project.groups[1], id: `target-${index}`, label: `Target ${index}` }))] }
  render(<AthenaComparisonReport {...props()} project={current} />)
  expect(screen.getByRole('status')).toHaveTextContent('Compare at most 100 target groups')
  expect(screen.getByRole('button', { name: 'Refresh comparison' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Download comparison JSON' })).toBeDisabled()
  expect(api).not.toHaveBeenCalled()
})

it('presents unavailable metrics with server explanations and supports valid zero values', async () => {
  const data = report()
  data.groups[0].energy_shift = null
  data.groups[0].unavailable.energy_shift = 'No shared edge interval.'
  data.groups[0].e0_difference = 0
  data.groups[0].xanes!.max_difference = 0
  data.groups[0].chi_amplitude!.kweight = 0
  data.groups[0].chi_amplitude!.bins[0].ratio = 0
  api.mockResolvedValueOnce(data)
  render(<AthenaComparisonReport {...props()} />)
  await ready()
  const card = openGroup()
  expect(card.getByText('No shared edge interval.')).toBeVisible()
  expect(card.getByText('0 eV')).toBeVisible()
  expect(card.getByText(/reference k weight 0/)).toBeVisible()
})

it('exports the exact confirmed snapshot with project, revision, scope and reference in its filename', async () => {
  const original = report()
  api.mockResolvedValueOnce(original)
  const createUrl = vi.fn().mockReturnValue('blob:comparison')
  vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<AthenaComparisonReport {...props()} />)
  await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Download comparison JSON' }))
  expect(click.mock.instances[0]).toHaveAttribute('download', 'craft-comparison-p-v4-marked-ref-r.json')
  const contents = await new Promise<string>(resolve => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(createUrl.mock.calls[0][0])
  })
  expect(JSON.parse(contents)).toEqual(original)
  expect(api).toHaveBeenCalledOnce()
})

it('retries a connection error while preserving reference and scope', async () => {
  api.mockRejectedValueOnce(new Error('Connection lost.')).mockResolvedValueOnce(report())
  render(<AthenaComparisonReport {...props()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost.')
  expect(screen.getByRole('button', { name: 'Download comparison JSON' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh comparison' }))
  await ready()
  expect(api.mock.calls[1][1]).toEqual({ version: 4, reference_id: 'r', scope: 'marked' })
})

it.each(['reference', 'scope'] as const)('aborts old requests and ignores late responses after changing %s', async change => {
  let resolve!: (value: unknown) => void
  api.mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce(change === 'reference' ? report('b') : report('r', 'all'))
  const rendered = render(<AthenaComparisonReport {...props()} />)
  const signal = api.mock.calls[0][3]!
  fireEvent.change(screen.getByLabelText(change === 'reference' ? 'Comparison reference' : 'Comparison groups'), { target: { value: change === 'reference' ? 'b' : 'all' } })
  await ready()
  expect(signal.aborted).toBe(true)
  await act(async () => { resolve(report()) })
  if (change === 'reference') expect(screen.getByRole('heading', { name: 'Compared with Repeated input' })).toBeVisible()
  else expect(screen.getByText('Repeated input', { selector: 'summary strong' })).toBeVisible()
  const lastSignal = api.mock.calls.at(-1)![3]!
  rendered.unmount()
  expect(lastSignal.aborted).toBe(true)
})

it('invalidates the displayed snapshot when the project revision changes', async () => {
  const next = { ...project, version: 5 }
  api.mockResolvedValueOnce(report()).mockResolvedValueOnce(report('r', 'marked', next))
  const p = props(), rendered = render(<AthenaComparisonReport {...p} />)
  await ready()
  const signal = api.mock.calls[0][3]!
  rendered.rerender(<AthenaComparisonReport {...p} project={next} />)
  expect(screen.getByRole('button', { name: 'Download comparison JSON' })).toBeDisabled()
  await ready()
  expect(signal.aborted).toBe(true)
  expect(screen.getByText(/Revision 5/)).toBeVisible()
})

it('asks for a new reference if the chosen group disappeared from the project', async () => {
  api.mockResolvedValueOnce(report())
  const p = props(), rendered = render(<AthenaComparisonReport {...p} />)
  await ready()
  rendered.rerender(<AthenaComparisonReport {...p} project={{ ...project, version: 5, groups: project.groups.slice(1) }} />)
  expect(screen.getByRole('status')).toHaveTextContent('Choose a comparison reference')
  expect(screen.getByRole('button', { name: 'Download comparison JSON' })).toBeDisabled()
  expect(api).toHaveBeenCalledOnce()
})

it('reloads a conflicted project explicitly and compares the same chosen scope again', async () => {
  const p = props(), next = { ...project, version: 5 }
  api.mockRejectedValueOnce(new ApiRequestError({ code: 'stale_revision', message: 'Changed elsewhere.', fields: [], recovery: 'Reload' }, 409))
  const rendered = render(<AthenaComparisonReport {...p} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Reload the project')
  expect(screen.getByRole('button', { name: 'Download comparison JSON' })).toBeDisabled()
  p.reloadProject.mockImplementationOnce(async () => {
    api.mockResolvedValueOnce(report('r', 'marked', next))
    rendered.rerender(<AthenaComparisonReport {...p} project={next} />)
    return true
  })
  fireEvent.click(screen.getByRole('button', { name: 'Reload project' }))
  await ready()
  expect(screen.getByLabelText('Comparison reference')).toHaveValue('r')
  expect(screen.getByLabelText('Comparison groups')).toHaveValue('marked')
  expect(screen.getByText(/Revision 5/)).toBeVisible()
})

it.each([
  ['wrong project', (value: ComparisonReport) => { value.project_id = 'other' }],
  ['wrong revision', (value: ComparisonReport) => { value.version++ }],
  ['wrong reference', (value: ComparisonReport) => { value.reference_id = 'b' }],
  ['wrong target', (value: ComparisonReport) => { value.groups[0].id = 'b' }],
  ['wrong axis', (value: ComparisonReport) => { value.groups[0].axis = 'k' }],
  ['nonfinite metric', (value: ComparisonReport) => { value.groups[0].energy_shift!.value = Infinity }],
  ['missing explanation', (value: ComparisonReport) => { value.groups[0].energy_shift = null }],
  ['contradictory explanation', (value: ComparisonReport) => { value.groups[0].unavailable.energy_shift = 'Unavailable' }],
  ['bin outside support', (value: ComparisonReport) => { value.groups[0].chi_amplitude!.bins[0].k[0] = 2 }],
  ['unknown duplicate', (value: ComparisonReport) => { value.groups[0].duplicate_inputs[0].id = 'missing' }],
] as const)('rejects %s before displaying or downloading the comparison', async (_name, alter) => {
  const invalid = report(); alter(invalid)
  expect(confirmedComparisonReport(invalid, project, 'r', 'marked')).toBe(false)
  api.mockResolvedValueOnce(invalid)
  render(<AthenaComparisonReport {...props()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
  expect(screen.getByRole('button', { name: 'Reload project' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Download comparison JSON' })).toBeDisabled()
})
