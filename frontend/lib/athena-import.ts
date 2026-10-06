import type { InspectionResponse } from "./contracts"
import { energyProcessingSettings, type AthenaGroup } from "./athena"

export interface ImportPreprocessing {
  mark: boolean; standard_id: string | null; copy_parameters: boolean; align: boolean
}
export const defaultPreprocessing: ImportPreprocessing = { mark: false, standard_id: null, copy_parameters: false, align: false }

export interface ImportRebinOptions {
  enabled: boolean; e0: number | null; emin: number | ""; emax: number | ""
  pre: number | ""; xanes: number | ""; exafs: number | ""; width: number | ""
}
export const defaultRebin: ImportRebinOptions = { enabled: false, e0: null, emin: -30, emax: 50, pre: 10, xanes: .5, exafs: .05, width: 3 }

export interface FluorescenceMapping {
  numerator: string[]; denominator: string | string[]
  individual_channels?: boolean; signal_multiplier?: number | ""; invert?: boolean
}

export interface ColumnMapping {
  energy_column: string; numerator: string[]; denominator: string | string[]
  mode: "mu" | "transmission" | "fluorescence"
  units: "eV" | "keV"; data_type: "mu" | "xanes" | "norm" | "chi" | "xmudat"
  is_normalized?: boolean
  exafs?: boolean | null
  is_reference?: boolean
  reference_numerator: string; reference_denominator: string; sort: boolean
  reference_log?: boolean; reference_same_element?: boolean; individual_channels?: boolean
  signal_multiplier?: number | ""; invert?: boolean
  preprocessing?: ImportPreprocessing
  rebin?: ImportRebinOptions
  additional_fluorescence?: FluorescenceMapping | null
}

export interface ColumnPreview {
  filename: string; points: number; x_label: string; y_label: string; warnings: string[]
  traces: { id: string; label: string; role: "sample" | "reference"; x: number[]; y: number[]; stage?: "original" | "rebinned" }[]
  rebin_results?: { id: string; label: string; role: "sample" | "reference"; e0: number; source_points: number; output_points: number }[]
}

export function columnPayload(mapping: ColumnMapping, { automaticExafs = true } = {}) {
  mapping = normalizeImportInversion(mapping)
  if (automaticExafs) mapping = automaticImportProcessing(mapping)
  const denominator = denominatorColumns(mapping)
  const fluorescenceDenominator = mapping.additional_fluorescence && denominatorColumns(mapping.additional_fluorescence)
  const { enabled, ...rebin } = mapping.rebin ?? defaultRebin
  const { exafs: _exafs, ...input } = mapping
  const payload = { ...input, ...importExafsSetting(mapping.data_type, automaticExafs), preprocessing: mapping.preprocessing ?? defaultPreprocessing,
    ...(mapping.additional_fluorescence ? { additional_fluorescence: { ...mapping.additional_fluorescence,
      denominator: fluorescenceDenominator!.length > 1 ? fluorescenceDenominator : fluorescenceDenominator![0] || null } } : {}),
    ...(mapping.rebin ? { rebin: enabled ? rebin : null } : {}),
    ...(mapping.rebin && !rebinProblem({ ...mapping.rebin, enabled: true, e0: null }) ? {
      rebin_grid: Object.fromEntries((['emin', 'emax', 'pre', 'xanes', 'exafs', 'width'] as const).map(key => [key, mapping.rebin![key]])),
    } : {}),
    denominator: denominator.length > 1 ? denominator : denominator[0] || null,
    reference_numerator: mapping.reference_numerator || null, reference_denominator: mapping.reference_denominator || null }
  if (!payload.is_reference) delete payload.is_reference
  return payload
}

export function denominatorColumns(mapping: Pick<ColumnMapping, 'denominator'>): string[] {
  return Array.isArray(mapping.denominator) ? mapping.denominator : mapping.denominator ? [mapping.denominator] : []
}

type SignalMapping = {
  numerator: string[]; denominator: string | string[]
  signal_multiplier?: number | ""; invert?: boolean
}

function normalizeSignalInversion<T extends SignalMapping>(mapping: T): T {
  if (!mapping.invert) return mapping
  const multiplier = mapping.signal_multiplier ?? 1
  return { ...mapping, signal_multiplier: multiplier === "" ? "" : -multiplier, invert: false }
}

