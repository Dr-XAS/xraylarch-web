import { describe, expect, it } from "vitest"
import type { ArtemisModelDraft, ArtemisPath } from "./artemis"
import { planExpansionInsertion } from "./artemis-expansion"

function draft(): ArtemisModelDraft {
  return { revision: 1, transform: {} as ArtemisModelDraft["transform"],
    parameters: [{ id: "dr", name: "del_r", kind: "guess", value: "0.01", min: "-0.2", max: "0.2", expression: "" }],
    paths: [{ id: "p", label: "Cu–O", enabled: true, filename: "feff0001.dat", content: "unchanged FEFF contents",
      metadata: { reff: 1.85, degen: 2, nleg: 2, absorber: "Cu", edge: "K", geometry: [], kmin: 0, kmax: 20 },
      sigma2: "0.003", s02: "0.9", e0: "0", deltar: "del_r" }] }
}

describe("isotropic expansion insertion", () => {
  it("fits a dimensionless alpha against FEFF reff without creating or altering FEFF values", () => {
    const before = draft()
    const result = planExpansionInsertion(before, "p", { value: "0.01" })
    expect(result.expression).toBe("alpha_1 * reff")
    expect(result.alphaName).toBe("alpha_1")
    expect(result.added).toEqual([{ name: "alpha_1", value: .01, kind: "guess",
      min: -1 + Number.EPSILON / 2, max: null, expression: "" }])
    expect(result.removed).toEqual(["del_r"])
    expect(result.paths[0]).toEqual({ ...before.paths[0], deltar: result.expression })
    expect(result.paths[0].metadata).toBe(before.paths[0].metadata)
    expect(before).toEqual(draft())
    expect(result.added.some(parameter => parameter.name === "reff")).toBe(false)
  })

  it("scales both single and multiple scattering lengths and admits contraction", () => {
    for (const [nleg, reff] of [[2, 1.85], [3, 3.4], [4, 5.1]]) {
      const before = draft()
      before.paths[0].metadata = { ...before.paths[0].metadata, nleg, reff }
      const result = planExpansionInsertion(before, "p", { value: "-0.02" })
      const evaluate = new Function("alpha_1", "reff", `return ${result.expression}`)
      expect(reff + evaluate(result.added[0].value, reff)).toBeCloseTo(.98 * reff, 12)
      expect(result.added[0]).toMatchObject({ kind: "guess", value: -.02, max: null })
    }
    for (const value of ["0", "2", String(-1 + Number.EPSILON / 2)]) {
      const result = planExpansionInsertion(draft(), "p", { value })
      expect(result.added[0].value).toBe(Number(value))
      expect(result.added[0].min).toBeLessThanOrEqual(Number(value))
      expect(result.added[0].min).toBeGreaterThan(-1)
    }
  })

  it("retains a shared ΔR parameter and its Def dependencies on other paths", () => {
    const before = draft()
    before.parameters[0] = { ...before.parameters[0], kind: "def", expression: "offset + scale * 2" }
    before.parameters.push(
      { id: "offset", name: "offset", kind: "set", value: "0.1", min: "", max: "", expression: "" },
      { id: "scale", name: "scale", kind: "guess", value: "0.01", min: "-0.1", max: "0.2", expression: "" },
    )
    before.paths.push({ ...before.paths[0], id: "other" })
    const snapshot = structuredClone(before)
    const result = planExpansionInsertion(before, "p", { value: "0" })
    expect(result.removed).toEqual([])
    expect(result.added.map(parameter => parameter.name)).toEqual(["alpha_1"])
    expect(result.paths[1]).toBe(before.paths[1])
    expect(before).toEqual(snapshot)
  })

  it("avoids existing alpha names and all unsynchronized references, including disabled paths and Defs", () => {
    const before = draft()
    before.parameters.push({ ...before.parameters[0], id: "existing", name: "alpha_1", kind: "def", expression: "alpha_2 + 1" })
    before.paths.push({ ...before.paths[0], id: "other", enabled: false,
      s02: "alpha_3", e0: "alpha_4", deltar: "alpha_5 * reff", sigma2: "alpha_6" })
    const snapshot = structuredClone(before)
    const result = planExpansionInsertion(before, "p", { value: "0" })
    expect(result.alphaName).toBe("alpha_7")
    expect(result.paths[1]).toBe(before.paths[1])
    expect(before).toEqual(snapshot)
  })

  it("rejects invalid expansion, missing paths, and unavailable FEFF lengths atomically", () => {
    for (const value of ["", " ", "-1", "-2", "NaN", "Infinity", "-Infinity"]) {
      const before = draft()
      expect(() => planExpansionInsertion(before, "p", { value })).toThrow(/greater than −1/)
      expect(before).toEqual(draft())
    }
    expect(() => planExpansionInsertion(draft(), "missing", { value: "0" })).toThrow(/Include this path/)
    for (const change of [{ enabled: false }, { metadata: undefined },
      ...[0, -1, NaN, Infinity].map(reff => ({ metadata: { ...draft().paths[0].metadata, reff } }))]) {
      const before = draft()
      before.paths[0] = { ...before.paths[0], ...change } as ArtemisPath
      const snapshot = structuredClone(before)
      expect(() => planExpansionInsertion(before, "p", { value: "0" })).toThrow()
      expect(before).toEqual(snapshot)
    }
  })

  it("keeps syntax and parameter-capacity failures atomic", () => {
    const invalid = draft()
    invalid.paths[0].e0 = "unfinished +"
    const snapshot = structuredClone(invalid)
    expect(() => planExpansionInsertion(invalid, "p", { value: "0" })).toThrow(/Cannot sync expression/)
    expect(invalid).toEqual(snapshot)

    const full = draft()
    full.paths[0].e0 = Array.from({ length: 32 }, (_, i) => `p${i}`).join("+")
    const fullSnapshot = structuredClone(full)
    expect(() => planExpansionInsertion(full, "p", { value: "0" })).toThrow(/limit is 32/)
    expect(full).toEqual(fullSnapshot)
  })
})
