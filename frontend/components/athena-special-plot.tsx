"use client"

import dynamic from "next/dynamic"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { athenaApi, type AthenaGroup } from "@/lib/athena"
import { AthenaDiagnosticPlot } from "./athena-diagnostic-plot"
import styles from "./athena-special-plot.module.css"

const Plot = dynamic(() => import("react-plotly.js").then(module => module.default), { ssr: false, loading: () => <p>Loading plot…</p> })
const colors = ["#16736b", "#c37b38", "#7470b0", "#c85a65", "#467cac", "#8e9c47"]

export type AthenaSpecialPlotKind = "i0sig" | "normderiv" | "k123" | "r123" | "quad" | "i0" | "e00" | "normscaled" | "biquad"
export const athenaSpecialPlotLabels: Record<AthenaSpecialPlotKind, string> = {
  i0sig: "Data + I₀ + signal", normderiv: "Normalized μ(E) + derivative", k123: "k-space · weights 1, 2, 3",
  r123: "R-space · weights 1, 2, 3", quad: "Quad plot", i0: "Marked I₀", e00: "Marked E − E₀",
  normscaled: "Marked normalized data × edge step", biquad: "Bi-quad plot · two marked groups",
}

type Props = {
  kind: AthenaSpecialPlotKind; groups: AthenaGroup[]; active?: AthenaGroup
  projectId?: string; version?: number; energyMode?: string; component?: string; offset?: number
  selectGroup?: (id: string) => void
}
type Options = { version: number; kind: Exclude<AthenaSpecialPlotKind, 'quad' | 'biquad'>; group_ids: string[]; energy_mode: string; component: string; stack_offset: number }
export type ShortcutPlot = { project_id: string; version: number; options: Options; result: {
  group_ids: string[]; curves: { group_id: string; name: string; x: number[]; y: number[]; kweight?: number; scale: number; effective_scale: number; offset: number }[];
  notes: string[]; skipped: { group_id: string; label: string; reason: string; channel?: string }[];
  x_label: string; y_label: string; x_range: [number, number] | null;
} }

