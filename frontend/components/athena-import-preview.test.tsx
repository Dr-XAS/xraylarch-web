import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AthenaImportPreview } from "./athena-import-preview"
import { defaultRebin, type ColumnMapping, type ColumnPreview } from "@/lib/athena-import"

const { api, plot } = vi.hoisted(() => ({ api: vi.fn(), plot: vi.fn() }))
vi.mock("@/lib/athena", () => ({ athenaApi: api }))
vi.mock("next/dynamic", () => ({ default: () => (props: unknown) => { plot(props); return <div data-testid="plotly" /> } }))
const mapping: ColumnMapping = { energy_column: "c0", numerator: ["c1"], denominator: "c2", mode: "transmission", units: "eV",
  data_type: "mu", reference_numerator: "", reference_denominator: "", sort: false }
const response: ColumnPreview = { filename: "sample.dat", points: 3, x_label: "Energy (eV)", y_label: "μ(E)", warnings: [],
  traces: [{ id: "sample", label: "Sample", role: "sample", x: [1, 2, 3], y: [.1, .5, .9] }] }
function value(y: number): ColumnPreview { return { ...response, traces: [{ ...response.traces[0], y: [y, y, y] }] } }
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
function props(change: Partial<ColumnMapping> = {}) { return { projectId: "p", version: 2, uploadId: "u", mapping: { ...mapping, ...change } } }
async function tick(ms = 180) { await act(() => vi.advanceTimersByTimeAsync(ms)) }
function handoff() { return plot.mock.calls.at(-1)![0] }
beforeEach(() => { vi.useFakeTimers(); api.mockReset().mockResolvedValue(response); plot.mockClear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe("live column preview", () => {
  it("debounces input and plots server values with matching axes without mutating them", async () => {
    const view = render(<AthenaImportPreview {...props()} />)
    await tick(100)
    view.rerender(<AthenaImportPreview {...props({ units: "keV", numerator: ["c2"], denominator: "c1", sort: true })} />)
    await tick(179)
    expect(api).not.toHaveBeenCalled()
    await tick(1)
    expect(api).toHaveBeenCalledExactlyOnceWith("/projects/p/preview-columns", {
      version: 2, upload_id: "u", ...mapping, units: "keV", numerator: ["c2"], denominator: "c1", sort: true,
      reference_numerator: null, reference_denominator: null,
      preprocessing: { mark: false, standard_id: null, copy_parameters: false, align: false },
    }, "POST", expect.any(AbortSignal))
    expect(handoff().data[0].y).toEqual(response.traces[0].y)
    expect(handoff().data[0].y).not.toBe(response.traces[0].y)
    expect(handoff().layout.xaxis.title.text).toBe("Energy (eV)")
    expect(screen.getByText(/3 source points/)).toHaveTextContent("all points displayed")
  })
  it.each(["resolve", "reject"] as const)("ignores an old request that %s after a newer selection", async completion => {
    const old = deferred<ColumnPreview>(), current = deferred<ColumnPreview>()
    api.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const view = render(<AthenaImportPreview {...props()} />)
    await tick()
    const signal = api.mock.calls[0][3] as AbortSignal
    view.rerender(<AthenaImportPreview {...props({ numerator: ["c3"] })} />)
    expect(signal.aborted).toBe(true)
    expect(screen.queryByTestId("plotly")).not.toBeInTheDocument()
    await tick()
    await act(async () => { current.resolve(value(2)) })
    await act(async () => { if (completion === "resolve") old.resolve(value(1)); else old.reject(new Error("old failure")) })
    expect(handoff().data[0].y).toEqual([2, 2, 2])
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("hides the preceding curve while updating, reports failures, and retries the same selection", async () => {
    api.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("The denominator contains zero detector counts.")).mockResolvedValueOnce(value(4))
    const view = render(<AthenaImportPreview {...props()} />)
    await tick()
    view.rerender(<AthenaImportPreview {...props({ denominator: "c4" })} />)
    expect(screen.queryByTestId("plotly")).not.toBeInTheDocument()
    await tick()
    expect(screen.getByRole("alert")).toHaveTextContent("zero detector counts")
    expect(screen.queryByTestId("plotly")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Replot" }))
    await tick()
    expect(handoff().data[0].y).toEqual([4, 4, 4])
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("holds the previous plot while paused, replots once, and resumes automatic refresh", async () => {
    api.mockResolvedValueOnce(value(1)).mockResolvedValueOnce(value(2)).mockResolvedValueOnce(value(3))
    const view = render(<AthenaImportPreview {...props()} />)
    await tick()
    const oldRevision = handoff().layout.uirevision
    fireEvent.click(screen.getByLabelText("Pause plotting"))
    view.rerender(<AthenaImportPreview {...props({ numerator: ["c3"] })} />)
    await tick(500)
    expect(api).toHaveBeenCalledTimes(1)
    expect(handoff().data[0].y).toEqual([1, 1, 1])
    expect(handoff().layout.uirevision).toBe(oldRevision)
    expect(screen.getByRole("status")).toHaveTextContent("previous column selection")
    fireEvent.click(screen.getByRole("button", { name: "Replot" }))
    await tick()
    expect(api).toHaveBeenCalledTimes(2)
    expect(handoff().data[0].y).toEqual([2, 2, 2])
    view.rerender(<AthenaImportPreview {...props({ numerator: ["c4"] })} />)
    await tick(500)
    expect(api).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByLabelText("Pause plotting"))
    await tick()
    expect(api).toHaveBeenCalledTimes(3)
    expect(handoff().data[0].y).toEqual([3, 3, 3])
  })
  it("cancels pending work on pause without claiming a nonexistent displayed curve", async () => {
    const old = deferred<ColumnPreview>(); api.mockReturnValueOnce(old.promise)
    render(<AthenaImportPreview {...props()} />)
    await tick()
    fireEvent.click(screen.getByLabelText("Pause plotting"))
    expect(api.mock.calls[0][3].aborted).toBe(true)
    await act(async () => { old.resolve(response) })
    expect(screen.queryByTestId("plotly")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).not.toHaveTextContent("displayed curve")
  })
  it("previews the constant numerator after clearing and aborts on unmount", async () => {
    const view = render(<AthenaImportPreview {...props()} />)
    await tick()
    view.rerender(<AthenaImportPreview {...props({ numerator: [] })} />)
    expect(api.mock.calls[0][3].aborted).toBe(true)
    await tick()
    expect(api).toHaveBeenCalledTimes(2)
    expect(api.mock.calls[1][1].numerator).toEqual([])
    expect(screen.getByTestId("plotly")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Replot" })).toBeEnabled()
    view.rerender(<AthenaImportPreview {...props()} />)
    await tick()
    view.unmount()
    expect(api.mock.calls[2][3].aborted).toBe(true)
  })
  it("isolates uploads and accepted versions and suspends requests while importing", async () => {
    const view = render(<AthenaImportPreview {...props()} disabled />)
    await tick()
    expect(api).not.toHaveBeenCalled()
    view.rerender(<AthenaImportPreview {...props()} />)
    await tick()
    view.rerender(<AthenaImportPreview {...props()} uploadId="next" version={3} />)
    expect(screen.queryByTestId("plotly")).not.toBeInTheDocument()
    await tick()
    expect(api.mock.calls[1][1]).toMatchObject({ upload_id: "next", version: 3 })
  })
  it("plots the reference separately and toggles it without another backend request", async () => {
    api.mockResolvedValue({ ...response, traces: [...response.traces, { ...response.traces[0], role: "reference", label: "Reference", id: "ref" }] })
    render(<AthenaImportPreview {...props({ reference_numerator: "c2", reference_denominator: "c3", reference_log: false, reference_same_element: false, individual_channels: true })} />)
    await tick()
    expect(api.mock.calls[0][1]).toMatchObject({ reference_log: false, reference_same_element: false, individual_channels: true })
    expect(handoff().data.map((t: { yaxis: string }) => t.yaxis)).toEqual(["y", "y2"])
    fireEvent.click(screen.getByLabelText("Plot reference"))
    expect(handoff().data).toHaveLength(1)
    await tick()
    expect(api).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText("Plot reference"))
    expect(handoff().data).toHaveLength(2)
  })
  it("uses chi axes and displays full-data warnings and extrema sampling information", async () => {
    api.mockResolvedValue({ ...response, points: 100000, x_label: "k (Å⁻¹)", y_label: "χ(k)", warnings: ["Duplicate energies need repair."] })
    render(<AthenaImportPreview {...props({ data_type: "chi", mode: "mu" })} />)
    await tick()
    expect(handoff().layout.xaxis.title.text).toBe("k (Å⁻¹)")
    expect(handoff().layout.yaxis.title.text).toBe("χ(k)")
    expect(screen.getByText(/display preserves local minima/)).toBeInTheDocument()
    expect(screen.getByText("Duplicate energies need repair.")).toBeInTheDocument()
  })
})

it("invalidates scaled previews and sends denominator sums, inversion and zero constants", async () => {
  const view = render(<AthenaImportPreview {...props()} />)
  await tick()
  view.rerender(<AthenaImportPreview {...props({ denominator: ["c2", "c3"], invert: true, signal_multiplier: 2.5 })} />)
  await tick()
  expect(api.mock.calls[1][1]).toMatchObject({ denominator: ["c2", "c3"], invert: true, signal_multiplier: 2.5 })
  view.rerender(<AthenaImportPreview {...props({ signal_multiplier: "" })} />)
  await tick()
  expect(api).toHaveBeenCalledTimes(2)
  expect(screen.getByRole("alert")).toHaveTextContent("finite multiplicative constant")
  expect(screen.queryByTestId("plotly")).not.toBeInTheDocument()
  view.rerender(<AthenaImportPreview {...props({ signal_multiplier: 0 })} />)
  await tick()
  expect(api.mock.calls[2][1]).toMatchObject({ signal_multiplier: 0 })
})

it('compares original and rebinned curves, hides originals without refetching, and refreshes grid edits', async () => {
  const rebinned = { ...response, points: 2006, traces: [
    { ...response.traces[0], id: 'original', stage: 'original', label: 'Sample · original' },
    { ...response.traces[0], id: 'rebin', stage: 'rebinned', label: 'Sample · rebinned', x: [1, 3], y: [.1, .9] },
  ], rebin_results: [{ id: 'rebin', label: 'Sample', role: 'sample', source_points: 2006, output_points: 396, e0: 17168.101 }] }
  api.mockResolvedValue(rebinned)
  const rebin = { ...defaultRebin, enabled: true }
  const view = render(<AthenaImportPreview {...props({ rebin })} />)
  await tick()
  expect(handoff().data).toHaveLength(2)
  expect(handoff().data[0]).toMatchObject({ opacity: .45, line: { dash: 'dot' } })
  expect(handoff().data[1].y).toEqual([.1, .9])
  expect(screen.getByText(/2,006 → 396/)).toHaveTextContent('17168.101 eV')
  fireEvent.click(screen.getByLabelText('Plot original data'))
  expect(handoff().data).toHaveLength(1)
  expect(handoff().data[0].name).toBe('Sample · rebinned')
  await tick()
  expect(api).toHaveBeenCalledTimes(1)
  view.rerender(<AthenaImportPreview {...props({ rebin: { ...rebin, xanes: '' } })} />)
  await tick()
  expect(screen.queryByTestId('plotly')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('finite rebin')
  expect(api).toHaveBeenCalledTimes(1)
  view.rerender(<AthenaImportPreview {...props({ rebin: { ...rebin, xanes: .25 } })} />)
  await tick()
  expect(api.mock.calls[1][1].rebin).toMatchObject({ xanes: .25 })
  expect(handoff().data).toHaveLength(1)
})
