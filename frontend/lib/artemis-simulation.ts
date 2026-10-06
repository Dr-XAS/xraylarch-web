import type { ArtemisTransform } from "./artemis"
import type { ArtemisFeffJob } from "./artemis-structures"
import { validArtemisPreview, type ArtemisPreview } from "./artemis-path-preview"

export interface SimulationRequest {
  path_ids: string[] | null
  s02: number
  sigma2: number
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
export const simulationDefaults = { s02: "1", sigma2: "0.003", e0: "0", deltar: "0", kmin: "3", kmax: "12", dk: "2" }
export type SimulationFields = typeof simulationDefaults

export function simulationRequest(fields: SimulationFields, weight: number, window: ArtemisTransform["window"], pathIds: string[] | null): SimulationRequest {
  const value = (key: keyof SimulationFields, min: number, max: number) => {
    const number = Number(fields[key])
    if (!fields[key].trim() || !Number.isFinite(number) || number < min || number > max) throw new Error(`${key}: enter a number from ${min} to ${max}.`)
    return number
  }
  const s02 = value("s02", 0, 2), sigma2 = value("sigma2", 0, 0.1), e0 = value("e0", -50, 50), deltar = value("deltar", -1, 1)
  const kmin = value("kmin", 0, 19), kmax = value("kmax", 1, 20), dk = value("dk", 0, 10)
  if (kmax - kmin < 1 - 1e-12) throw new Error("Use a Fourier k interval of at least 1 Å⁻¹.")
  if (pathIds !== null && !pathIds.length) throw new Error("Select at least one generated path, or use all available paths.")
  return { path_ids: pathIds, s02, sigma2, e0, deltar, transform: { kmin, kmax, dk, kweight: [weight], window, fitspace: "r", rmin: 1, rmax: 3, dr: 0 } }
}

export function validSimulation(result: SimulationResult, job: ArtemisFeffJob, request: SimulationRequest) {
  const ids = request.path_ids ?? job.paths.map(path => path.id)
  const paths = ids.map(id => ({ ...job.paths.find(path => path.id === id)!, label: "", enabled: true,
    s02: String(request.s02), sigma2: String(request.sigma2), e0: String(request.e0), deltar: String(request.deltar) }))
  const scalars = ["s02", "sigma2", "e0", "deltar"] as const
  const sameTransform = (value: ArtemisTransform | undefined) => !!value && Object.entries(request.transform).every(([key, expected]) =>
    JSON.stringify(value[key as keyof ArtemisTransform]) === JSON.stringify(expected))
  return result?.simulation?.feff_job_id === job.id && Array.isArray(result.simulation.path_ids) && result.simulation.path_ids.join("|") === ids.join("|") &&
    !!result.simulation.request && scalars.every(key => result.simulation.request[key] === request[key]) &&
    JSON.stringify(result.simulation.request.path_ids) === JSON.stringify(request.path_ids) &&
    sameTransform(result.simulation.request.transform) && sameTransform(result.transform) && result.k?.weight === request.transform.kweight[0] &&
    validArtemisPreview(result, { parameters: [], paths, transform: request.transform }) &&
    result.paths.every(path => scalars.every(key => path.values?.[key] === request[key])) &&
    result.source?.provenance?.cif === job.provenance.cif && result.source.provenance.feff_input === job.provenance.feff_input &&
    Object.entries(job.request).every(([key, value]) => result.source.request?.[key as keyof ArtemisFeffJob["request"]] === value) &&
    Array.isArray(result.source.paths) && result.source.paths.length === paths.length &&
    result.source.paths.every((path, i) => path.id === paths[i].id && path.filename === paths[i].filename && path.content === paths[i].content) &&
    Array.isArray(result.k.chi) && result.k.chi.length === result.k.x.length && result.k.chi.every(Number.isFinite)
}

export function simulationCsv(result: SimulationResult, space: "k" | "r") {
  const info = result.simulation, request = info.request, source = result.source
  const header = ["# Simulated EXAFS; no measured data or fit", `# CIF SHA256: ${info.cif_sha256}`,
    `# ${source.request.absorber} ${source.request.edge}; site ${source.request.site_index}; FEFF job ${info.feff_job_id}`,
    `# Paths: ${info.path_ids.join(" ")}; ${info.path_ids.length}/${info.available_paths} available, ${info.total_paths} generated`,
    `# S02=${request.s02}; sigma2_A2=${request.sigma2}; dE0_eV=${request.e0}; dR_A=${request.deltar}`,
    `# FT: kmin=${request.transform.kmin}; kmax=${request.transform.kmax}; dk=${request.transform.dk}; window=${request.transform.window}; kweight=${result.k.weight}`,
    ...info.assumptions.map(text => `# ${text}`), ...result.warnings.map(text => `# Warning: ${text.replace(/[\r\n]+/g, " ")}`)]
  const rows = space === "k" ? ["k_A^-1,chi,k_weighted_chi", ...result.k.x.map((x, i) => `${x},${result.k.chi[i]},${result.k.total[i]}`)]
    : ["R_A,chi_R_magnitude,chi_R_real,chi_R_imaginary", ...result.r.x.map((x, i) => `${x},${result.r.total_mag[i]},${result.r.total_re[i]},${result.r.total_im[i]}`)]
  return [...header, ...rows, ""].join("\n")
}
