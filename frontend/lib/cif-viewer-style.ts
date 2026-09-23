import type { AtomStyleSpec } from "3dmol"

/** Keep the CIF and FEFF structure renderers on the same visual parameters. */
export const CIF_ELEMENT_COLORS = ["#225ea8", "#e5bf46", "#41b6c4", "#a1dab4", "#875ba6", "#e58255"]
export const CIF_SPHERE_RADIUS = 0.36
export const CIF_BOND_RADIUS = 0.08
export const CIF_BOND_COLOR = "#8a8f98"

export function cifElementColor(elementIndex: number) {
  return CIF_ELEMENT_COLORS[elementIndex % CIF_ELEMENT_COLORS.length]
}

export function cifAtomStyle(elementIndex: number, bonds: boolean): AtomStyleSpec {
  return {
    sphere: { radius: CIF_SPHERE_RADIUS, color: cifElementColor(elementIndex) },
    ...(bonds ? { stick: { radius: CIF_BOND_RADIUS, color: CIF_BOND_COLOR } } : {}),
  }
}
