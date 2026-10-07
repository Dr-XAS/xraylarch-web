import type { GLViewer, Label, Vector2 } from "3dmol"
import { clearCifHover } from "./cif-renderer"
import { CIF_BOND_COLOR, CIF_BOND_RADIUS, CIF_SPHERE_RADIUS, cifElementColor } from "./cif-viewer-style"
import type { FeffPathGeometry, FeffPathLeg } from "./feff-path-geometry"
import type { FeffPathEquivalents } from "./feff-path-equivalents"

export const FEFF_LEG_COLORS = ["#AF2168", "#3285AD", "#8061B0", "#C27332", "#348778", "#BD4B53"]
// 3Dmol 2.5.3 multiplies its opacity uniform twice in the fragment shader.
// This renderer input gives a visible alpha of 0.3 (70% transparency).
export const FEFF_CONTEXT_OPACITY = Math.sqrt(0.3)
type Point = { x: number; y: number; z: number }
export type FeffContextAtom = Point & { atom: string }
export interface FeffScenePath { id: string; filename: string; geometry: FeffPathGeometry; color: string; equivalents?: FeffPathEquivalents }
export type FeffSceneAtom = FeffContextAtom & { participating: boolean; isAbsorber: boolean }
const point = ({ x, y, z }: Point) => ({ x, y, z })
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const sameAtom = (a: FeffContextAtom, b: FeffContextAtom) => a.atom === b.atom && distance(a, b) < 0.005

/** Arrows replace bonds; compact centered lanes keep overlapping legs readable. */
function arrowForLeg(leg: FeffPathLeg, allLegs: FeffPathLeg[], position: number) {
  const delta = { x: leg.to.x - leg.from.x, y: leg.to.y - leg.from.y, z: leg.to.z - leg.from.z }
  const unit = { x: delta.x / leg.length, y: delta.y / leg.length, z: delta.z / leg.length }
  // Canonical direction keeps reversed and shared inter-path legs in one frame.
  const sign = Math.abs(unit.x) > 1e-6 ? Math.sign(unit.x) : Math.abs(unit.y) > 1e-6 ? Math.sign(unit.y) : Math.sign(unit.z)
  const axis = { x: unit.x * sign, y: unit.y * sign, z: unit.z * sign }
  const perpendicular = Math.abs(axis.z) < 0.8 ? { x: -axis.y, y: axis.x, z: 0 } : { x: 0, y: -axis.z, z: axis.y }
  const norm = Math.hypot(perpendicular.x, perpendicular.y, perpendicular.z)
  const parallel = allLegs.map((other, index) => ({ other, index })).filter(({ other }) => {
    const d = { x: other.to.x - other.from.x, y: other.to.y - other.from.y, z: other.to.z - other.from.z }
    const cross = Math.hypot(d.y * unit.z - d.z * unit.y, d.z * unit.x - d.x * unit.z, d.x * unit.y - d.y * unit.x)
    const offset = { x: other.from.x - leg.from.x, y: other.from.y - leg.from.y, z: other.from.z - leg.from.z }
    const lineDistance = Math.hypot(offset.y * unit.z - offset.z * unit.y, offset.z * unit.x - offset.x * unit.z, offset.x * unit.y - offset.y * unit.x)
    return cross < 1e-4 && lineDistance < 1e-4
  })
  const rank = parallel.findIndex(other => other.index === position)
  // An unshared leg sits exactly on the bond axis. Shared/reversed legs form
  // a symmetric bundle around it instead of floating outside a visible bond.
  const lane = parallel.length % 2 === 0
    ? (Math.floor(rank / 2) + 0.5) * (rank % 2 === 0 ? 1 : -1)
    : rank === 0 ? 0 : Math.ceil(rank / 2) * (rank % 2 === 1 ? 1 : -1)
  // Keep even long repeated paths within the atom/bond silhouette. The first
  // five lanes retain their usual spacing; larger bundles become denser.
  const outerLane = parallel.length % 2 === 0 ? (parallel.length - 1) / 2 : Math.floor(parallel.length / 2)
  const shift = Math.min(0.14, 0.28 / Math.max(outerLane, 1)) * lane
  const at = (fraction: number) => ({
    x: leg.from.x + delta.x * fraction + perpendicular.x / norm * shift,
    y: leg.from.y + delta.y * fraction + perpendicular.y / norm * shift,
    z: leg.from.z + delta.z * fraction + perpendicular.z / norm * shift,
  })
  // Keep each tip clear of the atom surface so its direction stays visible.
  const inset = Math.min(0.45, (CIF_SPHERE_RADIUS + 0.05) / leg.length)
  const label = at(0.55)
  const labelShift = parallel.length === 1 ? 0.16 : Math.sign(lane || 1) * 0.16
  return { start: at(inset), end: at(1 - inset), label: {
    x: label.x + perpendicular.x / norm * labelShift,
    y: label.y + perpendicular.y / norm * labelShift,
    z: label.z + perpendicular.z / norm * labelShift,
  } }
}

