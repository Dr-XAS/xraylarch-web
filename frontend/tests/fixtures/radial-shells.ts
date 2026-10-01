import type { ArtemisStructure } from "@/lib/artemis-structures"
import type { ArtemisPathMetadata } from "@/lib/artemis"
import type { RadialShells } from "@/lib/radial-shells"

export const radialStructure: ArtemisStructure = {
  id: 1, cif: "data_radial_fixture", mineral: "Test crystal", formula: "CuO", space_group: "P1", authors: "", year: null, journal: "", title: "",
  elements: ["Cu", "O"], supported: true, ordered: true, warnings: [], cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 },
  sites: [
    { index: 1, element: "Cu", species: "Cu", occupancy: 1, multiplicity: 1, wyckoff: "1a", x: 0, y: 0, z: 0 },
    { index: 2, element: "O", species: "O", occupancy: 1, multiplicity: 1, wyckoff: "1a", x: 0.2, y: 0, z: 0 },
  ],
}
export const radialFixture: RadialShells = {
  method: "complete_linkage", cif: radialStructure.cif, cif_sha256: "a".repeat(64), absorber: "Cu", site_index: 1,
  radius: 6, tolerance: 0.05, symmetry_tolerance: 1e-5, warnings: [],
  neighbors: [-2, 2, -3, 3].map((x, i) => ({ id: i, element: i < 2 ? "O" : "Cu", structure_index: i + 1, image: [x < 0 ? -1 : 0, 0, 0],
    fractional_offset: [x / 10, 0, 0], cartesian_offset: [x, 0, 0], distance: Math.abs(x), shell_index: i < 2 ? 1 : 2, group_id: i < 2 ? "1.1" : "2.1" })),
  shells: [1, 2].map((index) => ({ index, r_min: index + 1, r_max: index + 1, r_mean: index + 1, coordination_number: 2,
    elements: { [index === 1 ? "O" : "Cu"]: 2 }, neighbor_ids: index === 1 ? [0, 1] : [2, 3],
    groups: [{ id: `${index}.1`, element: index === 1 ? "O" : "Cu", coordination_number: 2, r_min: index + 1, r_max: index + 1, neighbor_ids: index === 1 ? [0, 1] : [2, 3] }],
  })),
}
export function radialMetadata(shell = 1): ArtemisPathMetadata {
  return { absorber: "Cu", edge: "K", reff: shell + 1, degen: 2, nleg: 2, kmin: 0, kmax: 20,
    geometry: [{ atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }, { atom: shell === 1 ? "O" : "Cu", x: shell + 1, y: 0, z: 0, ipot: 1 }] }
}
