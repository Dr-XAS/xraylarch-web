import type { AthenaGroup } from "./athena"
import { expect, it } from "vitest"
import type { InspectionResponse } from "./contracts"
import { columnPayload, columnProblem, defaultRebin, flipSignalColumns, initialColumnMapping, reuseColumnMapping, setDualMode, changeInputType, lastImportedSample, type ColumnMapping } from "./athena-import"
const previous: ColumnMapping = { energy_column: "old", numerator: ["old"], denominator: ["d1", "d2"], mode: "fluorescence",
  units: "eV", data_type: "xanes", reference_numerator: "r1", reference_denominator: "r2", signal_multiplier: 9, invert: true, sort: false }
const inspection: InspectionResponse = { upload_id: "u", display_name: "file.dat", row_count: 5, warnings: [], issues: [],
  columns: ["e", "i0", "it"].map((name, index) => ({ column_id: `c${index}`, name, index, preview: [8, 9, 10, 11, 12], role_hint: null, unit: null, numeric: true })),
  athena_suggestion: { energy_column: "c0", numerator: ["c1"], denominator: "c2", mode: "transmission", units: "keV", data_type: "mu" } }
it("initializes a new file from backend suggestions and clears previous transforms and references", () => {
  expect(initialColumnMapping(inspection, { ...previous, is_reference: true })).toEqual({ ...previous, ...inspection.athena_suggestion,
    is_reference: false,
    reference_numerator: "", reference_denominator: "", signal_multiplier: 1, invert: false, individual_channels: false })
  expect(initialColumnMapping(inspection, { ...previous, is_reference: true }, true, false).is_reference).toBe(true)
})
it("initializes extracted chi and constant-1 detector suggestions", () => {
  const chi = initialColumnMapping({ ...inspection, athena_suggestion: { ...inspection.athena_suggestion!, data_type: "chi", mode: "mu", denominator: null, numerator: ["c1"], units: "eV" } }, previous)
  expect(columnPayload(chi)).toMatchObject({ data_type: "chi", mode: "mu", denominator: null, units: "eV", signal_multiplier: 1, invert: false })
  const constant = initialColumnMapping({ ...inspection, athena_suggestion: { ...inspection.athena_suggestion!, numerator: [] } }, previous)
  expect(columnPayload(constant).numerator).toEqual([])
})
it.each([[[], null], [["one"], "one"], [["one", "two"], ["one", "two"]]])("keeps old single-column payloads compatible while supporting denominator %j", (denominator, expected) => {
  expect(columnPayload({ ...previous, denominator: denominator as string[] }).denominator).toEqual(expected)
})
it("flips complete numerator and denominator selections without reusing either array", () => {
  const mapping = { ...previous, numerator: ["n1", "n2"], denominator: ["d1", "d2"] }
  const flipped = flipSignalColumns(mapping)
  expect(flipped).toMatchObject({ numerator: ["d1", "d2"], denominator: ["n1", "n2"], invert: false, signal_multiplier: -9 })
  expect(flipped.numerator).not.toBe(mapping.denominator)
  expect(flipped.denominator).not.toBe(mapping.numerator)
  expect(flipSignalColumns(flipped)).toMatchObject({ numerator: ["n1", "n2"], denominator: ["d1", "d2"] })
})
it("preserves legacy sign inversion as a negative scale instead of sending invert", () => {
  expect(columnPayload(previous)).toMatchObject({ signal_multiplier: -9, invert: false })
  expect(columnPayload({ ...previous, signal_multiplier: -2 })).toMatchObject({ signal_multiplier: 2, invert: false })
})
it("sends the reference marker only when selected", () => {
  expect(columnPayload({ ...previous, is_reference: true }).is_reference).toBe(true)
  expect(columnPayload({ ...previous, is_reference: false })).not.toHaveProperty("is_reference")
})

it("retains batch preprocessing across column changes and clears energy operations for chi", () => {
  const mapping = { ...previous, preprocessing: { mark: true, standard_id: 'std', align: true, copy_parameters: true } }
  expect(initialColumnMapping(inspection, mapping).preprocessing).toEqual(mapping.preprocessing)
  expect(changeInputType(mapping, 'chi').preprocessing).toEqual({ mark: true, standard_id: null, align: false, copy_parameters: false })
})
it("selects the imported sample even when both it and its reference are unmarked", () => {
  const sample = { id: 'sample', reference_id: 'ref', marked: false } as AthenaGroup
  const reference = { id: 'ref', reference_id: null, marked: false } as AthenaGroup
  expect(lastImportedSample([sample, reference])).toBe(sample)
})

