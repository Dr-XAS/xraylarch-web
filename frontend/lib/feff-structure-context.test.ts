import { describe, expect, it } from "vitest"
import type { ArtemisPathMetadata } from "./artemis"
import type { ArtemisStructure, ArtemisStructureAttachment } from "./artemis-structures"
import { buildCifGeometry } from "./cif-viewer"
import { buildFeffPathGeometry } from "./feff-path-geometry"
import { resolveFeffStructureContext } from "./feff-structure-context"

const atom = (atom: string, x: number, y = 0, z = 0, ipot = 1) => ({ atom, x, y, z, ipot })
const metadata = (geometry = [atom("Cu", 0, 0, 0, 0), atom("O", 2)]): ArtemisPathMetadata => ({
  nleg: geometry.length, geometry, reff: 2, degen: 4, absorber: "Cu", edge: "K", kmin: 0, kmax: 20,
})
const site = (element: string, x: number, y: number, z: number, index: number) => ({
  index, element, species: element, occupancy: 1, multiplicity: 1, wyckoff: "1a", x, y, z,
})
function structure(overrides: Partial<ArtemisStructure> = {}): ArtemisStructure {
  return {
    id: 1, mineral: "Copper oxide", formula: "Cu O N", space_group: "P 1", authors: "", year: null, journal: "", title: "",
    cif: "data_example", elements: ["Cu", "O", "N"], ordered: true, supported: true, warnings: [],
    cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 },
    sites: [site("Cu", .2, .2, .2, 1), site("O", .4, .2, .2, 2), site("N", .2, .4, .2, 3)],
    ...overrides,
  }
}
const attachment = (value = structure(), id = "cif-1"): ArtemisStructureAttachment => ({
  id, amcsd_id: value.id, attached_at: "2026-09-23", sha256: id, structure: value,
})

