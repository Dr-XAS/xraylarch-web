import type { ArtemisPathMetadata } from "./artemis"
import type { ArtemisStructureAttachment } from "./artemis-structures"
import {
  buildCifGeometry, CIF_VIEWER_DEFAULT_RADIUS, CIF_VIEWER_MAX_RADIUS, CIF_VIEWER_MIN_RADIUS,
  type CifGeometry,
} from "./cif-viewer"
import { buildFeffPathGeometry } from "./feff-path-geometry"

export interface FeffContextAtom {
  atom: string
  x: number
  y: number
  z: number
  ipot?: number
}

export interface FeffStructureCandidate {
  attachmentId: string
  siteIndex: number
  label: string
}

export interface FeffStructureContext {
  /** Surrounding atoms within the display radius. Render the path atoms separately. */
  atoms: FeffContextAtom[]
  source: "feff.inp" | "cif" | null
  sourceLabel: string
  attachmentId?: string
  siteIndex?: number
  warnings: string[]
  radius: number
  maxRadius: number
  /** Outer extent of a finite FEFF input; null for a periodic CIF or no source. */
  availableRadius: number | null
  candidates: FeffStructureCandidate[]
  requiresSelection: boolean
}

export interface FeffStructureContextOptions {
  radius?: number
  selectedAttachmentId?: string
  selectedSiteIndex?: number
}

// FEFF text coordinates are rounded. Match both element and Cartesian position;
// matching a distance alone cannot establish a common crystal or orientation.
const MATCH_TOLERANCE = 0.005
const MAX_CONTEXT_ATOMS = 4000
const MAX_MATCHING_SITES = 128
const length = (atom: FeffContextAtom) => Math.hypot(atom.x, atom.y, atom.z)
const matches = (path: FeffContextAtom[], atoms: FeffContextAtom[]) => path.every(site => atoms.some(atom =>
  atom.atom === site.atom && Math.hypot(atom.x - site.x, atom.y - site.y, atom.z - site.z) <= MATCH_TOLERANCE,
))
const contextAtoms = (geometry: CifGeometry): FeffContextAtom[] => geometry.atoms.map(atom => ({
  atom: atom.element, x: atom.x, y: atom.y, z: atom.z, ...(atom.isAbsorber ? { ipot: 0 } : {}),
}))
const fingerprint = (atoms: FeffContextAtom[]) => atoms.map(atom =>
  [atom.atom, ...[atom.x, atom.y, atom.z].map(value => Math.round(value * 1e5))].join(","),
).sort().join(";")

/**
 * Resolve display-only structure context without changing path/fitting data.
 * Prefer actual FEFF provenance. An attached CIF is eligible only when every
 * unique path atom matches in the same Cartesian frame about an absorber site.
 * No rotation, equivalent-path expansion, or degeneracy-based atoms are added.
 */
