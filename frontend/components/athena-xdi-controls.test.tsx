import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { athenaApi } from '@/lib/athena'
import { AthenaXDIControls, type XDIMetadata } from './athena-xdi-controls'

vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const data: XDIMetadata = { version: 3, group_id: 'cu', label: 'Cu foil', xdi_version: '1.0', extra_version: 'GSE/1.0',
  families: [{ name: 'Element', fields: { symbol: 'Cu', edge: 'K' } }, { name: 'Mono', fields: { d_spacing: '-1' } }],
  comments: 'Original\ncomments', required: [{ field: 'Element.symbol', present: true }, { field: 'Mono.d_spacing', present: true }],
  recommended: [{ field: 'Facility.name', present: false }] }
const props = () => ({ projectId: 'project', groupId: 'cu', onSaved: vi.fn(), onBusyChange: vi.fn(), close: vi.fn() })
const response = (comments: string, version = 4) => ({ id: 'project', version, groups: [{ id: 'cu', source: { xdi_metadata: { comments_text: comments } } }] })
afterEach(() => { cleanup(); api.mockReset() })

it('right-clicks an XDI field to validate that saved value without changing draft comments', async () => {
  api.mockResolvedValueOnce(data).mockResolvedValueOnce({ version: 3, group_id: 'cu', engine: 'Larch XDI', valid: true,
    results: [{ family: 'Element', tag: 'symbol', value: 'Cu', valid: true, code: 0, message: '' }] })
  const p = props(); render(<dialog open aria-label="Metadata"><AthenaXDIControls {...p} /></dialog>)
  const field = await screen.findByRole('rowheader', { name: 'symbol' })
  fireEvent.change(screen.getByLabelText('XDI comments'), { target: { value: 'Unsaved draft' } })
  fireEvent.contextMenu(field, { clientX: 30, clientY: 60 })
  const menu = within(screen.getByRole('dialog')).getByRole('menu', { name: 'Element.symbol actions' })
  expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Validate Element.symbol' }))
  expect(await screen.findByRole('region', { name: 'Validation results' })).toHaveTextContent('1 field checked · 0 need attention')
  expect(api).toHaveBeenLastCalledWith('/projects/project/groups/cu/xdi/validate', { version: 3, family: 'Element', tag: 'symbol' })
  expect(api).toHaveBeenCalledTimes(2); expect(p.onSaved).not.toHaveBeenCalled()
  expect(screen.getByLabelText('XDI comments')).toHaveValue('Unsaved draft')
  expect(screen.queryByRole('menu')).toBeNull()
})

