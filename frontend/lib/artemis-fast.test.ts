import { describe, expect, it, vi } from "vitest"
import { artemisApi, type ArtemisFitResult } from "./artemis"
import { fastEngineStatus, formatSeconds, judgeFits, type FitVerdict } from "./artemis-fast"

vi.mock("./artemis", async importOriginal => ({ ...await importOriginal<typeof import("./artemis")>(), artemisApi: vi.fn() }))

type Row = ArtemisFitResult["parameters"][number]
const row = (name: string, value: number, stderr: number | null, kind: Row["kind"] = "guess"): Row =>
  ({ name, kind, value, initial: value, stderr, expression: "", min: null, max: null })

function result(parameters: Row[], chi_square: number, parity = 1e-13) {
  return { success: true, parameters, statistics: { chi_square, errorbars: true }, metadata: { engine: "x", engine_parity: parity } } as unknown as ArtemisFitResult
}
const compared = (verdict: FitVerdict) => {
  if (verdict.kind === "not_compared") throw new Error(verdict.reason)
  return verdict
}

describe("judgeFits", () => {
  it("measures a difference against the parameter's own uncertainty, not its size", () => {
    // Two parameters move by the same relative amount, 1%. Only the first is
    // well determined, so only the first has really moved. A comparison in
    // relative units would call these equally close and hide the difference.
    const reference = result([row("reff", 2.5, 0.025), row("sig2", 0.005, 0.005)], 100)
    const fast = result([row("reff", 2.525, null), row("sig2", 0.00505, null)], 100)
    const verdict = compared(judgeFits(reference, fast))
    expect(verdict.worstName).toBe("reff")
    expect(verdict.worstSigma).toBeCloseTo(1, 12)
    expect(verdict.kind).toBe("different")
    expect(verdict.failed).toEqual(["fitted values"])
  })

  it("skips parameters the reference fit could not put an error bar on", () => {
    // A Set parameter has no uncertainty. Dividing by it would be a division by
    // zero or a NaN silently shown as the headline agreement number.
    const reference = result([row("amp", 1, null, "set"), row("del_r", 0.01, 0.002)], 100)
    const fast = result([row("amp", 1, null, "set"), row("del_r", 0.0101, null)], 100)
    const verdict = compared(judgeFits(reference, fast))
    expect(verdict.worstName).toBe("del_r")
    expect(Number.isFinite(verdict.worstSigma)).toBe(true)
  })

  it("reports a worse minimum as worse rather than as a magnitude", () => {
    // The sign carries the claim. An absolute difference here would let a
    // backend that fits worse be presented as if it fit better.
    const reference = result([row("amp", 1, 0.01)], 100)
    expect(compared(judgeFits(reference, result([row("amp", 1, null)], 101))).chiSquareChange).toBeCloseTo(0.01, 12)
    expect(compared(judgeFits(reference, result([row("amp", 1, null)], 99))).chiSquareChange).toBeCloseTo(-0.01, 12)
  })

  it("does not call two fits the same when the forward models disagree, however close the values", () => {
    const reference = result([row("amp", 1, 0.01)], 100)
    const verdict = compared(judgeFits(reference, result([row("amp", 1, null)], 100, 3e-4)))
    expect(verdict.kind).toBe("different")
    expect(verdict.failed).toEqual(["forward models"])
  })

  it("does not call two fits the same when one guessed parameter has no reference error and moved far", () => {
    // The old loop skipped a guess without a reference error, and one other
    // comparable guess was enough for "same" while the skipped one moved by
    // a factor of a thousand.
    const reference = result([row("amp", 1, null), row("del_r", 0.01, 0.002)], 100)
    const fast = result([row("amp", 1234, null), row("del_r", 0.01, null)], 100)
    expect(judgeFits(reference, fast).kind).toBe("not_compared")
  })

  it("does not compare fits that guess different parameters", () => {
    const reference = result([row("amp", 1, 0.01), row("del_r", 0.01, 0.002)], 100)
    expect(judgeFits(reference, result([row("amp", 1, null)], 100)).kind).toBe("not_compared")
    expect(judgeFits(result([row("amp", 1, 0.01)], 100), result([row("amp", 1, null), row("del_r", 5, null)], 100)).kind).toBe("not_compared")
  })

  it("does not read a zero reference chi-square as no change", () => {
    // 0 was treated as a zero relative change, whatever the fast fit's chi-square.
    const reference = result([row("amp", 1, 0.01)], 0)
    expect(judgeFits(reference, result([row("amp", 1, null)], 50)).kind).toBe("not_compared")
  })

  it("gives no verdict when either fit has no uncertainties to judge on", () => {
    const reference = result([row("amp", 1, 0.01)], 100)
    const bare = { ...result([row("amp", 1, null)], 100), statistics: { chi_square: 100, errorbars: false } } as unknown as ArtemisFitResult
    expect(judgeFits(reference, bare).kind).toBe("not_compared")
    expect(judgeFits(bare, reference).kind).toBe("not_compared")
  })
})

describe("formatSeconds", () => {
  it("keeps a millisecond solve readable instead of rounding it to 0.01 s", () => {
    expect(formatSeconds(0.0123)).toBe("12 ms")
    expect(formatSeconds(1.234)).toBe("1.23 s")
  })
})

describe("fastEngineStatus", () => {
  it("asks once per page however often the panel remounts, and asks again after a failed request", async () => {
    // The panel remounts on every model edit; a status request per edit was the cost to avoid.
    const api = vi.mocked(artemisApi)
    api.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ available: false, reason: "No module named 'jax'" })
    await expect(fastEngineStatus()).rejects.toThrow("offline")
    await expect(fastEngineStatus()).resolves.toMatchObject({ available: false })
    await fastEngineStatus()
    expect(api).toHaveBeenCalledTimes(2)
    expect(api).toHaveBeenLastCalledWith("/fast-fit/status")
  })
})
