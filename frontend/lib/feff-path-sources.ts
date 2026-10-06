import type { ArtemisPath } from "./artemis"
import type { ArtemisStructureAttachment } from "./artemis-structures"
import { resolveFeffStructureContext } from "./feff-structure-context"

type SourcePath = Pick<ArtemisPath, "id" | "filename" | "label" | "metadata">
export interface FeffPathSource<T> {
  key: string
  label: string
  paths: T[]
  /** Limit CIF fallback context to the recorded source, even after removal. */
  cifSha256?: string
  siteIndex?: number
}

/** Group display paths by recorded CIF and absorber site. Old models retain
 * full FEFF clusters: compare those independently of the display radius, never
 * infer a common source from a shared filename or a subset of path atoms. */
export function groupFeffPathSources<T extends SourcePath>(paths: T[], attachments: ArtemisStructureAttachment[]): FeffPathSource<T>[] {
  const groups = new Map<string, FeffPathSource<T>>()
  for (const path of paths) {
    const { metadata } = path
    const source = metadata.sourceCif
    let key: string, label: string, cifSha256: string | undefined, siteIndex: number | undefined
    if (source) {
      cifSha256 = source.sha256
      siteIndex = source.siteIndex
      key = JSON.stringify(["cif", cifSha256, metadata.absorber, source.siteIndex])
      label = `${source.label} · ${metadata.absorber} site ${source.siteIndex}`
    } else if (metadata.viewerCluster && resolveFeffStructureContext(metadata).source === "feff.inp") {
      const atoms = metadata.viewerCluster.atoms
      const origin = atoms.find(atom => atom.ipot === 0)!
      const fingerprint = atoms.map(atom => [atom.atom, atom.ipot,
        ...[atom.x - origin.x, atom.y - origin.y, atom.z - origin.z].map(value => Math.round(value * 1e5)),
      ].join(",")).sort().join(";")
      key = JSON.stringify(["cluster", fingerprint])
      const suffix = ` · ${path.filename}`
      label = path.label.endsWith(suffix) ? path.label.slice(0, -suffix.length) : path.label || path.filename
      label += " · FEFF input"
    } else {
      const context = resolveFeffStructureContext(metadata, attachments)
      const attachment = context.source === "cif" ? attachments.find(item => item.id === context.attachmentId) : undefined
      if (attachment) {
        cifSha256 = attachment.sha256
        siteIndex = context.siteIndex
        key = JSON.stringify(["cif", cifSha256, metadata.absorber, context.siteIndex])
        label = context.sourceLabel
      } else {
        // Unknown/ambiguous files remain individually inspectable; they must
        // not silently become an overlay of unrelated crystals.
        key = JSON.stringify(["path", path.id])
        label = `${path.label || path.filename} · CIF unknown`
      }
    }
    const group = groups.get(key)
    if (group) group.paths.push(path)
    else groups.set(key, { key, label, paths: [path], cifSha256, siteIndex })
  }
  const result = [...groups.values()]
  const counts = new Map<string, number>()
  for (const group of result) counts.set(group.label, (counts.get(group.label) ?? 0) + 1)
  const positions = new Map<string, number>()
  for (const group of result) {
    if (counts.get(group.label)! < 2) continue
    const position = (positions.get(group.label) ?? 0) + 1
    positions.set(group.label, position)
    group.label += ` (${position})`
  }
  return result
}
