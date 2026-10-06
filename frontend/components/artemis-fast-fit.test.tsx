import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { artemisApi, type ArtemisFitRequest, type ArtemisFitResult } from "@/lib/artemis"
import { fastEngineStatus } from "@/lib/artemis-fast"
import { ArtemisFastFitComparison } from "./artemis-fast-fit"

vi.mock("@/lib/artemis", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/artemis")>(), artemisApi: vi.fn() }))
vi.mock("@/lib/artemis-fast", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/artemis-fast")>(), fastEngineStatus: vi.fn() }))
const api = vi.mocked(artemisApi)
const status = vi.mocked(fastEngineStatus)

const transform: ArtemisFitRequest["transform"] = { fitspace: "r", kmin: 3, kmax: 12, kweight: [2], dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0 }
const request: ArtemisFitRequest = {
  version: 4,
  parameters: [{ name: "amp", kind: "guess", value: 0.9, expression: "", min: null, max: null }],
  paths: [{ id: "a", label: "Cu–Cu", filename: "feff0001.dat", content: "FEFF data", enabled: true, s02: "amp", e0: "0", deltar: "0", sigma2: "0.003" }],
  transform,
}

function fit(overrides: Partial<ArtemisFitResult> = {}): ArtemisFitResult {
  return {
    project_id: "p", group_id: "copper", group_label: "copper foil", version: 4, success: true,
    message: "Fit succeeded.", report: "report", warnings: [],
    statistics: { n_varys: 1, n_independent: 12.5, n_data: 40, nfev: 40, chi_square: 100, reduced_chi_square: 8.7, r_factor: 0.003, aic: 20, bic: 25, errorbars: true, epsilon_k: 0.0002 },
    parameters: [{ name: "amp", kind: "guess", value: 0.9, initial: 0.9, stderr: 0.02, expression: "", min: null, max: null }],
    correlations: [], paths: [],
    k: { x: [0, 1, 2, 3], data: [0, 1, 0, -1], model: [0, 1, 0, -1], residual: [0, 0, 0, 0], weight: 2 },
    r: { x: [0, 1, 2, 3], data_mag: [0, 1, 2, 1], model_mag: [0, 1, 2, 1], residual_mag: [0, 0, 0, 0],
      data_re: [0, 1, -1, 0], model_re: [0, 1, -1, 0], residual_re: [0, 0, 0, 0],
      data_im: [0, 1, -1, 0], model_im: [0, 1, -1, 0], residual_im: [0, 0, 0, 0] },
    transform,
    metadata: { engine: "larch.feffit", seconds: { optimizer: 0.063, fit: 0.081, total: 0.095 } },
    ...overrides,
  }
}
const reference = fit()
const fastResult = fit({
  statistics: { ...fit().statistics, nfev: 11, chi_square: 99.99 },
  parameters: [{ name: "amp", kind: "guess", value: 0.9002, initial: 0.9, stderr: 0.02, expression: "", min: null, max: null }],
  warnings: ["Fast backend: the reference and differentiable forward models differ by at most 4.20e-13 in the weighted residual at these parameters."],
  metadata: { engine: "xasforward.exafs_paths+jax", engine_parity: 4.2e-13, seconds: { compile: 0.9, optimizer: 0.012, fit: 0.93, total: 0.95 } },
})
const row = (name: string) => screen.getByRole("rowheader", { name }).closest("tr")!

function panel(props: Partial<React.ComponentProps<typeof ArtemisFastFitComparison>> = {}) {
  return render(<ArtemisFastFitComparison projectId="p" groupId="copper" request={request}
    reference={reference} blocked="" disabled={false} {...props} />)
}

beforeEach(() => { api.mockReset(); status.mockReset(); status.mockResolvedValue({ available: true, reason: null }) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("ArtemisFastFitComparison", () => {
  it("refits the model that produced the result on screen, on the fast route", async () => {
    // A comparison between two different models would be meaningless, so the
    // request sent must be exactly the one the caller supplied.
    api.mockResolvedValue(fastResult)
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    await waitFor(() => expect(api).toHaveBeenCalled())
    expect(api.mock.calls[0][0]).toBe("/projects/p/groups/copper/fit/fast")
    expect(api.mock.calls[0][1]).toBe(request)
  })

  it("is not offered at all on a server without the engine, rather than as a button that can only fail", async () => {
    // A standard deployment installs neither jax nor xasforward.
    status.mockResolvedValue({ available: false, reason: "No module named 'jax'" })
    const { container } = panel()
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(api).not.toHaveBeenCalled()
  })

  it("asks for nothing until the user asks for a comparison", () => {
    // The panel is mounted beside every fit. A request on mount would cost one
    // round trip per model edit, because the panel remounts when the model changes.
    panel()
    expect(api).not.toHaveBeenCalled()
  })

  it("times the same phases on both engines, instead of feffit's whole call against the fast optimizer alone", async () => {
    api.mockResolvedValue(fastResult)
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    await screen.findByRole("table", { name: /Same model and data/ })
    expect(row("Optimizer loop")).toHaveTextContent(/63 ms.*12 ms/)
    expect(row("Compilation")).toHaveTextContent(/none.*900 ms/)
    expect(row("Whole fit call")).toHaveTextContent(/81 ms.*930 ms/)
    expect(row("Server total")).toHaveTextContent(/95 ms.*950 ms/)
    expect(row("Residual evaluations")).toHaveTextContent(/40.*11/)
    expect(screen.getByText(/xasforward\.exafs_paths\+jax/)).toBeInTheDocument()
  })

  it("says 'same answer' only with the tolerances it was judged against", async () => {
    api.mockResolvedValue(fastResult)
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    // 0.0002 in amp against a standard error of 0.02 is a hundredth of a sigma.
    const verdict = await screen.findByText(/^Same answer within the stated tolerances/)
    expect(verdict).toHaveTextContent("0.0100 of amp’s reference standard error (tolerance 0.1)")
    expect(verdict).toHaveTextContent("χ² lower by 1.0e-4 relative (tolerance 1e-3)")
    expect(verdict).toHaveTextContent("forward models differ by 4.2e-13 in the noise-weighted residual (tolerance 1e-6)")
  })

  it("calls the answers different when a value moves by more than the tolerance", async () => {
    api.mockResolvedValue({ ...fastResult, parameters: [{ ...fastResult.parameters[0], value: 0.91 }] })
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    expect(await screen.findByText(/^Not the same answer within tolerance \(fitted values\)/)).toHaveTextContent("0.5000 of amp’s")
  })

  it("shows each engine's convergence and makes no comparison when one did not converge", async () => {
    api.mockResolvedValue({ ...fastResult, success: false, message: "Maximum number of function evaluations exceeded." })
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    await screen.findByRole("table", { name: /Same model and data/ })
    expect(row("Converged")).toHaveTextContent(/yes.*no — Maximum number of function evaluations exceeded\./)
    expect(screen.getByText(/^No agreement is claimed\. The fast fit did not converge/)).toBeInTheDocument()
    expect(screen.queryByText(/Same answer/)).not.toBeInTheDocument()
  })

  it("lists the fast engine's own warnings rather than dropping them", async () => {
    api.mockResolvedValue({ ...fastResult, warnings: ["amp finished at its upper bound (2); its uncertainty does not describe it."] })
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    expect(await screen.findByRole("list", { name: "Fast fit warnings" })).toHaveTextContent("amp finished at its upper bound")
  })

  it("does not show an old saved fit's non-comparable timing as if it were the same phase", async () => {
    api.mockResolvedValue(fastResult)
    panel({ reference: fit({ metadata: { engine: "larch.feffit", seconds: { solve: 0.063 } } }) })
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    await screen.findByRole("table", { name: /Same model and data/ })
    expect(row("Optimizer loop")).toHaveTextContent(/not recorded.*12 ms/)
  })

  it("shows why the engine could not run instead of leaving the button silent", async () => {
    // The server decides availability; a deployment without JAX must say so.
    api.mockRejectedValue(new Error("The differentiable fit backend is not installed on this server."))
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("not installed on this server")
  })

  it("refuses to compare against a result the editor's model no longer matches", () => {
    // Comparing a new model's fast fit against an old reference would present a
    // difference in models as a difference between backends.
    panel({ request: null, blocked: "The model in the editor differs from this fit." })
    expect(screen.getByRole("button", { name: "Refit on the fast backend" })).toBeDisabled()
    expect(screen.getByText("The model in the editor differs from this fit.")).toBeInTheDocument()
  })

  it("does not claim a comparison when the reference fit has no uncertainties", async () => {
    api.mockResolvedValue(fastResult)
    panel({ reference: fit({ statistics: { ...fit().statistics, errorbars: false },
      parameters: [{ name: "amp", kind: "guess", value: 0.9, initial: 0.9, stderr: null, expression: "", min: null, max: null }] }) })
    fireEvent.click(screen.getByRole("button", { name: "Refit on the fast backend" }))
    expect(await screen.findByText(/^No agreement is claimed\. The reference fit reported no uncertainties/)).toBeInTheDocument()
    expect(row("Uncertainties")).toHaveTextContent(/not available.*estimated/)
  })
})
