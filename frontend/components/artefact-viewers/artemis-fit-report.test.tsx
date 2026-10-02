import "@testing-library/jest-dom/vitest"

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ArtemisFitResult } from "@/lib/artemis"
import { download } from "@/lib/artemis-fit-utils"
import { ArtemisFitReport } from "./artemis-fit-report"

vi.mock("@/lib/artemis-fit-utils", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/artemis-fit-utils")>(), download: vi.fn(),
}))

function fitResult(): ArtemisFitResult {
  return {
    project_id: "project", group_id: "copper", group_label: "Cu foil · 300 K", version: 4,
    success: true, message: "Fit succeeded.", report: "[[Statistics]]\n  r-factor = 0.003\n[[Parameters]]\n  amp = 0.85 +/- 0.02\n",
    warnings: ["Uncertainties use Larch's high-R noise estimate; systematic model errors are not included."],
    statistics: { n_varys: 2, n_independent: 12.5, n_data: 832, nfev: 25, chi_square: 50,
      reduced_chi_square: 5.8, r_factor: 0.003, aic: 20, bic: 25, errorbars: true },
    parameters: [
      { name: "amp", kind: "guess", value: 0.85, initial: 1, stderr: 0.02, expression: "", min: 0, max: 2 },
      { name: "sig2", kind: "guess", value: 0.003, initial: 0.008, stderr: null, expression: "", min: 0, max: 0.1 },
      { name: "temperature", kind: "set", value: 300, initial: 300, stderr: null, expression: "", min: null, max: null },
      { name: "half_amp", kind: "def", value: 0.425, initial: 0.5, stderr: 0.01, expression: "amp / 2", min: null, max: null },
    ],
    correlations: [{ left: "amp", right: "sig2", value: 0.2 }],
    paths: [{ id: "path1", label: "Cu–Cu", filename: "feff0001.dat", sigma2_expression: "sig2",
      metadata: { reff: 2.5527, degen: 12, nleg: 2, absorber: "Cu", edge: "K", geometry: [], kmin: 0, kmax: 20 },
      values: { s02: 0.85, e0: 2.5, deltar: 0.01, sigma2: 0.003 } }],
    transform: { fitspace: "r", kmin: 3, kmax: 12, rmin: 1, rmax: 3, kweight: [1, 2], dk: 1, dr: 0, window: "hanning" },
    k: { x: [3, 4], data: [1, 2], model: [0.9, 1.9], residual: [0.1, 0.1], weight: 1 },
    r: { x: [1, 2], data_mag: [1, 2], model_mag: [0.9, 1.9], residual_mag: [0.1, 0.1],
      data_re: [1, 2], model_re: [0.9, 1.9], residual_re: [0.1, 0.1],
      data_im: [0, 0], model_im: [0, 0], residual_im: [0, 0] },
  }
}

