import { artemisApi, type ArtemisFitRequest, type ArtemisFitResult } from "./artemis"

/** Whether this server has the differentiable engine, asked once per page.
 *
 *  The engine is an optional install (jax and diffexafs-core), absent from a
 *  standard deployment; the panel hides itself rather than offer a button
 *  that can only fail. A failed request is not an answer, so it is not cached.
 */
let fastStatus: Promise<{ available?: boolean; reason?: string | null }> | null = null
export function fastEngineStatus() {
  fastStatus ??= artemisApi<{ available?: boolean; reason?: string | null }>("/fast-fit/status")
    .catch(error => { fastStatus = null; throw error })
  return fastStatus
}

/** Refit a model on the differentiable backend.
 *
 *  A server without the engine answers with `fast_engine_unavailable` and a
 *  reason the user can read, in case the status above could not be read.
 */
export function runFastFit(projectId: string, groupId: string, request: ArtemisFitRequest, signal?: AbortSignal) {
  return artemisApi<ArtemisFitResult>(
    `/projects/${encodeURIComponent(projectId)}/groups/${encodeURIComponent(groupId)}/fit/fast`, request, signal)
}

/** What "the same answer" means on screen. Nothing is called agreement unless
 *  all three hold, and the panel prints these numbers beside the verdict.
 *  The backend suite holds the twelve benchmark fits to a tenth of these. */
export const SAME_FIT_TOLERANCE = {
  /** Every Guess within this fraction of its own reference standard error. */
  valueSigma: 0.1,
  /** χ² within this fraction of the reference χ². */
  chiSquareRelative: 1e-3,
  /** The two forward models within this, in the noise-weighted residual. */
  parity: 1e-6,
} as const

export type FitVerdict =
  | { kind: "not_compared"; reason: string }
  | { kind: "same" | "different"; worstSigma: number; worstName: string; chiSquareChange: number; parity: number | undefined; failed: string[] }

/** Judge two fits of the same model on the scale that means something.
 *
 *  A fitted value is only determined to the width of its own uncertainty, so
 *  that -- not a count of decimal digits -- is the scale two backends are
 *  judged on. No verdict is given when either engine did not converge or did
 *  not produce uncertainties: there is then no scale to judge on, and a
 *  comparison would claim more than the numbers support.
 */
export function judgeFits(reference: ArtemisFitResult, fast: ArtemisFitResult): FitVerdict {
  if (!reference.success || !fast.success) {
    const which = !reference.success && !fast.success ? "Neither engine" : !reference.success ? "The reference fit" : "The fast fit"
    return { kind: "not_compared", reason: `${which} did not converge, so the two answers are not compared.` }
  }
  if (!reference.statistics.errorbars || !fast.statistics.errorbars) {
    const which = !reference.statistics.errorbars && !fast.statistics.errorbars ? "Neither engine" : !reference.statistics.errorbars ? "The reference fit" : "The fast fit"
    return { kind: "not_compared", reason: `${which} reported no uncertainties, so there is no scale on which to compare the two answers.` }
  }
  // Every Guess is judged, or none is: a parameter left out of the judgement
  // could move by any amount under a verdict of "same", so a guess the other
  // fit lacks, or one without a usable reference error, declines the comparison.
  const guesses = (fit: ArtemisFitResult) => fit.parameters.filter(row => row.kind === "guess")
  const rows = new Map(guesses(reference).map(row => [row.name, row]))
  const fastGuesses = guesses(fast)
  const unmatched = [...fastGuesses.filter(row => !rows.has(row.name)).map(row => row.name),
    ...Array.from(rows.keys()).filter(name => !fastGuesses.some(row => row.name === name))]
  if (unmatched.length) return { kind: "not_compared", reason: `The two fits do not guess the same parameters (${unmatched.join(", ")}), so they are not fits of one model.` }
  const unscaled = Array.from(rows.values()).filter(row => !(typeof row.stderr === "number" && Number.isFinite(row.stderr) && row.stderr > 0)).map(row => row.name)
  if (!rows.size || unscaled.length) return { kind: "not_compared", reason: rows.size
    ? `The reference fit has no usable standard error for ${unscaled.join(", ")}, so that parameter cannot be judged and the two answers are not compared.`
    : "Neither fit guesses any parameter, so there is nothing to compare." }
  let worstSigma = 0, worstName = ""
  for (const row of fastGuesses) {
    const expected = rows.get(row.name)!
    const sigma = Math.abs(row.value - expected.value) / expected.stderr!
    if (!(sigma < worstSigma)) { worstSigma = sigma; worstName = row.name }
  }
  const referenceChi = reference.statistics.chi_square
  if (!(Number.isFinite(referenceChi) && referenceChi > 0)) return { kind: "not_compared", reason: "The reference χ² is zero or not finite, so a relative change in χ² has no scale and the two answers are not compared." }
  const chiSquareChange = (fast.statistics.chi_square - referenceChi) / referenceChi
  const parity = fast.metadata?.engine_parity
  const failed = [
    ...(!(worstSigma <= SAME_FIT_TOLERANCE.valueSigma) ? ["fitted values"] : []),
    ...(!(Math.abs(chiSquareChange) <= SAME_FIT_TOLERANCE.chiSquareRelative) ? ["χ²"] : []),
    ...(parity === undefined || !(parity <= SAME_FIT_TOLERANCE.parity) ? ["forward models"] : []),
  ]
  return { kind: failed.length ? "different" : "same", worstSigma, worstName, chiSquareChange, parity, failed }
}

/** Round a duration the way a reader reads it: milliseconds when small, seconds when not. */
export function formatSeconds(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`
}
