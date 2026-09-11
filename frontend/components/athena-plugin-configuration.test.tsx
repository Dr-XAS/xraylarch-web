import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AthenaPluginConfiguration } from './athena-plugin-configuration'
import { applyPluginConfiguration, loadPluginConfiguration, type PluginConfiguration } from '@/lib/athena-preferences'

vi.mock('@/lib/athena-preferences', () => ({ applyPluginConfiguration: vi.fn(), loadPluginConfiguration: vi.fn() }))
const defaults = { energy: 1, i0: 6, narrow: 7, wide: 9, trans: 8 }
const initial: PluginConfiguration = { reader: 'X15B', version: 0, session_id: 'server-a', unsaved: false,
  values: defaults, saved: defaults, defaults, fields: Object.keys(defaults).map(name => ({
    name, title: `${name} column`, type: 'integer', minimum: 1, maximum: 14,
  })) }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(loadPluginConfiguration).mockResolvedValue(structuredClone(initial)) })
afterEach(cleanup)
async function open() {
  render(<AthenaPluginConfiguration reader="X15B" />)
  return screen.findByRole('spinbutton', { name: 'i0 column' })
}

it('applies only on demand and distinguishes current, saved and factory values', async () => {
  const input = await open()
  fireEvent.change(input, { target: { value: '7' } })
  expect(applyPluginConfiguration).not.toHaveBeenCalled()
  const values = { ...defaults, i0: 7 }
  vi.mocked(applyPluginConfiguration).mockResolvedValueOnce({ ...initial, version: 1, values, unsaved: true })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  await screen.findByText(/Applied for this server session/)
  expect(applyPluginConfiguration).toHaveBeenLastCalledWith('X15B', { version: 0, session_id: 'server-a', values, save: false })
  expect(screen.getByText('Current: 7 · Saved: 6 · Default: 6')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Use saved values' }))
  expect(input).toHaveValue(6)
  fireEvent.click(screen.getByRole('button', { name: 'Use current values' }))
  expect(input).toHaveValue(7)
  expect(applyPluginConfiguration).toHaveBeenCalledTimes(1)
  vi.mocked(applyPluginConfiguration).mockResolvedValueOnce({ ...initial, version: 2, values, saved: values })
  fireEvent.click(screen.getByRole('button', { name: 'Apply and Save' }))
  await screen.findByText(/Applied and saved reader settings/)
  expect(applyPluginConfiguration).toHaveBeenLastCalledWith('X15B', { version: 1, session_id: 'server-a', values, save: true })
  expect(screen.getByText('Current: 7 · Saved: 7 · Default: 6')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Use Athena defaults' }))
  expect(input).toHaveValue(6)
  expect(applyPluginConfiguration).toHaveBeenCalledTimes(2)
})

it.each(['', '0', '15', '1.5'])('blocks invalid binary source column %j before applying', async value => {
  const input = await open(); fireEvent.change(input, { target: { value } })
  expect(screen.getByRole('alert')).toHaveTextContent('Check i0 column')
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Apply and Save' })).toBeDisabled()
  expect(applyPluginConfiguration).not.toHaveBeenCalled()
})

it('validates named channels, positive integration time and the time-source choice', async () => {
  const values = { time: 'column', inttime: 1, intcol: 'inttime' }
  vi.mocked(loadPluginConfiguration).mockResolvedValue({ ...initial, reader: 'X23A2MED', values, saved: values, defaults: values,
    fields: [{ name: 'time', title: 'Time source', type: 'string', enum: ['column', 'constant'] },
      { name: 'inttime', title: 'Integration time', type: 'number', exclusiveMinimum: 0 },
      { name: 'intcol', title: 'Time label', type: 'string', maxLength: 128 }] })
  render(<AthenaPluginConfiguration reader="X23A2MED" />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Time source' }), { target: { value: 'constant' } })
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } })
  expect(screen.getByRole('alert')).toHaveTextContent('Check integration time')
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: ' ' } })
  expect(screen.getByRole('alert')).toHaveTextContent('Check time label')
  expect(applyPluginConfiguration).not.toHaveBeenCalled()
})

