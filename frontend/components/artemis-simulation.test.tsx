import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { artemisApi } from "@/lib/artemis"
import { ApiRequestError } from "@/lib/backend-client"
import { downloadArtemisText } from "@/lib/artemis-structures"
import { simulationFixture, simulationJob } from "@/tests/fixtures/artemis-simulation"
import type { SimulationRequest } from "@/lib/artemis-simulation"
import { ArtemisSimulation } from "./artemis-simulation"
import { InstructionVisibility } from "./section-help"

vi.mock("@/lib/artemis", () => ({ artemisApi: vi.fn() }))
vi.mock("@/lib/artemis-structures", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/artemis-structures")>(), downloadArtemisText: vi.fn() }))
vi.mock("./themed-plot", () => ({ ThemedPlot: () => <div data-testid="simulation-plot" /> }))
const api = vi.mocked(artemisApi)
beforeEach(() => { vi.clearAllMocks(); api.mockImplementation(async url => url.endsWith("/simulate") ? simulationFixture() : simulationJob) })
afterEach(() => { cleanup(); vi.useRealTimers() })
function SimulationHarness({ onAddToDataList }: { onAddToDataList?: (result: ReturnType<typeof simulationFixture>, idempotencyKey: string) => Promise<void> }) {
  return <ArtemisSimulation feffRequest={simulationJob.request} disabled={false} onAddToDataList={onAddToDataList} />
}
const selectFixed = () => fireEvent.change(screen.getByLabelText("Simulation disorder model"), { target: { value: "fixed" } })
const renderSimulation = (onAddToDataList?: (result: ReturnType<typeof simulationFixture>, idempotencyKey: string) => Promise<void>) => {
  const view = render(<SimulationHarness onAddToDataList={onAddToDataList} />)
  selectFixed()
  return view
}
const run = () => fireEvent.click(screen.getByRole("button", { name: "Run EXAFS simulation" }))

describe("CIF simulation controls", () => {
  it("defaults to Debye at 298 K, requires material ΘD, and reuses FEFF when temperature changes", async () => {
    api.mockImplementation(async (url, body) => {
      if (!url.endsWith("/simulate")) return simulationJob
      const result = simulationFixture()
      result.simulation.request = body as SimulationRequest
      result.paths[0].values.sigma2 = 0.005
      return result
    })
    render(<SimulationHarness />)
    expect(screen.getByLabelText("Simulation disorder model")).toHaveValue("debye")
    expect(screen.getByLabelText("Simulation Temperature (K)")).toHaveValue(298)
    expect(screen.getByLabelText("Simulation Debye temperature ΘD (K)")).toHaveValue(null)
    expect(screen.queryByLabelText("Simulation σ² (Å²)")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Simulation Debye temperature ΘD (K)"), { target: { value: "350" } })
    run(); await screen.findByTestId("simulation-plot")
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining("/simulate"), expect.objectContaining({ disorder_model: "debye", temperature: 298, debye_temperature: 350, static_sigma2: 0 }), expect.any(AbortSignal))
    fireEvent.change(screen.getByLabelText("Simulation Temperature (K)"), { target: { value: "100" } })
    expect(screen.queryByTestId("simulation-plot")).not.toBeInTheDocument()
    run(); await screen.findByTestId("simulation-plot")
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining("/simulate"), expect.objectContaining({ temperature: 100 }), expect.any(AbortSignal))
    expect(api.mock.calls.filter(([url]) => url === "/feff/jobs")).toHaveLength(1)
    selectFixed()
    expect(screen.queryByTestId("simulation-plot")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Simulation Temperature (K)")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Simulation σ² (Å²)")).toHaveValue(0.003)
  })
  it("exposes physical scalar limits and blocks invalid disorder before calculation", () => {
    renderSimulation()
    const disorder = screen.getByRole("spinbutton", { name: "Simulation σ² (Å²)" })
    expect(disorder).toHaveAttribute("min", "0")
    expect(disorder).toHaveAttribute("max", "0.1")
    expect(screen.getByRole("spinbutton", { name: "Simulation ΔE₀ (eV)" })).toHaveAttribute("min", "-50")
    expect(screen.getByRole("spinbutton", { name: "Simulation FT k max (Å⁻¹)" })).toHaveAttribute("max", "20")
    fireEvent.change(disorder, { target: { value: "-0.01" } })
    expect(screen.getByRole("status")).toHaveTextContent("sigma2: enter a number from 0 to 0.1")
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeDisabled()
    expect(api).not.toHaveBeenCalled()
  })
  it("shows instructions for each input only when enabled, without requesting a simulation", () => {
    const panel = (visible: boolean) => <InstructionVisibility.Provider value={visible}>
      <ArtemisSimulation feffRequest={simulationJob.request} disabled={false} />
    </InstructionVisibility.Provider>
    const view = render(panel(false))
    selectFixed()
    expect(screen.queryByRole("button", { name: /^About / })).not.toBeInTheDocument()
    view.rerender(panel(true))
    for (const name of ["Simulation S₀²", "Simulation σ² (Å²)", "Simulation ΔE₀ (eV)", "Simulation ΔR (Å)", "Simulation FT k min (Å⁻¹)", "Simulation FT k max (Å⁻¹)", "Simulation FT dk (Å⁻¹)", "Simulation k-weight", "Simulation window"])
      expect(screen.getByRole("button", { name: `About ${name}` })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "About Simulation σ² (Å²)" }))
    expect(screen.getByRole("tooltip")).toHaveTextContent("not derived from CIF displacement factors")
    expect(screen.getByLabelText("Simulation σ² (Å²)")).toHaveValue(0.003)
    view.rerender(panel(false))
    expect(screen.queryByRole("button", { name: /^About / })).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })
  it("simulates all paths without a measured group, then switches views and exports without recalculation", async () => {
    renderSimulation()
    expect(api).not.toHaveBeenCalled()
    run()
    await screen.findByTestId("simulation-plot")
    expect(screen.getByLabelText("Simulation S₀²")).toHaveValue(0.85)
    expect(api).toHaveBeenCalledWith(`/feff/jobs/${simulationJob.id}/simulate`, expect.objectContaining({ path_ids: null, s02: 0.85, sigma2: 0.003 }), expect.any(AbortSignal))
    fireEvent.click(screen.getByRole("button", { name: "Download χ(k) CSV" }))
    expect(downloadArtemisText).toHaveBeenCalledWith(expect.stringContaining("simulation-k.csv"), expect.stringContaining("0,0.125,0\n"), "text/csv")
    fireEvent.click(screen.getByRole("button", { name: "|χ(R)|" }))
    fireEvent.click(screen.getByRole("button", { name: "Download χ(R) CSV" }))
    fireEvent.click(screen.getByRole("button", { name: "Download simulation JSON" }))
    expect(api).toHaveBeenCalledTimes(2)
    expect(downloadArtemisText).toHaveBeenLastCalledWith(expect.stringContaining(".json"), expect.stringContaining('"cif": "data_copper"'), "application/json")
  })
  it("invalidates completed curves when assumptions change", async () => {
    renderSimulation(); run(); await screen.findByTestId("simulation-plot")
    fireEvent.change(screen.getByLabelText("Simulation σ² (Å²)"), { target: { value: "0.009" } })
    expect(screen.queryByTestId("simulation-plot")).not.toBeInTheDocument()
    expect(screen.queryByText("Download simulation JSON")).not.toBeInTheDocument()
  })
  it("ignores late results and permits retry when returning to the original inputs", async () => {
    let resolve!: (value: unknown) => void
    api.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    renderSimulation(); run()
    const signal = api.mock.calls[0][2]!
    fireEvent.change(screen.getByLabelText("Simulation S₀²"), { target: { value: "0.9" } })
    expect(signal.aborted).toBe(false)
    fireEvent.change(screen.getByLabelText("Simulation S₀²"), { target: { value: "0.85" } })
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeEnabled()
    await act(async () => resolve(simulationJob))
    expect(screen.queryByTestId("simulation-plot")).not.toBeInTheDocument()
    run(); await screen.findByTestId("simulation-plot")
  })
  it("shows failures and retries", async () => {
    api.mockRejectedValueOnce(new Error("FEFF job expired"))
    renderSimulation(); run()
    expect(await screen.findByRole("alert")).toHaveTextContent("expired")
    fireEvent.click(screen.getByRole("button", { name: "Retry EXAFS simulation" }))
    await screen.findByTestId("simulation-plot")
  })
  it("requires valid structure settings and never offers path selection", () => {
    render(<ArtemisSimulation feffRequest={null} disabled={false} />)
    expect(screen.queryByLabelText("Simulation paths")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeDisabled()
    expect(api).not.toHaveBeenCalled()
  })
  it("calculates and polls paths automatically before summing all of them", async () => {
    vi.useFakeTimers()
    api.mockResolvedValueOnce({ ...simulationJob, status: "running", paths: [] })
    renderSimulation()
    await act(async () => run())
    expect(screen.getByRole("status")).toHaveTextContent("Calculating scattering paths")
    expect(api).toHaveBeenCalledWith("/feff/jobs", expect.objectContaining({ max_paths: null }), expect.any(AbortSignal))
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(screen.getByTestId("simulation-plot")).toBeVisible()
    expect(api.mock.calls.map(([url]) => url)).toEqual(["/feff/jobs", `/feff/jobs/${simulationJob.id}`, `/feff/jobs/${simulationJob.id}/simulate`])
  })
  it("reuses a running job across scalar edits and reconnects after a failed poll", async () => {
    vi.useFakeTimers()
    api.mockResolvedValueOnce({ ...simulationJob, status: "running", paths: [] })
    renderSimulation()
    await act(async () => run())
    fireEvent.change(screen.getByLabelText("Simulation S₀²"), { target: { value: "0.9" } })
    fireEvent.change(screen.getByLabelText("Simulation S₀²"), { target: { value: "0.85" } })
    await act(async () => run())
    expect(api.mock.calls.filter(([url]) => url === "/feff/jobs")).toHaveLength(1)
    api.mockRejectedValueOnce(new Error("Connection interrupted"))
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(screen.getByRole("alert")).toHaveTextContent("Connection interrupted")
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry EXAFS simulation" })))
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(screen.getByTestId("simulation-plot")).toBeVisible()
    expect(api.mock.calls.filter(([url]) => url === "/feff/jobs")).toHaveLength(1)
  })
  it("starts a new calculation when the cached running job has expired", async () => {
    vi.useFakeTimers()
    api.mockResolvedValueOnce({ ...simulationJob, status: "running", paths: [] })
    renderSimulation()
    await act(async () => run())
    api.mockRejectedValueOnce(new ApiRequestError({ code: "invalid_feff", message: "Job expired", fields: ["job"], recovery: "Retry" }, 400))
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(screen.getByRole("alert")).toHaveTextContent("Job expired")
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry EXAFS simulation" })))
    expect(screen.getByTestId("simulation-plot")).toBeVisible()
    expect(api.mock.calls.filter(([url]) => url === "/feff/jobs")).toHaveLength(2)
  })
  it.each([
    { ...simulationJob, truncated: true, total_paths: 2 },
    { ...simulationJob, total_paths: 2 },
    { ...simulationJob, request: { ...simulationJob.request, path_radius: 4 } },
    { ...simulationJob, status: "failed", message: "Scattering calculation failed" },
  ])("refuses incomplete, mismatched or failed scattering calculations", async job => {
    api.mockResolvedValueOnce(job)
    renderSimulation(); run()
    await screen.findByRole("alert")
    expect(api.mock.calls.some(([url]) => url.endsWith("/simulate"))).toBe(false)
    expect(screen.queryByTestId("simulation-plot")).not.toBeInTheDocument()
  })
  it("invalidates results on radius changes but preserves them after a version-only save", async () => {
    const view = render(<ArtemisSimulation feffRequest={simulationJob.request} disabled={false} />)
    selectFixed()
    run(); await screen.findByTestId("simulation-plot")
    view.rerender(<ArtemisSimulation feffRequest={{ ...simulationJob.request, version: 4 }} disabled={false} />)
    expect(screen.getByTestId("simulation-plot")).toBeVisible()
    view.rerender(<ArtemisSimulation feffRequest={{ ...simulationJob.request, path_radius: 5 }} disabled={false} />)
    expect(screen.queryByTestId("simulation-plot")).not.toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(2)
  })
  it("adds the completed raw spectrum once, and hides the action after edits", async () => {
    let finish!: () => void
    const add = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    renderSimulation(add)
    expect(screen.queryByRole("button", { name: "Add to data list" })).not.toBeInTheDocument()
    run(); await screen.findByTestId("simulation-plot")
    fireEvent.click(screen.getByRole("button", { name: "Add to data list" }))
    expect(add).toHaveBeenCalledWith(simulationFixture(), expect.any(String))
    expect(screen.getByRole("button", { name: "Adding spectrum…" })).toBeDisabled()
    expect(screen.getByLabelText("Simulation S₀²")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeDisabled()
    await act(async () => finish())
    expect(screen.getByRole("button", { name: "Added to data list" })).toBeDisabled()
    expect(screen.getByText("Spectrum added · theory")).toBeVisible()
    expect(add).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText("Simulation ΔR (Å)"), { target: { value: "0.01" } })
    expect(screen.queryByRole("button", { name: /data list/ })).not.toBeInTheDocument()
  })
  it("retains completed curves after an add failure and reuses the retry key", async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error("Project changed; retry after refresh")).mockResolvedValueOnce(undefined)
    renderSimulation(add); run(); await screen.findByTestId("simulation-plot")
    fireEvent.click(screen.getByRole("button", { name: "Add to data list" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Project changed")
    expect(screen.getByTestId("simulation-plot")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Add to data list" }))
    await screen.findByRole("button", { name: "Added to data list" })
    expect(add.mock.calls[1]).toEqual(add.mock.calls[0])
    expect(api).toHaveBeenCalledTimes(2)
  })
})
