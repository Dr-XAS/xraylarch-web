'use client'

import { useEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import styles from './athena-xdi-controls.module.css'

type Presence = { field: string; present: boolean }
export type XDIMetadata = {
  version: number; group_id: string; label: string; xdi_version: string; extra_version: string
  families: { name: string; fields: Record<string, string> }[]; comments: string
  required: Presence[]; recommended: Presence[]
  history?: { process: string; start_time: string | null; end_time: string | null; inherited: boolean }
}
type Report = { version: number; group_id: string; valid: boolean; engine: string
  results: { family: string; tag: string; value: string; code: number | null; valid: boolean; message: string }[] }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function metadata(value: unknown, groupId: string): XDIMetadata {
  const presence = (rows: unknown) => Array.isArray(rows) && rows.every(r => object(r) && typeof r.field === 'string' && typeof r.present === 'boolean')
  if (!object(value) || !Number.isInteger(value.version) || (value.version as number) < 0 || value.group_id !== groupId
    || typeof value.label !== 'string' || typeof value.comments !== 'string' || typeof value.xdi_version !== 'string' || typeof value.extra_version !== 'string'
    || !Array.isArray(value.families) || !value.families.every(f => object(f) && typeof f.name === 'string' && object(f.fields) && Object.values(f.fields).every(v => typeof v === 'string'))
    || !presence(value.required) || !presence(value.recommended)
    || (value.history !== undefined && (!object(value.history) || typeof value.history.process !== 'string' || typeof value.history.inherited !== 'boolean'
      || ![value.history.start_time, value.history.end_time].every(v => v === null || typeof v === 'string')))) throw new Error('Could not read XDI metadata. Reload and try again.')
  return value as XDIMetadata
}

export function AthenaXDIControls({ projectId, groupId, onSaved, onBusyChange, close }: {
  projectId: string; groupId: string; onSaved: (project: AthenaProject) => void
  onBusyChange: (busy: boolean) => void; close: () => void
}) {
  const [saved, setSaved] = useState<XDIMetadata | null>(null), [comments, setComments] = useState('')
  const [expanded, setExpanded] = useState<string[]>([]), [report, setReport] = useState<Report | null>(null)
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const running = useRef(false), generation = useRef(0), busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange
  const base = `/projects/${projectId}/groups/${groupId}/xdi`
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (running.current) return
    running.current = true; const token = ++generation.current
    setPending(true); busyCallback.current(true); setError(''); setNotice('')
    try { await work(() => token === generation.current) }
    catch (e) { if (token === generation.current) setError(e instanceof Error ? e.message : 'The metadata operation failed.') }
    finally { if (token === generation.current) { running.current = false; setPending(false); busyCallback.current(false) } }
  }
  async function reload(signal?: AbortSignal) {
    await perform(async current => {
      const next = metadata(await athenaApi(base, undefined, 'GET', signal), groupId)
      if (!current() || signal?.aborted) return
      setSaved(next); setComments(next.comments); setExpanded(next.families.map(f => f.name)); setReport(null)
    })
  }
  useEffect(() => {
    setSaved(null); setComments(''); setReport(null)
    const abort = new AbortController(); void reload(abort.signal)
    return () => { generation.current++; running.current = false; abort.abort(); busyCallback.current(false) }
  }, [projectId, groupId])
  async function validate(family?: string, tag?: string) {
    if (!saved) return
    await perform(async current => {
      const result = await athenaApi<Report>(`${base}/validate`, { version: saved.version, ...(family ? { family, tag } : {}) })
      if (!current()) return
      if (!object(result) || result.version !== saved.version || result.group_id !== groupId || typeof result.valid !== 'boolean'
        || !Array.isArray(result.results) || !result.results.every(r => object(r) && typeof r.family === 'string' && typeof r.tag === 'string'
          && typeof r.valid === 'boolean' && typeof r.message === 'string')) throw new Error('The validation result could not be confirmed. Reload metadata and retry.')
      setReport(result)
    })
  }
  async function save() {
    if (!saved) return
    await perform(async current => {
      const text = comments
      const project = await athenaApi<AthenaProject>(`/projects/${projectId}/command`, {
        version: saved.version, action: 'xdi_comments', group_ids: [groupId], options: { comments: text },
      })
      if (!current()) return
      const group = project?.groups?.find(g => g.id === groupId)
      const value = group?.source?.xdi_metadata
      if (project?.id !== projectId || project.version !== saved.version + 1 || !object(value) || value.comments_text !== text) {
        throw new Error('The saved comments could not be confirmed. Reload metadata before retrying.')
      }
      onSaved(project); setSaved({ ...saved, version: project.version, comments: text }); setComments(text)
      setNotice('XDI comments saved. Undo is available in the project toolbar.'); setReport(null)
    })
  }
  function status(title: string, rows: Presence[]) {
    const count = rows.filter(r => r.present).length
    return <details className={styles.presence}><summary>{title}: {count} of {rows.length} present</summary>
      <ul>{rows.map(r => <li key={r.field}>{r.field}: <strong>{r.present ? 'present' : 'missing'}</strong></li>)}</ul>
    </details>
  }
  return <section aria-label="File metadata controls" className={styles.controls}>
    {pending && <p role="status">Loading or saving metadata…</p>}
    {error && <p role="alert" className="ath-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {saved && <>
      <p>Current group <strong>{saved.label}</strong></p>
      <p>XDI {saved.xdi_version}{saved.extra_version && ` · ${saved.extra_version}`}</p>
      {saved.history && <section className={styles.history} aria-label="Acquisition and processing history">
        <h3>Acquisition and processing history</h3>
        <dl><dt>Scan start</dt><dd>{saved.history.start_time ?? 'Not recorded'}</dd><dt>Scan end</dt><dd>{saved.history.end_time ?? 'Not recorded'}</dd></dl>
        <p className={styles.process}>{saved.history.process || 'No processing history recorded in Scan.process.'}</p>
        {saved.history.inherited && <p className="ath-hint">Acquisition fields and comments are inherited from the source scan. Column metadata describes the acquisition; exported column files describe their actual output columns.</p>}
        <p className="ath-hint">Scan.process is retained as recorded text. Saved processing parameters are included in column-file exports.</p>
      </section>}
      {status('Required metadata', saved.required)}{status('Recommended metadata', saved.recommended)}
      <p className="ath-hint">Presence checks show which fields are available. Validate their values separately.</p>
      <p className="ath-hint">Element fields follow the current absorber selection. The original acquisition header remains in Source metadata.</p>
      <div className={styles.actions}>
        <button type="button" onClick={() => setExpanded(saved.families.map(f => f.name))}>Expand all families</button>
        <button type="button" onClick={() => setExpanded([])}>Collapse all families</button>
        <button type="button" disabled={pending} onClick={() => { void validate() }}>Validate all</button>
      </div>
      <div className={styles.families}>{saved.families.map(f => <section key={f.name} aria-label={`${f.name} metadata family`}>
        <h3><button type="button" aria-expanded={expanded.includes(f.name)} onClick={() => setExpanded(current =>
          current.includes(f.name) ? current.filter(name => name !== f.name) : [...current, f.name])}><span aria-hidden="true">{expanded.includes(f.name) ? '▾' : '▸'}</span>{f.name}</button></h3>
        {expanded.includes(f.name) && <table aria-label={`${f.name} fields`}><tbody>{Object.entries(f.fields).sort(([a], [b]) => a.localeCompare(b)).map(([tag, value]) => {
          const result = report?.results.find(r => r.family === f.name && r.tag === tag)
          return <tr key={tag}><th scope="row">{tag}</th><td>{value}{result && <p className={result.valid ? styles.valid : 'ath-warning'}>{result.valid ? 'Valid' : result.message}</p>}</td>
            <td><button type="button" disabled={pending} aria-label={`Validate ${f.name}.${tag}`} onClick={() => { void validate(f.name, tag) }}>Validate</button></td></tr>
        })}</tbody></table>}
      </section>)}</div>
      {report && <section aria-label="Validation results"><p role="status">{report.results.length === 0 ? 'No metadata fields to validate.' :
        `${report.results.length} field${report.results.length === 1 ? '' : 's'} checked · ${report.results.filter(r => !r.valid).length} need attention.`}</p>
        {report.results.some(r => !r.valid) && <ul>{report.results.filter(r => !r.valid).map(r =>
          <li key={`${r.family}.${r.tag}`}><strong>{r.family}.{r.tag}</strong>: {r.message}</li>)}</ul>}
      </section>}
      <label className="ath-field"><span>XDI comments</span><textarea aria-label="XDI comments" rows={7} maxLength={50000} value={comments} disabled={pending}
        onChange={e => { setComments(e.target.value); setNotice('') }} /></label>
      <p className="ath-hint">These comments are saved with XDI metadata and Athena projects. Group notes are edited in Group information.</p>
      {comments !== saved.comments && <p role="status">Unsaved XDI comments</p>}
    </>}
    <div className={styles.actions}>
      <button type="button" disabled={pending} onClick={() => { void reload() }}>Reload saved metadata</button>
      <button type="button" disabled={pending || !saved || comments === saved.comments} onClick={() => { void save() }}>Save comments</button>
      <button type="button" disabled={pending} onClick={close}>Close metadata</button>
    </div>
    <p className="ath-hint">Reload replaces unsaved comments with the saved version.</p>
  </section>
}
