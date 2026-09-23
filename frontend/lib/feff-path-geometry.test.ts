import { describe, expect, it } from "vitest"
import type { ArtemisPathMetadata } from "./artemis"
import { buildFeffPathGeometry } from "./feff-path-geometry"

const site = (x: number, y = 0, z = 0, ipot = 1) => ({ atom: ipot === 0 ? "Cu" : "O", x, y, z, ipot })
const metadata = (geometry: ArtemisPathMetadata["geometry"], extra: Partial<ArtemisPathMetadata> = {}): ArtemisPathMetadata => ({
  nleg: geometry.length, geometry, reff: 2, degen: 4, absorber: "Cu", edge: "K", kmin: 0, kmax: 20, ...extra,
})

describe("buildFeffPathGeometry", () => {
  it("keeps both directed legs of single scattering and centers a translated absorber", () => {
    const input = metadata([site(10, 5, -2, 0), site(12, 5, -2)])
    const original = structuredClone(input)
    const { geometry, error } = buildFeffPathGeometry(input)
    expect(error).toBeNull()
    expect(geometry?.absorber).toMatchObject({ x: 0, y: 0, z: 0, visitIndices: [0, 2], isAbsorber: true })
    expect(geometry?.visits.map(visit => visit.atomIndex)).toEqual([0, 1, 0])
    expect(geometry?.legs.map(leg => [leg.index, leg.from.atomIndex, leg.to.atomIndex, leg.length, leg.scatteringAngle]))
      .toEqual([[1, 0, 1, 2, 180], [2, 1, 0, 2, 180]])
    expect(geometry?.totalLength).toBe(4)
    expect(geometry?.classification.kind).toBe("single")
    expect(input).toEqual(original)
  })

  it("rotates absorber-last FEFF order without reversing the triangle", () => {
    const { geometry } = buildFeffPathGeometry(metadata([site(2), site(2, 2), site(0, 0, 0, 0)]))
    expect(geometry?.visits.map(({ x, y }) => [x, y])).toEqual([[0, 0], [2, 0], [2, 2], [0, 0]])
    expect(geometry?.classification.kind).toBe("double-triangle")
    expect(geometry?.totalLength).toBeCloseTo(4 + Math.sqrt(8))
    expect(geometry?.legs[0].scatteringAngle).toBeCloseTo(90)
    expect(geometry?.legs[1].scatteringAngle).toBeCloseTo(135)
    expect(geometry?.legs[2].scatteringAngle).toBeCloseTo(135)
  })

  it("recognizes a collinear three-leg path and uses the FEFF forward-scattering angle", () => {
    const { geometry } = buildFeffPathGeometry(metadata([site(0, 0, 0, 0), site(1), site(2)]))
    expect(geometry?.classification.kind).toBe("double-collinear")
    expect(geometry?.legs.map(leg => leg.scatteringAngle)).toEqual([0, 180, 180])
    expect(geometry?.totalLength).toBe(4)
  })

  it("retains a repeated absorber inside a four-leg trajectory", () => {
    const { geometry } = buildFeffPathGeometry(metadata([site(0, 0, 0, 0), site(2), site(0, 0, 0, 0), site(-2)]))
    expect(geometry?.visits.map(visit => visit.atomIndex)).toEqual([0, 1, 0, 2, 0])
    expect(geometry?.atoms[0].visitIndices).toEqual([0, 2, 4])
    expect(geometry?.legs).toHaveLength(4)
    expect(geometry?.totalLength).toBe(8)
    expect(geometry?.classification).toMatchObject({ label: "Triple scattering", hasRepeatedSites: true })
  })

  it("retains repeated scatterer visits and does not infer sites from degeneracy", () => {
    const { geometry } = buildFeffPathGeometry(metadata([site(0, 0, 0, 0), site(1), site(2), site(1)], { degen: 48 }))
    expect(geometry?.atoms).toHaveLength(3)
    expect(geometry?.atoms[1].visitIndices).toEqual([1, 3])
    expect(geometry?.visits).toHaveLength(5)
    expect(geometry?.classification.description).toContain("revisits an atomic site")
  })

  it("supports the maximum 20 legs", () => {
    const rows = Array.from({ length: 20 }, (_, i) => site(Math.cos(i * Math.PI / 10), Math.sin(i * Math.PI / 10), 0, i === 0 ? 0 : 1))
    const { geometry, error } = buildFeffPathGeometry(metadata(rows))
    expect(error).toBeNull()
    expect(geometry?.legs).toHaveLength(20)
    expect(geometry?.classification.label).toBe("19-fold scattering")
  })

  it.each([1, 21, 2.5, NaN])("rejects unsupported leg count %s", nleg => {
    expect(buildFeffPathGeometry(metadata([site(0, 0, 0, 0), site(2)], { nleg })).error).toContain("2 and 20")
  })

  it("reports incomplete geometry rather than drawing a different path", () => {
    const result = buildFeffPathGeometry(metadata([site(0, 0, 0, 0), site(2)], { nleg: 3 }))
    expect(result.geometry).toBeNull()
    expect(result.error).toContain("Expected 3 geometry entries")
  })

  it.each([NaN, Infinity, -Infinity])("rejects non-finite coordinates %s", x => {
    expect(buildFeffPathGeometry(metadata([site(0, 0, 0, 0), site(x)])).error).toContain("non-finite")
  })

  it("requires an explicit absorber instead of guessing the nearest atom", () => {
    expect(buildFeffPathGeometry(metadata([site(0), site(2)])).error).toContain("ipot = 0")
  })

  it.each([
    [site(0, 0, 0, 0), site(0)],
    [site(0, 0, 0, 0), site(2), site(0, 0, 0, 0)],
  ])("rejects consecutive zero-length legs, including the closing leg", (...geometry) => {
    expect(buildFeffPathGeometry(metadata(geometry)).error).toContain("zero-length")
  })
})
