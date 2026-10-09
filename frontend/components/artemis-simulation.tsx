"use client"

import { useEffect, useRef, useState } from "react"
import { artemisApi, type ArtemisTransform } from "@/lib/artemis"
import { ApiRequestError } from "@/lib/backend-client"
import { sameFeffRequest, type ArtemisFeffJob, type ArtemisFeffRequest } from "@/lib/artemis-structures"
import { simulationDefaults, simulationLimits, simulationRequest, validSimulation, type SimulationFields, type SimulationResult } from "@/lib/artemis-simulation"
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

export function ArtemisSimulation({ feffRequest, disabled, onAddToDataList }: {
  feffRequest: ArtemisFeffRequest | null; disabled: boolean
  onAddToDataList?: (result: SimulationResult, idempotencyKey: string) => Promise<void>
}) {
  const [values, setValues] = useState({ ...simulationDefaults })
  const [weight, setWeight] = useState(2)
  const [window, setWindow] = useState<ArtemisTransform["window"]>("hanning")
  const [state, setState] = useState<{ key: string; result?: SimulationResult; error?: string; loading?: boolean; progress?: string; addKey?: string } | null>(null)
  const [addition, setAddition] = useState<{ key: string; pending?: boolean; added?: boolean; error?: string } | null>(null)
  const adding = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const calculation = useRef<{ controller: AbortController; request: ArtemisFeffRequest; pending: Promise<ArtemisFeffJob>; job?: ArtemisFeffJob } | null>(null)
  let request: ReturnType<typeof simulationRequest> | null = null, validation = ""
  try { request = simulationRequest(values, weight, window, null) } catch (error) { validation = (error as Error).message }
  // Saving a spectrum changes the project version, not this simulation.
  const feffKey = JSON.stringify(feffRequest && { ...feffRequest, version: undefined })
  const key = JSON.stringify([feffKey, values, weight, window])
  useEffect(() => {
    calculation.current = null
    return () => calculation.current?.controller.abort()
  }, [feffKey])
  useEffect(() => { setState(null); setAddition(null); return () => abort.current?.abort() }, [key])
  const current = state?.key === key ? state : null
  const addState = addition?.key === current?.addKey ? addition : null
  const controlsDisabled = disabled || !!addState?.pending
  async function simulate() {
    if (!request || !feffRequest || controlsDisabled || current?.loading) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setAddition(null)
    setState({ key, loading: true, progress: "Preparing scattering calculation…" })
    // Scalar edits cancel the displayed simulation, but reuse its native job.
    // Keep even the creation promise so an edit during POST cannot start duplicates.
    if (!calculation.current) {
      const jobController = new AbortController()
      calculation.current = { controller: jobController, request: feffRequest, pending: artemisApi<ArtemisFeffJob>("/feff/jobs", feffRequest, jobController.signal) }
    }
    const activeCalculation = calculation.current
    let reconnect = false
    try {
      let job = activeCalculation.job ?? await activeCalculation.pending
      activeCalculation.job = job
      if (controller.signal.aborted) return
      if (!sameFeffRequest(job.request, activeCalculation.request)) throw new Error("The scattering calculation does not match these simulation settings. Please retry.")
      const jobId = job.id
      reconnect = job.status === "running"
      while (job.status === "running") {
        setState({ key, loading: true, progress: "Calculating scattering paths…" })
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve() }
          const timer = setTimeout(finish, 1200)
          controller.signal.addEventListener("abort", finish, { once: true })
        })
        if (controller.signal.aborted) return
        job = await artemisApi<ArtemisFeffJob>(`/feff/jobs/${encodeURIComponent(jobId)}`, undefined, controller.signal)
        if (controller.signal.aborted) return
        if (job.id !== jobId || !sameFeffRequest(job.request, activeCalculation.request)) {
          reconnect = false
          throw new Error("The scattering calculation does not match these simulation settings. Please retry.")
        }
        activeCalculation.job = job
      }
      reconnect = false
      if (job.status !== "complete") throw new Error(job.message || "The scattering calculation failed. Please retry.")
      if (job.truncated || job.paths.length !== job.total_paths) throw new Error("The scattering calculation returned only some paths. Retry to simulate the complete path set.")
      setState({ key, loading: true, progress: "Calculating EXAFS…" })
      const result = await artemisApi<SimulationResult>(`/feff/jobs/${encodeURIComponent(job.id)}/simulate`, request, controller.signal)
      if (controller.signal.aborted) return
      if (!validSimulation(result, job, request)) throw new Error("The simulation curves do not match this FEFF calculation. Please retry.")
      const addKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")
      setState({ key, result, addKey })
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 400 && error.fields.includes("job"))) reconnect = false
      if ((!controller.signal.aborted || !activeCalculation.job) && !reconnect && calculation.current === activeCalculation) calculation.current = null
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
    <p className={styles.help}>All generated paths within the maximum R are included automatically, with single and multiple scattering up to four legs.</p>
    <div className={styles.grid}>
      {fields.map(([key, label, help]) => <label key={key}><span>{label}<SectionHelp label={`Simulation ${label}`}>{help} Supported values: {simulationLimits[key].min}–{simulationLimits[key].max}.</SectionHelp></span><input aria-label={`Simulation ${label}`} type="number" {...simulationLimits[key]} inputMode="decimal" value={values[key]} disabled={controlsDisabled} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
      <label><span>FT k-weight<SectionHelp label="Simulation k-weight">Power of k multiplying χ(k) before Fourier transformation and in the weighted k plot. Higher powers emphasize high-k oscillations.</SectionHelp></span><select aria-label="Simulation k-weight" value={weight} disabled={controlsDisabled} onChange={event => setWeight(Number(event.target.value))}>{[0, 1, 2, 3].map(item => <option key={item}>{item}</option>)}</select></label>
      <label><span>FT window<SectionHelp label="Simulation window">Taper shape used over the chosen k interval. Window shape affects Fourier peak width and ringing, not the underlying FEFF paths.</SectionHelp></span><select aria-label="Simulation window" value={window} disabled={controlsDisabled} onChange={event => setWindow(event.target.value as ArtemisTransform["window"])}>{["hanning", "kaiser", "parzen", "welch"].map(item => <option key={item}>{item}</option>)}</select></label>
    </div>
    {validation && <p className={styles.warning} role="status">{validation}</p>}
    <button type="button" className={styles.primaryButton} disabled={controlsDisabled || !feffRequest || !request || current?.loading} onClick={() => void simulate()}>{current?.loading ? "Simulating EXAFS…" : current?.error ? "Retry EXAFS simulation" : "Run EXAFS simulation"}</button>
    {current?.loading && <p className={styles.status} role="status">{current.progress}</p>}
    {current?.error && <p className={styles.error} role="alert">{current.error}</p>}
    {current?.result && <>
      <p className={styles.status} role="status">Simulation complete · {current.result.paths.length} path{current.result.paths.length === 1 ? "" : "s"} · no measured spectrum or fit</p>
      {current.result.warnings.map((warning, i) => <p key={i} className={styles.warning}>{warning}</p>)}
      <ArtemisSimulationViewer result={current.result} actions={onAddToDataList && <>
        <button type="button" className={styles.primaryButton} disabled={controlsDisabled || addState?.added} onClick={() => void addToDataList()}>{addState?.pending ? "Adding spectrum…" : addState?.added ? "Added to data list" : "Add to data list"}</button>
        <SectionHelp label="Add simulated spectrum">Save the unweighted χ(k) spectrum in this project with a theory tag, its Fourier parameters, and the exact CIF and FEFF sources. It can be plotted alongside measured spectra, saved with the project, and removed with Undo.</SectionHelp>
        {addState?.added && <span className={styles.status} role="status">Spectrum added · theory</span>}
      </>} />
      {addState?.error && <p className={styles.error} role="alert">{addState.error}</p>}
    </>}
  </section>
}
