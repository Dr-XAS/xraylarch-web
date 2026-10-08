'use client'

import { SectionHelp } from "./section-help"

import { ThemedPlot as Plot } from "./themed-plot"
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type AthenaProject } from '@/lib/athena'
import { useAthenaApi } from '@/lib/athena-context'
import styles from './athena-processing-layout.module.css'

type View = 'spectrum' | 'depth'
type Algorithm = 'fluo' | 'booth'
export type SelfAbsorptionOptions = {
  algorithm: Algorithm; formula: string; element: string; edge: string
  angle_in: number; angle_out: number; thickness?: number; density?: number
}
export type SelfAbsorptionPreview = {
  project_id: string; version: number; options: SelfAbsorptionOptions
  results: {
    group_id: string; label: string; energy: number[]; measured: number[]; corrected: number[]
    information_depth_um: number[] | null; sampled_fraction: number[] | null
    attenuation_length_um: number | null; reference_sampled_fraction: number | null
    thickness_over_attenuation_length: number | null
    details: { algorithm: Algorithm; alpha: number; fluorescence_energy: number; edge_energy: number }
    // The normalization the inversion started from: the group's own, unless
    // the request overrode it. Shown, because the correction is nonlinear in it.
    normalization?: { e0: number; pre1: number; pre2: number; norm1: number; norm2: number; nnorm: number; step?: number | null; nvict?: number | null }
  }[]
}

function finite(values: unknown, length?: number) {
  return Array.isArray(values) && values.length > 0 && (length === undefined || values.length === length)
    && values.every(v => typeof v === 'number' && Number.isFinite(v))
}

function validate(value: SelfAbsorptionPreview, project: AthenaProject, groupId: string, options: SelfAbsorptionOptions) {
  if (value.project_id !== project.id || value.version !== project.version || value.results?.length !== 1 || value.results[0].group_id !== groupId
      || Object.entries(options).some(([key, v]) => value.options?.[key as keyof SelfAbsorptionOptions] !== v))
    throw new Error('The self-absorption preview does not match these settings. Preview again.')
  const result = value.results[0]
  if (!finite(result.energy) || !finite(result.measured, result.energy.length) || !finite(result.corrected, result.energy.length))
    throw new Error('The self-absorption preview has invalid numerical data. Preview again.')
  if (!Number.isFinite(result.details?.alpha) || !Number.isFinite(result.details?.fluorescence_energy))
    throw new Error('The self-absorption preview is incomplete. Preview again.')
  // The depth curves are optional, but a present one must cover the whole scan.
  for (const curve of [result.information_depth_um, result.sampled_fraction])
    if (curve !== null && curve !== undefined && !finite(curve, result.energy.length))
      throw new Error('The self-absorption preview has an invalid depth curve. Preview again.')
  if ((options.density !== undefined) !== (result.information_depth_um != null))
    throw new Error('The self-absorption preview does not match these settings. Preview again.')
}

/** What the numbers say about whether either correction can be believed. */
function applicability(result: SelfAbsorptionPreview['results'][0], algorithm: Algorithm) {
  const depth = result.information_depth_um
  if (!depth) return 'Enter the sample density to see how deep the detected fluorescence comes from.'
  const shallow = Math.min(...depth), deep = Math.max(...depth)
  // The probing depth is where the incoming and outgoing beams together have
  // fallen by 1/e. "63% of the signal comes from shallower than it" holds for
  // a semi-infinite sample only; a finite slab is described by its own share.
  const span = `The probing depth runs from ${deep.toFixed(2)} µm in the pre-edge to ${shallow.toFixed(2)} µm at its shortest.`
  // What decides whether the thick-sample correction applies is the reference
  // yield the normalized measurement divides by, so the comparison is against
  // the probing depth at the edge step, not the shortest in the scan.
  const reference = result.reference_sampled_fraction
  const length = result.attenuation_length_um
  const at = length === null ? '' : ` At the edge step it is ${length.toFixed(2)} µm.`
  if (reference === null || length === null || result.thickness_over_attenuation_length === null)
    return `${span}${at} In a sample much thicker than that, 63% of the detected signal comes from within one probing depth of the surface. Enter a thickness to see what a slab of that thickness does.`
  const thickness = result.thickness_over_attenuation_length * length
  // The depth holding 63% of THIS slab's signal: (1 - e^(-z/L)) / (1 - e^(-d/L)) = 0.63.
  const share = -length * Math.log(1 - 0.63 * reference)
  const emitted = ` At the edge step this ${thickness.toPrecision(3)} µm slab emits ${(100 * reference).toFixed(0)}% of what an infinitely thick one would, and 63% of this slab's own signal comes from its top ${share.toFixed(2)} µm.`
  if (reference >= 0.99) return `${span}${at}${emitted} The slab is effectively thick at the edge step, so the finite-thickness correction approaches the thick-sample one. That says nothing about how close either is to the truth: near the thick-sample pole both amplify any error in the measured white line.`
  if (reference >= 0.63) return `${span}${at}${emitted} The slab is thicker than one probing depth but not saturated, so the two corrections differ and the finite-thickness one is the smaller.`
  return `${span}${at}${emitted} The slab is thinner than one probing depth, so the thick-sample correction overestimates self-absorption here${algorithm === 'fluo' ? '; use the finite-thickness correction instead.' : '.'}`
}

