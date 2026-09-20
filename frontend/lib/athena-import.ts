import type { InspectionResponse } from "./contracts"
import type { AthenaGroup } from "./athena"

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

export function columnPayload(mapping: ColumnMapping) {
  mapping = normalizeImportInversion(mapping)
  const denominator = denominatorColumns(mapping)
  const fluorescenceDenominator = mapping.additional_fluorescence && denominatorColumns(mapping.additional_fluorescence)
  const { enabled, ...rebin } = mapping.rebin ?? defaultRebin
  const payload = { ...mapping, preprocessing: mapping.preprocessing ?? defaultPreprocessing,
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

export function changeInputType(mapping: ColumnMapping, data_type: ColumnMapping["data_type"]): ColumnMapping {
  return { ...mapping, data_type, ...(data_type === "chi" ? { mode: "mu" as const, units: "eV" as const,
    denominator: "", invert: false, signal_multiplier: 1, reference_numerator: "", reference_denominator: "",
    ...(mapping.additional_fluorescence ? { additional_fluorescence: null } : {}),
    ...(mapping.rebin ? { rebin: { ...mapping.rebin, enabled: false } } : {}),
    ...(mapping.preprocessing ? { preprocessing: { ...mapping.preprocessing, standard_id: null, copy_parameters: false, align: false } } : {}) } : {}) }
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

export function initialColumnMapping(inspection: InspectionResponse, previous: ColumnMapping, remembered = true, resetReference = true): ColumnMapping {
  const cols = inspection.columns, suggested = inspection.athena_suggestion
  const { additional_fluorescence: _fluorescence, ...singlePrevious } = previous
  const mapping: ColumnMapping = suggested ? { ...singlePrevious, ...suggested, denominator: suggested.denominator ?? "", reference_numerator: "",
    reference_denominator: "", invert: false, signal_multiplier: 1, individual_channels: false }
    : { ...singlePrevious, energy_column: cols.find(c => c.role_hint === "energy")?.column_id ?? cols[0]?.column_id ?? "",
      numerator: [cols.find(c => c.role_hint === "mu")?.column_id ?? cols[1]?.column_id ?? ""],
      denominator: cols.find(c => c.role_hint === "i0")?.column_id ?? cols[2]?.column_id ?? "",
      reference_numerator: "", reference_denominator: "" }
  const restored = remembered && inspection.remembered_columns
  const is_reference = resetReference ? false : previous.is_reference ?? false
  const selected = normalizeImportInversion(restored ? { ...mapping, ...restored.mapping, is_reference } : { ...mapping, is_reference })
  if (selected.rebin && !restored) selected.rebin = { ...selected.rebin, enabled: false }
  return selected.data_type === 'chi' ? changeInputType(selected, 'chi') : selected
}

// A shared batch uses the column positions the user selected, even when files
// label those columns differently. Resolve IDs for each upload independently.
export function reuseColumnMapping(source: InspectionResponse, target: InspectionResponse, mapping: ColumnMapping): ColumnMapping | null {
  const column = (id: string): string | undefined => {
    const original = source.columns.find(c => c.column_id === id)
    if (!original) return undefined
    // Renamed headers are common across scans; a known label moving to another
    // position is evidence of a different layout and needs an explicit review.
    const named = target.columns.filter(c => c.name === original.name)
    if (source.columns.filter(c => c.name === original.name).length === 1
      && named.length === 1 && named[0].index !== original.index) return undefined
    return target.columns.find(c => c.index === original.index && c.numeric)?.column_id
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
