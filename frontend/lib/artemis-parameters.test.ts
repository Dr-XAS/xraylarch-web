import { describe, expect, it } from "vitest"

import type { ArtemisParameter, ArtemisPath } from "./artemis"
import { planArtemisParameterSync } from "./artemis-parameters"

type PathExpressions = Pick<ArtemisPath, "enabled" | "s02" | "e0" | "deltar" | "sigma2">

function path(overrides: Partial<PathExpressions> = {}): PathExpressions {
  return { enabled: true, s02: "amp", e0: "del_e0", deltar: "del_r", sigma2: "sig2", ...overrides }
}

function parameter(name: string, overrides: Partial<ArtemisParameter> = {}): ArtemisParameter {
  return { name, kind: "guess", value: 0, expression: "", min: null, max: null, ...overrides }
}

describe("planArtemisParameterSync", () => {
  it("initializes bare path symbols for their physical role and adds shared names only once", () => {
    const result = planArtemisParameterSync([], [path(), path()])

    expect(result.removed).toEqual([])
    expect(result.added).toEqual([
      parameter("amp", { value: 1, min: 0, max: 2 }),
      parameter("del_e0", { min: -20, max: 20 }),
      parameter("del_r", { min: -0.2, max: 0.2 }),
      parameter("sig2", { value: 0.003, min: 0, max: 0.1 }),
    ])
  })

  it("reconciles renamed shells without changing retained settings and is idempotent", () => {
    const parameters = [
      parameter("amp", { kind: "set", value: 0.87 }),
      parameter("del_e0", { value: 2.5, min: -5, max: 8 }),
      parameter("del_r", { value: 0.01, min: -0.1, max: 0.1 }),
      parameter("sig2", { value: 0.007 }),
      parameter("unused_set", { kind: "set", value: 12 }),
      parameter("unused_def", { kind: "def", expression: "unused_set * 2" }),
    ]
    const paths = [path({ deltar: "del_r1", sigma2: "sig2_1" }), path({ deltar: "del_r2", sigma2: "sig2_2" })]
    const before = structuredClone(parameters)
    const result = planArtemisParameterSync(parameters, paths)

    expect(result.added.map(item => item.name)).toEqual(["del_r1", "sig2_1", "del_r2", "sig2_2"])
    expect(result.removed).toEqual(["del_r", "sig2", "unused_set", "unused_def"])
    expect(parameters).toEqual(before)

    const synchronized = [...parameters.filter(item => !result.removed.includes(item.name)), ...result.added]
    expect(synchronized.slice(0, 2)).toEqual(before.slice(0, 2))
    expect(planArtemisParameterSync(synchronized, paths)).toEqual({ added: [], removed: [] })
  })

  it("retains recursive Def dependencies and discovers missing symbols inside them", () => {
    const parameters = [
      parameter("amplitude", { kind: "def", expression: "shared * fraction" }),
      parameter("shared", { kind: "def", expression: "amp * scale" }),
      parameter("amp", { value: 0.9 }),
      parameter("fraction", { kind: "set", value: 0.5 }),
      parameter("obsolete"),
    ]
    const result = planArtemisParameterSync(parameters, [path({ s02: "amplitude", e0: "0", deltar: "0", sigma2: "0.003" })])

    expect(result.added.map(item => item.name)).toEqual(["scale"])
    expect(result.removed).toEqual(["obsolete"])
  })

  it("recognizes supported math, path constants, scientific notation, and repeated identifiers", () => {
    const result = planArtemisParameterSync([], [path({
      s02: "new_amp * exp(-2 * disorder) + 1e-3 + 2E+4 + pi/e + reff/degen + nleg",
      e0: "sqrt(abs(shift)) + log(1) + sin(pi) + cos(0) + tan(0)",
      deltar: "offset ** 2 + offset ** -2 + offset ** (2) + offset ** (-2)",
      sigma2: "+disorder",
    })])

    expect(result.added.map(item => item.name).sort()).toEqual(["disorder", "new_amp", "offset", "shift"])
    expect(result.removed).toEqual([])
  })

  it("rejects malformed expressions and invalid or reserved names without mutating inputs", () => {
    const parameters = [parameter("amp", { value: 0.85, min: 0.3, max: 1.5 })]
    const before = structuredClone(parameters)
    const invalid = [
      "new_amp +", "new_amp + _hidden", "new_amp + " + "a".repeat(33),
      "new_amp + items", "new_amp + class", "new_amp.real", "new_amp[0]", "[new_amp]",
      "unknown_function(new_amp)", "new_amp ** variable_power", "new_amp ** 9", "new_amp + 1e309",
    ]

    for (const expression of invalid) {
      expect(() => planArtemisParameterSync(parameters, [path({ s02: expression })]), expression).toThrow()
      expect(parameters).toEqual(before)
    }
  })

  it("rejects cycles through used Def parameters", () => {
    const parameters = [
      parameter("first", { kind: "def", expression: "second + 1" }),
      parameter("second", { kind: "def", expression: "first * 2" }),
    ]

    expect(() => planArtemisParameterSync(parameters, [path({ s02: "first", e0: "0", deltar: "0", sigma2: "0.003" })])).toThrow()
  })

  it("ignores disabled paths and refuses to remove parameters when no path is included", () => {
    const parameters = [parameter("amp"), parameter("disabled_only")]
    const paths = [path({ e0: "0", deltar: "0", sigma2: "0.003" }), path({ enabled: false, s02: "disabled_only", sigma2: "unfinished +" })]

    expect(planArtemisParameterSync(parameters, paths)).toEqual({ added: [], removed: ["disabled_only"] })
    expect(() => planArtemisParameterSync(parameters, paths.map(item => ({ ...item, enabled: false })))).toThrow()
    expect(() => planArtemisParameterSync(parameters, [])).toThrow()
  })

  it("applies the 32-parameter limit after removing obsolete rows and rejects overflow atomically", () => {
    const old = Array.from({ length: 32 }, (_, index) => parameter(`old_${index}`))
    const names = Array.from({ length: 33 }, (_, index) => `new_${index}`)
    const paths = [path({
      s02: names.slice(0, 8).join(" + "),
      e0: names.slice(8, 16).join(" + "),
      deltar: names.slice(16, 24).join(" + "),
      sigma2: names.slice(24, 32).join(" + "),
    })]
    const result = planArtemisParameterSync(old, paths)

    expect(result.added.map(item => item.name)).toEqual(names.slice(0, 32))
    expect(result.removed).toEqual(old.map(item => item.name))
    const before = structuredClone(old)
    expect(() => planArtemisParameterSync(old, [{ ...paths[0], sigma2: names.slice(24).join(" + ") }])).toThrow()
    expect(old).toEqual(before)
  })
})
