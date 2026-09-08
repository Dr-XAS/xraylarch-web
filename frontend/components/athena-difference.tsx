"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { athenaApi, type AthenaProject, type DifferenceForm, type DifferenceOptions, type DifferencePreview, type DifferenceResult } from "@/lib/athena"
import { ApiRequestError } from "@/lib/backend-client"
import { AthenaDifferencePlot, type DifferenceView } from "./athena-difference-plot"
import styles from "./athena-difference.module.css"

const forms: Record<DifferenceForm, string> = {
  xmu: "μ(E)", norm: "Normalized μ(E)", der: "Derivative μ(E)",
  nder: "Derivative of normalized μ(E)", sec: "Second derivative μ(E)", nsec: "Second derivative of normalized μ(E)",
}
type Draft = Omit<DifferenceOptions, "multiplier" | "xmin" | "xmax" | "plot_space"> & { multiplier: string; xmin: string; xmax: string }
const defaults: Draft = { standard_id: "", form: "norm", multiplier: "1", invert: false, plot_inputs: true,
  integrate: true, xmin: "-20", xmax: "30", renormalize: false, name_template: "diff %d - %s" }
type Snapshot = { intent: string; projectId: string; groupIds: string[]; response: DifferencePreview }
type BoundPick = { bound: "xmin" | "xmax"; generation: number }

function validInputK(result: DifferenceResult, options: DifferenceOptions) {
  const inputs = result.input_k
  if (inputs === undefined) return true // Older previews omit input curves.
  if (!Array.isArray(inputs) || inputs.length !== (options.plot_space === "k" ? 2 : 0)) return false
  return new Set(inputs.map(input => input?.role)).size === inputs.length && inputs.every(input => input
    && (input.role === "DATA" ? input.group_id === result.group_id : input.role === "STANDARD" && input.group_id === options.standard_id)
    && typeof input.group_id === "string" && typeof input.label === "string"
    && (input.error === null || typeof input.error === "string")
    && (input.kweight === null || (typeof input.kweight === "number" && Number.isFinite(input.kweight)))
    && Array.isArray(input.k) && Array.isArray(input.weighted_chi) && input.k.length === input.weighted_chi.length
    && [...input.k, ...input.weighted_chi].every(value => typeof value === "number" && Number.isFinite(value)))
}

function checkPreview(response: DifferencePreview, version: number, ids: string[], options: DifferenceOptions) {
  if (!response || response.version !== version || (Object.keys(options) as (keyof DifferenceOptions)[]).some(key => response.options?.[key] !== options[key])) {
    throw new Error("The preview does not match the requested version or options. Preview again.")
  }
  if (!Array.isArray(response.results) || response.results.length !== ids.length || response.results.some((result, index) => {
    const arrays = [result.energy, result.difference, result.data, result.standard]
    return result.group_id !== ids[index] || result.form !== options.form || !Array.isArray(result.energy) || !result.energy.length
      || arrays.some(array => !Array.isArray(array) || array.length !== result.energy.length || array.some(value => !Number.isFinite(value)))
      || (result.area !== null && !Number.isFinite(result.area)) || (result.e0 !== null && !Number.isFinite(result.e0))
      || !Array.isArray(result.warnings) || typeof result.label !== "string"
      || !validInputK(result, options)
      || (options.plot_space === "k" && (!Array.isArray(result.k) || !Array.isArray(result.weighted_chi) || result.k.length !== result.weighted_chi.length
        || [...result.k, ...result.weighted_chi].some(value => !Number.isFinite(value))))
  })) throw new Error("The preview returned incomplete or mismatched spectra. Preview again.")
}

