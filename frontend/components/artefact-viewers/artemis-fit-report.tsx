"use client"

import { Download, FileJson, FileText, TriangleAlert } from "lucide-react"
import type { ArtemisFitResult } from "@/lib/artemis"
import { download, exportBundle, format } from "@/lib/artemis-fit-utils"
import { correlationHealth, independentPointsHealth, parameterHealth, rFactorHealth, type FitHealth } from "@/lib/artemis-fit-health"
import { SectionHelp } from "../section-help"
import styles from "./artemis-fit-report.module.css"

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value)
const kindLabels = { guess: "Varied", set: "Fixed", def: "Derived" }
const healthLabels = { good: "In range", caution: "Borderline", bad: "Out of range", railed: "Railed on bound", neutral: "Not assessed" }

function healthAttributes(health: FitHealth) {
  const description = `${healthLabels[health.state]}: ${health.reason}`
  return { "data-health": health.state, title: description, "aria-description": description }
}

// Match the report summary's bound check in backend/xraylarch_web/agent_fit.py.
function parameterBound(parameter: ArtemisFitResult["parameters"][number]) {
  if (parameter.kind !== "guess" || !finite(parameter.value) || !finite(parameter.min) || !finite(parameter.max) || parameter.max <= parameter.min) return null
  const margin = (parameter.max - parameter.min) * 1e-3
  if (parameter.value <= parameter.min + margin) return "min"
  if (parameter.value >= parameter.max - margin) return "max"
  return null
}

