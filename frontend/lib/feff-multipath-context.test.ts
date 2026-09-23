import { describe, expect, it } from "vitest"
import type { ArtemisPathMetadata } from "./artemis"
import type { ArtemisStructure, ArtemisStructureAttachment } from "./artemis-structures"
import { resolveFeffMultipathContext } from "./feff-multipath-context"
import { resolveFeffStructureContext } from "./feff-structure-context"

const atom = (atom: string, x: number, y = 0, z = 0, ipot = 1) => ({ atom, x, y, z, ipot })
const metadata = (geometry = [atom("Cu", 0, 0, 0, 0), atom("O", 2)]): ArtemisPathMetadata => ({
  nleg: geometry.length, geometry, reff: 2, degen: 4, absorber: "Cu", edge: "K", kmin: 0, kmax: 20,
})
const site = (element: string, x: number, y: number, z: number, index: number) => ({
  index, element, species: element, occupancy: 1, multiplicity: 1, wyckoff: "1a", x, y, z,
})
function attachment(extra: Partial<ArtemisStructure> = {}, id = "cif-1"): ArtemisStructureAttachment {
  return {
    id, amcsd_id: 1, attached_at: "2026-09-23", sha256: id,
    structure: {
      id: 1, mineral: "Example", formula: "Cu O N", space_group: "P 1", authors: "", year: null, journal: "", title: "",
      cif: "data_example", elements: ["Cu", "O", "N"], ordered: true, supported: true, warnings: [],
      cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 },
      sites: [site("Cu", .2, .2, .2, 1), site("O", .4, .2, .2, 2), site("N", .2, .4, .2, 3)],
      ...extra,
    },
  }
}
const second = () => metadata([atom("Cu", 0, 0, 0, 0), atom("N", 0, 2)])
const withProvenance = (): ArtemisPathMetadata => ({
  ...metadata(),
  viewerCluster: { source: "feff.inp", atoms: [atom("Cu", 0, 0, 0, 0), atom("O", 2), atom("N", 0, 2)] },
})