export function normalizeImportInversion(mapping: ColumnMapping): ColumnMapping {
  const normalized = normalizeSignalInversion(mapping)
  return normalized.additional_fluorescence ? { ...normalized,
    additional_fluorescence: normalizeSignalInversion(normalized.additional_fluorescence) } : normalized
}

export function flipSignalColumns<T extends SignalMapping>(mapping: T): T {
  const normalized = normalizeSignalInversion(mapping)
  return { ...normalized, numerator: [...denominatorColumns(normalized)], denominator: [...normalized.numerator] }
}

export function columnProblem(mapping: ColumnMapping): string | null {
  if (mapping.signal_multiplier === "" || !Number.isFinite(mapping.signal_multiplier ?? 1)) return "Enter a finite multiplicative constant."
  const fluorescence = mapping.additional_fluorescence
  if (fluorescence) {
    if (mapping.mode !== 'transmission' || mapping.data_type === 'chi') return "Both modes require transmission and fluorescence energy data."
    if (!mapping.numerator.length || !denominatorColumns(mapping).length) return "Choose the transmission numerator (I₀) and denominator (It) columns."
    if (!fluorescence.numerator.length || !denominatorColumns(fluorescence).length) return "Choose the fluorescence signal and I₀ columns."
    if (fluorescence.signal_multiplier === '' || !Number.isFinite(fluorescence.signal_multiplier ?? 1)) return "Enter a finite fluorescence multiplicative constant."
  }
  const p = mapping.preprocessing
  if (p && (p.align || p.copy_parameters) && !p.standard_id) return "Choose a preprocessing standard."
  return rebinProblem(mapping.rebin)
}

export function rebinProblem(r?: ImportRebinOptions): string | null {
  if (r?.enabled) {
    if (r.e0 !== null && (!Number.isFinite(r.e0) || r.e0 <= 0)) return "Enter a positive rebin grid E₀ or leave it automatic."
    for (const key of ['emin', 'emax', 'pre', 'xanes', 'exafs', 'width'] as const) {
      if (r[key] === '' || !Number.isFinite(r[key])) return "Enter finite rebin boundaries and grid steps."
    }
    if (r.emin === r.emax || Math.max(Number(r.emin), Number(r.emax)) <= 0) return "Rebin edge boundaries must differ and end above E₀."
    if ([r.pre, r.xanes, r.exafs].some(n => Number(n) <= 0)) return "Rebin grid steps must be positive."
    if (!Number.isInteger(r.width) || Number(r.width) < 1 || Number(r.width) > 11) return "Rebin smoothing width must be an integer from 1 to 11."
  }
  return null
}

export function changeInputType(mapping: ColumnMapping, data_type: ColumnMapping["data_type"], { automaticExafs = true } = {}): ColumnMapping {
  const { exafs: _exafs, ...input } = mapping
  return { ...input, data_type, ...importExafsSetting(data_type, automaticExafs), is_normalized: data_type === 'norm' || data_type === 'xmudat', ...(data_type === "chi" ? { mode: "mu" as const, units: "eV" as const,
    denominator: "", invert: false, signal_multiplier: 1, reference_numerator: "", reference_denominator: "",
    ...(mapping.additional_fluorescence ? { additional_fluorescence: null } : {}),
    ...(mapping.rebin ? { rebin: { ...mapping.rebin, enabled: false } } : {}),
    ...(mapping.preprocessing ? { preprocessing: { ...mapping.preprocessing, standard_id: null, copy_parameters: false, align: false } } : {}) } : {}) }
}

function importExafsSetting(data_type: ColumnMapping['data_type'], automaticExafs: boolean): { exafs?: boolean | null } {
  return data_type === 'chi' || data_type === 'xmudat' ? {} : { exafs: automaticExafs ? null : data_type !== 'xanes' }
}

function automaticImportProcessing(mapping: ColumnMapping): ColumnMapping {
  if (mapping.data_type === 'chi' || mapping.data_type === 'xmudat') return mapping
  // Old remembered choices may carry XANES-only processing. New imports decide
  // EXAFS eligibility from each spectrum, while retaining its normalization flag.
  return { ...mapping, data_type: energyProcessingSettings(mapping).is_normalized ? 'norm' : 'mu', exafs: null }
}

