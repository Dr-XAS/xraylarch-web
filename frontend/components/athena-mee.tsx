'use client'

import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import styles from './athena-difference.module.css'
import meeStyles from './athena-mee.module.css'

const Plot = dynamic(() => import('react-plotly.js').then(m => m.default), { ssr: false })
type Space = 'E' | 'k' | 'R'
type Options = { method: 'reflection' | 'arctangent'; shift: number; amplitude: number; width: number }
type Trace = { role: string; label: string; x: number[]; y: number[] }
export type MEEPreview = {
  project_id: string; version: number; options: Options
  results: { group_id: string; label: string; kweight: number; corrected_mu: number[]
    details: { e0: number; center: number; amplitude: number; width: number; warnings: string[] }
    traces: Record<Space, Trace[]>; errors: Partial<Record<Space, string>> }[]
}

function validate(value: MEEPreview, project: AthenaProject, groupId: string, options: Options) {
  if (value.project_id !== project.id || value.version !== project.version || value.results?.length !== 1 || value.results[0].group_id !== groupId
      || Object.entries(options).some(([key, v]) => value.options?.[key as keyof Options] !== v)) throw new Error('The MEE preview does not match these settings. Preview again.')
  const result = value.results[0]
  for (const space of ['E', 'k', 'R'] as const) {
    if (!Array.isArray(result.traces?.[space]) || (space === 'E' && result.traces[space].length !== 2)) throw new Error('The MEE preview has incomplete curves. Preview again.')
    for (const trace of result.traces[space]) if (!Array.isArray(trace.x) || !trace.x.length || !Array.isArray(trace.y) || trace.x.length !== trace.y.length
      || [...trace.x, ...trace.y].some(v => !Number.isFinite(v))) throw new Error('The MEE preview has invalid numerical data. Preview again.')
  }
  if (!Number.isFinite(result.details?.e0) || !Number.isFinite(result.details?.center) || !Array.isArray(result.details?.warnings)
      || !Array.isArray(result.corrected_mu) || result.corrected_mu.length !== result.traces.E[0].x.length || result.corrected_mu.some(v => !Number.isFinite(v))) throw new Error('The MEE preview is incomplete. Preview again.')
}