describe("shared structure context for a FEFF path overlay", () => {
  it("delegates a single selected path and handles an empty selection", () => {
    const input = metadata(), cif = attachment()
    expect(resolveFeffMultipathContext([input], [cif], { radius: 2 })).toEqual(
      resolveFeffStructureContext(input, [cif], { radius: 2 }),
    )
    expect(resolveFeffMultipathContext([], [], { radius: NaN })).toMatchObject({
      source: null, atoms: [], warnings: [], radius: 3.5, requiresSelection: false,
    })
  })

  it("uses one actual FEFF cluster for compatible paths even beyond the display cutoff", () => {
    const paths = [withProvenance(), second()]
    const original = JSON.stringify(paths)
    const result = resolveFeffMultipathContext(paths, [attachment()], { radius: 1 })
    expect(result).toMatchObject({ source: "feff.inp", radius: 1, warnings: [] })
    expect(result.atoms).toHaveLength(1)
    expect(JSON.stringify(paths)).toBe(original)
  })

  it("accepts translated FEFF path origins while preserving their orientation", () => {
    const translated = metadata([atom("Cu", 5, 1, -3, 0), atom("N", 5, 3, -3)])
    expect(resolveFeffMultipathContext([withProvenance(), translated]).source).toBe("feff.inp")
    const rotated = metadata([atom("Cu", 0, 0, 0, 0), atom("N", 2)])
    const result = resolveFeffMultipathContext([withProvenance(), rotated])
    expect(result).toMatchObject({ source: null, atoms: [], requiresSelection: false })
    expect(result.warnings.join(" ")).toContain("common local structure is not verified")
  })

  it("does not replace a short focused FEFF cluster with another path's source or an attached CIF", () => {
    const anchor = withProvenance()
    anchor.viewerCluster!.atoms = anchor.viewerCluster!.atoms.slice(0, 2)
    const other = { ...second(), viewerCluster: withProvenance().viewerCluster }
    const result = resolveFeffMultipathContext([anchor, other], [attachment()])
    expect(result).toMatchObject({ source: null, atoms: [], requiresSelection: false })
    expect(result.warnings.join(" ")).toContain("absent from the focused path's FEFF input")
    expect(result.warnings.join(" ")).toContain("overlay shows each path's absorber-centered coordinates")
  })

  it("verifies compatible paths against one explicit CIF site and leaves metadata untouched", () => {
    const paths = [metadata(), { ...second(), viewerCluster: withProvenance().viewerCluster }]
    const cif = attachment()
    const original = JSON.stringify({ paths, cif })
    const result = resolveFeffMultipathContext(paths, [cif], { radius: 1, selectedAttachmentId: cif.id, selectedSiteIndex: 1 })
    expect(result).toMatchObject({ source: "cif", attachmentId: cif.id, siteIndex: 1, warnings: [] })
    expect(result.atoms).toHaveLength(1)
    expect(JSON.stringify({ paths, cif })).toBe(original)
  })

  it("rejects paths that separately match different CIF structures", () => {
    const first = attachment({ sites: [site("Cu", .2, .2, .2, 1), site("O", .4, .2, .2, 2)] })
    const other = attachment({ sites: [site("Cu", .2, .2, .2, 1), site("N", .2, .4, .2, 3)] }, "cif-2")
    const anchor = resolveFeffStructureContext(metadata(), [first, other])
    const result = resolveFeffMultipathContext([metadata(), second()], [first, other])
    expect(result).toMatchObject({ source: null, atoms: [], requiresSelection: false })
    expect(result.candidates).toEqual(anchor.candidates)
    expect(result.warnings.join(" ")).toContain("do not match the chosen CIF absorber site")
  })

  it("preserves ambiguous CIF candidates until an explicit common structure is chosen", () => {
    const first = attachment(), other = attachment({ mineral: "Other example" }, "cif-2")
    const result = resolveFeffMultipathContext([metadata(), second()], [first, other])
    expect(result).toMatchObject({ source: null, atoms: [], requiresSelection: true })
    expect(result.candidates).toHaveLength(2)
    const chosen = resolveFeffMultipathContext([metadata(), second()], [first, other], { selectedAttachmentId: other.id })
    expect(chosen).toMatchObject({ source: "cif", attachmentId: other.id, requiresSelection: false })
  })

  it("does not switch absorber sites within the selected CIF to accommodate another path", () => {
    const cif = attachment({ sites: [
      site("Cu", .2, .2, .2, 1), site("O", .4, .2, .2, 2),
      site("Cu", .7, .7, .7, 4), site("O", .9, .7, .7, 5), site("N", .7, .9, .7, 6),
    ] })
    const result = resolveFeffMultipathContext([metadata(), second()], [cif], {
      selectedAttachmentId: cif.id, selectedSiteIndex: 1,
    })
    expect(result).toMatchObject({ source: null, atoms: [], requiresSelection: false })
    expect(result.warnings.join(" ")).toContain("do not match the chosen CIF absorber site")
  })

  it("reports absent context without mistaking it for an unresolved structure selection", () => {
    const result = resolveFeffMultipathContext([metadata(), second()])
    expect(result).toMatchObject({ source: null, atoms: [], candidates: [], requiresSelection: false })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("common local structure is not verified")
  })

  it("rejects different absorber elements and invalid selected path geometry", () => {
    const changed = { ...second(), absorber: "Fe", geometry: [atom("Fe", 0, 0, 0, 0), atom("N", 0, 2)] }
    const result = resolveFeffMultipathContext([withProvenance(), changed])
    expect(result.source).toBeNull()
    expect(result.warnings.join(" ")).toContain("different absorber elements")
    const invalid = { ...second(), nleg: 3 }
    expect(resolveFeffMultipathContext([withProvenance(), invalid]).warnings.join(" ")).toContain("invalid atomic geometry")
  })
})
