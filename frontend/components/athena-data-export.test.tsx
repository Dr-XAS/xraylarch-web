import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaDataExport } from './athena-data-export'

vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const project = { id: 'p', version: 4, groups: [{ id: 'cu', label: 'Cu foil', marked: true }, { id: 'fe', label: 'Fe foil', marked: true }] } as AthenaProject
const data = { version: 4, project_id: 'p', files: [{ filename: 'cu.xmu', rows: 408, group_ids: ['cu'],
  columns: [{ name: 'energy', unit: 'eV' }, { name: 'xmu', unit: '' }], sample: [[8970, 1], [8980, 2]],
  warnings: [], notes: [], header: ['XDI/1.0 XrayLarch/0.1.0', 'Column.1: energy eV'] }] }
const props = () => ({ project, groupId: 'cu', close: vi.fn(), onBusyChange: vi.fn() })
afterEach(() => { cleanup(); api.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function ready() { await screen.findByText('408 rows · 2 columns') }

it('previews the current applied revision and exact server columns and header', async () => {
  api.mockResolvedValue(data); render(<AthenaDataExport {...props()} />); await ready()
  expect(api).toHaveBeenCalledWith('/projects/p/export-data/preview',
    { version: 4, scope: 'current', group_id: 'cu', form: 'xmu', kweight: 'all', arbitrary_kweight: null, with_multipliers: false }, 'POST', expect.any(AbortSignal))
  expect(screen.getByRole('table')).toHaveAccessibleName('cu.xmu first five rows')
  fireEvent.click(screen.getByText('File header and processing parameters'))
  expect(screen.getByText(/Column.1: energy eV/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Download column file' })).toBeEnabled()
})

it('supports all marked forms, legal multiplier choices, separate files and arbitrary weights', async () => {
  api.mockResolvedValue(data); render(<AthenaDataExport {...props()} />); await ready()
  fireEvent.change(screen.getByLabelText('Export groups'), { target: { value: 'marked' } })
  await waitFor(() => expect(api).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ scope: 'marked' }), 'POST', expect.any(AbortSignal)))
  expect(screen.getByLabelText('Data form').querySelectorAll('option')).toHaveLength(19)
  expect(api.mock.calls.at(-1)?.[1]).not.toHaveProperty('group_id')
  fireEvent.click(screen.getByLabelText("Apply each group's plot multiplier"))
  await waitFor(() => expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ with_multipliers: true }))
  fireEvent.change(screen.getByLabelText('Data form'), { target: { value: 'norm' } })
  await waitFor(() => expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ form: 'norm', with_multipliers: false }))
  fireEvent.change(screen.getByLabelText('Export groups'), { target: { value: 'each' } })
  fireEvent.change(screen.getByLabelText('Data form'), { target: { value: 'chi' } })
  fireEvent.change(screen.getByLabelText('Output k weight'), { target: { value: 'kw' } })
  fireEvent.click(screen.getByLabelText('Use a shared output weight'))
  fireEvent.change(screen.getByLabelText('Arbitrary output k weight'), { target: { value: '1.5' } })
  await waitFor(() => expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ scope: 'each', form: 'chi', kweight: 'kw', arbitrary_kweight: 1.5 }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Download ZIP' })).toBeEnabled())
})

it('keeps choices after preview errors and invalid weights cannot download an older preview', async () => {
  api.mockRejectedValueOnce(new Error('Grids differ')).mockResolvedValue(data)
  render(<AthenaDataExport {...props()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Grids differ')
  expect(screen.getByRole('button', { name: 'Download column file' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry preview' })); await ready()
  fireEvent.change(screen.getByLabelText('Data form'), { target: { value: 'chi' } })
  fireEvent.change(screen.getByLabelText('Output k weight'), { target: { value: 'kw' } })
  fireEvent.click(screen.getByLabelText('Use a shared output weight'))
  fireEvent.change(screen.getByLabelText('Arbitrary output k weight'), { target: { value: '' } })
  expect(screen.getByRole('alert')).toHaveTextContent('finite output weight')
  expect(screen.getByRole('button', { name: 'Download column file' })).toBeDisabled()
})

it('ignores late previews and rejects malformed output data', async () => {
  let first!: (value: unknown) => void
  api.mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValueOnce(data)
  render(<AthenaDataExport {...props()} />)
  fireEvent.change(screen.getByLabelText('Data form'), { target: { value: 'norm' } }); await ready()
  await act(async () => { first({ ...data, files: [] }) })
  expect(screen.queryByRole('alert')).toBeNull()
  api.mockResolvedValueOnce({ ...data, version: 3 })
  fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
  expect(screen.getByRole('button', { name: 'Download column file' })).toBeDisabled()
})

it('reports download conflicts without starting a browser download', async () => {
  api.mockResolvedValue(data)
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'stale_revision', message: 'Reload this project before exporting.' } }), { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<AthenaDataExport {...props()} />); await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Download column file' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Reload this project')
  expect(click).not.toHaveBeenCalled()
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ version: 4, group_id: 'cu' })
})

it('downloads only confirmed nonempty content and blocks duplicate pending downloads', async () => {
  api.mockResolvedValue(data)
  let finish!: (value: Response) => void
  const fetcher = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  const create = vi.fn().mockReturnValue('blob:export')
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const p = props(); render(<AthenaDataExport {...p} />); await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Download column file' }))
  expect(screen.getByRole('button', { name: 'Preparing download…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Close export' })).toBeDisabled()
  await act(async () => { finish(new Response('# column data\n8970 1', { headers: { 'X-Athena-Project-Version': '4', 'Content-Disposition': 'attachment; filename="Cu.xmu"' } })) })
  expect(await screen.findByText('Downloaded Cu.xmu')).toBeVisible()
  expect(fetcher).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce()
  expect(create).toHaveBeenCalledOnce(); expect(p.onBusyChange).toHaveBeenLastCalledWith(false)
})
