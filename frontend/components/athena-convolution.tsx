'use client'

import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import styles from './athena-difference.module.css'
import convolutionStyles from './athena-smoothing.module.css'

const Plot = dynamic(() => import('react-plotly.js').then(m => m.default), { ssr: false })
type Space = 'E' | 'k' | 'R'
type Options = { form: 'gaussian' | 'lorentzian'; width: number; noise: number; seed?: number | null }
export type ConvolutionDraft = {form: Options['form']; width: string; noise: string}
type Trace = { role: string; label: string; x: number[]; y: number[] }
export type ConvolutionPreview = {
  project_id: string; version: number; options: Options
  results: { group_id: string; label: string; input_space: 'E' | 'k'; data_type: string; kweight: number
    modified_energy: number[]; modified_mu: number[]
    details: { input_points: number; output_points: number; noise_sigma: number; seed: number | null; edge_step: number | null; warnings: string[] }
    traces: Record<Space, Trace[]>; errors: Partial<Record<Space, string>> }[]
}

const finiteArray = (a: unknown): a is number[] => Array.isArray(a) && a.length > 0 && a.every(v => typeof v === 'number' && Number.isFinite(v))
function validate(value: ConvolutionPreview, project: AthenaProject, groupId: string, options: Options) {
  if (value.project_id !== project.id || value.version !== project.version || value.results?.length !== 1 || value.results[0].group_id !== groupId
    || Object.entries(options).some(([key, v]) => value.options?.[key as keyof Options] !== v)) throw new Error('The convolution preview does not match these settings. Preview again.')
  const result = value.results[0], group = project.groups.find(g => g.id === groupId)!
  const inputSpace = group.data_type === 'chi' ? 'k' : 'E'
  if (result.input_space !== inputSpace || !finiteArray(result.modified_energy) || !finiteArray(result.modified_mu)
    || result.modified_energy.length !== result.modified_mu.length || result.details?.output_points !== result.modified_mu.length
    || result.details.input_points !== group.mu.length
    || result.details.output_points !== result.details.input_points
    || !Number.isFinite(result.details.noise_sigma) || result.details.noise_sigma < 0
    || (options.noise > 0 && (!Number.isInteger(value.options.seed) || value.options.seed! < 0 || value.options.seed! > 4294967295 || result.details.seed !== value.options.seed))
    || !Array.isArray(result.details.warnings) || !result.details.warnings.every(v => typeof v === 'string')) throw new Error('The convolution preview is incomplete. Preview again.')
  for (const space of ['E', 'k', 'R'] as const) {
    const traces = result.traces?.[space]
    if (!Array.isArray(traces) || (space === inputSpace && traces.length !== 2) || ![0, 2].includes(traces.length)) throw new Error('The convolution preview has incomplete curves. Preview again.')
    for (const t of traces) if (!finiteArray(t.x) || !finiteArray(t.y) || t.x.length !== t.y.length) throw new Error('The convolution preview has invalid numerical data. Preview again.')
    if (traces.length && (traces[0].role !== 'original' || traces[1].role !== 'modified')) throw new Error('The convolution comparison is incomplete. Preview again.')
  }
}

