import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScanInspectionResponse } from '@/lib/contracts'
import { AthenaImportPreview } from './athena-import-preview'
import { AthenaScanSelection } from './athena-scan-selection'

vi.mock('./athena-import-preview', () => ({ AthenaImportPreview: vi.fn(() => <div data-testid="scan-curve" />) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const scans: ScanInspectionResponse = { kind: 'scan_list', display_name: 'multi.spec',
  file_plugin: { id: 'SPEC', description: 'ESRF SPEC', source_sha256: 'hash', total_points: 12, skipped_scans: [] },
  scans: [1, 2].map(n => ({ upload_id: `u${n}`, display_name: `multi.spec.${n}`, row_count: n * 4, warnings: [], issues: [],
    columns: ['Mon', 'ZapEnergy', 'Ion1', 'Ion2'].map((name, index) => ({ name, index, column_id: `c${index}`, numeric: true,
      unit: null, role_hint: null, preview: [1, 2, 3] })),
    athena_suggestion: { energy_column: 'c1', numerator: ['c2'], denominator: 'c3', mode: 'transmission', units: 'keV', data_type: 'mu' },
    file_plugin: { id: 'SPEC', version: '0.1', description: 'ESRF SPEC', summary: 'Use ZapEnergy in keV.', source_sha256: 'hash',
      converted_sha256: `hash${n}`, scan: { number: '1', ordinal: n, command: 'zapline mono 1 2', date: 'Friday', points: n * 4 } } })) }

function setup(busy = false, collection = scans) {
  const onContinue = vi.fn(), onCancel = vi.fn()
  render(<AthenaScanSelection collection={collection} projectId="p" version={7} busy={busy} onContinue={onContinue} onCancel={onCancel} />)
  return { onContinue, onCancel }
}

it('starts with all scans, shows duplicate scan numbers separately and previews suggested columns', () => {
  const { onContinue } = setup()
  expect(screen.getByLabelText('Include Scan 1 · entry 1')).toBeChecked()
  expect(screen.getByLabelText('Include Scan 1 · entry 2')).toBeChecked()
  expect(screen.getByText(/ZapEnergy in keV/)).toBeVisible()
  expect(vi.mocked(AthenaImportPreview).mock.calls.at(-1)?.[0]).toMatchObject({ uploadId: 'u1', version: 7,
    mapping: { energy_column: 'c1', numerator: ['c2'], denominator: 'c3', units: 'keV', mode: 'transmission' } })
  expect(onContinue).not.toHaveBeenCalled()
})
it('changes preview without changing which scans will be imported', () => {
  setup()
  fireEvent.click(screen.getByRole('button', { name: 'Preview Scan 1 · entry 2' }))
  expect(vi.mocked(AthenaImportPreview).mock.calls.at(-1)?.[0].uploadId).toBe('u2')
  expect(screen.getByLabelText('Include Scan 1 · entry 1')).toBeChecked()
  expect(screen.getByLabelText('Include Scan 1 · entry 2')).toBeChecked()
  expect(screen.getByRole('link', { name: 'Download original SPEC file' })).toHaveAttribute('href', '/api/backend/api/athena/projects/p/uploads/u2/file')
})
it('supports all/none/invert, requires a selection and preserves source order after reselecting', () => {
  const { onContinue } = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Select no scans' }))
  expect(screen.getByRole('button', { name: 'Review selected scans' })).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Include Scan 1 · entry 2'))
  fireEvent.click(screen.getByLabelText('Include Scan 1 · entry 1'))
  fireEvent.click(screen.getByRole('button', { name: 'Review selected scans' }))
  expect(onContinue).toHaveBeenLastCalledWith(scans.scans)
  fireEvent.click(screen.getByRole('button', { name: 'Select all scans' }))
  fireEvent.click(screen.getByLabelText('Include Scan 1 · entry 1'))
  fireEvent.click(screen.getByRole('button', { name: 'Invert scan selection' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review selected scans' }))
  expect(onContinue).toHaveBeenLastCalledWith([scans.scans[0]])
})
it('retains independent selection when previewing an excluded scan', () => {
  const { onContinue } = setup()
  fireEvent.click(screen.getByLabelText('Include Scan 1 · entry 1'))
  fireEvent.click(screen.getByRole('button', { name: 'Preview Scan 1 · entry 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review selected scans' }))
  expect(onContinue).toHaveBeenCalledWith([scans.scans[1]])
})
it('keeps remembered import changes out of the labelled suggested-columns preview', () => {
  const collection = structuredClone(scans)
  collection.scans[0].remembered_columns = { version: 2, matching_columns: true, warnings: [], mapping: {
    energy_column: 'c0', numerator: ['c1'], denominator: '', mode: 'mu', units: 'eV', data_type: 'mu',
    reference_numerator: '', reference_denominator: '', sort: false, invert: true } }
  setup(false, collection)
  expect(vi.mocked(AthenaImportPreview).mock.calls.at(-1)?.[0].mapping).toMatchObject({ energy_column: 'c1', invert: false })
})
it('shows empty or unrelated scans as unavailable without turning them into import choices', () => {
  setup(false, { ...scans, file_plugin: { ...scans.file_plugin, skipped_scans: [{ number: '3', ordinal: 3, command: 'ascan motor', reason: 'Not a zapline mono scan.' }] } })
  fireEvent.click(screen.getByText('Scans not available for import'))
  expect(screen.getByText(/ascan motor/)).toBeVisible()
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
})
it('blocks changes during a pending operation and allows explicit file cancellation', () => {
  const { onCancel } = setup(true)
  expect(screen.getByRole('button', { name: 'Review selected scans' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Preview Scan 1 · entry 1' })).toBeDisabled()
  expect(screen.getByLabelText('Include Scan 1 · entry 1')).toBeDisabled()
  expect(onCancel).not.toHaveBeenCalled()
  cleanup()
  const ready = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Choose another file' }))
  expect(ready.onCancel).toHaveBeenCalledOnce()
  expect(ready.onContinue).not.toHaveBeenCalled()
})
