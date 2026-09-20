import { describe, expect, it } from "vitest"
import type { ArtemisStructure } from "./artemis-structures"
import { buildCifGeometry, CIF_VIEWER_DEFAULT_RADIUS, CIF_VIEWER_MAX_RADIUS } from "./cif-viewer"

function structure(overrides: Partial<ArtemisStructure> = {}): ArtemisStructure {
  return {
    id: 13088, mineral: "Copper", formula: "Cu", space_group: "F m -3 m", authors: "", year: null, journal: "", title: "",
    cif: `data_copper
loop_
_space_group_symop_id
_space_group_symop_operation_xyz
1 'x,y,z'
2 'x,y+1/2,z+1/2'
3 'x+1/2,y,z+1/2'
4 'x+1/2,y+1/2,z'
`,
    elements: ["Cu"], ordered: true, supported: true, warnings: [],
    cell: { a: 3.63, b: 3.63, c: 3.63, alpha: 90, beta: 90, gamma: 90 },
    sites: [{ index: 1, element: "Cu", species: "Cu", occupancy: 1, multiplicity: 4, wyckoff: "4a", x: 0, y: 0, z: 0 }],
    ...overrides,
  }
}

// AMCSD 11639: the displayed CuO example uses a monoclinic conventional cell.
const tenorite = structure({
  id: 11639, mineral: "Tenorite", formula: "Cu O", space_group: "C 1 2/c 1", elements: ["Cu", "O"],
  cell: { a: 4.653, b: 3.41, c: 5.108, alpha: 90, beta: 99.48, gamma: 90 },
  sites: [
    { index: 1, element: "Cu", species: "Cu", occupancy: 1, multiplicity: 4, wyckoff: "4c", x: .25, y: .25, z: 0 },
    { index: 2, element: "O", species: "O", occupancy: 1, multiplicity: 4, wyckoff: "4e", x: 0, y: .416, z: .25 },
  ],
  cif: `data_global
_publ_section_title
;
An ignored multiline field containing loop_ and _symmetry_equiv_pos_as_xyz
;
loop_
_space_group_symop_operation_xyz
'x,y,z'
'1/2+x,1/2+y,z'
'x,-y,1/2+z'
'1/2+x,1/2-y,1/2+z'
'-x,y,1/2-z'
'1/2-x,1/2+y,1/2-z'
'-x,-y,-z'
'1/2-x,1/2-y,-z'
loop_
_atom_site_label
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Cu .25 .25 0
O 0 -.584 .25
`,
})

