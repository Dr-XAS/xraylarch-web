'use client'

import { useEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { decodeApiError } from '@/lib/backend-client'
import styles from './athena-data-export.module.css'

type Scope = 'all' | 'marked'
type Report = { project_id: string; version: number; scope: Scope; filename: string
  columns: { index: number; key: string; label: string; unit: string; section: string }[]
  sections: { key: string; label: string }[]
  rows: { group_id: string; label: string; values: (string | number | null)[]; notes: string[] }[] }

function confirmed(data: Report, project: AthenaProject, scope: Scope) {
  const ids = project.groups.filter(g => scope === 'all' || g.marked).map(g => g.id)
  return data?.project_id === project.id && data.version === project.version && data.scope === scope
    && data.filename === `athena-parameters-${scope}.xls` && Array.isArray(data.columns) && data.columns.length === 28
    && new Set(data.columns.map(c => c.index)).size === 28 && data.columns.every(c => Number.isInteger(c.index) && c.index >= 0 && c.index < 32
      && [c.key, c.label, c.unit, c.section].every(v => typeof v === 'string'))
    && Array.isArray(data.sections) && data.sections.length === 5 && data.sections.every(s => typeof s.key === 'string' && typeof s.label === 'string')
    && Array.isArray(data.rows) && data.rows.length === ids.length && data.rows.every((r, i) => r.group_id === ids[i]
      && typeof r.label === 'string' && Array.isArray(r.values) && r.values.length === 32
      && r.values.every(v => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))
      && Array.isArray(r.notes) && r.notes.every(n => typeof n === 'string'))
}

export function AthenaParameterReport({ project, initialScope, close, onBusyChange }: {
  project: AthenaProject; initialScope: Scope; close: () => void; onBusyChange: (value: boolean) => void
}) {
  const [scope, setScope] = useState<Scope>(initialScope), [section, setSection] = useState('identity')
  const [preview, setPreview] = useState<{ signature: string; report: Report } | null>(null)
  const [loading, setLoading] = useState(false), [downloading, setDownloading] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0)
  const serial = useRef(0), pending = useRef(false), downloadAbort = useRef<AbortController | null>(null)
  const busy = useRef(onBusyChange); busy.current = onBusyChange
  const selected = project.groups.filter(g => scope === 'all' || g.marked)
  const signature = JSON.stringify({ version: project.version, scope }), base = `/projects/${project.id}/parameter-report`
  useEffect(() => {
    const token = ++serial.current, abort = new AbortController()
    setPreview(null); setError(''); setNotice(''); setLoading(!!selected.length)
    if (selected.length) athenaApi<Report>(`${base}/preview`, JSON.parse(signature), 'POST', abort.signal).then(data => {
      if (token !== serial.current || abort.signal.aborted) return
      if (!confirmed(data, project, scope)) throw new Error('The report preview could not be confirmed. Reload the project and retry.')
      setPreview({ signature, report: data })
    }).catch(e => { if (token === serial.current && !abort.signal.aborted) setError(e instanceof Error ? e.message : 'Report preview failed.') })
      .finally(() => { if (token === serial.current) setLoading(false) })
    return () => { abort.abort(); serial.current++ }
  }, [base, signature, selected.length, retry])
  useEffect(() => () => { downloadAbort.current?.abort(); busy.current(false) }, [project.id])
  async function download() {
    if (pending.current || loading || preview?.signature !== signature) return
    const token = serial.current, abort = new AbortController()
    downloadAbort.current = abort; pending.current = true; setDownloading(true); busy.current(true); setError(''); setNotice('')
    try {
      const response = await fetch(`/api/backend/api/athena${base}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: signature, signal: abort.signal })
      if (!response.ok) throw decodeApiError(response.status, await response.json().catch(() => null))
      if (response.headers.get('X-Athena-Project-Version') !== String(project.version)
        || response.headers.get('Content-Disposition') !== `attachment; filename="${preview.report.filename}"`)
        throw new Error('The report revision or filename could not be confirmed. Reload the project and retry.')
      const blob = await response.blob(), bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
      if (bytes.join(',') !== '208,207,17,224,161,177,26,225') throw new Error('The server did not return a valid XLS workbook.')
      if (token !== serial.current || abort.signal.aborted) return
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = url; anchor.download = preview.report.filename; document.body.appendChild(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice(`Downloaded ${preview.report.filename}`)
    } catch (e) {
      if (token === serial.current && !abort.signal.aborted) setError(e instanceof Error ? e.message : 'Report download failed.')
    } finally { pending.current = false; setDownloading(false); busy.current(false) }
  }
  const report = preview?.signature === signature ? preview.report : null
  const columns = report?.columns.filter(c => c.index === 0 || section === 'all' || c.section === section) ?? []
  return <section className={styles.export} aria-label="Parameter report controls">
    <div className="ath-fields">
      <label className="ath-field"><span>Report groups</span><select value={scope} disabled={downloading} onChange={e => setScope(e.target.value as Scope)}>
        <option value="all">All groups</option><option value="marked">Marked groups</option>
      </select></label>
      <label className="ath-field"><span>Preview section</span><select value={section} onChange={e => setSection(e.target.value)}>
        {(report?.sections ?? [{ key: 'identity', label: 'Group information' }]).map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        <option value="all">All parameter columns</option>
      </select></label>
    </div>
    <p>{selected.length} groups in project list order. Frozen groups are included.</p>
    <p className="ath-hint">The XLS report contains all 28 parameter columns. Applied values take precedence over saved settings. Apply pending parameter edits before exporting. Unused or unavailable settings are identified in the report notes.</p>
    {!selected.length && <p role="status">Mark at least one group or choose All groups.</p>}
    {loading && <p role="status">Preparing parameter report…</p>}
    {error && <p className="ath-error" role="alert">{error}</p>}
    {report && <><h3>{report.filename}</h3><div className={styles.table}><table aria-label="Parameter report preview">
      <thead><tr>{columns.map(c => <th key={c.key}>{c.label}{c.unit && <small>{c.unit}</small>}</th>)}</tr></thead>
      <tbody>{report.rows.map(r => <tr key={r.group_id}>{columns.map(c => <td key={c.key}>{r.values[c.index] ?? 'n.a.'}</td>)}</tr>)}</tbody>
    </table></div><details><summary>Applicability and retained settings</summary>{report.rows.filter(r => r.notes.length).map(r => <div key={r.group_id}><strong>{r.label}</strong><ul>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>)}</details></>}
    {notice && <p role="status">{notice}</p>}
    <div className={`ath-modal-actions ${styles.actions}`}>
      <button disabled={downloading || loading || !selected.length} onClick={() => setRetry(v => v + 1)}>Retry preview</button>
      <button disabled={downloading} onClick={close}>Close report</button>
      <button className="ath-primary" disabled={downloading || loading || !report} onClick={() => { void download() }}>{downloading ? 'Preparing workbook…' : 'Download Excel report'}</button>
    </div>
  </section>
}
