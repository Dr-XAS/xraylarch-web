import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { artemisApi } from "@/lib/artemis"
import { downloadArtemisText } from "@/lib/artemis-structures"
import { simulationFixture, simulationJob } from "@/tests/fixtures/artemis-simulation"
import { ArtemisSimulation } from "./artemis-simulation"
import { InstructionVisibility } from "./section-help"

vi.mock("@/lib/artemis", () => ({ artemisApi: vi.fn() }))
vi.mock("@/lib/artemis-structures", () => ({ downloadArtemisText: vi.fn() }))
vi.mock("./themed-plot", () => ({ ThemedPlot: () => <div data-testid="simulation-plot" /> }))
const api = vi.mocked(artemisApi)
beforeEach(() => { vi.clearAllMocks(); api.mockResolvedValue(simulationFixture()) })
afterEach(cleanup)
function SimulationHarness({ onAddToDataList }: { onAddToDataList?: (result: ReturnType<typeof simulationFixture>, idempotencyKey: string) => Promise<void> }) {
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null)
  return <ArtemisSimulation job={simulationJob} selectedIds={selectedIds} onSelectionChange={setSelectedIds} disabled={false} onAddToDataList={onAddToDataList} />
}
const renderSimulation = (onAddToDataList?: (result: ReturnType<typeof simulationFixture>, idempotencyKey: string) => Promise<void>) => render(<SimulationHarness onAddToDataList={onAddToDataList} />)
const run = () => fireEvent.click(screen.getByRole("button", { name: "Run EXAFS simulation" }))

describe("CIF simulation controls", () => {
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
      <ArtemisSimulation job={simulationJob} selectedIds={null} onSelectionChange={vi.fn()} disabled={false} />
    </InstructionVisibility.Provider>
    const view = render(panel(false))
    expect(screen.queryByRole("button", { name: /^About / })).not.toBeInTheDocument()
    view.rerender(panel(true))
    for (const name of ["Simulation paths", "Simulation S₀²", "Simulation σ² (Å²)", "Simulation ΔE₀ (eV)", "Simulation ΔR (Å)", "Simulation FT k min (Å⁻¹)", "Simulation FT k max (Å⁻¹)", "Simulation FT dk (Å⁻¹)", "Simulation k-weight", "Simulation window"])
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
    fireEvent.change(screen.getByLabelText("Simulation S₀²"), { target: { value: "0.85" } })
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeEnabled()
    await act(async () => resolve(simulationFixture()))
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
  it("blocks an empty selection", () => {
    render(<ArtemisSimulation job={simulationJob} selectedIds={[]} onSelectionChange={vi.fn()} disabled={false} />)
    expect(screen.getByLabelText("Simulation paths")).toHaveValue("selected")
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeDisabled()
    expect(screen.getByText(/Select at least one/)).toBeVisible()
  })
  it("keeps checked paths when switching to selected mode, and can restore all", () => {
    renderSimulation()
    fireEvent.change(screen.getByLabelText("Simulation paths"), { target: { value: "selected" } })
    expect(screen.getByLabelText("Simulation paths")).toHaveValue("selected")
    expect(screen.getByRole("option", { name: "Selected paths (1)" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run EXAFS simulation" })).toBeEnabled()
    fireEvent.change(screen.getByLabelText("Simulation paths"), { target: { value: "all" } })
    expect(screen.getByLabelText("Simulation paths")).toHaveValue("all")
    expect(api).not.toHaveBeenCalled()
  })
  it("invalidates completed curves when the checked paths change and sends the current selection", async () => {
    const props = { job: simulationJob, disabled: false, onSelectionChange: vi.fn() }
    const view = render(<ArtemisSimulation {...props} selectedIds={null} />)
    run(); await screen.findByTestId("simulation-plot")
    const ids = simulationJob.paths.map(path => path.id)
    view.rerender(<ArtemisSimulation {...props} selectedIds={ids} />)
    expect(screen.queryByTestId("simulation-plot")).not.toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(1)
    const result = simulationFixture()
    result.simulation.request.path_ids = ids
    api.mockResolvedValueOnce(result)
    run(); await screen.findByTestId("simulation-plot")
    expect(api).toHaveBeenLastCalledWith(`/feff/jobs/${simulationJob.id}/simulate`, expect.objectContaining({ path_ids: ids }), expect.any(AbortSignal))
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
    expect(api).toHaveBeenCalledTimes(1)
  })
})
