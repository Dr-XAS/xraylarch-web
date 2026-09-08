import type { AthenaGroup, AthenaProject, DifferenceInputK, DifferenceOptions, DifferencePreview, Parameters } from "@/lib/athena"

export const differenceParameters: Parameters = { e0: 8979, step: null, pre1: -150, pre2: -30, norm1: 100, norm2: 300, nnorm: 2, flatten: true,
  rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1, kmin: 3, kmax: 12,
  kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0, rwindow: "hanning", energy_shift: 3, nfft: 2048, kstep: 0.05 }
export const differenceOptions: DifferenceOptions = { standard_id: "standard", form: "norm", multiplier: 1, invert: false, plot_inputs: true,
  integrate: true, xmin: -20, xmax: 30, renormalize: false, name_template: "diff %d - %s", plot_space: "E" }
export function differenceInputs(id = "data", label = "DATA foil"): DifferenceInputK[] {
  return [
    { role: "DATA", group_id: id, label, k: [0.5, 1.5], weighted_chi: [0.4, -0.8], kweight: 1, error: null },
    { role: "STANDARD", group_id: "standard", label: "STANDARD foil", k: [1, 2.5, 4], weighted_chi: [2, -3, 4], kweight: 3, error: null },
  ]
}
export function differenceGroup(id: string, label: string, marked = true): AthenaGroup {
  return { id, label, marked, data_type: "mu", frozen: false, energy: [8960, 8980, 9000], mu: [0.3, 0.8, 1.2],
    parameters: { ...differenceParameters }, source: {}, processing_error: null, multiplier: 1, offset: 0, notes: "", reference_id: null,
    result: { arrays: { energy: [8963, 8983, 9003], norm: [0, 0.7, 1], k: [1, 2, 3], weighted_chi: [0.1, -0.2, 0.3] }, effective: { e0: 8979 }, warnings: [] } }
}
export function differenceProject(): AthenaProject {
  return { id: "difference-project", version: 7, name: "Difference study", groups: [differenceGroup("data", "DATA foil"), differenceGroup("standard", "STANDARD foil"), differenceGroup("other", "Other scan")],
    journal: "", updated: "2026-09-07", undo: [], redo: [], history: [] }
}
export function differencePreview(project = differenceProject(), ids = ["data"], overrides: Partial<DifferenceOptions> = {}): DifferencePreview {
  const options = { ...differenceOptions, ...overrides }
  return { version: project.version, options, results: ids.map((id, index) => {
    const group = project.groups.find(group => group.id === id)!
    const e0 = Number(group.result?.effective.e0 ?? 8979)
    return { group_id: id, label: `diff ${group.label} - ${project.groups.find(group => group.id === options.standard_id)?.label}`,
      energy: [8950, 8980, 9010], difference: [0.2, -0.1, 0.3], data: [0.5, 0.7, 1.1], standard: [0.3, 0.8, 0.8],
      form: options.form, data_form: options.form === "norm" ? "flat" : options.form, standard_form: options.form,
      area: options.integrate ? (index === 0 ? -0.25 : 0.75) : null, e0,
      integration: options.integrate ? { xmin: options.xmin, xmax: options.xmax, lower: e0 + options.xmin, upper: e0 + options.xmax, converged: true, iterations: 3 } : null,
      warnings: [], y_label: "Difference signal", area_label: "eV", extrapolated_points: 0,
      k: options.plot_space === "k" ? [1, 2, 3] : [], weighted_chi: options.plot_space === "k" ? [0.2, -0.4, 0.3] : [], kweight: options.plot_space === "k" ? 2 : null, k_error: null }
  }) }
}
export function differenceSaved(project: AthenaProject, preview: DifferencePreview): AthenaProject {
  const groups = preview.results.map(result => ({ ...differenceGroup(`diff-${result.group_id}`, result.label), is_difference: !preview.options.renormalize,
    data_type: preview.options.form === "xmu" ? "mu" as const : "xanes" as const, energy: result.energy, mu: result.difference, source: { operation: "difference" } }))
  return { ...project, version: project.version + 1, groups: [...project.groups, ...groups], undo: ["difference"],
    last_operation: { action: "difference", skipped_group_ids: [], difference_results: groups.map((group, index) => ({ group_id: group.id, source_group_id: preview.results[index].group_id, label: group.label, area: preview.results[index].area })) } }
}