function downloadReport(snapshot: Snapshot, format: "json" | "csv") {
  const response = snapshot.response
  // Quote text fields (including labels with commas, quotes, or newlines).
  const csv = (value: unknown) => typeof value === "string" ? `"${value.replaceAll('"', '""')}"` : value == null ? "" : String(value)
  const rows: unknown[][] = [["group_id", "label", "form", "energy_eV", "difference", "data", "scaled_standard", "area", "e0_eV"]]
  for (const result of response.results) result.energy.forEach((energy, index) => rows.push([result.group_id, result.label, result.form, energy, result.difference[index], result.data[index], result.standard[index], result.area, result.e0]))
  const text = format === "json" ? JSON.stringify({ project_id: snapshot.projectId, group_ids: snapshot.groupIds, ...response }, null, 2) : rows.map(row => row.map(csv).join(",")).join("\r\n")
  const url = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url; link.download = `athena-difference-preview.${format}`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function AthenaDifferenceDialog({ project, activeId, getProject, selectData, onSaved, onBusyChange, close, disabled = false }: {
  project: AthenaProject; activeId: string; getProject: () => AthenaProject | null
  selectData: (id: string) => void; onSaved: (project: AthenaProject) => void
  onBusyChange: (busy: string) => void; close: () => void; disabled?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0), saving = useRef(false)
  const [draft, setDraft] = useState<Draft>({ ...defaults })
  const [scope, setScope] = useState<"current" | "marked">("current")
  const [view, setView] = useState<DifferenceView>("E")
  const [preview, setPreview] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false), [saveBusy, setSaveBusy] = useState(false)
  const [error, setError] = useState("")
  const [pick, setPick] = useState<BoundPick | null>(null)
  const active = project.groups.find(group => group.id === activeId)
  const standard = project.groups.find(group => group.id === draft.standard_id)
  const targets = (scope === "current" ? active ? [active] : [] : project.groups.filter(group => group.marked)).filter(group => group.id !== draft.standard_id)
  const targetIds = targets.map(group => group.id)
  const plotSpace = view === "k" ? "k" : "E"
  const intent = JSON.stringify([project.id, project.version, activeId, targetIds, scope, draft, plotSpace])
  const committedIntent = useRef(intent)
  const committedPick = useRef<{ intent: string; view: DifferenceView; pick: BoundPick | null } | null>(null)
  const locked = disabled || saveBusy
  const ready = !!standard && standard.data_type !== "chi" && !!targets.length && targets.every(group => group.data_type !== "chi")
  const current = preview?.intent === intent && preview.response.version === project.version ? preview : null
  const inputKWarnings = [...new Map((current?.response.results ?? []).flatMap(result => result.input_k ?? []).filter(input => input.error)
    .map(input => [JSON.stringify([input.role, input.group_id, input.error]), input])).values()]
  const labels = Object.fromEntries(project.groups.map(group => [group.id, group.label]))
  const single = scope === "current" && current?.response.results.length === 1 ? current.response.results[0] : null
  const canPick = !!single && single.e0 !== null && Number.isFinite(single.e0) && draft.integrate && view === "E" && !locked && !loading

  // Commit context before async callbacks run. Never compare an old effect's
  // context with live picker state from a newer render.
  useLayoutEffect(() => {
    committedIntent.current = intent; generation.current++
    setPreview(null); setLoading(false); setPick(null); setError("")
  }, [intent])
  useLayoutEffect(() => { committedPick.current = { intent, view, pick } }, [intent, view, pick])
  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => { generation.current++; committedPick.current = null; node?.close() }
  }, [])
  function stillCurrent(key: string, id: string, version: number) {
    const latest = getProject()
    return committedIntent.current === key && latest?.id === id && latest.version === version
  }
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(previous => ({ ...previous, [key]: value })) }
  function changeView(next: DifferenceView) { setPick(null); setView(next) }
  function dismiss() { if (!locked && !saving.current) { generation.current++; close() } }
  async function runPreview() {
    if (locked || !ready || loading) return
    setError(""); setPreview(null); setPick(null)
    const options: DifferenceOptions = { ...draft, multiplier: Number(draft.multiplier), xmin: Number(draft.xmin), xmax: Number(draft.xmax), plot_space: plotSpace }
    if (!draft.multiplier.trim() || !Number.isFinite(options.multiplier)) { setError("Enter a finite standard multiplier."); return }
    if (![draft.xmin, draft.xmax].every(value => value.trim() && Number.isFinite(Number(value))) || (draft.integrate && options.xmin >= options.xmax)) { setError("Enter finite integration bounds with the minimum below the maximum."); return }
    if (!draft.name_template.trim() || draft.name_template.length > 200) { setError("Enter a name template of 1–200 characters for the difference groups."); return }
    if (!stillCurrent(intent, project.id, project.version)) { setError("The project changed. Wait for the current project and preview again."); return }
    const token = ++generation.current
    setLoading(true)
    try {
      const response = await athenaApi<DifferencePreview>(`/projects/${project.id}/difference/preview`, { version: project.version, action: "difference", group_ids: targetIds, options })
      if (token !== generation.current || !stillCurrent(intent, project.id, project.version)) return
      checkPreview(response, project.version, targetIds, options)
      // Snapshot server-resolved options, not the subsequently editable fields.
      setPreview({ intent, projectId: project.id, groupIds: [...targetIds], response: structuredClone(response) })
    } catch (reason) {
      if (token === generation.current && stillCurrent(intent, project.id, project.version)) setError(reason instanceof Error ? reason.message : "Difference preview failed. Try again.")
    } finally { if (token === generation.current) setLoading(false) }
  }
  async function save() {
    if (locked || saving.current || !current) return
    if (!stillCurrent(current.intent, current.projectId, current.response.version)) { setPreview(null); setError("The project changed after this preview. Preview again before saving."); return }
    saving.current = true; setSaveBusy(true); setPick(null); setError("")
    onBusyChange("Saving difference groups")
    try {
      const next = await athenaApi<AthenaProject>(`/projects/${current.projectId}/command`, { version: current.response.version, action: "difference", group_ids: current.groupIds, options: current.response.options })
      if (!stillCurrent(current.intent, current.projectId, current.response.version)) { setPreview(null); throw new Error("The workspace changed while saving. Reload the project to see the saved difference groups.") }
      onSaved(next); close()
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 409) {
        setPreview(null)
        setError(`${reason.message} Reload the project, then preview again before saving.`)
      } else setError(reason instanceof Error ? reason.message : "Could not save difference groups. Try again.")
    }
    finally { saving.current = false; setSaveBusy(false); onBusyChange("") }
  }
  function pluck(x: number) {
    if (!pick || !canPick || !single || single.e0 === null || !Number.isFinite(x)) return
    if (committedPick.current?.intent !== intent || committedPick.current.view !== "E" || committedPick.current.pick !== pick || pick.generation !== generation.current || !stillCurrent(intent, project.id, project.version)) return
    update(pick.bound, String(Number((x - single.e0).toFixed(6))))
    setPick(null)
  }
  const numberField = (key: "multiplier" | "xmin" | "xmax", label: string, off = false) => <label className="ath-field"><span>{label}</span><input type="number" step="any" value={draft[key]} disabled={off} onChange={event => update(key, event.target.value)} /></label>
  return <dialog ref={dialog} className={`ath-modal ${styles.dialog}`} aria-label="Difference spectrum" onCancel={event => { event.preventDefault(); if (pick) setPick(null); else dismiss() }}>
    <header><h2>Difference spectrum</h2><button type="button" aria-label="Close dialog" onClick={dismiss}>×</button></header>
    <div className="ath-modal-body">
      <p>Subtract a scaled STANDARD from each DATA spectrum. Preview uses saved spectra and recipes; parameter drafts stay separate. Frozen source spectra can be read and remain unchanged.</p>
      <div className={styles.layout}>
        <fieldset className={styles.controls} disabled={locked}>
          <label className="ath-field"><span>Current DATA</span><select aria-label="Current DATA" value={activeId} onChange={event => selectData(event.target.value)}>{project.groups.map(group => <option key={group.id} value={group.id} disabled={group.data_type === "chi"}>{group.label}{group.frozen ? " · frozen" : ""}</option>)}</select></label>
          <label className="ath-field"><span>STANDARD</span><select aria-label="STANDARD" value={draft.standard_id} onChange={event => update("standard_id", event.target.value)}><option value="">Choose a standard</option>{project.groups.filter(group => group.data_type !== "chi").map(group => <option key={group.id} value={group.id}>{group.label}{group.frozen ? " · frozen" : ""}</option>)}</select></label>
          <label className="ath-field"><span>DATA targets</span><select aria-label="DATA targets" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="current">Current DATA</option><option value="marked">Marked DATA groups</option></select></label>
          <p className="ath-hint">The STANDARD is excluded. Marked targets follow group-list order, including groups hidden by search.</p>
          <ul className={styles.targets} aria-label="Difference targets">{targets.map(group => <li key={group.id}>{group.label}{group.frozen ? " · frozen (read only)" : ""}</li>)}</ul>
          {!ready && <p role="status">Choose a STANDARD and at least one different DATA group on an energy axis. Unmark χ(k) inputs for marked differences.</p>}
          <label className="ath-field"><span>Difference form</span><select aria-label="Difference form" value={draft.form} onChange={event => { const form = event.target.value as DifferenceForm; setDraft(previous => ({ ...previous, form, renormalize: form === "xmu" })) }}>{Object.entries(forms).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          {numberField("multiplier", "STANDARD multiplier")}
          <label className="ath-check"><input type="checkbox" checked={draft.invert} onChange={event => update("invert", event.target.checked)} />Invert difference spectrum</label>
          <label className="ath-check"><input type="checkbox" checked={draft.plot_inputs} onChange={event => update("plot_inputs", event.target.checked)} />Plot DATA and STANDARD</label>
          <p className="ath-hint">In k view, overlays show the original processed inputs with their saved k-weights. The difference multiplier and inversion do not change these input curves.</p>
          <label className="ath-check"><input type="checkbox" checked={draft.renormalize} onChange={event => update("renormalize", event.target.checked)} />Allow difference group to be renormalized</label>
          <p className="ath-hint">Selecting μ(E) enables renormalization; other forms start with it off. Renormalization processes the new group and leaves the source spectra intact.</p>
          <label className="ath-check"><input type="checkbox" checked={draft.integrate} onChange={event => { update("integrate", event.target.checked); if (!event.target.checked && view === "area") changeView("E") }} />Integrate difference</label>
          <div className={styles.bounds}>{numberField("xmin", "Integration minimum (E − E₀, eV)", !draft.integrate)}<button type="button" aria-label="Pick integration minimum" aria-pressed={pick?.bound === "xmin"} disabled={!canPick} onClick={() => setPick(pick?.bound === "xmin" ? null : { bound: "xmin", generation: generation.current })}>Pick</button>
            {numberField("xmax", "Integration maximum (E − E₀, eV)", !draft.integrate)}<button type="button" aria-label="Pick integration maximum" aria-pressed={pick?.bound === "xmax"} disabled={!canPick} onClick={() => setPick(pick?.bound === "xmax" ? null : { bound: "xmax", generation: generation.current })}>Pick</button></div>
          <p className="ath-hint">Bounds are relative to each DATA group’s saved E₀. Type either bound, or preview a single current DATA group in E view and pick a plotted point. Picking changes the fields; preview again to recalculate.</p>
          <label className="ath-field"><span>Name template</span><input maxLength={200} value={draft.name_template} onChange={event => update("name_template", event.target.value)} /></label>
          <p className="ath-hint">%d DATA · %s STANDARD · %f form · %m multiplier · %n minimum · %x maximum · %a area · %% literal %. Invert swaps DATA/STANDARD name tokens.</p>
        </fieldset>
        <section className={styles.results} aria-label="Difference preview results">
          <div className={styles.views} aria-label="Difference view">{(["E", "k", "area"] as const).map(value => <button key={value} aria-pressed={view === value} disabled={locked || (value === "area" && !draft.integrate)} onClick={() => changeView(value)}>{value === "area" ? "Area sequence" : `${value} preview`}</button>)}</div>
          {pick && <div className={styles.pick} role="status">Pick {pick.bound === "xmin" ? "minimum" : "maximum"} for {active?.label}; plotted E minus {single?.e0} eV. <button onClick={() => setPick(null)}>Cancel pick</button></div>}
          {current ? <>
            <AthenaDifferencePlot preview={current.response} view={view} labels={labels} standardLabel={standard?.label ?? "STANDARD"} picking={!!pick && canPick} onPick={pluck} />
            <table className={styles.table}><caption>Preview at project revision {current.response.version}</caption><thead><tr><th>DATA / new group</th><th>Forms (DATA / STANDARD)</th><th>Integrated area</th></tr></thead><tbody>{current.response.results.map(result => <tr key={result.group_id}><td>{labels[result.group_id]}<br /><strong>{result.label}</strong></td><td>{result.data_form} / {result.standard_form}</td><td>{result.area === null ? "Not integrated" : `${result.area.toPrecision(7)} ${result.area_label}`}</td></tr>)}</tbody></table>
            {current.response.results.map(result => {
              const hasIntegrationWarning = result.warnings.some(warning => /integration|romberg/i.test(warning) && /converg/i.test(warning))
              return <div key={result.group_id}>{result.k_error && <p className="ath-warning">{labels[result.group_id]}: k preview — {result.k_error}. The energy difference can still be saved.</p>}{result.warnings.map((warning, index) => <p className="ath-warning" key={index}>{labels[result.group_id]}: {warning}</p>)}{result.integration && !result.integration.converged && !hasIntegrationWarning && <p className="ath-warning">{labels[result.group_id]}: integration did not converge after {result.integration.iterations} iterations. Inspect the bounds and area.</p>}</div>
            })}
            {inputKWarnings.map(input => <p className="ath-warning" key={JSON.stringify([input.role, input.group_id, input.error])}>{input.label}: original {input.role} k preview — {input.error}. The energy difference can still be saved.</p>)}
            <div className={styles.downloads}><button disabled={locked} onClick={() => downloadReport(current, "csv")}>Download energy CSV</button><button disabled={locked} onClick={() => downloadReport(current, "json")}>Download preview JSON</button></div>
          </> : <div className={styles.empty}><p>{loading ? "Calculating difference preview…" : "Preview the selected DATA and STANDARD before saving. Changes to options, targets, or the project require a new preview."}</p></div>}
          {error && <div className="ath-error" role="alert">{error}</div>}
        </section>
      </div>
      <div className="ath-modal-actions"><button disabled={locked} onClick={dismiss}>Cancel</button><button disabled={locked || !ready || loading} onClick={() => { void runPreview() }}>{loading ? "Previewing…" : "Preview difference"}</button><button className="ath-primary" disabled={locked || !current || loading} onClick={() => { void save() }}>{saveBusy ? "Saving…" : "Save difference groups"}</button></div>
    </div>
  </dialog>
}
