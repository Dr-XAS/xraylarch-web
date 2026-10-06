import { describe, expect, it } from "vitest"
import {
  ALL_PATHS, filterPathRows, previewRequestKey, sortPathRows, validArtemisPreview,
  type ArtemisPreview, type ArtemisPreviewRequest, type PathRow,
} from "./artemis-path-preview"

const metrics = (amplitude: number) => ({ amplitude, r_at_amplitude: 2.1, window_area: amplitude * 3, chi_k_peak: amplitude / 2 })
function row(id: string, nleg: number, reff: number, degen: number, amplitude?: number): PathRow {
  return { id, filename: `${id}.dat`, label: id, enabled: true, metadata: { reff, degen, nleg },
    metrics: amplitude === undefined ? undefined : metrics(amplitude) }
}
const rows = [row("a", 2, 1.8, 2, 1), row("b", 3, 3.4, 48, 0.02), row("c", 2, 4.5, 6, 0.5)]
const ids = (result: readonly PathRow[]) => result.map(item => item.id)

function preview(overrides: Partial<ArtemisPreview> = {}): ArtemisPreview {
  const k = { x: [0, 0.05, 0.1], weight: 2, total: [0, 1, 2] }
  const r = { x: [0, 0.03, 0.06], total_mag: [0, 1, 2], total_re: [0, 1, 2], total_im: [0, 1, 2] }
  return {
    k, r, warnings: [],
    transform: { fitspace: "r", kmin: 3, kmax: 12, kweight: [2], dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0 },
    paths: [{ id: "a", label: "a", filename: "a.dat", metadata: { reff: 1.8, degen: 2, nleg: 2, absorber: "Cu", edge: "K", geometry: [], kmin: 0, kmax: 20 },
      values: { s02: 1, e0: 0, deltar: 0, sigma2: 0.003 }, k: { chi: [0, 1, 2] },
      r: { mag: [0, 1, 2], re: [0, 1, 2], im: [0, 1, 2] }, metrics: metrics(1) }],
    metadata: { engine: "larch", kstep: 0.05, nfft: 2048, rwindow: "hanning", note: "", metrics: "" },
    ...overrides,
  }
}
function request(overrides: Partial<ArtemisPreviewRequest> = {}): ArtemisPreviewRequest {
  return {
    parameters: [{ name: "s02", kind: "guess", value: 0.9, expression: "", min: null, max: null }],
    transform: { fitspace: "r", kmin: 3, kmax: 12, kweight: [2], dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0 },
    paths: [{ id: "a", label: "a", filename: "a.dat", content: "FEFF", enabled: true, s02: "s02", e0: "e0", deltar: "dr", sigma2: "ss" }],
    ...overrides,
  }
}

describe("validArtemisPreview", () => {
  it("accepts a response whose curves match the request", () => {
    expect(validArtemisPreview(preview(), request())).toBe(true)
  })

  it("rejects curves from a different set of paths, which would be plotted under the wrong labels", () => {
    const stale = preview()
    stale.paths[0].id = "b"
    expect(validArtemisPreview(stale, request())).toBe(false)
  })

  it("rejects a path series shorter than its axis, which would silently plot a truncated path", () => {
    const short = preview()
    short.paths[0].k.chi = [0, 1]
    expect(validArtemisPreview(short, request())).toBe(false)
  })

  it("rejects NaN in a curve rather than leaving a gap in the plot", () => {
    const broken = preview()
    broken.r.total_mag = [0, Number.NaN, 2]
    expect(validArtemisPreview(broken, request())).toBe(false)
  })

  it("rejects a non-monotonic axis, which would draw the curve folded back on itself", () => {
    expect(validArtemisPreview(preview({ k: { x: [0, 0.1, 0.05], weight: 2, total: [0, 1, 2] } }), request())).toBe(false)
  })

  it("compares against the enabled paths only, since disabled paths are not sent to the engine", () => {
    const withDisabled = request()
    withDisabled.paths = [...withDisabled.paths, { ...withDisabled.paths[0], id: "off", enabled: false }]
    expect(validArtemisPreview(preview(), withDisabled)).toBe(true)
  })
})

describe("filterPathRows", () => {
  it("keeps every path by default", () => {
    expect(ids(filterPathRows(rows, ALL_PATHS))).toEqual(["a", "b", "c"])
  })

  it("separates single from multiple scattering by leg count", () => {
    expect(ids(filterPathRows(rows, { ...ALL_PATHS, legs: "single" }))).toEqual(["a", "c"])
    expect(ids(filterPathRows(rows, { ...ALL_PATHS, legs: "multiple" }))).toEqual(["b"])
  })

  it("drops paths beyond the Reff cutoff", () => {
    expect(ids(filterPathRows(rows, { ...ALL_PATHS, reffMax: 3.5 }))).toEqual(["a", "b"])
  })

  it("measures the amplitude cutoff against the largest path, not an absolute value", () => {
    expect(ids(filterPathRows(rows, { ...ALL_PATHS, minAmplitude: 0.05 }))).toEqual(["a", "c"])
  })

  it("keeps paths whose amplitude is unknown, so nothing disappears before the curves arrive", () => {
    const unmeasured = [row("a", 2, 1.8, 2, 1), row("d", 2, 2.2, 4)]
    expect(ids(filterPathRows(unmeasured, { ...ALL_PATHS, minAmplitude: 0.5 }))).toEqual(["a", "d"])
  })
})

describe("sortPathRows", () => {
  it("leaves the model's own order alone", () => {
    expect(ids(sortPathRows(rows, "model", true))).toEqual(["a", "b", "c"])
  })

  it("orders by Reff, amplitude, legs and degeneracy in both directions", () => {
    expect(ids(sortPathRows(rows, "reff", false))).toEqual(["a", "b", "c"])
    expect(ids(sortPathRows(rows, "reff", true))).toEqual(["c", "b", "a"])
    expect(ids(sortPathRows(rows, "amplitude", true))).toEqual(["a", "c", "b"])
    expect(ids(sortPathRows(rows, "degen", true))).toEqual(["b", "c", "a"])
    expect(ids(sortPathRows(rows, "legs", true))).toEqual(["b", "a", "c"])
  })

  it("breaks ties by model order instead of shuffling equal paths between renders", () => {
    const tied = [row("a", 2, 2, 4, 1), row("b", 2, 2, 4, 1), row("c", 2, 2, 4, 1)]
    expect(ids(sortPathRows(tied, "reff", true))).toEqual(["a", "b", "c"])
  })

  it("sends paths with no measured amplitude to the end rather than treating them as zero", () => {
    const partial = [row("a", 2, 1.8, 2), row("b", 2, 2.4, 4, 0.1)]
    expect(ids(sortPathRows(partial, "amplitude", false))).toEqual(["b", "a"])
    expect(ids(sortPathRows(partial, "amplitude", true))).toEqual(["b", "a"])
  })
})

describe("previewRequestKey", () => {
  it("changes when a starting value changes, so the curves are recomputed", () => {
    const other = request()
    other.paths[0].sigma2 = "0.01"
    expect(previewRequestKey(other)).not.toBe(previewRequestKey(request()))
  })

  it("is stable when nothing changed, so the same model is not fetched twice", () => {
    expect(previewRequestKey(request())).toBe(previewRequestKey(request()))
  })

  it("changes when a FEFF file is replaced by one of a different size", () => {
    const replaced = request()
    replaced.paths[0].content = "FEFF with more lines"
    expect(previewRequestKey(replaced)).not.toBe(previewRequestKey(request()))
  })
})
