import { describe, expect, it } from "vitest"
import type { AthenaGroup } from "@/lib/athena"
import { currentEdgeIdentity, edgeIdentityDescription } from "./athena-edge-identity"

function group(): AthenaGroup {
  return {
    id: "native-cu", label: "Native Cu foil", data_type: "mu", marked: false, frozen: false,
    energy: [8950, 8979, 9010], mu: [0, 0.5, 1], multiplier: 1, offset: 0, notes: "", reference_id: null,
    parameters: { e0: 8979, step: null, pre1: -150, pre2: -30, norm1: 100, norm2: 300, nnorm: 2, flatten: true,
      rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1, kmin: 3, kmax: 12,
      kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0, rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05 },
    source: { edge_identity: { element: "Cu", edge: "K", origin: "native" } }, processing_error: null,
    result: { arrays: { norm: [0, 0.5, 1] }, effective: { e0: 8979, element: "Cu", edge: "K" }, warnings: [] },
  }
}

describe("Athena current-group edge identity", () => {
  it("prefers native source identity, falls back to effective identity, and leaves missing identity Unknown", () => {
    const native = group()
    native.result!.effective = { element: "Fe", edge: "L3" }
    expect(currentEdgeIdentity(native)).toEqual({ element: "Cu", edge: "K", origin: "native" })
    expect(edgeIdentityDescription(native)).toBe("Cu K · native")
    native.source.edge_identity = { element: "Cu", edge: null }
    expect(currentEdgeIdentity(native)).toEqual({ element: "Fe", edge: "L3" })
    native.result = null
    expect(edgeIdentityDescription(native)).toBe("Unknown")
  })
})
