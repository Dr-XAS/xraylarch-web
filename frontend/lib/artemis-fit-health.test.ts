import { describe, expect, it } from "vitest"
import type { ArtemisFitRequest, ArtemisFitResult } from "./artemis"
import { correlationHealth, independentPointsHealth, parameterHealth, rFactorHealth } from "./artemis-fit-health"

type Parameter = ArtemisFitResult["parameters"][number]
function parameter(name: string, value: number, overrides: Partial<Parameter> = {}): Parameter {
  return { name, value, initial: value, kind: "guess", expression: "", min: null, max: null, stderr: null, ...overrides }
}
function path(overrides: Partial<ArtemisFitRequest["paths"][number]> = {}): ArtemisFitRequest["paths"][number] {
  return { id: "p1", label: "path", filename: "feff0001.dat", content: "", enabled: true,
    s02: "amp", e0: "del_e0", sigma2: "sig2", deltar: "del_r", ...overrides }
}

describe("EXAFS parameter health", () => {
  it.each([
    ["amp", 0.7, "good"], ["amp", 1, "good"], ["amp", 0.6999, "bad"], ["amp", 1.0001, "bad"],
    ["e0", -5, "good"], ["e0", 5, "good"], ["e0", -10, "caution"], ["e0", 10, "caution"],
    ["e0", -10.001, "bad"], ["e0", 10.001, "bad"],
    ["sigma2", 0.003, "good"], ["sigma2", 0.02, "good"], ["sigma2", 0.0029, "bad"], ["sigma2", 0.0201, "bad"],
    ["deltar", -0.1, "good"], ["deltar", 0.1, "good"], ["deltar", -0.1001, "bad"], ["deltar", 0.1001, "bad"],
  ] as const)("uses the source's inclusive physical limits for %s = %s", (name, value, state) => {
    expect(parameterHealth(parameter(name, value)).state).toBe(state)
  })

  it("requires the whole available one-sigma interval within the core for green", () => {
    expect(parameterHealth(parameter("amp", 0.85, { stderr: 0.1 })).state).toBe("good")
    expect(parameterHealth(parameter("amp", 0.85, { stderr: 0.16 })).state).toBe("caution")
    expect(parameterHealth(parameter("e0", 4, { stderr: 1 })).state).toBe("good")
    expect(parameterHealth(parameter("e0", 4, { stderr: 1.01 })).state).toBe("caution")
    expect(parameterHealth(parameter("e0", 9.14, { stderr: 0.486 })).state).toBe("caution")
    expect(parameterHealth(parameter("sigma2", 0.021, { stderr: 0.01 })).state).toBe("bad")
  })

  it("ignores invalid errors and errors the report does not claim", () => {
    for (const stderr of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parameterHealth(parameter("amp", 0.85, { stderr })).state).toBe("good")
    }
    const fitted = parameter("amp", 0.85, { stderr: 0.2 })
    expect(parameterHealth(fitted, { errorbars: true }).state).toBe("caution")
    expect(parameterHealth(fitted, { errorbars: false }).state).toBe("good")
    expect(parameterHealth({ ...fitted, kind: "set" }, { errorbars: true }).state).toBe("good")
    expect(parameterHealth({ ...fitted, kind: "def", expression: "other" }, { errorbars: true }).state).toBe("caution")
  })

  it("marks only varied, non-expression amplitude at a finite bound as railed", () => {
    for (const bounds of [{ min: 0.85 }, { max: 0.85 }, { min: 0.85009 }, { max: 0.84991 }]) {
      expect(parameterHealth(parameter("amp", 0.85, bounds)).state).toBe("railed")
    }
    expect(parameterHealth(parameter("amp", 0.85, { min: 0.85011 })).state).toBe("good")
    expect(parameterHealth(parameter("amp", 0.85, { min: -Infinity, max: Infinity })).state).toBe("good")
    expect(parameterHealth(parameter("amp", 0.6, { min: 0.6 })).state).toBe("railed")
    expect(parameterHealth(parameter("amp", 0.85, { min: 0.85, kind: "set" })).state).toBe("good")
    expect(parameterHealth(parameter("amp", 0.85, { max: 0.85, kind: "def", expression: "other" })).state).toBe("good")
    expect(parameterHealth(parameter("amp", 0.85, { max: 0.85, expression: "other" })).state).toBe("good")
    expect(parameterHealth(parameter("e0", 0, { min: 0 })).state).toBe("good")
    expect(parameterHealth(parameter("sigma2", 0.01, { max: 0.01 })).state).toBe("good")
  })

  it("supports source aliases and the existing Artemis aliases, with underscore suffixes", () => {
    for (const name of ["amp", "s02", "AMP_shell_1"]) expect(parameterHealth(parameter(name, 0.9)).state).toBe("good")
    for (const name of ["e0", "deltae", "del_e0", "del_e0_2"]) expect(parameterHealth(parameter(name, 6)).state).toBe("caution")
    for (const name of ["sigma2", "ss2", "sig2", "SIG2_O"]) expect(parameterHealth(parameter(name, 0.001)).state).toBe("bad")
    for (const name of ["deltar", "dr", "del_r", "del_r_o"]) expect(parameterHealth(parameter(name, 0.02)).state).toBe("good")
    for (const name of ["amplitude", "sig2extra", "driver", "alpha", "theta_e_1"]) {
      expect(parameterHealth(parameter(name, 0.9)).state).toBe("neutral")
    }
  })

  it("resolves custom names only from direct, unambiguous path references", () => {
    expect(parameterHealth(parameter("custom", 0.9), { paths: [path({ s02: " custom " })] }).state).toBe("good")
    expect(parameterHealth(parameter("custom", 6), { paths: [path({ e0: "custom" })] }).state).toBe("caution")
    expect(parameterHealth(parameter("custom", 0.001), { paths: [path({ sigma2: "custom" })] }).state).toBe("bad")
    expect(parameterHealth(parameter("custom", 0.02), { paths: [path({ deltar: "custom" })] }).state).toBe("good")
    expect(parameterHealth(parameter("custom", 0.9), { paths: [path({ s02: "custom", e0: "custom" })] }).state).toBe("neutral")
    expect(parameterHealth(parameter("custom", 0.9), { paths: [path({ s02: "custom", enabled: false })] }).state).toBe("neutral")
    expect(parameterHealth(parameter("custom", 0.9), { paths: [path({ s02: "custom" }), path({ s02: "custom" })] }).state).toBe("good")
    expect(parameterHealth(parameter("Custom", 0.9), { paths: [path({ s02: "custom" })] }).state).toBe("neutral")
  })

  it("does not infer units from variables in composite expressions", () => {
    const paths = [path({ s02: "scale * factor", e0: "shift + offset", deltar: "alpha * reff", sigma2: "static + sigma2_eins(T, theta)" })]
    for (const name of ["scale", "factor", "shift", "offset", "alpha", "reff", "static", "T", "theta"]) {
      expect(parameterHealth(parameter(name, 0.9), { paths }).state).toBe("neutral")
    }
    expect(parameterHealth(parameter("sig2_static", 0.001), { paths: [path({ sigma2: "sig2_static + sigma2_eins(T, theta)" })] }).state).toBe("neutral")
    expect(parameterHealth(parameter("amp", 12), { paths: [path({ s02: "0.9 * amp / degen" })] }).state).toBe("neutral")
    expect(parameterHealth(parameter("del_r", 0.05), { paths: [path({ deltar: "del_r * reff" })] }).state).toBe("neutral")
  })

  it("uses the saved direct role ahead of a conventional name, with conflicts unassessed", () => {
    expect(parameterHealth(parameter("amp", 0.02), { paths: [path({ s02: "0.9", deltar: "amp" })] }).state).toBe("good")
    expect(parameterHealth(parameter("amp", 0.02, { min: 0.02 }), { paths: [path({ s02: "0.9", deltar: "amp" })] }).state).toBe("good")
    expect(parameterHealth(parameter("amp", 0.9), { paths: [path({ deltar: "amp" })] }).state).toBe("neutral")
    expect(parameterHealth(parameter("s02_1", 0.9), { paths: [path({ s02: "s02_1 * coordination / 12" })] }).state).toBe("neutral")
    expect(parameterHealth(parameter("amp", 0.9), { paths: [path(), path({ s02: "0.9 * amp / degen" })] }).state).toBe("good")
  })

  it("recognizes only the native CN helper's explicit S0² within a composite expression", () => {
    const paths = [path({ s02: " s02_2 * cn_7 / degen " })]
    expect(parameterHealth(parameter("s02_2", 0.9), { paths }).state).toBe("good")
    expect(parameterHealth(parameter("s02_2", 1.2), { paths }).state).toBe("bad")
    expect(parameterHealth(parameter("cn_7", 12), { paths }).state).toBe("neutral")
    expect(parameterHealth(parameter("s02_2", 0.9), { paths: [path({ s02: "s02_2*cn_7/degen + 1" })] }).state).toBe("neutral")
    expect(parameterHealth(parameter("s02_2", 0.9), { paths: [path({ s02: "2 * s02_2 * cn_7 / degen" })] }).state).toBe("neutral")
    expect(parameterHealth(parameter("amp", 0.9), { paths: [path({ s02: "0.9 * amp / degen", enabled: false })] }).state).toBe("good")
    expect(parameterHealth(parameter("amp", 0.9), { paths: [path({ s02: "amp_other * 2" })] }).state).toBe("good")
  })

  it("leaves derived effective amplitudes neutral while keeping identity propagation", () => {
    const effective = parameter("effective", 0.18, { kind: "def", expression: "0.9 * cn / 12", stderr: 0.02 })
    expect(parameterHealth(effective, { paths: [path({ s02: "effective" })] }).state).toBe("neutral")
    expect(parameterHealth({ ...effective, name: "amp" }).state).toBe("neutral")
    expect(parameterHealth(parameter("amp", 0.85, { kind: "def", expression: "other", stderr: 0.2 })).state).toBe("caution")
    expect(parameterHealth(parameter("amp", 0.85, { kind: "def", expression: "other", stderr: 0.01 })).state).toBe("good")
  })

  it("leaves non-finite values unassessed and does not mutate the saved result", () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(parameterHealth(parameter("amp", value)).state).toBe("neutral")
    const original = Object.freeze(parameter("amp", 0.9, { stderr: 0.2 }))
    parameterHealth(original)
    expect(original).toEqual(parameter("amp", 0.9, { stderr: 0.2 }))
  })
})

