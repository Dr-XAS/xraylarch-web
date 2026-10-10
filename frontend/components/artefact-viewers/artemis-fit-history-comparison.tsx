'use client'

import { useId, useMemo, useState } from 'react'
import type { ArtemisFitArchive } from '@/lib/artemis'
import { download, format } from '@/lib/artemis-fit-utils'
import { buildHistoryComparison, historyComparisonFilename, type HistoryComparisonContext, type HistoryComparisonReport, type FitSnapshot, type ParameterSnapshot, type PathSnapshot } from '@/lib/artemis-history-comparison'
import styles from './artemis-fit-history-comparison.module.css'

const number = (value: number | null, digits = 7) => value === null ? 'Unavailable' : format(value, digits)
const text = (value: string | null) => value || 'Unavailable'
const kinds = { guess: 'Varied', set: 'Fixed', def: 'Derived' }
const transforms = [
  ['fitspace', 'Fit space', ''], ['kmin', 'k min', 'Å⁻¹'], ['kmax', 'k max', 'Å⁻¹'],
  ['kweight', 'k weights', ''], ['rmin', 'R min', 'Å'], ['rmax', 'R max', 'Å'],
  ['dk', 'k taper', 'Å⁻¹'], ['dr', 'R taper', 'Å'], ['window', 'k window', ''],
] as const
const statistics = [
  ['r_factor', 'R factor'], ['reduced_chi_square', 'Reduced χ²'], ['chi_square', 'χ²'],
  ['n_varys', 'Free parameters'], ['n_independent', 'Independent points'], ['epsilon_k', 'Noise ε(k)'],
] as const
function setting(value: string | number | number[] | null) {
  return value === null ? 'Unavailable' : Array.isArray(value) ? value.join(', ') : typeof value === 'number' ? number(value) : value
}
function date(value: string) {
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString() : value || 'Unknown date'
}
function fitLabel(history: ArtemisFitArchive[], id: string) {
  const index = history.findIndex(fit => fit.id === id), fit = history[index]
  return fit ? `Fit ${index + 1} · ${date(fit.created)}${fit.imported ? ' · Imported' : ''}` : 'Choose a saved fit'
}
function initialPair(history: ArtemisFitArchive[], initialReferenceId?: string) {
  const baseline = history.find(fit => fit.id === initialReferenceId)?.id ?? history.at(-1)?.id ?? ''
  return { baseline, comparison: history.findLast(fit => fit.id !== baseline)?.id ?? '' }
}

function FitIdentity({ title, fit, label }: { title: string; fit: FitSnapshot; label: string }) {
  return <section className={styles.identity} aria-label={`${title} fit`}><h5>{title}</h5><p>{label}</p>
    <p>{fit.success === null ? 'Convergence unavailable' : fit.success ? 'Converged' : 'Did not converge'}</p>
    <p>{fit.input_current === null ? 'Loaded input match unknown' : fit.input_current ? 'Matches loaded processed input' : 'Different from loaded processed input'}</p>
    {fit.imported !== false && <p>{fit.imported ? 'Imported fit · unverified' : 'Import provenance unavailable'}</p>}
    <p>Engine: {text(fit.engine)}</p><p>Larch: {text(fit.origin.larch_version)}</p>
    {fit.message && !fit.success && <p>{fit.message}</p>}
  </section>
}

function ParameterValue({ value, title }: { value: ParameterSnapshot | null; title: string }) {
  return <div><h6>{title}</h6>{value ? <><p className={styles.value}>{number(value.value)}</p>
    <p>{value.kind ? kinds[value.kind] : 'Kind unavailable'}</p>
    <p>Initial value: {number(value.initial)}</p>
    {value.kind !== 'set' && <p>Standard error: {number(value.stderr)}</p>}
    <p>Bounds: {value.min === null ? 'none saved' : number(value.min)} to {value.max === null ? 'none saved' : number(value.max)}</p>
    {value.expression && <p className={styles.expression}>{value.expression}</p>}
  </> : <p>Unavailable</p>}</div>
}

function PathValue({ value, title }: { value: PathSnapshot | null; title: string }) {
  return <div><h6>{title}</h6>{value ? <><p>{text(value.filename)}</p>
    <dl className={styles.pathValues}>
      <div><dt>{value.distance_kind === 'single_scattering' ? 'Distance R' : value.distance_kind === 'half_path_length' ? 'Half-path length R' : 'Path R'}</dt><dd>{number(value.r)}{value.r !== null && ' Å'}</dd></div>
      <div><dt>σ²</dt><dd>{number(value.sigma2)}{value.sigma2 !== null && ' Å²'}</dd></div>
      <div><dt>Path ΔE₀</dt><dd>{number(value.e0)}{value.e0 !== null && ' eV'}</dd></div>
      <div><dt>Path amplitude factor</dt><dd>{number(value.s02)}</dd></div>
    </dl>
  </> : <p>Unavailable</p>}</div>
}

