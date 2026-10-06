import { describe, expect, it } from "vitest"
import { commonSupport, peakStart } from "./peak-start"

const gaussian = (x: number, center: number, sigma: number, area: number) =>
  area / (sigma * Math.sqrt(2 * Math.PI)) * Math.exp(-(((x - center) / sigma) ** 2) / 2)

describe("peakStart", () => {
  it("starts a weak pre-edge peak near its real size, not at area 1", () => {
    // A Mn-like pre-edge (area 0.25, sigma 1.2 eV at 6540.5) on a rising edge,
    // in normalized units. Area 1 and sigma 2 eV were four times and 1.7 times off.
    const x = Array.from({ length: 91 }, (_, i) => 6530 + i * 0.2)
    const y = x.map(e => gaussian(e, 6540.5, 1.2, 0.25) + 0.5 + Math.atan((e - 6550) / 2) / Math.PI)
    const start = peakStart(x, y, 6535, 6545)!
    expect(Math.abs(start.center - 6540.5)).toBeLessThan(0.5)
    expect(start.sigma).toBeGreaterThan(0.6)
    expect(start.sigma).toBeLessThan(2)
    expect(start.amplitude).toBeGreaterThan(0.1)
    expect(start.amplitude).toBeLessThan(0.5)
  })

  it("offers nothing rather than a guess when the window holds too few points", () => {
    expect(peakStart([1, 2, 3, 4, 5, 6], [0, 1, 0, 1, 0, 1], 2, 4)).toBeNull()
  })

  // A window that reaches up the edge has no excess above its chord, so the
  // start falls on the first point. These synthetic coordinates catch a
  // two-decimal rounding that would put the start outside the fit range.
  const edge = Array.from({ length: 101 }, (_, i) => 7000.123 + i * 0.2)
  const rising = edge.map(e => Math.exp((e - 7020) / 3))

  it("never rounds the centre below the first measured point", () => {
    const start = peakStart(edge, rising, 7000, 7020)!
    expect(start.center).toBeGreaterThanOrEqual(edge[0])
  })

  it("keeps the centre inside every series member's measured range", () => {
    const later = edge.map(e => e + 0.02)
    const support = commonSupport([edge, later], 7000, 7020)!
    expect(support[0]).toBeCloseTo(later[0], 10)
    const start = peakStart(edge, rising, 7000, 7020, support)!
    expect(start.center).toBeGreaterThanOrEqual(later[0])
    expect(start.center).toBeLessThanOrEqual(support[1])
  })
})
