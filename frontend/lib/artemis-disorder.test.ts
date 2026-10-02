import { describe, expect, it } from "vitest"
import type { ArtemisModelDraft } from "./artemis"
import { planDisorderInsertion, type DisorderOptions } from "./artemis-disorder"
import { planArtemisParameterSync } from "./artemis-parameters"

const options: DisorderOptions = { model: "einstein", temperature: "100", theta: "300", refineTheta: true,
  staticOffset: true, staticValue: "0.001", value: "0.003" }
function draft(): ArtemisModelDraft {
  return { revision: 1, transform: {} as ArtemisModelDraft["transform"],
    parameters: [{ id: "s", name: "sig2", kind: "guess", value: "0.003", min: "0", max: "0.1", expression: "" }],
    paths: [{ id: "p", enabled: true, sigma2: "sig2", s02: "1", e0: "0", deltar: "0" }] as ArtemisModelDraft["paths"] }
}

describe("Debye–Waller insertion", () => {
  it("replaces only the target path, creates bounded theta and fixed T/static, and syncs obsolete parameters", () => {
    const before = draft()
    const result = planDisorderInsertion(before, "p", options)
    expect(result.expression).toBe("sig2_static_1 + sigma2_eins(temperature_1, theta_e_1)")
    expect(result.removed).toEqual(["sig2"])
    expect(result.added.map(row => [row.name, row.kind, row.value, row.min])).toEqual([
      ["temperature_1", "set", 100, null], ["theta_e_1", "guess", 300, 1.e-5], ["sig2_static_1", "set", .001, null],
    ])
    expect(before).toEqual(draft())
  })

  it("retains shared σ² on other paths and never overwrites existing temperature definitions", () => {
    const before = draft()
    before.paths.push({ ...before.paths[0], id: "other" })
    before.parameters.push({ ...before.parameters[0], id: "t", name: "temperature_1", kind: "set", value: "77" })
    before.paths[1].sigma2 = "sig2 + sigma2_eins(temperature_1, 400)"
    const result = planDisorderInsertion(before, "p", { ...options, model: "debye" })
    expect(result.expression).toContain("sigma2_debye(temperature_2, theta_d_1)")
    expect(result.removed).toEqual([])
    expect(result.paths[1]).toEqual(before.paths[1])
  })

  it("supports fixed and fitted values, and preserves zero sample temperature", () => {
    for (const model of ["guess", "set"] as const) {
      const result = planDisorderInsertion(draft(), "p", { ...options, model })
      expect(result.added[0]).toMatchObject({ kind: model, value: .003 })
    }
    expect(planDisorderInsertion(draft(), "p", { ...options, temperature: "0", refineTheta: false }).added[1].kind).toBe("set")
  })

  it("keeps unsynchronized references separate from newly inserted parameters", () => {
    const before = draft()
    before.paths.push({ ...before.paths[0], id: "other", sigma2: "sig2_1" })
    const result = planDisorderInsertion(before, "p", { ...options, model: "guess" })
    expect(result.expression).toBe("sig2_2")
    expect(result.paths[1].sigma2).toBe("sig2_1")
  })

  it("rejects missing/invalid scientific values and incomplete models atomically", () => {
    for (const change of [{ temperature: "" }, { temperature: "-1" }, { theta: "0" }, { staticValue: "NaN" }]) {
      expect(() => planDisorderInsertion(draft(), "p", { ...options, ...change })).toThrow()
    }
    const before = draft()
    before.paths[0].e0 = "unfinished +"
    expect(() => planDisorderInsertion(before, "p", options)).toThrow()
    expect(before.paths[0].sigma2).toBe("sig2")
  })
})

describe("thermal expression synchronization", () => {
  it("recognizes both native aliases and Larch function dependencies", () => {
    const paths = draft().paths
    paths[0].sigma2 = "static + sigma2_eins(temp,theta_e) + debye(temp,theta_d)"
    expect(planArtemisParameterSync([], paths).added.map(row => row.name)).toEqual(["static", "temp", "theta_e", "theta_d"])
  })

  it("rejects path-dependent Defs, wrong fields, arity, keywords and internal path access", () => {
    for (const expression of ["eins(300)", "debye(300,350,feffpath)", "eins(t=300,theta=350)", "feffpath"]) {
      expect(() => planArtemisParameterSync([], [{ ...draft().paths[0], sigma2: expression }])).toThrow()
    }
    expect(() => planArtemisParameterSync([], [{ ...draft().paths[0], s02: "eins(300,350)" }])).toThrow()
    expect(() => planArtemisParameterSync([{ name: "sig2", kind: "def", expression: "eins(300,350)" }], draft().paths)).toThrow()
  })
})
