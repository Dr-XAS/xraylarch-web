import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RebinDefaultsControls, gridValues, useRebinDefaults } from './athena-rebin-defaults'
import { defaultRebin } from '@/lib/athena-import'

const { load, save } = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/athena-preferences', () => ({ loadRebinDefaults: load, saveRebinDefaults: save }))
const initial = () => ({ version: 4, grid: { ...gridValues(defaultRebin), pre: 5 } })
function Harness() {
  const state = useRebinDefaults()
  return <><input aria-label="grid pre" type="number" value={state.grid.pre}
    onChange={e => state.edit({ ...state.grid, pre: e.target.value === '' ? '' : Number(e.target.value) })} />
    <button onClick={() => state.adopt(gridValues(defaultRebin))}>Adopt import grid</button>
    <output data-testid="grid">{JSON.stringify(state.grid)}</output><RebinDefaultsControls state={state} /></>
}
const change = (value: string) => fireEvent.change(screen.getByLabelText('grid pre'), { target: { value } })
const loaded = () => screen.findByText('Saved grid defaults loaded.')
beforeEach(() => { load.mockReset().mockResolvedValue(initial()); save.mockReset().mockImplementation(async r => ({ ...r, version: r.version + 1 })) })
afterEach(cleanup)

it('loads shared defaults and saves only the grid, separately from E0 and enablement', async () => {
  render(<Harness />); await loaded(); expect(screen.getByLabelText('grid pre')).toHaveValue(5)
  change('7'); fireEvent.click(screen.getByRole('button', { name: 'Save grid as defaults' }))
  await screen.findByText('Grid defaults saved for future sessions.')
  expect(save).toHaveBeenCalledWith({ version: 4, grid: { ...initial().grid, pre: 7 } })
  fireEvent.click(screen.getByRole('button', { name: 'Use Athena default grid' }))
  expect(screen.getByLabelText('grid pre')).toHaveValue(10)
  expect(save).toHaveBeenCalledTimes(1)
})

it('keeps edits made while loading and aborts a request on unmount', async () => {
  let finish!: (v: unknown) => void
  load.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const view = render(<Harness />); change('7')
  await act(async () => finish(initial()))
  expect(screen.getByLabelText('grid pre')).toHaveValue(7)
  expect(screen.getByText(/newer grid edits are kept/)).toBeInTheDocument()
  view.unmount(); expect(load.mock.calls[0][0].aborted).toBe(true)
})

it('lets a restored import grid take precedence even when equal to the initial grid', async () => {
  let finish!: (v: unknown) => void
  load.mockReturnValue(new Promise(resolve => { finish = resolve }))
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Adopt import grid' }))
  await act(async () => finish(initial()))
  expect(screen.getByLabelText('grid pre')).toHaveValue(10)
  expect(screen.getByText(/newer grid edits are kept/)).toBeInTheDocument()
})

it('rejects malformed stored values, retains the draft and recovers through Load saved grid', async () => {
  load.mockResolvedValueOnce({ ...initial(), grid: { ...initial().grid, pre: '5' } })
  render(<Harness />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read saved rebin defaults')
  expect(screen.getByRole('button', { name: 'Save grid as defaults' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Load saved grid' })); await loaded()
  expect(screen.getByLabelText('grid pre')).toHaveValue(5)
})

it('does not save invalid drafts or overwrite them on a failed save; reload resolves a version conflict', async () => {
  render(<Harness />); await loaded(); change('')
  expect(screen.getByRole('button', { name: 'Save grid as defaults' })).toBeDisabled()
  change('7'); save.mockRejectedValueOnce(new Error('Rebin defaults changed in another window.'))
  fireEvent.click(screen.getByRole('button', { name: 'Save grid as defaults' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('another window')
  expect(screen.getByLabelText('grid pre')).toHaveValue(7)
  load.mockResolvedValue({ version: 5, grid: { ...initial().grid, pre: 8 } })
  fireEvent.click(screen.getByRole('button', { name: 'Load saved grid' })); await loaded()
  change('6'); fireEvent.click(screen.getByRole('button', { name: 'Save grid as defaults' }))
  await screen.findByText('Grid defaults saved for future sessions.')
  expect(save.mock.calls.at(-1)![0]).toMatchObject({ version: 5, grid: { pre: 6 } })
})

it('saves a snapshot once and preserves newer edits while the response is pending', async () => {
  let finish!: (v: unknown) => void
  save.mockReturnValue(new Promise(resolve => { finish = resolve }))
  render(<Harness />); await loaded(); change('7')
  fireEvent.click(screen.getByRole('button', { name: 'Save grid as defaults' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save grid as defaults' })); change('9')
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => finish({ version: 5, grid: { ...initial().grid, pre: 7 } }))
  expect(screen.getByLabelText('grid pre')).toHaveValue(9)
  save.mockImplementation(async r => ({ ...r, version: r.version + 1 }))
  fireEvent.click(screen.getByRole('button', { name: 'Save grid as defaults' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  expect(save.mock.calls[1][0]).toMatchObject({ version: 5, grid: { pre: 9 } })
})

it('does not claim an unconfirmed response was saved', async () => {
  save.mockResolvedValue({ version: 5, grid: { ...initial().grid, pre: 20 } })
  render(<Harness />); await loaded(); change('7')
  fireEvent.click(screen.getByRole('button', { name: 'Save grid as defaults' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
  expect(screen.queryByText('Grid defaults saved for future sessions.')).not.toBeInTheDocument()
  expect(screen.getByLabelText('grid pre')).toHaveValue(7)
})
