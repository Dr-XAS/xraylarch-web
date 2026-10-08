import type { Parameters } from "./athena"

export type NumericRange = { min?: number; max?: number; exclusiveMin?: boolean; exclusiveMax?: boolean; integer?: boolean }

// Match AthenaParameters in athena_science.py. These are admissible values,
// not suggested fit intervals: usable energy/k support depends on the spectrum.
export const parameterRanges = {
  e0: { min: 0, exclusiveMin: true, max: 1e7 },
  step: { min: 0, exclusiveMin: true },
  pre1: { max: 0, exclusiveMax: true }, pre2: { max: 0 },
  norm1: { min: 0 }, norm2: { min: 0, exclusiveMin: true },
  nnorm: { min: 0, max: 3, integer: true },
  rbkg: { min: 0, exclusiveMin: true, max: 20 },
  bkg_kmin: { min: 0, max: 100 }, bkg_kmax: { min: 0, exclusiveMin: true, max: 100 },
  bkg_kweight: { min: 0, max: 3 }, bkg_dk: { min: 0, max: 20 },
  nclamp: { min: 0, max: 100, integer: true },
  clamp_lo: { min: 0, max: 1000 }, clamp_hi: { min: 0, max: 1000 },
  kmin: { min: 0, max: 100 }, kmax: { min: 0, exclusiveMin: true, max: 100 },
  kweight: { min: 0, max: 3 }, dk: { min: 0, max: 20 },
  rmin: { min: 0, max: 100 }, rmax: { min: 0, exclusiveMin: true, max: 100 },
  dr: { min: 0, max: 20 }, energy_shift: { min: -100000, max: 100000 },
  nfft: { min: 128, max: 65536, integer: true }, kstep: { min: .001, max: 1 },
} satisfies Partial<Record<keyof Parameters, NumericRange>>

export function numericRangeProblem(value: number | null | undefined, range: NumericRange, label: string, optional = false): string | null {
  if (value == null) return optional ? null : `${label} requires a number.`
  if (!Number.isFinite(value)) return `${label} must be finite.`
  if (range.integer && !Number.isInteger(value)) return `${label} must be a whole number.`
  if (range.min !== undefined && (value < range.min || (range.exclusiveMin && value === range.min)))
    return `${label} must be ${range.exclusiveMin ? "greater than" : "at least"} ${range.min}.`
  if (range.max !== undefined && (value > range.max || (range.exclusiveMax && value === range.max)))
    return `${label} must be ${range.exclusiveMax ? "less than" : "at most"} ${range.max}.`
  return null
}

const labels: Partial<Record<keyof Parameters, string>> = {
  e0: "E₀", step: "Edge step", pre1: "Pre-edge start", pre2: "Pre-edge end",
  norm1: "Post-edge start", norm2: "Post-edge end", kweight: "FT k-weight",
  bkg_kweight: "Spline k-weight", bkg_kmin: "Spline k min", bkg_kmax: "Spline k max",
  kmin: "FT k min", kmax: "FT k max", rmin: "R min", rmax: "R max",
  nclamp: "Clamp points", rbkg: "Rbkg", nfft: "FFT points", kstep: "k grid step",
}
const automatic = new Set(["e0", "step", "pre1", "pre2", "norm1", "norm2", "nnorm", "bkg_kmax", "kmax"])

export function parameterRangeProblem(parameters: Parameters): string | null {
  for (const [key, range] of Object.entries(parameterRanges)) {
    const value = parameters[key as keyof Parameters] as number | null | undefined
    // Older saved recipes omit these fields and use server defaults.
    if (value === undefined && ["bkg_dk", "nclamp"].includes(key)) continue
    const problem = numericRangeProblem(value, range, labels[key as keyof Parameters] ?? key, automatic.has(key))
    if (problem) return problem
  }
  for (const [low, high] of [["pre1", "pre2"], ["norm1", "norm2"], ["bkg_kmin", "bkg_kmax"], ["kmin", "kmax"], ["rmin", "rmax"]] as const) {
    const a = parameters[low], b = parameters[high]
    if (a !== null && b !== null && a >= b) return `${labels[high]} must be greater than ${labels[low]}.`
  }
  if ((parameters.nfft & (parameters.nfft - 1)) !== 0) return "FFT points must be a power of two from 128 through 65536."
  const rlast = Math.PI / (parameters.kstep * parameters.nfft) * (parameters.nfft / 2 - 1)
  if (parameters.rmax + parameters.dr / 2 > rlast) return "R max + dr/2 exceeds the FFT R range; lower it or decrease the k grid step."
  for (const [window, width] of [["window", "dk"], ["rwindow", "dr"], ["bkg_window", "bkg_dk"]] as const) {
    if (parameters[window] === "gaussian" && (parameters[width] ?? 1) <= 0) return `Gaussian windows require a positive ${width}.`
  }
  return null
}
