import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AthenaPluginRegistry } from './athena-plugin-registry'
import { loadPluginRegistry, savePluginRegistry, importPluginRegistry, loadPluginConfiguration, applyPluginConfiguration, type PluginRegistry, type PluginConfiguration } from '@/lib/athena-preferences'

vi.mock('@/lib/athena-preferences', () => ({ loadPluginRegistry: vi.fn(), savePluginRegistry: vi.fn(), importPluginRegistry: vi.fn(), loadPluginConfiguration: vi.fn(), applyPluginConfiguration: vi.fn() }))
const id = 'Demeter::Plugins::X10C', unknown = 'Demeter::Plugins::SSRLA'
const blank: PluginRegistry = { version: 0, enabled: {}, plugins: [{ id, name: 'X10C', version: '0.1', origin: 'system',
  description: 'NSLS beamline X10C', documentation: 'Transmission uses columns 4 and 6.', documentation_url: 'https://github.com/bruceravel/demeter/X10C.pm' }] }
afterEach(cleanup)
beforeEach(() => { vi.resetAllMocks(); vi.mocked(loadPluginRegistry).mockResolvedValue(structuredClone(blank)) })

it('loads native unchecked defaults, documentation, and exchange controls', async () => {
  render(<AthenaPluginRegistry />)
  const toggle = await screen.findByRole('checkbox', { name: 'Enable X10C' })
  expect(toggle).not.toBeChecked(); expect(toggle).toBeEnabled()
  fireEvent.click(screen.getByText('X10C documentation'))
  expect(screen.getByText('Transmission uses columns 4 and 6.')).toBeVisible()
  expect(screen.getByRole('link', { name: 'Original X10C documentation' })).toHaveAttribute('target', '_blank')
  expect(screen.getByRole('link', { name: 'Export Athena registry' })).toHaveAttribute('href', '/api/backend/api/athena/preferences/plugins/export')
})

it('saves one toggle immediately, serializes pending changes and retains unknown native flags', async () => {
  vi.mocked(loadPluginRegistry).mockResolvedValue({ ...blank, enabled: { [unknown]: true } })
  let finish!: (value: PluginRegistry) => void
  vi.mocked(savePluginRegistry).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const pending = vi.fn(); render(<AthenaPluginRegistry onPendingChange={pending} />)
  const toggle = await screen.findByRole('checkbox', { name: 'Enable X10C' })
  fireEvent.click(toggle)
  expect(savePluginRegistry).toHaveBeenCalledWith({ version: 0, enabled: { [unknown]: true, [id]: true } })
  expect(toggle).toBeDisabled(); expect(toggle).not.toBeChecked()
  fireEvent.click(toggle); expect(savePluginRegistry).toHaveBeenCalledTimes(1)
  await act(async () => finish({ ...blank, version: 1, enabled: { [unknown]: true, [id]: true } }))
  expect(toggle).toBeChecked(); expect(toggle).toBeEnabled()
  expect(pending).toHaveBeenLastCalledWith(false)
  fireEvent.click(screen.getByText('Settings for 1 unavailable plugins'))
  expect(screen.getByText('SSRLA · saved as enabled')).toBeVisible()
})

it('keeps accepted switches on failed save and reloads before using another window’s version', async () => {
  vi.mocked(savePluginRegistry).mockRejectedValueOnce(new Error('File-plugin settings changed in another window.'))
  render(<AthenaPluginRegistry />)
  const toggle = await screen.findByRole('checkbox', { name: 'Enable X10C' })
  fireEvent.click(toggle)
  await screen.findByRole('alert'); expect(toggle).not.toBeChecked()
  vi.mocked(loadPluginRegistry).mockResolvedValue({ ...blank, version: 3, enabled: { [id]: true } })
  fireEvent.click(screen.getByRole('button', { name: 'Reload plugin settings' }))
  await waitFor(() => expect(toggle).toBeChecked())
  vi.mocked(savePluginRegistry).mockResolvedValue({ ...blank, version: 4, enabled: { [id]: false } })
  fireEvent.click(toggle)
  await waitFor(() => expect(savePluginRegistry).toHaveBeenLastCalledWith({ version: 3, enabled: { [id]: false } }))
  await waitFor(() => expect(toggle).toBeEnabled())
})

const unconfirmedSaves: PluginRegistry[] = [{ ...blank, version: 5, enabled: { [id]: true } }, { ...blank, version: 1, enabled: {} }]
it.each(unconfirmedSaves)('requires a confirmed save response', async response => {
  vi.mocked(savePluginRegistry).mockResolvedValue(response)
  render(<AthenaPluginRegistry />)
  const toggle = await screen.findByRole('checkbox', { name: 'Enable X10C' }); fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
  expect(toggle).not.toBeChecked()
})

