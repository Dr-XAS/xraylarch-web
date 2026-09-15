import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { InspectionResponse } from '@/lib/contracts'
import { AthenaColumnSelection } from './athena-column-selection'
import type { ColumnMapping } from '@/lib/athena-import'

const { plot, imported } = vi.hoisted(() => ({ plot: vi.fn(), imported: vi.fn() }))
vi.mock('next/dynamic', () => ({ default: () => (props: unknown) => { plot(props); return <div data-testid="plotly" /> } }))
vi.mock('./athena-import-preview', () => ({ AthenaImportPreview: () => <div>Selected detector preview</div> }))
afterEach(() => { cleanup(); plot.mockReset(); imported.mockReset() })
const preview: NonNullable<InspectionResponse['reader_preview']> = { points: 4, edge_energy: 1602.95, step_size: 600,
  pre_range: [1572.95, 1592.95], post_range: [1612.95, 1632.95], traces: ['original', 'pre', 'post', 'corrected'].map((role, i) =>
    ({ id: role, label: role, role, x: [1570, 1590, 1610, 1640], y: [10000, 10010, 10620, 10630].map(v => v+i) })) }
function Harness({ required = true, upload = 'u', busy = false }: { required?: boolean; upload?: string; busy?: boolean }) {
  const [mapping, setMapping] = useState<ColumnMapping>({ energy_column: 'c0', numerator: ['c3'], denominator: 'c4', mode: 'transmission', units: 'eV',
    data_type: 'xanes', reference_numerator: '', reference_denominator: '', sort: false })
  return <AthenaColumnSelection key={upload} projectId="p" version={0} busy={busy} remaining={2} reuseMapping setReuseMapping={() => {}}
    chooseAnother={() => {}} importCurrent={imported} mapping={mapping} setMapping={setMapping} inspection={{ upload_id: upload,
      display_name: 'probe.dat', row_count: 4, columns: ['Energy', 'Angle', 'Time', 'I0', 'I1', 'mu'].map((name, index) =>
        ({ name, index, column_id: 'c'+index, numeric: true, unit: null, role_hint: null, preview: [] })), warnings: [], issues: [],
      file_plugin: { id: 'BL8Ar', version: '0.1', description: 'BL8', summary: 'Argon correction', source_sha256: 'a', converted_sha256: 'b', review_required: required },
      reader_preview: preview }} />
}
function plotted() { return plot.mock.calls.at(-1)![0] }

it('requires a rendered I0 plot and per-file review while column edits remain available', () => {
  const view = render(<Harness />)
  const review = screen.getByLabelText('I reviewed the I0 correction for this file')
  expect(review).toBeDisabled(); expect(screen.getByRole('button', { name: 'Import spectrum' })).toBeDisabled()
  expect(plotted().data.map((t: { name: string }) => t.name)).toEqual(['original', 'pre', 'post', 'corrected'])
  expect(plotted().data[0].x).toEqual(preview.traces[0].x)
  expect(plotted().data[0].x).not.toBe(preview.traces[0].x)
  expect(plotted().layout.shapes[0]).toMatchObject({ x0: 1572.95, x1: 1592.95 })
  expect(plotted().layout.shapes[2]).toMatchObject({ x0: 1602.95, x1: 1602.95 })
  act(() => plotted().onInitialized())
  fireEvent.click(review)
  expect(screen.queryByLabelText('I0 correction plot')).not.toBeInTheDocument()
  expect(screen.getByText('Selected detector preview')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Import spectrum' })); expect(imported).toHaveBeenCalledWith(true)
  view.rerender(<Harness upload="next" />)
  expect(screen.getByLabelText('I reviewed the I0 correction for this file')).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Import spectrum' })).toBeDisabled()
})

it('optional plots do not block imports, and failed mandatory plots cannot be approved', () => {
  const view = render(<Harness required={false} />)
  expect(screen.queryByLabelText('I0 correction plot')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Import spectrum' })); expect(imported).toHaveBeenCalledWith(false)
  fireEvent.click(screen.getByRole('button', { name: 'Show I0 correction' }))
  expect(screen.getByLabelText('I0 correction plot')).toBeVisible()
  view.rerender(<Harness upload="mandatory" />)
  act(() => { plotted().onInitialized(); plotted().onError(new Error('Plot failed')) })
  expect(screen.getByRole('alert')).toHaveTextContent('Could not display')
  expect(screen.getByLabelText('I reviewed the I0 correction for this file')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Import spectrum' })).toBeDisabled()
})

it('holds review changes while an import is running', () => {
  render(<Harness busy />)
  act(() => plotted().onInitialized())
  expect(screen.getByLabelText('I reviewed the I0 correction for this file')).toBeDisabled()
})