/** Also accepts neighboring paths when computing shared arrow lanes. */
export function feffArrow(geometry: FeffPathGeometry, legIndex: number, otherPaths: FeffPathGeometry[] = []) {
  return arrowForLeg(geometry.legs[legIndex], [...geometry.legs, ...otherPaths.flatMap(path => path.legs)], legIndex)
}

export function feffSceneAtoms(paths: FeffScenePath[], context: FeffContextAtom[], showContext = true): FeffSceneAtom[] {
  const combined: FeffSceneAtom[] = []
  for (const path of paths) for (const atom of [...path.geometry.atoms, ...(path.equivalents?.atoms ?? [])]) {
    const isAbsorber = sameAtom(atom, path.geometry.absorber)
    const existing = combined.find(other => sameAtom(atom, other))
    if (existing) existing.isAbsorber ||= isAbsorber
    else combined.push({ ...point(atom), atom: atom.atom, participating: true, isAbsorber })
  }
  if (showContext) for (const atom of context) {
    if (!combined.some(other => sameAtom(atom, other))) combined.push({ ...atom, participating: false, isAbsorber: false })
  }
  return combined
}

/** Shared by the FEFF viewer, fit thumbnails and their interactive preview. */
export function drawFeffScene(scene: GLViewer, { paths, activePathId, selectedLeg = null, context = [],
  showContext = true, labels = true, bonds = true, ink = "#384150", background = "#ffffff", labelOffset, interactive = true }: {
  paths: FeffScenePath[]; activePathId?: string; selectedLeg?: number | null; context?: FeffContextAtom[]
  showContext?: boolean; labels?: boolean; bonds?: boolean; ink?: string; background?: string; labelOffset?: Vector2; interactive?: boolean
}) {
  const atoms = feffSceneAtoms(paths, context, showContext)
  const elements = [...new Set(atoms.map(atom => atom.atom))].sort()
  const activePath = paths.find(path => path.id === activePathId) ?? paths[0]
  clearCifHover(scene, () => {})
  scene.clear()
  // The installed renderer loses translucent RGB when its canvas alpha is
  // zero. Use the exact themed CIF canvas background for correct blending.
  scene.setBackgroundColor(background, 1)
  let hoverLabel: Label | null = null
  // A hidden XYZ model preserves CIF's exact distance-based bond perception.
  // 3Dmol uses one opacity per model material, so distinct-opacity atoms and
  // bond halves are shapes instead of conflicting per-atom model styles.
  if (atoms.length) {
    const model = scene.addModel(`${atoms.length}\nLocal FEFF structure\n${atoms.map(atom => `${atom.atom} ${atom.x} ${atom.y} ${atom.z}`).join("\n")}`, "xyz")
    scene.setStyle({}, {})
    if (bonds) {
      const inferred = model.selectedAtoms({})
      for (const [index, atom] of inferred.entries()) for (const neighbor of atom.bonds ?? []) {
        if (neighbor <= index || !atoms[index] || !atoms[neighbor]) continue
        const left = atoms[index], right = atoms[neighbor]
        // Suppress only bonds replaced by a representative arrow. Verified
        // equivalent bonds without arrows retain their normal highlighting.
        const matchesBond = (leg: { from: FeffContextAtom; to: FeffContextAtom }) =>
          (sameAtom(leg.from, left) && sameAtom(leg.to, right)) || (sameAtom(leg.from, right) && sameAtom(leg.to, left))
        if (paths.some(path => path.geometry.legs.some(matchesBond))) continue
        const middle = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, z: (left.z + right.z) / 2 }
        const onPath = paths.some(path => path.equivalents?.bonds.some(matchesBond))
        for (const source of [left, right]) scene.addCylinder({
          start: point(source), end: middle, radius: CIF_BOND_RADIUS, color: CIF_BOND_COLOR,
          opacity: onPath ? 1 : FEFF_CONTEXT_OPACITY, fromCap: 0, toCap: 0,
        })
      }
    }
  }
  for (const atom of atoms) {
    scene.addSphere({ center: point(atom), radius: CIF_SPHERE_RADIUS, color: cifElementColor(elements.indexOf(atom.atom)),
      opacity: atom.participating ? 1 : FEFF_CONTEXT_OPACITY, hoverable: interactive,
      hover_callback: () => {
        if (hoverLabel) scene.removeLabel(hoverLabel)
        hoverLabel = scene.addLabel(`${atom.atom} · ${Math.hypot(atom.x, atom.y, atom.z).toFixed(3)} Å from A`, {
          position: { x: atom.x, y: atom.y, z: atom.z + 0.4 }, fontSize: 12,
          fontColor: "white", backgroundColor: "#27272a", backgroundOpacity: 0.9, inFront: true,
        })
        scene.render()
      },
      unhover_callback: () => { if (hoverLabel) scene.removeLabel(hoverLabel); hoverLabel = null; scene.render() },
    })
    if (labels && paths.some(path => path.geometry.atoms.some(site => sameAtom(site, atom)))) {
      const activeAtom = activePath?.geometry.atoms.find(other => sameAtom(atom, other))
      // Atom numbers refer to the active route; other paths may use a
      // different numbering for this same physical site.
      const suffix = atom.isAbsorber ? " · A" : activeAtom ? ` · ${activeAtom.index}` : ""
      scene.addLabel(`${atom.atom}${suffix}`, {
        position: point(atom), screenOffset: labelOffset, fontSize: 11, alignment: "bottomLeft",
        fontColor: ink, showBackground: false, backgroundOpacity: 0, borderThickness: 0, inFront: true,
      })
    }
  }
  const directed = paths.flatMap(path => path.geometry.legs.map(leg => ({ path, leg })))
  const allLegs = directed.map(item => item.leg)
  for (const [index, { path, leg }] of directed.entries()) {
    const emphasized = path.id !== activePath?.id || selectedLeg === null || selectedLeg === leg.index
    const arrow = arrowForLeg(leg, allLegs, index)
    scene.addArrow({ start: arrow.start, end: arrow.end, radius: emphasized ? 0.065 : 0.045, radiusRatio: 2.2,
      midpos: -Math.min(0.26, distance(arrow.start, arrow.end) * 0.3), color: path.color, opacity: emphasized ? 1 : 0.3 })
    if (labels && emphasized) scene.addLabel(String(leg.index), {
      position: { ...arrow.label, z: arrow.label.z + 0.12 }, fontSize: 11, fontColor: path.color, showBackground: false,
      backgroundOpacity: 0, borderThickness: 0, inFront: true,
    })
  }
}
