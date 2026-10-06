import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { artemisApi } from "@/lib/artemis"
import { downloadArtemisText } from "@/lib/artemis-structures"
import { simulationFixture, simulationJob } from "@/tests/fixtures/artemis-simulation"
import { ArtemisSimulation } from "./artemis-simulation"

vi.mock("@/lib/artemis", () => ({ artemisApi: vi.fn() }))
vi.mock("@/lib/artemis-structures", () => ({ downloadArtemisText: vi.fn() }))
vi.mock("./themed-plot", () => ({ ThemedPlot: () => <div data-testid="simulation-plot" /> }))
const api = vi.mocked(artemisApi)
beforeEach(() => { vi.clearAllMocks(); api.mockResolvedValue(simulationFixture()) })
afterEach(cleanup)
const renderSimulation = () => render(<ArtemisSimulation job={simulationJob} selectedIds={[]} disabled={false} />)
const run = () => fireEvent.click(screen.getByRole("button", { name: "Run EXAFS simulation" }))

describe("CIF simulation controls", () => {
  it("simulates all paths without a measured group, then switches views and exports without recalculation", async () => {
    renderSimulation()
    expect(api).not.toHaveBeenCalled()
    run()
    await screen.findByTestId("simulation-plot")
    expect(api).toHaveBeenCalledWith(`/feff/jobs/${simulationJob.id}/simulate`, expect.objectContaining({ path_ids: null, s02: 1, sigma2: 0.003 }), expect.any(AbortSignal))
    fireEvent.click(screen.getByRole("button", { name: "Download χ(k) CSV" }))
    expect(downloadArtemisText).toHaveBeenCalledWith(expect.stringContaining("simulation-k.csv"), expect.stringContaining("0,0.125,0\n"), "text/csv")
    fireEvent.click(screen.getByRole("button", { name: "|χ(R)|" }))
    fireEvent.click(screen.getByRole("button", { name: "Download χ(R) CSV" }))
    fireEvent.click(screen.getByRole("button", { name: "Download simulation JSON" }))
    expect(api).toHaveBeenCalledTimes(1)
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
    expect(signal.aborted).toBe(true)
    fireEvent.change(screen.getByLabelText("Simulation S₀²"), { target: { value: "1" } })
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeEnabled()
    await act(async () => resolve(simulationFixture()))
    expect(screen.queryByTestId("simulation-plot")).not.toBeInTheDocument()
    run(); await screen.findByTestId("simulation-plot")
  })
  it("shows failures and retries, but blocks an empty selection", async () => {
    api.mockRejectedValueOnce(new Error("FEFF job expired"))
    renderSimulation(); run()
    expect(await screen.findByRole("alert")).toHaveTextContent("expired")
    fireEvent.click(screen.getByRole("button", { name: "Retry EXAFS simulation" }))
    await screen.findByTestId("simulation-plot")
    fireEvent.change(screen.getByLabelText("Simulation paths"), { target: { value: "selected" } })
    await waitFor(() => expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeDisabled())
    expect(screen.getByText(/Select at least one/)).toBeVisible()
  })
})
