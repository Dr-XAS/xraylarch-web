import { describe, expect, it } from "vitest"
import type { ArtemisTransform } from "./artemis"
import { validateArtemisTransform } from "./artemis-transform-limits"

const transform: ArtemisTransform = { fitspace: "r", window: "hanning", kmin: 3, kmax: 12, rmin: 1, rmax: 3, dk: 2, dr: 0, kweight: [0, 1, 2, 3] }

describe("Artemis transform calculation limits", () => {
  it.each([
    { kmin: -1 }, { kmax: 51 }, { dk: -1 }, { dk: 11 },
    { rmin: -1 }, { rmax: 11 }, { dr: -1 }, { dr: 6 },
    { kmax: 3.5 }, { rmax: 1.05 }, { kmax: Infinity }, { rmin: NaN },
    { kweight: [] }, { kweight: [9] }, { kweight: [-1] }, { kweight: [1.5] }, { kweight: [2, 2] },
  ])("rejects invalid or unsupported transform %j", change => {
    expect(() => validateArtemisTransform({ ...transform, ...change })).toThrow()
  })

  it("accepts all supported weights, zero tapers, and decimal minimum-width boundaries", () => {
    expect(() => validateArtemisTransform({ ...transform, kmin: 3.1, kmax: 4.1, rmin: 1.1, rmax: 1.2, dk: 0 })).not.toThrow()
    expect(() => validateArtemisTransform({ ...transform, kmin: 49, kmax: 50, rmin: 9.9, rmax: 10, window: "kaiser", dk: 10, dr: 5 })).not.toThrow()
  })
})