export function AthenaSelfAbsorption({ project, activeId, selectGroup, setBusy, saved, close, disabled }: {
  project: AthenaProject; activeId: string; selectGroup: (id: string) => void; setBusy: (value: string) => void
  saved: (next: AthenaProject) => void; close: () => void; disabled: boolean
}) {
  const athenaApi = useAthenaApi()
  const [draft, setDraft] = useState({ algorithm: 'fluo' as Algorithm, formula: '', element: '', edge: 'K',
    angle_in: '45', angle_out: '45', thickness: '', density: '' })
  const [view, setView] = useState<View>('spectrum')
  const [preview, setPreview] = useState<{ key: string; value: SelfAbsorptionPreview } | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const generation = useRef(0), saving = useRef(false)
  const group = project.groups.find(g => g.id === activeId)
  const eligible = !!group && !!group.result?.arrays.norm?.length && !group.processing_error
    && !['chi', 'detector'].includes(group.data_type)
  const angles = [draft.angle_in, draft.angle_out].map(Number)
  // The server's limits: angles from the sample surface, 0.1° to 90°.
  const anglesValid = [draft.angle_in, draft.angle_out].every(v => v.trim() && Number.isFinite(Number(v)))
    && angles.every(a => a >= 0.1 && a <= 90)
  // Density is optional under FLUO, where it only buys the depth diagnostic.
  const optional = (value: string) => value.trim() === '' ? undefined : Number(value)
  const thickness = optional(draft.thickness), density = optional(draft.density)
  const extrasValid = [thickness, density].every(v => v === undefined || (Number.isFinite(v) && v > 0))
  const needsSlab = draft.algorithm === 'booth'
  const options: SelfAbsorptionOptions = { algorithm: draft.algorithm, formula: draft.formula.trim(), element: draft.element.trim(),
    edge: draft.edge.trim(), angle_in: angles[0], angle_out: angles[1],
    ...(thickness === undefined ? {} : { thickness }), ...(density === undefined ? {} : { density }) }
  const composed = !!options.formula && !!options.element && !!options.edge
  const canCalculate = eligible && composed && anglesValid && extrasValid
    && (!needsSlab || (thickness !== undefined && density !== undefined))
  const key = JSON.stringify([project.id, project.version, activeId, draft])
  const committed = useRef(key)
  const current = preview?.key === key ? preview.value : null
  useLayoutEffect(() => { committed.current = key; generation.current++; setPreview(null); setLoading(false); setError('') }, [key])
  useEffect(() => {
    if (!canCalculate || disabled) return
    const controller = new AbortController(), token = ++generation.current
    const timer = setTimeout(async () => {
      setLoading(true); setError('')
      try {
        const value = await athenaApi<SelfAbsorptionPreview>(`/projects/${project.id}/self-absorption/preview`,
          { version: project.version, action: 'self_absorption', group_ids: [activeId], options }, 'POST', controller.signal)
        if (token !== generation.current || committed.current !== key) return
        validate(value, project, activeId, options)
        setPreview({ key, value })
      } catch (reason) {
        if (!controller.signal.aborted && token === generation.current) setError(reason instanceof Error ? reason.message : 'Could not preview the correction. Try again.')
      } finally { if (token === generation.current) setLoading(false) }
    }, 400)
    return () => { clearTimeout(timer); controller.abort(); generation.current++ }
  // One intent includes every project, group and parameter used by the request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, canCalculate, disabled])

  async function save() {
    if (!current || disabled || saving.current || committed.current !== key) return
    saving.current = true; setBusy('Saving corrected group'); setError('')
    try {
      const next = await athenaApi<AthenaProject>(`/projects/${project.id}/command`,
        { version: current.version, action: 'self_absorption', group_ids: [activeId], options: current.options })
      if (committed.current !== key) throw new Error('The workspace changed while saving. Reload the project to see the corrected group.')
      saved(next); close()
    } catch (reason) {
      setPreview(null); setError(reason instanceof Error ? reason.message : 'Could not save the corrected group. Preview again.')
    } finally { saving.current = false; setBusy('') }
  }

  const result = current?.results[0]
  const arrays = group?.result?.arrays ?? {}
  const depthView = view === 'depth' && !!result?.information_depth_um
  const corrected = current?.options.algorithm === 'booth' && current.options.thickness !== undefined
    ? `Corrected · Booth slab ${current.options.thickness} µm` : 'Corrected · thick sample (FLUO)'
  const traces = depthView
    ? [{ name: 'Probing depth', x: result!.energy, y: result!.information_depth_um!, color: '#5a6f9b' }]
    : result ? [{ name: 'Measured', x: result.energy, y: result.measured, color: '#16736b' },
                { name: corrected, x: result.energy, y: result.corrected, color: '#bb6542' }]
      : arrays.energy?.length && arrays.norm?.length ? [{ name: group!.label, x: arrays.energy, y: arrays.norm, color: '#16736b' }] : []
  // The entered thickness on the depth plot, so slab against probing depth is
  // the one comparison the eye makes.
  const slab = depthView ? current?.options.thickness : undefined
  const normalization = result?.normalization
  return <div className="ath-modal-body">
    <p>Fluorescence self-absorption flattens a spectrum because the sample re-absorbs its own emission. Correct it either with Larch’s thick-sample approximation or, for a sample too thin for that, with the Booth finite-thickness slab model. Give the composition, geometry and, for the slab, the thickness and density.</p>
    <div className={styles.layout}>
      <fieldset className={styles.controls} disabled={disabled}>
        <label className="ath-field"><span>Source group <SectionHelp label="Source group">Choose a processed fluorescence absorption group. The correction uses its saved normalized spectrum and creates a new group when accepted.</SectionHelp></span><select aria-label="Source group" value={activeId} onChange={e => selectGroup(e.target.value)}>{project.groups.map(g => <option key={g.id} value={g.id}>{g.label}{g.frozen ? ' · frozen' : ''}</option>)}</select></label>
        <label className="ath-field"><span>Correction <SectionHelp label="Correction">Use the thick-sample approximation for a sufficiently thick sample, or the Booth slab model with explicit thickness and density for finite thickness.</SectionHelp></span><select aria-label="Correction" value={draft.algorithm} onChange={e => setDraft(d => ({ ...d, algorithm: e.target.value as Algorithm }))}><option value="fluo">Thick sample (Larch FLUO)</option><option value="booth">Finite thickness (Booth slab)</option></select></label>
        {([['formula', 'Sample formula', 'Fe2O3'], ['element', 'Absorbing element', 'Fe'], ['edge', 'Absorption edge', 'K']] as const).map(([field, label, placeholder]) =>
          <label className="ath-field" key={field}><span>{label} <SectionHelp label={label}>{({formula: "Enter the complete chemical composition, including the matrix, for example Fe2O3. Tabulated attenuation depends on the whole sample composition.", element: "Enter the absorbing element’s chemical symbol. It must occur in the sample formula.", edge: "Enter the absorption edge code, such as K or L3, corresponding to the measured spectrum."})[field]}</SectionHelp></span><input value={draft[field]} placeholder={placeholder} onChange={e => setDraft(d => ({ ...d, [field]: e.target.value }))} /></label>)}
        <div className="ath-fields">{([['angle_in', 'Incident angle'], ['angle_out', 'Exit angle']] as const).map(([field, label]) =>
          <label className="ath-field" key={field}><span>{label} (degrees) <SectionHelp label={label}>{field === "angle_in" ? "Angle of the incoming beam measured from the sample surface, between 0.1° and 90°. Grazing incidence lengthens the path through the sample." : "Angle of the detected fluorescence measured from the sample surface, between 0.1° and 90°. This controls its exit path through the sample."}</SectionHelp></span><input type="number" min="0.1" max="90" step="any" value={draft[field]} onChange={e => setDraft(d => ({ ...d, [field]: e.target.value }))} /></label>)}</div>
        <div className="ath-fields">
          <label className="ath-field"><span>Thickness (µm){needsSlab ? '' : ' — optional'} <SectionHelp label="Sample thickness">Physical slab thickness in micrometres. The finite-thickness model requires a positive value; the thickness-density product sets the amount of material in the beam path.</SectionHelp></span><input type="number" min="0" step="any" value={draft.thickness} onChange={e => setDraft(d => ({ ...d, thickness: e.target.value }))} /></label>
          <label className="ath-field"><span>Density (g/cm³){needsSlab ? '' : ' — optional'} <SectionHelp label="Sample density">Mass density in g/cm³, including packing fraction where appropriate. Required for finite-thickness correction; in the thick-sample model it only sets the reported probing depth.</SectionHelp></span><input type="number" min="0" step="any" value={draft.density} onChange={e => setDraft(d => ({ ...d, density: e.target.value }))} /></label>
        </div>
        <p className="ath-hint">Angles are measured from the sample surface. Only the product of density and thickness enters the physics, so either may carry a packing fraction for a pressed pellet. Under the thick-sample correction the density changes nothing; it only reports the depth the signal came from.</p>
        <p className="ath-hint">Attenuation is taken from tabulated values just below and above the edge and at the fluorescence line, as Larch does. The correction starts from the group&apos;s own normalized curve — its E₀, pre-edge and post-edge ranges and polynomial degree, shown under the plot. Saving makes a new group holding the corrected normalized spectrum, stored as already-normalized data and not renormalized; it is not a corrected raw fluorescence yield.</p>
      </fieldset>
      <section className={styles.results} aria-label="Self-absorption preview results">
        <div className={styles.views}>
          <button disabled={disabled} aria-pressed={view === 'spectrum'} onClick={() => setView('spectrum')}>Corrected spectrum</button>
          <button disabled={disabled || !result?.information_depth_um} aria-pressed={depthView} onClick={() => setView('depth')}>Probing depth</button>
        </div>
        <div className={styles.plot} aria-label={depthView ? 'Probing depth preview' : 'Corrected spectrum preview'}>{traces.length ? <Plot
          data={traces.map(t => ({ x: t.x.slice(), y: t.y.slice(), name: t.name, type: 'scatter', mode: 'lines', line: { color: t.color, width: 1.8 } }))}
          layout={{ autosize: true, margin: { l: 65, r: 18, t: 75, b: 55 }, hovermode: 'closest',
            legend: { orientation: 'h', x: 0, y: 1.04, yanchor: 'bottom' },
            xaxis: { title: { text: 'Energy (eV)' } },
            yaxis: depthView
              ? { title: { text: 'Probing depth 1/(μ_in/sin θ_in + μ_f/sin θ_out) (µm)' }, automargin: true, rangemode: 'tozero' }
              : { title: { text: 'Normalized μ(E)' }, automargin: true },
            shapes: slab === undefined ? [] : [{ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: slab, y1: slab,
              line: { color: '#bb6542', width: 1.5, dash: 'dash' } }],
            annotations: slab === undefined ? [] : [{ xref: 'paper', x: 1, xanchor: 'right', yref: 'y', y: slab, yanchor: 'bottom',
              text: `sample thickness ${slab} µm`, showarrow: false }],
            uirevision: `${project.id}:${activeId}:${view}` }}
          config={{ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'], toImageButtonOptions: { format: 'svg', filename: 'athena-self-absorption' } }}
          style={{ width: '100%', height: '100%' }} useResizeHandler /> : <p>No curve is available for this group.</p>}</div>
        {!eligible ? <p role="status">Choose a processed absorption spectrum.</p>
          : !composed ? <p role="status">Enter the sample formula, absorbing element and edge.</p>
          : !anglesValid ? <p role="status">Enter incident and exit angles between 0.1 and 90 degrees from the sample surface.</p>
          : !extrasValid ? <p role="status">Thickness and density must be positive.</p>
          : needsSlab && (thickness === undefined || density === undefined) ? <p role="status">The finite-thickness correction needs both the thickness and the density.</p>
          : <p role="status">{loading ? 'Calculating the correction…' : current ? `Preview at project revision ${current.version}` : 'Waiting for a current preview…'}</p>}
        {normalization && <p className="ath-hint">Normalization from the group: E₀ {normalization.e0.toFixed(1)} eV, pre-edge {normalization.pre1.toFixed(0)} to {normalization.pre2.toFixed(0)} eV, post-edge {normalization.norm1.toFixed(0)} to {normalization.norm2.toFixed(0)} eV, polynomial degree {normalization.nnorm}{normalization.step != null ? `, edge step fixed at ${normalization.step.toPrecision(4)}` : ''}{normalization.nvict ? `, pre-edge energy exponent ${normalization.nvict}` : ''}. “Measured” is that normalized curve.</p>}
        {result && <p className="ath-hint">{applicability(result, draft.algorithm)}</p>}
        {error && <div className="ath-error" role="alert">{error}</div>}
      </section>
    </div>
    <div className={`ath-modal-actions ${styles.actions}`}><button disabled={disabled} onClick={close}>Close correction tool</button><button disabled={disabled || !canCalculate || loading} onClick={() => { setPreview(null); setRetry(v => v + 1) }}>Preview again</button><button className="ath-primary" disabled={disabled || !current || loading} onClick={() => { void save() }}>Make group from corrected data</button></div>
  </div>
}