export function ArtemisFitReport({ result }: { result: ArtemisFitResult }) {
  const { statistics: stats, transform } = result
  const informationHealth = independentPointsHealth(stats.n_independent, stats.n_varys)
  const fitPaths = result.request?.paths.filter(path => result.paths.some(fitted => fitted.id === path.id))
  const correlations = result.correlations.filter(pair => finite(pair.value)).slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  const strongCorrelations = correlations.filter(pair => Math.abs(pair.value) >= 0.9)
  const reviewNotes: string[] = []
  if (finite(stats.r_factor) && stats.r_factor > 0.05) reviewNotes.push("R factor is above 0.05. Review the model and fit range; convergence alone does not establish a good fit.")
  if (finite(stats.n_varys) && finite(stats.n_independent) && stats.n_varys >= stats.n_independent) reviewNotes.push("Free parameters meet or exceed the number of independent points. Reduce the number of varied parameters or reconsider the fit range.")
  if (strongCorrelations.length) reviewNotes.push("Some parameters are strongly correlated (|correlation| ≥ 0.90). Their values may not be independently determined.")
  const boundParameters = result.parameters.filter(parameter => parameterBound(parameter))
  if (boundParameters.length) reviewNotes.push(`Parameters at a bound: ${boundParameters.map(parameter => parameter.name).join(", ")}. Their standard errors may be unreliable; review the constraints.`)
  if (!stats.errorbars) reviewNotes.push("Parameter uncertainties could not be estimated reliably for this fit.")

  return <section className={styles.report} aria-label="Fit report">
    <header className={styles.header}>
      <div className={styles.heading}><FileText size={18} aria-hidden="true" /><div><h4>Fit report</h4><p>{result.group_label}</p></div></div>
      <span className={styles.status} data-converged={result.success}>{result.success ? "Converged" : "Did not converge"}
        <SectionHelp label="Fit convergence">Convergence describes the optimizer stopping. Assess the residual, uncertainties and correlations before interpreting the model.</SectionHelp>
      </span>
    </header>

    {!result.success && <p className={styles.failure} role="alert">Fit did not converge: {result.message}</p>}
    <dl className={styles.metrics}>
      <div className={styles.primaryMetric} data-review={finite(stats.r_factor) && stats.r_factor > 0.05}>
        <dt>R factor<SectionHelp label="R factor">Normalized squared residual in the fit space. Lower values indicate closer agreement; a small R factor alone does not validate the model.</SectionHelp></dt>
        <dd {...healthAttributes(rFactorHealth(stats.r_factor))}>{format(stats.r_factor, 5)}</dd><span className={styles.metricHint}>Model–data agreement</span>
      </div>
      <div><dt>Reduced χ²<SectionHelp label="Reduced chi square">Chi square scaled by the fit's degrees of freedom. Its size depends on the noise estimate as well as the residual.</SectionHelp></dt><dd>{format(stats.reduced_chi_square, 5)}</dd><span className={styles.metricHint}>Depends on noise estimate</span></div>
      <div><dt>Free parameters</dt><dd {...healthAttributes(informationHealth)}>{format(stats.n_varys)}</dd><span className={styles.metricHint}>Varied in this fit</span></div>
      <div><dt>Independent points<SectionHelp label="Independent points">The information available over the fit range. This is different from the number of sampled data points.</SectionHelp></dt><dd {...healthAttributes(informationHealth)}>{format(stats.n_independent, 4)}</dd><span className={styles.metricHint}>Available information</span></div>
      <div><dt>Noise ε(k)<SectionHelp label="Noise estimate">χ² and the uncertainties are measured against this noise ε(k), estimated from the high-R part of the transform. Two fits are only comparable on χ² when they share that scale.</SectionHelp></dt><dd>{format(stats.epsilon_k)}</dd><span className={styles.metricHint}>Scale of χ² and uncertainties</span></div>
    </dl>

    {reviewNotes.length > 0 && <aside className={styles.review} aria-label="Fit review notes">
      <strong><TriangleAlert size={15} aria-hidden="true" /> Review before interpreting</strong>
      <ul>{reviewNotes.map(note => <li key={note}>{note}</li>)}</ul>
    </aside>}

    <section className={styles.section} aria-label="Fitted parameters">
      <div className={styles.sectionHeading}><h5>Fitted parameters<SectionHelp label="Parameter treatment">Uncertainty is Larch’s estimated standard error. Fixed values have no fitted uncertainty. Varied = Guess, optimized by the fit. Fixed = Set, held at its supplied value. Derived = Def, calculated from an expression. Parameter names are user defined.</SectionHelp></h5><span>{result.parameters.length} total</span></div>
      <div className={styles.tableScroll} role="region" aria-label="Fitted parameter values" tabIndex={0}><table aria-label="Fitted parameters">
        <thead><tr><th scope="col">Parameter</th><th scope="col">Value ± uncertainty</th><th scope="col">Initial value</th><th scope="col">Treatment</th></tr></thead>
        <tbody>{result.parameters.map(parameter => <tr key={parameter.name}>
          <th scope="row"><code>{parameter.name}</code>{parameter.expression && <span className={styles.expression}>{parameter.expression}</span>}</th>
          <td {...healthAttributes(parameterHealth(parameter, { errorbars: stats.errorbars, paths: fitPaths }))}><span className={styles.value}>{format(parameter.value, 7)}</span><span className={styles.uncertainty}>{parameter.kind === "set" ? " —" : stats.errorbars && finite(parameter.stderr) ? ` ± ${format(parameter.stderr, 3)}` : " ± Unavailable"}</span></td>
          <td className={styles.secondary}>{format(parameter.initial, 7)}</td>
          <td><span className={styles.kind} data-kind={parameter.kind}>{kindLabels[parameter.kind]}</span>{parameterBound(parameter) && <span className={styles.bound}>At {parameterBound(parameter)} bound</span>}</td>
        </tr>)}</tbody>
      </table></div>
      <details className={styles.detail}>
        <summary>Parameter bounds &amp; expressions</summary>
        <div className={styles.tableScroll} role="region" aria-label="Parameter bounds and expressions" tabIndex={0}><table>
          <thead><tr><th scope="col">Parameter</th><th scope="col">Minimum</th><th scope="col">Maximum</th><th scope="col">Expression</th></tr></thead>
          <tbody>{result.parameters.map(parameter => <tr key={parameter.name}><th scope="row"><code>{parameter.name}</code></th><td>{format(parameter.min, 7)}</td><td>{format(parameter.max, 7)}</td><td className={styles.wrap}>{parameter.expression || "—"}</td></tr>)}</tbody>
        </table></div>
      </details>
    </section>

    {result.paths.length > 0 && <section className={styles.section} aria-label="Fitted paths">
      <div className={styles.sectionHeading}><h5>Fitted paths<SectionHelp label="Fitted path lengths">R = Rₑff + ΔR. For multiple scattering, R is half the total path length. For single scattering, R is the absorber–scatterer distance with the scattering phase accounted for. It is different from an uncorrected peak position in |χ(R)|. An em dash means the saved fit does not include this value.</SectionHelp></h5><span>{result.paths.length} {result.paths.length === 1 ? "path" : "paths"}</span></div>
      <div className={styles.tableScroll} role="region" aria-label="Fitted path lengths and disorder" tabIndex={0}><table>
        <caption className={styles.tableCaption}>Path disorder</caption>
        <thead><tr><th scope="col">Path</th><th scope="col">R (Å)</th><th scope="col">ΔR (Å)</th><th scope="col">σ² (Å²)</th></tr></thead>
        <tbody>{result.paths.map((path, index) => <tr key={path.id}>
          <th scope="row"><span className={styles.pathName}><span className={styles.pathIndex}>{index + 1}</span>{path.label || path.filename}</span><span className={styles.expression}>{path.filename} · {path.metadata.nleg === 2 ? "Single scattering" : "Multiple scattering"}</span></th>
          <td className={styles.value}>{finite(path.metadata.reff) && finite(path.values?.deltar) ? format(path.metadata.reff + path.values.deltar, 6) : "—"}</td>
          <td>{format(path.values?.deltar, 5)}</td><td>{format(path.values?.sigma2, 5)}</td>
        </tr>)}</tbody>
      </table></div>
      <details className={styles.detail}>
        <summary>Path values &amp; disorder expressions</summary>
        <div className={styles.tableScroll} role="region" aria-label="Path values and disorder expressions" tabIndex={0}><table>
          <thead><tr><th scope="col">Path</th><th scope="col">Rₑff (Å)</th><th scope="col">Degeneracy</th><th scope="col">S₀²</th><th scope="col">ΔE₀ (eV)</th><th scope="col">σ² expression</th></tr></thead>
          <tbody>{result.paths.map(path => <tr key={path.id}><th scope="row" className={styles.wrap}>{path.label || path.filename}</th><td>{format(path.metadata.reff, 6)}</td><td>{format(path.metadata.degen)}</td><td>{format(path.values?.s02, 6)}</td><td>{format(path.values?.e0, 6)}</td><td className={styles.wrap}>{path.sigma2_expression || "—"}</td></tr>)}</tbody>
        </table></div>
      </details>
    </section>}

    <details className={`${styles.section} ${styles.correlations}`} open>
      <summary>Parameter correlations ({correlations.length})<SectionHelp label="Parameter correlations">Values near −1 or +1 indicate parameters that change together. Bar length shows the absolute correlation.</SectionHelp></summary>
      {correlations.length ? <ul className={styles.correlationList}>{correlations.map(pair => <li key={`${pair.left}:${pair.right}`} data-strong={Math.abs(pair.value) >= 0.9}>
        <span className={styles.pair}><code>{pair.left}</code><span aria-hidden="true">↔</span><code>{pair.right}</code></span>
        <span className={styles.correlationBar} aria-hidden="true"><span style={{ width: `${Math.min(1, Math.abs(pair.value)) * 100}%` }} /></span>
        <span className={styles.correlationValue} {...healthAttributes(correlationHealth(pair.value))}>{pair.value > 0 ? "+" : ""}{pair.value.toFixed(3)}</span>
        <span className={styles.correlationLabel}>{Math.abs(pair.value) >= 0.9 ? "Strong" : ""}</span>
      </li>)}</ul> : <p className={styles.note}>No parameter correlations were reported for this fit.</p>}
    </details>

    <details className={styles.section}>
      <summary>Fit settings &amp; statistics<SectionHelp label="Fit statistics">AIC and BIC help compare models fitted to the same data with the same fit settings.</SectionHelp></summary>
      <dl className={styles.settings}>
        {([
          ["Fit space", transform.fitspace.toUpperCase()], ["k range", `${format(transform.kmin)}–${format(transform.kmax)} Å⁻¹`],
          ["R range", `${format(transform.rmin)}–${format(transform.rmax)} Å`], ["Fit k-weights", transform.kweight.join(", ")],
          ["k window", transform.window], ["Window taper dk", `${format(transform.dk)} Å⁻¹`], ["Window taper dR", `${format(transform.dr)} Å`],
          ["χ²", format(stats.chi_square, 7)], ["Data points", format(stats.n_data, 7)], ["Fit evaluations", format(stats.nfev, 7)],
          ["Akaike criterion (AIC)", format(stats.aic, 7)], ["Bayesian criterion (BIC)", format(stats.bic, 7)],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <p className={styles.note}>Optimizer message: {result.message || "Not reported"}</p>
    </details>

    {result.warnings.length > 0 && <details className={styles.section} open>
      <summary>Fit notes ({result.warnings.length})</summary>
      <ul className={styles.backendNotes}>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>}

    <details className={`${styles.section} ${styles.raw}`}>
      <summary><span>Larch fit report</span><span className={styles.summaryHint}>Original text</span></summary>
      <pre tabIndex={0} aria-label="Original Larch fit report">{result.report}</pre>
    </details>
    <footer className={styles.downloads}>
      <button type="button" onClick={() => download("artemis-fit-report.txt", result.report, "text/plain")}><Download size={14} aria-hidden="true" />Download report</button>
      {result.request && <button type="button" onClick={() => download("artemis-fit.json", exportBundle(result.request!, result, { project_id: result.project_id, group_id: result.group_id, group_label: result.group_label }))}><FileJson size={14} aria-hidden="true" />Download fit + model JSON</button>}
    </footer>
  </section>
}
