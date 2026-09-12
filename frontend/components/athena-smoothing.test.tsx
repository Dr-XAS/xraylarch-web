import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaSmoothing, type SmoothingPreview } from './athena-smoothing'
import { loadSmoothingPreferences } from '@/lib/athena-smoothing-preferences'

type PlotProps = ComponentProps<typeof Plot>
const plot = vi.hoisted(() => vi.fn<(p: PlotProps) => void>())
vi.mock('next/dynamic', () => ({ default: () => (props: PlotProps) => { useLayoutEffect(() => { plot(props) }); return <div /> } }))
vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
vi.mock('@/lib/athena-smoothing-preferences', () => ({loadSmoothingPreferences: vi.fn(async () => ({version: 0, session_id: 's', values: {window: 31, order: 9}, saved: {window: 31, order: 9}, defaults: {window: 31, order: 9}, unsaved: false})), applySmoothingPreferences: vi.fn()}))
const api = vi.mocked(athenaApi)
const x = Array.from({length: 31}, (_, i) => 8900 + i * 2)
const y = x.map((_, i) => Math.sin(i) + i / 10)
const project = { id: 'p', version: 4, groups: [{ id: 'g', label: 'Cu', data_type: 'mu', frozen: true,
  energy: x, mu: y, source: {}, parameters: {energy_shift: 2, kweight: 2},
  result: {arrays: {k: [0,1,2], weighted_chi: [0,.1,-.1], r: [0,1,2], chir_mag: [0,1,.5]}} }] } as unknown as AthenaProject
const props = () => ({project, activeId: 'g', selectGroup: vi.fn(), setBusy: vi.fn(), saved: vi.fn(), close: vi.fn(), disabled: false})
function preview(options: SmoothingPreview['options'] = {method: 'boxcar', window: 11}): SmoothingPreview {
  const size = options.method === 'boxcar' || options.method === 'gaussian' ? (options.window || 11) + ((options.window || 11) % 2 === 0 ? 1 : 0) : 0
  const left = Math.floor(size / 2), right = size ? left + 1 : 0
  const energy = x.slice(left, x.length-right).map(v => v + 2), mu = y.slice(left, y.length-right).map(v => v * .99)
  return {project_id: 'p', version: 4, options, results: [{group_id: 'g', label: 'Cu, smoothed', input_space: 'E', data_type: 'mu', kweight: 2,
    smoothed_energy: energy, smoothed_mu: mu, details: {input_points: x.length, output_points: mu.length, trimmed_left: left, trimmed_right: right, warnings: []}, errors: {},
    traces: Object.fromEntries(['E','k','R'].map(space => [space, [
      {role: 'original', label: 'Cu', x: space === 'E' ? x.map(v => v+2) : [0,1,2], y: space === 'E' ? y : [0,.1,-.1]},
      {role: 'smoothed', label: 'Cu, smoothed', x: space === 'E' ? energy : [0,1,2], y: space === 'E' ? mu : [0,.09,-.09]},
    ]])) as SmoothingPreview['results'][0]['traces']}]}
}
const saveButton = () => screen.getByRole('button', {name: 'Make smoothed group'})
const handoff = () => plot.mock.calls.at(-1)![0]
const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), {target: {value}})
async function ready() { await waitFor(() => expect(saveButton()).toBeEnabled(), {timeout: 2000}) }
function savedProject(result: SmoothingPreview) {
  return {...project, version: 5, groups: [...project.groups, {...project.groups[0], id: 'child', source: {parent: 'g'},
    energy: result.results[0].smoothed_energy, mu: result.results[0].smoothed_mu}]}
}
afterEach(() => { cleanup(); vi.clearAllMocks(); api.mockReset() })

it('a late SG preference load does not invalidate an already confirmed boxcar preview', async () => {
  let resolve!: (v: Awaited<ReturnType<typeof loadSmoothingPreferences>>) => void
  vi.mocked(loadSmoothingPreferences).mockImplementationOnce(() => new Promise(r => {resolve = r}))
  api.mockResolvedValue(preview()); render(<AthenaSmoothing {...props()}/>); await ready()
  await act(async () => resolve({version: 2,session_id: 's',values: {window: 21,order: 11},saved: {window: 21,order: 11},defaults: {window: 31,order: 9},unsaved: false}))
  expect(saveButton()).toBeEnabled(); expect(api).toHaveBeenCalledOnce()
})

