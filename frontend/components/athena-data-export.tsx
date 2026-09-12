'use client'

import { useEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { decodeApiError } from '@/lib/backend-client'
import styles from './athena-data-export.module.css'

const single = [['xmu', 'μ(E)'], ['norm', 'Normalized μ(E)'], ['chi', 'χ(k)'], ['r', 'χ(R)'], ['q', 'χ(q)']]
const marked = [['xmu', 'μ(E)'], ['norm', 'Normalized μ(E)'], ['der', 'First derivative of μ(E)'], ['sec', 'Second derivative of μ(E)'],
  ['nder', 'First derivative of normalized μ(E)'], ['nsec', 'Second derivative of normalized μ(E)'],
  ['chi', 'χ(k)'], ['chik', 'k × χ(k)'], ['chik2', 'k² × χ(k)'], ['chik3', 'k³ × χ(k)'],
  ['chir_re', 'Real χ(R)'], ['chir_im', 'Imaginary χ(R)'], ['chir_mag', 'Magnitude χ(R)'], ['chir_pha', 'Phase χ(R)'], ['dph', 'Scaled phase derivative in R'],
  ['chiq_re', 'Real χ(q)'], ['chiq_im', 'Imaginary χ(q)'], ['chiq_mag', 'Magnitude χ(q)'], ['chiq_pha', 'Phase χ(q)']]
type FilePreview = { filename: string; rows: number; group_ids: string[]; columns: { name: string; unit: string }[]
  sample: number[][]; warnings: string[]; notes: string[]; header: string[] }
type Preview = { version: number; project_id: string; files: FilePreview[] }

function validPreview(value: Preview, project: AthenaProject) {
  return value?.version === project.version && value.project_id === project.id && Array.isArray(value.files) && value.files.length > 0
    && value.files.every(f => typeof f.filename === 'string' && Number.isInteger(f.rows) && f.rows >= 3
      && Array.isArray(f.columns) && f.columns.length > 0 && f.columns.every(c => typeof c.name === 'string' && typeof c.unit === 'string')
      && Array.isArray(f.sample) && f.sample.length > 0 && f.sample.every(r => Array.isArray(r) && r.length === f.columns.length && r.every(Number.isFinite))
      && [f.header, f.warnings, f.notes, f.group_ids].every(a => Array.isArray(a) && a.every(v => typeof v === 'string')))
}

export function AthenaDataExport({ project, groupId, close, onBusyChange }: {
  project: AthenaProject; groupId: string; close: () => void; onBusyChange: (value: boolean) => void
}) {
  const [scope, setScope] = useState('current'), [form, setForm] = useState('xmu')
  const [weight, setWeight] = useState('all'), [arbitrary, setArbitrary] = useState('2'), [multipliers, setMultipliers] = useState(false)
  const [sharedWeight, setSharedWeight] = useState(false)
  const [preview, setPreview] = useState<{ signature: string; data: Preview } | null>(null)
  const [loading, setLoading] = useState(false), [downloading, setDownloading] = useState(false), [error, setError] = useState('')
  const [retry, setRetry] = useState(0), [notice, setNotice] = useState('')
  const generation = useRef(0), running = useRef(false), downloadAbort = useRef<AbortController | null>(null), busy = useRef(onBusyChange)
  busy.current = onBusyChange
  const forms = scope === 'marked' ? marked : single
  const supportsWeight = scope !== 'marked' && form === 'chi'
  const supportsMultipliers = scope === 'marked' && ['xmu', 'der', 'sec'].includes(form)
  const numericWeight = Number(arbitrary), badWeight = supportsWeight && weight === 'kw' && sharedWeight &&
    (!arbitrary.trim() || !Number.isFinite(numericWeight) || numericWeight < 0 || numericWeight > 4)
  const request = { version: project.version, scope, ...(scope === 'current' ? { group_id: groupId } : {}), form,
    kweight: supportsWeight ? weight : 'all', arbitrary_kweight: !badWeight && supportsWeight && weight === 'kw' && sharedWeight ? numericWeight : null,
    with_multipliers: supportsMultipliers && multipliers }
  const signature = JSON.stringify(request), base = `/projects/${project.id}/export-data`
  const selected = project.groups.filter(g => scope === 'current' ? g.id === groupId : g.marked)

  useEffect(() => {
    const token = ++generation.current, abort = new AbortController()
    setPreview(null); setError(''); setNotice('')
    if (badWeight || !selected.length) { setLoading(false); return }
    setLoading(true)
    athenaApi<Preview>(`${base}/preview`, JSON.parse(signature), 'POST', abort.signal).then(data => {
      if (token !== generation.current || abort.signal.aborted) return
      if (!validPreview(data, project)) throw new Error('The export preview could not be confirmed. Reload the project and retry.')
      setPreview({ signature, data })
    }).catch(e => { if (token === generation.current && !abort.signal.aborted) setError(e instanceof Error ? e.message : 'Export preview failed.') })
      .finally(() => { if (token === generation.current) setLoading(false) })
    return () => { abort.abort(); generation.current++ }
  }, [base, signature, retry, badWeight, selected.length])
  useEffect(() => () => { downloadAbort.current?.abort(); running.current = false; busy.current(false) }, [project.id, groupId])

  function chooseScope(value: string) {
    setScope(value)
    if (!(value === 'marked' ? marked : single).some(([key]) => key === form)) setForm('xmu')
  }
  async function download() {
    if (running.current || preview?.signature !== signature || loading) return
    const token = generation.current, abort = new AbortController()
    running.current = true; downloadAbort.current = abort; setDownloading(true); busy.current(true); setError(''); setNotice('')
    try {
      const response = await fetch(`/api/backend/api/athena${base}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: signature, signal: abort.signal })
      if (!response.ok) throw decodeApiError(response.status, await response.json().catch(() => null))
      if (response.headers.get('X-Athena-Project-Version') !== String(project.version)) throw new Error('The downloaded revision could not be confirmed. Reload the project before retrying.')
      const filename = /filename="([^"/\\]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1]
      if (!filename) throw new Error('The server did not return a confirmed export filename.')
      const blob = await response.blob()
      if (!blob.size) throw new Error('The server returned an empty export.')
      if (token !== generation.current || abort.signal.aborted) return
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(`Downloaded ${filename}`)
    } catch (e) {
      if (token === generation.current && !abort.signal.aborted) setError(e instanceof Error ? e.message : 'The download failed.')
    } finally {
      running.current = false; setDownloading(false); busy.current(false)
    }
  }
  return <section className={styles.export} aria-label="Data export controls">
    <div className="ath-fields">
      <label className="ath-field"><span>Export groups</span><select value={scope} disabled={downloading} onChange={e => chooseScope(e.target.value)}>
        <option value="current">Current group</option><option value="marked">Marked groups · one table</option><option value="each">Each marked group · ZIP</option>
      </select></label>
      <label className="ath-field"><span>Data form</span><select value={form} disabled={downloading} onChange={e => setForm(e.target.value)}>
        {forms.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {supportsWeight && <label className="ath-field"><span>Output k weight</span><select value={weight} disabled={downloading} onChange={e => setWeight(e.target.value)}>
        <option value="all">All weights · 0, 1, 2, 3</option>{['0', '1', '2', '3'].map(w => <option key={w} value={w}>{w}</option>)}<option value="kw">Arbitrary weight</option>
      </select></label>}
      {supportsWeight && weight === 'kw' && sharedWeight && <label className="ath-field"><span>Arbitrary output k weight</span><input type="number" min="0" max="4" step="any" value={arbitrary} disabled={downloading} onChange={e => setArbitrary(e.target.value)} /></label>}
    </div>
    {supportsWeight && weight === 'kw' && <><label className="ath-check"><input type="checkbox" checked={sharedWeight} disabled={downloading} onChange={e => setSharedWeight(e.target.checked)} />Use a shared output weight</label><p className="ath-hint">By default, each group uses its saved arbitrary weight, or its applied FT weight if no separate value was imported.</p></>}
    {supportsMultipliers && <label className="ath-check"><input type="checkbox" checked={multipliers} disabled={downloading} onChange={e => setMultipliers(e.target.checked)} />Apply each group's plot multiplier</label>}
    <p>{selected.length} group{selected.length === 1 ? '' : 's'} selected{scope !== 'current' && ' in project list order'}: {selected.map(g => g.label).join(', ') || 'none'}</p>
    <p className="ath-hint">Exports use applied parameters and include acquisition metadata, saved XDI comments and processing settings. Apply any parameter edits before exporting.</p>
    {scope === 'marked' && <p className="ath-hint">The first marked group supplies the axis. Energy data are linearly interpolated; any extrapolation is listed below. k/R/q grids must match; separate files retain each group's grid.</p>}
    {scope === 'each' && <p className="ath-hint">The ZIP contains one column file per marked group. Duplicate labels receive distinct filenames.</p>}
    {badWeight && <p role="alert">Enter a finite output weight from 0 through 4.</p>}
    {!selected.length && <p role="status">Mark at least one group before exporting.</p>}
    {loading && <p role="status">Preparing output columns…</p>}
    {error && <p role="alert" className="ath-error">{error}</p>}
    {preview?.signature === signature && preview.data.files.map(file => <article key={file.filename} className={styles.file}>
      <h3>{file.filename}</h3><p>{file.rows} rows · {file.columns.length} columns</p>
      {file.warnings.map((warning, i) => <p className="ath-warning" key={i}>{warning}</p>)}
      {file.notes.map((note, i) => <p className="ath-hint" key={i}>{note}</p>)}
      <div className={styles.table}><table aria-label={`${file.filename} first five rows`}><thead><tr>{file.columns.map(c => <th key={c.name}>{c.name}{c.unit && <small>{c.unit}</small>}</th>)}</tr></thead>
        <tbody>{file.sample.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j}>{v.toPrecision(7)}</td>)}</tr>)}</tbody></table></div>
      <details><summary>File header and processing parameters</summary><pre>{file.header.join('\n')}</pre></details>
    </article>)}
    {notice && <p role="status">{notice}</p>}
    <div className={`ath-modal-actions ${styles.actions}`}>
      <button disabled={downloading || loading || badWeight || !selected.length} onClick={() => setRetry(value => value+1)}>Retry preview</button>
      <button disabled={downloading} onClick={close}>Close export</button>
      <button className="ath-primary" disabled={downloading || loading || preview?.signature !== signature || badWeight} onClick={() => { void download() }}>{downloading ? 'Preparing download…' : scope === 'each' ? 'Download ZIP' : 'Download column file'}</button>
    </div>
  </section>
}
