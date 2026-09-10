"use client"

import { useRef, useState } from 'react'
import { dataTypeLabel, type AthenaProject } from '@/lib/athena'

export function AthenaDatatype({ project, activeId, selectGroup, busy, error, clearError, apply, close }: {
  project: AthenaProject; activeId: string; selectGroup: (id: string) => void
  busy: boolean; error: string; clearError: () => void; close: () => void
  apply: (ids: string[], type: 'mu' | 'xanes' | 'norm') => Promise<AthenaProject | null>
}) {
  const [scope, setScope] = useState('current')
  const [type, setType] = useState<'mu' | 'xanes' | 'norm'>('mu')
  const [completed, setCompleted] = useState<AthenaProject | null>(null)
  const pending = useRef(false)
  const groups = project.groups.filter(g => scope === 'all' || (scope === 'marked' ? g.marked : g.id === activeId))
  const eligible = groups.filter(g => ['mu', 'xanes', 'norm', 'detector'].includes(g.data_type))
  const report = completed?.last_operation
  function edit() { setCompleted(null); clearError() }
  async function submit() {
    if (busy || pending.current || !eligible.length) return
    pending.current = true; edit()
    try { setCompleted(await apply(groups.map(g => g.id), type)) }
    finally { pending.current = false }
  }
  return <form className="ath-modal-body" onSubmit={event => { event.preventDefault(); void submit() }}>
    <p className="ath-hint">Correct how saved data are processed. μ(E) and XANES fit the normalization; normalized μ(E) uses the supplied signal as normalized data. XANES omits EXAFS processing.</p>
    <p className="ath-hint">Raw data, calibration, saved parameters and reference links are retained. Unapplied parameter edits remain drafts. Like Athena, this type correction also applies to frozen energy groups.</p>
    <fieldset disabled={busy} className="ath-e0-fields"><div className="ath-fields">
      <label className="ath-field"><span>Change data type for</span><select value={scope} onChange={event => { edit(); setScope(event.target.value) }}>
        <option value="current">Current group</option><option value="marked">All marked groups</option><option value="all">All groups</option>
      </select></label>
      {scope === 'current' && <label className="ath-field"><span>Current group</span><select value={activeId} onChange={event => { edit(); selectGroup(event.target.value) }}>{project.groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>}
      <label className="ath-field"><span>Change data type to</span><select value={type} onChange={event => { edit(); setType(event.target.value as typeof type) }}>
        <option value="mu">μ(E)</option><option value="xanes">XANES</option><option value="norm">Normalized μ(E)</option>
      </select></label>
    </div></fieldset>
    <p>{eligible.length} eligible of {groups.length} selected groups</p>
    {groups.length > 0 && <ul>{groups.map(g => <li key={g.id}>{g.label} · {dataTypeLabel(g)}{!eligible.includes(g) && ' · skipped: χ(k) and FEFF types cannot be changed here'}</li>)}</ul>}
    {!!report?.datatype_results && <div role="status"><p>Data type updated for {report.datatype_results.length} groups.</p>
      {Object.entries(report.processing_errors ?? {}).map(([id, message]) => <p className="ath-warning" key={id}>{project.groups.find(g => g.id === id)?.label}: {message}</p>)}
    </div>}
    {error && <div role="alert" className="ath-error">{error}</div>}
    <div className="ath-modal-actions"><button type="button" disabled={busy} onClick={close}>{completed ? 'Close' : 'Cancel'}</button><button className="ath-primary" disabled={busy || !eligible.length}>{busy ? 'Processing…' : 'Change data type'}</button></div>
  </form>
}
