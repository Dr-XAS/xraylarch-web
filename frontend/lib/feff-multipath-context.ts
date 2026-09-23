import type { ArtemisPathMetadata } from "./artemis"
import type { ArtemisStructureAttachment } from "./artemis-structures"
import { CIF_VIEWER_DEFAULT_RADIUS, CIF_VIEWER_MAX_RADIUS, CIF_VIEWER_MIN_RADIUS } from "./cif-viewer"
import { buildFeffPathGeometry } from "./feff-path-geometry"
import {
  resolveFeffStructureContext,
  type FeffStructureContext,
  type FeffStructureContextOptions,
} from "./feff-structure-context"

const OVERLAY_WARNING = "A common local structure is not verified; the overlay shows each path's absorber-centered coordinates."

function withoutContext(context: FeffStructureContext, reason?: string): FeffStructureContext {
  return {
    ...context, atoms: [], source: null, sourceLabel: "Path atoms only", attachmentId: undefined, siteIndex: undefined,
    warnings: [...new Set([...context.warnings, ...(reason ? [reason] : []), OVERLAY_WARNING])],
  }
}

/**
 * Resolve one verified structure behind an overlay, using the first (focused)
 * path as the anchor. All validation uses full source coordinates, independent
 * of the display radius. Paths and their scientific metadata remain untouched.
 */
export function resolveFeffMultipathContext(
  metadata: ArtemisPathMetadata[],
  attachments: ArtemisStructureAttachment[] = [],
  options: FeffStructureContextOptions = {},
): FeffStructureContext {
  if (!metadata.length) {
    return {
      atoms: [], source: null, sourceLabel: "Path atoms only", warnings: [],
      radius: Math.min(CIF_VIEWER_MAX_RADIUS, Math.max(CIF_VIEWER_MIN_RADIUS,
        Number.isFinite(options.radius) ? options.radius! : CIF_VIEWER_DEFAULT_RADIUS)),
      maxRadius: CIF_VIEWER_MAX_RADIUS, availableRadius: null, candidates: [], requiresSelection: false,
    }
  }
  const anchor = resolveFeffStructureContext(metadata[0], attachments, options)
  if (metadata.length === 1) return anchor
  if (!anchor.source) return withoutContext(anchor)

  const firstGeometry = buildFeffPathGeometry(metadata[0]).geometry
  for (const path of metadata.slice(1)) {
    const geometry = buildFeffPathGeometry(path).geometry
    if (!firstGeometry || !geometry) {
      return withoutContext(anchor, "One or more selected paths have invalid atomic geometry.")
    }
    if (path.absorber !== metadata[0].absorber || geometry.absorber.atom !== firstGeometry.absorber.atom) {
      return withoutContext(anchor, "The selected paths have different absorber elements.")
    }

    if (anchor.source === "feff.inp") {
      // Keep the actual focused calculation as the source. A second path's own
      // provenance or an unrelated attached CIF cannot silently replace it.
      const checked = resolveFeffStructureContext({ ...path, viewerCluster: metadata[0].viewerCluster }, [], options)
      if (checked.source !== "feff.inp") {
        return withoutContext(anchor, "Some selected path atoms are absent from the focused path's FEFF input cluster.")
      }
    } else {
      // Strip optional provenance only from this temporary validation object;
      // otherwise the single-path resolver would prefer it over the chosen CIF.
      const checked = resolveFeffStructureContext({ ...path, viewerCluster: undefined }, attachments, {
        ...options, selectedAttachmentId: anchor.attachmentId, selectedSiteIndex: anchor.siteIndex,
      })
      if (checked.source !== "cif" || checked.attachmentId !== anchor.attachmentId || checked.siteIndex !== anchor.siteIndex) {
        return withoutContext(anchor, "Some selected paths do not match the chosen CIF absorber site in the same coordinate frame.")
      }
    }
  }
  return anchor
}
