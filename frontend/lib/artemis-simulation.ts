import type { ArtemisTransform } from "./artemis"
import type { ArtemisFeffJob } from "./artemis-structures"
import { validArtemisPreview, type ArtemisPreview } from "./artemis-path-preview"
import { validateArtemisTransform } from "./artemis-transform-limits"

export interface SimulationRequest {
  path_ids: string[] | null
  s02: number
  sigma2: number
  disorder_model?: "fixed" | "debye"
  temperature?: number
  debye_temperature?: number | null
  static_sigma2?: number
  e0: number
  deltar: number
  transform: ArtemisTransform
}
export interface SimulationResult extends ArtemisPreview {
  k: ArtemisPreview["k"] & { chi: number[] }
  simulation: {
    kind: "cif-exafs"; schema_version: number; feff_job_id: string; request: SimulationRequest
    path_ids: string[]; available_paths: number; total_paths: number; cif_sha256: string
    calculated_k_range: number[]; assumptions: string[]
  }
  source: Pick<ArtemisFeffJob, "request" | "provenance"> & { paths: { id: string; filename: string; content: string }[] }
}
export const simulationDefaults = { s02: "0.85", sigma2: "0.003", temperature: "298", debye_temperature: "", static_sigma2: "0", e0: "0", deltar: "0", kmin: "3", kmax: "12", dk: "2" }
export type SimulationFields = typeof simulationDefaults
export const simulationLimits = {
  s02: { min: 0, max: 2, step: "any" },
  sigma2: { min: 0, max: 0.1, step: "any" },
  temperature: { min: 0, step: "any" },
  debye_temperature: { min: 0, step: "any" },
  static_sigma2: { min: 0, max: 0.1, step: "any" },
  e0: { min: -50, max: 50, step: "any" },
  deltar: { min: -1, max: 1, step: "any" },
  kmin: { min: 0, max: 19, step: "any" },
  kmax: { min: 1, max: 20, step: "any" },
  dk: { min: 0, max: 10, step: "any" },
} as const

export function simulationRequest(fields: SimulationFields, weight: number, window: ArtemisTransform["window"], pathIds: string[] | null, model: "fixed" | "debye" = "fixed"): SimulationRequest {
  const value = (key: keyof SimulationFields) => {
    const limits = simulationLimits[key], { min } = limits, max = "max" in limits ? limits.max : Infinity
    const number = Number(fields[key])
    if (key === "debye_temperature" && (!fields[key].trim() || !Number.isFinite(number) || number <= 0)) throw new Error("Enter the material’s Debye temperature ΘD in K (greater than zero).")
    if (!fields[key].trim() || !Number.isFinite(number) || number < min || number > max) throw new Error(Number.isFinite(max)
      ? `${key}: enter a number from ${min} to ${max}.` : "Temperature: enter a finite, nonnegative number in K.")
    return number
  }
  const s02 = value("s02"), sigma2 = model === "fixed" ? value("sigma2") : Number(simulationDefaults.sigma2), e0 = value("e0"), deltar = value("deltar")
  const disorder = model === "debye" ? { disorder_model: model, debye_temperature: value("debye_temperature"), temperature: value("temperature"), static_sigma2: value("static_sigma2") }
    : { disorder_model: model, debye_temperature: null, temperature: 298, static_sigma2: 0 }
  const kmin = value("kmin"), kmax = value("kmax"), dk = value("dk")
  if (kmax - kmin < 1 - 1e-12) throw new Error("Use a Fourier k interval of at least 1 Å⁻¹.")
  if (pathIds !== null && !pathIds.length) throw new Error("Select at least one generated path, or use all available paths.")
  const transform: ArtemisTransform = { kmin, kmax, dk, kweight: [weight], window, fitspace: "r", rmin: 1, rmax: 3, dr: 0 }
  validateArtemisTransform(transform)
  return { path_ids: pathIds, s02, sigma2, e0, deltar, transform, ...disorder }
}

function disorderRecipe(request: SimulationRequest) {
  return [request.disorder_model ?? "fixed", request.temperature ?? 298, request.debye_temperature ?? null, request.static_sigma2 ?? 0]
}

