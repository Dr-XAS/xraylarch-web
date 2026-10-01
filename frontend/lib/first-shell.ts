import type { ArtemisPathMetadata } from "./artemis"
import type { ArtemisStructure } from "./artemis-structures"
import { cartesian, latticeVectors, type CifVector, type CifViewerAtom } from "./cif-viewer"
import { buildFeffPathGeometry } from "./feff-path-geometry"

export interface FirstShell {
  method: "CrystalNN"
  pymatgen_version: string
  cif: string
  cif_sha256: string
  absorber: string
  site_index: number
  coordination_number: number
  coordination_weight: number
  alternatives: { coordination_number: number; weight: number }[]
  neighbors: { element: string; structure_index: number; image: CifVector; fractional_offset: CifVector; cartesian_offset: CifVector; distance: number; weight: number }[]
  warnings: string[]
}

export interface FirstShellSelection {
  structure: ArtemisStructure
  attachmentId: string
  shell: FirstShell
}

/** Use the viewer's basis, not pymatgen's potentially rotated Cartesian basis. */
export function firstShellAtoms(structure: ArtemisStructure, shell: FirstShell): CifViewerAtom[] {
  const lattice = latticeVectors(structure.cell)
  if (!lattice) return []
  return shell.neighbors.map(neighbor => {
    const [x, y, z] = cartesian(neighbor.fractional_offset, lattice)
    return { element: neighbor.element, label: `${neighbor.element} · image (${neighbor.image.join(", ")})`,
      siteIndex: -1, occupancy: 1, x, y, z, distance: neighbor.distance, isAbsorber: false }
  })
}

export function isShellAtom(atom: { element: string; x: number; y: number; z: number }, neighbors: CifViewerAtom[]) {
  return neighbors.some(neighbor => atom.element === neighbor.element &&
    Math.hypot(atom.x - neighbor.x, atom.y - neighbor.y, atom.z - neighbor.z) <= 0.005)
}

/** A geometric candidate relative to the explicitly selected CIF/site, never an inferred source identity. */
export function isFirstShellPath(metadata: ArtemisPathMetadata, structure: ArtemisStructure, shell: FirstShell) {
  if (structure.cif !== shell.cif) return false
  if (metadata.nleg !== 2 || metadata.absorber !== shell.absorber) return false
  const { geometry } = buildFeffPathGeometry(metadata)
  if (!geometry || geometry.absorber.atom !== shell.absorber) return false
  const scatterers = geometry.atoms.filter(atom => atom !== geometry.absorber)
  // larixite/FEFF uses pymatgen's Cartesian basis, which differs from the
  // conventional viewer basis for oblique cells. Never compare the two frames.
  return scatterers.length === 1 && Math.abs(metadata.reff - Math.hypot(scatterers[0].x, scatterers[0].y, scatterers[0].z)) <= 0.005 &&
    shell.neighbors.some(neighbor => neighbor.element === scatterers[0].atom &&
      Math.hypot(scatterers[0].x - neighbor.cartesian_offset[0], scatterers[0].y - neighbor.cartesian_offset[1], scatterers[0].z - neighbor.cartesian_offset[2]) <= 0.005)
}
