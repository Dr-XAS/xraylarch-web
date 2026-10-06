"use client"

import styles from "./athena-analysis-summary.module.css"

/** Numbers reported as "value ± error" for the peak and combination fits.
 *
 * The error sets the precision: a value is shown to two significant digits of
 * its own standard error, so the displayed digits are the ones the fit resolves.
 */
export function plusMinus(value: number, stderr: number | null | undefined) {
  if (stderr === null || stderr === undefined || !Number.isFinite(stderr)) return `${value.toPrecision(5)} (no error)`
  if (stderr === 0) return `${value.toPrecision(5)} (fixed)`
  const places = Math.max(0, Math.min(8, 1 - Math.floor(Math.log10(Math.abs(stderr)))))
  return `${value.toFixed(places)} ± ${stderr.toFixed(places)}`
}

/** A weight as a percentage, saying why an error is missing when it is. */
export function weightNote(weight: number, stderr: number | null | undefined) {
  if (stderr === null || stderr === undefined || !Number.isFinite(stderr)) {
    return weight <= 1e-6 ? "held at zero" : "no error"
  }
  return stderr === 0 ? "fixed" : `± ${(stderr * 100).toFixed(1)}%`
}

const CORRELATED_RESIDUALS =
  "Weight uncertainties are nominal least-squares errors, with the weights held at zero treated as fixed rather than fitted. They assume these standards describe the target and that residuals are independent; interpolated XANES residuals are correlated, so read them as lower bounds."

/** What the "reduced χ²" of an LCF or peak fit is, said wherever it is shown. */
export const UNWEIGHTED_CHI =
  "Reduced χ² here is the unweighted residual sum of squares over the degrees of freedom, in squared signal units. No measurement noise enters it, so it ranks fits of the same data over the same window; it is not a goodness-of-fit test, and it says nothing about whether the model is the right one."

type Weights = { weights?: number[]; labels?: string[]; weight_stderr?: (number | null)[]
  weight_stderr_warning?: string | null
  rfactor?: number; reduced_chisqr?: number | null; degrees_of_freedom?: number | null }

function fitQuality(result: Weights) {
  const parts = [`R-factor ${Number(result.rfactor).toPrecision(4)}`]
  if (result.reduced_chisqr !== null && result.reduced_chisqr !== undefined) parts.push(`unweighted reduced χ² ${result.reduced_chisqr.toPrecision(4)}`)
  if (result.degrees_of_freedom !== null && result.degrees_of_freedom !== undefined) parts.push(`${result.degrees_of_freedom} degrees of freedom`)
  return parts.join(" · ")
}

/** The fitted fractions of one linear combination, with their standard errors.
 *
 * The analysis report travels as free-form JSON, so each summary narrows it
 * here rather than making every caller do the cast.
 */
export function LcfWeights({ result: report, labels }: { result: Record<string, unknown>; labels?: string[] }) {
  const result = report as unknown as Weights
  const weights = result.weights ?? []
  const names = labels ?? result.labels ?? []
  const stderr = result.weight_stderr ?? []
  return <>
    <div className="ath-weights">{weights.map((weight, index) =>
      <div key={index}>
        <span>{names[index] ?? `Standard ${index + 1}`}</span>
        <strong>{(weight * 100).toFixed(1)}%</strong>
        <span>{weightNote(weight, stderr[index])}</span>
      </div>)}
    </div>
    <p>{fitQuality(result)}</p>
    <p className={`ath-hint ${styles.note}`}>{result.weight_stderr_warning ?? CORRELATED_RESIDUALS}</p>
  </>
}

type Combination = { indices: number[]; weights: number[]; weight_stderr: (number | null)[]
  rfactor: number; reduced_chisqr: number | null }
type Search = { labels?: string[]; combinations?: Combination[]; best?: Weights & { indices?: number[] }
  tried?: number; skipped?: number }

