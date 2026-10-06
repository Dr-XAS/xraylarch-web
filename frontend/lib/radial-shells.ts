import type { ArtemisPathMetadata } from "./artemis"
import type { ArtemisStructure } from "./artemis-structures"
import { cartesian, latticeVectors, type CifVector, type CifViewerAtom } from "./cif-viewer"
import { buildFeffPathGeometry } from "./feff-path-geometry"

export interface RadialNeighbor {
  id: number; element: string; structure_index: number; image: CifVector
  fractional_offset: CifVector; cartesian_offset: CifVector; distance: number
  shell_index: number; group_id: string
}
export interface RadialShell {
  index: number; r_min: number; r_max: number; r_mean: number; coordination_number: number
  elements: Record<string, number>; neighbor_ids: number[]
  groups: { id: string; element: string; coordination_number: number; r_min: number; r_max: number; neighbor_ids: number[] }[]
}
export interface RadialShells {
  method: "complete_linkage"; cif: string; cif_sha256: string; absorber: string; site_index: number
  radius: number; tolerance: number; symmetry_tolerance: number
  shells: RadialShell[]; neighbors: RadialNeighbor[]; warnings: string[]
}
export interface RadialShellContext { structure: ArtemisStructure; attachmentId: string; siteIndex: number }
export const RADIAL_SHELL_DEFAULTS = { radius: 6, tolerance: 0.05 }
const COLORS = ["#06b6d4", "#a78bfa", "#f472b6", "#22c55e", "#f97316", "#60a5fa", "#d4b000", "#e879f9"]
export const shellColor = (index: number) => COLORS[(index - 1) % COLORS.length]
export const shellRange = (shell: Pick<RadialShell, "r_min" | "r_max">) => `${shell.r_min.toFixed(3)}–${shell.r_max.toFixed(3)} Å`

export function radialShellAtoms(structure: ArtemisStructure, analysis: RadialShells): (CifViewerAtom & { shellIndex: number; groupId: string })[] {
  const lattice = latticeVectors(structure.cell)
  if (!lattice || structure.cif !== analysis.cif) return []
  return analysis.neighbors.map(neighbor => {
    const [x, y, z] = cartesian(neighbor.fractional_offset, lattice)
    return { element: neighbor.element, label: `${neighbor.element} · image (${neighbor.image.join(", ")})`, siteIndex: -1,
      occupancy: 1, x, y, z, distance: neighbor.distance, isAbsorber: false, shellIndex: neighbor.shell_index, groupId: neighbor.group_id }
  })
}

/** Match the actual FEFF geometry in its native basis; R_eff alone is insufficient. */
export function radialPathNeighbor(metadata: ArtemisPathMetadata, structure: ArtemisStructure, analysis: RadialShells): RadialNeighbor | undefined {
  if (structure.cif !== analysis.cif || metadata.nleg !== 2 || metadata.absorber !== analysis.absorber) return
  const { geometry } = buildFeffPathGeometry(metadata)
  if (!geometry || geometry.absorber.atom !== analysis.absorber) return
  const scatterers = geometry.atoms.filter(atom => atom !== geometry.absorber)
  if (scatterers.length !== 1) return
  const atom = scatterers[0]
  if (Math.abs(metadata.reff - Math.hypot(atom.x, atom.y, atom.z)) > 0.005) return
  return analysis.neighbors.find(neighbor => neighbor.element === atom.atom &&
    Math.hypot(atom.x - neighbor.cartesian_offset[0], atom.y - neighbor.cartesian_offset[1], atom.z - neighbor.cartesian_offset[2]) <= 0.005)
}

export function groupRadialPaths<T extends { id: string; metadata: ArtemisPathMetadata }>(paths: T[], structure: ArtemisStructure | null, analysis: RadialShells | null) {
  const groups = new Map<string, { key: string; label: string; shell?: RadialShell; paths: T[] }>()
  if (analysis && structure?.cif === analysis.cif) for (const shell of analysis.shells) {
    groups.set(String(shell.index), { key: String(shell.index), label: `Shell ${shell.index} · ${shellRange(shell)}`, shell, paths: [] })
  }
  for (const path of paths) {
    const neighbor = structure && analysis ? radialPathNeighbor(path.metadata, structure, analysis) : undefined
    const key = neighbor ? String(neighbor.shell_index) : path.metadata.nleg > 2 ? "multiple" : "unmatched"
    if (!groups.has(key)) groups.set(key, { key, label: key === "multiple" ? "Multiple scattering" : "Unmatched", paths: [] })
    groups.get(key)!.paths.push(path)
  }
  return [...groups.values()].filter(group => group.paths.length > 0)
}