function Report({ report, history }: { report: HistoryComparisonReport; history: ArtemisFitArchive[] }) {
  return <>
    <p className={styles.context}>{report.group_label} · Loaded project revision {report.version}</p>
    <p className={styles.input}>{report.same_input === null ? 'Recorded input match is unknown.' : report.same_input ? 'Both fits used the same recorded input.' : 'The fits used different recorded inputs.'}</p>
    <div className={styles.pair}>
      <FitIdentity title="Reference" fit={report.baseline} label={fitLabel(history, report.baseline_fit_id)} />
      <FitIdentity title="Comparison" fit={report.comparison} label={fitLabel(history, report.comparison_fit_id)} />
    </div>
    <details className={styles.notes}><summary>How to read this comparison</summary><ul>{report.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>
    <section aria-label="Saved fit conditions"><h4>Fit conditions</h4>
      {report.transform_changes.length > 0 && <p>Changed: {report.transform_changes.map(change => change.label).join(', ')}.</p>}
      <table><thead><tr><th scope="col">Condition</th><th scope="col">Reference</th><th scope="col">Comparison</th></tr></thead><tbody>
        {transforms.map(([key, label, unit]) => <tr key={key}><th scope="row">{label}{unit && <small>{unit}</small>}</th><td>{setting(report.baseline.transform[key])}</td><td>{setting(report.comparison.transform[key])}</td></tr>)}
      </tbody></table>
    </section>
    <section aria-label="Saved fit statistics"><h4>Fit statistics</h4>
      <p>Read these with the fit conditions and noise estimates. Lower values alone do not establish a better physical model.</p>
      <p>Saved ε(k) applies to the plotted k weight; multi-weight fits can have additional noise scales.</p>
      <table><thead><tr><th scope="col">Statistic</th><th scope="col">Reference</th><th scope="col">Comparison</th></tr></thead><tbody>
        {statistics.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{number(report.baseline.statistics[key])}</td><td>{number(report.comparison.statistics[key])}</td></tr>)}
        <tr><th scope="row">Standard errors estimated</th>{[report.baseline, report.comparison].map((fit, index) => <td key={index}>{fit.statistics.errorbars === null ? 'Unavailable' : fit.statistics.errorbars ? 'Yes' : 'No'}</td>)}</tr>
      </tbody></table>
      <details className={styles.notes}><summary>Additional statistics</summary><table><thead><tr><th scope="col">Statistic</th><th scope="col">Reference</th><th scope="col">Comparison</th></tr></thead><tbody>
        {([['aic', 'AIC'], ['bic', 'BIC'], ['n_data', 'Data points'], ['nfev', 'Function evaluations']] as const).map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{number(report.baseline.statistics[key])}</td><td>{number(report.comparison.statistics[key])}</td></tr>)}
      </tbody></table></details>
    </section>
    <section aria-label="Saved parameter differences"><h4>Parameter differences</h4><p>Δ is comparison minus reference. Standard errors describe individual fits; these differences are not significance tests.</p>
      {report.parameter_changes.map(parameter => <details className={styles.record} key={parameter.name}><summary><strong>{parameter.name}</strong><span>Δ {number(parameter.delta)}</span></summary>
        <div className={styles.recordBody}><div className={styles.pair}><ParameterValue title="Reference" value={parameter.baseline} /><ParameterValue title="Comparison" value={parameter.comparison} /></div>
          {parameter.bounds_changed && <p>Saved bounds differ.</p>}{parameter.initial_changed && <p>Saved initial values differ.</p>}{parameter.notes.length > 0 && <ul>{parameter.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
        </div>
      </details>)}
      {!report.parameter_changes.length && <p>No saved parameters to compare.</p>}
    </section>
    <section aria-label="Saved path differences"><h4>Fitted path differences</h4><p>R uses the saved FEFF path length plus its fitted ΔR. For multiple scattering, R is half the total path length.</p>
      {report.path_changes.map(path => <details className={styles.record} key={path.id}><summary><strong>{path.label}</strong><span>ΔR {number(path.delta_r)}{path.delta_r !== null && ' Å'}</span></summary>
        <div className={styles.recordBody}><div className={styles.pair}><PathValue title="Reference" value={path.baseline} /><PathValue title="Comparison" value={path.comparison} /></div>
          <p>Δσ²: {number(path.delta_sigma2)}{path.delta_sigma2 !== null && ' Å²'}</p>
          {path.notes.length > 0 && <ul>{path.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
        </div>
      </details>)}
      {!report.path_changes.length && <p>No saved paths to compare.</p>}
    </section>
    <details className={styles.notes}><summary>Fit provenance and warnings</summary>
      {([['Reference', report.baseline], ['Comparison', report.comparison]] as const).map(([title, fit]) => {
        return <section key={title}><h5>{title}</h5><dl className={styles.provenance}>
          <div><dt>Saved fit ID</dt><dd>{fit.id}</dd></div><div><dt>Input SHA-256</dt><dd>{text(fit.input_sha256)}</dd></div>
          <div><dt>Original project</dt><dd>{text(fit.origin.project_id)}</dd></div><div><dt>Original group</dt><dd>{text(fit.origin.group_id)}</dd></div>
          <div><dt>Original revision</dt><dd>{number(fit.origin.project_version)}</dd></div>
        </dl>{fit.warnings.length > 0 ? <ul>{fit.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : <p>No warnings saved.</p>}</section>
      })}
    </details>
  </>
}

export function ArtemisFitHistoryComparison({ context, history, initialReferenceId, pending = false }: {
  context: HistoryComparisonContext; history: ArtemisFitArchive[]; initialReferenceId?: string; pending?: boolean
}) {
  return <HistoryComparison key={`${context.projectId}:${context.groupId}`} context={context} history={history} initialReferenceId={initialReferenceId} pending={pending} />
}

function HistoryComparison({ context, history, initialReferenceId, pending }: {
  context: HistoryComparisonContext; history: ArtemisFitArchive[]; initialReferenceId?: string; pending: boolean
}) {
  const [open, setOpen] = useState(false), [pair, setPair] = useState(() => initialPair(history, initialReferenceId))
  const [notice, setNotice] = useState<{ report: HistoryComparisonReport; message: string } | null>(null), [error, setError] = useState('')
  const id = useId()
  const baseline = history.find(fit => fit.id === pair.baseline), comparison = history.find(fit => fit.id === pair.comparison)
  const reason = pending ? 'Waiting for project updates to finish before comparing saved fits.' : history.length < 2 ? 'Save at least two fits for this spectrum to compare them.'
    : new Set(history.map(fit => fit.id)).size !== history.length ? 'Saved fit IDs are not unique. Reload the project before comparing.'
    : !baseline || !comparison ? 'A selected fit is no longer available. Choose two saved fits to continue.'
    : baseline.id === comparison.id ? 'Choose two different saved fits.' : ''
  const prepared = useMemo(() => {
    if (!open || reason || !baseline || !comparison) return { report: null, error: '' }
    try { return { report: buildHistoryComparison(context, baseline, comparison), error: '' } }
    catch (error) { return { report: null, error: error instanceof Error ? error.message : 'The saved fits could not be compared.' } }
  }, [open, reason, context.projectId, context.projectName, context.version, context.groupId, context.groupLabel, context.currentInputSha256, baseline, comparison])
  const report = prepared.report
  function toggle() {
    if (!open) setPair(initialPair(history, initialReferenceId))
    setNotice(null); setError(''); setOpen(value => !value)
  }
  function choose(which: 'baseline' | 'comparison', value: string) {
    setNotice(null); setError('')
    setPair(previous => which === 'baseline'
      ? { baseline: value, comparison: value === previous.comparison ? previous.baseline : previous.comparison }
      : { baseline: value === previous.baseline ? previous.comparison : previous.baseline, comparison: value })
  }
  function exportReport() {
    if (!report || pending) return
    setError(''); setNotice(null)
    const filename = historyComparisonFilename(report)
    try { download(filename, JSON.stringify(report, null, 2) + '\n'); setNotice({ report, message: `Downloaded ${filename}` }) }
    catch (error) { setError(error instanceof Error ? error.message : 'The comparison download failed.') }
  }
  return <div className={styles.comparison}>
    <button type="button" disabled={pending || history.length < 2} aria-expanded={open} aria-controls={id} onClick={toggle}>Compare saved fits</button>
    {!open && history.length < 2 && <p className={styles.hint}>Save at least two fits for this spectrum to compare them.</p>}
    {open && <section id={id} aria-label="Saved fit comparison" aria-busy={pending}>
      <p>This comparison reads saved fits in the loaded project. Reload the project to include changes from another browser. Choosing a reference changes neither the model editor nor the result currently plotted.</p>
      <div className={styles.selectors}>
        <label><span>Reference saved fit</span><select value={baseline ? pair.baseline : ''} disabled={pending} onChange={event => choose('baseline', event.target.value)}>
          {!baseline && <option value="">Choose a saved fit</option>}{history.map(fit => <option key={fit.id} value={fit.id}>{fitLabel(history, fit.id)}</option>)}
        </select></label>
        <label><span>Comparison saved fit</span><select value={comparison ? pair.comparison : ''} disabled={pending} onChange={event => choose('comparison', event.target.value)}>
          {!comparison && <option value="">Choose a saved fit</option>}{history.map(fit => <option key={fit.id} value={fit.id}>{fitLabel(history, fit.id)}</option>)}
        </select></label>
      </div>
      {reason && <p role="status">{reason}</p>}
      {(error || prepared.error) && <p className="ath-error" role="alert">{error || prepared.error}</p>}
      {report && <Report report={report} history={history} />}
      <div className={styles.actions}><button type="button" disabled={!report || pending} onClick={exportReport}>Download fit comparison JSON</button></div>
      {notice?.report === report && <p role="status">{notice.message}</p>}
    </section>}
  </div>
}
