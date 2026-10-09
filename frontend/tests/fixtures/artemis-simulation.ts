import type { ArtemisFeffJob } from "@/lib/artemis-structures"
import { simulationDefaults, simulationRequest, type SimulationResult } from "@/lib/artemis-simulation"

export const simulationJob: ArtemisFeffJob = {
  id: "a".repeat(32), status: "complete", stage: "done", message: "Done", log: "", elapsed_seconds: 1,
  request: { absorber: "Cu", edge: "K", site_index: 1, cluster_radius: 3, path_radius: 3, max_legs: 4, max_paths: null },
  provenance: { cif: "data_copper", feff_input: "TITLE copper", structure: { id: "cif-test", provider: "uploaded", filename: "copper.cif", mineral: "Copper", formula: "Cu", space_group: "Fm-3m", authors: "", year: null, journal: "", title: "" } },
  paths: [{ id: "feff0001", filename: "feff0001.dat", content: "FEFF test path", metadata: { reff: 2.56, degen: 12, nleg: 2, absorber: "Cu", edge: "K", kmin: 0, kmax: 20, geometry: [] } }],
  total_paths: 1, truncated: false, warnings: [],
}
export function simulationFixture(): SimulationResult {
  const request = simulationRequest(simulationDefaults, 2, "hanning", null)
  return { paths: simulationJob.paths.map(path => ({ ...path, label: path.filename, values: { s02: request.s02, sigma2: 0.003, e0: 0, deltar: 0 },
    k: { chi: [0, 0.2, 0.4] }, r: { mag: [0.3, 0.4], re: [0.3, 0.4], im: [0, 0] }, metrics: { amplitude: 0.4, r_at_amplitude: 2, window_area: 0.2, chi_k_peak: 0.4 } })),
    warnings: [], transform: request.transform, k: { x: [0, 1, 2], chi: [0.125, 0.2, 0.1], weight: 2, total: [0, 0.2, 0.4] },
    r: { x: [0, 2], total_mag: [0.3, 0.4], total_re: [0.3, 0.4], total_im: [0, 0] },
    metadata: { engine: "larch.feffdat", kstep: 0.05, nfft: 2048, rwindow: "hanning", note: "Simulation", metrics: "" },
    simulation: { kind: "cif-exafs", schema_version: 1, feff_job_id: simulationJob.id, request, path_ids: ["feff0001"], available_paths: 1, total_paths: 1, cif_sha256: "b".repeat(64), calculated_k_range: [0, 2], assumptions: ["One absorbing site."] },
    source: { request: simulationJob.request, provenance: simulationJob.provenance, paths: simulationJob.paths.map(({ id, filename, content }) => ({ id, filename, content })) } }
}