/** Every fitted subset of the standards, ranked, with the winner spelt out. */
export function LcfSearchSummary({ result: report }: { result: Record<string, unknown> }) {
  const result = report as unknown as Search
  const labels = result.labels ?? []
  const combinations = result.combinations ?? []
  const best = result.best
  const name = (index: number) => labels[index] ?? `Standard ${index + 1}`
  return <>
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead><tr><th>Standards</th><th>R-factor</th><th>Unweighted reduced χ²</th></tr></thead>
        <tbody>{combinations.map((row, rank) =>
          <tr key={rank} className={rank === 0 ? styles.best : undefined}>
            <td>{row.indices.map((index, position) => `${name(index)} ${(row.weights[position] * 100).toFixed(1)}%`).join(" · ")}</td>
            <td>{row.rfactor.toPrecision(4)}</td>
            <td>{row.reduced_chisqr === null ? "—" : row.reduced_chisqr.toPrecision(4)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <p>{result.tried} combinations fitted{result.skipped ? `, ${result.skipped} skipped as linearly dependent` : ""}. R-factor can only fall as standards are added, so compare the reduced χ² before preferring a longer combination, and prefer it only when each added weight is several times its own error.</p>
    <p className={`ath-hint ${styles.note}`}>{UNWEIGHTED_CHI}</p>
    {best && <LcfWeights result={best as unknown as Record<string, unknown>} labels={(best.indices ?? []).map(name)} />}
  </>
}

type SeriesRow = Weights & { label?: string; error?: string }
type LcfSeries = { labels?: string[]; targets?: SeriesRow[]; xmin?: number; xmax?: number }

/** Every target scan against the same standards: one row per scan, one column per standard. */
export function LcfSeriesSummary({ result: report }: { result: Record<string, unknown> }) {
  const result = report as unknown as LcfSeries
  const standards = result.labels ?? []
  const rows = result.targets ?? []
  const failed = rows.filter(row => row.error)
  return <>
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead><tr><th>Target</th>{standards.map(name => <th key={name}>{name}</th>)}<th>R-factor</th><th>Unweighted reduced χ²</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          <td>{row.label ?? `Target ${index + 1}`}</td>
          {row.error ? <td colSpan={standards.length + 2}>not fitted</td> : <>
            {standards.map((name, s) => <td key={name}>{`${((row.weights?.[s] ?? NaN) * 100).toFixed(1)}%`} <span className={styles.note}>{weightNote(row.weights?.[s] ?? 0, row.weight_stderr?.[s])}</span></td>)}
            <td>{Number(row.rfactor).toPrecision(3)}</td>
            <td>{row.reduced_chisqr === null || row.reduced_chisqr === undefined ? "—" : row.reduced_chisqr.toPrecision(3)}</td>
          </>}
        </tr>)}</tbody>
      </table>
    </div>
    <p>{rows.length - failed.length} of {rows.length} targets fitted against the same {standards.length} standards over {Number(result.xmin).toFixed(1)}–{Number(result.xmax).toFixed(1)}, each on its own.</p>
    {failed.map((row, index) => <p className="ath-warning" key={index}>{row.error}</p>)}
    <p className={`ath-hint ${styles.note}`}>Each row is the fit a single-target LCF gives. The weights say how these standards combine to reproduce each scan; they identify phases only if the standards are the right ones, and a trend in them is real only where it exceeds the errors and the residuals stay small. {CORRELATED_RESIDUALS} {UNWEIGHTED_CHI}</p>
  </>
}

type Suggestion = { id: string; name: string; formula?: string; oxidation_state?: string
  technique?: string; rfactor: number; scale: number; points: number }
type Unusable = { id?: string; name?: string; reason?: string }
type Suggestions = { suggestions?: Suggestion[]; skipped?: Unusable[]; unusable?: Unusable[]
  element?: string; edge?: string; xmin?: number; xmax?: number; array?: string; considered?: number; citation?: string }

/** Whether a ranking still answers the question the dialog will fit: same signal, same window. */
export function suggestionsMatch(report: Record<string, unknown>, settings: Record<string, unknown>) {
  const result = report as Suggestions
  return result.array === settings.array && result.xmin === Number(settings.xmin) && result.xmax === Number(settings.xmax)
}

/** Bundled standards ranked by how well each alone matches the unknown's shape.
 *
 * Each row is its own single-component fit with a free scale, so the R-factors
 * rank the standards against one another but do not compare with a combination
 * fit's R-factor, which is a different question on a different model. The scale
 * is the fitted multiplier; on its own it establishes neither shape agreement
 * nor abundance, so the panel says so.
 */
export function ReferenceSuggestions({ result: report, picked, onPick, stale = false }: {
  result: Record<string, unknown>; picked: string[]; onPick: (ids: string[]) => void
  /** The dialog's signal or window changed after this ranking was made. */
  stale?: boolean }) {
  const result = report as unknown as Suggestions
  const suggestions = result.suggestions ?? []
  const unusable = [...(result.skipped ?? []), ...(result.unusable ?? [])]
  const toggle = (id: string, on: boolean) => onPick(on ? [...picked, id] : picked.filter(item => item !== id))
  if (stale) return <p className="ath-warning" role="status">These suggestions were ranked over {Number(result.xmin).toFixed(1)}–{Number(result.xmax).toFixed(1)} eV on a different fit signal or range than the one now set. Suggest again before choosing standards.</p>
  return <>
    <p>{result.considered} bundled {result.element} {result.edge}-edge standards fitted one at a time over {Number(result.xmin).toFixed(1)}–{Number(result.xmax).toFixed(1)} eV.</p>
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead><tr><th>Use</th><th>Standard</th><th>Oxidation state</th><th>R-factor</th><th>Scale</th></tr></thead>
        <tbody>{suggestions.map((row, rank) =>
          <tr key={row.id} className={rank === 0 ? styles.best : undefined}>
            <td><input type="checkbox" aria-label={`Use ${row.name}`} checked={picked.includes(row.id)}
              onChange={event => toggle(row.id, event.target.checked)} /></td>
            <td>{row.name}{row.formula ? ` (${row.formula})` : ""}{row.technique && row.technique !== "XAS" ? ` · ${row.technique}` : ""}</td>
            <td>{row.oxidation_state ?? "—"}</td>
            <td>{row.rfactor.toPrecision(3)}</td>
            <td>{row.scale.toFixed(2)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {!suggestions.length && <p className="ath-warning">No bundled standard could be fitted over this range.</p>}
    {unusable.map((row, index) => <p className="ath-warning" key={index}>{row.name ?? row.id} could not be used: {row.reason}</p>)}
    <p className={`ath-hint ${styles.note}`}>Each standard is fitted alone with a free scale, so these R-factors rank the standards against each other; they are not comparable with a combination fit&apos;s R-factor. The scale is the fitted multiplier: it does not measure how well the shapes agree (the R-factor does), nor how much of this species is present — a scale away from 1 can come from a different edge-step normalization, a mixture, or a poor match. {result.citation}</p>
  </>
}

type Parameter = { value: number; stderr: number | null; vary?: boolean }
type PeakFit = { parameters?: Record<string, Parameter>; redchi?: number
  details?: { peak_kinds?: string[]; uncertainties_available?: boolean; background?: string } }

/** The background that was fitted under the peaks, in words: the line, and
 * the edge step when there is one, with its form and which of its centre and
 * width were held where the user put them. The step changes pre-edge areas,
 * so a summary that names only the line describes a different model. */
function backgroundText(parameters: Record<string, Parameter>, label: string | undefined, unit: string) {
  const slope = parameters.background_slope, intercept = parameters.background_intercept
  const line = slope && intercept ? `${plusMinus(slope.value, slope.stderr)} × x + ${plusMinus(intercept.value, intercept.stderr)}` : ""
  const height = parameters.step_amplitude, center = parameters.step_center, width = parameters.step_sigma
  if (!height || !center || !width) return line ? `background ${line}` : ""
  const form = label?.includes("erf") ? "error-function" : "arctangent"
  const held = (p: Parameter) => p.vary === false ? " (held)" : ` (fitted${p.stderr == null ? "" : `, ±${p.stderr.toPrecision(2)}`})`
  return `background ${line} + ${form} step: height ${plusMinus(height.value, height.stderr)}, centre ${center.value.toFixed(2)} ${unit}${held(center)}, width ${width.value.toPrecision(3)} ${unit}${held(width)}`
}

const PEAK_COLUMNS = [["amplitude", "Area"], ["center", "Centre"], ["fwhm", "FWHM"], ["height", "Height"]] as const

/** Fitted peak areas, positions and widths with their standard errors. */
export function PeakSummary({ result: report, unit = "eV" }: { result: Record<string, unknown>; unit?: string }) {
  const result = report as unknown as PeakFit
  const parameters = result.parameters ?? {}
  const kinds = result.details?.peak_kinds ?? []
  const background = backgroundText(parameters, result.details?.background, unit)
  return <>
    <table className={styles.table}>
      <thead><tr><th>Peak</th><th>Shape</th>{PEAK_COLUMNS.map(([, title]) => <th key={title}>{title}</th>)}</tr></thead>
      <tbody>{kinds.map((kind, position) => {
        const index = position + 1
        return <tr key={index}>
          <td>{index}</td>
          <td>{kind}</td>
          {PEAK_COLUMNS.map(([key, title]) => {
            const parameter = parameters[`peak_${index}_${key}`]
            return <td key={title}>{parameter ? plusMinus(parameter.value, parameter.stderr) : "—"}</td>
          })}
        </tr>
      })}</tbody>
    </table>
    <p>Unweighted reduced χ² {Number(result.redchi).toPrecision(4)}{background ? ` · ${background}` : ""}</p>
    <p className={`ath-hint ${styles.note}`}>Area is the integrated peak area (signal × {unit}); centre and FWHM are in {unit}. Errors are nominal: they assume this peak model and independent residuals, so read them as lower bounds. {UNWEIGHTED_CHI}</p>
    {result.details?.uncertainties_available === false &&
      <p className="ath-warning">The fit converged but produced no error estimates; the peaks are probably not separable with these starting values.</p>}
  </>
}

type SeriesSpectrum = { parameters?: Record<string, Parameter>; redchi?: number }
type Consistency = { parameter: string; fitted_alone: number; of: number; mean?: number; chi_square?: number
  degrees_of_freedom?: number; probability?: number; consistent?: boolean; warning?: string }
type PeakSeries = { spectra?: SeriesSpectrum[]; labels?: string[]; redchi?: number
  consistency?: Consistency[]; warnings?: string[]
  details?: { peak_kinds?: string[]; uncertainties_available?: boolean; shared_across_series?: string[]; background?: string } }

/** One peak series fitted together: the tied peaks once, then each spectrum.
 *
 * A series fit exists to measure the shared peak energies and widths on the
 * whole series at once, so those are reported once at the top with the single
 * error the series supports. What varies spectrum by spectrum — the areas, and
 * any centre or width that was not tied — goes in the table below, one row per
 * spectrum, which is the trend a reader is there to see.
 */
export function PeakSeriesSummary({ result: report, unit = "eV" }: { result: Record<string, unknown>; unit?: string }) {
  const result = report as unknown as PeakSeries
  const spectra = result.spectra ?? []
  const labels = result.labels ?? []
  const kinds = result.details?.peak_kinds ?? []
  const shared = result.details?.shared_across_series ?? []
  // The tie makes every spectrum carry the same value for a shared parameter,
  // so the first spectrum speaks for the series.
  const tied = spectra[0]?.parameters ?? {}
  const sharedColumns: [string, string][] = [
    ...(shared.includes("center") ? [["center", "Centre"] as [string, string]] : []),
    ...(shared.includes("sigma") ? [["fwhm", "FWHM"] as [string, string]] : [])]
  const perSpectrum: [string, string][] = [["amplitude", "area"],
    ...(shared.includes("center") ? [] : [["center", "centre"] as [string, string]]),
    ...(shared.includes("sigma") ? [] : [["fwhm", "FWHM"] as [string, string]])]
  const columnTitle = (title: string, index: number) =>
    kinds.length === 1 ? title[0].toUpperCase() + title.slice(1) : `Peak ${index} ${title}`
  const cell = (parameters: Record<string, Parameter>, name: string) => {
    const parameter = parameters[name]
    return parameter ? plusMinus(parameter.value, parameter.stderr) : "—"
  }
  const checks = result.consistency ?? []
  const step = tied.step_amplitude && tied.step_center && tied.step_sigma
  // Each spectrum's own step: its height, and the centre (its own E0 by
  // default) and width it was held at or fitted to.
  const stepCell = (parameters: Record<string, Parameter>, name: string) => {
    const parameter = parameters[name]
    if (!parameter) return "—"
    if (name === "step_amplitude") return plusMinus(parameter.value, parameter.stderr)
    const value = name === "step_center" ? parameter.value.toFixed(2) : parameter.value.toPrecision(3)
    return parameter.vary === false ? `${value} (held)` : plusMinus(parameter.value, parameter.stderr)
  }
  const stepColumns: [string, string][] = step ? [["step_amplitude", "Step height"], ["step_center", `Step centre (${unit})`], ["step_sigma", `Step width (${unit})`]] : []
  const stepNote = step ? ` Each spectrum has its own background: a line plus ${result.details?.background?.includes("erf") ? "an error-function" : "an arctangent"} step whose centre and width were ${tied.step_center.vary === false && tied.step_sigma.vary === false ? "held where they were set" : "fitted"} and whose height was fitted.` : ""
  return <>
    {(result.warnings ?? []).map((warning, index) => <p className="ath-warning" role="alert" key={index}>{warning}</p>)}
    {checks.length > 0 && <table className={styles.table}>
      <caption>Is sharing supported? Each spectrum fitted on its own first</caption>
      <thead><tr><th>Shared quantity</th><th>Fitted alone</th><th>χ² / degrees of freedom</th><th>p</th><th>Verdict</th></tr></thead>
      <tbody>{checks.map(check => <tr key={check.parameter}>
        <td>{check.parameter.replace(/^peak_(\d+)_center$/, "Peak $1 centre").replace(/^peak_(\d+)_sigma$/, "Peak $1 width")}</td>
        <td>{check.fitted_alone} of {check.of}</td>
        <td>{check.chi_square === undefined ? "—" : `${check.chi_square.toPrecision(3)} / ${check.degrees_of_freedom}`}</td>
        <td>{check.probability === undefined ? "—" : check.probability.toPrecision(2)}</td>
        <td>{check.consistent === undefined ? "not checked" : check.consistent ? "consistent with one value" : "not supported"}</td>
      </tr>)}</tbody>
    </table>}
    {sharedColumns.length > 0 && <table className={styles.table}>
      <thead><tr><th>Shared peak</th><th>Shape</th>{sharedColumns.map(([, title]) => <th key={title}>{title}</th>)}</tr></thead>
      <tbody>{kinds.map((kind, position) =>
        <tr key={position}>
          <td>{position + 1}</td>
          <td>{kind}</td>
          {sharedColumns.map(([key, title]) => <td key={title}>{cell(tied, `peak_${position + 1}_${key}`)}</td>)}
        </tr>)}
      </tbody>
    </table>}
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead><tr><th>Spectrum</th>
          {kinds.flatMap((_, position) => perSpectrum.map(([key, title]) =>
            <th key={`${position}-${key}`}>{columnTitle(title, position + 1)}</th>))}
          {stepColumns.map(([key, title]) => <th key={key}>{title}</th>)}
          <th>Misfit</th></tr></thead>
        <tbody>{spectra.map((spectrum, row) =>
          <tr key={row}>
            <td>{labels[row] ?? `Spectrum ${row + 1}`}</td>
            {kinds.flatMap((_, position) => perSpectrum.map(([key]) =>
              <td key={`${position}-${key}`}>{cell(spectrum.parameters ?? {}, `peak_${position + 1}_${key}`)}</td>))}
            {stepColumns.map(([key]) => <td key={key}>{stepCell(spectrum.parameters ?? {}, key)}</td>)}
            <td>{Number(spectrum.redchi).toPrecision(3)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <p>{spectra.length} spectra fitted together{sharedColumns.length > 0 ? `, sharing peak ${[...(shared.includes("center") ? ["positions"] : []), ...(shared.includes("sigma") ? ["widths"] : [])].join(" and ")}` : ""} · unweighted reduced χ² {Number(result.redchi).toPrecision(4)}</p>
    <p className={`ath-hint ${styles.note}`}>Area is the integrated peak area (signal × {unit}); centre and FWHM are in {unit}. A shared value carries one error for the whole series, conditional on the sharing being right. The table above fits each spectrum on its own first and asks whether the separate values agree within their nominal errors, under this peak and background model: it can detect a disagreement, but passing it does not show that the value is physically common, and it does not account for correlated residuals or an error in the background model. Errors are nominal lower bounds.{stepNote} The misfit column is a spectrum&apos;s mean squared residual — its share of the total, not a separate fit quality.</p>
    {result.details?.uncertainties_available === false &&
      <p className="ath-warning">The series fit converged but produced no error estimates; the peaks are probably not separable with these starting values.</p>}
  </>
}
