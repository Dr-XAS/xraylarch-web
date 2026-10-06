import type { ArtemisFitRequest, ArtemisFitResult } from "./artemis"

export interface FitHealth {
  state: "good" | "caution" | "bad" | "railed" | "neutral"
  reason: string
}

// Display criteria ported from Dr.XAS's fitting-results-summary.tsx. These
// assess the saved result without changing the fit or its reported values.
const RULES = {
  amp: { unit: "", low: 0.7, high: 1, outerLow: 0.7, outerHigh: 1 },
  e0: { unit: "eV", low: -5, high: 5, outerLow: -10, outerHigh: 10 },
  sigma2: { unit: "Å²", low: 0.003, high: 0.02, outerLow: 0.003, outerHigh: 0.02 },
  deltar: { unit: "Å", low: -0.1, high: 0.1, outerLow: -0.1, outerHigh: 0.1 },
}
type ParameterKey = keyof typeof RULES
const ALIASES: Record<string, ParameterKey> = {
  amp: "amp", s02: "amp", e0: "e0", deltae: "e0", del_e0: "e0",
  sigma2: "sigma2", ss2: "sigma2", sig2: "sigma2",
  deltar: "deltar", dr: "deltar", del_r: "deltar",
}
const PATH_KEYS: Record<"s02" | "e0" | "sigma2" | "deltar", ParameterKey> = {
  s02: "amp", e0: "e0", sigma2: "sigma2", deltar: "deltar",
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nonnegative(value: unknown): number | null {
  const number = finite(value)
  return number !== null && number >= 0 ? number : null
}

function parameterKey(name: string, paths?: ArtemisFitRequest["paths"]): ParameterKey | null {
  // Only a direct reference establishes a custom parameter's units. Variables
  // inside formulas (e.g. alpha * reff or sigma2_eins(T, theta)) do not inherit
  // the result's physical range, and conflicting direct roles are ambiguous.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null
  const roles = new Set<ParameterKey>()
  let compositeReference = false
  for (const path of paths ?? []) {
    if (!path.enabled) continue
    for (const field of Object.keys(PATH_KEYS) as (keyof typeof PATH_KEYS)[]) {
      const expression = path[field].trim()
      if (expression === name) roles.add(PATH_KEYS[field])
      else if (expression.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.includes(name)) {
        // The native CN helper keeps S0² explicit; its independently generated
        // s02 and cn suffixes need not agree. Other formulas do not prove units.
        const nativeAmplitude = field === "s02" && expression.match(/^(s02_\d+)\s*\*\s*cn_\d+\s*\/\s*degen$/)?.[1] === name
        if (!nativeAmplitude) compositeReference = true
      }
    }
  }
  if (roles.size > 1) return null
  if (roles.size === 1) return [...roles][0]
  if (compositeReference) return null
  const lower = name.toLowerCase()
  return Object.entries(ALIASES).find(([key]) => lower === key || lower.startsWith(`${key}_`))?.[1] ?? null
}

export function parameterHealth(
  parameter: ArtemisFitResult["parameters"][number],
  options: { errorbars?: boolean; paths?: ArtemisFitRequest["paths"] } = {},
): FitHealth {
  const key = parameterKey(parameter.name, options.paths)
  const value = finite(parameter.value)
  if (!key || value === null) return { state: "neutral", reason: "No available value or reference range." }
  if (key === "amp" && parameter.kind === "def" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.expression.trim())) {
    return { state: "neutral", reason: "Composite amplitude expressions are not assessed as standalone S0²." }
  }
  const rule = RULES[key]
  // The report does not claim uncertainty for fixed parameters or when the
  // fit could not estimate errors. Def parameters can have propagated errors.
  const error = parameter.kind === "set" || options.errorbars === false ? null : nonnegative(parameter.stderr)
  const criterion = `In range: ${rule.low} to ${rule.high}${rule.unit ? ` ${rule.unit}` : ""}, including ±1σ when available.${key === "e0" ? " Borderline up to |ΔE0| = 10 eV." : ""}`
  if (key === "amp" && parameter.kind === "guess" && !parameter.expression.trim() &&
      [finite(parameter.min), finite(parameter.max)].some(bound => bound !== null && Math.abs(value - bound) <= 1e-4)) {
    return { state: "railed", reason: "Varied S0² is within 0.0001 of its recorded fit bound." }
  }
  if (value < rule.outerLow || value > rule.outerHigh) return { state: "bad", reason: criterion }
  const inside = value >= rule.low && value <= rule.high &&
    (error === null || (value - error >= rule.low && value + error <= rule.high))
  return { state: inside ? "good" : "caution", reason: criterion }
}

export function rFactorHealth(value: unknown): FitHealth {
  const rfactor = nonnegative(value)
  return {
    state: rfactor === null ? "neutral" : rfactor < 0.05 ? "good" : "bad",
    reason: "In range below 0.05; out of range at or above 0.05.",
  }
}

export function independentPointsHealth(nind: unknown, nvarys: unknown): FitHealth {
  const independent = nonnegative(nind), variables = nonnegative(nvarys)
  return {
    state: independent === null || variables === null || variables === 0 ? "neutral"
      : independent >= 2 * variables ? "good" : independent > variables ? "caution" : "bad",
    reason: "In range: n_indep ≥ 2 × n_varys. Borderline: n_varys < n_indep < 2 × n_varys. Out of range: n_indep ≤ n_varys. Zero fitted variables is not assessed.",
  }
}

export function correlationHealth(value: unknown): FitHealth {
  const coefficient = finite(value)
  return {
    state: coefficient === null ? "neutral" : Math.abs(coefficient) >= 0.9 ? "bad" : Math.abs(coefficient) >= 0.8 ? "caution" : "good",
    reason: "In range below |r| = 0.8. Borderline from |r| = 0.8. Out of range at |r| ≥ 0.9: the pair is close to degenerate and the two values cannot be read independently.",
  }
}
