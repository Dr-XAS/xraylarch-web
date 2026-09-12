'use client'

import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { SmoothingDefaults, useSmoothingPreferences } from './athena-smoothing-defaults'
import styles from './athena-difference.module.css'
import smoothingStyles from './athena-smoothing.module.css'

const Plot = dynamic(() => import('react-plotly.js').then(m => m.default), { ssr: false })
type Space = 'E' | 'k' | 'R'
type Method = 'boxcar' | 'gaussian' | 'savitzky_golay' | 'three_point'
type Options = { method: Method; window?: number; sigma?: number; order?: number; repetitions?: number }
export type SmoothingDraft = {method: Method; window: string; sigma: string; sgWindow: string; order: string; sgEdited: boolean}
type Trace = { role: string; label: string; x: number[]; y: number[] }
export type SmoothingPreview = {
  project_id: string; version: number; options: Options
  results: { group_id: string; label: string; input_space: 'E' | 'k'; data_type: string; kweight: number
    smoothed_energy: number[]; smoothed_mu: number[]
    details: { input_points: number; output_points: number; trimmed_left: number; trimmed_right: number; warnings: string[] }
    traces: Record<Space, Trace[]>; errors: Partial<Record<Space, string>> }[]
}

const finiteArray = (a: unknown): a is number[] => Array.isArray(a) && a.length > 0 && a.every(v => typeof v === 'number' && Number.isFinite(v))
function validate(value: SmoothingPreview, project: AthenaProject, groupId: string, options: Options) {
  if (value.project_id !== project.id || value.version !== project.version || value.results?.length !== 1 || value.results[0].group_id !== groupId
    || Object.entries(options).some(([key, v]) => value.options?.[key as keyof Options] !== v)) throw new Error('The smoothing preview does not match these settings. Preview again.')
  const result = value.results[0], group = project.groups.find(g => g.id === groupId)!
  const inputSpace = group.data_type === 'chi' ? 'k' : 'E'
  if (result.input_space !== inputSpace || !finiteArray(result.smoothed_energy) || !finiteArray(result.smoothed_mu)
    || result.smoothed_energy.length !== result.smoothed_mu.length || result.details?.output_points !== result.smoothed_mu.length
    || result.details.input_points !== group.mu.length
    || ![result.details.trimmed_left, result.details.trimmed_right].every(v => Number.isInteger(v) && v >= 0)
    || result.details.output_points + result.details.trimmed_left + result.details.trimmed_right !== result.details.input_points
    || !Array.isArray(result.details.warnings) || !result.details.warnings.every(v => typeof v === 'string')) throw new Error('The smoothing preview is incomplete. Preview again.')
  for (const space of ['E', 'k', 'R'] as const) {
    const traces = result.traces?.[space]
    if (!Array.isArray(traces) || (space === inputSpace && traces.length !== 2) || ![0, 2].includes(traces.length)) throw new Error('The smoothing preview has incomplete curves. Preview again.')
    for (const t of traces) if (!finiteArray(t.x) || !finiteArray(t.y) || t.x.length !== t.y.length) throw new Error('The smoothing preview has invalid numerical data. Preview again.')
    if (traces.length && (traces[0].role !== 'original' || traces[1].role !== 'smoothed')) throw new Error('The smoothing comparison is incomplete. Preview again.')
  }
}