describe("FEFF structure context", () => {
  it("uses the same local cluster as the CIF viewer around the matching absorber", () => {
    const cif = attachment()
    const input = metadata()
    const original = JSON.stringify({ input, cif })
    const result = resolveFeffStructureContext(input, [cif])
    const expected = buildCifGeometry(cif.structure, { siteIndex: 1, radius: 3.5 })
    expect(result).toMatchObject({ source: "cif", attachmentId: cif.id, siteIndex: 1, radius: 3.5, maxRadius: 10, requiresSelection: false })
    expect(result.atoms.map(({ atom, x, y, z }) => ({ element: atom, x, y, z }))).toEqual(
      expected.atoms.map(({ element, x, y, z }) => ({ element, x, y, z })),
    )
    expect(result.warnings).toEqual([])
    expect(JSON.stringify({ input, cif })).toBe(original)
  })

  it("searches matching absorber sites and recenters a translated path without rotating it", () => {
    const cif = attachment(structure({ sites: [site("Cu", .7, .7, .7, 4), ...structure().sites] }))
    const input = metadata([atom("Cu", 12, 7, -1, 0), atom("O", 14, 7, -1)])
    expect(resolveFeffStructureContext(input, [cif])).toMatchObject({ source: "cif", siteIndex: 1 })
    const rotated = metadata([atom("Cu", 0, 0, 0, 0), atom("O", 0, 2)])
    expect(resolveFeffStructureContext(rotated, [cif]).source).toBeNull()
  })

  it("validates every unique path atom, including sites outside the display radius", () => {
    const cif = attachment(structure({ sites: [...structure().sites, site("O", .65, .2, .2, 4)] }))
    const input = metadata([atom("Cu", 0, 0, 0, 0), atom("O", 2), atom("O", 4.5)])
    const result = resolveFeffStructureContext(input, [cif], { radius: 1 })
    expect(result.source).toBe("cif")
    expect(result.atoms).toHaveLength(1)
    expect(buildFeffPathGeometry(input).geometry?.atoms).toHaveLength(3)
    const incomplete = attachment(structure())
    expect(resolveFeffStructureContext(input, [incomplete], { radius: 1 }).source).toBeNull()
  })

  it("accepts FEFF rounding but rejects a different element or lattice spacing", () => {
    expect(resolveFeffStructureContext(metadata([atom("Cu", 0, 0, 0, 0), atom("O", 2.004)]), [attachment()]).source).toBe("cif")
    expect(resolveFeffStructureContext(metadata([atom("Cu", 0, 0, 0, 0), atom("O", 2.006)]), [attachment()]).source).toBeNull()
    expect(resolveFeffStructureContext(metadata([atom("Cu", 0, 0, 0, 0), atom("N", 2)]), [attachment()]).source).toBeNull()
  })

  it("prefers validated FEFF provenance and limits its radius to actual recorded atoms", () => {
    const input = metadata()
    input.viewerCluster = { source: "feff.inp", atoms: [atom("Cu", 5, 0, 0, 0), atom("O", 7), atom("O", 2)] }
    const result = resolveFeffStructureContext(input, [attachment()], { radius: 6 })
    expect(result).toMatchObject({ source: "feff.inp", radius: 3, maxRadius: 3, availableRadius: 3, candidates: [] })
    expect(result.atoms.map(({ x }) => x)).toEqual([0, 2, -3])
  })

  it("rounds a finite FEFF extent upward to a valid slider step without adding atoms", () => {
    const input = metadata()
    input.viewerCluster = { source: "feff.inp", atoms: [atom("Cu", 0, 0, 0, 0), atom("O", 2), atom("N", 2.56)] }
    const result = resolveFeffStructureContext(input, [], { radius: 6 })
    expect(result).toMatchObject({ source: "feff.inp", radius: 2.6, maxRadius: 2.6, availableRadius: 2.56 })
    expect(result.atoms).toEqual(input.viewerCluster.atoms)
  })

  it("rejects corrupt provenance potentials and a different atom occupying the absorber", () => {
    const input = metadata()
    for (const atoms of [
      [atom("Cu", 0, 0, 0, 0), atom("O", 2, 0, 0, -1)],
      [atom("N", 0, 0, 0, 0), atom("Cu", 0), atom("O", 2)],
      [atom("Cu", 0, 0, 0, 0), atom("O", 2, 0, 0, 0)],
    ]) {
      input.viewerCluster = { source: "feff.inp", atoms }
      expect(resolveFeffStructureContext(input)).toMatchObject({ source: null, atoms: [] })
    }
  })

  it("rejects mismatched FEFF provenance before considering a matching attached CIF", () => {
    const input = metadata()
    input.viewerCluster = { source: "feff.inp", atoms: [atom("Cu", 0, 0, 0, 0), atom("O", 3)] }
    const result = resolveFeffStructureContext(input, [attachment()])
    expect(result.source).toBe("cif")
    expect(result.warnings).toEqual([expect.stringContaining("recorded FEFF cluster does not match")])
  })

  it("requires an explicit structure choice when different attached crystals match a short path", () => {
    const first = attachment()
    const second = attachment(structure({ mineral: "Second crystal", sites: [...structure().sites, site("S", .2, .2, .45, 5)] }), "cif-2")
    const ambiguous = resolveFeffStructureContext(metadata(), [first, second])
    expect(ambiguous).toMatchObject({ source: null, atoms: [], requiresSelection: true })
    expect(ambiguous.candidates).toHaveLength(2)
    const chosen = resolveFeffStructureContext(metadata(), [first, second], { selectedAttachmentId: "cif-2" })
    expect(chosen).toMatchObject({ source: "cif", attachmentId: "cif-2", requiresSelection: false })
    expect(chosen.atoms.some(atom => atom.atom === "S")).toBe(true)
  })

  it("deduplicates identical attachments without choosing between different absorber environments", () => {
    const first = attachment()
    const duplicate = { ...first, id: "copy" }
    expect(resolveFeffStructureContext(metadata(), [first, duplicate]).source).toBe("cif")
    const cif = attachment(structure({ sites: [
      ...structure().sites, site("Cu", .7, .7, .7, 4), site("O", .9, .7, .7, 5),
    ] }))
    expect(resolveFeffStructureContext(metadata(), [cif]).requiresSelection).toBe(true)
    expect(resolveFeffStructureContext(metadata(), [cif], { selectedAttachmentId: cif.id, selectedSiteIndex: 4 }))
      .toMatchObject({ source: "cif", siteIndex: 4, requiresSelection: false })
  })

  it("retains ambiguity when the display radius hides differences between absorber sites", () => {
    const cif = attachment(structure({ sites: [
      site("Cu", .2, .2, .2, 1), site("O", .4, .2, .2, 2), site("N", .2, .2, .6, 3),
      site("Cu", .7, .7, .7, 4), site("O", .9, .7, .7, 5),
    ] }))
    const results = [1, 3.5, 6].map(radius => resolveFeffStructureContext(metadata(), [cif], { radius }))
    for (const result of results) {
      expect(result).toMatchObject({ source: null, requiresSelection: true })
      expect(result.candidates).toEqual(results[0].candidates)
    }
  })

  it("automatically recognizes equivalent FCC absorber sites at every display radius", () => {
    const cif = attachment(structure({
      cell: { a: 3.6032, b: 3.6032, c: 3.6032, alpha: 90, beta: 90, gamma: 90 },
      sites: [site("Cu", 0, 0, 0, 1), site("Cu", .5, .5, 0, 2), site("Cu", .5, 0, .5, 3), site("Cu", 0, .5, .5, 4)],
    }))
    const input = metadata([atom("Cu", 0, 0, 0, 0), atom("Cu", 1.8016, 1.8016)])
    const results = [1, 3.5, 10].map(radius => resolveFeffStructureContext(input, [cif], { radius }))
    for (const result of results) {
      expect(result).toMatchObject({ source: "cif", requiresSelection: false, siteIndex: 1 })
      expect(result.candidates).toEqual(results[0].candidates)
    }
    expect(results[0].atoms).toHaveLength(1)
    expect(results[2].atoms.length).toBeGreaterThan(results[1].atoms.length)
    expect(resolveFeffStructureContext(input, [cif], { selectedSiteIndex: 4 }).siteIndex).toBe(4)
  })

  it("keeps missing or unrelated structure context empty, without inventing neighbors from degeneracy", () => {
    const input = { ...metadata(), degen: 48 }
    expect(resolveFeffStructureContext(input)).toMatchObject({ source: null, atoms: [], warnings: [] })
    const unrelated = attachment(structure({ sites: [site("Cu", 0, 0, 0, 1)] }))
    expect(resolveFeffStructureContext(input, [unrelated])).toMatchObject({ source: null, atoms: [] })
    expect(resolveFeffStructureContext(input, [unrelated]).warnings[0]).toContain("No attached CIF matches")
  })

  it("does not establish source identity from a truncated comparison cluster", () => {
    const dense = attachment(structure({
      cell: { a: 1, b: 1, c: 1, alpha: 90, beta: 90, gamma: 90 },
      sites: [site("Cu", 0, 0, 0, 1)],
    }))
    const input = metadata([atom("Cu", 0, 0, 0, 0), atom("Cu", 1)])
    expect(resolveFeffStructureContext(input, [dense], { radius: 1 })).toMatchObject({ source: null, atoms: [] })
  })

  it("clamps display radii like the CIF viewer and retains the path beyond the cutoff", () => {
    const input = metadata()
    const before = JSON.stringify(input)
    expect(resolveFeffStructureContext(input, [attachment()], { radius: NaN }).radius).toBe(3.5)
    expect(resolveFeffStructureContext(input, [attachment()], { radius: -1 }).radius).toBe(1)
    expect(resolveFeffStructureContext(input, [attachment()], { radius: 30 }).radius).toBe(10)
    expect(JSON.stringify(input)).toBe(before)
    expect(buildFeffPathGeometry(input).geometry?.legs).toHaveLength(2)
  })
})
