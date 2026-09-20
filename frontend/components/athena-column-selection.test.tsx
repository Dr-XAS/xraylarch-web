import "@testing-library/jest-dom/vitest"
import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ColumnMapping } from "@/lib/athena-import"
import type { InspectionResponse } from "@/lib/contracts"
import { numeratorRange } from "@/lib/athena-import"
import { AthenaColumnSelection } from "./athena-column-selection"

vi.mock("./athena-import-preview", () => ({ AthenaImportPreview: () => <div /> }))
vi.mock("@/lib/athena", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/athena")>(),
  athenaDownload: vi.fn(),
}))
afterEach(() => { cleanup(); vi.unstubAllEnvs() })
const columns = ["energy", "i0", "it", "detA", "detB", "ref"].map((name, index) => ({ name, index, column_id: `c${index}`,
  numeric: true, unit: null, role_hint: null, preview: [1, 2, 3] }))
const initial: ColumnMapping = { energy_column: "c0", numerator: ["c1"], denominator: "c2", mode: "transmission", units: "eV",
  data_type: "mu", reference_numerator: "", reference_denominator: "", sort: false }
function Harness({ busy = false, columnUnits, inspection = {}, remaining = 1, initialMapping = initial, replacement = false }: { busy?: boolean; columnUnits?: Record<string, "eV" | "keV" | null>; inspection?: Partial<InspectionResponse>; remaining?: number; initialMapping?: ColumnMapping; replacement?: boolean }) {
  const [mapping, setMapping] = useState(initialMapping)
  const [reuseMapping, setReuseMapping] = useState<boolean | null>(null)
  return <><AthenaColumnSelection projectId="p" version={0} inspection={{ display_name: "columns.dat", upload_id: "u", row_count: 3,
    columns, column_units: columnUnits, warnings: [], issues: [], source_preview: "# Original beamline headers", source_preview_truncated: true, ...inspection }}
    mapping={mapping} setMapping={setMapping} busy={busy} remaining={remaining} reuseMapping={reuseMapping} setReuseMapping={setReuseMapping}
    chooseAnother={() => {}} importCurrent={() => {}} replacement={replacement} /><output data-testid="mapping">{JSON.stringify(mapping)}</output></>
}
function accepted() { return JSON.parse(screen.getByTestId("mapping").textContent!) }
it('limits replacement to one existing group while retaining column, signal and ordering choices', () => {
  render(<Harness replacement />)
  expect(screen.getByRole('button', { name: 'Apply column changes' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  expect(screen.queryByRole('option', { name: 'Transmission + fluorescence' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Save each channel as its own group')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('reference numerator')).not.toBeInTheDocument()
  expect(screen.queryByText('Reference channel & ordering')).not.toBeInTheDocument()
  expect(screen.queryByText('Preprocessing')).not.toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Numerator detA'))
  fireEvent.click(screen.getByLabelText('Sort ascending by energy (duplicate energies still require repair)'))
  expect(accepted()).toMatchObject({ numerator: ['c1', 'c3'], sort: true })
})
it('locks replacement controls and cancel while applying changes', () => {
  render(<Harness replacement busy />)
  expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(screen.getByLabelText('Numerator detA')).toBeDisabled()
})
const readerSuggestions: InspectionResponse['plugin_suggestions'] = {
  transmission: { energy_column: 'c0', numerator: ['c1'], denominator: 'c2', mode: 'transmission', units: 'eV', data_type: 'mu' },
  fluorescence: { energy_column: 'c0', numerator: ['c3'], denominator: 'c1', mode: 'fluorescence', units: 'eV', data_type: 'mu' },
}
it('marks an import as a reference and omits that choice while replacing columns', () => {
  const { rerender } = render(<Harness />)
  const checkbox = screen.getByRole('checkbox', { name: 'This is reference' })
  expect(checkbox).not.toBeChecked()
  fireEvent.click(checkbox)
  expect(accepted().is_reference).toBe(true)
  rerender(<Harness replacement />)
  expect(screen.queryByRole('checkbox', { name: 'This is reference' })).not.toBeInTheDocument()
})
it('imports both modes with independent detector columns and signal scales', () => {
  render(<Harness inspection={{ plugin_suggestions: readerSuggestions }} />)
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'both' } })
  expect(screen.getByRole('heading', { name: 'Transmission' })).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'Fluorescence columns' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Import both modes' })).toBeEnabled()
  expect(screen.getByLabelText('Natural log')).toBeChecked()
  expect(screen.getByLabelText('Natural log')).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Fluorescence numerator detB'))
  fireEvent.change(screen.getByLabelText('Fluorescence multiplicative constant'), { target: { value: '0.5' } })
  expect(accepted()).toMatchObject({ mode: 'transmission', numerator: ['c1'], denominator: 'c2',
    additional_fluorescence: { numerator: ['c3', 'c4'], denominator: 'c1', invert: false, signal_multiplier: 0.5 } })
  expect(screen.getByText('μ(E) = ln(|(i0) / (it)|)')).toBeInTheDocument()
  expect(screen.getByText('μ(E) = 0.5 × (detA + detB) / (i0)')).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Save each fluorescence channel as its own group'))
  expect(accepted().additional_fluorescence.individual_channels).toBe(true)
  expect(accepted().individual_channels).toBeFalsy()
})
it('flips fluorescence columns independently and swaps every rendered checkbox', () => {
  render(<Harness inspection={{ plugin_suggestions: readerSuggestions }} />)
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'both' } })
  fireEvent.click(screen.getByLabelText('Fluorescence numerator detB'))
  const flip = screen.getByRole('button', { name: 'Flip fluorescence numerator and denominator' })

  fireEvent.click(flip)

  expect(accepted()).toMatchObject({ mode: 'transmission', numerator: ['c1'], denominator: 'c2',
    additional_fluorescence: { numerator: ['c1'], denominator: ['c3', 'c4'] } })
  expect(accepted().additional_fluorescence.invert).not.toBe(true)
  expect(screen.getByLabelText('Fluorescence numerator i0')).toBeChecked()
  expect(screen.getByLabelText('Fluorescence numerator detA')).not.toBeChecked()
  expect(screen.getByLabelText('Fluorescence numerator detB')).not.toBeChecked()
  expect(screen.getByLabelText('Fluorescence denominator i0')).not.toBeChecked()
  expect(screen.getByLabelText('Fluorescence denominator detA')).toBeChecked()
  expect(screen.getByLabelText('Fluorescence denominator detB')).toBeChecked()
  expect(screen.getByText('μ(E) = (i0) / (detA + detB)')).toBeInTheDocument()

  fireEvent.click(flip)

  expect(accepted().additional_fluorescence).toMatchObject({ numerator: ['c3', 'c4'], denominator: ['c1'] })
  expect(accepted().additional_fluorescence.invert).not.toBe(true)
  expect(screen.getByLabelText('Fluorescence numerator i0')).not.toBeChecked()
  expect(screen.getByLabelText('Fluorescence numerator detA')).toBeChecked()
  expect(screen.getByLabelText('Fluorescence numerator detB')).toBeChecked()
  expect(screen.getByLabelText('Fluorescence denominator i0')).toBeChecked()
  expect(screen.getByLabelText('Fluorescence denominator detA')).not.toBeChecked()
  expect(screen.getByLabelText('Fluorescence denominator detB')).not.toBeChecked()
})
it('requires explicit fluorescence columns when no detector suggestion is available', () => {
  render(<Harness />)
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'both' } })
  expect(accepted().additional_fluorescence.numerator).toEqual([])
  expect(screen.getByRole('button', { name: 'Import both modes' })).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Fluorescence numerator detA'))
  fireEvent.click(screen.getByRole('button', { name: 'Clear fluorescence denominator' }))
  expect(screen.getByRole('button', { name: 'Import both modes' })).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Fluorescence denominator i0'))
  expect(screen.getByRole('button', { name: 'Import both modes' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Clear fluorescence numerator' }))
  expect(screen.getByRole('button', { name: 'Import both modes' })).toBeDisabled()
  expect(accepted().numerator).toEqual(['c1'])
  expect(accepted().denominator).toBe('c2')
})
it('keeps default fluorescence controls independent from transmission for restored mappings', () => {
  render(<Harness initialMapping={{ ...initial, signal_multiplier: 2, individual_channels: true,
    additional_fluorescence: { numerator: ['c3', 'c4'], denominator: 'c1' } }} />)
  expect(screen.getByText('μ(E) = (detA + detB) / (i0)')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Flip fluorescence numerator and denominator' })).toBeEnabled()
  expect(screen.getByLabelText('Fluorescence multiplicative constant')).toHaveValue(1)
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'fluorescence' } })
  expect(accepted()).toMatchObject({ mode: 'fluorescence', numerator: ['c3', 'c4'], invert: false,
    signal_multiplier: 1, individual_channels: false })
  expect(accepted().additional_fluorescence).toBeFalsy()
})
it('keeps dual-mode reader suggestions separate and retains fluorescence choices when selecting one mode', () => {
  render(<Harness inspection={{ plugin_suggestions: readerSuggestions }} />)
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'both' } })
  fireEvent.click(screen.getByLabelText('Fluorescence numerator detB'))
  fireEvent.click(screen.getByRole('button', { name: 'Use transmission columns' }))
  expect(accepted().additional_fluorescence.numerator).toEqual(['c3', 'c4'])
  fireEvent.click(screen.getByRole('button', { name: 'Use fluorescence columns' }))
  expect(accepted()).toMatchObject({ mode: 'transmission', numerator: ['c1'], denominator: 'c2',
    additional_fluorescence: { numerator: ['c3'], denominator: 'c1' } })
  expect(screen.getByLabelText('Measurement')).toHaveValue('both')
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'fluorescence' } })
  expect(accepted()).toMatchObject({ mode: 'fluorescence', numerator: ['c3'], denominator: 'c1' })
  expect(accepted().additional_fluorescence).toBeFalsy()
  expect(screen.queryByRole('group', { name: 'Fluorescence columns' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Import spectrum' })).toBeEnabled()
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'both' } })
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'transmission' } })
  expect(accepted()).toMatchObject({ mode: 'transmission', numerator: ['c1'], denominator: 'c2' })
  expect(accepted().additional_fluorescence).toBeFalsy()
})
it('clears dual-mode importing for extracted chi and does not restore it implicitly', () => {
  render(<Harness inspection={{ plugin_suggestions: readerSuggestions }} />)
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'both' } })
  fireEvent.change(screen.getByLabelText('Data type'), { target: { value: 'chi' } })
  expect(accepted()).toMatchObject({ data_type: 'chi', mode: 'mu' })
  expect(accepted().additional_fluorescence).toBeFalsy()
  expect(screen.getByLabelText('Measurement')).toBeDisabled()
  expect(screen.queryByRole('group', { name: 'Fluorescence columns' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Data type'), { target: { value: 'mu' } })
  expect(screen.getByLabelText('Measurement')).toBeEnabled()
  expect(screen.getByLabelText('Measurement')).toHaveValue('mu')
})
it('freezes all additional fluorescence controls during import', () => {
  const { rerender } = render(<Harness inspection={{ plugin_suggestions: readerSuggestions }} />)
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'both' } })
  rerender(<Harness busy inspection={{ plugin_suggestions: readerSuggestions }} />)
  for (const label of ['Fluorescence numerator detA', 'Fluorescence denominator i0',
    'Fluorescence multiplicative constant', 'Save each fluorescence channel as its own group']) {
    expect(screen.getByLabelText(label)).toBeDisabled()
  }
  expect(screen.getByRole('button', { name: 'Flip fluorescence numerator and denominator' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Clear fluorescence numerator' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled()
})
it('applies both modes to a shared batch while preserving the batch import action', () => {
  render(<Harness remaining={3} inspection={{ plugin_suggestions: readerSuggestions }} />)
  fireEvent.change(screen.getByLabelText('Measurement'), { target: { value: 'both' } })
  expect(screen.getByRole('button', { name: 'Import both modes' })).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: 'Yes, use the same parameters' }))
  expect(screen.getByRole('button', { name: 'Import 3 files' })).toBeEnabled()
  fireEvent.change(screen.getByLabelText('Fluorescence multiplicative constant'), { target: { value: '' } })
  expect(screen.getByRole('button', { name: 'Import 3 files' })).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent(/fluorescence.*multiplicative constant/i)
})
it('asks once at the top of a batch whether to share parameters and makes the import scope explicit', () => {
  render(<Harness remaining={3} />)
  const question = screen.getByRole('group', { name: 'Use the same import parameters for all files?' })
  expect(question.compareDocumentPosition(screen.getByLabelText('Data type')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Import spectrum' })).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: 'Yes, use the same parameters' }))
  expect(screen.getByRole('button', { name: 'Import 3 files' })).toBeEnabled()
  fireEvent.click(screen.getByRole('radio', { name: 'No, review each file' }))
  expect(screen.getByRole('button', { name: 'Import spectrum' })).toBeEnabled()
})
it('leaves single-file importing unchanged and locks the batch choice during an import', () => {
  const { rerender } = render(<Harness />)
  expect(screen.queryByRole('radio', { name: 'Yes, use the same parameters' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Import spectrum' })).toBeEnabled()
  rerender(<Harness remaining={3} busy />)
  expect(screen.getByRole('radio', { name: 'Yes, use the same parameters' })).toBeDisabled()
  expect(screen.getByRole('radio', { name: 'No, review each file' })).toBeDisabled()
})
it('places the file and import actions above the column controls', () => {
  render(<Harness />)
  const actions = screen.getByRole('group', { name: 'Import actions' })
  expect(actions).toContainElement(screen.getByRole('button', { name: 'Choose another file' }))
  expect(actions).toContainElement(screen.getByRole('button', { name: 'Import spectrum' }))
  expect(actions.compareDocumentPosition(screen.getByLabelText('Data type')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
it('applies native transmission/fluorescence suggestions only on request and preserves other import choices', () => {
  render(<Harness inspection={{ plugin_suggestions: readerSuggestions }} />)
  expect(accepted()).toEqual(initial)
  fireEvent.change(screen.getByLabelText('Data type'), { target: { value: 'xanes' } })
  fireEvent.change(screen.getByLabelText('reference numerator'), { target: { value: 'c2' } })
  fireEvent.click(screen.getByLabelText('Save each channel as its own group'))
  fireEvent.click(screen.getByRole('button', { name: 'Use fluorescence columns' }))
  expect(accepted()).toMatchObject({ numerator: ['c3'], denominator: 'c1', mode: 'fluorescence', units: 'eV',
    data_type: 'xanes', individual_channels: false, reference_numerator: 'c2' })
  expect(screen.getByLabelText('Natural log')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('Numerator detB'))
  expect(accepted().numerator).toEqual(['c3', 'c4'])
  fireEvent.click(screen.getByRole('button', { name: 'Use transmission columns' }))
  expect(accepted()).toMatchObject({ numerator: ['c1'], denominator: 'c2', mode: 'transmission', data_type: 'xanes', reference_numerator: 'c2' })
  expect(screen.getByLabelText('Natural log')).toBeChecked()
})
it('does not offer a nonexistent reader fluorescence mapping', () => {
  render(<Harness inspection={{ plugin_suggestions: { transmission: readerSuggestions!.transmission } }} />)
  expect(screen.getByRole('button', { name: 'Use transmission columns' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Use fluorescence columns' })).not.toBeInTheDocument()
})
it('hides energy reader suggestions for extracted chi input', () => {
  render(<Harness inspection={{ plugin_suggestions: readerSuggestions }} />)
  fireEvent.change(screen.getByLabelText('Data type'), { target: { value: 'chi' } })
  expect(screen.queryByLabelText('Reader column suggestions')).not.toBeInTheDocument()
})
it('prevents reader suggestion changes while importing', () => {
  render(<Harness busy inspection={{ plugin_suggestions: readerSuggestions }} />)
  expect(screen.getByRole('button', { name: 'Use transmission columns' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Use fluorescence columns' })).toBeDisabled()
})
it('presents binary source bytes as hexadecimal with the original download', () => {
  render(<Harness inspection={{ source_preview_format: 'hex', source_preview: '00000000  53 53 52 4c' }} />)
  fireEvent.click(screen.getByText('Binary source bytes (hex) (first section)'))
  expect(screen.getByText(/00000000\s+53 53 52 4c/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Download original file' })).toBeVisible()
})
it('shows file conversion and separate original/converted downloads without changing detector choices', () => {
  render(<Harness inspection={{ file_plugin: { id: 'X10C', version: '0.1', description: 'NSLS beamline X10C',
    summary: 'Separated joined negative values.', source_sha256: 'a', converted_sha256: 'b' },
    source_preview: 'EXAFS\0padding', converted_preview: '# energy 1 2 3 4 5 6 7', converted_preview_truncated: true }} />)
  expect(screen.getByLabelText('File conversion')).toHaveTextContent('NSLS beamline X10C')
  fireEvent.click(screen.getByText('Source file contents (first section)'))
  fireEvent.click(screen.getByText('Converted columns (first section)'))
  expect(screen.getByText('EXAFS␀padding')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Download original file' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Download converted file' })).toBeEnabled()
  expect(accepted()).toEqual(initial)
})
it('offers transport-backed original and converted upload downloads', () => {
  render(<Harness inspection={{ source_preview: 'source', converted_preview: 'converted' }} />)
  fireEvent.click(screen.getByText('Source file contents (first section)'))
  fireEvent.click(screen.getByText('Converted columns'))
  expect(screen.getByRole('button', { name: 'Download original file' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Download converted file' })).toBeEnabled()
})

it('offers the original full file for ordinary tables without a conversion label', () => {
  render(<Harness />)
  fireEvent.click(screen.getByText('Source file contents (first section)'))
  expect(screen.getByRole('button', { name: 'Download original file' })).toBeVisible()
  expect(screen.queryByLabelText('File conversion')).not.toBeInTheDocument()
  expect(screen.queryByText(/Converted columns/)).not.toBeInTheDocument()
})
it("offers FEFF normalized input while retaining energy column controls and preview choices", () => {
  render(<Harness />)
  fireEvent.change(screen.getByLabelText('Data type'), { target: { value: 'xmudat' } })
  expect(accepted()).toMatchObject({ data_type: 'xmudat', energy_column: 'c0', numerator: ['c1'] })
  expect(screen.getByText(/FEFF μ\(E\) is already normalized/)).toBeInTheDocument()
  expect(screen.getByLabelText('Energy units')).toBeEnabled()
  expect(screen.getByLabelText('reference numerator')).toBeEnabled()
  fireEvent.change(screen.getByLabelText('Data type'), { target: { value: 'chi' } })
  expect(screen.getByLabelText('Energy units')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Data type'), { target: { value: 'xmudat' } })
  expect(screen.getByLabelText('Energy units')).toBeEnabled()
  expect(accepted()).toMatchObject({ data_type: 'xmudat', mode: 'mu', denominator: '' })
})
it.each([["7,9,12-15", [6, 8, 11, 12, 13, 14]], ["4-2, 3, 1", [0, 1, 2, 3]], ["2,2", [1]]])("parses Athena column range %s", (range, expected) => {
  expect(numeratorRange(range as string, 15)).toEqual(expected)
})
it.each(["", "0", "16", "1;2", "1,,2", "1e2", "NaN", "1.5", "1-2-3"])("rejects invalid range %s", range => {
  expect(() => numeratorRange(range, 15)).toThrow()
})
it("adds a range to selected numerator buttons, skips energy, and clears all on request", () => {
  render(<Harness />)
  fireEvent.change(screen.getByLabelText("Numerator column numbers"), { target: { value: "5-4,1" } })
  fireEvent.click(screen.getByRole("button", { name: "Select range" }))
  expect(accepted().numerator).toEqual(["c1", "c3", "c4"])
  expect(screen.getByLabelText("Numerator energy")).not.toBeChecked()
  fireEvent.change(screen.getByLabelText("Numerator column numbers"), { target: { value: "999" } })
  fireEvent.click(screen.getByRole("button", { name: "Select range" }))
  expect(screen.getByRole("alert")).toHaveTextContent("between 1 and 6")
  expect(accepted().numerator).toEqual(["c1", "c3", "c4"])
  fireEvent.click(screen.getByRole("button", { name: "Clear numerator" }))
  expect(accepted().numerator).toEqual([])
  expect(screen.getByRole("button", { name: "Import spectrum" })).toBeEnabled()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})
it("sends individual-channel and reference toggles and clears references for chi", () => {
  render(<Harness />)
  fireEvent.click(screen.getByLabelText("Save each channel as its own group"))
  fireEvent.change(screen.getByLabelText("reference numerator"), { target: { value: "c2" } })
  fireEvent.change(screen.getByLabelText("reference denominator"), { target: { value: "c5" } })
  fireEvent.click(screen.getByLabelText("Reference natural log"))
  fireEvent.click(screen.getByLabelText("Same element"))
  expect(accepted()).toMatchObject({ individual_channels: true, reference_log: false, reference_same_element: false,
    reference_numerator: "c2", reference_denominator: "c5" })
  fireEvent.change(screen.getByLabelText("Data type"), { target: { value: "chi" } })
  expect(accepted()).toMatchObject({ data_type: "chi", reference_numerator: "", reference_denominator: "" })
  expect(screen.getByLabelText("Energy units")).toBeDisabled()
  expect(screen.getByLabelText("reference numerator")).toBeDisabled()
})
it("exposes source contents and freezes mapping controls during import", () => {
  render(<Harness busy />)
  expect(screen.getByText("# Original beamline headers")).toBeInTheDocument()
  expect(screen.getByLabelText("Measurement")).toBeDisabled()
  expect(screen.getByLabelText("Numerator i0")).toBeDisabled()
  expect(screen.getByRole("button", { name: "Select range" })).toBeDisabled()
})

it("flips complete numerator and denominator selections, including every rendered checkbox", () => {
  render(<Harness />)
  fireEvent.click(screen.getByLabelText("Numerator detA"))
  fireEvent.click(screen.getByLabelText("Denominator detB"))
  const flip = screen.getByRole("button", { name: "Flip numerator and denominator" })

  fireEvent.click(flip)

  expect(accepted()).toMatchObject({ numerator: ["c2", "c4"], denominator: ["c1", "c3"] })
  expect(accepted().invert).not.toBe(true)
  for (const name of ["it", "detB"]) expect(screen.getByLabelText(`Numerator ${name}`)).toBeChecked()
  for (const name of ["i0", "detA"]) expect(screen.getByLabelText(`Denominator ${name}`)).toBeChecked()
  expect(screen.getByLabelText("Numerator i0")).not.toBeChecked()
  expect(screen.getByLabelText("Numerator detA")).not.toBeChecked()
  expect(screen.getByLabelText("Denominator it")).not.toBeChecked()
  expect(screen.getByLabelText("Denominator detB")).not.toBeChecked()
  expect(screen.getByText("μ(E) = ln(|(it + detB) / (i0 + detA)|)")).toBeInTheDocument()

  fireEvent.click(flip)

  expect(accepted()).toMatchObject({ numerator: ["c1", "c3"], denominator: ["c2", "c4"] })
  expect(accepted().invert).not.toBe(true)
  expect(screen.getByLabelText("Numerator i0")).toBeChecked()
  expect(screen.getByLabelText("Numerator detA")).toBeChecked()
  expect(screen.getByLabelText("Numerator it")).not.toBeChecked()
  expect(screen.getByLabelText("Numerator detB")).not.toBeChecked()
  expect(screen.getByLabelText("Denominator it")).toBeChecked()
  expect(screen.getByLabelText("Denominator i0")).not.toBeChecked()
  expect(screen.getByLabelText("Denominator detB")).toBeChecked()
})

it("uses constant 1 when the denominator is cleared and displays signal scaling", () => {
  render(<Harness />)
  fireEvent.change(screen.getByLabelText("Multiplicative constant"), { target: { value: "2.5" } })
  expect(accepted()).toMatchObject({ signal_multiplier: 2.5 })
  expect(accepted().invert).not.toBe(true)
  expect(screen.getByText(/μ\(E\) = 2.5 × ln/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Clear denominator" }))
  expect(accepted().denominator).toBe("")
  expect(screen.getByText(/ln\(\|\(i0\) \/ \(1\)\|\)/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Multiplicative constant"), { target: { value: "" } })
  expect(screen.getByRole("button", { name: "Import spectrum" })).toBeDisabled()
  expect(screen.getByRole("alert")).toHaveTextContent("finite multiplicative constant")
  fireEvent.change(screen.getByLabelText("Multiplicative constant"), { target: { value: "0" } })
  expect(screen.getByRole("button", { name: "Import spectrum" })).toBeEnabled()
  expect(screen.getByText(/μ\(E\) = 0 × ln/)).toBeInTheDocument()
})

it("disables flipping for direct and chi data without creating an inversion transform", () => {
  render(<Harness />)
  const flip = screen.getByRole("button", { name: "Flip numerator and denominator" })
  expect(flip).toBeEnabled()
  fireEvent.change(screen.getByLabelText("Measurement"), { target: { value: "mu" } })
  expect(flip).toBeDisabled()
  expect(accepted().invert).not.toBe(true)
  fireEvent.change(screen.getByLabelText("Measurement"), { target: { value: "transmission" } })
  expect(flip).toBeEnabled()
  fireEvent.change(screen.getByLabelText("Multiplicative constant"), { target: { value: "4" } })
  fireEvent.change(screen.getByLabelText("Data type"), { target: { value: "chi" } })
  expect(accepted()).toMatchObject({ data_type: "chi", mode: "mu", units: "eV", denominator: "", invert: false, signal_multiplier: 1 })
  expect(flip).toBeDisabled()
  for (const label of ["Natural log", "Multiplicative constant", "Denominator it", "Measurement", "Energy units"]) {
    expect(screen.getByLabelText(label)).toBeDisabled()
  }
  fireEvent.change(screen.getByLabelText("Data type"), { target: { value: "mu" } })
  expect(flip).toBeDisabled()
  expect(screen.getByLabelText("Multiplicative constant")).toHaveValue(1)
})

it("suggests units for a new energy column and preserves a manual override while choosing detectors", () => {
  render(<Harness columnUnits={{ c0: "eV", c1: "keV", c2: null }} />)
  fireEvent.change(screen.getByLabelText("Energy column"), { target: { value: "c1" } })
  expect(screen.getByLabelText("Energy units")).toHaveValue("keV")
  fireEvent.change(screen.getByLabelText("Energy units"), { target: { value: "eV" } })
  fireEvent.click(screen.getByLabelText("Numerator detA"))
  expect(accepted().units).toBe("eV")
  fireEvent.change(screen.getByLabelText("Energy column"), { target: { value: "c2" } })
  expect(accepted().units).toBe("eV")
  expect(screen.getByText(/could not be inferred/)).toBeInTheDocument()
})