function parameterRow(name: string) {
  const region = screen.getByRole("region", { name: "Fitted parameter values" })
  return within(region).getByRole("rowheader", { name }).closest("tr")!
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe("Artemis fit report", () => {
  it("distinguishes unavailable uncertainties, fixed values and propagated uncertainties", () => {
    const result = fitResult()
    // Imported results can carry a numeric stderr on a fixed parameter. It is still fixed.
    result.parameters[2].stderr = 0.5
    render(<ArtemisFitReport result={result} />)

    expect(within(parameterRow("sig2")).getAllByRole("cell")[0]).toHaveTextContent("0.003 ± Unavailable")
    const fixed = parameterRow("temperature")
    expect(within(fixed).getAllByRole("cell")[0]).toHaveTextContent("300 —")
    expect(within(fixed).getByText("Fixed")).toBeInTheDocument()
    expect(fixed).not.toHaveTextContent("±")
    const derived = parameterRow("half_amp amp / 2")
    expect(derived).toHaveTextContent("0.425 ± 0.01")
    expect(within(derived).getByText("Derived")).toBeInTheDocument()
    expect(parameterRow("amp")).toHaveTextContent("0.85 ± 0.02")
  })

  it("marks uncertainty unavailable when the fit could not estimate error bars", () => {
    const result = fitResult()
    result.statistics.errorbars = false
    render(<ArtemisFitReport result={result} />)

    expect(within(parameterRow("amp")).getAllByRole("cell")[0]).toHaveTextContent("0.85 ± Unavailable")
    expect(within(parameterRow("half_amp amp / 2")).getAllByRole("cell")[0]).toHaveTextContent("0.425 ± Unavailable")
    expect(within(parameterRow("temperature")).getAllByRole("cell")[0]).toHaveTextContent("300 —")
    expect(screen.getByRole("complementary", { name: "Fit review notes" })).toHaveTextContent("Parameter uncertainties could not be estimated reliably")
  })

  it("shows a poor residual as a review note even when the optimizer converged", () => {
    const result = fitResult()
    result.statistics.r_factor = 0.30584861
    render(<ArtemisFitReport result={result} />)

    expect(screen.getByText("Converged", { exact: true })).toBeInTheDocument()
    expect(screen.getByRole("complementary", { name: "Fit review notes" })).toHaveTextContent("R factor is above 0.05")
    expect(screen.getByText("0.30585", { exact: true })).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the routine noise-estimate notice separate from fit review concerns", () => {
    render(<ArtemisFitReport result={fitResult()} />)

    expect(screen.getByText("Converged", { exact: true })).toBeInTheDocument()
    expect(screen.getByText("Fit notes (1)", { exact: true })).toBeInTheDocument()
    expect(screen.getByText(/Uncertainties use Larch's high-R noise estimate/)).toBeVisible()
    expect(screen.queryByRole("complementary", { name: "Fit review notes" })).not.toBeInTheDocument()
  })

  it("flags a model with as many free parameters as independent points", () => {
    const result = fitResult()
    result.statistics.n_independent = result.statistics.n_varys
    const view = render(<ArtemisFitReport result={result} />)

    expect(screen.getByRole("complementary", { name: "Fit review notes" })).toHaveTextContent("Free parameters meet or exceed the number of independent points")
    view.rerender(<ArtemisFitReport result={{ ...result, statistics: { ...result.statistics, n_independent: 2.1 } }} />)
    expect(screen.queryByRole("complementary", { name: "Fit review notes" })).not.toBeInTheDocument()
  })

  it("marks only varied parameters near a finite bound and qualifies their standard errors", () => {
    const result = fitResult()
    const base = { ...result.parameters[0], min: 0, max: 1 }
    result.parameters = [
      { ...base, name: "lower", value: 0.0005 },
      { ...base, name: "upper", value: 0.9995 },
      { ...base, name: "interior", value: 0.002 },
      { ...base, name: "fixed", kind: "set", value: 0 },
      { ...base, name: "derived", kind: "def", value: 0, expression: "fixed" },
      { ...base, name: "one_sided", value: 0, max: null },
      { ...base, name: "unbounded", value: 0, max: Infinity },
      { ...base, name: "no_span", value: 0, max: 0 },
    ]
    render(<ArtemisFitReport result={result} />)

    expect(within(parameterRow("lower")).getByText("At min bound", { exact: true })).toBeInTheDocument()
    expect(within(parameterRow("upper")).getByText("At max bound", { exact: true })).toBeInTheDocument()
    for (const name of ["interior", "fixed", "derived fixed", "one_sided", "unbounded", "no_span"]) {
      expect(within(parameterRow(name)).queryByText(/At (min|max) bound/)).not.toBeInTheDocument()
    }
    const review = screen.getByRole("complementary", { name: "Fit review notes" })
    expect(review).toHaveTextContent("Parameters at a bound: lower, upper.")
    expect(review).toHaveTextContent("Their standard errors may be unreliable")
  })

  it("sorts correlations by magnitude while preserving their signs and source order", () => {
    const result = fitResult()
    result.correlations = [
      { left: "amp", right: "sig2", value: 0.82 },
      { left: "sig2", right: "del_r", value: -0.95 },
      { left: "amp", right: "del_r", value: -0.12 },
    ]
    const original = structuredClone(result.correlations)
    render(<ArtemisFitReport result={result} />)

    const details = screen.getByText("Parameter correlations (3)", { exact: true }).closest("details")!
    const pairs = within(details).getAllByRole("listitem")
    expect(pairs[0]).toHaveTextContent("sig2↔del_r-0.950Strong")
    expect(pairs[1]).toHaveTextContent("amp↔sig2+0.820")
    expect(pairs[2]).toHaveTextContent("amp↔del_r-0.120")
    expect(screen.getByRole("complementary", { name: "Fit review notes" })).toHaveTextContent("strongly correlated")
    expect(result.correlations).toEqual(original)
  })

  it("calculates fitted path lengths only from saved fitted values", () => {
    const result = fitResult()
    result.paths.push({ ...result.paths[0], id: "legacy", label: "Cu–O–Cu", filename: "feff0002.dat",
      metadata: { ...result.paths[0].metadata, nleg: 3 }, values: undefined })
    render(<ArtemisFitReport result={result} />)

    const region = screen.getByRole("region", { name: "Fitted path lengths and disorder" })
    const rows = within(region).getAllByRole("row").slice(1)
    expect(within(rows[0]).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["2.5627", "0.01", "0.003"])
    expect(within(rows[1]).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["—", "—", "—"])
    expect(rows[1]).toHaveTextContent("Multiple scattering")
    expect(screen.getByText(/For multiple scattering, R is half the total path length/)).toBeInTheDocument()
  })

  it("preserves the original report and reproducible JSON downloads", () => {
    const result = fitResult()
    result.request = { version: result.version, parameters: result.parameters, paths: [], transform: result.transform }
    const original = structuredClone(result)
    render(<ArtemisFitReport result={result} />)

    fireEvent.click(screen.getByText("Larch fit report", { exact: true }))
    expect(screen.getByLabelText("Original Larch fit report").textContent).toBe(result.report)
    fireEvent.click(screen.getByRole("button", { name: "Download report" }))
    expect(download).toHaveBeenNthCalledWith(1, "artemis-fit-report.txt", result.report, "text/plain")
    fireEvent.click(screen.getByRole("button", { name: "Download fit + model JSON" }))
    const [filename, text] = vi.mocked(download).mock.calls[1]
    expect(filename).toBe("artemis-fit.json")
    const bundle = JSON.parse(text)
    expect(bundle.request).toEqual(result.request)
    expect(bundle.result.report).toBe(result.report)
    expect(bundle.result.parameters).toEqual(result.parameters)
    expect(bundle.result.request).toBeUndefined()
    expect(result).toEqual(original)
  })

  it("retains the last attempted parameters and report when optimization failed", () => {
    const result = fitResult()
    result.success = false
    result.message = "Maximum number of function evaluations reached."
    render(<ArtemisFitReport result={result} />)

    expect(screen.getByText("Did not converge", { exact: true })).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(result.message)
    expect(parameterRow("amp")).toHaveTextContent("0.85")
    expect(screen.getByRole("button", { name: "Download report" })).toBeEnabled()
  })
})