it.each(['visible', 'Shift+F10', 'ContextMenu'])('exposes field actions through %s and keeps family and comment editing menus native', async method => {
  api.mockResolvedValueOnce(data); render(<AthenaXDIControls {...props()} />)
  const trigger = await screen.findByRole('button', { name: 'Actions for Element.symbol' })
  trigger.focus()
  if (method === 'visible') fireEvent.click(trigger)
  else fireEvent.keyDown(trigger, { key: method === 'Shift+F10' ? 'F10' : 'ContextMenu', shiftKey: method === 'Shift+F10' })
  expect(screen.getByRole('menuitem', { name: 'Validate Element.symbol' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(trigger).toHaveFocus()
  expect(fireEvent.contextMenu(screen.getByRole('button', { name: 'Element' }))).toBe(true)
  expect(fireEvent.contextMenu(screen.getByLabelText('XDI comments'))).toBe(true)
  fireEvent.keyDown(screen.getByLabelText('XDI comments'), { key: 'F10', shiftKey: true })
  expect(screen.queryByRole('menu')).toBeNull(); expect(api).toHaveBeenCalledOnce()
})

it('dismisses a field menu when changing groups instead of validating the previous group’s field', async () => {
  api.mockResolvedValueOnce(data).mockResolvedValueOnce({ ...data, version: 6, group_id: 'fe', label: 'Fe foil' })
  const p = props(); const view = render(<AthenaXDIControls {...p} />)
  fireEvent.contextMenu(await screen.findByRole('rowheader', { name: 'symbol' }))
  expect(screen.getByRole('menu')).toBeVisible()
  view.rerender(<AthenaXDIControls {...p} groupId="fe" />)
  await screen.findByText('Fe foil')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(api).toHaveBeenCalledTimes(2)
  expect(api).toHaveBeenLastCalledWith('/projects/project/groups/fe/xdi', undefined, 'GET', expect.any(AbortSignal))
})

it('shows exact read-only acquisition and accumulated process text independently of editable comments', async () => {
  const process = 'Earlier μ 铜; <script>text</script>\nRemoved multi-electron excitation; '
  api.mockResolvedValueOnce({ ...data, history: { process, start_time: '2001-06-26T22:27:31', end_time: null, inherited: true } })
  render(<AthenaXDIControls {...props()} />)
  const history = await screen.findByRole('region', { name: 'Acquisition and processing history' })
  expect(history.querySelector('p')?.textContent).toBe(process)
  expect(within(history).getByText('2001-06-26T22:27:31')).toBeVisible()
  expect(within(history).getByText('Not recorded')).toBeVisible()
  expect(within(history).getByText(/inherited from the source scan/)).toBeVisible()
  expect(within(history).queryByRole('textbox')).toBeNull()
  expect(document.querySelector('script')).toBeNull()
  fireEvent.change(screen.getByLabelText('XDI comments'), { target: { value: 'My new comment' } })
  expect(history.querySelector('p')?.textContent).toBe(process)
  expect(api).toHaveBeenCalledOnce()
})

it('refreshes acquisition history when reloading a newer saved revision and distinguishes empty history', async () => {
  api.mockResolvedValueOnce({ ...data, history: { process: 'Earlier processing', start_time: null, end_time: null, inherited: false } })
    .mockResolvedValueOnce({ ...data, version: 8, history: { process: '', start_time: null, end_time: null, inherited: false } })
  render(<AthenaXDIControls {...props()} />)
  const history = await screen.findByRole('region', { name: 'Acquisition and processing history' })
  expect(history).toHaveTextContent('Earlier processing')
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved metadata' }))
  expect(await screen.findByText('No processing history recorded in Scan.process.')).toBeVisible()
  expect(screen.queryByText('Earlier processing')).toBeNull()
  expect(screen.queryByText(/inherited from the source scan/)).toBeNull()
})

it('shows versions, presence and family controls without confusing availability with validation', async () => {
  api.mockResolvedValueOnce(data); render(<AthenaXDIControls {...props()} />)
  expect(await screen.findByText('XDI 1.0 · GSE/1.0')).toBeVisible()
  fireEvent.click(screen.getByText('Required metadata: 2 of 2 present'))
  fireEvent.click(screen.getByText('Recommended metadata: 0 of 1 present'))
  expect(screen.getByText('missing')).toBeVisible()
  expect(screen.getByRole('rowheader', { name: 'd_spacing' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all families' }))
  expect(screen.queryByRole('rowheader')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Element' }))
  expect(screen.getByRole('rowheader', { name: 'symbol' })).toBeVisible()
  expect(screen.queryByRole('rowheader', { name: 'd_spacing' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand all families' }))
  expect(screen.getByRole('rowheader', { name: 'd_spacing' })).toBeVisible()
  expect(api).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Save comments' })).toBeDisabled()
})

it('validates saved fields with a version and shows all errors even when families are collapsed', async () => {
  const error = { family: 'Mono', tag: 'd_spacing', value: '-1', valid: false, code: 108, message: 'negative value for d-spacing' }
  api.mockResolvedValueOnce(data).mockResolvedValueOnce({ version: 3, group_id: 'cu', engine: 'Larch XDI', valid: false, results: [error] })
    .mockResolvedValueOnce({ version: 3, group_id: 'cu', engine: 'Larch XDI', valid: true, results: [{ family: 'Element', tag: 'symbol', value: 'Cu', valid: true, code: 0, message: '' }] })
  render(<AthenaXDIControls {...props()} />); await screen.findByText('Cu foil')
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all families' }))
  fireEvent.click(screen.getByRole('button', { name: 'Validate all' }))
  const results = await screen.findByRole('region', { name: 'Validation results' })
  expect(results).toHaveTextContent('negative value for d-spacing')
  expect(api).toHaveBeenLastCalledWith('/projects/project/groups/cu/xdi/validate', { version: 3 })
  fireEvent.click(screen.getByRole('button', { name: 'Expand all families' }))
  fireEvent.click(screen.getByRole('button', { name: 'Validate Element.symbol' }))
  await waitFor(() => expect(results).toHaveTextContent('0 need attention'))
  expect(api).toHaveBeenLastCalledWith('/projects/project/groups/cu/xdi/validate', { version: 3, family: 'Element', tag: 'symbol' })
  expect(screen.getByLabelText('XDI comments')).toHaveValue(data.comments)
})

it('saves exact independent comments, confirms the returned revision, and blocks duplicate pending saves', async () => {
  let finish!: (value: unknown) => void
  api.mockResolvedValueOnce(data).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const p = props(); render(<AthenaXDIControls {...p} />); await screen.findByText('Cu foil')
  const text = ' μ 铜 "quoted" $var @array\n<script>text</script> '
  fireEvent.change(screen.getByLabelText('XDI comments'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Save comments' }))
  expect(screen.getByRole('button', { name: 'Save comments' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Close metadata' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Actions for Element.symbol' })).toBeDisabled()
  fireEvent.contextMenu(screen.getByRole('rowheader', { name: 'symbol' })); expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save comments' }))
  expect(api).toHaveBeenCalledTimes(2)
  await act(async () => { finish(response(text)) })
  expect(api).toHaveBeenLastCalledWith('/projects/project/command', { version: 3, action: 'xdi_comments', group_ids: ['cu'], options: { comments: text } })
  expect(p.onSaved).toHaveBeenCalledWith(response(text))
  expect(screen.getByLabelText('XDI comments')).toHaveValue(text)
  expect(screen.queryByText('Unsaved XDI comments')).toBeNull()
  expect(document.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close metadata' })); expect(p.close).toHaveBeenCalledOnce()
})

it('preserves the draft on conflict and explicitly reloads before saving at the new version', async () => {
  api.mockResolvedValueOnce(data).mockRejectedValueOnce(new Error('Project changed in another window.'))
    .mockResolvedValueOnce({ ...data, version: 7, comments: 'Other window' }).mockResolvedValueOnce(response('Reviewed', 8))
  render(<AthenaXDIControls {...props()} />); await screen.findByText('Cu foil')
  fireEvent.change(screen.getByLabelText('XDI comments'), { target: { value: 'My draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save comments' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('changed in another window')
  expect(screen.getByLabelText('XDI comments')).toHaveValue('My draft')
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved metadata' }))
  await waitFor(() => expect(screen.getByLabelText('XDI comments')).toHaveValue('Other window'))
  fireEvent.change(screen.getByLabelText('XDI comments'), { target: { value: 'Reviewed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save comments' }))
  await screen.findByText(/XDI comments saved/)
  expect(api).toHaveBeenLastCalledWith('/projects/project/command', { version: 7, action: 'xdi_comments', group_ids: ['cu'], options: { comments: 'Reviewed' } })
})

it('reports unavailable validation independently and still permits comment saving', async () => {
  api.mockResolvedValueOnce(data).mockRejectedValueOnce(new Error('Larch XDI validator is unavailable.')).mockResolvedValueOnce(response(''))
  render(<AthenaXDIControls {...props()} />); await screen.findByText('Cu foil')
  fireEvent.click(screen.getByRole('button', { name: 'Validate all' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable')
  fireEvent.change(screen.getByLabelText('XDI comments'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save comments' }))
  await screen.findByText(/XDI comments saved/); expect(screen.getByLabelText('XDI comments')).toHaveValue('')
})

it('rejects malformed metadata and unconfirmed save/validation responses', async () => {
  api.mockResolvedValueOnce({ ...data, comments: [] }).mockResolvedValueOnce(data)
    .mockResolvedValueOnce(response('Wrong')).mockResolvedValueOnce({ version: 99, group_id: 'cu', valid: true, results: [] })
  const p = props(); render(<AthenaXDIControls {...p} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read')
  expect(screen.getByRole('button', { name: 'Save comments' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved metadata' })); await screen.findByText('Cu foil')
  fireEvent.change(screen.getByLabelText('XDI comments'), { target: { value: 'My draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save comments' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('saved comments could not be confirmed'))
  expect(p.onSaved).not.toHaveBeenCalled(); expect(screen.getByLabelText('XDI comments')).toHaveValue('My draft')
  fireEvent.click(screen.getByRole('button', { name: 'Validate all' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('validation result could not be confirmed'))
  expect(screen.queryByRole('region', { name: 'Validation results' })).toBeNull()
})

it('ignores late results after changing group or closing and cannot save old comments into the new group', async () => {
  let finish!: (value: unknown) => void
  api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockRejectedValueOnce(new Error('Group no longer exists.'))
  const p = props(); const view = render(<AthenaXDIControls {...p} />)
  view.rerender(<AthenaXDIControls {...p} groupId="fe" />)
  await screen.findByRole('alert')
  await act(async () => { finish(data) })
  expect(screen.queryByLabelText('XDI comments')).toBeNull()
  expect(screen.getByRole('button', { name: 'Save comments' })).toBeDisabled()
  api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved metadata' })); view.unmount()
  await act(async () => { finish({ ...data, group_id: 'fe' }) })
  expect(p.onSaved).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: 'File metadata controls' })).toBeNull()
})
