import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AthenaBeamlineMetadata, AthenaBeamlinePreferences } from './athena-beamline-metadata'
import { athenaApi } from '@/lib/athena'

vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
afterEach(() => { cleanup(); api.mockReset() })

it('shows acquisition fields and comments as inert text, including date corrections', () => {
  render(<AthenaBeamlineMetadata value={{ reader: 'X11A', attributes: { facility: { name: 'NSLS' }, beamline: { name: 'X11A' },
    scan: { start_time: '1992-09-15T01:52:53' }, mono: { d_spacing: '3.135301' } },
    comments: ['<script>throw Error("bad")</script>'], warnings: ['Acquisition date corrected from original header.'], source_sha256: 'a'.repeat(64) }} />)
  expect(screen.getByText('NSLS · X11A · acquisition metadata')).toBeVisible()
  expect(screen.getByText('Acquired: 1992-09-15T01:52:53')).toBeVisible()
  expect(screen.getByText('Acquisition date corrected from original header.')).toBeVisible()
  fireEvent.click(screen.getByText('View beamline metadata'))
  expect(screen.getByRole('rowheader', { name: 'mono.d_spacing' })).toBeVisible()
  expect(screen.getByText('<script>throw Error("bad")</script>')).toBeVisible()
  expect(document.querySelector('script')).toBeNull()
})

it('handles absent and malformed metadata from imported projects', () => {
  const view = render(<AthenaBeamlineMetadata value={undefined} />)
  expect(screen.queryByRole('region')).toBeNull()
  view.rerender(<AthenaBeamlineMetadata value={{ reader: 'X11A', attributes: { mono: null }, comments: [], warnings: [] }} />)
  expect(screen.getByText(/cannot be displayed/)).toBeVisible()
})

it('displays native XDI versions, extension families and literal Unicode comments', () => {
  render(<AthenaBeamlineMetadata value={{ reader: 'XDI', input_basis: 'native project', xdi_version: '1.0', extra_version: 'GSE/1.0',
    attributes: { element: { symbol: 'Cu', edge: 'K' }, gse: { extra: 'extension value' } },
    comments: ['μ 铜 "quoted" $variable @array', '<script>text</script>'], warnings: [] }} />)
  expect(screen.getByRole('region', { name: 'XDI metadata' })).toBeVisible()
  expect(screen.getByText('XDI 1.0 · GSE/1.0')).toBeVisible()
  fireEvent.click(screen.getByText('View XDI metadata'))
  expect(screen.getByRole('rowheader', { name: 'gse.extra' })).toBeVisible()
  expect(screen.getByText('μ 铜 "quoted" $variable @array')).toBeVisible()
  expect(screen.getByText(/Restored from the native XDI project object/)).toBeVisible()
  expect(document.querySelector('script')).toBeNull()
})

it('loads, saves with a version, and reports persisted future-import behavior', async () => {
  api.mockResolvedValueOnce({ version: 2, enabled: true }).mockResolvedValueOnce({ version: 3, enabled: false })
  const close = vi.fn(); render(<AthenaBeamlinePreferences close={close} />)
  const checkbox = screen.getByRole('checkbox', { name: 'Identify beamline metadata on import' })
  expect(checkbox).toBeDisabled()
  await waitFor(() => expect(checkbox).toBeEnabled())
  fireEvent.click(checkbox); fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
  await screen.findByText('Settings saved. Inspect the file again to use this choice.')
  expect(api).toHaveBeenLastCalledWith('/preferences/beamline', { version: 2, enabled: false }, 'PUT')
  expect(checkbox).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' })); expect(close).toHaveBeenCalledOnce()
})

it('retains an unsaved switch on conflict and reloads the authoritative version', async () => {
  api.mockResolvedValueOnce({ version: 0, enabled: true }).mockRejectedValueOnce(new Error('Settings changed in another window.'))
    .mockResolvedValueOnce({ version: 4, enabled: true })
  render(<AthenaBeamlinePreferences close={() => {}} />)
  const checkbox = screen.getByRole('checkbox')
  await waitFor(() => expect(checkbox).toBeEnabled()); fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('changed in another window')
  expect(checkbox).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Reload settings' }))
  await screen.findByText('Settings reloaded.'); expect(checkbox).toBeChecked()
})

it('rejects malformed loads and unconfirmed saves and ignores late responses after close', async () => {
  api.mockResolvedValueOnce({ enabled: 'true' }).mockResolvedValueOnce({ version: 0, enabled: true })
    .mockResolvedValueOnce({ version: 0, enabled: false })
  const view = render(<AthenaBeamlinePreferences close={() => {}} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read')
  expect(screen.getByRole('checkbox')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload settings' }))
  await screen.findByText('Settings reloaded.'); fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
  let finish!: (value: unknown) => void
  api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Reload settings' })); view.unmount()
  await act(async () => { finish({ version: 10, enabled: true }) })
  expect(screen.queryByRole('region')).toBeNull()
})
