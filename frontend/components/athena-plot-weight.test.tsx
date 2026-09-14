import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { athenaApi, type AthenaGroup } from "@/lib/athena"
import { useAthenaPlotWeight, type PlotWeightResult } from "./athena-plot-weight"

vi.mock("@/lib/athena", () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
type Options = Parameters<typeof useAthenaPlotWeight>[0]

const parameters: import("@/lib/athena").Parameters = {
  e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null,
  flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1,
  kmin: 0, kmax: 3, kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05,
}

function group(id = "Copper"): AthenaGroup {
  return {
    id, label: `${id} foil`, marked: true, frozen: false, data_type: "mu", energy: [10, 20, 30], mu: [1, 2, 3],
    multiplier: 1, offset: 0, notes: "", reference_id: null, parameters: { ...parameters }, processing_error: null, source: {},
    result: { effective: { kweight: 2, e0: 20 }, warnings: ["Saved warning"], arrays: {
      energy: [10, 20, 30], mu: [1, 2, 3], k: [0, 1, 2, 3], chi: [0, 2, -1, 1],
      r: [0, 1, 2], chir_mag: [2, 3, 2], chir_re: [1, 1, 1], chir_im: [1, 2, 1], chir_pha: [0, 1, 2],
    } },
  }
}

function transformed(overrides: Partial<PlotWeightResult> = {}): PlotWeightResult {
  return {
    project_id: "p", version: 4, group_id: "Copper", kweight: 3,
    arrays: {
      r: [0, 1, 2], chir_mag: [5, 7, 5], chir_re: [1, 2, 1], chir_im: [3, 4, 3], chir_pha: [0, 1, 2],
      q: [0, 1, 2, 3], chiq_mag: [2, 4, 4, 2], chiq_re: [1, 2, 2, 1], chiq_im: [1, 2, 2, 1], chiq_pha: [0, 1, 2, 3],
    },
    effective: { kweight: 3 }, warnings: ["Preview warning"], ...overrides,
  }
}

function serve() {
  api.mockImplementation(async (path, body) => {
    const { version, kweight } = body as { version: number; kweight: number }
    return transformed({ project_id: path.split("/")[2], group_id: path.split("/")[4], version, kweight, effective: { kweight } })
  })
}

function deferred() {
  let resolve!: (value: PlotWeightResult) => void
  const promise = new Promise<PlotWeightResult>(done => { resolve = done })
  return { promise, resolve }
}

function options(overrides: Partial<Options> = {}): Options {
  return { projectId: "p", version: 4, groups: [group()], space: "R", kWeight: 3, ...overrides }
}

function show(initialProps = options()) {
  return renderHook(props => useAthenaPlotWeight(props), { initialProps })
}

async function calculate() {
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

beforeEach(() => { vi.useFakeTimers(); api.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe("useAthenaPlotWeight", () => {
  it("keeps saved spectra immutable while transforming every usable displayed group", async () => {
    serve()
    const groups = freeze([group(), group("Iron"), { ...group("Raw"), result: null }])
    const original = JSON.stringify(groups)
    const view = show(options({ groups }))
    expect(view.result.current).toMatchObject({ groups, loading: true, error: null })
    expect(api).not.toHaveBeenCalled()
    await calculate()
    expect(api).toHaveBeenCalledTimes(2)
    expect(api).toHaveBeenCalledWith("/projects/p/groups/Copper/plot-transform", { version: 4, kweight: 3 }, "POST", expect.any(AbortSignal))
    expect(api).toHaveBeenCalledWith("/projects/p/groups/Iron/plot-transform", { version: 4, kweight: 3 }, "POST", expect.any(AbortSignal))
    expect(view.result.current.loading).toBe(false)
    expect(view.result.current.error).toBeNull()
    for (let index = 0; index < 2; index++) {
      const preview = view.result.current.groups[index]
      expect(preview).not.toBe(groups[index])
      expect(preview.parameters).toBe(groups[index].parameters)
      expect(preview.result?.arrays.chir_mag).toEqual([5, 7, 5])
      expect(preview.result?.arrays.energy).toBe(groups[index].result?.arrays.energy)
      expect(preview.result?.effective).toEqual({ kweight: 3, e0: 20 })
      expect(preview.result?.warnings).toEqual(["Saved warning", "Preview warning"])
    }
    expect(view.result.current.groups[2]).toBe(groups[2])
    expect(JSON.stringify(groups)).toBe(original)
    // Recreated selection arrays must not schedule duplicate calculations.
    view.rerender(options({ groups: [...groups] }))
    await calculate()
    expect(api).toHaveBeenCalledTimes(2)
  })

  it.each(["E", "k", "auto", "unprocessed", "failed", "unpaired", "nonfinite", "pending"])("does not request transforms for %s", async kind => {
    const sample = group()
    if (kind === "unprocessed") sample.result = null
    if (kind === "failed") sample.processing_error = "Background subtraction failed"
    if (kind === "unpaired") sample.result!.arrays.chi = [1]
    if (kind === "nonfinite") sample.result!.arrays.chi[1] = Number.NaN
    const groups = [sample]
    const view = show(options({ groups, space: kind === "E" || kind === "k" ? kind : "R",
      kWeight: kind === "auto" ? null : 3, pending: kind === "pending" }))
    await calculate()
    expect(api).not.toHaveBeenCalled()
    expect(view.result.current.groups).toBe(groups)
    expect(view.result.current.loading).toBe(kind === "pending")
    if (["failed", "unpaired", "nonfinite"].includes(kind)) expect(view.result.current.error).toMatch(/Reprocess Copper foil/)
    else expect(view.result.current.error).toBeNull()
  })

  it.each(["R", "q"] as const)("blocks cached %s products without usable chi, including mixed selections", async space => {
    serve()
    const stale = group("Stale")
    stale.result!.arrays = { ...stale.result!.arrays, ...transformed().arrays }
    delete stale.result!.arrays.chi
    const props = options({ groups: [stale], space })
    const view = show(props)
    expect(view.result.current.error).toMatch(/Reprocess Stale foil/)
    expect(view.result.current.loading).toBe(false)
    await calculate()
    expect(api).not.toHaveBeenCalled()
    const mixed = [group(), stale]
    view.rerender({ ...props, groups: mixed })
    expect(view.result.current.groups).toBe(mixed)
    expect(view.result.current.error).toMatch(/Reprocess Stale foil/)
    await calculate()
    expect(api).not.toHaveBeenCalled()
    // Auto may display saved products; the explicit override cannot do so.
    view.rerender({ ...props, groups: mixed, kWeight: null })
    expect(view.result.current.error).toBeNull()
    expect(view.result.current.groups).toBe(mixed)
  })

  it("passes through spectra with no saved Fourier products while transforming eligible groups", async () => {
    serve()
    const unavailable = group("XANES")
    unavailable.result!.arrays = { energy: [10, 20, 30], mu: [1, 2, 3] }
    const props = options({ groups: [group(), unavailable, { ...group("Raw"), result: null }] })
    const view = show(props)
    await calculate()
    expect(api).toHaveBeenCalledTimes(1)
    expect(view.result.current.error).toBeNull()
    expect(view.result.current.loading).toBe(false)
    expect(view.result.current.groups[0].result?.effective.kweight).toBe(3)
    expect(view.result.current.groups[1]).toBe(unavailable)
    expect(view.result.current.groups[2]).toBe(props.groups[2])
  })

  it("debounces rapid changes and requests only the latest weight, selection and revision", async () => {
    serve()
    const view = show()
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    view.rerender(options({ kWeight: 1 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    const latest = options({ kWeight: 0, version: 5, groups: [group("Iron")] })
    view.rerender(latest)
    await calculate()
    expect(api).toHaveBeenCalledExactlyOnceWith("/projects/p/groups/Iron/plot-transform", { version: 5, kweight: 0 }, "POST", expect.any(AbortSignal))
    expect(view.result.current.groups[0].result?.effective.kweight).toBe(0)
  })

  it.each(["projectId", "version"] as const)("reports a missing %s instead of displaying saved Fourier data under an explicit weight", async field => {
    const props = options({ [field]: undefined })
    const view = show(props)
    await calculate()
    expect(api).not.toHaveBeenCalled()
    expect(view.result.current.loading).toBe(false)
    expect(view.result.current.error).toMatch(/saved project revision/)
    expect(view.result.current.groups).toBe(props.groups)
  })

  it.each(["group", "version", "project", "weight", "space"] as const)("rejects a late response after the %s changes", async change => {
    const previous = deferred(), next = deferred()
    api.mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise)
    const view = show()
    await calculate()
    const oldSignal = api.mock.calls[0][3]!
    const latest = options({ projectId: change === "project" ? "other" : "p", version: change === "version" ? 5 : 4,
      groups: [group(change === "group" ? "Iron" : "Copper")], kWeight: change === "weight" ? 1 : 3,
      space: change === "space" ? "q" : "R" })
    view.rerender(latest)
    expect(oldSignal.aborted).toBe(true)
    expect(view.result.current.loading).toBe(true)
    expect(view.result.current.groups).toBe(latest.groups)
    await calculate()
    await act(async () => { next.resolve(transformed({ project_id: latest.projectId, version: latest.version,
      group_id: latest.groups[0].id, kweight: latest.kWeight!, effective: { kweight: latest.kWeight! } })) })
    const accepted = view.result.current.groups[0]
    expect(view.result.current.loading).toBe(false)
    expect(accepted.result?.effective.kweight).toBe(latest.kWeight)
    await act(async () => { previous.resolve(transformed()) })
    expect(view.result.current.groups[0].result).toEqual(accepted.result)
    expect(view.result.current.error).toBeNull()
  })

  it("immediately hides completed transforms on pending processing and recalculates even if the revision is unchanged", async () => {
    serve()
    const props = options()
    const view = show(props)
    await calculate()
    expect(view.result.current.groups[0].result?.effective.kweight).toBe(3)
    const signal = api.mock.calls[0][3]!
    view.rerender({ ...props, pending: true })
    expect(signal.aborted).toBe(true)
    expect(view.result.current.groups).toBe(props.groups)
    expect(view.result.current.loading).toBe(true)
    await calculate()
    expect(api).toHaveBeenCalledTimes(1)
    view.rerender(props)
    expect(view.result.current.groups).toBe(props.groups)
    expect(view.result.current.loading).toBe(true)
    await calculate()
    expect(api).toHaveBeenCalledTimes(2)
    expect(view.result.current.groups[0].result?.effective.kweight).toBe(3)
  })

  it("restores saved results immediately on Auto, cancels the request and rejects its eventual response", async () => {
    const pending = deferred()
    api.mockReturnValueOnce(pending.promise)
    const props = options()
    const view = show(props)
    await calculate()
    const signal = api.mock.calls[0][3]!
    view.rerender({ ...props, kWeight: null })
    expect(signal.aborted).toBe(true)
    expect(view.result.current).toMatchObject({ loading: false, error: null })
    expect(view.result.current.groups).toBe(props.groups)
    await act(async () => { pending.resolve(transformed()) })
    await calculate()
    expect(view.result.current.groups).toBe(props.groups)
    expect(view.result.current.groups[0].result?.effective.kweight).toBe(2)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("returns no partial transforms when a group fails and retries the full displayed selection", async () => {
    api.mockResolvedValueOnce(transformed()).mockRejectedValueOnce(new Error("Project changed in another tab."))
    const props = options({ groups: [group(), group("Iron")] })
    const view = show(props)
    await calculate()
    expect(view.result.current.groups).toBe(props.groups)
    expect(view.result.current).toMatchObject({ loading: false, error: "Project changed in another tab." })
    serve()
    act(() => view.result.current.retry())
    expect(view.result.current).toMatchObject({ loading: true, error: null })
    await calculate()
    expect(api).toHaveBeenCalledTimes(4)
    expect(view.result.current.groups.every(sample => sample.result?.effective.kweight === 3)).toBe(true)
    expect(view.result.current.error).toBeNull()
  })

  it.each([
    ["project", { project_id: "other" }], ["version", { version: 3 }], ["group", { group_id: "Iron" }],
    ["weight", { kweight: 1 }], ["effective weight", { effective: { kweight: 1 } }],
    ["unordered axis", { arrays: { ...transformed().arrays, r: [0, 2, 1] } }],
    ["nonfinite component", { arrays: { ...transformed().arrays, chir_im: [1, Number.NaN, 1] } }],
    ["unpaired component", { arrays: { ...transformed().arrays, chir_mag: [1] } }],
    ["missing component", { arrays: { r: [0, 1, 2], chir_mag: [1, 2, 1] } }],
  ] satisfies [string, Partial<PlotWeightResult>][])("rejects a response with invalid %s", async (_, overrides) => {
    api.mockResolvedValueOnce(transformed(overrides))
    const props = options()
    const view = show(props)
    await calculate()
    expect(view.result.current.groups).toBe(props.groups)
    expect(view.result.current.loading).toBe(false)
    expect(view.result.current.error).toMatch(/does not match/)
  })

  it("validates back-transform components against q and cancels on unmount", async () => {
    api.mockResolvedValueOnce(transformed({ arrays: { ...transformed().arrays, chiq_pha: [0, 1] } }))
    const view = show(options({ space: "q" }))
    await calculate()
    expect(view.result.current.error).toMatch(/does not match/)
    const signal = api.mock.calls[0][3]!
    view.unmount()
    expect(signal.aborted).toBe(true)
  })
})
