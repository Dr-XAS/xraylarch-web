export interface ColumnMapping {
  energy_column: string; numerator: string[]; denominator: string
  mode: "mu" | "transmission" | "fluorescence"
  units: "eV" | "keV"; data_type: "mu" | "xanes" | "norm" | "chi"
  reference_numerator: string; reference_denominator: string; sort: boolean
  reference_log?: boolean; reference_same_element?: boolean; individual_channels?: boolean
}

export interface ColumnPreview {
  filename: string; points: number; x_label: string; y_label: string; warnings: string[]
  traces: { id: string; label: string; role: "sample" | "reference"; x: number[]; y: number[] }[]
}

export function columnPayload(mapping: ColumnMapping) {
  return { ...mapping, denominator: mapping.denominator || null,
    reference_numerator: mapping.reference_numerator || null, reference_denominator: mapping.reference_denominator || null }
}

export function numeratorRange(text: string, count: number): number[] {
  const selected = new Set<number>()
  if (!text.trim()) throw new Error("Enter column numbers, for example 4-8, 11.")
  for (const item of text.split(",")) {
    const match = item.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!match) throw new Error("Use comma-separated column numbers or ranges, for example 4-8, 11.")
    const start = Number(match[1]), end = Number(match[2] ?? match[1])
    if (start < 1 || end > count || start > end) throw new Error(`Choose increasing column ranges between 1 and ${count}.`)
    for (let n = start; n <= end; n++) selected.add(n - 1)
  }
  return [...selected].sort((a, b) => a - b)
}