export function AthenaSpecialPlot({ kind, groups, active, projectId, version, energyMode = "norm", component = "mag", offset = 0, selectGroup }: Props) {
  const marked = ["i0", "e00", "normscaled", "biquad"].includes(kind)
  const selected = marked ? groups.filter(g => g.marked) : active ? [active] : []
  const ids = selected.map(g => g.id), quad = kind === 'quad' || kind === 'biquad'
  const [remote, setRemote] = useState<{ key: string; value: ShortcutPlot } | null>(null)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0), [loading, setLoading] = useState(false)
  const generation = useRef(0), currentKey = useRef('')
  const options = { version, kind, group_ids: ids, energy_mode: energyMode, component, stack_offset: offset }
  const key = JSON.stringify([projectId, options])
  const available = !!projectId && version !== undefined && !!ids.length && !quad
  const current = available && remote?.key === key ? remote.value : null
  useLayoutEffect(() => { currentKey.current = key; generation.current++; setRemote(null); setError(''); setLoading(false) }, [key])
  useEffect(() => {
    if (!available) return
    const abort = new AbortController(), token = ++generation.current
    setLoading(true)
    void athenaApi<ShortcutPlot>(`/projects/${projectId}/plots/shortcut`, options, 'POST', abort.signal).then(value => {
      if (abort.signal.aborted || token !== generation.current || currentKey.current !== key) return
      const r = value.result
      if (value.project_id !== projectId || value.version !== version
        || Object.entries(options).some(([name, v]) => JSON.stringify(value.options?.[name as keyof Options]) !== JSON.stringify(v))
        || JSON.stringify(r?.group_ids) !== JSON.stringify(ids) || !Array.isArray(r.curves) || !Array.isArray(r.notes) || !Array.isArray(r.skipped)
        || typeof r.x_label !== 'string' || typeof r.y_label !== 'string'
        || (r.x_range !== null && (!Array.isArray(r.x_range) || r.x_range.length !== 2 || !r.x_range.every(v => typeof v === 'number' && Number.isFinite(v)) || r.x_range[0] >= r.x_range[1]))
        || r.notes.some(note => typeof note !== 'string')
        || r.skipped.some(item => !ids.includes(item.group_id) || typeof item.label !== 'string' || typeof item.reason !== 'string' || (item.channel !== undefined && typeof item.channel !== 'string'))
        || r.curves.some(c => !ids.includes(c.group_id) || !Array.isArray(c.x) || !Array.isArray(c.y) || c.x.length < 2 || c.x.length !== c.y.length
          || typeof c.name !== 'string' || c.x.some((v, i) => typeof v !== 'number' || !Number.isFinite(v) || (i > 0 && v <= c.x[i - 1]))
          || c.y.some(v => typeof v !== 'number' || !Number.isFinite(v)))
        || (['k123', 'r123'].includes(kind) && (r.curves.length !== 3 || [1, 2, 3].some(w => r.curves.filter(c => c.kweight === w).length !== 1)))) {
        throw new Error('The shortcut plot does not match this project, selection and settings. Replot to retry.')
      }
      setRemote({ key, value }); setError('')
    }).catch(e => { if (!abort.signal.aborted && token === generation.current) setError(e instanceof Error ? e.message : 'Could not calculate the shortcut plot.') })
      .finally(() => { if (token === generation.current) setLoading(false) })
    return () => { abort.abort(); generation.current++ }
  // key captures every display option, group selection and project revision.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, available, retry])

  if (!ids.length) return <p role="status">{marked ? 'Mark groups to use this plot shortcut.' : 'Select a current group to use this plot shortcut.'}</p>
  if (kind === 'biquad' && ids.length !== 2) return <p role="status">Mark exactly two groups for Athena’s bi-quad plot.</p>
  if (!projectId || version === undefined) return <p role="status">Open a saved project to prepare this diagnostic plot.</p>
  if (quad) return <AthenaDiagnosticPlot key={kind} initialView={kind} project={{ id: projectId, version, groups }} groupId={active?.id ?? ids[0]} selectGroup={selectGroup ?? (() => {})} />
  const r = current?.result
  return <section aria-label={athenaSpecialPlotLabels[kind]}>
    <p role="status">{r ? `${r.curves.length} shortcut curves · project revision ${current.version}.` : loading ? 'Preparing Athena shortcut curves…' : 'Shortcut plot unavailable.'}</p>
    <button disabled={loading} onClick={() => { setRemote(null); setError(''); setRetry(n => n + 1) }}>Replot shortcut</button>
    {error && <p role="alert" className="ath-error">{error}</p>}
    {r && r.curves.length > 0 && <div className={styles.plot} aria-label="Athena shortcut figure"><Plot data={r.curves.map((c, i) => ({ x: c.x, y: c.y, name: c.name, type: 'scatter', mode: 'lines', line: { color: colors[i % colors.length], width: 1.8 } }))}
      layout={{ autosize: true, margin: { l: 75, r: 25, t: 20, b: 110 }, font: { family: 'Arial, sans-serif', color: '#586661', size: 12 },
        xaxis: { title: { text: r.x_label }, automargin: true, ...(r.x_range ? { range: r.x_range } : {}) }, yaxis: { title: { text: r.y_label }, automargin: true },
        paper_bgcolor: '#fff', plot_bgcolor: '#fff', legend: { orientation: 'h', y: -0.24 }, hovermode: 'closest', uirevision: key }}
      config={{ responsive: true, displaylogo: false, toImageButtonOptions: { format: 'svg', filename: `athena-${kind}` }, modeBarButtonsToRemove: ['lasso2d', 'select2d'] }}
      useResizeHandler style={{ width: '100%', height: '100%' }} /></div>}
    {r?.notes.map((note, i) => <p className={styles.note} key={i}>{note}</p>)}
    {!!r?.skipped.length && <ul className={styles.notes}>{r.skipped.map((s, i) => <li key={i}>{s.label}{s.channel ? ` · ${s.channel}` : ''}: {s.reason}</li>)}</ul>}
  </section>
}