export function changeImportProcessing(mapping: ColumnMapping, options: Partial<ReturnType<typeof energyProcessingSettings>>, { automaticExafs = true } = {}): ColumnMapping {
  const { is_normalized, exafs } = { ...energyProcessingSettings(mapping), ...options }
  if (automaticExafs) return { ...mapping, is_normalized, exafs: null, data_type: is_normalized ? 'norm' : 'mu' }
  return { ...mapping, is_normalized, exafs, data_type: !exafs ? 'xanes' : is_normalized ? 'norm' : 'mu' }
}

export function setDualMode(mapping: ColumnMapping, inspection: InspectionResponse, enabled: boolean): ColumnMapping {
  if (!enabled) {
    const { additional_fluorescence: _fluorescence, ...single } = mapping
    return single
  }
  if (mapping.data_type === 'chi' || mapping.additional_fluorescence) return mapping
  const suggested = (mode: 'transmission' | 'fluorescence') => inspection.plugin_suggestions?.[mode]
    ?? (inspection.athena_suggestion?.mode === mode ? inspection.athena_suggestion : undefined)
  const named = (role: string, pattern: RegExp) => inspection.columns.find(c => c.role_hint === role)?.column_id
    ?? inspection.columns.find(c => pattern.test(c.name.replace(/[^a-z0-9]/gi, '')))?.column_id
  const i0 = named('i0', /^(?:i0|io)$/i)
  const it = named('it', /^(?:it|i1|itrans|transmission)$/i)
  const fluorescence = named('ifluor', /^(?:if\d*|ifluor\d*|fluorescence\d*|iy)$/i)
  const transmissionSuggestion = suggested('transmission')
  const fluorescenceSuggestion = suggested('fluorescence')
  const additional: FluorescenceMapping = mapping.mode === 'fluorescence'
    ? { numerator: [...mapping.numerator], denominator: denominatorColumns(mapping), individual_channels: mapping.individual_channels,
      signal_multiplier: mapping.signal_multiplier, invert: mapping.invert }
    : { numerator: fluorescenceSuggestion?.numerator ?? (fluorescence ? [fluorescence] : []),
      denominator: fluorescenceSuggestion?.denominator ?? i0 ?? '', individual_channels: false, signal_multiplier: 1, invert: false }
  return { ...mapping, mode: 'transmission', ...(mapping.mode !== 'transmission' ? {
    numerator: transmissionSuggestion?.numerator ?? (i0 ? [i0] : []), denominator: transmissionSuggestion?.denominator ?? it ?? '',
    individual_channels: false, signal_multiplier: 1, invert: false,
  } : {}), additional_fluorescence: additional }
}

/** The reference channel a recognized beamline file carries, as mapping fields. */
export function suggestedReference(inspection: InspectionResponse): Pick<ColumnMapping, 'reference_numerator' | 'reference_denominator' | 'reference_log'> | null {
  const reference = inspection.beamline_reader?.reference
  return reference ? { reference_numerator: reference.numerator, reference_denominator: reference.denominator ?? '', reference_log: reference.log } : null
}

export function initialColumnMapping(inspection: InspectionResponse, previous: ColumnMapping, remembered = true, resetReference = true): ColumnMapping {
  const cols = inspection.columns, suggested = inspection.athena_suggestion
  const { additional_fluorescence: _fluorescence, is_normalized: _normalized, exafs: _exafs, ...singlePrevious } = previous
  // A reference channel the reader recognized (a foil behind It) is imported
  // by default; it used to be cleared, so every file needed it picked by hand.
  // Only a reference whose edge the reader saw in the data is imported by
  // default; one it could not check (no stated E0) is offered as a button.
  const reference = suggested && suggested.data_type !== 'chi' && inspection.beamline_reader?.reference?.default === true
    ? suggestedReference(inspection) : null
  const mapping: ColumnMapping = suggested ? { ...singlePrevious, ...suggested, denominator: suggested.denominator ?? "", reference_numerator: "",
    reference_denominator: "", ...reference, invert: false, signal_multiplier: 1, individual_channels: false }
    : { ...singlePrevious, ...(previous.is_normalized === undefined ? {} : { is_normalized: previous.is_normalized }),
      energy_column: cols.find(c => c.role_hint === "energy")?.column_id ?? cols[0]?.column_id ?? "",
      numerator: [cols.find(c => c.role_hint === "mu")?.column_id ?? cols[1]?.column_id ?? ""],
      denominator: cols.find(c => c.role_hint === "i0")?.column_id ?? cols[2]?.column_id ?? "",
      reference_numerator: "", reference_denominator: "" }
  const restored = remembered && inspection.remembered_columns
  const is_reference = resetReference ? false : previous.is_reference ?? false
  const selected = normalizeImportInversion(restored ? { ...mapping, ...restored.mapping, is_reference } : { ...mapping, is_reference })
  if (selected.rebin && !restored) selected.rebin = { ...selected.rebin, enabled: false }
  return selected.data_type === 'chi' ? changeInputType(selected, 'chi') : automaticImportProcessing(selected)
}