it('immediately shows calibrated raw data, then boxcar comparison and E/k/R without extra requests', async () => {
  const result = preview(); api.mockResolvedValue(result); const p = props(); render(<AthenaSmoothing {...p}/>)
  expect(handoff().data[0].y).toEqual(y); expect(handoff().data[0].x).toEqual(x.map(v => v + 2))
  expect(screen.getByLabelText('Algorithm')).toHaveValue('boxcar'); expect(api).not.toHaveBeenCalled(); expect(saveButton()).toBeDisabled()
  await ready()
  expect(api.mock.calls[0][1]).toEqual({version: 4, action: 'smooth', group_ids: ['g'], options: {method: 'boxcar', window: 11}})
  expect(screen.getByText(/20 of 31 points remain/)).toHaveTextContent('Removed 5 points at the left boundary and 6 at the right boundary.')
  expect(handoff().data[1].y).toEqual(result.results[0].smoothed_mu)
  fireEvent.click(screen.getByRole('button', {name: 'Plot in k'}))
  expect(handoff().data[1].y).toEqual(result.results[0].traces.k[1].y)
  expect(handoff().layout?.yaxis).toEqual(expect.objectContaining({title: {text: 'k^2 χ(k)'}}))
  fireEvent.click(screen.getByRole('button', {name: 'Plot in R'})); expect(handoff().data[1].y).toEqual(result.results[0].traces.R[1].y)
  expect(api).toHaveBeenCalledTimes(1)
  const next = savedProject(result); api.mockResolvedValueOnce(next); fireEvent.click(saveButton())
  await waitFor(() => expect(p.saved).toHaveBeenCalledWith(next)); expect(p.close).toHaveBeenCalledOnce()
  expect(api.mock.calls.at(-1)?.[1]).toEqual({version: 4, action: 'smooth', group_ids: ['g'], options: result.options})
})

it('retains SG controls, shares kernel size with repetitions, and sends even sizes for native coercion', async () => {
  api.mockImplementation(async (_path, body) => preview((body as {options: SmoothingPreview['options']}).options))
  render(<AthenaSmoothing {...props()}/>); await ready()
  change('Kernel size · points', '8'); expect(saveButton()).toBeDisabled(); await ready()
  expect(screen.getByText(/22 of 31 points remain/)).toBeVisible()
  change('Algorithm', 'gaussian'); change('Gaussian σ · samples', '1.25'); await ready()
  expect(api.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({options: {method: 'gaussian', window: 8, sigma: 1.25}}))
  change('Algorithm', 'savitzky_golay'); await ready()
  expect(screen.getByLabelText('Savitzky–Golay window · points')).toHaveValue(31)
  expect(api.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({options: {method: 'savitzky_golay', window: 31, order: 9}}))
  change('Polynomial order', ''); expect(saveButton()).toBeDisabled()
  change('Algorithm', 'three_point'); expect(screen.getByLabelText('Repetitions')).toHaveValue(8); change('Repetitions', '0'); await ready()
  expect(api.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({options: {method: 'three_point', repetitions: 0}}))
  change('Algorithm', 'gaussian'); expect(screen.getByLabelText('Kernel size · points')).toHaveValue(0)
  expect(screen.getByLabelText('Gaussian σ · samples')).toHaveValue(1.25)
}, 10000)

it('ignores late responses after input edits and rejects a response for an obsolete revision', async () => {
  let first!: (v: SmoothingPreview) => void
  api.mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValueOnce(preview({method: 'boxcar', window: 8}))
  render(<AthenaSmoothing {...props()}/>); await waitFor(() => expect(api).toHaveBeenCalledOnce())
  change('Kernel size · points', '8'); await ready(); await act(async () => first(preview()))
  expect(handoff().data[1].y).toEqual(preview({method: 'boxcar', window: 8}).results[0].smoothed_mu)
  api.mockResolvedValueOnce({...preview({method: 'boxcar', window: 9}), version: 3}); change('Kernel size · points', '9')
  expect(await screen.findByRole('alert')).toHaveTextContent('does not match'); expect(saveButton()).toBeDisabled()
})

