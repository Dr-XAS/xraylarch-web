import type { FeffPathGeometry } from "./feff-path-geometry"

export interface FeffEquivalentAtom {
  atom: string
  x: number
  y: number
  z: number
  /** CIF context may not have FEFF potential indices. */
  ipot?: number
}

export interface FeffPathEquivalents {
  atoms: FeffEquivalentAtom[]
  /** Unique physical edges, independent of traversal direction or visit count. */
  bonds: { from: FeffEquivalentAtom; to: FeffEquivalentAtom }[]
  /** Directed trajectories found; a lower bound if the search was stopped. */
  count: number
  complete: boolean
  warning?: string
}

const DISTANCE_TOLERANCE = 0.005
const SITE_TOLERANCE = 1e-5
const MAX_CONTEXT_ATOMS = 4000
const MAX_DEGENERACY = 10_000
const MAX_COMPARISONS = 250_000

const distance = (a: FeffEquivalentAtom, b: FeffEquivalentAtom) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const element = (atom: FeffEquivalentAtom) => atom.atom.trim().toLowerCase()
const compatible = (a: FeffEquivalentAtom, b: FeffEquivalentAtom) =>
  element(a) === element(b) && (a.ipot === undefined || b.ipot === undefined || a.ipot === b.ipot)
const edgeKey = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`

/**
 * Match a FEFF path to real atoms in an already verified, absorber-centered cluster.
 * Full pairwise distances preserve geometry, including nonadjacent distances and
 * repeated-site topology. FEFF groups time reversals and spatial inversions; count
 * distinct ordered trajectories, including reversals, rather than multiplying N.
 * https://feff.phys.washington.edu/feff/Docs/feff8/feff8web/node9.html
 * Only an exhaustive match to the reported degeneracy promotes equivalent atoms.
 */
export function resolveFeffPathEquivalents(
  geometry: FeffPathGeometry,
  degeneracy: number,
  contextAtoms: readonly FeffEquivalentAtom[],
): FeffPathEquivalents {
  const representativeBonds = new Map<string, FeffPathEquivalents["bonds"][number]>()
  for (const { from, to } of geometry.legs) {
    representativeBonds.set(edgeKey(from.atomIndex, to.atomIndex), {
      from: geometry.atoms[from.atomIndex], to: geometry.atoms[to.atomIndex],
    })
  }
  const fallback = (reason: string, count = 0): FeffPathEquivalents => ({
    atoms: [...geometry.atoms], bonds: [...representativeBonds.values()], count, complete: false,
    warning: `Equivalent paths were not expanded: ${reason} Showing the representative path.`,
  })
  if (!Number.isInteger(degeneracy) || degeneracy < 1 || degeneracy > MAX_DEGENERACY) {
    return fallback("FEFF degeneracy must be a positive integer within the supported search limit.")
  }
  if (contextAtoms.length < 2) return fallback("the verified cluster does not contain the complete path.")
  if (contextAtoms.length > MAX_CONTEXT_ATOMS) return fallback("the cluster exceeds the equivalent-path search limit.")
  if (contextAtoms.some(atom => !atom || typeof atom.atom !== "string" || !atom.atom.trim() ||
      ![atom.x, atom.y, atom.z].every(Number.isFinite) ||
      (atom.ipot !== undefined && (!Number.isInteger(atom.ipot) || atom.ipot < 0)))) {
    return fallback("the cluster contains invalid atomic coordinates or potential indices.")
  }

  // A duplicated input row is one physical atom. Reject incompatible occupancies
  // at the same position instead of inflating the multiplicity or choosing one.
  const atoms: FeffEquivalentAtom[] = []
  const bins = new Map<string, number[]>()
  for (const atom of contextAtoms) {
    const cell = [atom.x, atom.y, atom.z].map(value => Math.floor(value / SITE_TOLERANCE))
    let duplicate = -1
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const nearby = bins.get(`${cell[0] + dx},${cell[1] + dy},${cell[2] + dz}`) ?? []
      for (const index of nearby) if (distance(atoms[index], atom) <= SITE_TOLERANCE) duplicate = index
    }
    if (duplicate >= 0) {
      if (!compatible(atoms[duplicate], atom)) return fallback("the cluster has conflicting atoms at one physical site.")
      if (atoms[duplicate].ipot === undefined && atom.ipot !== undefined) atoms[duplicate] = atom
    } else {
      const key = cell.join(",")
      bins.set(key, [...(bins.get(key) ?? []), atoms.length])
      atoms.push(atom)
    }
  }

  const template = geometry.atoms
  if (template.length < 2 || template.length > 20 || geometry.visits.length > 21) {
    return fallback("the path exceeds the equivalent-path search limit.")
  }
  // A matching shell elsewhere in the cluster cannot establish that this is the
  // path's source structure. Its actual representative must also be present.
  if (template.some(site => !atoms.some(atom => compatible(site, atom) && distance(site, atom) <= DISTANCE_TOLERANCE))) {
    return fallback("the verified cluster does not contain the complete representative path.")
  }
  const absorberCandidates = atoms.flatMap((atom, index) =>
    compatible(geometry.absorber, atom) && distance(geometry.absorber, atom) <= DISTANCE_TOLERANCE ? [index] : [])
  if (absorberCandidates.length !== 1) return fallback("the absorber position is ambiguous in the cluster.")
  const absorberIndex = absorberCandidates[0]
  const distances = template.map(a => template.map(b => distance(a, b)))
  const candidates = template.map((site, index) => index === geometry.absorber.index
    ? [absorberIndex]
    : atoms.flatMap((atom, atomIndex) => atomIndex !== absorberIndex && compatible(site, atom) &&
        Math.abs(distance(atom, atoms[absorberIndex]) - distances[index][geometry.absorber.index]) <= DISTANCE_TOLERANCE
      ? [atomIndex] : []))
  // Constrain the fewest-candidate sites first; the trajectory order stays intact.
  const order = template.map((_, index) => index).filter(index => index !== geometry.absorber.index)
    .sort((a, b) => candidates[a].length - candidates[b].length)
  const assignment = new Array<number>(template.length).fill(-1)
  assignment[geometry.absorber.index] = absorberIndex
  const assigned = [geometry.absorber.index]
  const used = new Set([absorberIndex])
  const trajectories = new Set<string>()
  const matchedAtoms = new Set<number>()
  const matchedBonds = new Map<string, FeffPathEquivalents["bonds"][number]>()
  let comparisons = 0, stopped = false, exceeded = false

  const search = (depth: number) => {
    if (stopped || exceeded) return
    if (depth === order.length) {
      const route = geometry.visits.map(visit => assignment[visit.atomIndex])
      trajectories.add(route.join(","))
      trajectories.add([...route].reverse().join(","))
      if (trajectories.size > degeneracy) { exceeded = true; return }
      for (const index of route) matchedAtoms.add(index)
      for (let i = 1; i < route.length; i++) matchedBonds.set(edgeKey(route[i - 1], route[i]), {
        from: atoms[route[i - 1]], to: atoms[route[i]],
      })
      return
    }
    const index = order[depth]
    for (const candidate of candidates[index]) {
      if (++comparisons > MAX_COMPARISONS) { stopped = true; return }
      if (used.has(candidate)) continue
      let matches = true
      for (const other of assigned) {
        if (++comparisons > MAX_COMPARISONS) { stopped = true; return }
        if (Math.abs(distance(atoms[candidate], atoms[assignment[other]]) - distances[index][other]) > DISTANCE_TOLERANCE) {
          matches = false
          break
        }
      }
      if (!matches) continue
      assignment[index] = candidate
      assigned.push(index)
      used.add(candidate)
      search(depth + 1)
      used.delete(candidate)
      assigned.pop()
      assignment[index] = -1
      if (stopped || exceeded) return
    }
  }
  search(0)
  if (stopped) return fallback("the equivalent-path search reached its work limit.", trajectories.size)
  if (exceeded) return fallback(`the cluster has more matching paths than FEFF degeneracy ${degeneracy}.`, trajectories.size)
  if (trajectories.size !== degeneracy) {
    return fallback(`found ${trajectories.size} matching directed paths, but FEFF reports degeneracy ${degeneracy}.`, trajectories.size)
  }
  return {
    atoms: [...matchedAtoms].sort((a, b) => a - b).map(index => atoms[index]),
    bonds: [...matchedBonds.values()], count: trajectories.size, complete: true,
  }
}