function mappingColumnIds(mapping: ColumnMapping): string[] {
  const fluorescence = mapping.additional_fluorescence
  return [mapping.energy_column, ...mapping.numerator, ...denominatorColumns(mapping),
    mapping.reference_numerator, mapping.reference_denominator,
    ...(fluorescence ? [...fluorescence.numerator, ...denominatorColumns(fluorescence)] : [])]
    .filter(id => id && id !== '1')
}

/** Why a shared batch must stop and ask before importing this file, or null.
 *
 * A batch reuses column positions. That is only the same measurement when the
 * file has the same layout: a renamed, moved or missing selected column, a
 * different column count, or energy units the file states differently, can
 * each turn a plausible-looking spectrum into the wrong ratio. */
export function reuseProblem(source: InspectionResponse, target: InspectionResponse, mapping: ColumnMapping): string | null {
  for (const id of mappingColumnIds(mapping)) {
    const original = source.columns.find(c => c.column_id === id)
    if (!original) return 'a selected column is not in the first file.'
    const now = target.columns.find(c => c.index === original.index)
    if (!now || !now.numeric) return `selected column ${original.index + 1} (${original.name}) is missing in this file.`
    if (now.name !== original.name) return `selected column ${original.index + 1} was “${original.name}” and is “${now.name}” here.`
  }
  if (source.columns.length !== target.columns.length) return `the file has ${target.columns.length} columns, the first had ${source.columns.length}.`
  const renamed = target.columns.find((c, i) => c.name !== source.columns[i]?.name)
  if (renamed) return `column ${renamed.index + 1} is “${renamed.name}” here, “${source.columns[renamed.index].name}” in the first file.`
  const energy = source.columns.find(c => c.column_id === mapping.energy_column)
  const units = energy && target.column_units?.[target.columns[energy.index]?.column_id]
  if (mapping.data_type !== 'chi' && units && units !== mapping.units) return `this file’s energy reads as ${units}; the batch uses ${mapping.units}.`
  // A first file that asked sample-or-foil carries the user's answer to the
  // batch; after a clear first file, a scan that cannot tell must ask too.
  const evidence = (inspection: InspectionResponse) => beamEvidence(inspection)
  if (evidence(target) === 'ask' && evidence(source) !== 'ask') return 'this scan’s I0/It edge is marginal beside an It/Iref edge, so it may be a foil rather than a sample; say which it measured.'
  // A choice made on a scan with the same evidence covers this one (the user
  // saw it and decided); a scan whose edges say otherwise asks again.
  if (mapping.mode === 'transmission' && evidence(target) !== evidence(source)) {
    if (evidence(target) === null || evidence(source) === null) return 'beamline measurement evidence is missing from one of these files; confirm which channels this file measured before continuing the batch.'
    const contrast = target.beamline_reader?.measurement?.contrast ?? {}
    const times = (key: string) => typeof contrast[key] === 'number' ? ` (${(contrast[key] as number).toFixed(0)} times its noise)` : ''
    const foil = foilColumns(target)
    const at = (inspection: InspectionResponse, ids: string[]) => ids.map(id => inspection.columns.find(c => c.column_id === id)?.index)
    const usesFoil = !!foil && String(at(source, [...mapping.numerator, ...denominatorColumns(mapping)])) === String(at(target, foil))
    if (evidence(target) === 'sample' && usesFoil) return `this scan shows a clear I0/It sample edge${times('transmission')}, but the batch imports It/Iref as a foil scan; say which it measured.`
    if (evidence(target) === 'foil' && !usesFoil) return `this scan’s I0/It shows no edge and It/Iref does${times('reference')}, as when a foil is scanned, but the batch imports it as a sample; say which it measured.`
  }
  return null
}

/** What a scan's own edges say it measured in transmission: a clear sample
 * edge in I0/It, only a foil's edge in It/Iref, or too little to tell. */
