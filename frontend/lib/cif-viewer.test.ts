import { describe, expect, it } from "vitest"
import type { ArtemisStructure } from "./artemis-structures"
import { buildCifGeometry, cartesian, CIF_VIEWER_DEFAULT_RADIUS, CIF_VIEWER_MAX_CELL_REPEATS, CIF_VIEWER_MAX_RADIUS, type CifVector } from "./cif-viewer"
import fccP1 from "./fixtures/cif-p1-fcc-cu.json"
import perturbedP1 from "./fixtures/cif-p1-perturbed-cu-cr-p-s.json"

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

const p1Copper = structure({
  cif: `data_explicit_copper
_symmetry_equiv_pos_as_xyz 'x,y,z'
loop_
_atom_site_type_symbol
_atom_site_label
_atom_site_symmetry_multiplicity
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Cu Cu0 1 0 0 0 1
Cu Cu1 1 0 .5 .5 1
Cu Cu2 1 .5 0 .5 1
Cu Cu3 1 .5 .5 0 1
`,
})

describe("CIF viewer geometry", () => {
  it.each([fccP1, perturbedP1])("matches independent periodic geometry for $structure.mineral", fixture => {
    const source = fixture.structure as ArtemisStructure
    const before = JSON.stringify(source)
    const cell = buildCifGeometry(source, { mode: "cell" })
    expect(cell.warnings).toEqual([])
    expect(cell.atoms).toHaveLength(fixture.expected.cellAtomCount)
    const positionKey = (element: string, coordinates: number[]) => `${element}:${coordinates.map(value => value.toFixed(6)).join(",")}`
    const actual = cell.atoms.map(atom => positionKey(atom.element, [atom.x, atom.y, atom.z].map((value, i) => value + cell.center[i]))).sort()
    const expected = fixture.expected.cellAtoms.map(atom => positionKey(atom.element, cartesian(atom.fractional as CifVector, cell.lattice!))).sort()
    expect(actual).toEqual(expected)
    for (const reference of fixture.expected.clusters) {
      const cluster = buildCifGeometry(source, reference)
      expect(cluster.warnings).toEqual([])
      expect(cluster.atoms).toHaveLength(reference.atoms.length)
      expect(cluster.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
      for (const expectedAtom of reference.atoms) {
        expect(cluster.atoms.some(atom => atom.element === expectedAtom.element && Math.hypot(atom.x - expectedAtom.cartesianOffset[0], atom.y - expectedAtom.cartesianOffset[1], atom.z - expectedAtom.cartesianOffset[2]) < 1e-7)).toBe(true)
      }
    }
    expect(JSON.stringify(source)).toBe(before)
  })

  it("retains CIF labels for explicit rows whose crystallographic orbit is unknown", () => {
    const cell = buildCifGeometry(perturbedP1.structure as ArtemisStructure, { mode: "cell" })
    const unknown = cell.atoms.filter(atom => atom.siteIndex < 0)
    expect(unknown.length).toBeGreaterThan(0)
    expect(unknown.every(atom => /^[PS]\d+$/.test(atom.label))).toBe(true)
  })

  it("anchors the absorber to the explicit row when representative coordinates round differently", () => {
    // pymatgen rationalizes .333333 to 1/3 in the representative metadata.
    const source = structure({
      cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 },
      sites: [{ ...p1Copper.sites[0], x: 1 / 3, multiplicity: 2 }],
      cif: p1Copper.cif.slice(0, p1Copper.cif.indexOf("Cu Cu0")) + "Cu Cu0 1 .333333 0 0 1\nCu Cu1 1 .833333 0 0 1\n",
    })
    const geometry = buildCifGeometry(source)
    expect(geometry.warnings).toEqual([])
    expect(geometry.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
    expect(geometry.atoms[0].distance).toBe(0)
    expect(geometry.center[0]).toBeCloseTo(.333333 * 10, 10)
  })

  it("renders complete explicit P1 cells with backend-inferred higher symmetry", () => {
    const before = JSON.stringify(p1Copper)
    const cell = buildCifGeometry(p1Copper, { mode: "cell" })
    expect(cell.warnings).toEqual([])
    expect(cell.atoms).toHaveLength(4)
    expect(cell.atoms.map(atom => atom.siteIndex)).toEqual([1, 1, 1, 1])
    expect(buildCifGeometry(p1Copper, { mode: "cell", cellRepeats: [2, 3, 1] }).atoms).toHaveLength(24)
    const cluster = buildCifGeometry(p1Copper, { radius: 3 })
    expect(cluster.atoms).toHaveLength(13)
    expect(cluster.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
    for (const atom of cluster.atoms.slice(1)) expect(atom.distance).toBeCloseTo(3.63 / Math.sqrt(2), 8)
    expect(JSON.stringify(p1Copper)).toBe(before)
  })

  it("accepts CIF real uncertainties and periodic coordinates in explicit cells", () => {
    const source = { ...p1Copper, cif: p1Copper.cif.replace("Cu Cu1 1 0 .5 .5 1", "Cu Cu1 1 1.0(2) 5.0(1)e-1 -.5 1") }
    expect(buildCifGeometry(source).atoms).toEqual(buildCifGeometry(p1Copper).atoms)
  })

  it.each([
    (cif: string) => cif.replace("Cu Cu3 1 .5 .5 0 1", ""),
    (cif: string) => cif.replace("Cu Cu3 1 .5 .5 0 1", "O O3 1 .5 .5 0 1"),
    (cif: string) => cif.replace("Cu Cu3 1 .5 .5 0 1", "Cu Cu3 1 0 .5 .5 1"),
    (cif: string) => cif.replace("Cu Cu0 1 0 0 0 1", "Cu Cu0 1 .1 0 0 1"),
    (cif: string) => cif.replace("Cu Cu3 1 .5 .5 0 1", "Cu Cu3 1 .5 .5 0 .5"),
    (cif: string) => cif.replace("Cu Cu3 1 .5 .5 0 1", "Cu Cu3 2 .5 .5 0 1"),
    (cif: string) => cif.replace("Cu Cu3 1 .5 .5 0 1", "Cu Cu3 1 .5 .5 ? 1"),
    (cif: string) => cif.replace("Cu Cu3 1 .5 .5 0 1", "Cu Cu3 1 .5 .5 0"),
    (cif: string) => cif + "data_second\n_atom_site_label Cu\n",
    (cif: string) => cif.replace("'x,y,z'", "'-x,-y,-z'"),
  ])("refuses an incomplete or inconsistent explicit cell %#", change => {
    const geometry = buildCifGeometry({ ...p1Copper, cif: change(p1Copper.cif) })
    expect(geometry.atoms).toEqual([])
    expect(geometry.warnings.length).toBeGreaterThan(0)
  })

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

  it("repeats the complete symmetry-expanded basis independently along a, b, and c", () => {
    const source = structure()
    const before = JSON.stringify(source)
    const cell = buildCifGeometry(source, { mode: "cell", cellRepeats: [2, 3, 1], radius: 1 })
    expect(cell.warnings).toEqual([])
    expect(cell.atoms).toHaveLength(24)
    expect(cell.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
    expect(cell.atoms.every(atom => atom.element === "Cu" && atom.siteIndex === 1)).toBe(true)
    expect(Math.max(...cell.atoms.map(atom => atom.x))).toBeCloseTo(1.5 * 3.63, 8)
    expect(Math.max(...cell.atoms.map(atom => atom.y))).toBeCloseTo(2.5 * 3.63, 8)
    expect(Math.max(...cell.atoms.map(atom => atom.z))).toBeCloseTo(.5 * 3.63, 8)
    const fractionalPositions = new Set(cell.atoms.map(atom => [atom.x, atom.y, atom.z].map(value => Math.round(value / 3.63 * 2)).join(",")))
    expect(fractionalPositions.size).toBe(24)
    // The farthest cell contains all four FCC basis positions, despite radius=1.
    for (const position of ["2,4,0", "2,5,1", "3,4,1", "3,5,0"]) expect(fractionalPositions.has(position)).toBe(true)
    expect(JSON.stringify(source)).toBe(before)
  })

  it("translates repeated monoclinic cells along their oblique lattice vectors", () => {
    const base = buildCifGeometry(tenorite, { mode: "cell", siteIndex: 2, absorber: "O" })
    const expanded = buildCifGeometry(tenorite, { mode: "cell", cellRepeats: [2, 1, 3], siteIndex: 2, absorber: "O" })
    const positionKey = (position: number[]) => position.map(value => Math.round(value * 1e6)).join(",")
    const actualPositions = new Set(expanded.atoms.map(atom => `${atom.element}:${positionKey([atom.x, atom.y, atom.z])}`))
    const beta = 99.48 * Math.PI / 180
    expect(expanded.warnings).toEqual([])
    expect(expanded.atoms).toHaveLength(48)
    expect(expanded.atoms.filter(atom => atom.element === "Cu")).toHaveLength(24)
    expect(expanded.atoms.filter(atom => atom.element === "O")).toHaveLength(24)
    expect(expanded.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
    expect(expanded.center).toEqual(base.center)
    for (let a = 0; a < 2; a++) for (let c = 0; c < 3; c++) {
      for (const atom of base.atoms) {
        const expected = [atom.x + 4.653 * a + 5.108 * Math.cos(beta) * c, atom.y, atom.z + 5.108 * Math.sin(beta) * c]
        expect(actualPositions.has(`${atom.element}:${positionKey(expected)}`)).toBe(true)
      }
    }
    const edgeVectors = expanded.cellEdges.map(([start, end]) => end.map((value, axis) => value - start[axis]))
    const cEdges = edgeVectors.filter(vector => vector[2] > 1)
    expect(cEdges).toHaveLength(18)
    for (const edge of cEdges) {
      expect(edge[0]).toBeCloseTo(5.108 * Math.cos(beta), 8)
      expect(edge[2]).toBeCloseTo(5.108 * Math.sin(beta), 8)
    }
  })

  it("outlines every constituent cell without duplicate shared edges", () => {
    const cell = buildCifGeometry(structure(), { mode: "cell", cellRepeats: [2, 2, 1] })
    const edgeKeys = cell.cellEdges.map(edge => edge.map(vertex => vertex.map(value => Math.round(value / 3.63)).join(",")).sort().join(";"))
    // a edges: 2*3*2, b edges: 3*2*2, c edges: 3*3*1.
    expect(cell.cellEdges).toHaveLength(33)
    expect(new Set(edgeKeys).size).toBe(33)
    expect(edgeKeys).toContain("1,1,0;1,1,1")
    expect(edgeKeys).toContain("2,2,0;2,2,1")
  })

  it.each([
    { repeats: [2.9, -2, Number.POSITIVE_INFINITY], expectedAtoms: 8 },
    { repeats: [100, Number.NaN, 0], expectedAtoms: 4 * CIF_VIEWER_MAX_CELL_REPEATS },
  ])("bounds and normalizes cell repeat counts: $repeats", ({ repeats, expectedAtoms }) => {
    const geometry = buildCifGeometry(structure(), { mode: "cell", cellRepeats: repeats as CifVector })
    expect(geometry.warnings).toEqual([])
    expect(geometry.atoms).toHaveLength(expectedAtoms)
  })

  it("refuses incomplete cells when repeats exceed the atom limit", () => {
    const allowed = buildCifGeometry(structure(), { mode: "cell", cellRepeats: [2, 3, 1], maxAtoms: 24 })
    expect(allowed.atoms).toHaveLength(24)
    expect(allowed.truncated).toBe(false)
    const rejected = buildCifGeometry(structure(), { mode: "cell", cellRepeats: [2, 3, 1], maxAtoms: 23 })
    expect(rejected.atoms).toEqual([])
    expect(rejected.cellEdges).toEqual([])
    expect(rejected.truncated).toBe(true)
    expect(rejected.warnings[0]).toContain("24 atoms")
    expect(rejected.warnings[0]).toContain("limit of 23")
    expect(rejected.warnings[0]).toContain("Reduce the unit-cell repeats")
    const single = buildCifGeometry(structure(), { mode: "cell", maxAtoms: 3 })
    expect(single.atoms).toEqual([])
    expect(single.warnings[0]).toContain("A complete unit cell cannot be shown")
  })

  it("ignores unit-cell repeats in radius-based cluster mode", () => {
    expect(buildCifGeometry(tenorite, { radius: 3.5, cellRepeats: [6, 2, 3] }))
      .toEqual(buildCifGeometry(tenorite, { radius: 3.5 }))
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
