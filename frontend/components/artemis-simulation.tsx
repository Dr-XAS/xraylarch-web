"use client"

import { useEffect, useRef, useState } from "react"
import { artemisApi, type ArtemisTransform } from "@/lib/artemis"
import type { ArtemisFeffJob } from "@/lib/artemis-structures"
import { simulationDefaults, simulationRequest, validSimulation, type SimulationFields, type SimulationResult } from "@/lib/artemis-simulation"
import { ArtemisSimulationViewer } from "./artefact-viewers/artemis-simulation-viewer"
import { SectionHelp } from "./section-help"
import styles from "./artemis-structures.module.css"

const fields: [keyof SimulationFields, string, string][] = [
  ["s02", "S₀²", "Dimensionless amplitude reduction factor shared by every path. FEFF degeneracies are already included; this value is an assumption unless calibrated from a reference."],
  ["sigma2", "σ² (Å²)", "Shared mean-square relative displacement, damping each path by exp(−2k²σ²). It is not derived from CIF displacement factors; different shells can have different disorder."],
  ["e0", "ΔE₀ (eV)", "Shared energy correction relative to the FEFF calculation, in eV. It changes the phase of χ(k); zero keeps the FEFF energy reference."],
  ["deltar", "ΔR (Å)", "Shared change to each path’s effective half-path length. Zero uses the CIF geometry; a nonzero value shifts every included path by the same amount."],
  ["kmin", "FT k min (Å⁻¹)", "Lower wavenumber limit for the Fourier transform. It changes χ(R), while the calculated χ(k) remains available over its FEFF support."],
  ["kmax", "FT k max (Å⁻¹)", "Upper wavenumber limit for the Fourier transform, up to 20 Å⁻¹. Use a range supported by the FEFF paths and at least 1 Å⁻¹ wider than the lower limit."],
  ["dk", "FT dk (Å⁻¹)", "Width of the smooth taper at the k-window edges. Increasing it reduces abrupt-edge ringing in χ(R)."],
]