function beamEvidence(inspection: InspectionResponse): 'sample' | 'foil' | 'ask' | null {
  const measurement = inspection.beamline_reader?.measurement
  if (inspection.plugin_suggestions || measurement?.mode !== 'transmission') return null
  return measurement.ambiguous ? 'ask' : measurement.foil_spectrum ? 'foil' : 'sample'
}

// The It/Iref columns a scan offers as a foil spectrum, if it has a reference edge.
function foilColumns(inspection: InspectionResponse): string[] | null {
  const reader = inspection.beamline_reader
  const foil = reader?.suggestions?.foil ?? (reader?.measurement?.foil_spectrum ? reader.suggestions?.transmission : undefined)
  if (foil) return [...foil.numerator, ...(foil.denominator ? [foil.denominator] : [])]
  return reader?.reference ? [reader.reference.numerator, ...(reader.reference.denominator ? [reader.reference.denominator] : [])] : null
}

// A shared batch reuses the column positions the user selected only for a file
// with the same layout; reuseProblem says why any other file pauses the batch.
export function reuseColumnMapping(source: InspectionResponse, target: InspectionResponse, mapping: ColumnMapping): ColumnMapping | null {
  if (reuseProblem(source, target, mapping)) return null
  const column = (id: string): string | undefined => {
    const original = source.columns.find(c => c.column_id === id)
    return original && target.columns.find(c => c.index === original.index && c.numeric)?.column_id
  }
  const reference = (id: string) => !id || id === '1' ? id : column(id)
  const energy_column = column(mapping.energy_column)
  const numerator = mapping.numerator.map(column)
  const denominator = denominatorColumns(mapping).map(column)
  const reference_numerator = reference(mapping.reference_numerator)
  const reference_denominator = reference(mapping.reference_denominator)
  let additional_fluorescence = mapping.additional_fluorescence
  if (additional_fluorescence) {
    const numerator = additional_fluorescence.numerator.map(column)
    const denominator = denominatorColumns(additional_fluorescence).map(column)
    if (numerator.some(id => id === undefined) || denominator.some(id => id === undefined)) return null
    additional_fluorescence = { ...additional_fluorescence, numerator: numerator as string[],
      denominator: Array.isArray(additional_fluorescence.denominator) ? denominator as string[] : denominator[0] ?? '' }
  }
  if (!energy_column || numerator.some(id => id === undefined) || denominator.some(id => id === undefined)
    || reference_numerator === undefined || reference_denominator === undefined) return null
  return { ...mapping, energy_column, numerator: numerator as string[],
    ...(additional_fluorescence ? { additional_fluorescence } : {}),
    denominator: Array.isArray(mapping.denominator) ? denominator as string[] : denominator[0] ?? '',
    reference_numerator, reference_denominator }
}

/** Files a multi-file selection leaves out of a scan batch, with the reason.
 *
 * Selecting a beamline folder brings along what is not a scan: LabVIEW's
 * '.last' counter, sequence logs, alignment scans, and the per-scan detector
 * HDF5 beside each text scan. Each would stop a shared batch; they are listed
 * for the user, who can still include them. */
export function batchExclusions(names: string[]): Map<number, string> {
  const left = new Map<number, string>()
  if (names.length < 2) return left
  // A detector file is 'series.0007.hdf5' beside text scans 'series.0003' ...;
  // its own text scan may be missing (an aborted first scan).
  const series = (name: string) => name.toLowerCase().replace(/\.(hdf5|h5)$/, '').replace(/\.\d+$/, '')
  const textSeries = new Set(names.filter(name => !/\.(hdf5|h5)$/i.test(name)).map(series))
  names.forEach((name, index) => {
    const lower = name.toLowerCase()
    if (lower.endsWith('.last')) left.set(index, "the scan counter LabVIEW writes, not a scan")
    else if (/^sequence log|\.log$/.test(lower)) left.set(index, "an acquisition log")
    else if (/(^|[^a-z])align(ment)?([^a-z]|$)/.test(lower)) left.set(index, "an alignment scan")
    else if (/\.(hdf5|h5)$/.test(lower) && textSeries.has(series(name))) left.set(index, "the detector spectra of a scan in this series; its text file holds the scan")
  })
  return left.size === names.length ? new Map() : left
}

// The server's project limits (athena.py save and _exchange_budget).
export const MAX_PROJECT_GROUPS = 100
export const MAX_PROJECT_VALUES = 2_000_000

