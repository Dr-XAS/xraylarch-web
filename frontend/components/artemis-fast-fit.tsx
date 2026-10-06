"use client"

import { useEffect, useRef, useState } from "react"
import { validArtemisResult, type ArtemisFitRequest, type ArtemisFitResult } from "@/lib/artemis"
import { fastEngineStatus, formatSeconds, judgeFits, runFastFit, SAME_FIT_TOLERANCE, type FitVerdict } from "@/lib/artemis-fast"
import styles from "./artemis-fast-fit.module.css"

const seconds = (value: number | undefined, absent = "not recorded") => value === undefined ? absent : formatSeconds(value)

function verdictText(verdict: FitVerdict) {
  if (verdict.kind === "not_compared") return `No agreement is claimed. ${verdict.reason}`
  const tolerance = SAME_FIT_TOLERANCE
  const details = `largest fitted-value difference ${verdict.worstSigma.toFixed(4)} of ${verdict.worstName}’s reference standard error (tolerance ${tolerance.valueSigma}); `
    + `χ² ${verdict.chiSquareChange <= 0 ? "lower" : "higher"} by ${Math.abs(verdict.chiSquareChange).toExponential(1)} relative (tolerance ${tolerance.chiSquareRelative.toExponential(0)}); `
    + `forward models differ by ${verdict.parity === undefined ? "an unreported amount" : verdict.parity.toExponential(1)} in the noise-weighted residual (tolerance ${tolerance.parity.toExponential(0)}).`
  return verdict.kind === "same"
    ? `Same answer within the stated tolerances: ${details}`
    : `Not the same answer within tolerance (${verdict.failed.join(", ")}): ${details}`
}

/** Run the same fit again on the differentiable backend, and say how the two differ.
 *
 *  This is a comparison, not an alternative way to fit: the result is shown and
 *  then discarded, so saved fit history stays single-engine. The reference fit
 *  it compares against is whichever result the panel is currently showing, and
 *  the caller only supplies a request when that result came from the model now
 *  in the editor, so both engines are answering the same question. Each engine's
 *  convergence, uncertainties and timings are shown side by side, phase for
 *  phase, and "same answer" is only said against the tolerances printed with it.
 */
export function ArtemisFastFitComparison({ projectId, groupId, request, reference, blocked, disabled }: {
  projectId: string
  groupId: string
  /** The model to refit, or null when there is nothing comparable to run. */
  request: ArtemisFitRequest | null
  reference: ArtemisFitResult | null
  /** Why no comparison is possible, shown to the user; empty when one is. */
  blocked: string
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [fast, setFast] = useState<{ result: ArtemisFitResult; seconds: number } | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  // Hidden only on the server's explicit "not installed"; if the status cannot
  // be read, the button stays and a refit reports the reason itself.
  const [installed, setInstalled] = useState(true)
  useEffect(() => {
    let live = true
    fastEngineStatus().then(status => { if (live && status?.available === false) setInstalled(false) }, () => {})
    return () => { live = false }
  }, [])

  async function compare() {
    if (!request || !reference || busy) return
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setError("")
    setFast(null)
    const started = performance.now()
    try {
      const result = await runFastFit(projectId, groupId, request, abort.signal)
      if (abort.signal.aborted) return
      if (!validArtemisResult(result, projectId, groupId, request.version)) {
        throw new Error("The fast backend returned a result that does not match this spectrum. Run the reference fit again.")
      }
      setFast({ result, seconds: (performance.now() - started) / 1000 })
    } catch (caught) {
      if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "The fast backend request failed.")
    } finally { if (!abort.signal.aborted) setBusy(false) }
  }

  const verdict = fast && reference ? judgeFits(reference, fast.result) : null
  const engines = fast && reference ? [reference, fast.result] as const : null
  const time = engines?.map(result => result.metadata?.seconds ?? {})
  if (!installed) return null
  return <div className={styles.panel}>
    <h4>Fast fit backend</h4>
    <button type="button" disabled={disabled || busy || !request || !reference} onClick={() => void compare()}>
      {busy ? "Refitting…" : "Refit on the fast backend"}
    </button>
    {blocked
      ? <p>{blocked}</p>
      : <p>Repeats the fit above with an exact derivative instead of finite differences. The result is shown for comparison and is not saved.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {engines && time && verdict && fast && <>
      <div className={styles.scroll}><table className={styles.engines}>
        <caption>Same model and data. Reference: {engines[0].metadata?.engine ?? "larch.feffit"}; fast: {engines[1].metadata?.engine ?? "unknown engine"}.</caption>
        <thead><tr><th scope="col"><span className={styles.hidden}>Quantity</span></th><th scope="col">Reference</th><th scope="col">Fast</th></tr></thead>
        <tbody>
          <tr><th scope="row">Converged</th>{engines.map((result, i) => <td key={i} className={result.success ? undefined : styles.bad}>{result.success ? "yes" : `no — ${result.message}`}</td>)}</tr>
          <tr><th scope="row">Uncertainties</th>{engines.map((result, i) => <td key={i} className={result.statistics.errorbars ? undefined : styles.bad}>{result.statistics.errorbars ? "estimated" : "not available"}</td>)}</tr>
          <tr><th scope="row">Residual evaluations</th>{engines.map((result, i) => <td key={i}>{result.statistics.nfev}</td>)}</tr>
          <tr><th scope="row">χ²</th>{engines.map((result, i) => <td key={i}>{result.statistics.chi_square.toPrecision(6)}</td>)}</tr>
          <tr><th scope="row">R-factor</th>{engines.map((result, i) => <td key={i}>{result.statistics.r_factor.toPrecision(4)}</td>)}</tr>
          <tr><th scope="row">Optimizer loop</th>{time.map((value, i) => <td key={i}>{seconds(value.optimizer)}</td>)}</tr>
          <tr><th scope="row">Compilation</th><td>none</td><td>{seconds(time[1].compile)}</td></tr>
          <tr><th scope="row">Whole fit call</th>{time.map((value, i) => <td key={i}>{seconds(value.fit)}</td>)}</tr>
          <tr><th scope="row">Server total</th>{time.map((value, i) => <td key={i}>{seconds(value.total)}</td>)}</tr>
          <tr><th scope="row">Browser round trip</th><td>not timed</td><td>{formatSeconds(fast.seconds)}</td></tr>
        </tbody>
      </table></div>
      <p className={verdict.kind === "same" ? undefined : styles.caution}>{verdictText(verdict)}</p>
      <p>Each row times the same phase on both engines. The whole fit call covers set-up, minimization, uncertainties and output curves; the server total adds reading the request. The fast engine also compiles its residual and Jacobian on every request, which dominates a fit this small. The reference fit&apos;s round trip is not timed because it is saved with the project.</p>
      {fast.result.warnings.length > 0 && <ul className={styles.warnings} aria-label="Fast fit warnings">{fast.result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
    </>}
  </div>
}
