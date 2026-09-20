import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { athenaApi, type AthenaGroup, type AthenaProject } from "@/lib/athena"
import { defaultPreprocessing, defaultRebin } from "@/lib/athena-import"
import { AthenaReimportColumns } from "./athena-reimport-columns"

vi.mock("@/lib/athena", async original => ({ ...await original<typeof import("@/lib/athena")>(), athenaApi: vi.fn() }))
vi.mock("./athena-import-preview", () => ({ AthenaImportPreview: () => <div /> }))
const api = vi.mocked(athenaApi)
const group = { id: "sample", label: "Cu scan", source: {} } as AthenaGroup
const project: AthenaProject = { id: "p", name: "Project", version: 5, groups: [group], journal: "", updated: "", undo: [], redo: [], history: [] }

function inspection() {
  return { upload_id: "reimport-token", version: 6, reimport_group_id: group.id, display_name: "cu.dat", row_count: 3,
    columns: ["energy", "I0", "It", "fluorescence"].map((name, index) => ({ column_id: `c${index}`, name, index,
      numeric: true, unit: null, role_hint: null, preview: [1, 2, 3] })), warnings: [], issues: [],
    current_mapping: { energy_column: "c0", numerator: ["c3"], denominator: "c1", mode: "fluorescence" as const, units: "keV" as const,
      data_type: "mu" as const, reference_numerator: "", reference_denominator: "", sort: true, invert: true, signal_multiplier: 2,
      is_reference: false, rebin: null as null | Omit<typeof defaultRebin, 'enabled'> },
    athena_suggestion: { energy_column: "c0", numerator: ["c1"], denominator: "c2", mode: "transmission", units: "eV", data_type: "mu" },
    remembered_columns: { version: 1, matching_columns: true, mapping: { numerator: ["c2"] }, warnings: [] } }
}
function setup() {
  const onApplied = vi.fn(), onBusyChange = vi.fn(), close = vi.fn()
  const result = render(<AthenaReimportColumns project={project} group={group} onApplied={onApplied} onBusyChange={onBusyChange} close={close} />)
  return { ...result, onApplied, onBusyChange, close }
}
beforeEach(() => { api.mockReset(); api.mockResolvedValue(inspection()) })
afterEach(cleanup)

it('loads saved columns only when opened and starts from the group mapping rather than import preferences', async () => {
  const state = setup()
  await screen.findByRole('button', { name: 'Apply column changes' })
  expect(api).toHaveBeenCalledTimes(1)
  expect(api).toHaveBeenCalledWith('/projects/p/groups/sample/columns', undefined, 'GET', expect.any(AbortSignal))
  expect(screen.getByLabelText('Numerator fluorescence')).toBeChecked()
  expect(screen.getByLabelText('Numerator I0')).not.toBeChecked()
  expect(screen.getByLabelText('Energy units')).toHaveValue('keV')
  expect(screen.queryByLabelText('Invert signal')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Flip numerator and denominator' })).toBeEnabled()
  expect(screen.getByLabelText('Multiplicative constant')).toHaveValue(-2)
  expect(screen.getByLabelText('Perform rebinning')).not.toBeChecked()
  expect(screen.queryByLabelText('Remembered import choices')).not.toBeInTheDocument()
  state.rerender(<AthenaReimportColumns project={{ ...project, version: 7 }} group={{ ...group }}
    onApplied={state.onApplied} onBusyChange={vi.fn()} close={state.close} />)
  expect(api).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(state.close).toHaveBeenCalledOnce()
  expect(state.onApplied).not.toHaveBeenCalled()
})

it('submits changes to the same group with the inspected version and preserves saved rebinning', async () => {
  const original = inspection()
  original.current_mapping.rebin = { ...defaultRebin, e0: 8979, xanes: 0.25 }
  original.current_mapping.is_reference = true
  api.mockResolvedValueOnce(original)
  const state = setup()
  await screen.findByRole('button', { name: 'Apply column changes' })
  expect(screen.getByLabelText('Perform rebinning')).toBeChecked()
  expect(screen.getByLabelText('Rebin XANES step · eV')).toHaveValue(0.25)
  fireEvent.click(screen.getByLabelText('Numerator It'))
  const updated = { ...project, version: 7 }
  let finish!: (value: AthenaProject) => void
  api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Apply column changes' }))
  expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(state.onBusyChange).toHaveBeenLastCalledWith(true)
  expect(api.mock.calls.at(-1)).toEqual(['/projects/p/groups/sample/reimport', expect.objectContaining({
    upload_id: 'reimport-token', version: 6, numerator: ['c3', 'c2'], denominator: 'c1', reader_reviewed: true,
    signal_multiplier: -2, invert: false,
    is_reference: true,
    individual_channels: false, reference_numerator: null, reference_denominator: null, additional_fluorescence: null,
    preprocessing: defaultPreprocessing, rebin: expect.objectContaining({ e0: 8979, xanes: 0.25 }),
  })])
  await act(async () => finish(updated))
  expect(state.onApplied).toHaveBeenCalledExactlyOnceWith(updated)
  expect(state.onBusyChange).toHaveBeenLastCalledWith(false)
})

it('supports retrying a failed inspection without modifying the spectrum', async () => {
  api.mockRejectedValueOnce(new Error('Stored source is unavailable.'))
  const state = setup()
  expect(await screen.findByRole('alert')).toHaveTextContent('Stored source is unavailable.')
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading columns' }))
  await screen.findByRole('button', { name: 'Apply column changes' })
  expect(api).toHaveBeenCalledTimes(2)
  expect(state.onApplied).not.toHaveBeenCalled()
})

it('retains changed selections after a failed apply and offers retry, reload, and cancel', async () => {
  const state = setup()
  await screen.findByRole('button', { name: 'Apply column changes' })
  fireEvent.click(screen.getByLabelText('Numerator It'))
  api.mockRejectedValueOnce(new Error('Project version changed.'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply column changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Project version changed.')
  expect(screen.getByLabelText('Numerator It')).toBeChecked()
  expect(screen.getByRole('button', { name: 'Apply column changes' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  expect(state.onApplied).not.toHaveBeenCalled()
  expect(state.onBusyChange).toHaveBeenLastCalledWith(false)
  fireEvent.click(screen.getByRole('button', { name: 'Reload original columns' }))
  await screen.findByRole('button', { name: 'Apply column changes' })
  expect(screen.getByLabelText('Numerator It')).not.toBeChecked()
})

it('aborts an inspection when closed so late results cannot reopen or change the project', async () => {
  let finish!: (value: ReturnType<typeof inspection>) => void
  api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const state = setup()
  const signal = api.mock.calls[0][3]!
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  state.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => finish(inspection()))
  expect(state.onApplied).not.toHaveBeenCalled()
  expect(state.onBusyChange).not.toHaveBeenCalled()
})

it('rejects an inspection for another group before allowing any replacement', async () => {
  api.mockResolvedValueOnce({ ...inspection(), reimport_group_id: 'different' })
  const state = setup()
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('do not belong to this group'))
  expect(screen.queryByRole('button', { name: 'Apply column changes' })).not.toBeInTheDocument()
  expect(state.onApplied).not.toHaveBeenCalled()
})
