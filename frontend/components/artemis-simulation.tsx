"use client"

import { useEffect, useRef, useState } from "react"
import { artemisApi, type ArtemisTransform } from "@/lib/artemis"
import type { ArtemisFeffJob } from "@/lib/artemis-structures"
import { simulationDefaults, simulationRequest, validSimulation, type SimulationFields, type SimulationResult } from "@/lib/artemis-simulation"
import { ArtemisSimulationViewer } from "./artefact-viewers/artemis-simulation-viewer"
import { SectionHelp } from "./section-help"
import styles from "./artemis-structures.module.css"

const fields: [keyof SimulationFields, string][] = [["s02", "S₀²"], ["sigma2", "σ² (Å²)"], ["e0", "ΔE₀ (eV)"], ["deltar", "ΔR (Å)"], ["kmin", "FT k min (Å⁻¹)"], ["kmax", "FT k max (Å⁻¹)"], ["dk", "FT dk (Å⁻¹)"]]

export function ArtemisSimulation({ job, selectedIds, disabled }: { job: ArtemisFeffJob; selectedIds: string[]; disabled: boolean }) {
  const [values, setValues] = useState({ ...simulationDefaults })
  const [weight, setWeight] = useState(2)
  const [window, setWindow] = useState<ArtemisTransform["window"]>("hanning")
  const [selection, setSelection] = useState("all")
  const [state, setState] = useState<{ key: string; result?: SimulationResult; error?: string; loading?: boolean } | null>(null)
  const abort = useRef<AbortController | null>(null)
  let request: ReturnType<typeof simulationRequest> | null = null, validation = ""
  try { request = simulationRequest(values, weight, window, selection === "all" ? null : selectedIds) } catch (error) { validation = (error as Error).message }
  const key = JSON.stringify([job.id, values, weight, window, selection, selection === "all" ? null : selectedIds])
  useEffect(() => { setState(null); return () => abort.current?.abort() }, [key])
  const current = state?.key === key ? state : null
  async function simulate() {
    if (!request || disabled || current?.loading) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setState({ key, loading: true })
    try {
      const result = await artemisApi<SimulationResult>(`/feff/jobs/${encodeURIComponent(job.id)}/simulate`, request, controller.signal)
      if (controller.signal.aborted) return
      if (!validSimulation(result, job, request)) throw new Error("The simulation curves do not match this FEFF calculation. Please retry.")
      setState({ key, result })
    } catch (error) {
      if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "EXAFS simulation failed." })
    }
  }
  return <section className={styles.simulation} aria-label="EXAFS simulation from CIF">
    <h4>Simulate EXAFS<SectionHelp label="EXAFS simulation assumptions">No measured spectrum is required. One absorbing site is simulated, with FEFF degeneracies and shared S₀², ΔE₀, ΔR and σ². The default σ² = 0.003 Å² is an assumption, not inferred from CIF displacement factors or temperature. Inequivalent sites are not averaged.</SectionHelp></h4>
    <p className={styles.help}>{job.request.absorber} {job.request.edge} · site {job.request.site_index} · {job.paths.length} available paths{job.truncated ? ` of ${job.total_paths} generated` : ""} · shared σ² assumption</p>
    <div className={styles.grid}>
      <label>Simulation paths<select aria-label="Simulation paths" value={selection} onChange={event => setSelection(event.target.value)} disabled={disabled}>
        <option value="all">All available paths ({job.paths.length})</option><option value="selected">Selected paths ({selectedIds.length})</option>
      </select></label>
      {fields.map(([key, label]) => <label key={key}>{label}<input aria-label={`Simulation ${label}`} inputMode="decimal" value={values[key]} disabled={disabled} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
      <label>FT k-weight<select aria-label="Simulation k-weight" value={weight} disabled={disabled} onChange={event => setWeight(Number(event.target.value))}>{[0, 1, 2, 3].map(item => <option key={item}>{item}</option>)}</select></label>
      <label>FT window<select aria-label="Simulation window" value={window} disabled={disabled} onChange={event => setWindow(event.target.value as ArtemisTransform["window"])}>{["hanning", "kaiser", "parzen", "welch"].map(item => <option key={item}>{item}</option>)}</select></label>
    </div>
    {validation && <p className={styles.warning} role="status">{validation}</p>}
    <button type="button" className={styles.primaryButton} disabled={disabled || !request || current?.loading} onClick={() => void simulate()}>{current?.loading ? "Simulating EXAFS…" : current?.error ? "Retry EXAFS simulation" : "Run EXAFS simulation"}</button>
    {current?.error && <p className={styles.error} role="alert">{current.error}</p>}
    {current?.result && <>
      <p className={styles.status} role="status">Simulation complete · {current.result.paths.length} path{current.result.paths.length === 1 ? "" : "s"} · no measured spectrum or fit</p>
      {current.result.warnings.map((warning, i) => <p key={i} className={styles.warning}>{warning}</p>)}
      <ArtemisSimulationViewer result={current.result} />
    </>}
  </section>
}
