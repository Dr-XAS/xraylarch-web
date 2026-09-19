'use client'

import { ThemedPlot as Plot } from "./themed-plot"
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type AthenaProject } from '@/lib/athena'
import { useAthenaApi } from '@/lib/athena-context'
import styles from './athena-diagnostic-plot.module.css'

type Options = { version: number; view: 'quad' | 'biquad' | 'kq'; group_ids: string[]; kweight: number | null; q_component: 're' | 'im' | 'mag' }
type Panel = { id: string; title: string; x_label: string; y_label: string; x_range: [number, number] | null;
  curves: { group_id: string; name: string; x: number[]; y: number[] }[] }
export type DiagnosticPlot = { project_id: string; version: number; options: Options; result: { group_ids: string[]; kweight: number; panels: Panel[]; notes: string[] } }
const colors = ['#16736b', '#c37b38', '#7470b0', '#c85a65']

function DiagnosticPanel({ panel, context, groupIds }: { panel: Panel; context: string; groupIds: string[] }) {
  const [minimum, setMinimum] = useState(''), [maximum, setMaximum] = useState('')
  const min = minimum.trim() === '' ? panel.x_range?.[0] ?? null : Number(minimum)
  const max = maximum.trim() === '' ? panel.x_range?.[1] ?? null : Number(maximum)
  const valid = (min === null || Number.isFinite(min)) && (max === null || Number.isFinite(max)) && (min === null || max === null || min < max)
  return <section className={styles.panel} aria-label={`${panel.title} diagnostic panel`}>
    <h3>{panel.title}</h3>
    <div className={styles.figure} aria-label={`${panel.title} diagnostic figure`}>
      <Plot data={panel.curves.map((c, i) => ({ name: c.name, x: c.x, y: c.y, type: 'scatter', mode: 'lines',
        line: { width: 1.8, color: colors[groupIds.length === 2 ? groupIds.indexOf(c.group_id) : i] } }))}
        layout={{ autosize: true, margin: { l: 65, r: 12, t: 90, b: 55 }, font: { size: 11 },
          legend: { orientation: 'h', y: 1.05, yanchor: 'bottom' },
          xaxis: { title: { text: panel.x_label }, ...(valid && (min !== null || max !== null) ? { range: [min, max] } : {}) },
          yaxis: { title: { text: panel.y_label } }, uirevision: `${context}:${panel.id}:${min}:${max}` }}
        config={{ responsive: true, displaylogo: false }} style={{ width: '100%', height: '100%' }} useResizeHandler />
    </div>
    <div className={styles.range}>
      <label>From <input aria-label={`${panel.title} plot minimum`} type="number" step="any" value={minimum} placeholder={String(panel.x_range?.[0] ?? 'Auto')} onChange={e => setMinimum(e.target.value)} /></label>
      <label>To <input aria-label={`${panel.title} plot maximum`} type="number" step="any" value={maximum} placeholder={String(panel.x_range?.[1] ?? 'Auto')} onChange={e => setMaximum(e.target.value)} /></label>
      <button onClick={() => { setMinimum(''); setMaximum('') }}>Reset range</button>
    </div>
    {!valid && <p role="alert" className="ath-error">Enter finite limits with From below To.</p>}
  </section>
}

