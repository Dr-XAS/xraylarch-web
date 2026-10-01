import type { CifViewerAtom } from "./cif-viewer"

export const CLUSTER_COORDINATION_MAX_ATOMS = 1500
export const CLUSTER_COORDINATION_DEFAULT_BOND_RANGE = 5
export const CLUSTER_COORDINATION_DEFAULT_TOLERANCE = 0.01

// Match the coincident-site guard in neighbor/neighbor_search.py.
const OVERLAP_DISTANCE = 1e-12
const MAX_COUNT_ENTRIES = 2_000_000
const MAX_SHELLS = 10_000

export interface ClusterCoordinationOptions {
  /** Exclusive distance cutoff, in angstroms. */
  bondRange?: number
  /** A larger gap between consecutive sorted distances starts another shell. */
  tolerance?: number
}

export interface ClusterCoordinationShell {
  index: number
  distance: number
  minDistance: number
  maxDistance: number
  averageCN: number
  /** CN of the marked absorber, or null for another central element/no absorber. */
  centerCN: number | null
  distribution: { cn: number; count: number }[]
  /** Input order, filtered to atoms of this pair's central element. Includes zeros. */
  countsByAtom: number[]
}

export interface ClusterCoordinationPair {
  centerElement: string
  neighborElement: string
  centerCount: number
  shells: ClusterCoordinationShell[]
}

export interface ClusterCoordinationResult {
  atomCount: number
  elementCounts: Record<string, number>
  bondRange: number
  tolerance: number
  pairs: ClusterCoordinationPair[]
}

/**
 * Finite-cluster adaptation of neighbor/neighbor_core.py get_CN/get_CN_all
 * (default gap shells) and neighbor/neighbor_search.py with boundary_mode='cluster',
 * reviewed at commit 2771716f9b901f2246d55bb7fa67e4c3194a0e04.
 *
 * Uses only the supplied Cartesian atoms: no periodic images or minimum-image
 * convention. For each ordered element pair, positive distances strictly below
 * bondRange are grouped by adjacent sorted gaps > tolerance. Shell distance is
 * the arithmetic mean; average CN divides directed contacts by ALL central
 * atoms, including atoms with no neighbor in that shell. Surface atoms therefore
 * reduce the average relative to a bulk/central-atom coordination number.
 *
 * Per-atom counts use the same shell membership as the source's CN_shells and
 * get_CN_summary_all. Its optional fixed shell edges and explicit distance-window
 * queries are separate calculation modes and are not exposed by this function.
 * Partial occupancy and overlapping sites are rejected rather than interpreted
 * as a particular disordered configuration. The caller must reject truncated
 * geometry before supplying its atoms.
 */