export function AthenaConvolution({ project, activeId, selectGroup, setBusy, saved, close, disabled, initialDraft, rememberDraft }: {
  project: AthenaProject; activeId: string; selectGroup: (id: string) => void; setBusy: (value: string) => void
  saved: (next: AthenaProject) => void; close: () => void; disabled: boolean
  initialDraft?: ConvolutionDraft; rememberDraft?: (draft: ConvolutionDraft) => void
}) {
  const group = project.groups.find(g => g.id === activeId)
  const [draft, setDraft] = useState<ConvolutionDraft>(() => initialDraft ?? {form: 'gaussian', width: '0', noise: '0'})
  useEffect(() => { rememberDraft?.(draft) }, [draft, rememberDraft])
  const [space, setSpace] = useState<Space>(group?.data_type === 'chi' ? 'k' : 'E')
  const [preview, setPreview] = useState<{ key: string; value: ConvolutionPreview } | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const generation = useRef(0), saving = useRef(false)
  const chi = group?.data_type === 'chi'
  const options: Options = {form: draft.form, width: chi ? 0 : Number(draft.width), noise: Number(draft.noise)}
  const numeric = (chi ? ['noise'] as const : ['width', 'noise'] as const).every(k => draft[k].trim() && Number.isFinite(Number(draft[k])) && Number(draft[k]) >= 0)
    && options.width <= 1000 && options.noise <= 100
  const eligible = !!group && group.energy.length >= 10 && group.energy.length === group.mu.length
  const canCalculate = eligible && numeric
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
        const value = await athenaApi<ConvolutionPreview>(`/projects/${project.id}/convolve/preview`, { version: project.version, action: 'convolve', group_ids: [activeId], options }, 'POST', controller.signal)
        if (token !== generation.current || committed.current !== key) return
        validate(value, project, activeId, options); setPreview({ key, value })
      } catch (reason) {
        if (!controller.signal.aborted && token === generation.current) setError(reason instanceof Error ? reason.message : 'Could not preview convolution. Try again.')
      } finally { if (token === generation.current) setLoading(false) }
    }, 400)
    return () => { clearTimeout(timer); controller.abort(); generation.current++ }
  // Every input used by this request belongs to the revision/settings key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, canCalculate, disabled])

  async function save() {
    if (!current || disabled || saving.current || committed.current !== key) return
    saving.current = true; setBusy('Saving modified group'); setError('')
    try {
      const next = await athenaApi<AthenaProject>(`/projects/${project.id}/command`, { version: current.version, action: 'convolve', group_ids: [activeId], options: current.options })
      if (committed.current !== key) throw new Error('The workspace changed while saving. Reload the project to see the modified group.')
      const added = next.groups?.filter(g => !project.groups.some(old => old.id === g.id)), expected = current.results[0]
      if (next.id !== project.id || next.version !== current.version + 1 || added?.length !== 1
        || added[0].source.parent !== activeId || added[0].mu.length !== expected.modified_mu.length
        || added[0].energy.length !== expected.modified_energy.length
        || added[0].mu.some((v, i) => v !== expected.modified_mu[i]) || added[0].energy.some((v, i) => v !== expected.modified_energy[i])) throw new Error('The saved convolution result could not be confirmed. Reload the project before trying again.')
      saved(next); close()
    } catch (reason) {
      setPreview(null); setError(reason instanceof Error ? reason.message : 'Could not save the modified group. Preview again.')
    } finally { saving.current = false; setBusy('') }
  }
  const arrays = group?.result?.arrays ?? {}, result = current?.results[0]
  const [xkey, ykey] = space === 'k' ? ['k', 'weighted_chi'] : ['r', 'chir_mag']
  const original = space === 'E' && group && group.data_type !== 'chi' ? [{ role: 'original', label: group.label, x: group.energy.map(x => x + group.parameters.energy_shift), y: group.mu }]
    : space !== 'E' && arrays[xkey]?.length && arrays[ykey]?.length ? [{ role: 'original', label: group!.label, x: arrays[xkey], y: arrays[ykey] }] : []
  const traces = result?.traces[space] ?? original
  return <div className={`ath-modal-body ${convolutionStyles.body}`}>
    <p>Compare the original with Gaussian or Lorentzian broadening, artificial noise, or both. Zero width leaves the spectrum unbroadened; zero noise adds no randomness. Saving keeps the exact noise realization shown in the preview.</p>
    <div className={styles.layout}>
      <fieldset className={styles.controls} disabled={disabled}>
        <label className="ath-field"><span>Source group</span><select aria-label="Source group" value={activeId} onChange={e => selectGroup(e.target.value)}>{project.groups.map(g => <option key={g.id} value={g.id}>{g.label}{g.frozen ? ' · frozen' : ''}</option>)}</select></label>
        <label className="ath-field"><span>Line shape</span><select value={draft.form} disabled={disabled || chi} onChange={e => setDraft(d => ({...d, form: e.target.value as Options['form']}))}>
          <option value="gaussian">Gaussian</option><option value="lorentzian">Lorentzian</option>
        </select></label>
        <label className="ath-field"><span>{draft.form === 'gaussian' ? 'Gaussian σ · eV' : 'Lorentzian HWHM · eV'}</span><input type="number" min={0} max={1000} step="any" disabled={disabled || chi} value={chi ? '0' : draft.width} onChange={e => setDraft(d => ({...d, width: e.target.value}))}/></label>
        <label className="ath-field"><span>{chi ? 'Noise σ · χ(k) units' : 'Noise σ · fraction of edge step'}</span><input type="number" min={0} max={100} step="any" value={draft.noise} onChange={e => setDraft(d => ({...d, noise: e.target.value}))}/></label>
        <p className="ath-hint">{chi ? 'χ(k) accepts noise only; energy broadening is disabled.' : 'Gaussian width is its standard deviation; Lorentzian width is half the full width at half maximum. Noise has a normal distribution scaled by the edge step after broadening.'}</p>
        <p className="ath-hint">Plot again to draw a fresh noise realization. Changing E/k/R views keeps the same data. Frozen sources remain available for comparison and copying.</p>
        <a href="https://bruceravel.github.io/demeter/documents/Athena/process/conv.html" target="_blank" rel="noreferrer">Document section: convolution and noise</a>
      </fieldset>
      <section className={styles.results} aria-label="Convolution preview results">
        <div className={styles.views}>{(['E', 'k', 'R'] as const).map(view => <button key={view} disabled={disabled} aria-pressed={space === view} onClick={() => setSpace(view)}>{view === 'E' ? 'Plot in energy' : `Plot in ${view}`}</button>)}</div>
        <div className={styles.plot} aria-label={`${space}-space convolution preview`}>{traces.length ? <Plot
          data={traces.map(t => ({ x: t.x.slice(), y: t.y.slice(), name: t.role === 'original' ? 'Original' : 'Modified', type: 'scatter', mode: 'lines', line: { color: t.role === 'original' ? '#16736b' : '#bb6542', width: 1.8 } }))}
          layout={{ autosize: true, margin: { l: 65, r: 18, t: 50, b: 55 }, hovermode: 'closest', font: { size: 11 },
            legend: { orientation: 'h', x: 0, y: 1.04, yanchor: 'bottom' },
            xaxis: { title: { text: space === 'E' ? 'Energy (eV)' : space === 'k' ? 'k (Å⁻¹)' : 'R (Å)' } },
            yaxis: { title: { text: space === 'E' ? group?.data_type === 'detector' ? 'Counts' : group?.is_normalized ? 'Normalized μ(E)' : 'μ(E)' : space === 'k' ? `k^${group?.parameters.kweight} χ(k)` : '|χ(R)|' }, automargin: true },
            uirevision: `${project.id}:${activeId}:${space}` }}
          config={{ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'], toImageButtonOptions: { format: 'svg', filename: 'athena-convolution' } }}
          style={{ width: '100%', height: '100%' }} useResizeHandler /> : <p>{result?.errors[space] ?? 'No curve is available in this plot space.'}</p>}</div>
        <p role="status">{!eligible ? 'Choose a spectrum with at least ten points.' : !numeric ? 'Enter a width from 0 to 1000 eV and noise from 0 to 100.' : loading ? 'Calculating convolution preview…' : current ? `Preview at project revision ${current.version}` : 'Waiting for a current convolution preview…'}</p>
        {result && <p>{result.details.output_points} of {result.details.input_points} points remain. {options.noise > 0 && `Added noise σ = ${result.details.noise_sigma.toPrecision(5)}${chi ? ' in χ(k) units.' : ' in input signal units.'}`}</p>}
        {result?.details.warnings.map(w => <p className="ath-warning" key={w}>{w}</p>)}
        {error && <div className="ath-error" role="alert">{error}</div>}
      </section>
    </div>
    <div className={`ath-modal-actions ${convolutionStyles.actions}`}><button disabled={disabled} onClick={close}>Close convolution tool</button><button disabled={disabled || !canCalculate || loading} onClick={() => { setPreview(null); setRetry(v => v + 1) }}>Plot data and modified</button><button className="ath-primary" disabled={disabled || !current || loading} onClick={() => { void save() }}>Make modified group</button></div>
  </div>
}