function retainedValues(group: AthenaGroup): number {
  const arrays = (key: string) => Object.values((group.source[key] ?? {}) as Record<string, unknown[]>)
    .reduce((total, values) => total + (Array.isArray(values) ? values.length : 0), 0)
  return group.energy.length * 2 + arrays('column_arrays') + arrays('raw_arrays')
}

/** Say before a batch starts whether it will outgrow the project.
 *
 * The server refuses the import that crosses either limit, so a 58-group
 * series stopped part-way at file 51 of a 60-file selection. Counting first
 * lets the user split the series or open a new project instead. */
export function batchCapacityWarning(mapping: ColumnMapping, inspection: InspectionResponse, groups: AthenaGroup[], files: number): string | null {
  if (files < 2) return null
  const samples = (mapping.individual_channels && mapping.numerator.length > 1 ? mapping.numerator.length : 1)
    + (mapping.additional_fluorescence ? 1 : 0)
  const referenced = !!(mapping.reference_numerator || mapping.reference_denominator)
  const perFile = samples * (referenced ? 2 : 1)
  const rows = inspection.row_count, finite = inspection.columns.filter(c => c.preview.every(v => v !== null)).length
  const valuesPerFile = samples * rows * (finite + 4) + (referenced ? samples * rows * 7 : 0)
  const groupsAfter = groups.length + files * perFile
  const valuesAfter = groups.reduce((total, g) => total + retainedValues(g), 0) + files * valuesPerFile
  const fit = Math.max(0, Math.min(Math.floor((MAX_PROJECT_GROUPS - groups.length) / perFile),
    Math.floor((MAX_PROJECT_VALUES - (valuesAfter - files * valuesPerFile)) / valuesPerFile)))
  if (groupsAfter <= MAX_PROJECT_GROUPS && valuesAfter <= MAX_PROJECT_VALUES) return null
  const reason = groupsAfter > MAX_PROJECT_GROUPS
    ? `${groupsAfter} groups (${perFile} per file${referenced ? ', counting each reference' : ''}); a project holds at most ${MAX_PROJECT_GROUPS}`
    : `about ${(valuesAfter / 1e6).toFixed(1)} million stored values; a project holds at most 2 million`
  return `This batch would bring the project to ${reason}. Only the first ${fit} of these ${files} files fit: import the series into its own new project, or choose fewer files.`
}

export function lastImportedSample(groups: AthenaGroup[]): AthenaGroup | undefined {
  const references = new Set(groups.map(g => g.reference_id).filter(Boolean))
  return groups.findLast(g => !references.has(g.id)) ?? groups.at(-1)
}

export function columnExpression(mapping: ColumnMapping, columns: InspectionResponse["columns"]): string {
  const name = (id: string) => columns.find(c => c.column_id === id)?.name ?? (id === "1" ? "1" : "?")
  const numerator = mapping.numerator.map(name).join(mapping.individual_channels ? ", " : " + ") || "1"
  const denominator = denominatorColumns(mapping).map(name).join(" + ") || "1"
  const ratio = mapping.mode === "mu" ? `(${numerator})` : `(${numerator}) / (${denominator})`
  return `${mapping.data_type === "chi" ? "χ(k)" : "μ(E)"} = ${mapping.invert ? "−1 × " : ""}${(mapping.signal_multiplier ?? 1) !== 1 ? `${mapping.signal_multiplier === "" ? "?" : mapping.signal_multiplier} × ` : ""}${mapping.individual_channels && mapping.numerator.length > 1 ? "each: " : ""}${mapping.mode === "transmission" ? `ln(|${ratio}|)` : ratio}`
}

export function numeratorRange(text: string, count: number): number[] {
  const selected = new Set<number>()
  if (!text.trim()) throw new Error("Enter column numbers, for example 4-8, 11.")
  for (const item of text.split(",")) {
    const match = item.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!match) throw new Error("Use comma-separated column numbers or ranges, for example 4-8, 11.")
    const [start, end] = [Number(match[1]), Number(match[2] ?? match[1])].sort((a, b) => a - b)
    if (start < 1 || end > count) throw new Error(`Choose column numbers between 1 and ${count}.`)
    for (let n = start; n <= end; n++) selected.add(n - 1)
  }
  return [...selected].sort((a, b) => a - b)
}
