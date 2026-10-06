import { describe, expect, it } from "vitest"
import type { ArtemisPath, ArtemisPathMetadata } from "./artemis"
import type { ArtemisStructureAttachment } from "./artemis-structures"
import { groupFeffPathSources } from "./feff-path-sources"

const atom = (atom: string, x: number, y = 0, z = 0, ipot = 1) => ({ atom, x, y, z, ipot })
const metadata = (overrides: Partial<ArtemisPathMetadata> = {}): ArtemisPathMetadata => ({
  nleg: 2, geometry: [atom("Cu", 0, 0, 0, 0), atom("O", 2)],
  reff: 2, degen: 4, absorber: "Cu", edge: "K", kmin: 0, kmax: 20, ...overrides,
})
const path = (id: string, overrides: Partial<ArtemisPathMetadata> = {}, label = "Copper oxide · feff0001.dat"):
  Pick<ArtemisPath, "id" | "filename" | "label" | "metadata"> => ({
  id, filename: "feff0001.dat", label, metadata: metadata(overrides),
})
const sourceCif = (sha256 = "cif-digest", siteIndex = 1) => ({ sha256, label: "Copper oxide", siteIndex })
const cluster = (atoms = [atom("Cu", 0, 0, 0, 0), atom("O", 2), atom("N", 0, 4.5)]) => ({
  source: "feff.inp" as const, atoms,
})
const site = (element: string, x: number, y: number, z: number, index: number) => ({
  index, element, species: element, occupancy: 1, multiplicity: 1, wyckoff: "1a", x, y, z,
})
const attachment = (): ArtemisStructureAttachment => ({
  id: "cif-1", amcsd_id: 1, attached_at: "2026-10-06", sha256: "attached-digest",
  structure: {
    id: 1, mineral: "Copper oxide", formula: "Cu O N", space_group: "P 1", authors: "", year: null,
    journal: "", title: "", cif: "data_example", elements: ["Cu", "O", "N"], ordered: true,
    supported: true, warnings: [], cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 },
    sites: [site("Cu", .2, .2, .2, 1), site("O", .4, .2, .2, 2), site("N", .2, .4, .2, 3)],
  },
})
const ids = (groups: ReturnType<typeof groupFeffPathSources>) => groups.map(group => group.paths.map(path => path.id))

describe("FEFF path sources", () => {
  it("groups recorded paths from the same CIF and absorber site without requiring an attachment", () => {
    const paths = [
      path("first", { sourceCif: { ...sourceCif(), attachmentId: "removed-attachment" }, viewerCluster: cluster() }),
      path("second", { sourceCif: { ...sourceCif(), attachmentId: "reattached-copy" } }, "Renamed path"),
    ]
    const before = JSON.stringify(paths)
    const groups = groupFeffPathSources(paths, [])
    expect(ids(groups)).toEqual([["first", "second"]])
    expect(groups[0]).toMatchObject({ label: "Copper oxide · Cu site 1", cifSha256: "cif-digest" })
    expect(JSON.stringify(paths)).toBe(before)
  })

  it("keeps different CIF contents separate when their labels, filenames and path atoms match", () => {
    const groups = groupFeffPathSources([
      path("first", { sourceCif: sourceCif("first-digest") }),
      path("second", { sourceCif: sourceCif("second-digest") }),
    ], [])
    expect(ids(groups)).toEqual([["first"], ["second"]])
    expect(new Set(groups.map(group => group.key)).size).toBe(2)
    expect(new Set(groups.map(group => group.label)).size).toBe(2)
    expect(groups.map(group => group.cifSha256)).toEqual(["first-digest", "second-digest"])
  })

  it("keeps different absorber sites within one recorded CIF separate", () => {
    const groups = groupFeffPathSources([
      path("site-one", { sourceCif: sourceCif("same-cif", 1) }),
      path("site-two", { sourceCif: sourceCif("same-cif", 2) }),
    ], [])
    expect(ids(groups)).toEqual([["site-one"], ["site-two"]])
    expect(groups.map(group => group.label)).toEqual(["Copper oxide · Cu site 1", "Copper oxide · Cu site 2"])
  })

  it("groups legacy full FEFF clusters independently of atom order and absolute translation", () => {
    const original = cluster()
    const translated = cluster(original.atoms.map(atom => ({ ...atom, x: atom.x + 7, y: atom.y - 3, z: atom.z + 1 })).reverse())
    const groups = groupFeffPathSources([
      path("original", { viewerCluster: original }),
      path("translated", { viewerCluster: translated }),
    ], [])
    expect(ids(groups)).toEqual([["original", "translated"]])
    expect(groups[0].label).toBe("Copper oxide · FEFF input")
  })

  it("separates legacy clusters with identical representative paths but different surroundings outside the display radius", () => {
    const groups = groupFeffPathSources([
      path("nitrogen", { viewerCluster: cluster() }),
      path("sulfur", { viewerCluster: cluster([atom("Cu", 0, 0, 0, 0), atom("O", 2), atom("S", 0, 4.5)]) }),
    ], [])
    expect(ids(groups)).toEqual([["nitrogen"], ["sulfur"]])
    expect(new Set(groups.map(group => group.key)).size).toBe(2)
  })

  it("isolates unassociated files even if their labels, filenames and representative path atoms match", () => {
    const groups = groupFeffPathSources([path("unknown-one"), path("unknown-two")], [])
    expect(ids(groups)).toEqual([["unknown-one"], ["unknown-two"]])
    expect(groups.every(group => group.label.includes("CIF unknown"))).toBe(true)
    expect(new Set(groups.map(group => group.label)).size).toBe(2)
  })

  it("groups paths matched uniquely to the same attached CIF and absorber site", () => {
    const cif = attachment()
    const groups = groupFeffPathSources([
      path("oxygen"),
      path("nitrogen", { geometry: [atom("Cu", 0, 0, 0, 0), atom("N", 0, 2)] }),
    ], [cif])
    expect(ids(groups)).toEqual([["oxygen", "nitrogen"]])
    expect(groups[0]).toMatchObject({ cifSha256: cif.sha256, label: "Copper oxide · Cu site 1" })
  })

  it("does not combine ambiguous paths merely because multiple attached crystals share their atoms", () => {
    const first = attachment()
    const second = attachment()
    second.id = "cif-2"
    second.sha256 = "different-digest"
    second.structure.sites.push(site("S", .2, .2, .65, 4))
    expect(ids(groupFeffPathSources([path("unknown-one"), path("unknown-two")], [first, second])))
      .toEqual([["unknown-one"], ["unknown-two"]])
  })
})