export function ArtemisSimulation({ job, selectedIds, disabled, onAddToDataList }: {
  job: ArtemisFeffJob; selectedIds: string[]; disabled: boolean
  onAddToDataList?: (result: SimulationResult, idempotencyKey: string) => Promise<void>
}) {
  const [values, setValues] = useState({ ...simulationDefaults })
  const [weight, setWeight] = useState(2)
  const [window, setWindow] = useState<ArtemisTransform["window"]>("hanning")
  const [selection, setSelection] = useState("all")
  const [state, setState] = useState<{ key: string; result?: SimulationResult; error?: string; loading?: boolean; addKey?: string } | null>(null)
  const [addition, setAddition] = useState<{ key: string; pending?: boolean; added?: boolean; error?: string } | null>(null)
  const adding = useRef(false)
  const abort = useRef<AbortController | null>(null)
  let request: ReturnType<typeof simulationRequest> | null = null, validation = ""
  try { request = simulationRequest(values, weight, window, selection === "all" ? null : selectedIds) } catch (error) { validation = (error as Error).message }
  const key = JSON.stringify([job.id, values, weight, window, selection, selection === "all" ? null : selectedIds])
  useEffect(() => { setState(null); setAddition(null); return () => abort.current?.abort() }, [key])
  const current = state?.key === key ? state : null
  const addState = addition?.key === current?.addKey ? addition : null
  const controlsDisabled = disabled || !!addState?.pending
  async function simulate() {
    if (!request || controlsDisabled || current?.loading) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setAddition(null)
    setState({ key, loading: true })
    try {
      const result = await artemisApi<SimulationResult>(`/feff/jobs/${encodeURIComponent(job.id)}/simulate`, request, controller.signal)
      if (controller.signal.aborted) return
      if (!validSimulation(result, job, request)) throw new Error("The simulation curves do not match this FEFF calculation. Please retry.")
      const addKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")
      setState({ key, result, addKey })
    } catch (error) {
      if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "EXAFS simulation failed." })
    }
  }
  async function addToDataList() {
    if (!current?.result || !current.addKey || !onAddToDataList || controlsDisabled || adding.current || addState?.added) return
    const result = current.result, addKey = current.addKey
    adding.current = true
    setAddition({ key: addKey, pending: true })
    try {
      await onAddToDataList(result, addKey)
      setAddition({ key: addKey, added: true })
    } catch (error) {
      setAddition({ key: addKey, error: error instanceof Error ? error.message : "Could not add the simulated spectrum. Please retry." })
    } finally { adding.current = false }
  }
  return <section className={styles.simulation} aria-label="EXAFS simulation from CIF">
    <h4>Simulate EXAFS<SectionHelp label="EXAFS simulation assumptions">No measured spectrum is required. One absorbing site is simulated, with FEFF degeneracies and shared S₀², ΔE₀, ΔR and σ². The default σ² = 0.003 Å² is an assumption, not inferred from CIF displacement factors or temperature. Inequivalent sites are not averaged.</SectionHelp></h4>
    <p className={styles.help}>{job.request.absorber} {job.request.edge} · site {job.request.site_index} · {job.paths.length} available paths{job.truncated ? ` of ${job.total_paths} generated` : ""} · shared σ² assumption</p>
    <div className={styles.grid}>
      <label><span>Simulation paths<SectionHelp label="Simulation paths">Sum all paths available in this job, or only those checked in the generated-path list. A truncated job does not contain every path FEFF generated.</SectionHelp></span><select aria-label="Simulation paths" value={selection} onChange={event => setSelection(event.target.value)} disabled={controlsDisabled}>
        <option value="all">All available paths ({job.paths.length})</option><option value="selected">Selected paths ({selectedIds.length})</option>
      </select></label>
      {fields.map(([key, label, help]) => <label key={key}><span>{label}<SectionHelp label={`Simulation ${label}`}>{help}</SectionHelp></span><input aria-label={`Simulation ${label}`} inputMode="decimal" value={values[key]} disabled={controlsDisabled} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
      <label><span>FT k-weight<SectionHelp label="Simulation k-weight">Power of k multiplying χ(k) before Fourier transformation and in the weighted k plot. Higher powers emphasize high-k oscillations.</SectionHelp></span><select aria-label="Simulation k-weight" value={weight} disabled={controlsDisabled} onChange={event => setWeight(Number(event.target.value))}>{[0, 1, 2, 3].map(item => <option key={item}>{item}</option>)}</select></label>
      <label><span>FT window<SectionHelp label="Simulation window">Taper shape used over the chosen k interval. Window shape affects Fourier peak width and ringing, not the underlying FEFF paths.</SectionHelp></span><select aria-label="Simulation window" value={window} disabled={controlsDisabled} onChange={event => setWindow(event.target.value as ArtemisTransform["window"])}>{["hanning", "kaiser", "parzen", "welch"].map(item => <option key={item}>{item}</option>)}</select></label>
    </div>
    {validation && <p className={styles.warning} role="status">{validation}</p>}
    <button type="button" className={styles.primaryButton} disabled={controlsDisabled || !request || current?.loading} onClick={() => void simulate()}>{current?.loading ? "Simulating EXAFS…" : current?.error ? "Retry EXAFS simulation" : "Run EXAFS simulation"}</button>
    {current?.error && <p className={styles.error} role="alert">{current.error}</p>}
    {current?.result && <>
      <p className={styles.status} role="status">Simulation complete · {current.result.paths.length} path{current.result.paths.length === 1 ? "" : "s"} · no measured spectrum or fit</p>
      {onAddToDataList && <div className={styles.toolbar}>
        <button type="button" className={styles.primaryButton} disabled={controlsDisabled || addState?.added} onClick={() => void addToDataList()}>{addState?.pending ? "Adding spectrum…" : addState?.added ? "Added to data list" : "Add to data list"}</button>
        <SectionHelp label="Add simulated spectrum">Save the unweighted χ(k) spectrum in this project with a theory tag, its Fourier parameters, and the exact CIF and FEFF sources. It can be plotted alongside measured spectra, saved with the project, and removed with Undo.</SectionHelp>
        {addState?.added && <span className={styles.status} role="status">Spectrum added · theory</span>}
      </div>}
      {addState?.error && <p className={styles.error} role="alert">{addState.error}</p>}
      {current.result.warnings.map((warning, i) => <p key={i} className={styles.warning}>{warning}</p>)}
      <ArtemisSimulationViewer result={current.result} />
    </>}
  </section>
}
