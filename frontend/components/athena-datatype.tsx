"use client"

import { useRef, useState } from 'react'
import { dataTypeLabel, energyProcessingSettings, type AthenaProject } from '@/lib/athena'

export function AthenaDatatype({ project, activeId, selectGroup, busy, error, clearError, apply, close }: {
  project: AthenaProject; activeId: string; selectGroup: (id: string) => void
  busy: boolean; error: string; clearError: () => void; close: () => void
  apply: (ids: string[], settings: { is_normalized: boolean; exafs: boolean }) => Promise<AthenaProject | null>
}) {
  const [scope, setScope] = useState('current')
  const [settings, setSettings] = useState(() => energyProcessingSettings(project.groups.find(g => g.id === activeId)))
  const [completed, setCompleted] = useState<AthenaProject | null>(null)
  const pending = useRef(false)
  const groups = project.groups.filter(g => scope === 'all' || (scope === 'marked' ? g.marked : g.id === activeId))
  const eligible = groups.filter(g => ['mu', 'xanes', 'norm', 'detector'].includes(g.data_type))
  const report = completed?.last_operation
  function edit() { setCompleted(null); clearError() }
  async function submit() {
    if (busy || pending.current || !eligible.length) return
    pending.current = true; edit()
    try { setCompleted(await apply(groups.map(g => g.id), settings)) }
    finally { pending.current = false }
  }
  return <form className="ath-modal-body" onSubmit={event => { event.preventDefault(); void submit() }}>
    <p className="ath-hint">Choose how to process your spectra. Raw data, calibration and saved parameters are retained.</p>
    <fieldset disabled={busy} className="ath-e0-fields"><div className="ath-fields">
      <label className="ath-field"><span>Apply settings to</span><select value={scope} onChange={event => { edit(); setScope(event.target.value) }}>
        <option value="current">Current group</option><option value="marked">All marked groups</option><option value="all">All groups</option>
      </select></label>
      {scope === 'current' && <label className="ath-field"><span>Current group</span><select value={activeId} onChange={event => { edit(); selectGroup(event.target.value); setSettings(energyProcessingSettings(project.groups.find(g => g.id === event.target.value))) }}>{project.groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>}
    </div>
      <label className="ath-check"><input type="checkbox" checked={settings.is_normalized} aria-describedby="ath-input-normalized-hint" onChange={event => { edit(); setSettings(s => ({ ...s, is_normalized: event.target.checked })) }} />Input already normalized</label>
      <p className="ath-hint" id="ath-input-normalized-hint">Use the supplied signal directly as normalized μ(E).</p>
      <label className="ath-check"><input type="checkbox" checked={settings.exafs} aria-describedby="ath-exafs-processing-hint" onChange={event => { edit(); setSettings(s => ({ ...s, exafs: event.target.checked })) }} />Enable EXAFS processing</label>
      <p className="ath-hint" id="ath-exafs-processing-hint">Calculate background removal and Fourier transforms. Turn off for near-edge analysis only.</p>
    </fieldset>
    <p>{eligible.length} eligible of {groups.length} selected groups</p>
    {groups.length > 0 && <ul>{groups.map(g => <li key={g.id}>{g.label} · {dataTypeLabel(g)}{!eligible.includes(g) && ' · skipped: χ(k) and FEFF types cannot be changed here'}</li>)}</ul>}
    {!!report?.datatype_results && <div role="status"><p>Processing settings updated for {report.datatype_results.length} groups.</p>
      {Object.entries(report.processing_errors ?? {}).map(([id, message]) => <p className="ath-warning" key={id}>{project.groups.find(g => g.id === id)?.label}: {message}</p>)}
    </div>}
    {error && <div role="alert" className="ath-error">{error}</div>}
    <div className="ath-modal-actions"><button type="button" disabled={busy} onClick={close}>{completed ? 'Close' : 'Cancel'}</button><button className="ath-primary" disabled={busy || !eligible.length}>{busy ? 'Processing…' : 'Apply settings'}</button></div>
  </form>
}
