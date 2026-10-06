import { describe, expect, it } from "vitest"
import type { ArtemisStructure } from "./artemis-structures"
import { buildCifGeometry, type CifVector } from "./cif-viewer"

// Synthetic hexagonal cells only. The representative coordinates were checked
// with snapshot_details(CifWriter(Structure(...), symprec=None)): pymatgen
// rationalizes coordinates near thirds while the saved P1 CIF retains its rows.
const lattice = { a: 2.56, b: 2.56, c: 4.18, alpha: 90, beta: 90, gamma: 120 }
const copperSite = { index: 1, element: "Cu", species: "Cu", occupancy: 1, multiplicity: 2, wyckoff: "2c", x: 1 / 3, y: 2 / 3, z: .25 }
type Row = { element: string; frac: CifVector }

function makeStructure(rows: Row[], sites = [copperSite]): ArtemisStructure {
  return {
    id: "synthetic-rounded-hcp", provider: "materials_project", mineral: "Synthetic hexagonal cell",
    formula: "Cu", space_group: "P6_3/mmc", authors: "", year: null, journal: "", title: "Synthetic geometry",
    ordered: true, supported: true, warnings: [], elements: [...new Set(rows.map(row => row.element))],
    cell: lattice, sites,
    cif: `data_synthetic_hexagonal
_symmetry_space_group_name_H-M 'P 1'
_symmetry_equiv_pos_as_xyz 'x,y,z'
loop_
_atom_site_type_symbol
_atom_site_label
_atom_site_symmetry_multiplicity
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
${rows.map((row, index) => `${row.element} ${row.element}${index} 1 ${row.frac.join(" ")} 1`).join("\n")}
`,
  }
}

function copperRows(delta = 1e-5): Row[] {
  const a = Number((1 / 3 + delta).toFixed(8))
  const b = Number((2 / 3 - delta).toFixed(8))
  return [{ element: "Cu", frac: [a, b, .25] }, { element: "Cu", frac: [b, a, .75] }]
}

// Independent analytic basis for this hexagonal cell, rather than the viewer's
// generic fractional-to-Cartesian function.
function position([x, y, z]: CifVector): CifVector {
  return [lattice.a * (x - y / 2), lattice.a * Math.sqrt(3) * y / 2, lattice.c * z]
}

function expectCoordinates(actual: number[], expected: number[]) {
  expected.forEach((value, axis) => expect(actual[axis]).toBeCloseTo(value, 10))
}

describe("P1 CIF coordinates rationalized in backend metadata", () => {
  it.each([1e-5, -1e-5, 3e-5, -3e-5])("preserves full-cell positions and the actual absorber row for delta %s", delta => {
    const rows = copperRows(delta)
    const source = makeStructure(rows)
    const before = JSON.stringify(source)
    const cell = buildCifGeometry(source, { mode: "cell" })
    expect(cell.warnings).toEqual([])
    expect(cell.atoms).toHaveLength(2)
    expectCoordinates(cell.center, position(rows[0].frac))
    for (const [index, row] of rows.entries()) {
      const atom = cell.atoms.find(atom => atom.label === `Cu${index}`)!
      expect(atom).toBeDefined()
      expectCoordinates([atom.x, atom.y, atom.z].map((value, axis) => value + cell.center[axis]), position(row.frac))
    }
    const cluster = buildCifGeometry(source, { radius: 3 })
    expect(cluster.warnings).toEqual([])
    expect(cluster.atoms).toHaveLength(13)
    expect(cluster.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
    expect(cluster.atoms[0]).toMatchObject({ label: "Cu0", siteIndex: 1, x: 0, y: 0, z: 0, distance: 0, isAbsorber: true })
    expect(JSON.stringify(source)).toBe(before)
  })

  it.each([1, 2])("keeps the selected crystallographic site %s centered in a two-orbit cell", siteIndex => {
    const rows: Row[] = [...copperRows(), { element: "Zn", frac: [0, 0, 0] }, { element: "Zn", frac: [0, 0, .5] }]
    const source = makeStructure(rows, [
      { ...copperSite, index: 1, element: "Zn", species: "Zn", wyckoff: "2a", x: 0, y: 0, z: 0 },
      { ...copperSite, index: 2 },
    ])
    const expectedRow = rows[siteIndex === 1 ? 2 : 0]
    const cell = buildCifGeometry(source, { mode: "cell", siteIndex })
    expect(cell.warnings).toEqual([])
    expect(cell.atoms).toHaveLength(4)
    expectCoordinates(cell.center, position(expectedRow.frac))
    expect(cell.atoms.filter(atom => atom.isAbsorber)).toHaveLength(1)
    expect(cell.atoms[0]).toMatchObject({ element: expectedRow.element, siteIndex, distance: 0, isAbsorber: true })
    expect(cell.atoms.filter(atom => atom.element === "Cu").every(atom => atom.siteIndex === 2)).toBe(true)
    expect(cell.atoms.filter(atom => atom.element === "Zn").every(atom => atom.siteIndex === 1)).toBe(true)
  })

  it("uses the larger relative rounding interval around two thirds", () => {
    const rows = copperRows()
    rows[0].frac[1] = 2 / 3 + 5e-5
    const cell = buildCifGeometry(makeStructure(rows), { mode: "cell" })
    expect(cell.warnings).toEqual([])
    expect(cell.atoms).toHaveLength(2)
    expectCoordinates(cell.center, position(rows[0].frac))
  })

  it.each([
    { name: "arbitrary non-third coordinate", x: 1 / 3, y: 2 / 3, z: .25002 },
    { name: "outside the one-third rounding interval", x: 1 / 3 + 4e-5, y: 2 / 3, z: .25 },
    { name: "one third only after periodic wrapping", x: 1 + 1 / 3 + 1e-5, y: 2 / 3, z: .25 },
    { name: "two thirds only after periodic wrapping", x: 1 / 3, y: -1 / 3 - 1e-5, z: .25 },
  ])("rejects a representative mismatch at $name", ({ x, y, z }) => {
    const rows = copperRows()
    rows[0].frac = [x, y, z]
    const geometry = buildCifGeometry(makeStructure(rows))
    expect(geometry.atoms).toEqual([])
    expect(geometry.warnings.length).toBeGreaterThan(0)
  })

  it("does not round an inconsistent backend representative to force a match", () => {
    const source = makeStructure(copperRows(), [{ ...copperSite, x: 1 / 3 + 2e-5 }])
    const geometry = buildCifGeometry(source)
    expect(geometry.atoms).toEqual([])
    expect(geometry.warnings.length).toBeGreaterThan(0)
  })

  it.each(["incomplete", "duplicate"])("still refuses an %s P1 cell", kind => {
    const rows = copperRows()
    if (kind === "incomplete") rows.pop()
    else rows[1] = { element: "Cu", frac: [...rows[0].frac] }
    const geometry = buildCifGeometry(makeStructure(rows))
    expect(geometry.atoms).toEqual([])
    expect(geometry.warnings.length).toBeGreaterThan(0)
  })
})