it('sends the grid without UI flags and resets only activation for fresh layouts and chi', () => {
  const rebin = { ...defaultRebin, enabled: true, e0: 17168, width: 4 }
  const mapping = { ...previous, rebin }
  expect(columnPayload(mapping).rebin).toEqual({ e0: 17168, emin: -30, emax: 50, pre: 10, xanes: .5, exafs: .05, width: 4 })
  expect(initialColumnMapping(inspection, mapping).rebin).toEqual({ ...rebin, enabled: false })
  expect(changeInputType(mapping, 'chi').rebin).toEqual({ ...rebin, enabled: false })
  expect(columnPayload({ ...mapping, rebin: { ...rebin, enabled: false } }).rebin).toBeNull()
  expect(mapping.rebin.enabled).toBe(true)
})

it.each([{ pre: 0 }, { xanes: -1 }, { exafs: '' }, { e0: -1 }, { width: 2.5 }, { width: 12 },
  { emin: 50, emax: 50 }, { emin: -50, emax: -10 }])('rejects invalid active grids but allows disabling them: %j', invalid => {
  const rebin = { ...defaultRebin, enabled: true, ...invalid } as NonNullable<ColumnMapping['rebin']>
  expect(columnProblem({ ...previous, rebin })).toBeTruthy()
  expect(columnProblem({ ...previous, rebin: { ...rebin, enabled: false } })).toBeNull()
})

it('restores accepted choices over guesses and keeps the recorded activation and preprocessing flags', () => {
  const remembered = { ...previous, energy_column: 'c0', numerator: ['c2'], denominator: ['c1', 'c2'],
    reference_numerator: 'c1', reference_denominator: '1',
    preprocessing: { mark: true, standard_id: 'standard', copy_parameters: true, align: true },
    rebin: { ...defaultRebin, enabled: true, pre: 7 } }
  const input = { ...inspection, remembered_columns: { version: 8, matching_columns: true, mapping: remembered, warnings: [] } }
  const selected = initialColumnMapping(input, previous)
  expect(selected).toMatchObject({ ...remembered, signal_multiplier: -9, invert: false })
  expect(columnPayload(selected)).toMatchObject({ rebin: { pre: 7 }, rebin_grid: { pre: 7 }, preprocessing: remembered.preprocessing })
  expect(initialColumnMapping(input, previous, false)).toEqual(initialColumnMapping(inspection, previous))
  expect(remembered.rebin.enabled).toBe(true)
})

it('stores a disabled valid grid separately without sending file-specific E0, but omits invalid disabled edits', () => {
  const mapping = { ...previous, rebin: { ...defaultRebin, e0: 8000, pre: 7 } }
  const body = columnPayload(mapping)
  expect(body.rebin).toBeNull()
  expect(body.rebin_grid).toEqual({ emin: -30, emax: 50, pre: 7, xanes: .5, exafs: .05, width: 3 })
  expect(columnPayload({ ...mapping, rebin: { ...mapping.rebin, pre: '' } })).not.toHaveProperty('rebin_grid')
})

it('shares every parameter by column position across renamed headers and upload IDs', () => {
  const mapping: ColumnMapping = { ...previous, energy_column: 'c0', numerator: ['c1', 'c2'], denominator: ['c2'],
    reference_numerator: '1', reference_denominator: 'c1', reference_log: false, reference_same_element: false,
    individual_channels: true, is_reference: true, preprocessing: { mark: true, standard_id: 'std', align: true, copy_parameters: true },
    rebin: { ...defaultRebin, enabled: true, e0: 8000 } }
  const target = { ...inspection, columns: inspection.columns.map(c => ({ ...c, name: `renamed ${c.name}`, column_id: `next-${c.index}` })) }
  expect(reuseColumnMapping(inspection, target, mapping)).toEqual({ ...mapping, energy_column: 'next-0',
    numerator: ['next-1', 'next-2'], denominator: ['next-2'], reference_denominator: 'next-1' })
})

it('pauses sharing for a missing selected column, a nonnumeric column, or a known reordered label', () => {
  const mapping: ColumnMapping = { ...previous, energy_column: 'c0', numerator: ['c1'], denominator: '', reference_numerator: '', reference_denominator: 'c2' }
  expect(reuseColumnMapping(inspection, { ...inspection, columns: inspection.columns.slice(0, 2) }, mapping)).toBeNull()
  expect(reuseColumnMapping(inspection, { ...inspection, columns: inspection.columns.map(c => ({ ...c, numeric: false })) }, mapping)).toBeNull()
  expect(reuseColumnMapping(inspection, { ...inspection, columns: inspection.columns.map((c, i) => ({ ...c, name: ['e', 'it', 'i0'][i] })) }, mapping)).toBeNull()
  expect(reuseColumnMapping(inspection, inspection, { ...mapping, numerator: ['unknown'] })).toBeNull()
})

