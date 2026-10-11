'use client'

import { useEffect, useRef, useState } from 'react'
import type { AthenaProject } from '@/lib/athena'
import { useAthenaApi } from '@/lib/athena-context'
import { ApiRequestError } from '@/lib/backend-client'
import { confirmedQualityReport, hasReviewFindings, qualityReportFilename, type QualityReport, type QualityReportGroup, type QualityReportScope } from '@/lib/athena-quality-report'
import styles from './athena-quality-report.module.css'

const number = (value: number | null) => value === null ? 'Unavailable' : String(Number(value.toPrecision(7)))
const statuses: Record<QualityReportGroup['status'], string> = { processed: 'Processed', failed: 'Processing failed', unprocessed: 'No processed result' }

function GroupReview({ group, inspect }: { group: QualityReportGroup; inspect: (id: string) => void }) {
  const findings = [
    group.warnings.length ? `${group.warnings.length} warning${group.warnings.length === 1 ? '' : 's'}` : '',
    group.adjustments.length ? `${group.adjustments.length} adjusted parameter${group.adjustments.length === 1 ? '' : 's'}` : '',
    group.duplicate_inputs.length ? 'Identical inputs' : '',
  ].filter(Boolean)
  return <details className={styles.group}>
    <summary>
      <strong>{group.label}</strong>
      <span className={styles.status} data-failed={group.status === 'failed'}>{statuses[group.status]}</span>
      {findings.length > 0 && <span className={styles.findings}>{findings.join(' · ')}</span>}
    </summary>
    <div className={styles.body}>
      <p className={styles.identity}>{group.data_type} · {group.points.toLocaleString()} points{group.marked ? ' · Marked' : ''}{group.frozen ? ' · Frozen' : ''}</p>
      {group.processing_error && <p className="ath-error">{group.processing_error}</p>}
      {group.warnings.length > 0 && <div><h4>Processing warnings</h4><ul>{group.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {group.adjustments.length > 0 && <div><h4>Requested → effective parameters</h4><ul>{group.adjustments.map((adjustment, index) => <li key={index}>
        <strong>{adjustment.parameter}</strong>: {number(adjustment.requested)} → {number(adjustment.effective)}{adjustment.unit ? ` ${adjustment.unit}` : ''}
      </li>)}</ul></div>}
      {group.duplicate_inputs.length > 0 && <div><h4>Identical input arrays</h4><ul>{group.duplicate_inputs.map(duplicate => <li key={duplicate.id}>{duplicate.label}</li>)}</ul>
        <p>Matches include groups outside this review scope. Check their provenance before treating them as independent measurements.</p>
      </div>}
      <dl className={styles.values}>
        <div><dt>{group.axis === 'energy' ? 'Energy range (shift applied)' : 'k range'}</dt><dd>{group.range ? `${number(group.range[0])} to ${number(group.range[1])} ${group.axis === 'energy' ? 'eV' : 'Å⁻¹'}` : 'Unavailable'}</dd></div>
        <div><dt>Available k support</dt><dd>{number(group.available_kmax)}{group.available_kmax !== null ? ' Å⁻¹' : ''}</dd></div>
        <div><dt>E₀</dt><dd>{number(group.e0)}{group.e0 !== null ? ' eV' : ''}</dd></div>
        <div><dt>Edge step</dt><dd>{number(group.edge_step)}</dd></div>
      </dl>
      <p>{group.exafs ? 'EXAFS result available.' : 'EXAFS result unavailable.'} Available k support describes the data extent; inspect the spectrum to choose a usable fit range.</p>
      {group.notes.length > 0 && <ul>{group.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      <button type="button" onClick={() => inspect(group.id)}>View spectrum</button>
    </div>
  </details>
}

export function AthenaQualityReport({ project, close, inspect, reloadProject }: {
  project: AthenaProject
  close: () => void
  inspect: (id: string) => void
  reloadProject: () => Promise<boolean>
}) {
  const athenaApi = useAthenaApi()
  const [scope, setScope] = useState<QualityReportScope>('all')
  const [findingsOnly, setFindingsOnly] = useState(false)
  const [snapshot, setSnapshot] = useState<{ signature: string; report: QualityReport } | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const serial = useRef(0)
  const request = useRef(athenaApi)
  request.current = athenaApi
  const signature = JSON.stringify({ projectId: project.id, version: project.version, scope,
    groups: project.groups.map(group => [group.id, group.label, group.marked, group.frozen, group.data_type]), name: project.name })
  useEffect(() => {
    const token = ++serial.current
    const abort = new AbortController()
    setSnapshot(null); setLoading(true); setError(''); setNotice(''); setStale(false); setReloading(false)
    request.current<unknown>(`/projects/${project.id}/quality-report`, { version: project.version, scope }, 'POST', abort.signal)
      .then(data => {
        if (abort.signal.aborted || token !== serial.current) return
        if (!confirmedQualityReport(data, project, scope)) throw new Error('The review could not be confirmed against this project revision. Reload the project and try again.')
        setSnapshot({ signature, report: data })
      })
      .catch(error => {
        if (abort.signal.aborted || token !== serial.current) return
        const message = error instanceof Error ? error.message : 'The spectrum review failed.'
        const conflict = error instanceof ApiRequestError && error.status === 409
        setStale(conflict)
        setError(conflict ? `${message} Reload the project to review its latest saved revision.` : message)
      })
      .finally(() => { if (token === serial.current && !abort.signal.aborted) setLoading(false) })
    return () => { abort.abort(); serial.current++ }
  // The signature includes every project field used to confirm the response.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, retry])

  const report = snapshot?.signature === signature ? snapshot.report : null
  const groups = report?.groups.filter(group => !findingsOnly || hasReviewFindings(group)) ?? []
  function download() {
    if (!report || loading) return
    setError(''); setNotice('')
    try {
      const filename = qualityReportFilename(report)
      const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      try {
        anchor.href = url; anchor.download = filename
        document.body.appendChild(anchor); anchor.click()
        setNotice(`Downloaded ${filename}`)
      } finally {
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The review download failed.')
    }
  }
  async function reload() {
    if (reloading) return
    const token = serial.current
    setReloading(true)
    try {
      const loaded = await reloadProject()
      if (!loaded && token === serial.current) setError('The latest project revision could not be loaded. Check the connection and try again.')
    } catch (error) {
      if (token === serial.current) setError(error instanceof Error ? error.message : 'The project could not be reloaded.')
    } finally { if (token === serial.current) setReloading(false) }
  }
  return <section className={styles.review} aria-label="Spectrum review controls" aria-busy={loading || reloading}>
    <p>Review the saved processing results before comparing, merging or fitting spectra. This review makes no changes to the project.</p>
    <div className={styles.controls}>
      <label className="ath-field"><span>Review groups</span><select value={scope} disabled={reloading} onChange={event => setScope(event.target.value as QualityReportScope)}>
        <option value="all">All groups</option><option value="marked">Marked groups</option>
      </select></label>
      <label className="ath-check"><input type="checkbox" checked={findingsOnly} onChange={event => setFindingsOnly(event.target.checked)} />Only groups with findings</label>
    </div>
    {loading && <p role="status">Reviewing saved spectra…</p>}
    {error && <p className="ath-error" role="alert">{error}</p>}
    {report && <>
      <p className={styles.revision}>{report.project_name} · Revision {report.version} · {report.scope === 'all' ? 'All groups' : 'Marked groups'}</p>
      <dl className={styles.counts} aria-label="Spectrum review summary">
        {([
          ['Groups', report.counts.groups], ['Processed', report.counts.processed], ['Failed', report.counts.failed],
          ['Unprocessed', report.counts.unprocessed], ['With warnings', report.counts.with_warnings],
          ['With adjusted parameters', report.counts.with_adjustments], ['With identical inputs', report.counts.with_duplicate_inputs],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {report.notes.length > 0 && <ul className={styles.notes}>{report.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      {!report.groups.length && <p role="status">{scope === 'marked' ? 'No marked groups. Mark groups in the project or choose All groups.' : 'This project has no groups to review.'}</p>}
      {report.groups.length > 0 && <p>{groups.length} of {report.counts.groups} groups shown. Open a group for details.</p>}
      {!!report.groups.length && !groups.length && <p role="status">No groups have findings in this saved snapshot. Inspect the spectra before drawing scientific conclusions.</p>}
      <div className={styles.groups}>{groups.map(group => <GroupReview key={`${signature}:${group.id}`} group={group} inspect={inspect} />)}</div>
    </>}
    {notice && <p role="status">{notice}</p>}
    <div className={`ath-modal-actions ${styles.actions}`}>
      {stale && <button type="button" disabled={reloading} onClick={() => { void reload() }}>{reloading ? 'Reloading project…' : 'Reload project'}</button>}
      <button type="button" disabled={loading || reloading} onClick={() => setRetry(value => value + 1)}>Refresh review</button>
      <button type="button" onClick={close}>Close review</button>
      <button type="button" className="ath-primary" disabled={loading || !report} onClick={download}>Download review JSON</button>
    </div>
    <p className={styles.exportNote}>The JSON download contains every group in the reviewed scope, including groups hidden by the findings filter.</p>
  </section>
}