describe("EXAFS fit statistic health", () => {
  it("uses the exact R-factor cutoff", () => {
    expect(rFactorHealth(0).state).toBe("good")
    expect(rFactorHealth(0.04999).state).toBe("good")
    expect(rFactorHealth(0.05).state).toBe("bad")
  })

  it("compares independent points with the saved number of varied parameters", () => {
    expect(independentPointsHealth(8, 4).state).toBe("good")
    expect(independentPointsHealth(7.99, 4).state).toBe("caution")
    expect(independentPointsHealth(4.01, 4).state).toBe("caution")
    expect(independentPointsHealth(4, 4).state).toBe("bad")
    expect(independentPointsHealth(3, 4).state).toBe("bad")
    expect(independentPointsHealth(8, 0).state).toBe("neutral")
  })

  it("uses absolute correlation and preserves both boundary cutoffs", () => {
    for (const sign of [-1, 1]) {
      expect(correlationHealth(sign * 0.7999).state).toBe("good")
      expect(correlationHealth(sign * 0.8).state).toBe("caution")
      expect(correlationHealth(sign * 0.8999).state).toBe("caution")
      expect(correlationHealth(sign * 0.9).state).toBe("bad")
      expect(correlationHealth(sign).state).toBe("bad")
    }
  })

  it("leaves absent and non-finite statistics unassessed", () => {
    for (const invalid of [null, undefined, NaN, Infinity, -Infinity, "0.01"]) {
      expect(rFactorHealth(invalid).state).toBe("neutral")
      expect(independentPointsHealth(invalid, 3).state).toBe("neutral")
      expect(independentPointsHealth(9, invalid).state).toBe("neutral")
      expect(correlationHealth(invalid).state).toBe("neutral")
    }
    expect(rFactorHealth(-0.1).state).toBe("neutral")
    expect(independentPointsHealth(-1, 3).state).toBe("neutral")
    expect(independentPointsHealth(9, -1).state).toBe("neutral")
  })
})
