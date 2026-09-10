import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultRebin } from '@/lib/athena-import'
import type { AthenaProject, RebinPreview } from '@/lib/athena'
import { differenceProject } from './athena-difference.fixtures'
import { AthenaRebin } from './athena-rebin'

const { api, plot, busy, saved } = vi.hoisted(() => ({ api: vi.fn(), plot: vi.fn(), busy: vi.fn(), saved: vi.fn() }))
vi.mock('@/lib/athena', async original => ({ ...await original<typeof import('@/lib/athena')>(), athenaApi: api }))
vi.mock('next/dynamic', () => ({ default: () => (props: unknown) => { plot(props); return <div data-testid="rebin-plot" /> } }))
function response(version = 7): RebinPreview {
  return { version, options: {}, skipped_reasons: {}, results: [{ source_group_id: 'data', label: 'DATA foil', kweight: 3,
    errors: [], processing_error: null, details: { e0: 8979, emin: -30, emax: 50, source_points: 2006, output_points: 396, width: 3, warnings: [] },
    traces: [ { id: 'a', label: 'original', role: 'original', x: [1, 2, 3], y: [4, 5, 6] },
      { id: 'b', label: 'rebinned', role: 'rebinned', x: [1, 3], y: [4, 6] } ],
  }] }
}
function Harness({ initial = differenceProject() }: { initial?: AthenaProject }) {
  const [project, setProject] = useState(initial), [id, setId] = useState(initial.groups[0].id)
  const [grid, setGrid] = useState({ ...defaultRebin, enabled: true })
  return <AthenaRebin project={project} activeId={id} selectGroup={setId} grid={grid} setGrid={setGrid}
    saved={p => { saved(p); setProject(p) }} setBusy={busy} />
}
async function tick() { await act(() => vi.advanceTimersByTimeAsync(180)) }
const drawing = () => plot.mock.calls.at(-1)![0]
beforeEach(() => { vi.useFakeTimers(); api.mockReset().mockResolvedValue(response()); plot.mockClear(); busy.mockClear(); saved.mockClear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('uses native defaults, accepted E0, region markers and server-produced E/k curves', async () => {
  render(<Harness />); await tick()
  expect(api.mock.calls[0][1]).toMatchObject({ version: 7, group_ids: ['data'], options: { pre: 10, xanes: .5, exafs: .05, emin: -30, emax: 50, width: 3, plot_space: 'E' } })
  expect(api.mock.calls[0][1].options).not.toHaveProperty('e0')
  expect(drawing().data[0].y).toEqual([4, 5, 6])
  expect(drawing().layout.shapes.map((s: { x0: number }) => s.x0)).toEqual([8949, 9029])
  expect(screen.getByText(/2,006 → 396/)).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Show original data'))
  expect(drawing().data).toHaveLength(1); await tick(); expect(api).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Plot data and rebinned data in k' }))
  await tick()
  expect(api.mock.calls[1][1].options.plot_space).toBe('k')
  expect(drawing().layout.shapes).toEqual([])
  expect(drawing().layout.xaxis.title.text).toBe('k (Å⁻¹)')
})

it('blocks invalid grid values, cancels stale requests, and recovers on a new selection', async () => {
  let finish!: (v: RebinPreview) => void
  api.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  render(<Harness />); await tick()
  fireEvent.change(screen.getByLabelText('Pre-edge grid · eV'), { target: { value: '' } })
  expect(api.mock.calls[0][3].aborted).toBe(true)
  await act(async () => finish(response()))
  expect(screen.queryByTestId('rebin-plot')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Make rebinned data group' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Pre-edge grid · eV'), { target: { value: '5' } })
  fireEvent.change(screen.getByLabelText('Rebin source group'), { target: { value: 'other' } })
  await tick()
  expect(api.mock.calls[1][1]).toMatchObject({ group_ids: ['other'], options: { pre: 5 } })
})

it('previews marked groups and preserves a failed creation for retry, then uses the accepted revision', async () => {
  api.mockImplementation((url: string) => url.endsWith('/preview') ? Promise.resolve(response()) : Promise.reject(new Error('Import budget exceeded')))
  render(<Harness />); await tick()
  fireEvent.click(screen.getByLabelText('Preview marked groups (3)')); await tick()
  expect(api.mock.calls.at(-1)![1]).toMatchObject({ group_ids: ['data', 'standard', 'other'], options: { skip_ineligible: true } })
  fireEvent.click(screen.getByRole('button', { name: 'Rebin marked data and make groups' }))
  await tick()
  expect(screen.getByRole('alert')).toHaveTextContent('Import budget exceeded')
  expect(saved).not.toHaveBeenCalled()
  const next = { ...differenceProject(), version: 8, last_operation: { action: 'rebin', skipped_group_ids: [], rebin_results: [{ group_id: 'new', source_group_id: 'data', label: 'new' }] } }
  api.mockImplementation((url: string) => Promise.resolve(url.endsWith('/preview') ? response(8) : next))
  fireEvent.click(screen.getByRole('button', { name: 'Rebin marked data and make groups' })); await tick(); await tick()
  expect(saved).toHaveBeenCalledWith(next)
  expect(api.mock.calls.at(-1)![1].version).toBe(8)
  expect(busy).toHaveBeenLastCalledWith('')
})

it('reports unavailable k processing without removing the E action', async () => {
  const noK = response(); noK.results[0].traces = []; noK.results[0].errors = ['No EXAFS data']
  api.mockResolvedValue(noK)
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Plot data and rebinned data in k' })); await tick()
  expect(screen.getByText('No EXAFS data')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Plot data and rebinned data' })).toBeEnabled()
})

it.each(['chi', 'rebinned'] as const)('disables creation for %s sources but permits switching to an original', async kind => {
  const p = differenceProject()
  if (kind === 'chi') p.groups[0].data_type = 'chi'
  else p.groups[0].source = { native: { args: { rebinned: '1' } } }
  render(<Harness initial={p} />); await tick()
  expect(api).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Make rebinned data group' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Rebin source group'), { target: { value: 'other' } }); await tick()
  expect(screen.getByRole('button', { name: 'Make rebinned data group' })).toBeEnabled()
})
