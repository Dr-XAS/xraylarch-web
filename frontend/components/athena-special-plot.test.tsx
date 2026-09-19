import "@testing-library/jest-dom/vitest"

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type Plot from "react-plotly.js"
import { athenaApi, type AthenaGroup, type Parameters } from "@/lib/athena"
import { AthenaSpecialPlot, type AthenaSpecialPlotKind, type ShortcutPlot } from "./athena-special-plot"

type Handoff = { data: { x: number[]; y: number[]; name: string; line: { color: string } }[]; layout: { xaxis: { title: { text: string }; range?: number[] }; yaxis: { title: { text: string } } } }
const plotly = vi.hoisted(() => vi.fn((_props: ComponentProps<typeof Plot>) => null))
vi.mock("next/dynamic", () => ({ default: () => plotly }))
vi.mock("@/lib/athena", async original => ({ ...await original<typeof import("@/lib/athena")>(), athenaApi: vi.fn() }))

const api = vi.mocked(athenaApi)
const parameters: Parameters = {
  e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null,
  flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1,
  kmin: 0, kmax: 3, kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 2, nfft: 2048, kstep: 0.05,
}

function group(id = "Copper", marked = true): AthenaGroup {
  return { id, label: id, marked, frozen: false, data_type: "mu", energy: [10, 20, 30], mu: [1, 2, 3],
    multiplier: 1, offset: 0, notes: "", reference_id: null, parameters: { ...parameters }, processing_error: null,
    source: { raw_arrays: { i0: [100, 200, 300], signal: [10, 20, 30] } },
    result: { effective: { e0: 22, edge_step: 2, kweight: 2, exafs: true }, warnings: [], arrays: {
      energy: [12, 22, 32], mu: [1, 2, 3], norm: [0, 0.5, 1], dmude: [0.01, 0.2, -0.05],
      k: [0, 1, 2, 3], chi: [0, 2, -1, 1], weighted_chi: [0, 2, -4, 9],
      r: [0, 1, 2], chir_mag: [2, 4, 2], chir_re: [-2, 4, -2],
      q: [0, 1, 2], chiq_mag: [1, 3, 1], chiq_re: [-1, 3, -1],
    } },
  }
}

type Options = ShortcutPlot["options"]
function response(options: Options, change?: (value: ShortcutPlot) => void): ShortcutPlot {
  const triple = options.kind === "k123" || options.kind === "r123"
  const curves: ShortcutPlot["result"]["curves"] = triple
    ? [1, 2, 3].map((weight, index) => ({ group_id: options.group_ids[0], name: `Copper · k-weight ${weight}`,
      x: [1, 2, 3], y: [index + 1, index + 2, index + 3], kweight: weight, scale: 1, effective_scale: 1, offset: 0 }))
    : options.group_ids.map((id, index) => ({ group_id: id, name: `${id} · ${options.kind}`,
      x: [1, 2, 3], y: [index + 1, index + 2, index + 3], scale: 1, effective_scale: 1, offset: 0 }))
  const value: ShortcutPlot = { project_id: "project", version: options.version, options, result: {
    group_ids: options.group_ids, curves, notes: ["Native diagnostic note"], skipped: [],
    x_label: options.kind === "e00" ? "E − E₀ (eV)" : "Energy (eV)", y_label: "Diagnostic signal", x_range: null,
  } }
  change?.(value)
  return value
}
function serve(change?: (value: ShortcutPlot) => void) {
  api.mockImplementation(async (_path, body) => response(body as Options, change))
}
function show(kind: AthenaSpecialPlotKind, groups = [group()], active = groups[0], extra: Partial<ComponentProps<typeof AthenaSpecialPlot>> = {}) {
  return render(<AthenaSpecialPlot kind={kind} groups={groups} active={active} projectId="project" version={5} {...extra} />)
}
function handoff(): Handoff {
  const props = plotly.mock.calls.at(-1)?.[0]
  if (!props) throw new Error("No Plotly handoff")
  return props as Handoff
}
async function ready(curves: number) {
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`${curves} shortcut curves`))
}

