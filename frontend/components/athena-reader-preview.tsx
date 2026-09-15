'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import type { InspectionResponse } from '@/lib/contracts'
import styles from './athena-column-selection.module.css'

const Plot = dynamic(() => import('react-plotly.js').then(m => m.default), { ssr: false })

export function AthenaReaderPreview({ value, required, reviewed, onReviewed, disabled }: {
  value: NonNullable<InspectionResponse['reader_preview']>; required: boolean; reviewed: boolean
  onReviewed: (value: boolean) => void; disabled: boolean
}) {
  const [open, setOpen] = useState(required), [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  return <section className={styles.previewPanel} aria-label="I0 correction review">
    <div className={styles.previewTools}><strong>I0 argon correction</strong>
      <button type="button" disabled={required && !reviewed} onClick={() => setOpen(v => !v)}>{open ? 'Hide I0 correction' : 'Show I0 correction'}</button>
    </div>
    <p className="ath-hint">Step {value.step_size.toPrecision(6)} at {value.edge_energy.toFixed(3)} eV. The shaded regions select the pre-edge and post-edge fits. I0 is corrected only above the argon edge.</p>
    {open && <div className={styles.plot} aria-label="I0 correction plot"><Plot
      data={value.traces.map((trace, index) => ({ x: trace.x.slice(), y: trace.y.slice(), name: trace.label, type: 'scatter', mode: 'lines',
        line: { color: ['#b96342', '#7470b0', '#467cac', '#16736b'][index], width: 1.8,
          dash: trace.role === 'pre' || trace.role === 'post' ? 'dash' : 'solid' } }))}
      layout={{ autosize: true, margin: { l: 65, r: 15, t: 80, b: 55 }, showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.05, yanchor: 'bottom' },
        xaxis: { title: { text: 'Energy (eV)' }, zeroline: false }, yaxis: { title: { text: 'I0 signal' }, zeroline: false },
        paper_bgcolor: 'white', plot_bgcolor: 'white', font: { family: 'Arial, sans-serif', size: 11 },
        shapes: [...[value.pre_range, value.post_range].map(([x0, x1]) => ({ type: 'rect', xref: 'x', yref: 'paper',
          x0, x1, y0: 0, y1: 1, fillcolor: '#d9e7df', opacity: .35, line: { width: 0 }, layer: 'below' })),
          { type: 'line', xref: 'x', yref: 'paper', x0: value.edge_energy, x1: value.edge_energy,
            y0: 0, y1: 1, line: { color: '#65765b', width: 1, dash: 'dot' } }] }}
      config={{ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['select2d', 'lasso2d'] }}
      onInitialized={() => setReady(true)} onError={() => { setReady(false); onReviewed(false); setError('Could not display the I0 correction. Reinspect the file to retry.') }}
      style={{ width: '100%', height: '100%' }} useResizeHandler /></div>}
    {error && <p role="alert" className="ath-error">{error}</p>}
    {open && <p className="ath-hint">{value.points.toLocaleString()} source points. Column selection below uses the converted detector table; choose column 6 as a reference without a logarithm to compare the uncorrected absorption.</p>}
    {required && <label className="ath-check"><input type="checkbox" disabled={disabled || !ready} checked={reviewed}
      onChange={e => { onReviewed(e.target.checked); setOpen(!e.target.checked) }} />I reviewed the I0 correction for this file</label>}
  </section>
}
