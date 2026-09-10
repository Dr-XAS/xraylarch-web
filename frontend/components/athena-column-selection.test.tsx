import "@testing-library/jest-dom/vitest"
import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ColumnMapping } from "@/lib/athena-import"
import type { InspectionResponse } from "@/lib/contracts"
import { numeratorRange } from "@/lib/athena-import"
import { AthenaColumnSelection } from "./athena-column-selection"

vi.mock("./athena-import-preview", () => ({ AthenaImportPreview: () => <div /> }))
afterEach(cleanup)
const columns = ["energy", "i0", "it", "detA", "detB", "ref"].map((name, index) => ({ name, index, column_id: `c${index}`,
  numeric: true, unit: null, role_hint: null, preview: [1, 2, 3] }))
const initial: ColumnMapping = { energy_column: "c0", numerator: ["c1"], denominator: "c2", mode: "transmission", units: "eV",
  data_type: "mu", reference_numerator: "", reference_denominator: "", sort: false }
function Harness({ busy = false, columnUnits, inspection = {} }: { busy?: boolean; columnUnits?: Record<string, "eV" | "keV" | null>; inspection?: Partial<InspectionResponse> }) {
  const [mapping, setMapping] = useState(initial)
  return <><AthenaColumnSelection projectId="p" version={0} inspection={{ display_name: "columns.dat", upload_id: "u", row_count: 3,
    columns, column_units: columnUnits, warnings: [], issues: [], source_preview: "# Original beamline headers", source_preview_truncated: true, ...inspection }}
    mapping={mapping} setMapping={setMapping} busy={busy} remaining={1} reuseMapping setReuseMapping={() => {}}
    chooseAnother={() => {}} importCurrent={() => {}} /><output data-testid="mapping">{JSON.stringify(mapping)}</output></>
}
function accepted() { return JSON.parse(screen.getByTestId("mapping").textContent!) }
const readerSuggestions: InspectionResponse['plugin_suggestions'] = {
  transmission: { energy_column: 'c0', numerator: ['c1'], denominator: 'c2', mode: 'transmission', units: 'eV', data_type: 'mu' },
  fluorescence: { energy_column: 'c0', numerator: ['c3'], denominator: 'c1', mode: 'fluorescence', units: 'eV', data_type: 'mu' },
}
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
  expect(screen.getByRole('link', { name: 'Download original file' })).toBeVisible()
})
it('shows file conversion and separate original/converted downloads without changing detector choices', () => {
  render(<Harness inspection={{ file_plugin: { id: 'X10C', version: '0.1', description: 'NSLS beamline X10C',
    summary: 'Separated joined negative values.', source_sha256: 'a', converted_sha256: 'b' },
    source_preview: 'EXAFS\0padding', converted_preview: '# energy 1 2 3 4 5 6 7', converted_preview_truncated: true }} />)
  expect(screen.getByLabelText('File conversion')).toHaveTextContent('NSLS beamline X10C')
  fireEvent.click(screen.getByText('Source file contents (first section)'))
  fireEvent.click(screen.getByText('Converted columns (first section)'))
  expect(screen.getByText('EXAFS␀padding')).toBeVisible()
  expect(screen.getByRole('link', { name: 'Download original file' })).toHaveAttribute('href', '/api/backend/api/athena/projects/p/uploads/u/file')
  expect(screen.getByRole('link', { name: 'Download converted file' })).toHaveAttribute('href', '/api/backend/api/athena/projects/p/uploads/u/file?variant=converted')
  expect(accepted()).toEqual(initial)
})
it('offers the original full file for ordinary tables without a conversion label', () => {
  render(<Harness />)
  fireEvent.click(screen.getByText('Source file contents (first section)'))
  expect(screen.getByRole('link', { name: 'Download original file' })).toBeVisible()
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

it("sums denominator buttons, uses constant 1 when cleared and displays signal scaling", () => {
  render(<Harness />)
  fireEvent.click(screen.getByLabelText("Denominator i0"))
  expect(accepted().denominator).toEqual(["c2", "c1"])
  expect(screen.getByText("μ(E) = ln(|(i0) / (it + i0)|)")).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText("Invert signal"))
  fireEvent.change(screen.getByLabelText("Multiplicative constant"), { target: { value: "2.5" } })
  expect(accepted()).toMatchObject({ invert: true, signal_multiplier: 2.5 })
  expect(screen.getByText(/μ\(E\) = −1 × 2.5 × ln/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Clear denominator" }))
  expect(accepted().denominator).toBe("")
  expect(screen.getByText(/ln\(\|\(i0\) \/ \(1\)\|\)/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Multiplicative constant"), { target: { value: "" } })
  expect(screen.getByRole("button", { name: "Import spectrum" })).toBeDisabled()
  expect(screen.getByRole("alert")).toHaveTextContent("finite multiplicative constant")
  fireEvent.change(screen.getByLabelText("Multiplicative constant"), { target: { value: "0" } })
  expect(screen.getByRole("button", { name: "Import spectrum" })).toBeEnabled()
  expect(screen.getByText(/μ\(E\) = −1 × 0 × ln/)).toBeInTheDocument()
})

it("resets all absorption transforms when switching to chi", () => {
  render(<Harness />)
  fireEvent.click(screen.getByLabelText("Invert signal"))
  fireEvent.change(screen.getByLabelText("Multiplicative constant"), { target: { value: "4" } })
  fireEvent.change(screen.getByLabelText("Data type"), { target: { value: "chi" } })
  expect(accepted()).toMatchObject({ data_type: "chi", mode: "mu", units: "eV", denominator: "", invert: false, signal_multiplier: 1 })
  for (const label of ["Natural log", "Invert signal", "Multiplicative constant", "Denominator it", "Measurement", "Energy units"]) {
    expect(screen.getByLabelText(label)).toBeDisabled()
  }
  fireEvent.change(screen.getByLabelText("Data type"), { target: { value: "mu" } })
  expect(screen.getByLabelText("Invert signal")).toBeEnabled()
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
