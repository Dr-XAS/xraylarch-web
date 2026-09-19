import type { Analysis, AthenaGroup } from "@/lib/athena"

export type PlotSpace = "E" | "k" | "R" | "q"
export type PlotRange = [number | null, number | null]

export function spectrumTraceCoordinates(group: AthenaGroup, space: PlotSpace, energyMode: string, component = "mag", kWeight: number | null = null) {
  if (group.data_type === "detector" && (space !== "E" || energyMode !== "mu")) return null
  const rawChi = !group.result && group.data_type === "chi"
  const arrays: Record<string, number[]> = group.result?.arrays ?? (rawChi
    ? { k: group.energy, chi: group.mu }
    : { energy: group.energy.map(energy => energy + group.parameters.energy_shift), mu: group.mu })
  const xKey = { E: "energy", k: "k", R: "r", q: "q" }[space]
  const yKey = { E: energyMode, k: "weighted_chi", R: `chir_${component}`, q: `chiq_${component}` }[space]
  const x = arrays[xKey]
  const y = space === "k" && kWeight !== null
    ? x && arrays.chi && x.length === arrays.chi.length ? arrays.chi.map((value, index) => value * x[index] ** kWeight) : undefined
    : arrays[rawChi && space === "k" ? "chi" : yKey]
  if (!x?.length || !y?.length || x.length !== y.length) return null
  return { arrays, rawChi, x, y }
}

function analysisXValues(analysis: Analysis | null) {
  if (!analysis) return []
  if (analysis.kind === "pca") {
    const values = analysis.result.explained_variance_ratio
    return Array.isArray(values) ? values.map((_, index) => index + 1) : []
  }
  const values = analysis.kind === "log_ratio" ? analysis.result.k : analysis.result.x
  return Array.isArray(values) ? values : []
}

function outwardRange(values: unknown[]): PlotRange {
  let minimum = Infinity
  let maximum = -Infinity
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [null, null]
  if (minimum === maximum) return [minimum - 1, maximum + 1]
  const precision = 1000
  return [Math.floor(minimum * precision) / precision, Math.ceil(maximum * precision) / precision]
}

export function automaticPlotRange(
  groups: AthenaGroup[], space: PlotSpace, energyMode: string, component: string,
  analysis: Analysis | null = null, analysisVisible = false, kWeight: number | null = null,
): PlotRange {
  if (analysisVisible) return outwardRange(analysisXValues(analysis))
  return outwardRange(groups.flatMap(group => {
    const coordinates = spectrumTraceCoordinates(group, space, energyMode, component, kWeight)
    if (!coordinates) return []
    const k = space === "q" && component === "re" ? spectrumTraceCoordinates(group, "k", energyMode)?.x ?? [] : []
    return [...coordinates.x, ...k]
  }))
}
