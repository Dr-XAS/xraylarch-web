import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { ArtemisPathMetadata } from "./artemis"
import { parseFeffCluster } from "./feff-cluster"
import { buildFeffPathGeometry, type FeffPathGeometry } from "./feff-path-geometry"
import { resolveFeffPathEquivalents, type FeffEquivalentAtom } from "./feff-path-equivalents"

const atom = (element: string, x: number, y = 0, z = 0, ipot = 1) => ({ atom: element, x, y, z, ipot })
const absorber = atom("Cu", 0, 0, 0, 0)
function path(sites: ArtemisPathMetadata["geometry"]): FeffPathGeometry {
  const result = buildFeffPathGeometry({
    geometry: sites, nleg: sites.length, reff: 0, degen: 1, absorber: "Cu", edge: "K", kmin: 0, kmax: 20,
  })
  expect(result.error).toBeNull()
  return result.geometry!
}
function fccCluster() {
  const halfCell = 1.8016
  const atoms = [absorber]
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    if ((x || y || z) && (x + y + z) % 2 === 0) atoms.push(atom("Cu", x * halfCell, y * halfCell, z * halfCell))
  }
  return atoms
}
const readFixture = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), "utf8")
function fixturePath(relativePath: string) {
  const lines = readFixture(relativePath).split(/\r?\n/).map(line => line.replace(/^\s*#/, ""))
  const index = lines.findIndex(line => line.includes("nleg, deg, reff"))
  expect(index).toBeGreaterThan(-1)
  const [nleg, degeneracy] = lines[index].trim().split(/\s+/).map(Number)
  const sites = lines.slice(index + 2, index + 2 + nleg).map(line => {
    const [x, y, z, ipot, , element] = line.trim().split(/\s+/)
    return atom(element, Number(x), Number(y), Number(z), Number(ipot))
  })
  return { geometry: path(sites), degeneracy }
}

describe("resolveFeffPathEquivalents", () => {
  it("highlights both actual first-shell O neighbors and Cu–O edges for degeneracy 2", () => {
    const sites = [absorber, atom("O", 1.8), atom("O", -1.8), atom("Cu", 0, 2.5, 0, 2)]
    const geometry = path(sites.slice(0, 2))
    const original = structuredClone({ sites, geometry })
    const result = resolveFeffPathEquivalents(geometry, 2, sites)
    expect(result).toMatchObject({ complete: true, count: 2 })
    expect(result.warning).toBeUndefined()
    expect(result.atoms).toEqual(sites.slice(0, 3))
    expect(result.bonds).toHaveLength(2)
    expect(result.atoms.every(site => sites.includes(site as typeof absorber))).toBe(true)
    expect(geometry.legs).toHaveLength(2)
    expect({ sites, geometry }).toEqual(original)
  })

  it("matches the 12 physical nearest neighbors of FCC copper", () => {
    const result = resolveFeffPathEquivalents(path([absorber, atom("Cu", 0, -1.8016, 1.8016)]), 12, fccCluster())
    expect(result).toMatchObject({ complete: true, count: 12 })
    expect(result.atoms).toHaveLength(13)
    expect(result.bonds).toHaveLength(12)
  })

  it("counts all 48 directed FCC triangle paths once, including their reversals", () => {
    const geometry = path([absorber, atom("Cu", 1.8016, -1.8016), atom("Cu", 1.8016, 0, -1.8016)])
    const result = resolveFeffPathEquivalents(geometry, 48, fccCluster())
    expect(result).toMatchObject({ complete: true, count: 48 })
    expect(result.atoms).toHaveLength(13)
    expect(result.bonds).toHaveLength(36)
  })

  it("includes the reversed order for asymmetric collinear three-leg paths", () => {
    const geometry = path([absorber, atom("Cu", 3.6032, 3.6032), atom("Cu", 1.8016, 1.8016)])
    const result = resolveFeffPathEquivalents(geometry, 24, fccCluster())
    expect(result).toMatchObject({ complete: true, count: 24 })
    expect(result.atoms).toHaveLength(25)
    expect(result.bonds).toHaveLength(36)
  })

  it("does not merge triangle and collinear geometries merely because their lengths match", () => {
    const sites = [absorber, atom("O", 1), atom("O", -1), atom("O", 0, 1)]
    const geometry = path([absorber, sites[1], sites[2]])
    const result = resolveFeffPathEquivalents(geometry, 2, sites)
    expect(result).toMatchObject({ complete: true, count: 2 })
    expect(result.atoms).toEqual(sites.slice(0, 3))
  })

  it("checks nonadjacent distances so a repeated absorber cannot join arbitrary equal-radius neighbors", () => {
    const sites = [absorber, atom("O", 2), atom("O", -2), atom("O", 0, 2)]
    const geometry = path([absorber, sites[1], absorber, sites[2]])
    const result = resolveFeffPathEquivalents(geometry, 2, sites)
    expect(result).toMatchObject({ complete: true, count: 2 })
    expect(result.atoms).toEqual(sites.slice(0, 3))
    expect(result.bonds).toHaveLength(2)
  })

  it("keeps repeated visits to one scatterer on that same atom without doubling palindromic paths", () => {
    const sites = [absorber, atom("O", 2), atom("O", -2)]
    const geometry = path([absorber, sites[1], absorber, sites[1]])
    const result = resolveFeffPathEquivalents(geometry, 2, sites)
    expect(result).toMatchObject({ complete: true, count: 2 })
    expect(result.atoms).toHaveLength(3)
    expect(result.bonds).toHaveLength(2)
  })

  it("preserves repeated scatterer topology in an out-and-back four-leg path", () => {
    const geometry = path([absorber, atom("Cu", -1.8016, 0, 1.8016), atom("Cu", -3.6032, 0, 3.6032), atom("Cu", -1.8016, 0, 1.8016)])
    expect(resolveFeffPathEquivalents(geometry, 12, fccCluster())).toMatchObject({ complete: true, count: 12 })
  })

  it("requires the same elements and known potential indices", () => {
    const sites = [absorber, atom("O", 2), atom("O", -2, 0, 0, 2), atom("N", 0, 2)]
    const result = resolveFeffPathEquivalents(path(sites.slice(0, 2)), 1, sites)
    expect(result).toMatchObject({ complete: true, count: 1 })
    expect(result.atoms).toEqual(sites.slice(0, 2))
  })

  it("allows verified CIF context without potential indices, while retaining element checks", () => {
    const sites: FeffEquivalentAtom[] = [absorber, atom("O", 2), { atom: "O", x: -2, y: 0, z: 0 }, atom("N", 0, 2)]
    expect(resolveFeffPathEquivalents(path([absorber, atom("O", 2)]), 2, sites))
      .toMatchObject({ complete: true, count: 2, atoms: sites.slice(0, 3) })
  })

  it("tolerates FEFF coordinate rounding and returns the actual cluster coordinates", () => {
    const sites = [absorber, atom("O", 1.80159), atom("O", -1.80159)]
    const result = resolveFeffPathEquivalents(path([absorber, atom("O", 1.8016)]), 2, sites)
    expect(result).toMatchObject({ complete: true, count: 2 })
    expect(result.atoms[1]).toBe(sites[1])
  })

  it("requires the representative coordinates to exist in the verified cluster", () => {
    const geometry = path([absorber, atom("O", 2)])
    const result = resolveFeffPathEquivalents(geometry, 2, [absorber, atom("O", 0, 2), atom("O", 0, -2)])
    expect(result.complete).toBe(false)
    expect(result.atoms).toEqual(geometry.atoms)
    expect(result.warning).toContain("complete representative path")
  })

  it("falls back to one representative if context is incomplete", () => {
    const geometry = path([absorber, atom("Cu", 2)])
    const result = resolveFeffPathEquivalents(geometry, 12, [absorber, atom("Cu", 2)])
    expect(result).toMatchObject({ complete: false, count: 1, atoms: geometry.atoms })
    expect(result.bonds).toHaveLength(1)
    expect(result.warning).toMatch(/^Equivalent paths were not expanded: found 1 matching directed paths/)
  })

  it("never chooses an arbitrary subset when more paths match than FEFF reports", () => {
    const geometry = path([absorber, atom("O", 2)])
    const result = resolveFeffPathEquivalents(geometry, 1, [absorber, atom("O", 2), atom("O", -2)])
    expect(result).toMatchObject({ complete: false, count: 2, atoms: geometry.atoms })
    expect(result.bonds).toHaveLength(1)
    expect(result.warning).toContain("more matching paths")
  })

  it("does not count duplicate source rows as different atoms", () => {
    const sites = [absorber, atom("O", 2), atom("O", -2), atom("O", 2 + 1e-7)]
    const result = resolveFeffPathEquivalents(path(sites.slice(0, 2)), 2, sites)
    expect(result).toMatchObject({ complete: true, count: 2 })
    expect(result.atoms).toHaveLength(3)
  })

  it("rejects conflicting atoms at the same physical site", () => {
    const sites = [absorber, atom("O", 2), atom("O", 2, 0, 0, 2)]
    expect(resolveFeffPathEquivalents(path(sites.slice(0, 2)), 1, sites).warning).toContain("conflicting atoms")
  })

  it.each([0, -1, 1.5, NaN, Infinity, 10_001])("does not expand unsupported degeneracy %s", degeneracy => {
    expect(resolveFeffPathEquivalents(path([absorber, atom("O", 2)]), degeneracy, [absorber, atom("O", 2)]).complete).toBe(false)
  })

  it("rejects invalid context and bounds the cluster size", () => {
    const geometry = path([absorber, atom("O", 2)])
    expect(resolveFeffPathEquivalents(geometry, 2, [absorber, atom("O", NaN)]).warning).toContain("invalid")
    expect(resolveFeffPathEquivalents(geometry, 2, []).warning).toContain("complete path")
    expect(resolveFeffPathEquivalents(geometry, 2, Array(4001).fill(absorber)).warning).toContain("search limit")
  })

  it("does not promote a partial search even if the count has already reached degeneracy", () => {
    const sites = [absorber, atom("O", 1), atom("O", Math.cos(.1), Math.sin(.1))]
    for (let i = 0; i < 1000; i++) sites.push(atom("O", Math.cos(Math.PI + i * .00002), Math.sin(Math.PI + i * .00002)))
    const geometry = path(sites.slice(0, 3))
    const result = resolveFeffPathEquivalents(geometry, 2, sites)
    expect(result).toMatchObject({ complete: false, count: 2, atoms: geometry.atoms })
    expect(result.warning).toContain("work limit")
  })

  it.each([
    ["0001", 2, 3], ["0002", 12, 13], ["0003", 12, 9], ["0004", 6, 7],
  ])("matches the actual Cu2O FEFF file feff%s.dat and its source cluster", (id, expectedCount, expectedAtoms) => {
    const base = "../../backend/xraylarch_web/resources/artemis/cuprite_15851/"
    const cluster = parseFeffCluster(readFixture(`${base}feff.inp`))!
    expect(cluster.atoms).toHaveLength(33)
    const { geometry, degeneracy } = fixturePath(`${base}feff${id}.dat`)
    expect(degeneracy).toBe(expectedCount)
    const result = resolveFeffPathEquivalents(geometry, degeneracy, cluster.atoms)
    expect(result).toMatchObject({ complete: true, count: expectedCount })
    expect(result.atoms).toHaveLength(expectedAtoms)
    if (id === "0001") expect(result.bonds).toHaveLength(2)
  })

  it.each(Array.from({ length: 13 }, (_, i) => String(i + 1).padStart(4, "0")))(
    "matches the reported directed degeneracy of actual FCC feff%s.dat", id => {
      const { geometry, degeneracy } = fixturePath(`../../examples/feffit/Feff_Cu/feff${id}.dat`)
      expect(resolveFeffPathEquivalents(geometry, degeneracy, fccCluster())).toMatchObject({ complete: true, count: degeneracy })
    },
  )
})