it('invalidates source/revision changes immediately and keeps settings after conflicts', async () => {
  api.mockResolvedValueOnce(preview()).mockRejectedValue(new Error('Changed in another tab'))
  const p = props(), view = render(<AthenaSmoothing {...p}/>); await ready()
  view.rerender(<AthenaSmoothing {...p} project={{...project, version: 5}}/>); expect(saveButton()).toBeDisabled()
  expect(await screen.findByRole('alert')).toHaveTextContent('Changed in another tab')
  expect(screen.getByLabelText('Kernel size · points')).toHaveValue(11)
  const other = {...project.groups[0], id: 'other', label: 'Fe'}
  view.rerender(<AthenaSmoothing {...p} project={{...project, groups: [...project.groups, other]}} activeId="other"/>)
  expect(saveButton()).toBeDisabled(); expect(handoff().data).toHaveLength(1)
  await waitFor(() => expect(api.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({group_ids: ['other']})))
})

it.each(['missing curves', 'invalid values', 'wrong counts', 'wrong options'] as const)('rejects %s before enabling save', async problem => {
  const result = preview()
  if (problem === 'missing curves') result.results[0].traces.E = []
  if (problem === 'invalid values') result.results[0].traces.E[1].y[0] = NaN
  if (problem === 'wrong counts') result.results[0].details.trimmed_left = 4
  if (problem === 'wrong options') result.options = {method: 'gaussian', window: 11}
  api.mockResolvedValue(result); render(<AthenaSmoothing {...props()}/>)
  expect(await screen.findByRole('alert')).toHaveTextContent(/preview|data/); expect(saveButton()).toBeDisabled()
})

it.each(['conflict', 'wrong arrays', 'wrong parent'] as const)('keeps the draft and releases busy state after save returns %s', async problem => {
  const result = preview(), next = savedProject(result)
  api.mockResolvedValueOnce(result)
  if (problem === 'conflict') api.mockRejectedValueOnce(new Error('Changed in another tab'))
  else {
    if (problem === 'wrong arrays') next.groups[1] = {...next.groups[1], mu: next.groups[1].mu.map(v => v + .1)}
    if (problem === 'wrong parent') next.groups[1] = {...next.groups[1], source: {parent: 'other'}}
    api.mockResolvedValueOnce(next)
  }
  const p = props(); render(<AthenaSmoothing {...p}/>); await ready(); fireEvent.click(saveButton())
  expect(await screen.findByRole('alert')).toHaveTextContent(/Changed|could not be confirmed/)
  expect(p.saved).not.toHaveBeenCalled(); expect(p.close).not.toHaveBeenCalled(); expect(saveButton()).toBeDisabled()
  expect(p.setBusy).toHaveBeenLastCalledWith(''); expect(screen.getByLabelText('Kernel size · points')).toHaveValue(11)
  api.mockResolvedValueOnce(result); fireEvent.click(screen.getByRole('button', {name: 'Plot data and smoothed'})); await ready()
})

it('opens chi data in k space and explicitly reports unavailable energy comparisons', async () => {
  const p = props(); p.project = {...project, groups: [{...project.groups[0], data_type: 'chi'}]}
  const result = preview(); result.results[0].input_space = 'k'; result.results[0].data_type = 'chi'
  result.results[0].traces.E = []; result.results[0].errors.E = 'Energy comparison is unavailable for chi data.'
  api.mockResolvedValue(result); render(<AthenaSmoothing {...p}/>); await ready()
  expect(screen.getByRole('button', {name: 'Plot in k'})).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByRole('button', {name: 'Plot in energy'}))
  expect(screen.getByText('Energy comparison is unavailable for chi data.')).toBeVisible()
})
