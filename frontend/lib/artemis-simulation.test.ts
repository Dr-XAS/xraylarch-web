import { describe, expect, it } from "vitest"
import { simulationFixture, simulationJob } from "@/tests/fixtures/artemis-simulation"
import { simulationCsv, simulationDefaults, simulationRequest, validSimulation } from "./artemis-simulation"

describe("CIF simulation contract", () => {
  it.each(["", "0", "-1", "Infinity"])("requires a positive material Debye temperature: %s", theta => {
    expect(() => simulationRequest({ ...simulationDefaults, debye_temperature: theta }, 2, "hanning", null, "debye")).toThrow("Debye temperature")
  })
  it.each(["temperature", "static_sigma2"] as const)("requires nonnegative finite %s in Debye mode", key => {
    for (const value of ["", "-1", "NaN", "Infinity"]) expect(() => simulationRequest({ ...simulationDefaults, debye_temperature: "350", [key]: value }, 2, "hanning", null, "debye")).toThrow()
  })
  it("accepts path-dependent Debye disorder and exports the applied values", () => {
    const request = simulationRequest({ ...simulationDefaults, debye_temperature: "350" }, 2, "hanning", null, "debye")
    expect(request).toMatchObject({ disorder_model: "debye", temperature: 298, debye_temperature: 350, static_sigma2: 0 })
    const result = simulationFixture()
    const job = structuredClone(simulationJob)
    job.paths.push({ ...job.paths[0], id: "feff0002", filename: "feff0002.dat" })
    job.total_paths = 2
    result.paths.push({ ...structuredClone(result.paths[0]), id: "feff0002", filename: "feff0002.dat" })
    result.simulation.path_ids.push("feff0002")
    result.source.paths = job.paths.map(({ id, filename, content }) => ({ id, filename, content }))
    result.simulation.request = request
    result.paths[0].values.sigma2 = 0.004
    result.paths[1].values.sigma2 = 0.006
    expect(validSimulation(result, job, request)).toBe(true)
    const csv = simulationCsv(result, "k")
    expect(csv).toContain("temperature_K=298; debye_temperature_K=350; static_sigma2_A2=0")
    expect(csv).toContain("Path feff0002: sigma2_A2=0.006")
    for (const sigma2 of [-0.001, NaN, Infinity]) {
      result.paths[1].values.sigma2 = sigma2
      expect(validSimulation(result, job, request)).toBe(false)
    }
  })
  it.each(["disorder_model", "temperature", "debye_temperature", "static_sigma2"] as const)("rejects a mismatched thermal %s", key => {
    const request = simulationRequest({ ...simulationDefaults, debye_temperature: "350" }, 2, "hanning", null, "debye")
    const result = simulationFixture()
    result.simulation.request = { ...request, [key]: key === "disorder_model" ? "fixed" : 1 }
    expect(validSimulation(result, simulationJob, request)).toBe(false)
  })
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
  it.each([-1, 1.5, 4, 9, NaN, Infinity])("refuses invalid simulation k-weight %s", weight => {
    expect(() => simulationRequest(simulationDefaults, weight, "hanning", null)).toThrow("k-weights from 0 to 3")
  })
  it("retains signed energy and distance corrections without allowing negative disorder", () => {
    expect(simulationRequest({ ...simulationDefaults, e0: "-5", deltar: "-0.05" }, 0, "hanning", null)).toMatchObject({ e0: -5, deltar: -0.05 })
    expect(() => simulationRequest({ ...simulationDefaults, sigma2: "-0.003" }, 2, "hanning", null)).toThrow("sigma2")
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