export function validSimulation(result: SimulationResult, job: ArtemisFeffJob, request: SimulationRequest) {
  const ids = request.path_ids ?? job.paths.map(path => path.id)
  const paths = ids.map(id => ({ ...job.paths.find(path => path.id === id)!, label: "", enabled: true,
    s02: String(request.s02), sigma2: String(request.sigma2), e0: String(request.e0), deltar: String(request.deltar) }))
  const scalars = ["s02", "e0", "deltar"] as const
  const sameTransform = (value: ArtemisTransform | undefined) => !!value && Object.entries(request.transform).every(([key, expected]) =>
    JSON.stringify(value[key as keyof ArtemisTransform]) === JSON.stringify(expected))
  return result?.simulation?.feff_job_id === job.id && Array.isArray(result.simulation.path_ids) && result.simulation.path_ids.join("|") === ids.join("|") &&
    !!result.simulation.request && scalars.every(key => result.simulation.request[key] === request[key]) &&
    result.simulation.request.sigma2 === request.sigma2 &&
    JSON.stringify(disorderRecipe(result.simulation.request)) === JSON.stringify(disorderRecipe(request)) &&
    JSON.stringify(result.simulation.request.path_ids) === JSON.stringify(request.path_ids) &&
    sameTransform(result.simulation.request.transform) && sameTransform(result.transform) && result.k?.weight === request.transform.kweight[0] &&
    validArtemisPreview(result, { parameters: [], paths, transform: request.transform }) &&
    result.paths.every(path => scalars.every(key => path.values?.[key] === request[key])) &&
    result.paths.every(path => request.disorder_model === "debye"
      ? Number.isFinite(path.values?.sigma2) && path.values.sigma2 >= (request.static_sigma2 ?? 0)
      : path.values?.sigma2 === request.sigma2) &&
    result.source?.provenance?.cif === job.provenance.cif && result.source.provenance.feff_input === job.provenance.feff_input &&
    Object.entries(job.request).every(([key, value]) => result.source.request?.[key as keyof ArtemisFeffJob["request"]] === value) &&
    Array.isArray(result.source.paths) && result.source.paths.length === paths.length &&
    result.source.paths.every((path, i) => path.id === paths[i].id && path.filename === paths[i].filename && path.content === paths[i].content) &&
    Array.isArray(result.k.chi) && result.k.chi.length === result.k.x.length && result.k.chi.every(Number.isFinite)
}

export function simulationCsv(result: SimulationResult, space: "k" | "r") {
  const info = result.simulation, request = info.request, source = result.source
  const disorder = request.disorder_model === "debye"
    ? [`# Disorder: correlated Debye; temperature_K=${request.temperature}; debye_temperature_K=${request.debye_temperature}; static_sigma2_A2=${request.static_sigma2}`,
      ...result.paths.map(path => `# Path ${path.id}: sigma2_A2=${path.values.sigma2}`)]
    : [`# Disorder: fixed; sigma2_A2=${request.sigma2}`]
  const header = ["# Simulated EXAFS; no measured data or fit", `# CIF SHA256: ${info.cif_sha256}`,
    `# ${source.request.absorber} ${source.request.edge}; site ${source.request.site_index}; FEFF job ${info.feff_job_id}`,
    `# Paths: ${info.path_ids.join(" ")}; ${info.path_ids.length}/${info.available_paths} available, ${info.total_paths} generated`,
    `# S02=${request.s02}; dE0_eV=${request.e0}; dR_A=${request.deltar}`, ...disorder,
    `# FT: kmin=${request.transform.kmin}; kmax=${request.transform.kmax}; dk=${request.transform.dk}; window=${request.transform.window}; kweight=${result.k.weight}`,
    ...info.assumptions.map(text => `# ${text}`), ...result.warnings.map(text => `# Warning: ${text.replace(/[\r\n]+/g, " ")}`)]
  const rows = space === "k" ? ["k_A^-1,chi,k_weighted_chi", ...result.k.x.map((x, i) => `${x},${result.k.chi[i]},${result.k.total[i]}`)]
    : ["R_A,chi_R_magnitude,chi_R_real,chi_R_imaginary", ...result.r.x.map((x, i) => `${x},${result.r.total_mag[i]},${result.r.total_re[i]},${result.r.total_im[i]}`)]
  return [...header, ...rows, ""].join("\n")
}
