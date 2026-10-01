import { describe, expect, it } from "vitest"
import type { CifViewerAtom } from "./cif-viewer"
import {
  calculateClusterCoordination,
  CLUSTER_COORDINATION_MAX_ATOMS,
  type ClusterCoordinationResult,
} from "./cluster-coordination"

function atom(element: string, x: number, y = 0, z = 0, isAbsorber = false): CifViewerAtom {
  return { element, x, y, z, isAbsorber, label: element, siteIndex: 1, occupancy: 1, distance: Math.hypot(x, y, z) }
}

function pair(result: ClusterCoordinationResult, centerElement: string, neighborElement = centerElement) {
  const value = result.pairs.find(candidate => candidate.centerElement === centerElement && candidate.neighborElement === neighborElement)
  expect(value).toBeDefined()
  return value!
}

describe("finite-cluster coordination", () => {
  it("counts both directions of same-element contacts and preserves surface atoms", () => {
    const result = calculateClusterCoordination([
      atom("Cu", 0), atom("Cu", 1, 0, 0, true), atom("Cu", 2),
    ], { bondRange: 1.5 })
    expect(result).toMatchObject({ atomCount: 3, elementCounts: { Cu: 3 }, bondRange: 1.5, tolerance: 0.01 })
    expect(pair(result, "Cu").shells).toEqual([{
      index: 1, distance: 1, minDistance: 1, maxDistance: 1,
      averageCN: 4 / 3, centerCN: 2,
      countsByAtom: [1, 2, 1], distribution: [{ cn: 1, count: 2 }, { cn: 2, count: 1 }],
    }])
  })

  it("groups all six directed contacts of an equilateral triangle", () => {
    const result = calculateClusterCoordination([atom("Cu", 0), atom("Cu", 1), atom("Cu", 0.5, Math.sqrt(3) / 2)])
    const shells = pair(result, "Cu").shells
    expect(shells).toHaveLength(1)
    expect(shells[0].distance).toBeCloseTo(1, 14)
    expect(shells[0]).toMatchObject({ averageCN: 2, centerCN: null, countsByAtom: [2, 2, 2], distribution: [{ cn: 2, count: 3 }] })
  })

  it("uses all central-element atoms as the denominator, including zero-neighbor atoms", () => {
    const atoms = [atom("Cu", 0, 0, 0, true), atom("O", 1), atom("Cu", 10), atom("O", -1)]
    const before = JSON.stringify(atoms)
    const result = calculateClusterCoordination(atoms, { bondRange: 1.5 })
    expect(result.pairs.map(value => `${value.centerElement}-${value.neighborElement}`)).toEqual(["Cu-Cu", "Cu-O", "O-Cu", "O-O"])
    expect(pair(result, "Cu").shells).toEqual([])
    expect(pair(result, "O").shells).toEqual([])
    expect(pair(result, "Cu", "O")).toMatchObject({ centerCount: 2, shells: [{
      averageCN: 1, centerCN: 2, countsByAtom: [2, 0], distribution: [{ cn: 0, count: 1 }, { cn: 2, count: 1 }],
    }] })
    expect(pair(result, "O", "Cu")).toMatchObject({ centerCount: 2, shells: [{
      averageCN: 1, centerCN: null, countsByAtom: [1, 1], distribution: [{ cn: 1, count: 2 }],
    }] })
    expect(JSON.stringify(atoms)).toBe(before)
  })

  it("distinguishes asymmetric ordered pairs and keeps shell numbers aligned", () => {
    const result = calculateClusterCoordination([atom("Cu", 0), atom("O", 1), atom("O", -1), atom("O", 2)])
    expect(pair(result, "Cu", "O").shells.map(shell => [shell.index, shell.averageCN])).toEqual([[1, 2], [2, 1]])
    expect(pair(result, "O", "Cu").shells.map(shell => [shell.index, shell.averageCN])).toEqual([[1, 2 / 3], [2, 1 / 3]])
  })

  it("reports central CN 12 and finite average 72/13 for a 13-atom FCC Cu cluster", () => {
    const halfCell = 3.63 / 2
    const atoms = [atom("Cu", 0, 0, 0, true)]
    // FCC nearest neighbors are all permutations of (0, ±a/2, ±a/2).
    for (let zeroAxis = 0; zeroAxis < 3; zeroAxis++) for (const first of [-1, 1]) for (const second of [-1, 1]) {
      const coordinates = [first * halfCell, second * halfCell]
      coordinates.splice(zeroAxis, 0, 0)
      atoms.push(atom("Cu", coordinates[0], coordinates[1], coordinates[2]))
    }
    const result = calculateClusterCoordination(atoms, { bondRange: 3 })
    const shells = pair(result, "Cu").shells
    expect(shells).toHaveLength(1)
    expect(shells[0].distance).toBeCloseTo(3.63 / Math.sqrt(2), 12)
    expect(shells[0]).toMatchObject({
      centerCN: 12, averageCN: 72 / 13,
      countsByAtom: [12, ...Array(12).fill(5)],
      distribution: [{ cn: 5, count: 12 }, { cn: 12, count: 1 }],
    })
  })

  it("excludes contacts exactly at the default 5 angstrom cutoff", () => {
    const result = calculateClusterCoordination([atom("Cu", 0), atom("O", 5), atom("O", -4.99)])
    expect(result.bondRange).toBe(5)
    expect(pair(result, "Cu", "O").shells).toHaveLength(1)
    expect(pair(result, "Cu", "O").shells[0]).toMatchObject({ distance: 4.99, averageCN: 1 })
    expect(pair(result, "O", "Cu").shells[0]).toMatchObject({ averageCN: 0.5, countsByAtom: [0, 1] })
  })

  it("starts a new shell only when the adjacent gap is strictly larger than tolerance", () => {
    const atoms = [atom("Cu", 0), ...[1, 1.125, 1.25, 1.5].map(x => atom("O", x))]
    const shells = pair(calculateClusterCoordination(atoms, { tolerance: 0.125 }), "Cu", "O").shells
    expect(shells.map(shell => [shell.index, shell.distance, shell.averageCN])).toEqual([[1, 1.125, 3], [2, 1.5, 1]])
    expect(shells[0]).toMatchObject({ minDistance: 1, maxDistance: 1.25 })
  })

  it("counts chained shell membership consistently even when its width exceeds tolerance", () => {
    const atoms = [atom("Cu", 0, 0, 0, true), ...[1, 1.09, 1.18, 1.27].map(x => atom("O", x))]
    const result = calculateClusterCoordination(atoms, { tolerance: 0.1 })
    const shells = pair(result, "Cu", "O").shells
    expect(shells).toHaveLength(1)
    expect(shells[0].distance).toBeCloseTo(1.135, 14)
    expect(shells[0]).toMatchObject({ minDistance: 1, maxDistance: 1.27, averageCN: 4, centerCN: 4, countsByAtom: [4], distribution: [{ cn: 4, count: 1 }] })
    expect(pair(result, "O", "Cu").shells[0]).toMatchObject({ averageCN: 1, countsByAtom: [1, 1, 1, 1], distribution: [{ cn: 1, count: 4 }] })
  })

  it("matches the current neighbor regression for a distorted five-neighbor shell", () => {
    // neighbor/tests/test_coordination.py:
    // ShellCoordinationTests.test_gap_group_membership_is_shared_by_all_statistics,
    // reviewed at 2771716f9b901f2246d55bb7fa67e4c3194a0e04.
    const atoms = [
      atom("Cu", 0, 0, 0, true), atom("O", 2), atom("O", -2.009),
      atom("O", 0, 2.018), atom("O", 0, -2.027), atom("O", 0, 0, 2.036),
    ]
    const result = calculateClusterCoordination(atoms, { tolerance: 0.01, bondRange: 3 })
    const shells = pair(result, "Cu", "O").shells
    expect(shells).toHaveLength(1)
    expect(shells[0].distance).toBeCloseTo(2.018, 14)
    expect(shells[0]).toMatchObject({
      minDistance: 2, maxDistance: 2.036, averageCN: 5, centerCN: 5,
      countsByAtom: [5], distribution: [{ cn: 5, count: 1 }],
    })
    expect(pair(result, "O", "Cu").shells[0]).toMatchObject({
      averageCN: 1, centerCN: null, countsByAtom: [1, 1, 1, 1, 1], distribution: [{ cn: 1, count: 5 }],
    })
  })

  it("accepts zero tolerance and isolated atoms without inventing shells", () => {
    const result = calculateClusterCoordination([atom("Cu", 0), atom("O", 1), atom("O", -1), atom("O", 1.1)], { tolerance: 0 })
    expect(pair(result, "Cu", "O").shells.map(shell => shell.averageCN)).toEqual([2, 1])
    const isolated = calculateClusterCoordination([atom("Cu", 0, 0, 0, true)])
    expect(isolated.pairs).toEqual([{ centerElement: "Cu", neighborElement: "Cu", centerCount: 1, shells: [] }])
  })

  it.each([
    { bondRange: 0 }, { bondRange: -1 }, { bondRange: Infinity }, { bondRange: NaN },
    { tolerance: -0.01 }, { tolerance: Infinity }, { tolerance: NaN },
  ])("rejects invalid options rather than silently substituting defaults: %j", options => {
    expect(() => calculateClusterCoordination([atom("Cu", 0)], options)).toThrow(/cutoff|tolerance/)
  })

  it("rejects empty or oversized clusters", () => {
    expect(() => calculateClusterCoordination([])).toThrow(/No cluster atoms/)
    expect(() => calculateClusterCoordination(Array.from({ length: CLUSTER_COORDINATION_MAX_ATOMS + 1 }, (_, index) => atom("Cu", index)))).toThrow(/at most 1500/)
  })

  it.each([
    { x: NaN }, { y: Infinity }, { z: -Infinity },
  ])("rejects nonfinite coordinates: %j", override => {
    expect(() => calculateClusterCoordination([{ ...atom("Cu", 0), ...override }])).toThrow(/coordinates must be finite/)
  })

  it.each([0.5, 0, 2, NaN])("rejects occupancy %s without guessing an atomic configuration", occupancy => {
    expect(() => calculateClusterCoordination([{ ...atom("Cu", 0), occupancy }])).toThrow(/fully occupied/)
  })

  it.each([0, 1e-13, 1e-12])("rejects overlapping distinct sites separated by %s angstrom", separation => {
    expect(() => calculateClusterCoordination([atom("Cu", 0), atom("O", separation)])).toThrow(/overlapping atomic sites/)
  })

  it("matches neighbor's overlap threshold without dropping distinct positive contacts", () => {
    const result = calculateClusterCoordination([atom("Cu", 0), atom("O", 2e-12)])
    expect(pair(result, "Cu", "O").shells[0]).toMatchObject({ distance: 2e-12, averageCN: 1 })
  })

  it("rejects pair-distance overflow and ambiguous center markers", () => {
    expect(() => calculateClusterCoordination([atom("Cu", -1e308), atom("Cu", 1e308)])).toThrow(/nonfinite pair distance/)
    expect(() => calculateClusterCoordination([atom("Cu", 0, 0, 0, true), atom("Cu", 1, 0, 0, true)])).toThrow(/more than one marked center/)
  })

  it("bounds output size when zero tolerance creates thousands of distinct shells", () => {
    const atoms = Array.from({ length: 250 }, (_, index) => atom("Cu", 1.01 ** index))
    expect(() => calculateClusterCoordination(atoms, { bondRange: 100, tolerance: 0 })).toThrow(/Too many coordination shells/)
  })
})
