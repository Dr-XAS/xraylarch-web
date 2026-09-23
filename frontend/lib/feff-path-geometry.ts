import type { ArtemisPathMetadata } from "./artemis"

type PathSite = ArtemisPathMetadata["geometry"][number]

export interface FeffPathVisit extends PathSite {
  /** Index into atoms; repeated visits retain the same physical atom index. */
  atomIndex: number
  /** Zero is the starting absorber; nleg is its final return. */
  visitIndex: number
}

export interface FeffPathAtom extends PathSite {
  index: number
  visitIndices: number[]
  isAbsorber: boolean
}

export interface FeffPathLeg {
  index: number
  from: FeffPathVisit
  to: FeffPathVisit
  length: number
  /** FEFF beta at the destination: 0 degrees forward, 180 degrees back. */
  scatteringAngle: number
}

export interface FeffPathGeometry {
  atoms: FeffPathAtom[]
  visits: FeffPathVisit[]
  legs: FeffPathLeg[]
  absorber: FeffPathAtom
  totalLength: number
  classification: {
    kind: "single" | "double-triangle" | "double-collinear" | "multiple"
    label: string
    description: string
    hasRepeatedSites: boolean
  }
}

export interface FeffPathGeometryResult {
  geometry: FeffPathGeometry | null
  error: string | null
}

const POSITION_TOLERANCE = 1e-5

function distance(a: PathSite, b: PathSite) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Build one representative closed FEFF trajectory, without inventing equivalent paths. */
export function buildFeffPathGeometry(metadata: ArtemisPathMetadata): FeffPathGeometryResult {
  const fail = (error: string): FeffPathGeometryResult => ({ geometry: null, error })
  const nleg = metadata.nleg
  if (!Number.isInteger(nleg) || nleg < 2 || nleg > 20) {
    return fail("A FEFF path must contain between 2 and 20 legs.")
  }
  const rows = metadata.geometry
  if (!Array.isArray(rows) || rows.length !== nleg) {
    return fail(`Expected ${nleg} geometry entries for this path; received ${Array.isArray(rows) ? rows.length : 0}.`)
  }
  if (rows.some(site => !site || ![site.x, site.y, site.z].every(Number.isFinite))) {
    return fail("The path contains missing or non-finite atomic coordinates.")
  }
  const absorberIndex = rows.findIndex(site => site.ipot === 0)
  if (absorberIndex < 0) return fail("The path has no absorber entry (ipot = 0).")

  // FEFF geometry is cyclic. Rotation changes the starting point, never the order.
  // In particular, a later absorber visit is a real vertex and must be retained.
  const origin = rows[absorberIndex]
  const ordered = [...rows.slice(absorberIndex), ...rows.slice(0, absorberIndex)].map(site => ({
    ...site, x: site.x - origin.x, y: site.y - origin.y, z: site.z - origin.z,
  }))
  if (ordered.some((site, i) => distance(site, ordered[(i + 1) % nleg]) <= POSITION_TOLERANCE)) {
    return fail("The path contains a zero-length leg between consecutive visits.")
  }

  const atoms: FeffPathAtom[] = []
  const visits: FeffPathVisit[] = [...ordered, ordered[0]].map((site, visitIndex) => {
    let atomIndex = atoms.findIndex(atom => distance(atom, site) <= POSITION_TOLERANCE)
    if (atomIndex < 0) {
      atomIndex = atoms.length
      atoms.push({ ...site, index: atomIndex, visitIndices: [], isAbsorber: atomIndex === 0 })
    }
    atoms[atomIndex].visitIndices.push(visitIndex)
    return { ...site, atomIndex, visitIndex }
  })
  const legs = visits.slice(0, -1).map((from, i): FeffPathLeg => {
    const to = visits[i + 1]
    const next = visits[(i + 2) % nleg]
    const length = distance(from, to)
    const outgoingLength = distance(to, next)
    const dot = (to.x - from.x) * (next.x - to.x) +
      (to.y - from.y) * (next.y - to.y) + (to.z - from.z) * (next.z - to.z)
    const cosine = Math.max(-1, Math.min(1, dot / (length * outgoingLength)))
    return { index: i + 1, from, to, length, scatteringAngle: Math.acos(cosine) * 180 / Math.PI }
  })
  const hasRepeatedSites = atoms.length < nleg
  let classification: FeffPathGeometry["classification"]
  if (nleg === 2) {
    classification = {
      kind: "single", label: "Single scattering", hasRepeatedSites,
      description: "Absorber → neighbor → absorber. Two legs describe one backscattering event.",
    }
  } else if (nleg === 3) {
    const [a, b, c] = ordered
    const ab = [b.x - a.x, b.y - a.y, b.z - a.z]
    const ac = [c.x - a.x, c.y - a.y, c.z - a.z]
    const crossLength = Math.hypot(
      ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0],
    )
    const collinear = crossLength <= POSITION_TOLERANCE * Math.max(distance(a, b), distance(a, c))
    classification = {
      kind: collinear ? "double-collinear" : "double-triangle",
      label: collinear ? "Double scattering · collinear" : "Double scattering · triangle",
      hasRepeatedSites,
      description: collinear
        ? "Absorber → first scatterer → second scatterer → absorber. These three legs are collinear, so the triangle is collapsed."
        : "Absorber → first scatterer → second scatterer → absorber. Three legs form a triangular trajectory.",
    }
  } else {
    classification = {
      kind: "multiple", label: nleg === 4 ? "Triple scattering" : `${nleg - 1}-fold scattering`, hasRepeatedSites,
      description: `${nleg} directed legs form a closed multiple-scattering trajectory.${hasRepeatedSites
        ? " The trajectory revisits an atomic site; repeated visits are retained." : ""}`,
    }
  }
  return {
    geometry: { atoms, visits, legs, absorber: atoms[0], totalLength: legs.reduce((sum, leg) => sum + leg.length, 0), classification },
    error: null,
  }
}