beforeEach(() => { vi.clearAllMocks(); api.mockReset() })
afterEach(cleanup)

describe("AthenaSpecialPlot", () => {
  it("requests server-calculated current-group curves with all display options and renders them", async () => {
    serve()
    const current = group("Current", false)
    show("i0sig", [group("Other"), current], current, { energyMode: "flat", component: "im", offset: 2 })
    await ready(1)
    expect(api).toHaveBeenCalledWith("/projects/project/plots/shortcut", {
      version: 5, kind: "i0sig", group_ids: ["Current"], energy_mode: "flat", component: "im", stack_offset: 2,
    }, "POST", expect.any(AbortSignal))
    expect(handoff().data).toEqual([expect.objectContaining({ name: "Current · i0sig", x: [1, 2, 3], y: [1, 2, 3] })])
    expect(handoff().layout.xaxis.title.text).toBe("Energy (eV)")
    expect(screen.getByText("Native diagnostic note")).toBeInTheDocument()
  })

  it("uses marked groups in project order and renders backend skip explanations", async () => {
    serve(value => { value.result.skipped = [{ group_id: "Second", label: "Second", channel: "i0", reason: "No retained I₀ channel." }] })
    const first = group("First"), hidden = group("Hidden", false), second = group("Second")
    show("i0", [first, hidden, second], hidden)
    await ready(2)
    expect((api.mock.calls[0][1] as Options).group_ids).toEqual(["First", "Second"])
    expect(screen.getByText("Second · i0: No retained I₀ channel.")).toBeInTheDocument()
  })

  it("passes E₀-at-zero, edge-step and three-weight shortcut options to the backend", async () => {
    serve()
    const first = group("First"), second = group("Second")
    const rendered = show("e00", [first, second], first, { energyMode: "mu" })
    await ready(2)
    expect((api.mock.calls.at(-1)![1] as Options)).toMatchObject({ kind: "e00", group_ids: ["First", "Second"], energy_mode: "mu" })
    rendered.rerender(<AthenaSpecialPlot kind="r123" groups={[first, second]} active={second} projectId="project" version={5} component="re" />)
    await ready(3)
    expect((api.mock.calls.at(-1)![1] as Options)).toMatchObject({ kind: "r123", group_ids: ["Second"], component: "re" })
    expect(handoff().data.map(curve => curve.name)).toEqual(["Copper · k-weight 1", "Copper · k-weight 2", "Copper · k-weight 3"])
  })

  it("rejects malformed server responses and supports retrying", async () => {
    let attempt = 0
    api.mockImplementation(async (_path, body) => response(body as Options, value => {
      if (attempt++ === 0) value.result.group_ids = ["elsewhere"]
    }))
    show("normderiv")
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match this project")
    expect(plotly).not.toHaveBeenCalled()
    await act(async () => screen.getByRole("button", { name: "Replot shortcut" }).click())
    await ready(1)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it("rejects nonfinite response signals before Plotly receives them", async () => {
    serve(value => { value.result.curves[0].y[1] = Number.NaN })
    show("normderiv")
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match this project")
    expect(plotly).not.toHaveBeenCalled()
  })

  it("rejects malformed labels, notes, skipped rows and plot ranges before rendering", async () => {
    serve(value => {
      value.result.notes = [42 as unknown as string]
      value.result.x_range = [4, 1]
      value.result.skipped = [{ group_id: "elsewhere", label: 42 as unknown as string, reason: null as unknown as string }]
    })
    show("normderiv")
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match this project")
    expect(plotly).not.toHaveBeenCalled()
  })

  it("discards an obsolete response and aborts the request when selection changes", async () => {
    let resolve!: (value: ShortcutPlot) => void
    api.mockImplementation((_path, _body) => new Promise<ShortcutPlot>(done => { resolve = done }))
    const first = group("First"), second = group("Second")
    const rendered = show("k123", [first, second], first)
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    const firstSignal = api.mock.calls[0][3]!
    serve()
    rendered.rerender(<AthenaSpecialPlot kind="i0sig" groups={[first, second]} active={second} projectId="project" version={5} />)
    await ready(1)
    await act(async () => resolve(response({ version: 5, kind: "k123", group_ids: ["First"], energy_mode: "norm", component: "mag", stack_offset: 0 })))
    expect(firstSignal.aborted).toBe(true)
    expect(handoff().data[0].name).toBe("Second · i0sig")
  })

  it("routes both Quad shortcuts to the shared diagnostic backend with correct scope", async () => {
    api.mockImplementation(async (_path, body) => {
      const options = body as { view: string; group_ids: string[]; version: number }
      return { project_id: "project", version: 5, options, result: { group_ids: options.group_ids, kweight: 2, notes: [],
        panels: ["E", "k", "R", "q"].map((id, i) => ({ id, title: id, x_label: id, y_label: "Signal", x_range: null,
          curves: Array.from({ length: options.view === "biquad" ? 2 : [4, 1, 2, 1][i] }, (_, j) => ({ group_id: options.group_ids[options.view === "biquad" ? j : 0], name: `${id}-${j}`, x: [1, 2, 3], y: [1, 2, 3] })) })) } }
    })
    const current = group("Current", false), first = group("First"), second = group("Second"), groups = [first, current, second]
    const rendered = show("quad", groups, current)
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("4 diagnostic panels"))
    expect(api).toHaveBeenLastCalledWith("/projects/project/plots/special", expect.objectContaining({ view: "quad", group_ids: ["Current"] }), "POST", expect.any(AbortSignal))
    rendered.rerender(<AthenaSpecialPlot kind="biquad" groups={groups} active={current} projectId="project" version={5} />)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("/projects/project/plots/special", expect.objectContaining({ view: "biquad", group_ids: ["First", "Second"] }), "POST", expect.any(AbortSignal)))
  })

  it("requires a current selection or exactly two marked groups before making a request", () => {
    const rendered = show("biquad", [group("Only")])
    expect(screen.getByRole("status")).toHaveTextContent("Mark exactly two groups")
    expect(api).not.toHaveBeenCalled()
    rendered.unmount()
    show("i0", [group("Unmarked", false)], undefined)
    expect(screen.getByRole("status")).toHaveTextContent("Mark groups")
    expect(api).not.toHaveBeenCalled()
  })

  it("keeps complete accessible labels and toggles curve visibility without recalculating", async () => {
    serve()
    show("r123")
    await ready(3)
    const legend = screen.getByRole('list', { name: 'Shortcut curve legend' })
    expect(legend).toHaveTextContent('Copper · k-weight 1')
    const toggle = screen.getByRole('button', { name: 'Copper · k-weight 1' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await act(async () => toggle.click())
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(plotly.mock.calls.at(-1)![0].data[0].visible).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    await act(async () => toggle.click())
    expect(plotly.mock.calls.at(-1)![0].data[0].visible).toBe(true)
  })

  it.each(['project', 'version', 'weights', 'range', 'grid'])("rejects a response with the wrong %s", async damage => {
    serve(value => {
      if (damage === 'project') value.project_id = 'another-project'
      if (damage === 'version') value.version++
      if (damage === 'weights') value.result.curves[1].kweight = 1
      if (damage === 'range') value.result.x_range = [10, 1]
      if (damage === 'grid') value.result.curves[0].x[1] = value.result.curves[0].x[0]
    })
    show('r123')
    expect(await screen.findByRole('alert')).toHaveTextContent('does not match this project')
    expect(plotly).not.toHaveBeenCalled()
  })
})