it('imports a native file and applies only the returned saved registry', async () => {
  vi.mocked(importPluginRegistry).mockResolvedValue({ ...blank, version: 1, enabled: { [id]: true, [unknown]: false } })
  render(<AthenaPluginRegistry />)
  const toggle = await screen.findByRole('checkbox', { name: 'Enable X10C' })
  const file = new File(['---\nDemeter::Plugins::X10C: 1'], 'athena.plugin_registry')
  fireEvent.change(screen.getByLabelText('Import Athena plugin registry file'), { target: { files: [file] } })
  await waitFor(() => expect(toggle).toBeChecked())
  expect(importPluginRegistry).toHaveBeenCalledWith(0, file)
  expect(screen.getByText('Settings for 1 unavailable plugins')).toBeInTheDocument()
  expect(screen.getByLabelText('Import Athena plugin registry file')).toHaveValue('')
})

it('retains saved registry and allows retry after a failed file import', async () => {
  vi.mocked(importPluginRegistry).mockRejectedValue(new Error('Invalid Athena YAML mapping.'))
  render(<AthenaPluginRegistry />); await screen.findByRole('checkbox', { name: 'Enable X10C' })
  const file = new File(['bad: value'], 'registry')
  fireEvent.change(screen.getByLabelText('Import Athena plugin registry file'), { target: { files: [file] } })
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid Athena YAML')
  expect(screen.getByRole('checkbox', { name: 'Enable X10C' })).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Import Athena registry…' })).toBeEnabled()
})

it('recovers an initial loading error without enabling writes against unknown state', async () => {
  vi.mocked(loadPluginRegistry).mockRejectedValueOnce(new Error('Backend unavailable'))
  render(<AthenaPluginRegistry />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Backend unavailable')
  expect(screen.getByRole('button', { name: 'Import Athena registry…' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload plugin settings' }))
  expect(await screen.findByRole('checkbox', { name: 'Enable X10C' })).toBeEnabled()
})

it.each([null, { ...blank, version: -1 }, { ...blank, enabled: { [id]: 1 } }, { ...blank, plugins: [null] }])('rejects malformed registry responses', async value => {
  vi.mocked(loadPluginRegistry).mockResolvedValue(value as unknown as PluginRegistry)
  render(<AthenaPluginRegistry />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the plugin registry')
  expect(screen.getByRole('button', { name: 'Import Athena registry…' })).toBeDisabled()
})

it('ignores a stale initial response after StrictMode remount', async () => {
  let first!: (v: PluginRegistry) => void
  vi.mocked(loadPluginRegistry).mockReturnValueOnce(new Promise(resolve => { first = resolve }))
  vi.mocked(loadPluginRegistry).mockResolvedValue({ ...blank, version: 2, enabled: { [id]: true } })
  render(<StrictMode><AthenaPluginRegistry /></StrictMode>)
  const toggle = await screen.findByRole('checkbox', { name: 'Enable X10C' })
  expect(toggle).toBeChecked()
  await act(async () => first(blank))
  expect(toggle).toBeChecked()
})

it('configures a real reader and locks registry actions until its apply finishes', async () => {
  vi.mocked(loadPluginRegistry).mockResolvedValue({ ...blank, plugins: [...blank.plugins, { ...blank.plugins[0],
    id: 'Demeter::Plugins::X15B', name: 'X15B', configurable: true }] })
  const config: PluginConfiguration = { reader: 'X15B', version: 0, session_id: 'session', values: { i0: 6 },
    saved: { i0: 6 }, defaults: { i0: 6 }, unsaved: false, fields: [{ name: 'i0', title: 'I0 column', type: 'integer', minimum: 1, maximum: 14 }] }
  vi.mocked(loadPluginConfiguration).mockResolvedValue(config)
  let finish!: (value: PluginConfiguration) => void
  vi.mocked(applyPluginConfiguration).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = vi.fn(); render(<AthenaPluginRegistry onPendingChange={pending} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Configure X15B' }))
  expect(await screen.findByRole('spinbutton', { name: 'I0 column' })).toHaveValue(6)
  expect(screen.queryByRole('button', { name: 'Configure X10C' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(pending).toHaveBeenLastCalledWith(true)
  expect(screen.getByRole('checkbox', { name: 'Enable X10C' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Configure X15B' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Reload plugin settings' })).toBeDisabled()
  expect(screen.queryByRole('link', { name: 'Export Athena registry' })).not.toBeInTheDocument()
  await act(async () => finish({ ...config, version: 1 }))
  expect(pending).toHaveBeenLastCalledWith(false)
  expect(screen.getByRole('checkbox', { name: 'Enable X10C' })).toBeEnabled()
  expect(savePluginRegistry).not.toHaveBeenCalled()
})
