'use client'

import { useEffect, useRef, useState } from 'react'
import type { AthenaProject } from '@/lib/athena'
import { useAthenaApi } from '@/lib/athena-context'
import { ApiRequestError } from '@/lib/backend-client'
import { comparisonGroupLabel, comparisonReportFilename, comparisonTargets, confirmedComparisonReport, type ComparisonGroup, type ComparisonReport, type ComparisonScope } from '@/lib/athena-comparison-report'
import styles from './athena-comparison-report.module.css'

const number = (value: number | null) => value === null ? 'Unavailable' : String(Number(value.toPrecision(7)))
const interval = (value: [number, number] | null, unit: string) => value ? `${number(value[0])} to ${number(value[1])} ${unit}` : 'No shared support'

function ComparisonCard({ group, project, inspect }: { group: ComparisonGroup; project: AthenaProject; inspect: (id: string) => void }) {
  const label = comparisonGroupLabel(project, group.id)
  return <details className={styles.group}>
    <summary><strong>{label}</strong><span>{group.energy_shift ? `Additional fitted shift ${number(group.energy_shift.value)} eV` : 'Fitted shift unavailable'}</span></summary>
    <div className={styles.body}>
      <p>{group.data_type} · {group.points.toLocaleString()} points</p>
      {group.processing_error && <p className="ath-error">{group.processing_error}</p>}
      <dl className={styles.metrics}>
        <div><dt>Additional fitted energy shift</dt><dd>{group.energy_shift ? `${number(group.energy_shift.value)} eV` : 'Unavailable'}</dd>
          {group.energy_shift ? <p>Fit standard error: {number(group.energy_shift.stderr)}{group.energy_shift.stderr !== null ? ' eV' : ''}. Fit interval: {interval(group.energy_shift.range, 'eV')}. This shift has not been applied.</p> : <p>{group.unavailable.energy_shift}</p>}
        </div>
        <div><dt>E₀ difference (group − reference)</dt><dd>{number(group.e0_difference)}{group.e0_difference !== null ? ' eV' : ''}</dd>{group.unavailable.e0_difference && <p>{group.unavailable.e0_difference}</p>}</div>
        <div><dt>Edge step ratio (group / reference)</dt><dd>{number(group.edge_step_ratio)}</dd>{group.unavailable.edge_step_ratio && <p>{group.unavailable.edge_step_ratio}</p>}</div>
        <div><dt>Largest normalized XANES difference</dt><dd>{group.xanes ? number(group.xanes.max_difference) : 'Unavailable'}</dd>
          {group.xanes ? <p>Evaluated over {interval(group.xanes.range, 'eV')} (upper bound excluded), using {group.xanes.points} reference points on the current energy axes.</p> : <p>{group.unavailable.xanes}</p>}
        </div>
        <div><dt>Shared {group.axis === 'energy' ? 'energy' : 'k'} support</dt><dd>{interval(group.common_range, group.axis === 'energy' ? 'eV' : 'Å⁻¹')}</dd></div>
      </dl>
      <h4>χ(k) amplitude ratios</h4>
      {group.chi_amplitude ? <>
        <p>Group / reference RMS amplitude at reference k weight {number(group.chi_amplitude.kweight)}, over {interval(group.chi_amplitude.range, 'Å⁻¹')}.</p>
        <dl className={styles.bins} aria-label={`Chi amplitude ratios for ${label}`}>
          {group.chi_amplitude.bins.map((bin, index) => <div key={index}><dt>{interval(bin.k, 'Å⁻¹')}</dt><dd>{number(bin.ratio)}</dd></div>)}
        </dl>
        <p>A ratio below 1 means lower weighted RMS amplitude in this window. Noise and processing choices also affect this ratio.</p>
      </> : <p>{group.unavailable.chi_amplitude}</p>}
      {group.duplicate_inputs.length > 0 && <><h4>Identical input arrays</h4><ul>{group.duplicate_inputs.map(duplicate => <li key={duplicate.id}>{comparisonGroupLabel(project, duplicate.id)}</li>)}</ul><p>Matches include groups outside the comparison scope. Check their provenance before treating them as independent measurements.</p></>}
      {group.notes.length > 0 && <ul>{group.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      <button type="button" onClick={() => inspect(group.id)}>View spectrum</button>
    </div>
  </details>
}

export function AthenaComparisonReport({ project, activeId, close, inspect, reloadProject }: {
  project: AthenaProject; activeId: string; close: () => void; inspect: (id: string) => void; reloadProject: () => Promise<boolean>
}) {
  const athenaApi = useAthenaApi()
  const initialReference = project.groups.find(group => group.id === activeId)?.id ?? project.groups[0]?.id ?? ''
  const [referenceId, setReferenceId] = useState(initialReference)
  const [scope, setScope] = useState<ComparisonScope>(() => comparisonTargets(project, initialReference, 'marked').length ? 'marked' : 'all')
  const [snapshot, setSnapshot] = useState<{ signature: string; report: ComparisonReport } | null>(null)
  const [loading, setLoading] = useState(false), [reloading, setReloading] = useState(false), [stale, setStale] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0)
  const serial = useRef(0), request = useRef(athenaApi)
  request.current = athenaApi
  const reference = project.groups.find(group => group.id === referenceId)
  const targets = comparisonTargets(project, referenceId, scope)
  const reason = !reference ? 'Choose a comparison reference from this project.' : !targets.length
    ? scope === 'marked' ? 'No other marked groups. Mark another group or choose All groups.' : 'Import another spectrum to compare with this reference.'
    : targets.length > 100 ? 'Compare at most 100 target groups at once. Mark a smaller batch.' : ''
  const signature = JSON.stringify({ projectId: project.id, name: project.name, version: project.version, referenceId, scope,
    groups: project.groups.map(group => [group.id, group.label, group.marked, group.data_type]) })
  useEffect(() => {
    const token = ++serial.current, abort = new AbortController()
    setSnapshot(null); setLoading(!reason); setReloading(false); setStale(false); setError(''); setNotice('')
    if (!reason) request.current<unknown>(`/projects/${project.id}/comparison-report`, { version: project.version, reference_id: referenceId, scope }, 'POST', abort.signal)
      .then(data => {
        if (abort.signal.aborted || token !== serial.current) return
        if (!confirmedComparisonReport(data, project, referenceId, scope)) {
          setStale(true)
          setError('The comparison could not be confirmed against this project revision and reference. Reload the project and try again.')
          return
        }
        setSnapshot({ signature, report: data })
      })
      .catch(error => {
        if (abort.signal.aborted || token !== serial.current) return
        const conflict = error instanceof ApiRequestError && error.status === 409
        setStale(conflict)
        const message = error instanceof Error ? error.message : 'The spectrum comparison failed.'
        setError(conflict ? `${message} Reload the project to compare its latest saved revision.` : message)
      })
      .finally(() => { if (!abort.signal.aborted && token === serial.current) setLoading(false) })
    return () => { abort.abort(); serial.current++ }
  // The signature includes the revision, ordered selection and comparison reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, reason, retry])
  const report = snapshot?.signature === signature && !reason ? snapshot.report : null

  function download() {
    if (!report || loading) return
    setError(''); setNotice('')
    try {
      const filename = comparisonReportFilename(report), url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }))
      const anchor = document.createElement('a')
      try {
        anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click()
        setNotice(`Downloaded ${filename}`)
      } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
    } catch (error) { setError(error instanceof Error ? error.message : 'The comparison download failed.') }
  }
  async function reload() {
    if (reloading) return
    const token = serial.current
    setReloading(true)
    try {
      if (!await reloadProject() && token === serial.current) setError('The latest project revision could not be loaded. Check the connection and try again.')
    } catch (error) { if (token === serial.current) setError(error instanceof Error ? error.message : 'The project could not be reloaded.') }
    finally { if (token === serial.current) setReloading(false) }
  }
  return <section className={styles.comparison} aria-label="Spectrum comparison controls" aria-busy={loading || reloading}>
    <p>Compare saved spectra against one reference on their current axes. The fitted shift is measured without changing any group; chemical differences can also affect it.</p>
    <div className={styles.controls}>
      <label className="ath-field"><span>Comparison reference</span><select value={reference ? referenceId : ''} disabled={reloading} onChange={event => setReferenceId(event.target.value)}>
        {!reference && <option value="">Choose a reference</option>}{project.groups.map(group => <option key={group.id} value={group.id}>{comparisonGroupLabel(project, group.id)}</option>)}
      </select></label>
      <label className="ath-field"><span>Comparison groups</span><select value={scope} disabled={reloading} onChange={event => setScope(event.target.value as ComparisonScope)}><option value="marked">Marked groups</option><option value="all">All groups</option></select></label>
    </div>
    <p>The comparison reference is excluded from the target groups. Choosing it here does not change linked references.</p>
    {reason && <p role="status">{reason}</p>}
    {loading && <p role="status">Comparing saved spectra…</p>}
    {error && <p role="alert" className="ath-error">{error}</p>}
    {report && <>
      <p className={styles.revision}>{report.project_name} · Revision {report.version} · {report.groups.length} {report.scope === 'marked' ? 'marked' : 'target'} groups</p>
      <section className={styles.reference} aria-label="Comparison reference summary"><h3>Compared with {comparisonGroupLabel(project, report.reference.id)}</h3>
        <p>{report.reference.data_type} · {report.reference.points.toLocaleString()} points · {interval(report.reference.range, report.reference.axis === 'energy' ? 'eV' : 'Å⁻¹')}</p>
        <p>E₀: {number(report.reference.e0)}{report.reference.e0 !== null ? ' eV' : ''} · Edge step: {number(report.reference.edge_step)} · Maximum available k: {number(report.reference.available_kmax)}{report.reference.available_kmax !== null ? ' Å⁻¹' : ''}</p>
        {report.reference.processing_error && <p className="ath-error">{report.reference.processing_error}</p>}
      </section>
      {report.notes.length > 0 && <details className={styles.notes}><summary>How to read this comparison</summary><ul>{report.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
      <p>Open a group to inspect its numerical comparison and the intervals used.</p>
      <div className={styles.groups}>{report.groups.map(group => <ComparisonCard key={`${signature}:${group.id}`} group={group} project={project} inspect={inspect} />)}</div>
    </>}
    {notice && <p role="status">{notice}</p>}
    <div className={`ath-modal-actions ${styles.actions}`}>
      {stale && <button type="button" disabled={reloading} onClick={() => { void reload() }}>{reloading ? 'Reloading project…' : 'Reload project'}</button>}
      <button type="button" disabled={!!reason || loading || reloading} onClick={() => setRetry(value => value + 1)}>Refresh comparison</button>
      <button type="button" onClick={close}>Close comparison</button>
      <button type="button" className="ath-primary" disabled={!report || loading || reloading} onClick={download}>Download comparison JSON</button>
    </div>
  </section>
}