describe("CIF viewer geometry", () => {
  it("expands the FCC cell and preserves its twelve nearest Cu neighbors", () => {
    const cell = buildCifGeometry(structure(), { mode: "cell" })
    expect(cell.warnings).toEqual([])
    expect(cell.atoms).toHaveLength(4)
    expect(cell.cellEdges).toHaveLength(12)
    const cluster = buildCifGeometry(structure(), { radius: 3 })
    expect(cluster.atoms).toHaveLength(13)
    expect(cluster.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
    expect(cluster.atoms[0]).toMatchObject({ element: "Cu", siteIndex: 1, x: 0, y: 0, z: 0 })
    for (const atom of cluster.atoms.slice(1)) expect(atom.distance).toBeCloseTo(3.63 / Math.sqrt(2), 8)
  })

  it("reconstructs all eight Tenorite atoms and its four Cu-O first neighbors", () => {
    const cell = buildCifGeometry(tenorite, { mode: "cell" })
    expect(cell.warnings).toEqual([])
    expect(cell.atoms.filter(atom => atom.element === "Cu")).toHaveLength(4)
    expect(cell.atoms.filter(atom => atom.element === "O")).toHaveLength(4)
    expect(cell.lattice?.[2][0]).toBeLessThan(0)
    const cluster = buildCifGeometry(tenorite, { siteIndex: 1, absorber: "Cu", radius: 2 })
    expect(cluster.atoms.map(atom => atom.element)).toEqual(["Cu", "O", "O", "O", "O"])
    // Independent reference: pymatgen get_sites_in_sphere for AMCSD 11639.
    expect(cluster.atoms[1].distance).toBeCloseTo(1.94723910, 7)
    expect(cluster.atoms[2].distance).toBeCloseTo(1.94723910, 7)
    expect(cluster.atoms[3].distance).toBeCloseTo(1.94772361, 7)
    expect(cluster.atoms[4].distance).toBeCloseTo(1.94772361, 7)
    expect(buildCifGeometry(tenorite, { radius: 3.5 }).atoms).toHaveLength(21)
  })

  it("centers the chosen site without changing the source attachment", () => {
    const before = JSON.stringify(tenorite)
    const geometry = buildCifGeometry(tenorite, { siteIndex: 2, absorber: "O", radius: 2 })
    expect(geometry.atoms[0]).toMatchObject({ element: "O", siteIndex: 2, distance: 0, isAbsorber: true })
    expect(geometry.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
    expect(JSON.stringify(tenorite)).toBe(before)
    expect(buildCifGeometry(tenorite, { siteIndex: 2, absorber: "Cu" }).warnings[0]).toContain("not available")
  })

  it("uses reciprocal bounds to include neighbors across skewed periodic cells", () => {
    const skewed = structure({
      cif: "data_skewed", cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 10 },
      sites: [{ ...structure().sites[0], multiplicity: 1 }],
    })
    const cluster = buildCifGeometry(skewed, { radius: 2 })
    expect(cluster.warnings).toEqual([])
    expect(cluster.atoms).toHaveLength(3)
    expect(cluster.atoms[1].distance).toBeCloseTo(20 * Math.sin(5 * Math.PI / 180), 8)
  })

  it("accepts legacy symmetry tags, comments, and quoted expressions with spaces", () => {
    const legacy = structure({ cif: `data_legacy
loop_
_symmetry_equiv_pos_site_id
_symmetry_equiv_pos_as_xyz
1 'x, y, z' # identity
2 'x, y + 1/2, z + 1/2'
3 'x + 1/2, y, z + 1/2'
4 'x + 1/2, y + 1/2, z'
` })
    expect(buildCifGeometry(legacy, { mode: "cell" }).atoms).toHaveLength(4)
  })

  it("refuses to silently draw only asymmetric sites when symmetry is missing", () => {
    const result = buildCifGeometry(structure({ cif: "data_incomplete" }))
    expect(result.atoms).toEqual([])
    expect(result.warnings[0]).toContain("complete unit cell")
  })

  it.each(["'x,y,globalThis.alert(1)'", "'x,y,1/0+z'", "'x,y,z' 2", "'x,y,x'"])("rejects malformed symmetry %s without execution", operation => {
    const result = buildCifGeometry(structure({ cif: `data_bad\nloop_\n_space_group_symop_id\n_space_group_symop_operation_xyz\n1 ${operation}` }))
    expect(result.atoms).toEqual([])
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it.each([
    { a: 0 }, { beta: 180 }, { gamma: 0 }, { a: Number.NaN }, { c: Number.POSITIVE_INFINITY },
    { alpha: 10, beta: 10, gamma: 170 },
  ])("rejects impossible or non-finite cell values %j", overrides => {
    const result = buildCifGeometry(structure({ cell: { ...structure().cell, ...overrides } }))
    expect(result.lattice).toBeNull()
    expect(result.atoms).toEqual([])
    expect(result.warnings[0]).toContain("valid, non-degenerate")
  })

  it("bounds radius, emitted atoms, and periodic work, and marks truncation", () => {
    expect(buildCifGeometry(structure(), { radius: Number.NaN }).radius).toBe(CIF_VIEWER_DEFAULT_RADIUS)
    expect(buildCifGeometry(structure(), { radius: 1000 }).radius).toBe(CIF_VIEWER_MAX_RADIUS)
    const truncated = buildCifGeometry(structure(), { radius: 10, maxAtoms: 10 })
    expect(truncated.atoms).toHaveLength(10)
    expect(truncated.truncated).toBe(true)
    expect(truncated.atoms[0].isAbsorber).toBe(true)
    expect(truncated.warnings[0]).toContain("limited")
    const tinyCell = buildCifGeometry(structure({ cell: { ...structure().cell, a: .01, b: .01, c: .01 } }), { radius: 10 })
    expect(tinyCell.atoms).toEqual([])
    expect(tinyCell.warnings[0]).toContain("Too many periodic images")
  })

  it("keeps partial occupancy explicit without synthesizing substitutions", () => {
    const geometry = buildCifGeometry(structure({ sites: [{ ...structure().sites[0], occupancy: .5 }] }), { mode: "cell" })
    expect(geometry.atoms).toHaveLength(4)
    expect(geometry.atoms.every(atom => atom.occupancy === .5)).toBe(true)
    expect(geometry.warnings[0]).toContain("Partially occupied")
  })
})
