import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { artemisApi } from "@/lib/artemis"
import type { ArtemisPreview, ArtemisPreviewRequest } from "@/lib/artemis-path-preview"
import { FeffPathViewer, type FeffPathSummary } from "./feff-path-viewer"

type PlotProps = { data: { x: number[]; y: number[]; name: string }[]; layout: { xaxis: { title: { text: string } }; yaxis: { title: { text: string } }; shapes: { x0: number; x1: number }[] } }
const plot = vi.hoisted(() => vi.fn((_props: PlotProps) => <div data-testid="contribution-plot" />))
vi.mock("next/dynamic", () => ({ default: () => plot }))
// The 3D scene has its own suite; here only the contribution curves and the path list matter.
vi.mock("../feff-path-scene", () => ({ FeffPathScene: ({ legend }: { legend: React.ReactNode }) => <div data-testid="scene">{legend}</div> }))
vi.mock("@/lib/artemis", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/artemis")>(), artemisApi: vi.fn() }))
const api = vi.mocked(artemisApi)

const site = (x: number, ipot = 1) => ({ atom: "Cu", x, y: 0, z: 0, ipot })
const summaries: FeffPathSummary[] = [
  { id: "cu1", filename: "feff0001.dat", label: "Cu first shell", enabled: true,
    metadata: { absorber: "Cu", edge: "K", reff: 2.56, degen: 12, nleg: 2, kmin: 0, kmax: 15, geometry: [site(0, 0), site(2.56)] } },
  { id: "cu2", filename: "feff0002.dat", label: "Cu triangle", enabled: true,
    metadata: { absorber: "Cu", edge: "K", reff: 3.41, degen: 48, nleg: 3, kmin: 0, kmax: 15, geometry: [site(0, 0), site(2), site(2.4)] } },
  { id: "cu3", filename: "feff0003.dat", label: "Cu fourth shell", enabled: true,
    metadata: { absorber: "Cu", edge: "K", reff: 5.11, degen: 6, nleg: 2, kmin: 0, kmax: 15, geometry: [site(0, 0), site(5.11)] } },
]
const transform: ArtemisPreviewRequest["transform"] = { fitspace: "r", kmin: 3, kmax: 12, kweight: [2], dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0 }
const model: ArtemisPreviewRequest = {
  parameters: [{ name: "amp", kind: "guess", value: 0.9, expression: "", min: null, max: null }], transform,
  paths: summaries.map(path => ({ id: path.id, label: path.label, filename: path.filename, content: "FEFF data",
    enabled: true, s02: "amp", e0: "0", deltar: "0", sigma2: "0.003" })),
}
// A small triangular χ(R) per path, large for the first shell and tiny for the
// distant one, so the amplitude filter has something real to act on.
const axis = [0, 1, 2, 3, 4]
function previewPath(path: FeffPathSummary, amplitude: number) {
  return { id: path.id, label: path.label, filename: path.filename, metadata: path.metadata,
    values: { s02: 0.9, e0: 0, deltar: 0, sigma2: 0.003 },
    k: { chi: axis.map(x => amplitude * Math.sin(x)) },
    r: { mag: axis.map(x => amplitude * Math.exp(-x)), re: axis.map(x => amplitude * Math.cos(x)), im: axis.map(x => amplitude * Math.sin(x)) },
    metrics: { amplitude, r_at_amplitude: path.metadata.reff - 0.4, window_area: amplitude * 2, chi_k_peak: amplitude / 2 } }
}
const amplitudes = [1, 0.3, 0.004]
const preview: ArtemisPreview = {
  paths: summaries.map((path, index) => previewPath(path, amplitudes[index])),
  warnings: [], transform,
  k: { x: axis, weight: 2, total: axis.map(x => Math.sin(x)) },
  r: { x: axis, total_mag: axis.map(x => 1.3 * Math.exp(-x)), total_re: axis, total_im: axis },
  metadata: { engine: "larch", kstep: 0.05, nfft: 2048, rwindow: "hanning", note: "", metrics: "" },
}

afterEach(() => { cleanup(); vi.resetAllMocks() })
const show = () => fireEvent.click(screen.getByRole("checkbox", { name: /Show χ\(k\) and χ\(R\) contributions/ }))
const rowNames = () => within(screen.getByRole("table", { name: /starting values/i }))
  .getAllByRole("rowheader").map(cell => cell.textContent?.slice(0, 12))
function view(overrides: Partial<Parameters<typeof FeffPathViewer>[0]> = {}) {
  return render(<FeffPathViewer paths={summaries} groupLabel="Copper foil" onOpenModel={vi.fn()} model={model} {...overrides} />)
}

describe("FEFF path contributions", () => {
  it("draws each path's own curve and the sum, and labels the axes for the plot k-weight", async () => {
    api.mockResolvedValue(preview)
    view()
    show()
    await waitFor(() => expect(plot).toHaveBeenCalled())
    expect(api).toHaveBeenCalledWith("/paths/preview", { parameters: model.parameters, paths: model.paths, transform }, expect.anything())
    const drawn = plot.mock.calls.at(-1)![0]
    expect(drawn.data.map(trace => trace.name)).toEqual(["Model · sum of all 3 included paths", "Cu first shell", "Cu triangle", "Cu fourth shell"])
    expect(drawn.data[0].y).toEqual(preview.r.total_mag)
    expect(drawn.data[1].y).toEqual(preview.paths[0].r.mag)
    expect(drawn.layout.xaxis.title.text).toContain("R (Å")
    expect(drawn.layout.yaxis.title.text).toContain("Å<sup>−3</sup>")
    // The shaded band must be the R window the fit uses, not the k window.
    expect(drawn.layout.shapes[0]).toMatchObject({ x0: 1, x1: 3 })
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    const inK = plot.mock.calls.at(-1)![0]
    expect(inK.data[1].y).toEqual(preview.paths[0].k.chi)
    expect(inK.layout.yaxis.title.text).toContain("k<sup>2</sup>χ(k)")
    expect(inK.layout.shapes[0]).toMatchObject({ x0: 3, x1: 12 })
  })

  it("asks the server once per model and not at all until the curves are wanted", async () => {
    api.mockResolvedValue(preview)
    const { rerender } = view()
    expect(api).not.toHaveBeenCalled()
    show()
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    rerender(<FeffPathViewer paths={summaries} groupLabel="Copper foil" onOpenModel={vi.fn()} model={{ ...model }} />)
    await waitFor(() => expect(plot).toHaveBeenCalled())
    expect(api).toHaveBeenCalledOnce()
  })

  it("recomputes when a starting value changes, so the curves never describe an older model", async () => {
    api.mockResolvedValue(preview)
    const { rerender } = view()
    show()
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    const changed = { ...model, paths: model.paths.map(path => ({ ...path, sigma2: "0.009" })) }
    rerender(<FeffPathViewer paths={summaries} groupLabel="Copper foil" onOpenModel={vi.fn()} model={changed} />)
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
  })

  it("reports a failed preview and retries on request instead of leaving an empty panel", async () => {
    api.mockRejectedValueOnce(new Error("Larch could not read feff0002.dat."))
    view()
    show()
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Larch could not read feff0002.dat.")
    api.mockResolvedValue(preview)
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(plot).toHaveBeenCalled())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("refuses curves that belong to another set of paths rather than mislabelling them", async () => {
    api.mockResolvedValue({ ...preview, paths: preview.paths.slice(0, 2) })
    view()
    show()
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match this model")
    expect(plot).not.toHaveBeenCalled()
  })

  it("lists every path's size before the curves exist and fills in the metrics afterwards", async () => {
    api.mockResolvedValue(preview)
    view()
    const table = screen.getByRole("table", { name: /starting values/i })
    expect(within(table).getAllByRole("row")).toHaveLength(4)
    expect(table).toHaveTextContent("2.56")
    expect(within(table).getAllByRole("cell").map(cell => cell.textContent)).toContain("—")
    show()
    await waitFor(() => expect(table).toHaveTextContent("0.004"))
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("2.16") // R at the peak of path 1
  })

  it("sorts by a column and reverses it on a second click", async () => {
    api.mockResolvedValue(preview)
    view()
    show()
    await waitFor(() => expect(plot).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: /Sort by Reff/ }))
    expect(rowNames()).toEqual(["feff0001.dat", "feff0002.dat", "feff0003.dat"])
    fireEvent.click(screen.getByRole("button", { name: /Sort by Reff/ }))
    expect(rowNames()).toEqual(["feff0003.dat", "feff0002.dat", "feff0001.dat"])
    fireEvent.click(screen.getByRole("button", { name: /Sort by Peak/ }))
    expect(rowNames()).toEqual(["feff0001.dat", "feff0002.dat", "feff0003.dat"])
    fireEvent.click(screen.getByRole("button", { name: /Sort by Path/ }))
    expect(rowNames()).toEqual(["feff0001.dat", "feff0002.dat", "feff0003.dat"])
  })

  it("filters the plot, the table and the legend together, so the three never disagree", async () => {
    api.mockResolvedValue(preview)
    view()
    show()
    await waitFor(() => expect(plot).toHaveBeenCalled())
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by legs" }), { target: { value: "multiple" } })
    expect(rowNames()).toEqual(["feff0002.dat"])
    expect(plot.mock.calls.at(-1)![0].data.map(trace => trace.name)).toEqual(["Full model · all 3 included paths", "Sum of shown paths · 1 of 3", "Cu triangle"])
    // The legend also holds its help icon; count the path toggles.
    expect(within(screen.getByRole("group", { name: "FEFF path legend" })).getAllByRole("button", { name: /^Show / })).toHaveLength(1)
    expect(screen.getByText("1 of 3 paths shown")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(rowNames()).toHaveLength(3)
    fireEvent.change(screen.getByRole("textbox", { name: "Filter by maximum Reff" }), { target: { value: "3" } })
    expect(rowNames()).toEqual(["feff0001.dat"])
    fireEvent.change(screen.getByRole("textbox", { name: "Filter by maximum Reff" }), { target: { value: "" } })
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by smallest peak amplitude" }), { target: { value: "0.05" } })
    expect(rowNames()).toEqual(["feff0001.dat", "feff0002.dat"])
  })

  it("sums only the shown paths under a filter, instead of labelling the full model as their sum", async () => {
    api.mockResolvedValue(preview)
    view()
    show()
    await waitFor(() => expect(plot).toHaveBeenCalled())
    // Reff at most 3.5 Å keeps the first shell and the triangle and hides the fourth shell.
    fireEvent.change(screen.getByRole("textbox", { name: "Filter by maximum Reff" }), { target: { value: "3.5" } })
    const traces = plot.mock.calls.at(-1)![0].data
    const sum = traces.find(trace => trace.name.startsWith("Sum of shown paths"))!
    // Complex parts add, then the magnitude: |1.3 e^{ix}| is 1.3 at every R.
    sum.y.forEach(value => expect(value).toBeCloseTo(1.3, 12))
    expect(traces.find(trace => trace.name.startsWith("Full model"))!.y).toEqual(preview.r.total_mag)
    fireEvent.click(screen.getByRole("button", { name: "Real" }))
    const real = plot.mock.calls.at(-1)![0].data.find(trace => trace.name.startsWith("Sum of shown paths"))!
    real.y.forEach((value, i) => expect(value).toBeCloseTo(1.3 * Math.cos(axis[i]), 12))
    fireEvent.click(screen.getByRole("button", { name: "k space" }))
    const inK = plot.mock.calls.at(-1)![0].data.find(trace => trace.name.startsWith("Sum of shown paths"))!
    inK.y.forEach((value, i) => expect(value).toBeCloseTo(1.3 * Math.sin(axis[i]), 12))
  })

  it("offers no curves while the fitting model cannot be read", () => {
    view({ model: null })
    expect(screen.queryByRole("checkbox", { name: /contributions/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Finish the fitting model/)).toBeVisible()
    expect(api).not.toHaveBeenCalled()
  })
})