export function AthenaMEE({ project, activeId, selectGroup, setBusy, saved, close, disabled }: {
  project: AthenaProject; activeId: string; selectGroup: (id: string) => void; setBusy: (value: string) => void
  saved: (next: AthenaProject) => void; close: () => void; disabled: boolean
}) {
  const [draft, setDraft] = useState({ method: 'reflection' as Options['method'], shift: '0', amplitude: '0.01', width: '0.5' })
  const [space, setSpace] = useState<Space>('E'), [picking, setPicking] = useState(false)
  const [preview, setPreview] = useState<{ key: string; value: MEEPreview } | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const generation = useRef(0), saving = useRef(false)
  const group = project.groups.find(g => g.id === activeId)
  const e0 = group?.result?.effective.e0
  const eligible = !!group && !!group.result?.arrays.norm?.length && !group.processing_error && typeof e0 === 'number' && Number.isFinite(e0)
    && !['chi', 'detector'].includes(group.data_type)
  const numeric = [draft.shift, draft.amplitude, draft.width].every(v => v.trim() && Number.isFinite(Number(v)))
  const options: Options = { method: draft.method, shift: Number(draft.shift), amplitude: Number(draft.amplitude), width: Number(draft.width) }
  const key = JSON.stringify([project.id, project.version, activeId, draft])
  const committed = useRef(key), pickContext = useRef({ key, space, picking })
  const current = preview?.key === key ? preview.value : null
  const canCalculate = eligible && numeric && options.shift > 0
  useLayoutEffect(() => { committed.current = key; generation.current++; setPreview(null); setLoading(false); setError(''); setPicking(false) }, [key])
  useLayoutEffect(() => { pickContext.current = { key, space, picking } }, [key, space, picking])
  useEffect(() => {
    if (!canCalculate || disabled) return
    const controller = new AbortController(), token = ++generation.current
    const timer = setTimeout(async () => {
      setLoading(true); setError('')
      try {
        const value = await athenaApi<MEEPreview>(`/projects/${project.id}/mee/preview`, { version: project.version, action: 'multi_electron', group_ids: [activeId], options }, 'POST', controller.signal)
        if (token !== generation.current || committed.current !== key) return
        validate(value, project, activeId, options)
        setPreview({ key, value })
      } catch (reason) {
        if (!controller.signal.aborted && token === generation.current) setError(reason instanceof Error ? reason.message : 'Could not preview MEE removal. Try again.')
      } finally { if (token === generation.current) setLoading(false) }
    }, 400)
    return () => { clearTimeout(timer); controller.abort(); generation.current++ }
  // One intent includes every project, group and parameter used by the request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, canCalculate, disabled])

  async function save() {
    if (!current || disabled || saving.current || committed.current !== key) return
    saving.current = true; setBusy('Saving MEE-corrected group'); setPicking(false); setError('')
    try {
      const next = await athenaApi<AthenaProject>(`/projects/${project.id}/command`, { version: current.version, action: 'multi_electron', group_ids: [activeId], options: current.options })
      if (committed.current !== key) throw new Error('The workspace changed while saving. Reload the project to see the MEE group.')
      saved(next); close()
    } catch (reason) {
      setPreview(null); setError(reason instanceof Error ? reason.message : 'Could not save the MEE group. Preview again.')
    } finally { saving.current = false; setBusy('') }
  }
  const arrays = group?.result?.arrays ?? {}
  const [xkey, ykey] = space === 'E' ? ['energy', 'norm'] : space === 'k' ? ['k', 'weighted_chi'] : ['r', 'chir_mag']
  const result = current?.results[0]
  const traces = result?.traces[space] ?? (arrays[xkey]?.length && arrays[ykey]?.length ? [{ role: 'original', label: group!.label, x: arrays[xkey], y: arrays[ykey] }] : [])
  const center = typeof e0 === 'number' && numeric && options.shift > 0 ? space === 'E' ? e0 + options.shift : space === 'k' ? Math.sqrt(options.shift * .2624682917) : null : null
  const pickable = eligible && space !== 'R' && !!traces.length && !disabled
  function pluck(x: unknown) {
    if (!picking || !pickable || typeof x !== 'number' || !Number.isFinite(x) || typeof e0 !== 'number'
      || pickContext.current.key !== key || pickContext.current.space !== space || !pickContext.current.picking) return
    const shift = space === 'E' ? x - e0 : x * x / .2624682917
    if (shift <= 0 || (space === 'k' && x < 0)) { setError('Pick a point above the primary edge.'); return }
    setDraft(d => ({ ...d, shift: shift.toFixed(3) })); setPicking(false)
  }
  return <div className="ath-modal-body">
    <p>Model a secondary edge using a shifted, broadened copy of the normalized spectrum or an arctangent. Adjust the model while comparing the original and corrected curves. Parameters are chosen from your data; they are not fitted automatically.</p>
    <div className={styles.layout}>
      <fieldset className={styles.controls} disabled={disabled}>
        <label className="ath-field"><span>Source group</span><select aria-label="Source group" value={activeId} onChange={e => selectGroup(e.target.value)}>{project.groups.map(g => <option key={g.id} value={g.id}>{g.label}{g.frozen ? ' · frozen' : ''}</option>)}</select></label>
        <label className="ath-field"><span>Algorithm</span><select aria-label="Algorithm" value={draft.method} onChange={e => setDraft(d => ({ ...d, method: e.target.value as Options['method'] }))}><option value="reflection">Reflection</option><option value="arctangent">Arctangent</option></select></label>
        {(['shift', 'amplitude', 'width'] as const).map((field, i) => <label className="ath-field" key={field}><span>{['Energy shift (eV)', 'Scale by (edge-step fraction)', 'Broadening (eV)'][i]}</span><input type="number" step="any" value={draft[field]} onChange={e => setDraft(d => ({ ...d, [field]: e.target.value }))} /></label>)}
        <button type="button" disabled={!pickable} aria-pressed={picking} onClick={() => setPicking(v => !v)}>{picking ? 'Cancel energy-shift pick' : 'Pick energy shift'}</button>
        <p className="ath-hint">Primary E₀: {typeof e0 === 'number' ? `${e0.toFixed(3)} eV` : 'unavailable'}. Pick an E or k point to set the excitation energy above E₀. Broadening uses a Lorentzian HWHM; values below 0.01 eV become 0.01. Negative scale becomes zero.</p>
        <p className="ath-hint">The corrected group keeps the source recipe and is processed again. Frozen sources can be compared and copied. Parameter drafts in the main pane must be applied before opening this tool.</p>
      </fieldset>
      <section className={styles.results} aria-label="MEE preview results">
        <div className={styles.views}>{(['E', 'k', 'R'] as const).map(view => <button key={view} disabled={disabled} aria-pressed={space === view} onClick={() => { setSpace(view); setPicking(false) }}>{view === 'E' ? 'Plot in energy' : `Plot in ${view}`}</button>)}</div>
        {picking && <p className={styles.pick} role="status">Click a curve to set the energy shift.</p>}
        <div className={styles.plot} aria-label={`${space}-space MEE preview`}>{traces.length ? <Plot
          data={traces.map(t => ({ x: t.x.slice(), y: t.y.slice(), name: `${t.role === 'original' ? 'Original' : 'MEE corrected'} · ${t.label}`, type: 'scatter', mode: 'lines', line: { color: t.role === 'original' ? '#16736b' : '#bb6542', width: 1.8 } }))}
          onClick={event => pluck(event.points?.[0]?.x)}
          layout={{ autosize: true, margin: { l: 65, r: 18, t: 75, b: 55 }, hovermode: 'closest', font: { size: 11 },
            legend: { orientation: 'h', x: 0, y: 1.04, yanchor: 'bottom' },
            xaxis: { title: { text: space === 'E' ? 'Energy (eV)' : space === 'k' ? 'k (Å⁻¹)' : 'R (Å)' } },
            yaxis: { title: { text: space === 'E' ? 'Normalized μ(E)' : space === 'k' ? `k^${group?.parameters.kweight} χ(k)` : '|χ(R)|' }, automargin: true },
            shapes: center === null ? [] : [{ type: 'line', x0: center, x1: center, y0: 0, y1: 1, yref: 'paper', line: { color: '#9b8355', dash: 'dot' } }],
            uirevision: `${project.id}:${activeId}:${space}` }}
          config={{ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'], toImageButtonOptions: { format: 'svg', filename: 'athena-mee' } }}
          style={{ width: '100%', height: '100%' }} useResizeHandler /> : <p>{result?.errors[space] ?? 'No curve is available in this plot space.'}</p>}</div>
        {!eligible ? <p role="status">Choose a processed absorption spectrum with a saved E₀.</p> : !numeric ? <p role="status">Enter finite values for all three parameters.</p> : options.shift <= 0 ? <p role="status">Set a positive energy shift to preview the correction.</p> : <p role="status">{loading ? 'Calculating MEE preview…' : current ? `Preview at project revision ${current.version}` : 'Waiting for a current MEE preview…'}</p>}
        {result?.details.warnings.map(w => <p className="ath-warning" key={w}>{w}</p>)}
        {error && <div className="ath-error" role="alert">{error}</div>}
      </section>
    </div>
    <div className={`ath-modal-actions ${meeStyles.actions}`}><button disabled={disabled} onClick={close}>Close MEE tool</button><button disabled={disabled || !canCalculate || loading} onClick={() => { setPreview(null); setRetry(v => v + 1) }}>Preview again</button><button className="ath-primary" disabled={disabled || !current || loading} onClick={() => { void save() }}>Make group from MEE-corrected data</button></div>
  </div>
}