export function calculateClusterCoordination(
  atoms: CifViewerAtom[],
  options: ClusterCoordinationOptions = {},
): ClusterCoordinationResult {
  const bondRange = options.bondRange === undefined ? CLUSTER_COORDINATION_DEFAULT_BOND_RANGE : options.bondRange
  const tolerance = options.tolerance === undefined ? CLUSTER_COORDINATION_DEFAULT_TOLERANCE : options.tolerance
  if (!Number.isFinite(bondRange) || bondRange <= 0) throw new Error("Neighbor cutoff must be a positive finite distance.")
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Shell tolerance must be a finite nonnegative distance.")
  if (atoms.length === 0) throw new Error("No cluster atoms are available for coordination calculation.")
  if (atoms.length > CLUSTER_COORDINATION_MAX_ATOMS) throw new Error(`Coordination calculation supports at most ${CLUSTER_COORDINATION_MAX_ATOMS} cluster atoms. Reduce the cluster radius.`)

  const elementAtoms = new Map<string, CifViewerAtom[]>()
  let absorberCount = 0
  for (const atom of atoms) {
    if (![atom.x, atom.y, atom.z].every(Number.isFinite)) throw new Error("Cluster coordinates must be finite.")
    if (!Number.isFinite(atom.occupancy) || atom.occupancy !== 1) throw new Error("Coordination calculation requires fully occupied sites. Partial occupancies do not specify an atomic configuration.")
    if (!/^[A-Z][a-z]?$/.test(atom.element)) throw new Error("Cluster atoms must have valid element symbols.")
    if (atom.isAbsorber) absorberCount++
    const group = elementAtoms.get(atom.element)
    if (group) group.push(atom)
    else elementAtoms.set(atom.element, [atom])
  }
  if (absorberCount > 1) throw new Error("The cluster contains more than one marked center atom.")

  const groups = [...elementAtoms.entries()]
  const pairs = groups.map(([centerElement, centers]) => groups.map(([neighborElement]): ClusterCoordinationPair => ({
    centerElement, neighborElement, centerCount: centers.length, shells: [],
  })))
  let countEntries = 0
  let shellCount = 0

  for (let left = 0; left < groups.length; left++) for (let right = left; right < groups.length; right++) {
    const centers = groups[left][1]
    const neighbors = groups[right][1]
    const sameElement = left === right
    const capacity = sameElement ? centers.length * (centers.length - 1) / 2 : centers.length * neighbors.length
    // One distance per undirected contact. Typed buffers keep the 1500-atom
    // bound manageable and avoid duplicating contacts for the reverse pair.
    const distances = new Float64Array(capacity)
    const contactIds = new Uint32Array(capacity)
    let contactCount = 0
    for (let i = 0; i < centers.length; i++) for (let j = sameElement ? i + 1 : 0; j < neighbors.length; j++) {
      const first = centers[i]
      const second = neighbors[j]
      const distance = Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z)
      if (!Number.isFinite(distance)) throw new Error("The cluster coordinates produce a nonfinite pair distance.")
      if (distance <= OVERLAP_DISTANCE) throw new Error("The cluster contains overlapping atomic sites. Coordination requires distinct, fully occupied positions.")
      if (distance < bondRange) {
        distances[contactCount] = distance
        contactIds[contactCount++] = i * neighbors.length + j
      }
    }
    const order = Uint32Array.from({ length: contactCount }, (_, index) => index)
    order.sort((a, b) => distances[a] - distances[b])
    const centerIndex = centers.findIndex(atom => atom.isAbsorber)
    const neighborCenterIndex = neighbors.findIndex(atom => atom.isAbsorber)

    for (let start = 0; start < order.length;) {
      let end = start + 1
      while (end < order.length && distances[order[end]] - distances[order[end - 1]] <= tolerance) end++
      countEntries += centers.length + (sameElement ? 0 : neighbors.length)
      shellCount += sameElement ? 1 : 2
      if (countEntries > MAX_COUNT_ENTRIES || shellCount > MAX_SHELLS) throw new Error("Too many coordination shells to display. Increase the shell tolerance or reduce the cluster radius or neighbor cutoff.")

      const centerCounts = Array<number>(centers.length).fill(0)
      const neighborCounts = sameElement ? centerCounts : Array<number>(neighbors.length).fill(0)
      let meanDistance = 0
      for (let cursor = start; cursor < end; cursor++) {
        const contact = order[cursor]
        const id = contactIds[contact]
        centerCounts[Math.floor(id / neighbors.length)]++
        neighborCounts[id % neighbors.length]++
        // Online mean also avoids overflow for finite but very large distances.
        meanDistance += (distances[contact] - meanDistance) / (cursor - start + 1)
      }
      const makeShell = (counts: number[], absorberIndex: number): ClusterCoordinationShell => {
        const distribution = new Map<number, number>()
        for (const count of counts) distribution.set(count, (distribution.get(count) ?? 0) + 1)
        return {
          index: pairs[left][right].shells.length + 1,
          distance: meanDistance,
          minDistance: distances[order[start]],
          maxDistance: distances[order[end - 1]],
          averageCN: (end - start) * (sameElement ? 2 : 1) / counts.length,
          centerCN: absorberIndex < 0 ? null : counts[absorberIndex],
          distribution: [...distribution].sort(([a], [b]) => a - b).map(([cn, count]) => ({ cn, count })),
          countsByAtom: counts,
        }
      }
      const forward = makeShell(centerCounts, centerIndex)
      const reverse = sameElement ? null : makeShell(neighborCounts, neighborCenterIndex)
      pairs[left][right].shells.push(forward)
      if (reverse) pairs[right][left].shells.push(reverse)
      start = end
    }
  }

  return {
    atomCount: atoms.length,
    elementCounts: Object.fromEntries(groups.map(([element, group]) => [element, group.length])),
    bondRange,
    tolerance,
    pairs: pairs.flat(),
  }
}
