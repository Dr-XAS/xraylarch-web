export const viewerIds = ["spectrum", "wavelet", "cif", "feff", "fit"] as const
export type ViewerId = typeof viewerIds[number]
export type ViewerSort = "default" | "process"

export const viewerLabels: Record<ViewerId, string> = {
  spectrum: "Spectrum viewer",
  wavelet: "Wavelet plotter",
  cif: "CIF viewer",
  feff: "FEFF path viewer",
  fit: "EXAFS fit viewer",
}

/** Unknown processing times retain the requested default order. */
export function orderViewers(available: readonly ViewerId[], sort: ViewerSort, times: Partial<Record<ViewerId, number>>): ViewerId[] {
  const ordered = viewerIds.filter(id => available.includes(id))
  if (sort === "default") return ordered
  return ordered.sort((left, right) => {
    // A source spectrum precedes any analysis derived from it.
    if (left === "spectrum") return -1
    if (right === "spectrum") return 1
    const a = times[left], b = times[right]
    if (a !== undefined && b !== undefined) return a - b || viewerIds.indexOf(left) - viewerIds.indexOf(right)
    if (a !== undefined) return -1
    if (b !== undefined) return 1
    return viewerIds.indexOf(left) - viewerIds.indexOf(right)
  })
}
