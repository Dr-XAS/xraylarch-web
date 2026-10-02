export const viewerIds = ["single", "multiple", "wavelet", "cif", "feff", "fit"] as const
export type ViewerId = typeof viewerIds[number]
export type ViewerSort = "default" | "process" | "custom"
export const viewerOrderStorageKey = "athena.viewer-order.v1"

type ViewerOrderPreference = { sort: "default" | "custom"; order: ViewerId[] }

/** Retain valid saved positions and append viewers added after the preference was saved. */
export function normalizeViewerOrder(value: unknown): ViewerId[] {
  const saved = Array.isArray(value) ? value.filter((id): id is ViewerId => viewerIds.includes(id)) : []
  return [...new Set([...saved, ...viewerIds])]
}

export function readViewerOrderPreference(): ViewerOrderPreference {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(viewerOrderStorageKey) ?? "null")
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      const preference = saved as Record<string, unknown>
      return { sort: preference.sort === "custom" ? "custom" : "default", order: normalizeViewerOrder(preference.order) }
    }
  } catch { /* Keep the default layout when preferences are unavailable or malformed. */ }
  return { sort: "default", order: [...viewerIds] }
}

export function writeViewerOrderPreference(sort: ViewerSort, order: readonly ViewerId[]): void {
  try {
    localStorage.setItem(viewerOrderStorageKey, JSON.stringify({
      sort: sort === "custom" ? "custom" : "default", order: normalizeViewerOrder(order),
    }))
  } catch { /* Keep the chosen layout for this session when storage is unavailable. */ }
}

/** Move within the supplied list; callers retain the slots of unavailable viewers. */
export function moveViewer(order: readonly ViewerId[], source: ViewerId, target: ViewerId): ViewerId[] {
  const next = [...order]
  const from = next.indexOf(source), to = next.indexOf(target)
  if (from < 0 || to < 0 || from === to) return next
  next.splice(from, 1)
  next.splice(to, 0, source)
  return next
}

export const viewerLabels: Record<ViewerId, string> = {
  single: "Single spectrum viewer",
  multiple: "Multiple spectra viewer",
  wavelet: "Wavelet plotter",
  cif: "CIF viewer",
  feff: "FEFF path viewer",
  fit: "EXAFS fit viewer",
}

/** Unknown processing times retain the requested default order. */
export function orderViewers(available: readonly ViewerId[], sort: ViewerSort, times: Partial<Record<ViewerId, number>>, customOrder?: readonly ViewerId[]): ViewerId[] {
  if (sort === "custom") return normalizeViewerOrder(customOrder).filter(id => available.includes(id))
  const ordered = viewerIds.filter(id => available.includes(id))
  if (sort === "default") return ordered
  return ordered.sort((left, right) => {
    // Source spectra precede derived analysis and retain their own stable order.
    const leftIsSpectrum = left === "single" || left === "multiple"
    const rightIsSpectrum = right === "single" || right === "multiple"
    if (leftIsSpectrum && rightIsSpectrum) return viewerIds.indexOf(left) - viewerIds.indexOf(right)
    if (leftIsSpectrum) return -1
    if (rightIsSpectrum) return 1
    const a = times[left], b = times[right]
    if (a !== undefined && b !== undefined) return a - b || viewerIds.indexOf(left) - viewerIds.indexOf(right)
    if (a !== undefined) return -1
    if (b !== undefined) return 1
    return viewerIds.indexOf(left) - viewerIds.indexOf(right)
  })
}
