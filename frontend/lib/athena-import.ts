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

export interface ColumnMapping {
  energy_column: string; numerator: string[]; denominator: string | string[]
  mode: "mu" | "transmission" | "fluorescence"
  units: "eV" | "keV"; data_type: "mu" | "xanes" | "norm" | "chi" | "xmudat"
  reference_numerator: string; reference_denominator: string; sort: boolean
  reference_log?: boolean; reference_same_element?: boolean; individual_channels?: boolean
  signal_multiplier?: number | ""; invert?: boolean
  preprocessing?: ImportPreprocessing
  rebin?: ImportRebinOptions
}

export interface ColumnPreview {
  filename: string; points: number; x_label: string; y_label: string; warnings: string[]
  traces: { id: string; label: string; role: "sample" | "reference"; x: number[]; y: number[]; stage?: "original" | "rebinned" }[]
  rebin_results?: { id: string; label: string; role: "sample" | "reference"; e0: number; source_points: number; output_points: number }[]
}

export function columnPayload(mapping: ColumnMapping) {
  const denominator = denominatorColumns(mapping)
  const { enabled, ...rebin } = mapping.rebin ?? defaultRebin
  return { ...mapping, preprocessing: mapping.preprocessing ?? defaultPreprocessing,
    ...(mapping.rebin ? { rebin: enabled ? rebin : null } : {}),
    ...(mapping.rebin && !rebinProblem({ ...mapping.rebin, enabled: true, e0: null }) ? {
      rebin_grid: Object.fromEntries((['emin', 'emax', 'pre', 'xanes', 'exafs', 'width'] as const).map(key => [key, mapping.rebin![key]])),
    } : {}),
    denominator: denominator.length > 1 ? denominator : denominator[0] || null,
    reference_numerator: mapping.reference_numerator || null, reference_denominator: mapping.reference_denominator || null }
}

export function denominatorColumns(mapping: ColumnMapping): string[] {
  return Array.isArray(mapping.denominator) ? mapping.denominator : mapping.denominator ? [mapping.denominator] : []
}

export function columnProblem(mapping: ColumnMapping): string | null {
  if (mapping.signal_multiplier === "" || !Number.isFinite(mapping.signal_multiplier ?? 1)) return "Enter a finite multiplicative constant."
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
    ...(mapping.rebin ? { rebin: { ...mapping.rebin, enabled: false } } : {}),
    ...(mapping.preprocessing ? { preprocessing: { ...mapping.preprocessing, standard_id: null, copy_parameters: false, align: false } } : {}) } : {}) }
}

export function initialColumnMapping(inspection: InspectionResponse, previous: ColumnMapping, remembered = true): ColumnMapping {
  const cols = inspection.columns, suggested = inspection.athena_suggestion
  const mapping = suggested ? { ...previous, ...suggested, denominator: suggested.denominator ?? "", reference_numerator: "",
    reference_denominator: "", invert: false, signal_multiplier: 1, individual_channels: false }
    : { ...previous, energy_column: cols.find(c => c.role_hint === "energy")?.column_id ?? cols[0]?.column_id ?? "",
      numerator: [cols.find(c => c.role_hint === "mu")?.column_id ?? cols[1]?.column_id ?? ""],
      denominator: cols.find(c => c.role_hint === "i0")?.column_id ?? cols[2]?.column_id ?? "",
      reference_numerator: "", reference_denominator: "" }
  const restored = remembered && inspection.remembered_columns
  const selected = restored ? { ...mapping, ...restored.mapping } : mapping
  if (selected.rebin && !restored) selected.rebin = { ...selected.rebin, enabled: false }
  return selected.data_type === 'chi' ? changeInputType(selected, 'chi') : selected
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
