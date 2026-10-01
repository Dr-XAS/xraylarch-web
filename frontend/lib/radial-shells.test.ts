import { expect, it } from "vitest"
import { groupRadialPaths, radialPathNeighbor, radialShellAtoms } from "./radial-shells"
import { radialFixture as data, radialStructure as structure, radialMetadata } from "@/tests/fixtures/radial-shells"

it("groups real SS geometry, keeps MS and unmatched paths separate, and retains degeneracies", () => {
  const paths = [1, 2].map(index => ({ id: String(index), metadata: radialMetadata(index) }))
  paths.push({ id: "ms", metadata: { ...radialMetadata(), nleg: 3 } })
  paths.push({ id: "unknown", metadata: { ...radialMetadata(), geometry: [] } })
  const before = JSON.stringify(paths)
  const groups = groupRadialPaths(paths, structure, data)
  expect(groups.map(group => [group.key, group.paths.map(path => path.id)])).toEqual([["1", ["1"]], ["2", ["2"]], ["multiple", ["ms"]], ["unmatched", ["unknown"]]])
  expect(JSON.stringify(paths)).toBe(before)
  expect(radialPathNeighbor({ ...radialMetadata(), reff: 4 }, structure, data)).toBeUndefined()
  expect(radialPathNeighbor(radialMetadata(), { ...structure, cif: "different" }, data)).toBeUndefined()
  expect(radialPathNeighbor({ ...radialMetadata(), geometry: [{ atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }, { atom: "O", x: 0, y: 2, z: 0, ipot: 1 }] }, structure, data)).toBeUndefined()
})
it("uses fractional offsets for the viewer and native offsets for oblique FEFF paths", () => {
  const oblique = { ...structure, cell: { ...structure.cell, beta: 110 } }
  const native: [number, number, number] = [1.87938524, 0, -0.68404029]
  const analysis = { ...data, neighbors: [{ ...data.neighbors[1], cartesian_offset: native }] }
  const atom = radialShellAtoms(oblique, analysis)[0]
  expect(atom.x).toBeCloseTo(2); expect(atom.z).toBeCloseTo(0)
  const path = radialMetadata()
  path.geometry[1] = { atom: "O", x: native[0], y: native[1], z: native[2], ipot: 1 }
  expect(radialPathNeighbor(path, oblique, analysis)?.shell_index).toBe(1)
  expect(radialPathNeighbor(radialMetadata(), oblique, analysis)).toBeUndefined()
})