export function resolveFeffStructureContext(
  metadata: ArtemisPathMetadata,
  attachments: ArtemisStructureAttachment[] = [],
  options: FeffStructureContextOptions = {},
): FeffStructureContext {
  const radius = Math.min(CIF_VIEWER_MAX_RADIUS, Math.max(CIF_VIEWER_MIN_RADIUS,
    Number.isFinite(options.radius) ? options.radius! : CIF_VIEWER_DEFAULT_RADIUS))
  const result: FeffStructureContext = {
    atoms: [], source: null, sourceLabel: "Path atoms only", warnings: [], radius,
    maxRadius: CIF_VIEWER_MAX_RADIUS, availableRadius: null, candidates: [], requiresSelection: false,
  }
  const { geometry, error } = buildFeffPathGeometry(metadata)
  if (!geometry) {
    if (error) result.warnings.push(error)
    return result
  }
  const path = geometry.atoms
  const recorded = metadata.viewerCluster
  if (recorded) {
    const atoms = recorded.atoms
    if (recorded.source === "feff.inp" && Array.isArray(atoms) && atoms.length <= MAX_CONTEXT_ATOMS &&
      atoms.every(atom => atom && typeof atom.atom === "string" && Number.isInteger(atom.ipot) && atom.ipot >= 0 &&
        [atom.x, atom.y, atom.z].every(Number.isFinite))) {
      const absorbers = atoms.filter(atom => atom.ipot === 0)
      if (absorbers.length === 1) {
        const origin = absorbers[0]
        const centered = atoms.map(atom => ({ ...atom, x: atom.x - origin.x, y: atom.y - origin.y, z: atom.z - origin.z }))
        if (origin.atom === geometry.absorber.atom && matches(path, centered)) {
          const availableRadius = Math.max(...centered.map(length))
          // Keep the slider endpoint on its 0.1 Å step. This rounds the display
          // extent only; it never synthesizes atoms beyond the recorded cluster.
          const maxRadius = Math.max(CIF_VIEWER_MIN_RADIUS, Math.min(CIF_VIEWER_MAX_RADIUS,
            Math.ceil((availableRadius - 1e-6) * 10) / 10))
          const displayRadius = Math.min(radius, maxRadius)
          return {
            ...result, source: "feff.inp", sourceLabel: "FEFF input cluster", availableRadius, maxRadius, radius: displayRadius,
            atoms: centered.filter(atom => length(atom) <= displayRadius + 1e-6),
          }
        }
      }
    }
    result.warnings.push("The recorded FEFF cluster does not match this path's atoms and is not displayed.")
  }
  if (!attachments.length) return result

  const pathRadius = Math.max(...path.map(length))
  if (pathRadius > CIF_VIEWER_MAX_RADIUS) {
    result.warnings.push("The path extends beyond the 10 Å CIF preview limit, so a matching surrounding structure could not be verified.")
    return result
  }
  // Source identity must not change when only the display radius changes. Check
  // the entire supported preview extent before considering sites equivalent.
  const matchingRadius = CIF_VIEWER_MAX_RADIUS
  const potentialSites = attachments.flatMap(attachment => attachment.structure.sites
    .filter(site => site.element === geometry.absorber.atom)
    .map(site => ({ attachment, site })))
  if (potentialSites.length > MAX_MATCHING_SITES) {
    result.warnings.push("Too many absorber sites to verify a unique matching CIF structure.")
    return result
  }
  type Match = { candidate: FeffStructureCandidate; attachment: ArtemisStructureAttachment; structureKey: string }
  const found: Match[] = []
  const seen = new Set<string>()
  for (const { attachment, site } of potentialSites) {
    const cluster = buildCifGeometry(attachment.structure, {
      absorber: site.element, siteIndex: site.index, radius: matchingRadius, maxAtoms: MAX_CONTEXT_ATOMS,
    })
    const atoms = contextAtoms(cluster)
    if (!atoms.length || cluster.truncated || !matches(path, atoms)) continue
    const shape = fingerprint(atoms)
    const duplicateKey = `${attachment.id}:${shape}`
    // Equivalent absorber sites need no arbitrary site choice in the interface.
    if (seen.has(duplicateKey) && options.selectedSiteIndex !== site.index) continue
    seen.add(duplicateKey)
    const candidate = {
      attachmentId: attachment.id, siteIndex: site.index,
      label: `${attachment.structure.mineral || attachment.structure.formula || "Attached CIF"} · ${site.element} site ${site.index}`,
    }
    found.push({
      candidate, attachment,
      structureKey: `${attachment.sha256 || attachment.structure.cif}:${shape}`,
    })
  }
  result.candidates = found.map(match => match.candidate)
  const eligible = found.filter(({ candidate }) =>
    (!options.selectedAttachmentId || candidate.attachmentId === options.selectedAttachmentId) &&
    (options.selectedSiteIndex === undefined || candidate.siteIndex === options.selectedSiteIndex),
  )
  if (!eligible.length) {
    result.warnings.push(options.selectedAttachmentId
      ? "The selected CIF does not match all path atoms in this coordinate frame."
      : "No attached CIF matches all path atoms in this coordinate frame.")
    return result
  }
  if (new Set(eligible.map(match => match.structureKey)).size > 1) {
    result.requiresSelection = true
    result.warnings.push("More than one attached structure matches this path. Select a structure to display its local cluster.")
    return result
  }
  const chosen = eligible[0]
  const display = buildCifGeometry(chosen.attachment.structure, {
    absorber: geometry.absorber.atom, siteIndex: chosen.candidate.siteIndex, radius,
  })
  return {
    ...result, source: "cif", sourceLabel: chosen.candidate.label,
    attachmentId: chosen.candidate.attachmentId, siteIndex: chosen.candidate.siteIndex,
    atoms: contextAtoms(display),
    warnings: [...result.warnings, ...display.warnings],
  }
}
