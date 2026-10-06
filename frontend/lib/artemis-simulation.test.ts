import { describe, expect, it } from "vitest"
import { simulationFixture, simulationJob } from "@/tests/fixtures/artemis-simulation"
import { simulationCsv, simulationDefaults, simulationRequest, validSimulation } from "./artemis-simulation"

describe("CIF simulation contract", () => {
  it("exports unweighted chi including k=0, complex R and provenance", () => {
    const result = simulationFixture()
    expect(simulationCsv(result, "k")).toContain("0,0.125,0\n")
    expect(simulationCsv(result, "k")).toContain("sigma2_A2=0.003")
    expect(simulationCsv(result, "k")).toContain(result.simulation.cif_sha256)
    expect(simulationCsv(result, "r")).toContain("R_A,chi_R_magnitude,chi_R_real,chi_R_imaginary")
  })
  it.each(["s02", "sigma2", "e0", "deltar", "kmin", "kmax", "dk"] as const)("refuses blank %s", key => {
    expect(() => simulationRequest({ ...simulationDefaults, [key]: "" }, 2, "hanning", null)).toThrow()
  })
  it("refuses empty selection and invalid k range", () => {
    expect(() => simulationRequest(simulationDefaults, 2, "hanning", [])).toThrow("Select at least")
    expect(() => simulationRequest({ ...simulationDefaults, kmin: "12" }, 2, "hanning", null)).toThrow("interval")
  })
  it.each(["job", "weight", "parameter", "transform", "pathValue", "raw", "source"])("rejects a response with mismatched %s", key => {
    const result = structuredClone(simulationFixture()), request = simulationRequest(simulationDefaults, 2, "hanning", null)
    expect(validSimulation(result, simulationJob, request)).toBe(true)
    if (key === "job") result.simulation.feff_job_id = "wrong"
    if (key === "weight") result.k.weight = 3
    if (key === "parameter") result.simulation.request.sigma2 = 0.01
    if (key === "transform") result.transform.kmax = 10
    if (key === "pathValue") result.paths[0].values.e0 = 2
    if (key === "raw") result.k.chi = [0]
    if (key === "source") result.source.paths[0].content = "wrong"
    expect(validSimulation(result, simulationJob, request)).toBe(false)
  })
})
