import type { AthenaGroup } from "./athena"
import { expect, it } from "vitest"
import type { InspectionResponse } from "./contracts"
import { columnPayload, columnProblem, defaultRebin, initialColumnMapping, changeInputType, lastImportedSample, type ColumnMapping } from "./athena-import"
const previous: ColumnMapping = { energy_column: "old", numerator: ["old"], denominator: ["d1", "d2"], mode: "fluorescence",
  units: "eV", data_type: "xanes", reference_numerator: "r1", reference_denominator: "r2", signal_multiplier: 9, invert: true, sort: false }
const inspection: InspectionResponse = { upload_id: "u", display_name: "file.dat", row_count: 5, warnings: [], issues: [],
  columns: ["e", "i0", "it"].map((name, index) => ({ column_id: `c${index}`, name, index, preview: [8, 9, 10, 11, 12], role_hint: null, unit: null, numeric: true })),
  athena_suggestion: { energy_column: "c0", numerator: ["c1"], denominator: "c2", mode: "transmission", units: "keV", data_type: "mu" } }
it("initializes a new file from backend suggestions and clears previous transforms and references", () => {
  expect(initialColumnMapping(inspection, previous)).toEqual({ ...previous, ...inspection.athena_suggestion,
    reference_numerator: "", reference_denominator: "", signal_multiplier: 1, invert: false, individual_channels: false })
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
  expect(selected).toMatchObject(remembered)
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
