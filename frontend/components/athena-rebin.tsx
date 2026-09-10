"use client"

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { athenaApi, rebinUnavailable, type AthenaProject, type RebinPreview } from '@/lib/athena'
import { rebinProblem, type ImportRebinOptions } from '@/lib/athena-import'
import styles from './athena-rebin.module.css'

const Plot = dynamic(() => import('react-plotly.js').then(m => m.default), { ssr: false })
const colors = ['#16736b', '#c37b38', '#7470b0', '#467cac']

export function AthenaRebin({ project, activeId, selectGroup, grid, setGrid, saved, setBusy, defaultsControls }: {
  project: AthenaProject; activeId: string; selectGroup: (id: string) => void
  grid: ImportRebinOptions; setGrid: (grid: ImportRebinOptions) => void
  saved: (project: AthenaProject) => void; setBusy: (message: string) => void
  defaultsControls?: ReactNode
}) {
  const [space, setSpace] = useState<'E' | 'k'>('E')
  const [previewMarked, setPreviewMarked] = useState(false)
  const [showOriginal, setShowOriginal] = useState(true)
  const [retry, setRetry] = useState(0)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [state, setState] = useState<{ key: string; value?: RebinPreview; error?: string } | null>(null)
  const active = project.groups.find(g => g.id === activeId)
  const unavailable = active ? rebinUnavailable(active) : null
  const marked = project.groups.filter(g => g.marked).map(g => g.id)
  const problem = rebinProblem({ ...grid, enabled: true })
  const { enabled: _enabled, e0: _manual, ...values } = grid
  const groupIds = previewMarked ? marked : active ? [active.id] : []
  const payload = { version: project.version, action: 'rebin', group_ids: groupIds,
    options: { ...values, plot_space: space, skip_ineligible: previewMarked } }
  const key = JSON.stringify({ projectId: project.id, payload })
  useEffect(() => {
    if (problem || saving || !groupIds.length || (!previewMarked && unavailable)) return
    const controller = new AbortController(); let current = true
    const timer = setTimeout(() => {
      void athenaApi<RebinPreview>(`/projects/${project.id}/rebin/preview`, payload, 'POST', controller.signal)
        .then(value => {
          if (current) {
            if (value.version !== payload.version) setState({ key, error: 'The project changed. Preview again.' })
            else setState({ key, value })
          }
        })
        .catch(e => { if (current) setState({ key, error: e instanceof Error ? e.message : 'Rebin preview failed.' }) })
    }, 180)
    return () => { current = false; clearTimeout(timer); controller.abort() }
    // key includes selected groups, saved revision, grid and space.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, problem, saving])
  const value = state?.key === key && !problem ? state.value : undefined
  const previewError = problem || (!previewMarked && unavailable) || (state?.key === key ? state.error : '')
  async function make(batch: boolean) {
    if (savingRef.current || problem) return
    const ids = batch ? marked : active ? [active.id] : []
    if (!ids.length) return
    savingRef.current = true; setSaving(true); setBusy('Rebinning data'); setError(''); setNotice('')
    try {
      const next = await athenaApi<AthenaProject>(`/projects/${project.id}/command`, {
        version: project.version, action: 'rebin', group_ids: ids, options: { ...values, skip_ineligible: batch },
      })
      saved(next)
      const operation = next.last_operation
      setNotice(`Created ${operation?.rebin_results?.length ?? next.groups.length - project.groups.length} rebinned groups. `
        + Object.values(operation?.skipped_reasons ?? {}).join(' '))
    } catch (e) { setError(e instanceof Error ? e.message : 'Rebinning failed.') }
    finally { savingRef.current = false; setSaving(false); setBusy('') }
  }
  const traces = value?.results.flatMap((result, i) => result.traces.filter(t => showOriginal || t.role !== 'original').map(t => ({
    x: t.x, y: t.y, name: t.label + (space === 'k' ? ` · k-weight ${result.kweight}` : ''),
    type: 'scatter' as const, mode: 'lines' as const, line: { color: colors[i % colors.length], dash: t.role === 'original' ? 'dot' : 'solid', width: t.role === 'original' ? 1 : 2 },
    opacity: t.role === 'original' ? .6 : 1,
  }))) ?? []
  return <div className="ath-modal-body">
    <div className={styles.layout}><fieldset disabled={saving} className={styles.controls}>
      <label className="ath-field"><span>Rebin source group</span><select value={activeId} onChange={e => selectGroup(e.target.value)}>
        {project.groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
      </select></label>
      <p>Edge energy: {active?.parameters.e0 ?? active?.result?.effective.e0 ?? 'Unavailable'} eV</p>
      <p className="ath-hint">Uses saved processing parameters. Apply edits in the main inspector first. Frozen sources can be used to create new groups.</p>
      <div className="ath-fields">{([
        ['emin', 'Edge region start · eV relative to E₀'], ['emax', 'Edge region end · eV relative to E₀'],
        ['pre', 'Pre-edge grid · eV'], ['xanes', 'XANES grid · eV'], ['exafs', 'EXAFS grid · Å⁻¹'], ['width', 'Smoothing width · points'],
      ] as const).map(([name, title]) => <label className="ath-field" key={name}><span>{title}</span>
        <input type="number" step={name === 'width' ? 1 : 'any'} value={grid[name]}
          onChange={e => setGrid({ ...grid, [name]: e.target.value === '' ? '' : Number(e.target.value) })} />
      </label>)}</div>
      <label className="ath-check"><input type="checkbox" checked={previewMarked} onChange={e => setPreviewMarked(e.target.checked)} />Preview marked groups ({marked.length})</label>
      <div className={styles.actions}>
        <button disabled={!!problem || !groupIds.length} onClick={() => { setSpace('E'); setRetry(n => n + 1) }}>Plot data and rebinned data</button>
        <button disabled={!!problem || !groupIds.length} onClick={() => { setSpace('k'); setRetry(n => n + 1) }}>Plot data and rebinned data in k</button>
        <button className="ath-primary" disabled={!!problem || !active || !!unavailable} onClick={() => { void make(false) }}>Make rebinned data group</button>
        <button disabled={!!problem || !marked.length} onClick={() => { void make(true) }}>Rebin marked data and make groups</button>
      </div>
      <p className="ath-hint">New groups follow their sources and start unmarked. χ(k) and already-rebinned groups are skipped in a marked batch. Undo restores the entire batch.</p>
      {defaultsControls}
    </fieldset><section className={styles.preview} aria-label="Rebin preview">
      <label className="ath-check"><input type="checkbox" checked={showOriginal} onChange={e => setShowOriginal(e.target.checked)} />Show original data</label>
      <div className={styles.plot} aria-label={`${space}-space rebin preview`} aria-busy={!value && !previewError && !!groupIds.length}>
        {value && traces.length ? <Plot data={traces} layout={{ autosize: true, margin: { l: 60, r: 20, t: 20, b: 135 },
          xaxis: { title: { text: space === 'E' ? 'Energy (eV)' : 'k (Å⁻¹)' }, automargin: true },
          yaxis: { title: { text: space === 'E' ? 'μ(E)' : 'Weighted χ(k)' }, automargin: true },
          legend: { orientation: 'h', y: -.4, yanchor: 'top' }, font: { size: 11 }, uirevision: key,
          shapes: space === 'E' && value.results.length === 1 ? [value.results[0].details.emin, value.results[0].details.emax].map(offset => ({
            type: 'line', x0: value.results[0].details.e0 + offset, x1: value.results[0].details.e0 + offset,
            y0: 0, y1: 1, yref: 'paper', line: { dash: 'dot', color: '#a2aaa0', width: 1 },
          })) : [],
        }} config={{ responsive: true, displaylogo: false, toImageButtonOptions: { format: 'svg', filename: 'athena-rebin' } }}
          style={{ width: '100%', height: '100%' }} useResizeHandler />
          : <p>{previewError ? 'Correct the grid or choose another source.' : !groupIds.length ? 'Select a source group.' : value ? 'No k-space curves are available. The energy preview is still available.' : 'Updating preview…'}</p>}
      </div>
      {previewError && <p className="ath-error" role="alert">{previewError}</p>}
      {value?.results.map(r => <div key={r.source_group_id}><p>{r.label}: {r.details.source_points.toLocaleString()} → {r.details.output_points.toLocaleString()} points · kernel {r.details.width}</p>
        {[...r.details.warnings, ...r.errors, ...(space === 'E' && r.processing_error ? [r.processing_error] : [])].map((text, i) => <p className="ath-warning" key={i}>{text}</p>)}
      </div>)}
      {value && Object.entries(value.skipped_reasons).map(([id, reason]) => <p className="ath-warning" key={id}>{project.groups.find(g => g.id === id)?.label}: {reason}</p>)}
    </section></div>
    {error && <p role="alert" className="ath-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>
}
