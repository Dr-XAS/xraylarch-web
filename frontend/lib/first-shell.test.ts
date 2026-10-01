import { describe, expect, it } from "vitest"
import { firstShellAtoms, isFirstShellPath, isShellAtom, type FirstShell } from "./first-shell"
import type { ArtemisStructure } from "./artemis-structures"
import type { ArtemisPathMetadata } from "./artemis"

const structure = { cif: "data_test", cell: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 60 } } as ArtemisStructure
const shell: FirstShell = { method: "CrystalNN", pymatgen_version: "test", cif: "data_test", cif_sha256: "a".repeat(64), absorber: "Cu", site_index: 1,
  coordination_number: 2, coordination_weight: 0.9, alternatives: [{ coordination_number: 2, weight: 0.9 }], warnings: [],
  neighbors: [-0.5, 0.5].map(y => ({ element: "O", structure_index: 2, image: [0, y < 0 ? -1 : 0, 0], fractional_offset: [0, y, 0], cartesian_offset: [2 * y, 2 * y * Math.sqrt(3), 0], distance: 2, weight: 1 })) }
function metadata(): ArtemisPathMetadata {
  return { absorber: "Cu", edge: "K", reff: 2, degen: 2, nleg: 2, kmin: 0, kmax: 20,
    geometry: [{ atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }, { atom: "O", x: 1, y: Math.sqrt(3), z: 0, ipot: 1 }] }
}
describe("CrystalNN first-shell mapping", () => {
  it("maps signed periodic offsets into the viewer's oblique cell basis", () => {
    const atoms = firstShellAtoms(structure, shell)
    expect(atoms).toHaveLength(2)
    expect(atoms[0].x).toBeCloseTo(-1)
    expect(atoms[0].y).toBeCloseTo(-Math.sqrt(3))
    expect(atoms[1].y).toBeCloseTo(Math.sqrt(3))
    expect(isShellAtom({ element: "O", x: 1, y: Math.sqrt(3), z: 0 }, atoms)).toBe(true)
    expect(isShellAtom({ element: "O", x: 3, y: 3 * Math.sqrt(3), z: 0 }, atoms)).toBe(false)
  })
  it("requires single scattering, correct element and position, not Reff alone", () => {
    expect(isFirstShellPath(metadata(), structure, shell)).toBe(true)
    expect(isFirstShellPath({ ...metadata(), nleg: 3 }, structure, shell)).toBe(false)
    expect(isFirstShellPath({ ...metadata(), absorber: "Fe" }, structure, shell)).toBe(false)
    const wrongElement = metadata(); wrongElement.geometry[1].atom = "Cu"
    expect(isFirstShellPath(wrongElement, structure, shell)).toBe(false)
    const wrongDirection = metadata(); wrongDirection.geometry[1] = { atom: "O", x: 2, y: 0, z: 0, ipot: 1 }
    expect(isFirstShellPath(wrongDirection, structure, shell)).toBe(false)
    expect(isFirstShellPath({ ...metadata(), geometry: [] }, structure, shell)).toBe(false)
  })
  it("accepts FEFF rounding but rejects inconsistent effective distance", () => {
    const rounded = metadata(); rounded.geometry[1].y = 1.73205
    expect(isFirstShellPath(rounded, structure, shell)).toBe(true)
    expect(isFirstShellPath({ ...rounded, reff: 4 }, structure, shell)).toBe(false)
  })
  it("uses the native FEFF frame for a monoclinic cell and the conventional frame for rendering", () => {
    const monoclinic = { ...structure, cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 110, gamma: 90 } }
    const native: [number, number, number] = [1.87938524, 0, -0.68404029]
    const prediction: FirstShell = { ...shell, coordination_number: 1, neighbors: [{ ...shell.neighbors[0], fractional_offset: [0.2, 0, 0], cartesian_offset: native }] }
    const rendered = firstShellAtoms(monoclinic, prediction)[0]
    expect(rendered.x).toBeCloseTo(2)
    expect(rendered.z).toBeCloseTo(0)
    const path = metadata()
    path.geometry[1] = { atom: "O", x: native[0], y: native[1], z: native[2], ipot: 1 }
    expect(isFirstShellPath(path, monoclinic, prediction)).toBe(true)
    path.geometry[1] = { atom: "O", x: 2, y: 0, z: 0, ipot: 1 }
    expect(isFirstShellPath(path, monoclinic, prediction)).toBe(false)
    expect(isFirstShellPath(path, { ...monoclinic, cif: "data_different" }, prediction)).toBe(false)
  })
})