export function AthenaSmoothing({ project, activeId, selectGroup, setBusy, saved, close, disabled, initialDraft, rememberDraft }: {
  project: AthenaProject; activeId: string; selectGroup: (id: string) => void; setBusy: (value: string) => void
  saved: (next: AthenaProject) => void; close: () => void; disabled: boolean
  initialDraft?: SmoothingDraft; rememberDraft?: (draft: SmoothingDraft) => void
}) {
  const group = project.groups.find(g => g.id === activeId)
  const [draft, setDraft] = useState<SmoothingDraft>(() => initialDraft ?? { method: 'boxcar', window: '11', sigma: '4', sgWindow: '31', order: '9', sgEdited: false })
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const preferences = useSmoothingPreferences({window: draft.sgWindow, order: draft.order},
    v => setDraft(d => ({...d, sgWindow: String(v.window), order: String(v.order), sgEdited: false})), !initialDraft?.sgEdited)
  useEffect(() => { rememberDraft?.(draft) }, [draft, rememberDraft])
  useEffect(() => { if (preferences.error) setPreferencesOpen(true) }, [preferences.error])
  const [space, setSpace] = useState<Space>(group?.data_type === 'chi' ? 'k' : 'E')
  const [preview, setPreview] = useState<{ key: string; value: SmoothingPreview } | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const generation = useRef(0), saving = useRef(false)
  const options: Options = draft.method === 'three_point' ? { method: draft.method, repetitions: Number(draft.window) }
    : draft.method === 'savitzky_golay' ? { method: draft.method, window: Number(draft.sgWindow), order: Number(draft.order) }
      : { method: draft.method, window: Number(draft.window), ...(draft.method === 'gaussian' ? { sigma: Number(draft.sigma) } : {}) }
  const fields = draft.method === 'savitzky_golay' ? ['sgWindow', 'order'] as const
    : draft.method === 'gaussian' ? ['window', 'sigma'] as const : ['window'] as const
  const numeric = fields.every(key => draft[key].trim() && Number.isFinite(Number(draft[key])) && Number(draft[key]) >= 0 && (key === 'sigma' || Number.isInteger(Number(draft[key]))))
  const eligible = !!group && group.energy.length >= 10 && group.energy.length === group.mu.length
  const sgReady = draft.method !== 'savitzky_golay' || !!preferences.state || draft.sgEdited
  const canCalculate = eligible && numeric && sgReady && (draft.method !== 'savitzky_golay' || preferences.valid)
  const key = JSON.stringify([project.id, project.version, activeId, options])
  const committed = useRef(key), current = preview?.key === key && canCalculate ? preview.value : null
  useLayoutEffect(() => { committed.current = key; generation.current++; setPreview(null); setLoading(false); setError('') }, [key])
  useLayoutEffect(() => { setSpace(group?.data_type === 'chi' ? 'k' : 'E') }, [activeId, group?.data_type])
  useEffect(() => {
    if (!canCalculate || disabled) return
    const controller = new AbortController(), token = ++generation.current
    const timer = setTimeout(async () => {
      setLoading(true); setError('')
      try {
        const value = await athenaApi<SmoothingPreview>(`/projects/${project.id}/smooth/preview`, { version: project.version, action: 'smooth', group_ids: [activeId], options }, 'POST', controller.signal)
        if (token !== generation.current || committed.current !== key) return
        validate(value, project, activeId, options); setPreview({ key, value })
      } catch (reason) {
        if (!controller.signal.aborted && token === generation.current) setError(reason instanceof Error ? reason.message : 'Could not preview smoothing. Try again.')
      } finally { if (token === generation.current) setLoading(false) }
    }, 400)
    return () => { clearTimeout(timer); controller.abort(); generation.current++ }
  // Every input used by this request belongs to the revision/settings key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, canCalculate, disabled])

  async function save() {
    if (!current || disabled || saving.current || committed.current !== key) return
    saving.current = true; setBusy('Saving smoothed group'); setError('')
    try {
      const next = await athenaApi<AthenaProject>(`/projects/${project.id}/command`, { version: current.version, action: 'smooth', group_ids: [activeId], options: current.options })
      if (committed.current !== key) throw new Error('The workspace changed while saving. Reload the project to see the smoothed group.')
      const added = next.groups?.filter(g => !project.groups.some(old => old.id === g.id)), expected = current.results[0]
      if (next.id !== project.id || next.version !== current.version + 1 || added?.length !== 1
        || added[0].source.parent !== activeId || added[0].mu.length !== expected.smoothed_mu.length
        || added[0].energy.length !== expected.smoothed_energy.length
        || added[0].mu.some((v, i) => v !== expected.smoothed_mu[i]) || added[0].energy.some((v, i) => v !== expected.smoothed_energy[i])) throw new Error('The saved smoothing result could not be confirmed. Reload the project before trying again.')
      saved(next); close()
    } catch (reason) {
      setPreview(null); setError(reason instanceof Error ? reason.message : 'Could not save the smoothed group. Preview again.')
    } finally { saving.current = false; setBusy('') }
  }
  const arrays = group?.result?.arrays ?? {}, result = current?.results[0]
  const [xkey, ykey] = space === 'k' ? ['k', 'weighted_chi'] : ['r', 'chir_mag']
  const original = space === 'E' && group && group.data_type !== 'chi' ? [{ role: 'original', label: group.label, x: group.energy.map(x => x + group.parameters.energy_shift), y: group.mu }]
    : space !== 'E' && arrays[xkey]?.length && arrays[ykey]?.length ? [{ role: 'original', label: group!.label, x: arrays[xkey], y: arrays[ykey] }] : []
  const traces = result?.traces[space] ?? original
  const names = { window: draft.method === 'three_point' ? 'Repetitions' : 'Kernel size · points', sigma: 'Gaussian σ · samples', sgWindow: 'Savitzky–Golay window · points', order: 'Polynomial order' }
  return <div className={`ath-modal-body ${smoothingStyles.body}`}>
    <p>Compare the original and filtered data before making a new group. Filters use neighbouring samples; on an irregular energy grid, their energy width varies along the scan. Smoothing can distort peak shapes and affect later analysis.</p>
    <div className={styles.layout}>
      <fieldset className={styles.controls} disabled={disabled}>
        <label className="ath-field"><span>Source group</span><select aria-label="Source group" value={activeId} onChange={e => selectGroup(e.target.value)}>{project.groups.map(g => <option key={g.id} value={g.id}>{g.label}{g.frozen ? ' · frozen' : ''}</option>)}</select></label>
        <label className="ath-field"><span>Algorithm</span><select aria-label="Algorithm" value={draft.method} onChange={e => setDraft(d => ({ ...d, method: e.target.value as Method }))}>
          <option value="boxcar">Boxcar average</option><option value="gaussian">Gaussian filter</option><option value="savitzky_golay">Savitzky–Golay</option><option value="three_point">Three-point smoothing</option>
        </select></label>
        {fields.map(field => <label className="ath-field" key={field}><span>{names[field]}</span><input type="number" min={field === 'order' ? 9 : 0} max={field === 'order' || field === 'sgWindow' ? 39 : undefined} step={field === 'sigma' ? 'any' : 1} value={draft[field]} onChange={e => setDraft(d => ({ ...d, [field]: e.target.value, ...((field === 'sgWindow' || field === 'order') ? {sgEdited: true} : {}) }))} /></label>)}
        <p className="ath-hint">{draft.method === 'boxcar' || draft.method === 'gaussian' ? 'Even kernel sizes become the next odd size. Athena trims the filter boundaries; the preview reports how many points remain.' : draft.method === 'savitzky_golay' ? 'Uses Larch’s Savitzky–Golay filter and endpoint padding. Athena’s effective defaults are a 31-sample window and order 9. The preference ranges are window 0–39 and order 9–39; Larch may adjust their relationship.' : 'Repeats Athena’s three-point kernel: half the centre sample plus one quarter of each neighbour. Repetitions share the kernel-size control used by boxcar and Gaussian.'}</p>
        {draft.method === 'savitzky_golay' && <details open={preferencesOpen} onToggle={e => setPreferencesOpen(e.currentTarget.open)}>
          <summary>Session and saved SG preferences</summary>
          <SmoothingDefaults preferences={preferences} disabled={disabled}/>
        </details>}
        <p className="ath-hint">Frozen source groups can be compared and copied. Apply any parameter changes in the main pane before opening this tool.</p>
        <a href="https://bruceravel.github.io/demeter/documents/Athena/process/smooth.html" target="_blank" rel="noreferrer">Document section: smoothing</a>
      </fieldset>
      <section className={styles.results} aria-label="Smoothing preview results">
        <div className={styles.views}>{(['E', 'k', 'R'] as const).map(view => <button key={view} disabled={disabled} aria-pressed={space === view} onClick={() => setSpace(view)}>{view === 'E' ? 'Plot in energy' : `Plot in ${view}`}</button>)}</div>
        <div className={styles.plot} aria-label={`${space}-space smoothing preview`}>{traces.length ? <Plot
          data={traces.map(t => ({ x: t.x.slice(), y: t.y.slice(), name: t.role === 'original' ? 'Original' : 'Smoothed', type: 'scatter', mode: 'lines', line: { color: t.role === 'original' ? '#16736b' : '#bb6542', width: 1.8 } }))}
          layout={{ autosize: true, margin: { l: 65, r: 18, t: 50, b: 55 }, hovermode: 'closest', font: { size: 11 },
            legend: { orientation: 'h', x: 0, y: 1.04, yanchor: 'bottom' },
            xaxis: { title: { text: space === 'E' ? 'Energy (eV)' : space === 'k' ? 'k (Å⁻¹)' : 'R (Å)' } },
            yaxis: { title: { text: space === 'E' ? group?.data_type === 'detector' ? 'Counts' : group?.is_normalized ? 'Normalized μ(E)' : 'μ(E)' : space === 'k' ? `k^${group?.parameters.kweight} χ(k)` : '|χ(R)|' }, automargin: true },
            uirevision: `${project.id}:${activeId}:${space}` }}
          config={{ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'], toImageButtonOptions: { format: 'svg', filename: 'athena-smoothing' } }}
          style={{ width: '100%', height: '100%' }} useResizeHandler /> : <p>{result?.errors[space] ?? 'No curve is available in this plot space.'}</p>}</div>
        <p role="status">{!eligible ? 'Choose a spectrum with at least ten points.' : !numeric ? 'Enter finite nonnegative parameters; kernel sizes, order and repetitions must be integers.' : !sgReady ? 'Load smoothing preferences or enter a window and order to preview.' : draft.method === 'savitzky_golay' && !preferences.valid ? 'Use a window from 0 to 39 and a polynomial order from 9 to 39.' : loading ? 'Calculating smoothing preview…' : current ? `Preview at project revision ${current.version}` : 'Waiting for a current smoothing preview…'}</p>
        {result && <p>{result.details.output_points} of {result.details.input_points} points remain. {result.details.trimmed_left + result.details.trimmed_right > 0 && `Removed ${result.details.trimmed_left} points at the left boundary and ${result.details.trimmed_right} at the right boundary.`}</p>}
        {result?.details.warnings.map(w => <p className="ath-warning" key={w}>{w}</p>)}
        {error && <div className="ath-error" role="alert">{error}</div>}
      </section>
    </div>
    <div className={`ath-modal-actions ${smoothingStyles.actions}`}><button disabled={disabled} onClick={close}>Close smoothing tool</button><button disabled={disabled || !canCalculate || loading} onClick={() => { setPreview(null); setRetry(v => v + 1) }}>Plot data and smoothed</button><button className="ath-primary" disabled={disabled || !current || loading} onClick={() => { void save() }}>Make smoothed group</button></div>
  </div>
}
