"use client"

import { ThemedPlot as Plot } from "./themed-plot"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { type AthenaGroup } from "@/lib/athena"
import { useAthenaApi } from "@/lib/athena-context"
import { AthenaDiagnosticPlot } from "./athena-diagnostic-plot"
import { useTheme } from "./theme-provider"
import { plotColorForTheme, plotDataForTheme } from "@/lib/plot-theme"
import { plotLayoutWithTypography } from "@/lib/plot-typography"
import styles from "./athena-special-plot.module.css"

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
  const athenaApi = useAthenaApi()
  const { theme } = useTheme()
  const marked = ["i0", "e00", "normscaled", "biquad"].includes(kind)
  const selected = marked ? groups.filter(g => g.marked) : active ? [active] : []
  const ids = selected.map(g => g.id), quad = kind === 'quad' || kind === 'biquad'
  const [remote, setRemote] = useState<{ key: string; value: ShortcutPlot } | null>(null)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0), [loading, setLoading] = useState(false)
  const [hidden, setHidden] = useState<number[]>([])
  const [exporting, setExporting] = useState(false)
  const figure = useRef<HTMLDivElement>(null)
  const generation = useRef(0), currentKey = useRef('')
  const options = { version, kind, group_ids: ids, energy_mode: energyMode, component, stack_offset: offset }
  const key = JSON.stringify([projectId, options])
  const available = !!projectId && version !== undefined && !!ids.length && !quad
  const current = available && remote?.key === key ? remote.value : null
  useLayoutEffect(() => { currentKey.current = key; generation.current++; setRemote(null); setError(''); setLoading(false); setHidden([]) }, [key])
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

  async function download() {
    const graph = figure.current?.querySelector('.js-plotly-plot') as (HTMLElement & { layout: Record<string, unknown> }) | null
    if (!current || !graph) return
    const requestedKey = key
    setExporting(true)
    try {
      const Plotly = (await import('plotly.js-dist-min')).default
      const traces = current.result.curves.filter((_, i) => !hidden.includes(i)).map(c => {
        const chunks = c.name.match(/.{1,60}/gu) ?? [c.name]
        const name = chunks.map(text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>')
        return { x: c.x, y: c.y, name, type: 'scatter', mode: 'lines', line: { color: colors[current.result.curves.indexOf(c) % colors.length], width: 1.8 } }
      })
      const height = Math.max(700, 100 + traces.reduce((total, t) => total + t.name.split('<br>').length * 18 + 12, 0))
      const url = await Plotly.toImage({ data: plotDataForTheme(traces, theme), layout: plotLayoutWithTypography({ ...graph.layout, autosize: false, width: 1400, height,
        margin: { l: 85, r: 440, t: 40, b: 65 }, showlegend: true, legend: { x: 1.02, y: 1, yanchor: 'top', orientation: 'v' } }) }, { format: 'svg', width: 1400, height })
      if (currentKey.current !== requestedKey) return
      const link = document.createElement('a'); link.href = url; link.download = `athena-${kind}.svg`
      document.body.appendChild(link); link.click(); link.remove()
    } catch (e) {
      if (currentKey.current === requestedKey) setError(e instanceof Error ? e.message : 'Could not export this plot.')
    } finally { setExporting(false) }
  }

  if (!ids.length) return <p role="status">{marked ? 'Mark groups to use this plot shortcut.' : 'Select a current group to use this plot shortcut.'}</p>
  if (kind === 'biquad' && ids.length !== 2) return <p role="status">Mark exactly two groups for Athena’s bi-quad plot.</p>
  if (!projectId || version === undefined) return <p role="status">Open a saved project to prepare this diagnostic plot.</p>
  if (quad) return <AthenaDiagnosticPlot key={kind} initialView={kind} project={{ id: projectId, version, groups }} groupId={active?.id ?? ids[0]} selectGroup={selectGroup ?? (() => {})} />
  const r = current?.result
  return <section aria-label={athenaSpecialPlotLabels[kind]}>
    <p role="status">{r ? `${r.curves.length} shortcut curves · project revision ${current.version}.` : loading ? 'Preparing Athena shortcut curves…' : 'Shortcut plot unavailable.'}</p>
    <button disabled={loading} onClick={() => { setRemote(null); setError(''); setRetry(n => n + 1) }}>Replot shortcut</button>
    {!!r?.curves.length && <button disabled={exporting || hidden.length === r.curves.length} onClick={() => { void download() }}>{exporting ? 'Exporting plot…' : 'Download shortcut SVG'}</button>}
    {error && <p role="alert" className="ath-error">{error}</p>}
    {r && r.curves.length > 0 && <div ref={figure} className={styles.plot} aria-label="Athena shortcut figure"><Plot data={r.curves.map((c, i) => ({ x: c.x, y: c.y, name: c.name, visible: !hidden.includes(i), type: 'scatter', mode: 'lines', line: { color: colors[i % colors.length], width: 1.8 } }))}
      layout={{ autosize: true, margin: { l: 75, r: 25, t: 20, b: 60 }, font: { color: '#586661' },
        xaxis: { title: { text: r.x_label }, automargin: true, ...(r.x_range ? { range: r.x_range } : {}) }, yaxis: { title: { text: r.y_label }, automargin: true },
        paper_bgcolor: '#fff', plot_bgcolor: '#fff', showlegend: false, hovermode: 'closest', uirevision: key }}
      config={{ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['toImage', 'lasso2d', 'select2d'] }}
      useResizeHandler style={{ width: '100%', height: '100%' }} /></div>}
    {!!r?.curves.length && <ul className={styles.legend} aria-label="Shortcut curve legend">{r.curves.map((c, i) => <li key={i}>
      <button type="button" aria-pressed={!hidden.includes(i)} onClick={() => setHidden(previous => previous.includes(i) ? previous.filter(n => n !== i) : [...previous, i])}>
        <span aria-hidden="true" style={{ background: plotColorForTheme(colors[i % colors.length], theme) }} /><span>{c.name}</span>
      </button>
    </li>)}</ul>}
    {r?.notes.map((note, i) => <p className={styles.note} key={i}>{note}</p>)}
    {!!r?.skipped.length && <ul className={styles.notes}>{r.skipped.map((s, i) => <li key={i}>{s.label}{s.channel ? ` · ${s.channel}` : ''}: {s.reason}</li>)}</ul>}
  </section>
}