export function AthenaDiagnosticPlot({ project, groupId, selectGroup, close, initialView = 'quad' }: {
  project: Pick<AthenaProject, 'id' | 'version' | 'groups'>; groupId: string; selectGroup: (id: string) => void;
  close?: () => void; initialView?: Options['view']
}) {
  const athenaApi = useAthenaApi()
  const [view, setView] = useState<Options['view']>(initialView), [weight, setWeight] = useState(''), [component, setComponent] = useState<Options['q_component']>('re')
  const [data, setData] = useState<{ key: string; value: DiagnosticPlot } | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0)
  const generation = useRef(0), currentKey = useRef('')
  const groups = view === 'biquad' ? project.groups.filter(g => g.marked) : project.groups.filter(g => g.id === groupId)
  const ids = groups.map(g => g.id)
  const options: Options = { version: project.version, view, group_ids: ids, kweight: weight.trim() === '' ? null : Number(weight), q_component: component }
  const reason = groups.length !== (view === 'biquad' ? 2 : 1) ? 'Close this window and mark exactly two groups for Bi-Quad, or choose a current-group plot.'
    : groups.some(g => !g.result?.effective.exafs || g.processing_error) ? 'Process or reprocess valid EXAFS parameters for every selected spectrum before making this plot.'
    : view !== 'kq' && groups.some(g => ['chi', 'xanes', 'detector'].includes(g.data_type)) ? 'Quad and Bi-Quad require energy spectra with all four plot spaces.'
    : options.kweight !== null && (!Number.isFinite(options.kweight) || options.kweight < 0 || options.kweight > 4) ? 'Choose a finite plot k weight from zero to four.' : ''
  const key = JSON.stringify([project.id, options]), current = data?.key === key && !reason ? data.value : null
  useLayoutEffect(() => { currentKey.current = key; generation.current++; setData(null); setError(''); setLoading(false) }, [key])
  useEffect(() => {
    if (reason) return
    const abort = new AbortController(), token = ++generation.current
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const value = await athenaApi<DiagnosticPlot>(`/projects/${project.id}/plots/special`, options, 'POST', abort.signal)
        if (token !== generation.current || currentKey.current !== key) return
        const r = value.result, expected = view === 'kq' ? ['kq'] : ['E', 'k', 'R', 'q']
        if (value.project_id !== project.id || value.version !== project.version
          || Object.entries(options).some(([k, v]) => JSON.stringify(value.options?.[k as keyof Options]) !== JSON.stringify(v))
          || JSON.stringify(r?.group_ids) !== JSON.stringify(ids) || !Number.isFinite(r.kweight) || r.kweight !== (options.kweight ?? groups[0].parameters.kweight)
          || !Array.isArray(r.panels) || r.panels.length !== expected.length
          || r.panels.some((p, i) => p.id !== expected[i] || !Array.isArray(p.curves)
            || p.curves.length !== (view === 'kq' || view === 'biquad' ? 2 : [4, 1, 2, 1][i])
            || p.curves.some((c, j) => c.group_id !== ids[view === 'biquad' ? j : 0]
              || !Array.isArray(c.x) || !Array.isArray(c.y) || c.x.length < 2 || c.x.length !== c.y.length
              || c.x.some((x, n) => typeof x !== 'number' || !Number.isFinite(x) || (n > 0 && x <= c.x[n - 1]))
              || c.y.some(y => typeof y !== 'number' || !Number.isFinite(y))))) throw new Error('The diagnostic plot does not match this selection and these settings. Replot to retry.')
        setData({ key, value }); setError('')
      } catch (e) { if (!abort.signal.aborted && token === generation.current) setError(e instanceof Error ? e.message : 'Could not prepare the diagnostic plot.') }
      finally { if (token === generation.current) setLoading(false) }
    }, 200)
    return () => { clearTimeout(timer); abort.abort(); generation.current++ }
  // key captures the revision, complete group selection and every display option.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reason, retry])
  return <div className={`ath-modal-body ${styles.body}`}>
    <p>Compare energy, EXAFS and Fourier-filtered spectra using the saved processing parameters. Display choices leave your project unchanged.</p>
    <fieldset className={styles.controls}>
      <label className="ath-field"><span>Diagnostic plot</span><select aria-label="Diagnostic plot" value={view} onChange={e => setView(e.target.value as Options['view'])}>
        <option value="quad">Quad · current group</option><option value="biquad">Bi-Quad · two marked groups</option><option value="kq">k / q · current group</option>
      </select></label>
      {view !== 'biquad' && <label className="ath-field"><span>Current spectrum</span><select aria-label="Diagnostic spectrum" value={groupId} onChange={e => selectGroup(e.target.value)}>{project.groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>}
      <label className="ath-field"><span>Plot k weight</span><input aria-label="Diagnostic k weight" type="number" min="0" max="4" step="any" value={weight} placeholder={`First group: ${groups[0]?.parameters.kweight ?? '—'}`} onChange={e => setWeight(e.target.value)} /></label>
      {view === 'kq' && <label className="ath-field"><span>Back-transform component</span><select aria-label="Diagnostic q component" value={component} onChange={e => setComponent(e.target.value as Options['q_component'])}>
        <option value="re">Real part</option><option value="im">Imaginary part</option><option value="mag">Magnitude</option>
      </select></label>}
      <button disabled={!!reason || loading} onClick={() => { setData(null); setError(''); setRetry(v => v + 1) }}>Replot diagnostics</button>
    </fieldset>
    <p className="ath-hint">{groups.map(g => g.label).join(' · ')}{view === 'biquad' ? ` · ${groups.length} marked` : ''}</p>
    <p role="status">{reason || (current ? `${current.result.panels.length} diagnostic panels · k weight ${current.result.kweight} · project revision ${current.version}.` : loading ? 'Preparing diagnostic plots…' : 'Waiting for diagnostic plots.')}</p>
    {error && <p role="alert" className="ath-error">{error}</p>}
    {current && <div className={view === 'kq' ? styles.single : styles.grid}>{current.result.panels.map(p => <DiagnosticPanel key={`${key}:${p.id}`} panel={p} context={key} groupIds={ids} />)}</div>}
    {current?.result.notes.map((note, i) => <p className="ath-hint" key={i}>{note}</p>)}
    <div className="ath-modal-actions"><a href="https://bruceravel.github.io/demeter/documents/Athena/plot/etc.html" target="_blank" rel="noreferrer">Athena plotting guide</a>{close && <button onClick={close}>Close diagnostic plots</button>}</div>
  </div>
}
