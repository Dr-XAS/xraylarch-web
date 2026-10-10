import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ArtemisFitArchive, ArtemisTransform } from '@/lib/artemis'
import { download } from '@/lib/artemis-fit-utils'
import { buildHistoryComparison, type HistoryComparisonContext } from '@/lib/artemis-history-comparison'
import { ArtemisFitHistoryComparison } from './artemis-fit-history-comparison'

vi.mock('@/lib/artemis-fit-utils', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/artemis-fit-utils')>(), download: vi.fn() }))
const save = vi.mocked(download)
const fingerprint = 'a'.repeat(64)
const context: HistoryComparisonContext = { projectId: 'p', projectName: 'Copper project', version: 8, groupId: 'g', groupLabel: 'Cu foil', currentInputSha256: fingerprint }
const transform: ArtemisTransform = { fitspace: 'r', kmin: 3, kmax: 12, kweight: [1, 2], rmin: 1, rmax: 3, dk: 1, dr: 0, window: 'hanning' }
function archive(id: string, delta = 0.01): ArtemisFitArchive {
  const metadata = { reff: 2.55, degen: 12, nleg: 2, absorber: 'Cu', edge: 'K',
    geometry: [{ atom: 'Cu', x: 0, y: 0, z: 0, ipot: 0 }, { atom: 'Cu', x: 2.55, y: 0, z: 0, ipot: 1 }], kmin: 0, kmax: 20 }
  const parameter = { name: 'del_r', kind: 'guess' as const, value: delta, min: -0.2, max: 0.2, expression: '' }
  return {
    id, created: '2026-10-10T12:00:00Z', input_sha256: fingerprint, imported: false,
    origin: { project_id: 'original-project', group_id: 'original-group', project_version: 4, larch_version: '2026.1' },
    model: { revision: 1, parameters: [{ ...parameter, id: 'parameter', value: '0', min: '-0.2', max: '0.2' }],
      paths: [{ id: 'path1', label: 'Cu–Cu', filename: 'feff0001.dat', content: 'saved FEFF contents', metadata, enabled: true, s02: '1', e0: '0', deltar: 'del_r', sigma2: '0.003' }],
      transform: { ...transform, kmin: '3', kmax: '12', rmin: '1', rmax: '3', dk: '1', dr: '0' } },
    result: { project_id: 'original-project', group_id: 'original-group', group_label: 'Original foil', version: 4,
      success: true, message: 'Fit succeeded.', report: 'Saved text report.', warnings: ['Systematic errors are not included.'],
      statistics: { n_varys: 1, n_independent: 12, n_data: 40, nfev: 25, chi_square: 50, reduced_chi_square: 4.5, r_factor: 0.003, aic: 20, bic: 25, errorbars: true, epsilon_k: 0.0002 },
      parameters: [{ ...parameter, initial: 0, stderr: 0.002 }], correlations: [],
      paths: [{ id: 'path1', label: 'Cu–Cu', filename: 'feff0001.dat', metadata, values: { deltar: delta, sigma2: 0.003, s02: 1, e0: 0 } }],
      k: { x: [3, 4], data: [1, 2], model: [0.9, 1.9], residual: [0.1, 0.1], weight: 1 },
      r: { x: [1, 2], data_mag: [1, 2], model_mag: [0.9, 1.9], residual_mag: [0.1, 0.1], data_re: [1, 2], model_re: [0.9, 1.9], residual_re: [0.1, 0.1], data_im: [0, 0], model_im: [0, 0], residual_im: [0, 0] },
      transform: { ...transform }, metadata: { engine: 'larch' } },
  }
}
function props() { return { context, history: [archive('fit-a'), archive('fit-b', 0.02)], initialReferenceId: 'fit-a' } }
function open() { fireEvent.click(screen.getByRole('button', { name: 'Compare saved fits' })); return within(screen.getByRole('region', { name: 'Saved fit comparison' })) }
function expand(region: ReturnType<typeof within>, name: string) { fireEvent.click(region.getByText(name, { selector: 'summary strong, summary' })) }

beforeEach(() => { save.mockReset(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('opens with the selected archive as reference and shows saved conditions and values without requests', () => {
  const p = props(); p.history[1].result.transform.kmax = 10
  render(<ArtemisFitHistoryComparison {...p} />)
  expect(screen.queryByRole('region', { name: 'Saved fit comparison' })).not.toBeInTheDocument()
  const region = open()
  expect(region.getByLabelText('Reference saved fit')).toHaveValue('fit-a')
  expect(region.getByLabelText('Comparison saved fit')).toHaveValue('fit-b')
  expect(region.getByText('Both fits used the same recorded input.')).toBeVisible()
  expect(region.getByText('Cu foil · Loaded project revision 8')).toBeVisible()
  const kmax = within(region.getByRole('region', { name: 'Saved fit conditions' })).getByRole('rowheader', { name: 'k max Å⁻¹' }).closest('tr')!
  expect(within(kmax).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['12', '10'])
  expand(region, 'del_r')
  expect(region.getAllByText('Standard error: 0.002')).toHaveLength(2)
  expect(region.getByText('Δ 0.01')).toBeVisible()
  expand(region, 'Cu–Cu')
  expect(region.getByText('ΔR 0.01 Å')).toBeVisible()
  expect(region.getByText('2.56 Å')).toBeVisible()
  expect(region.getByText('2.57 Å')).toBeVisible()
  expect(region.getByText(/Saved ε\(k\) applies to the plotted k weight/)).toBeVisible()
  expect(fetch).not.toHaveBeenCalled()
})

it('swaps the pair when either selector chooses the other fit, including identical timestamps', () => {
  render(<ArtemisFitHistoryComparison {...props()} />)
  const region = open()
  const reference = region.getByLabelText('Reference saved fit'), comparison = region.getByLabelText('Comparison saved fit')
  expect(within(reference).getAllByRole('option').map(option => option.textContent)).toEqual([expect.stringMatching(/^Fit 1 ·/), expect.stringMatching(/^Fit 2 ·/)])
  fireEvent.change(reference, { target: { value: 'fit-b' } })
  expect(reference).toHaveValue('fit-b'); expect(comparison).toHaveValue('fit-a')
  expect(region.getByText('Δ -0.01')).toBeVisible()
  fireEvent.change(comparison, { target: { value: 'fit-b' } })
  expect(reference).toHaveValue('fit-a'); expect(comparison).toHaveValue('fit-b')
  expect(region.getByRole('button', { name: 'Download fit comparison JSON' })).toBeEnabled()
})

it('exports the displayed compact snapshot without modifying either archived model or result', () => {
  const p = props(), original = structuredClone(p)
  render(<ArtemisFitHistoryComparison {...p} />)
  const region = open()
  fireEvent.click(region.getByRole('button', { name: 'Download fit comparison JSON' }))
  expect(save.mock.calls[0][0]).toBe('craft-fit-comparison-g-v8-fit-a-fit-b.json')
  const report = JSON.parse(save.mock.calls[0][1])
  expect(report).toEqual(buildHistoryComparison(context, p.history[0], p.history[1]))
  expect(report.baseline).not.toHaveProperty('k')
  expect(save.mock.calls[0][1]).not.toContain('saved FEFF contents')
  expect(p).toEqual(original)
  expect(fetch).not.toHaveBeenCalled()
})

it('blocks stale export during project updates and refreshes the context and archives afterward', () => {
  const p = props(), rendered = render(<ArtemisFitHistoryComparison {...p} />)
  open()
  rendered.rerender(<ArtemisFitHistoryComparison {...p} pending />)
  expect(screen.getByRole('button', { name: 'Download fit comparison JSON' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for project updates')
  expect(screen.queryByRole('region', { name: 'Saved fit conditions' })).not.toBeInTheDocument()
  const history = structuredClone(p.history); history[1].result.transform.kmax = 9
  rendered.rerender(<ArtemisFitHistoryComparison {...p} context={{ ...context, version: 9 }} history={history} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download fit comparison JSON' }))
  const report = JSON.parse(save.mock.calls[0][1])
  expect(report.version).toBe(9)
  expect(report.comparison.transform.kmax).toBe(9)
})

it('keeps imported status distinct from matching input and preserves original provenance', () => {
  const p = props(); p.history[1].imported = true
  render(<ArtemisFitHistoryComparison {...p} />)
  const region = open()
  expect(region.getByText('Both fits used the same recorded input.')).toBeVisible()
  expect(region.getByText('Imported fit · unverified')).toBeVisible()
  expect(region.getAllByText('Matches loaded processed input')).toHaveLength(2)
  expand(region, 'Fit provenance and warnings')
  expect(region.getAllByText(fingerprint)).toHaveLength(2)
  expect(region.getAllByText('original-project')).toHaveLength(2)
  expect(region.getAllByText('original-group')).toHaveLength(2)
  expect(region.getAllByText('Systematic errors are not included.')).toHaveLength(2)
})

it('recomputes input currentness independently of whether the two archived inputs match', () => {
  const p = props(), rendered = render(<ArtemisFitHistoryComparison {...p} />)
  open()
  rendered.rerender(<ArtemisFitHistoryComparison {...p} context={{ ...context, currentInputSha256: 'b'.repeat(64) }} />)
  expect(screen.getByText('Both fits used the same recorded input.')).toBeVisible()
  expect(screen.getAllByText('Different from loaded processed input')).toHaveLength(2)
  rendered.rerender(<ArtemisFitHistoryComparison {...p} context={{ ...context, currentInputSha256: null }} />)
  expect(screen.getAllByText('Loaded input match unknown')).toHaveLength(2)
})

it('does not silently substitute another archive when a selected fit is removed', () => {
  const p = props(); p.history.push(archive('fit-c', 0.03))
  const rendered = render(<ArtemisFitHistoryComparison {...p} />)
  const region = open()
  rendered.rerender(<ArtemisFitHistoryComparison {...p} context={{ ...context, version: 9 }} history={p.history.slice(1)} />)
  expect(region.getByRole('status')).toHaveTextContent('A selected fit is no longer available')
  expect(region.getByRole('button', { name: 'Download fit comparison JSON' })).toBeDisabled()
  expect(region.getByLabelText('Reference saved fit')).toHaveValue('')
  fireEvent.change(region.getByLabelText('Reference saved fit'), { target: { value: 'fit-b' } })
  expect(region.getByRole('button', { name: 'Download fit comparison JSON' })).toBeEnabled()
})

it('preserves the chosen pair after another fit is added and resets on project or group switches', () => {
  const p = props(), rendered = render(<ArtemisFitHistoryComparison {...p} />)
  open()
  rendered.rerender(<ArtemisFitHistoryComparison {...p} context={{ ...context, version: 9 }} history={[...p.history, archive('fit-c', 0.03)]} initialReferenceId="fit-c" />)
  expect(screen.getByLabelText('Reference saved fit')).toHaveValue('fit-a')
  expect(screen.getByLabelText('Comparison saved fit')).toHaveValue('fit-b')
  rendered.rerender(<ArtemisFitHistoryComparison {...p} context={{ ...context, groupId: 'another-group' }} />)
  expect(screen.queryByRole('region', { name: 'Saved fit comparison' })).not.toBeInTheDocument()
  open()
  rendered.rerender(<ArtemisFitHistoryComparison {...p} context={{ ...context, projectId: 'another-project' }} />)
  expect(screen.queryByRole('region', { name: 'Saved fit comparison' })).not.toBeInTheDocument()
})

it('uses the current selected history entry when reopened without changing the selection itself', () => {
  const p = props(), rendered = render(<ArtemisFitHistoryComparison {...p} />)
  open()
  fireEvent.click(screen.getByRole('button', { name: 'Compare saved fits' }))
  rendered.rerender(<ArtemisFitHistoryComparison {...p} initialReferenceId="fit-b" />)
  const region = open()
  expect(region.getByLabelText('Reference saved fit')).toHaveValue('fit-b')
  expect(region.getByLabelText('Comparison saved fit')).toHaveValue('fit-a')
})

it('shows initial values, fixed parameters and changed definitions without claiming a delta', () => {
  const p = props(); p.history[1].result.parameters[0].kind = 'set'; p.history[1].result.parameters[0].initial = 0.02
  render(<ArtemisFitHistoryComparison {...p} />)
  const region = open(); expand(region, 'del_r')
  expect(region.getByText('Initial value: 0')).toBeVisible()
  expect(region.getByText('Initial value: 0.02')).toBeVisible()
  expect(region.getByText('Fixed')).toBeVisible()
  expect(region.getByText('Δ Unavailable')).toBeVisible()
  expect(region.getByText('Saved initial values differ.')).toBeVisible()
  expect(region.getByText(/kind or expression changed/)).toBeVisible()
})

it('shows ambiguous parameter matches as unavailable and gives their reason', () => {
  const p = props(); p.history[0].result.parameters.push({ ...p.history[0].result.parameters[0] })
  render(<ArtemisFitHistoryComparison {...p} />)
  const region = open(); expand(region, 'del_r')
  expect(region.getByText('Δ Unavailable')).toBeVisible()
  expect(region.getByText(/Repeated parameter names make this match ambiguous/)).toBeVisible()
  expect(region.queryByText('Not in this fit')).not.toBeInTheDocument()
})

it('explains changed FEFF contents without displaying a path distance difference', () => {
  const p = props(); p.history[1].model.paths[0].content = 'different saved FEFF contents'
  render(<ArtemisFitHistoryComparison {...p} />)
  const region = open(); expand(region, 'Cu–Cu')
  expect(region.getByText('ΔR Unavailable')).toBeVisible()
  expect(region.getByText(/FEFF file contents changed/)).toBeVisible()
  expect(region.getByText('2.56 Å')).toBeVisible()
  expect(region.getByText('2.57 Å')).toBeVisible()
})

it('requires two saved fits and reports download failures without requesting data', () => {
  const p = props(), rendered = render(<ArtemisFitHistoryComparison {...p} history={[p.history[0]]} />)
  expect(screen.getByRole('button', { name: 'Compare saved fits' })).toBeDisabled()
  expect(screen.getByText('Save at least two fits for this spectrum to compare them.')).toBeVisible()
  rendered.rerender(<ArtemisFitHistoryComparison {...p} />)
  const region = open()
  save.mockImplementationOnce(() => { throw new Error('Download unavailable.') })
  fireEvent.click(region.getByRole('button', { name: 'Download fit comparison JSON' }))
  expect(region.getByRole('alert')).toHaveTextContent('Download unavailable.')
  expect(fetch).not.toHaveBeenCalled()
})
