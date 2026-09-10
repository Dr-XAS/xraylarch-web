import "@testing-library/jest-dom/vitest"
import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import type { AthenaGroup } from "@/lib/athena"
import { defaultPreprocessing, type ImportPreprocessing } from "@/lib/athena-import"
import { AthenaImportPreprocessing } from "./athena-import-preprocessing"

afterEach(cleanup)
const group = (id: string, changes: Partial<AthenaGroup> = {}) => ({ id, label: id, data_type: 'mu', source: {},
  result: { effective: {}, arrays: {}, warnings: [] }, processing_error: null, ...changes } as AthenaGroup)
const groups = [group('standard', { frozen: true }), group('reference'), group('chi', { data_type: 'chi' }),
  group('detector', { data_type: 'detector' }),
  group('difference', { is_difference: true }), group('broken', { processing_error: 'bad' }), group('empty', { result: null })]
function Harness({ chi = false, start = defaultPreprocessing }: { chi?: boolean; start?: ImportPreprocessing }) {
  const [value, set] = useState(start)
  return <><AthenaImportPreprocessing groups={groups} chi={chi} value={value} onChange={set} /><output data-testid="state">{JSON.stringify(value)}</output></>
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!)
it('offers processed absorption standards including frozen sources, and toggles copying and alignment', () => {
  render(<Harness />)
  expect(screen.getAllByRole('option', { hidden: true }).map(el => el.textContent)).toEqual(['None', 'standard', 'reference'])
  expect(screen.getByLabelText('Set parameters to the standard')).toBeDisabled()
  expect(screen.getByLabelText('Align to the standard')).toBeDisabled()
  expect(screen.getByLabelText('Mark each imported sample')).not.toBeChecked()
  fireEvent.change(screen.getByLabelText('Preprocessing standard'), { target: { value: 'standard' } })
  fireEvent.click(screen.getByLabelText('Set parameters to the standard'))
  fireEvent.click(screen.getByLabelText('Align to the standard'))
  fireEvent.click(screen.getByLabelText('Mark each imported sample'))
  expect(state()).toEqual({ standard_id: 'standard', mark: true, align: true, copy_parameters: true })
  fireEvent.change(screen.getByLabelText('Preprocessing standard'), { target: { value: '' } })
  expect(state()).toEqual({ standard_id: null, mark: true, align: false, copy_parameters: false })
})
it('allows marking chi but disables energy operations', () => {
  render(<Harness chi />)
  expect(screen.getByLabelText('Preprocessing standard')).toBeDisabled()
  expect(screen.getByLabelText('Align to the standard')).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Mark each imported sample'))
  expect(state().mark).toBe(true)
})
it('keeps an unavailable standard visible and permits recovery without silently selecting another', () => {
  render(<Harness start={{ standard_id: 'gone', copy_parameters: true, mark: true, align: true }} />)
  expect(screen.getByRole('alert', { hidden: true })).toHaveTextContent('no longer usable')
  expect(screen.getByLabelText('Preprocessing standard')).toHaveValue('gone')
  expect(screen.getByLabelText('Align to the standard')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Preprocessing standard'), { target: { value: 'standard' } })
  expect(screen.queryByRole('alert', { hidden: true })).not.toBeInTheDocument()
  expect(state()).toEqual({ standard_id: 'standard', copy_parameters: true, mark: true, align: true })
})
