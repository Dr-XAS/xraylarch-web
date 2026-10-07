import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { artemisApi } from "@/lib/artemis"
import type { AthenaGroup } from "@/lib/athena"
import { simulationFixture } from "@/tests/fixtures/artemis-simulation"
import { ArtemisFitResultViewer } from "./artemis-fit-result-viewer"
import type { ArtemisTheoryResult } from "./artemis-theory-result"

type PlotProps = { data: { name: string; y: number[]; customdata: number[][] }[]; layout: { shapes: unknown[]; yaxis: { title: { text: string } } } }
const plot = vi.hoisted(() => vi.fn((_props: PlotProps) => <div data-testid="theory-plot" />))
vi.mock("next/dynamic", () => ({ default: () => plot }))
vi.mock("@/lib/artemis", async original => ({ ...await original<typeof import("@/lib/artemis")>(), artemisApi: vi.fn() }))
const api = vi.mocked(artemisApi)

function group(id = "theory"): AthenaGroup {
  const simulation = simulationFixture()
  return { id, label: id, data_type: "chi", energy: simulation.k.x, mu: simulation.k.chi,
    marked: true, frozen: false, multiplier: 1, offset: 0, notes: "", reference_id: null, result: null,
    processing_error: null, source: { tags: ["theory"], simulation: simulation.simulation, feff: simulation.source },
    parameters: { e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null,
      flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1,
      kmin: 3, kmax: 12, kweight: 2, dk: 2, window: "hanning", rmin: 1, rmax: 3, dr: 0,
      rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05 } }
}
function result(id = "theory", weight = 2): ArtemisTheoryResult {
  const simulation = simulationFixture()
  return { ...simulation, project_id: "p", group_id: id, group_label: id, version: 4,
    k: { ...simulation.k, weight, total: simulation.k.x.map((k, i) => simulation.k.chi[i] * k ** weight) },
    paths: simulation.paths.map(path => ({ ...path, k: { chi: simulation.k.x.map((k, i) => simulation.k.chi[i] * k ** weight) } })) }
}
function lastPlot() { return plot.mock.calls.at(-1)![0] }
async function calculate() { await act(async () => { await vi.advanceTimersByTimeAsync(150) }) }
function deferred() {
  let resolve!: (value: ArtemisTheoryResult) => void
  const promise = new Promise<ArtemisTheoryResult>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers(); api.mockReset(); plot.mockClear(); localStorage.clear()
  api.mockImplementation(async (path, body) => result(path.split("/")[4], (body as { kweight: number | null }).kweight ?? 2))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("theory spectra in the EXAFS viewer", () => {
  it("shows total and individual paths, signed Fourier components and supplied values without fit statistics", async () => {
    render(<ArtemisFitResultViewer projectId="p" version={4} group={group()} />)
    expect(screen.getByText("Loading theory path contributions…")).toBeInTheDocument()
    await calculate()
    expect(screen.getByRole("region", { name: "EXAFS theory results" })).toBeInTheDocument()
    expect(screen.getByText("No fit performed")).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Fit report" })).not.toBeInTheDocument()
    expect(screen.queryByText("R factor")).not.toBeInTheDocument()
    expect(screen.queryByText(/Parameter correlations/)).not.toBeInTheDocument()
    expect(lastPlot().data.map(trace => trace.name)).toEqual(["Total theory", "Path 1 · feff0001.dat"])
    expect(lastPlot().layout.shapes).toEqual([])
    expect(screen.getByRole("checkbox", { name: "Show paths" })).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Imaginary" }))
    expect(lastPlot().data[0].y).toEqual(result().r.total_im)
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    expect(lastPlot().data[0].y).toEqual(result().k.total)
    expect(lastPlot().layout.shapes).toHaveLength(1)
    fireEvent.click(screen.getByRole("checkbox", { name: "Offset plot" }))
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offset spacing" }), { target: { value: "2" } })
    expect(lastPlot().data[0].y).toEqual(result().k.total)
    expect(lastPlot().data[1].y).toEqual(result().paths[0].k.chi.map(value => value - 2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Show paths" }))
    expect(lastPlot().data).toHaveLength(1)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0][0]).toBe("/projects/p/groups/theory/simulation-view")
  })

  it("changes display weights including zero and four without changing the saved recipe", async () => {
    const source = group(), before = JSON.stringify(source)
    render(<ArtemisFitResultViewer projectId="p" version={4} group={source} />)
    await calculate()
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    for (const weight of [0, 4, 2]) {
      fireEvent.change(screen.getByLabelText("EXAFS theory k-weight"), { target: { value: String(weight) } })
      await calculate()
      expect(lastPlot().data[0].y).toEqual(result("theory", weight).k.total)
      expect(lastPlot().layout.yaxis.title.text).toContain(`k<sup>${weight}</sup>`)
      expect(screen.getByLabelText("EXAFS theory k-weight")).toHaveValue(String(weight))
    }
    expect(JSON.stringify(source)).toBe(before)
    expect(api.mock.calls.every(([url]) => url.endsWith("/simulation-view"))).toBe(true)
  })

  it("does not show a previous theory when group requests finish out of order", async () => {
    const first = deferred(), second = deferred()
    api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(<ArtemisFitResultViewer projectId="p" version={4} group={group("first")} />)
    await calculate()
    view.rerender(<ArtemisFitResultViewer projectId="p" version={4} group={group("second")} />)
    await calculate()
    await act(async () => second.resolve(result("second")))
    expect(screen.getByText(/second · theory/)).toBeInTheDocument()
    await act(async () => first.resolve(result("first")))
    expect(screen.queryByText(/first · theory/)).not.toBeInTheDocument()
    expect(screen.getByText(/second · theory/)).toBeInTheDocument()
    view.rerender(<ArtemisFitResultViewer projectId="p" version={4} group={{ ...group("measured"), source: {} }} />)
    expect(screen.queryByText("No fit performed")).not.toBeInTheDocument()
    expect(screen.getByText("No fit result")).toBeInTheDocument()
  })

  it("reports missing sources, retries, and rejects mismatched responses", async () => {
    api.mockRejectedValueOnce(new Error("This spectrum has no saved EXAFS simulation sources for path contributions."))
    api.mockResolvedValueOnce(result("wrong-group"))
    render(<ArtemisFitResultViewer projectId="p" version={4} group={group()} />)
    await calculate()
    expect(screen.getByRole("alert")).toHaveTextContent("no saved EXAFS simulation sources")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await calculate()
    expect(screen.getByRole("alert")).toHaveTextContent("do not match")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await calculate()
    expect(screen.getByText("No fit performed")).toBeInTheDocument()
  })

  it("waits for project processing before requesting contributions", async () => {
    const view = render(<ArtemisFitResultViewer projectId="p" version={4} group={group()} pending />)
    await calculate()
    expect(api).not.toHaveBeenCalled()
    expect(screen.getByText("Waiting for spectrum processing…")).toBeInTheDocument()
    view.rerender(<ArtemisFitResultViewer projectId="p" version={4} group={group()} />)
    await calculate()
    expect(screen.getByText("No fit performed")).toBeInTheDocument()
  })
})