it('allows unused columns to differ and preserves scalar denominators and constant signals', () => {
  const mapping: ColumnMapping = { ...previous, energy_column: 'c0', numerator: [], denominator: '', reference_numerator: '', reference_denominator: '1' }
  const target = { ...inspection, columns: inspection.columns.slice(0, 1) }
  expect(reuseColumnMapping(inspection, target, mapping)).toEqual(mapping)
  expect(reuseColumnMapping(inspection, inspection, { ...mapping, denominator: 'c1' })?.denominator).toBe('c1')
})

const dualInspection: InspectionResponse = { ...inspection, columns: ['energy', 'i0', 'it', 'if1', 'if2'].map((name, index) => ({
  ...inspection.columns[0], name, index, column_id: `c${index}`,
})) }
const transmission: ColumnMapping = { ...previous, mode: 'transmission', energy_column: 'c0', numerator: ['c1'], denominator: 'c2',
  reference_numerator: '', reference_denominator: '', signal_multiplier: 1, invert: false }

it('adds an independent fluorescence recipe without changing reviewed transmission or shared settings', () => {
  const mapping = { ...transmission, units: 'keV' as const, signal_multiplier: 2, invert: true,
    rebin: { ...defaultRebin, enabled: true }, preprocessing: { mark: true, standard_id: 'std', align: true, copy_parameters: true } }
  const dual = setDualMode(mapping, dualInspection, true)
  expect(dual).toEqual({ ...mapping, additional_fluorescence: { numerator: ['c3'], denominator: 'c1',
    individual_channels: false, signal_multiplier: 1, invert: false } })
  expect(columnProblem(dual)).toBeNull()
  expect(setDualMode(dual, dualInspection, false)).toEqual(mapping)
})

it('keeps existing fluorescence choices when adding transmission and respects reader suggestions', () => {
  const mapping: ColumnMapping = { ...transmission, mode: 'fluorescence', numerator: ['c3', 'c4'], denominator: ['c1'],
    individual_channels: true, signal_multiplier: 3, invert: true }
  const dual = setDualMode(mapping, { ...dualInspection, plugin_suggestions: {
    transmission: { ...inspection.athena_suggestion!, numerator: ['c2'], denominator: 'c1' },
  } }, true)
  expect(dual).toMatchObject({ mode: 'transmission', numerator: ['c2'], denominator: 'c1', individual_channels: false,
    signal_multiplier: 1, invert: false, additional_fluorescence: { numerator: ['c3', 'c4'], denominator: ['c1'],
      individual_channels: true, signal_multiplier: 3, invert: true } })
  expect(columnPayload(dual).additional_fluorescence?.denominator).toBe('c1')
})

it('requires explicit channels for both modes and a finite independent fluorescence scale', () => {
  const missing = setDualMode(transmission, inspection, true)
  expect(missing.additional_fluorescence?.numerator).toEqual([])
  expect(columnProblem(missing)).toMatch(/fluorescence signal and I₀/)
  const dual = setDualMode(transmission, dualInspection, true)
  expect(columnProblem({ ...dual, denominator: '' })).toMatch(/transmission/)
  expect(columnProblem({ ...dual, mode: 'mu' })).toMatch(/Both modes/)
  for (const signal_multiplier of ['', Infinity] as const) expect(columnProblem({ ...dual,
    additional_fluorescence: { ...dual.additional_fluorescence!, signal_multiplier } })).toMatch(/fluorescence multiplicative constant/)
  expect(columnProblem({ ...transmission, numerator: [], denominator: '' })).toBeNull()
})

it('resets dual mode for chi and new layouts, restores remembered dual settings, and remaps both modes in a batch', () => {
  const dual = setDualMode(transmission, dualInspection, true)
  expect(changeInputType(dual, 'chi').additional_fluorescence).toBeNull()
  expect(initialColumnMapping(inspection, dual).additional_fluorescence).toBeUndefined()
  const remembered = { ...dualInspection, remembered_columns: { version: 1, matching_columns: true, mapping: dual, warnings: [] } }
  expect(initialColumnMapping(remembered, transmission).additional_fluorescence).toEqual(dual.additional_fluorescence)
  const target = { ...dualInspection, columns: dualInspection.columns.map(c => ({ ...c, name: `renamed ${c.name}`, column_id: `new-${c.index}` })) }
  const reused = reuseColumnMapping(dualInspection, target, dual)
  expect(reused).toMatchObject({ numerator: ['new-1'], denominator: 'new-2', additional_fluorescence: {
    numerator: ['new-3'], denominator: 'new-1', signal_multiplier: 1,
  } })
  expect(reuseColumnMapping(dualInspection, { ...target, columns: target.columns.slice(0, 3) }, dual)).toBeNull()
})
