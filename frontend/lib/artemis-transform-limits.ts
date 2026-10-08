import type { ArtemisTransform } from "./artemis"

// Match FitTransform in the API. These are calculation limits, not universal
// physical maxima; a useful fit also needs measured signal and FEFF support.
export const artemisTransformLimits = {
  kmin: { min: 0, max: 49, step: "any" },
  kmax: { min: 1, max: 50, step: "any" },
  rmin: { min: 0, max: 9.9, step: "any" },
  rmax: { min: 0.1, max: 10, step: "any" },
  dk: { min: 0, max: 10, step: "any" },
  dr: { min: 0, max: 5, step: "any" },
} as const

/** Validate drafts and imported models before requesting scientific curves. */
export function validateArtemisTransform(transform: ArtemisTransform) {
  for (const [field, limits] of Object.entries(artemisTransformLimits)) {
    const value = transform[field as keyof typeof artemisTransformLimits]
    if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
      throw new Error(`${field}: enter a finite number from ${limits.min} to ${limits.max}.`)
    }
  }
  if (transform.kmax - transform.kmin < 1 - 1e-12) throw new Error("The k range must be at least 1 Å⁻¹ wide, with 0 ≤ minimum < maximum.")
  if (transform.rmax - transform.rmin < 0.1 - 1e-12) throw new Error("The R range must be at least 0.1 Å wide, with 0 ≤ minimum < maximum.")
  if (!transform.kweight.length) throw new Error("Select at least one fit k-weight.")
  if (transform.kweight.some(weight => !Number.isInteger(weight) || weight < 0 || weight > 3) || new Set(transform.kweight).size !== transform.kweight.length) {
    throw new Error("Select unique integer k-weights from 0 to 3.")
  }
}
