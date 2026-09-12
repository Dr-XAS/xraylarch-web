import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SmoothingDefaults, useSmoothingPreferences } from './athena-smoothing-defaults'
import { applySmoothingPreferences, loadSmoothingPreferences, type SGPreferences } from '@/lib/athena-smoothing-preferences'

vi.mock('@/lib/athena-smoothing-preferences', () => ({loadSmoothingPreferences: vi.fn(), applySmoothingPreferences: vi.fn()}))
const load = vi.mocked(loadSmoothingPreferences), apply = vi.mocked(applySmoothingPreferences)
const state = (): SGPreferences => ({version: 0, session_id: 'session', values: {window: 21, order: 11}, saved: {window: 31, order: 9}, defaults: {window: 31, order: 9}, unsaved: true})
function Harness({adopt = true}: {adopt?: boolean}) {
  const [draft, setDraft] = useState({window: '31', order: '9'})
  const p = useSmoothingPreferences(draft, v => setDraft({window: String(v.window), order: String(v.order)}), adopt)
  return <><label>Window<input value={draft.window} onChange={e => setDraft(d => ({...d, window: e.target.value}))}/></label>
    <label>Order<input value={draft.order} onChange={e => setDraft(d => ({...d, order: e.target.value}))}/></label>
    <SmoothingDefaults preferences={p} disabled={false}/></>
}
const button = (name: string) => screen.getByRole('button', {name})
const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), {target: {value}})
const ready = async () => {await waitFor(() => expect(button('Apply')).toBeEnabled())}
beforeEach(() => {load.mockResolvedValue(state())})
afterEach(() => {cleanup(); vi.clearAllMocks(); load.mockReset(); apply.mockReset()})

it('loads applied preferences, distinguishes saved/default values, and applies without persistence', async () => {
  apply.mockImplementation(async req => ({...state(), version: req.version + 1, values: req.values}))
  render(<Harness/>); await ready(); expect(screen.getByLabelText('Window')).toHaveValue('21')
  expect(screen.getByText(/Current: 21 \/ 11 · Saved: 31 \/ 9 · Default: 31 \/ 9/)).toBeVisible()
  change('Window', '13'); fireEvent.click(button('Apply'))
  await waitFor(() => expect(apply).toHaveBeenCalledWith({version: 0, session_id: 'session', values: {window: 13, order: 11}, save: false}))
  expect(await screen.findByText('Smoothing preferences applied for this server session.')).toBeVisible()
})

it('copies current/saved/default values without applying and explicitly persists both values', async () => {
  apply.mockImplementation(async req => ({...state(), version: req.version + 1, values: req.values, saved: req.values, unsaved: false}))
  render(<Harness/>); await ready(); fireEvent.click(button('Use saved values'))
  expect(screen.getByLabelText('Window')).toHaveValue('31'); expect(screen.getByLabelText('Order')).toHaveValue('9')
  fireEvent.click(button('Use current values')); expect(screen.getByLabelText('Window')).toHaveValue('21')
  fireEvent.click(button('Use Athena defaults')); expect(screen.getByLabelText('Order')).toHaveValue('9'); expect(apply).not.toHaveBeenCalled()
  change('Window', '17'); change('Order', '12'); fireEvent.click(button('Apply and Save'))
  expect(await screen.findByText('Smoothing preferences applied and saved for future starts.')).toBeVisible()
  expect(apply).toHaveBeenCalledWith({version: 0, session_id: 'session', values: {window: 17, order: 12}, save: true})
  expect(screen.queryByText('Session preferences have not been saved for the next start.')).not.toBeInTheDocument()
})

it.each([false, true])('keeps newer edits during a late initial load, including reverted edits=%s', async revert => {
  let resolve!: (v: SGPreferences) => void; load.mockImplementationOnce(() => new Promise(r => {resolve = r}))
  render(<Harness/>); change('Window', '15'); if (revert) change('Window', '31')
  await act(async () => resolve(state())); await ready()
  expect(screen.getByLabelText('Window')).toHaveValue(revert ? '31' : '15')
  expect(screen.getByText('Preferences loaded; your current filter choices are kept.')).toBeVisible()
})

it('refreshes preference metadata without overwriting retained session controls', async () => {
  render(<Harness adopt={false}/>); await ready()
  expect(screen.getByLabelText('Window')).toHaveValue('31')
  fireEvent.click(button('Reload preferences')); await waitFor(() => expect(screen.getByLabelText('Window')).toHaveValue('21'))
})

it('cannot apply an invalid native preference range', async () => {
  render(<Harness/>); await ready()
  for (const [name, value] of [['Window','40'],['Window','1.5'],['Window',''],['Order','4']]) {
    change(name, value); expect(button('Apply')).toBeDisabled(); expect(button('Apply and Save')).toBeDisabled()
    change(name, name === 'Window' ? '31' : '9')
  }
  expect(apply).not.toHaveBeenCalled()
})

it('preserves fields on conflict, disables stale writes and supports explicit reload/retry', async () => {
  apply.mockRejectedValueOnce(new Error('Smoothing preferences changed or the server restarted.'))
  render(<Harness/>); await ready(); change('Window','17'); fireEvent.click(button('Apply and Save'))
  expect(await screen.findByRole('alert')).toHaveTextContent('preferences changed')
  expect(screen.getByLabelText('Window')).toHaveValue('17'); expect(button('Apply')).toBeDisabled(); expect(button('Reload preferences')).toBeEnabled()
  load.mockResolvedValueOnce({...state(),version: 2,values: {window: 19,order: 11}})
  fireEvent.click(button('Reload preferences')); await ready(); expect(screen.getByLabelText('Window')).toHaveValue('19')
  apply.mockResolvedValueOnce({...state(),version: 3,values: {window: 19,order: 11},saved: {window: 19,order: 11},unsaved: false})
  fireEvent.click(button('Apply and Save'))
  expect(await screen.findByText('Smoothing preferences applied and saved for future starts.')).toBeVisible()
})

it('a completed save cannot overwrite edits made while the request was in flight', async () => {
  let resolve!: (v: SGPreferences) => void; apply.mockImplementationOnce(() => new Promise(r => {resolve = r}))
  render(<Harness/>); await ready(); fireEvent.click(button('Apply and Save')); change('Window','17')
  await act(async () => resolve({...state(),version: 1,saved: state().values,unsaved: false}))
  expect(screen.getByLabelText('Window')).toHaveValue('17'); expect(button('Apply')).toBeEnabled()
})

it('rejects mismatched saved values and never accepts a late reply after unmount', async () => {
  apply.mockResolvedValueOnce({...state(),version: 1,saved: {window: 17,order: 11},unsaved: false})
  const view = render(<Harness/>); await ready(); fireEvent.click(button('Apply and Save'))
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed'); expect(button('Apply')).toBeDisabled()
  view.unmount(); let resolve!: (v: SGPreferences) => void
  load.mockImplementationOnce(() => new Promise(r => {resolve = r}))
  const second = render(<Harness/>); second.unmount(); await act(async () => resolve(state()))
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
})