it('keeps a draft after a stale write and reloads the actual server session before retry', async () => {
  const input = await open(); fireEvent.change(input, { target: { value: '7' } })
  vi.mocked(applyPluginConfiguration).mockRejectedValueOnce(new Error('Reader configuration changed or the server restarted.'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('server restarted')
  expect(input).toHaveValue(7)
  const restarted = { ...initial, session_id: 'server-b', version: 2, values: { ...defaults, i0: 8 } }
  vi.mocked(loadPluginConfiguration).mockResolvedValueOnce(restarted)
  fireEvent.click(screen.getByRole('button', { name: 'Reload configuration' }))
  await screen.findByText('Configuration reloaded.'); expect(input).toHaveValue(8)
  vi.mocked(applyPluginConfiguration).mockResolvedValueOnce({ ...restarted, version: 3, saved: restarted.values })
  fireEvent.click(screen.getByRole('button', { name: 'Apply and Save' }))
  await screen.findByText(/Applied and saved/)
  expect(applyPluginConfiguration).toHaveBeenLastCalledWith('X15B', { version: 2, session_id: 'server-b', values: restarted.values, save: true })
})

it('locks edits and reload during a pending write, then releases the host', async () => {
  let finish!: (value: PluginConfiguration) => void
  vi.mocked(applyPluginConfiguration).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = vi.fn(); render(<AthenaPluginConfiguration reader="X15B" onPendingChange={pending} />)
  await screen.findByRole('spinbutton', { name: 'i0 column' })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(pending).toHaveBeenLastCalledWith(true)
  expect(screen.getByRole('spinbutton', { name: 'i0 column' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Reload configuration' })).toBeDisabled()
  await act(async () => finish({ ...initial, version: 1 }))
  expect(pending).toHaveBeenLastCalledWith(false)
  expect(screen.getByRole('spinbutton', { name: 'i0 column' })).toBeEnabled()
})

it.each([{ ...initial, version: 5 }, { ...initial, version: 1, session_id: 'other' },
  { ...initial, version: 1, values: { ...defaults, i0: 8 } }, { ...initial, version: 1, unsaved: true }])(
  'rejects an unconfirmed Apply and Save response', async response => {
    await open(); vi.mocked(applyPluginConfiguration).mockResolvedValueOnce(response)
    fireEvent.click(screen.getByRole('button', { name: 'Apply and Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
    expect(screen.queryByText(/Applied and saved/)).not.toBeInTheDocument()
  })

it('recovers from a failed initial load without writing unknown configuration', async () => {
  vi.mocked(loadPluginConfiguration).mockRejectedValueOnce(new Error('Backend unavailable'))
  render(<AthenaPluginConfiguration reader="X15B" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Backend unavailable')
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload configuration' }))
  expect(await screen.findByRole('spinbutton', { name: 'i0 column' })).toHaveValue(6)
})

it('ignores a stale response after StrictMode cleanup', async () => {
  let first!: (value: PluginConfiguration) => void
  vi.mocked(loadPluginConfiguration).mockReturnValueOnce(new Promise(resolve => { first = resolve }))
  vi.mocked(loadPluginConfiguration).mockResolvedValueOnce({ ...initial, version: 2, values: { ...defaults, i0: 8 } })
  render(<StrictMode><AthenaPluginConfiguration reader="X15B" /></StrictMode>)
  const input = await screen.findByRole('spinbutton', { name: 'i0 column' })
  expect(input).toHaveValue(8)
  await act(async () => first(initial)); expect(input).toHaveValue(8)
  await waitFor(() => expect(input).toBeEnabled())
})

it('applies a boolean reference switch and an explicitly empty temperature label, then restores defaults', async () => {
  const values = { reference: true, temperature_column: 'mcs6', eshift1: 0 }
  const config: PluginConfiguration = { ...initial, reader: '10BMMultiChannel', values, saved: values, defaults: values,
    fields: [{ name: 'reference', title: 'Import reference channel', type: 'boolean' },
      { name: 'temperature_column', title: 'Temperature column label', type: 'string', minLength: 0, maxLength: 128 },
      { name: 'eshift1', title: 'Channel 1 energy shift (eV)', type: 'number' }] }
  vi.mocked(loadPluginConfiguration).mockResolvedValue(config)
  render(<AthenaPluginConfiguration reader="10BMMultiChannel" />)
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Import reference channel' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-2.5' } })
  const changed = { reference: false, temperature_column: '', eshift1: -2.5 }
  vi.mocked(applyPluginConfiguration).mockResolvedValueOnce({ ...config, version: 1, values: changed, saved: changed })
  fireEvent.click(screen.getByRole('button', { name: 'Apply and Save' }))
  await screen.findByText(/Applied and saved/)
  expect(applyPluginConfiguration).toHaveBeenCalledWith('10BMMultiChannel', { version: 0, session_id: 'server-a', values: changed, save: true })
  expect(screen.getByText('Current: false · Saved: false · Default: true')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Use Athena defaults' }))
  expect(screen.getByRole('checkbox')).toBeChecked()
  expect(screen.getByRole('textbox')).toHaveValue('mcs6')
  expect(screen.getByRole('spinbutton')).toHaveValue(0)
})
