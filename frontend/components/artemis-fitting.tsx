"use client"

import { ThemedPlot as Plot } from "./themed-plot"
import { useEffect, useRef, useState } from "react"
import { FlaskConical, Plus, RefreshCw, Trash2, Upload } from "lucide-react"
import type { AthenaGroup, AthenaProject } from "@/lib/athena"
import {
  artemisApi, validArtemisResult, type ArtemisExample, type ArtemisFitRequest, type ArtemisFitResult,
  type ArtemisInspectedPath, type ArtemisParameter, type ArtemisPath, type ArtemisTransform,
} from "@/lib/artemis"
import { ResizablePlotCard } from "./athena-plot-card"
import { ViewerPanel } from "./viewer-panel"
import { ViewerControlField, ViewerControlGroup, ViewerDisplayControls, ViewerToggle } from "./viewer-display-controls"
import { planArtemisParameterSync } from "@/lib/artemis-parameters"
import { parseFeffCluster } from "@/lib/feff-cluster"
import { ArtemisStructures } from "./artemis-structures"
import type { FeffPathSummary } from "./feff-path-viewer"
import styles from "./artemis-fitting.module.css"

export type { ArtemisFitResult } from "@/lib/artemis"

type ParameterDraft = Omit<ArtemisParameter, "value" | "min" | "max"> & { value: string; min: string; max: string; id: string }
type TransformDraft = Omit<ArtemisTransform, "kmin" | "kmax" | "dk" | "rmin" | "rmax" | "dr"> &
  Record<"kmin" | "kmax" | "dk" | "rmin" | "rmax" | "dr", string>
interface Draft { parameters: ParameterDraft[]; paths: ArtemisPath[]; transform: TransformDraft; revision: number }
interface SavedDraft { draft: Draft; result: { revision: number; data: ArtemisFitResult } | null }
interface PanelProps {
  projectId?: string
  version?: number
  group?: AthenaGroup
  pending?: boolean
  onFitResult?: (result: ArtemisFitResult | null) => void
  onPathsChange?: (paths: FeffPathSummary[], projectId?: string, groupId?: string) => void
  onProjectChange?: (project: AthenaProject) => void
  onViewStructure?: (attachmentId: string) => void
}

let sequence = 0
const nextId = () => `artemis-${++sequence}`
const defaultParameters: ArtemisParameter[] = [
  { name: "amp", kind: "guess", value: 1, expression: "", min: 0, max: 2 },
  { name: "del_e0", kind: "guess", value: 0, expression: "", min: -20, max: 20 },
  { name: "del_r", kind: "guess", value: 0, expression: "", min: -0.2, max: 0.2 },
  { name: "sig2", kind: "guess", value: 0.003, expression: "", min: 0, max: 0.1 },
]
function parameterDraft(parameter: ArtemisParameter): ParameterDraft {
  return { ...parameter, id: nextId(), value: String(parameter.value), min: parameter.min === null ? "" : String(parameter.min), max: parameter.max === null ? "" : String(parameter.max) }
}
function transformDraft(transform: ArtemisTransform): TransformDraft {
  return { ...transform, kmin: String(transform.kmin), kmax: String(transform.kmax), dk: String(transform.dk),
    rmin: String(transform.rmin), rmax: String(transform.rmax), dr: String(transform.dr) }
}
function newDraft(): Draft {
  return { revision: 0, paths: [], parameters: defaultParameters.map(parameterDraft),
    transform: transformDraft({ fitspace: "r", kmin: 3, kmax: 12, kweight: [0, 1, 2, 3], dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0 }) }
}
function pathDraft(path: ArtemisInspectedPath): ArtemisPath {
  return { ...path, id: nextId(), label: path.filename, enabled: true, s02: "amp", e0: "del_e0", deltar: "del_r", sigma2: "sig2" }
}
function numberValue(value: string, label: string) {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`${label} must be a finite number.`)
  return Number(value)
}
function requestFromDraft(draft: Draft, version: number): ArtemisFitRequest {
  if (!draft.paths.some(path => path.enabled)) throw new Error("Include at least one FEFF path before fitting.")
  const names = new Set<string>()
  const parameters = draft.parameters.map(parameter => {
    const name = parameter.name.trim()
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) throw new Error("Parameter names must start with a letter and contain up to 32 letters, digits, or underscores.")
    if (names.has(name)) throw new Error(`Parameter name “${name}” is used more than once.`)
    names.add(name)
    const value = parameter.kind === "def" ? 0 : numberValue(parameter.value, `${name} value`)
    const min = parameter.kind === "guess" && parameter.min.trim() ? numberValue(parameter.min, `${name} lower bound`) : null
    const max = parameter.kind === "guess" && parameter.max.trim() ? numberValue(parameter.max, `${name} upper bound`) : null
    if (min !== null && max !== null && min >= max) throw new Error(`${name}: lower bound must be smaller than upper bound.`)
    if ((min !== null && value < min) || (max !== null && value > max)) throw new Error(`${name}: starting value must lie within its bounds.`)
    if (parameter.kind === "def" && !parameter.expression.trim()) throw new Error(`${name}: enter an expression for this Def parameter.`)
    return { name, kind: parameter.kind, value, min, max, expression: parameter.kind === "def" ? parameter.expression.trim() : "" }
  })
  if (!parameters.some(parameter => parameter.kind === "guess")) throw new Error("Add at least one Guess parameter to refine.")
  const t = draft.transform
  const transform: ArtemisTransform = { fitspace: t.fitspace, window: t.window, kweight: t.kweight.slice(),
    kmin: numberValue(t.kmin, "k minimum"), kmax: numberValue(t.kmax, "k maximum"),
    dk: numberValue(t.dk, "k taper dk"), rmin: numberValue(t.rmin, "R minimum"), rmax: numberValue(t.rmax, "R maximum"), dr: 0 }
  if (transform.kmin < 0 || transform.kmax <= transform.kmin) throw new Error("The k range must have 0 ≤ minimum < maximum.")
  if (transform.rmin < 0 || transform.rmax <= transform.rmin) throw new Error("The R range must have 0 ≤ minimum < maximum.")
  if (transform.dk < 0 || transform.dr < 0) throw new Error("Window tapers dk and dr cannot be negative.")
  if (!transform.kweight.length) throw new Error("Select at least one fit k-weight.")
  return { version, parameters, transform, paths: draft.paths.map(path => ({ id: path.id, label: path.label,
    filename: path.filename, content: path.content, enabled: path.enabled, s02: path.s02, e0: path.e0, deltar: path.deltar, sigma2: path.sigma2 })) }
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "The request failed. Please try again." }
const format = (value: number | null | undefined, digits = 5) => value === null || value === undefined || !Number.isFinite(value) ? "—" : Number(value.toPrecision(digits)).toString()

function download(filename: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function exportBundle(request: ArtemisFitRequest, result: ArtemisFitResult | null, source?: { project_id?: string; group_id?: string; group_label?: string }) {
  const { request: _request, ...fitResult } = result ?? {}
  return JSON.stringify({ schema: "artemis-web/v1", source, request, result: result ? fitResult : null }, null, 2)
}
function importRequest(text: string): ArtemisFitRequest {
  const value = JSON.parse(text)
  const request = value?.request as ArtemisFitRequest | undefined
  if (value?.schema !== "artemis-web/v1" || !request || !Array.isArray(request.paths) || !request.paths.length || request.paths.length > 24 ||
    !Array.isArray(request.parameters) || request.parameters.length > 32 || !request.transform) throw new Error("Choose an Artemis-web model JSON exported from this fitting panel.")
  for (const parameter of request.parameters) {
    if (typeof parameter.name !== "string" || !["guess", "set", "def"].includes(parameter.kind) || !Number.isFinite(parameter.value) ||
      typeof parameter.expression !== "string" || !(parameter.min === null || Number.isFinite(parameter.min)) || !(parameter.max === null || Number.isFinite(parameter.max))) throw new Error("The model contains an invalid parameter.")
  }
  for (const path of request.paths) {
    if ([path.filename, path.content, path.label, path.s02, path.e0, path.deltar, path.sigma2].some(value => typeof value !== "string") || typeof path.enabled !== "boolean") throw new Error("The model contains an invalid FEFF path.")
  }
  const t = request.transform
  if (!["r", "k"].includes(t.fitspace) || !["hanning", "kaiser", "parzen", "welch"].includes(t.window) ||
    !Array.isArray(t.kweight) || !t.kweight.length || t.kweight.some(weight => ![0, 1, 2, 3].includes(weight)) ||
    new Set(t.kweight).size !== t.kweight.length || [t.kmin, t.kmax, t.rmin, t.rmax, t.dk, t.dr].some(value => !Number.isFinite(value))) throw new Error("The model contains invalid transform settings.")
  return request
}

/** The workbench keeps this wrapper mounted; drafts survive group and processing-tab changes. */
export function ArtemisFittingPanel(props: PanelProps) {
  const cache = useRef(new Map<string, SavedDraft>())
  const key = `${props.projectId ?? "none"}:${props.group?.id ?? "none"}`
  return <FittingEditor key={key} {...props} initial={cache.current.get(key)} onSave={saved => cache.current.set(key, saved)} />
}

function FittingEditor({ projectId, version, group, pending = false, onFitResult, onPathsChange, onProjectChange, onViewStructure, initial, onSave }: PanelProps & {
  initial?: SavedDraft; onSave: (saved: SavedDraft) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => initial?.draft ?? newDraft())
  const [result, setResult] = useState<SavedDraft["result"]>(initial?.result ?? null)
  const [busy, setBusy] = useState<"fit" | "upload" | "example" | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const controller = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const callbacks = useRef({ onFitResult, onPathsChange, onSave })
  callbacks.current = { onFitResult, onPathsChange, onSave }
  const reason = !projectId || !group ? "Select a spectrum to build an EXAFS fit."
    : pending ? "Waiting for spectrum processing…"
    : group.processing_error ? "Resolve this spectrum’s processing error before fitting."
    : !group.result?.arrays.k?.length || group.result.arrays.k.length !== group.result.arrays.chi?.length
      ? "EXAFS fitting requires processed χ(k). Select an EXAFS spectrum or process its background first." : ""
  const context = `${projectId}:${group?.id}:${version}:${draft.revision}:${reason}`
  const contextRef = useRef(context)
  contextRef.current = context
  const currentResult = !reason && result?.revision === draft.revision && result.data.project_id === projectId &&
    result.data.group_id === group?.id && result.data.version === version ? result.data : null

  useEffect(() => {
    callbacks.current.onSave({ draft, result })
    callbacks.current.onFitResult?.(currentResult)
  }, [draft, result, currentResult])
  useEffect(() => {
    callbacks.current.onPathsChange?.(draft.paths.map(({ id, label, filename, enabled, metadata }) => ({ id, label, filename, enabled, metadata })), projectId, group?.id)
  }, [draft.paths, projectId, group?.id])
  useEffect(() => {
    controller.current?.abort()
    setBusy(null)
    setError("")
    return () => { controller.current?.abort() }
  }, [projectId, group?.id, version, reason])

  function edit(change: (previous: Draft) => Draft) {
    controller.current?.abort()
    setBusy(null)
    setError("")
    setNotice("")
    setDraft(previous => ({ ...change(previous), revision: previous.revision + 1 }))
  }
  function editParameter(id: string, field: keyof ParameterDraft, value: string) {
    edit(previous => ({ ...previous, parameters: previous.parameters.map(parameter => parameter.id === id ? { ...parameter, [field]: value } : parameter) }))
  }
  function editPath(id: string, field: keyof ArtemisPath, value: string | boolean) {
    edit(previous => ({ ...previous, paths: previous.paths.map(path => path.id === id ? { ...path, [field]: value } : path) }))
  }
  function syncParameters() {
    try {
      const { added, removed } = planArtemisParameterSync(draft.parameters, draft.paths)
      if (added.length || removed.length) {
        const obsolete = new Set(removed)
        edit(previous => ({ ...previous, parameters: [
          ...previous.parameters.filter(parameter => !obsolete.has(parameter.name.trim())), ...added.map(parameterDraft),
        ] }))
      }
      setError("")
      setNotice(added.length || removed.length
        ? [added.length ? `Added: ${added.map(parameter => parameter.name).join(", ")}. Review their starting values and bounds.` : "",
          removed.length ? `Removed unused parameters: ${removed.join(", ")}.` : ""].filter(Boolean).join(" ")
        : "Parameters are already in sync with the included paths.")
    } catch (error) { setError(errorText(error)) }
  }
  function begin(kind: NonNullable<typeof busy>) {
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setBusy(kind)
    setError("")
    setNotice("")
    return abort
  }
  async function upload(files: File[]) {
    if (!files.length) return
    if (draft.paths.length + files.length > 24) { setError("A model can contain up to 24 FEFF paths."); return }
    const abort = begin("upload")
    const requestContext = context
    try {
      const inspected: ArtemisPath[] = []
      for (const file of files) {
        const content = await file.text()
        if (abort.signal.aborted) return
        const path = await artemisApi<ArtemisInspectedPath>("/paths/inspect", { filename: file.name, content }, abort.signal)
        inspected.push(pathDraft(path))
      }
      if (abort.signal.aborted || contextRef.current !== requestContext) return
      setDraft(previous => ({ ...previous, revision: previous.revision + 1, paths: [...previous.paths, ...inspected] }))
      setNotice(`Added ${inspected.length} FEFF path${inspected.length === 1 ? "" : "s"}. Review the path expressions before fitting.`)
    } catch (error) { if (!abort.signal.aborted) setError(errorText(error)) }
    finally { if (!abort.signal.aborted) setBusy(null) }
  }
  async function loadExample() {
    if (!projectId || version === undefined || !group || !onProjectChange || draft.paths.length) return
    const abort = begin("example")
    const requestContext = context
    try {
      const example = await artemisApi<ArtemisExample>("/examples/cuprite", undefined, abort.signal)
      if (abort.signal.aborted || contextRef.current !== requestContext) return
      if (example.amcsd_id !== 15851 || !/^[0-9a-f]{64}$/.test(example.cif_sha256) ||
        !Array.isArray(example.paths) || example.paths.length !== 4 ||
        example.paths.some((path, index) => path.filename !== `feff${String(index + 1).padStart(4, "0")}.dat`)) {
        throw new Error("The Cu₂O example does not contain the expected Cuprite structure and four FEFF paths.")
      }
      // The attach operation can commit even if the selected spectrum changes.
      // Always receive its response so the workbench learns the new project version.
      const updated = await artemisApi<AthenaProject>(`/projects/${encodeURIComponent(projectId)}/structures`,
        { version, amcsd_id: example.amcsd_id })
      if (updated.id !== projectId || updated.version < version) {
        throw new Error("The saved CIF response does not match this project. Reload the project and try again.")
      }
      const applyToGroup = !abort.signal.aborted && contextRef.current === requestContext
      const attachment = updated.artemis_structures?.find(item => item.amcsd_id === example.amcsd_id)
      if (!attachment || attachment.sha256 !== example.cif_sha256) {
        onProjectChange(updated)
        if (!applyToGroup) return
        throw new Error("The attached CIF does not match the Cu₂O FEFF calculation. Reload the project and try again.")
      }
      if (applyToGroup) {
        const viewerCluster = parseFeffCluster(example.feff_input)
        const paths = example.paths.map(path => ({ ...pathDraft(path),
          label: `Cuprite · AMCSD 0015851 · Cu site 1 · ${path.filename}`,
          metadata: viewerCluster ? { ...path.metadata, viewerCluster } : path.metadata }))
        setDraft(previous => ({ revision: previous.revision + 1, paths,
          parameters: example.parameters.map(parameterDraft), transform: transformDraft(example.transform) }))
        setNotice(example.description)
      }
      onProjectChange(updated)
      if (applyToGroup) onViewStructure?.(attachment.id)
    } catch (error) { if (!abort.signal.aborted) setError(errorText(error)) }
    finally { if (!abort.signal.aborted) setBusy(null) }
  }
  function saveModel() {
    try {
      const request = requestFromDraft(draft, version ?? 0)
      download("artemis-model.json", exportBundle(request, currentResult, { project_id: projectId, group_id: group?.id, group_label: group?.label }))
      setError("")
      setNotice("Downloaded the model, FEFF files, and any current fit result as JSON.")
    } catch (error) { setError(errorText(error)) }
  }
  async function loadModel(file: File) {
    const abort = begin("upload")
    const requestContext = context
    try {
      const request = importRequest(await file.text())
      const paths: ArtemisPath[] = []
      for (const path of request.paths) {
        if (abort.signal.aborted) return
        const inspected = await artemisApi<ArtemisInspectedPath>("/paths/inspect", { filename: path.filename, content: path.content }, abort.signal)
        paths.push({ ...path, ...inspected, id: nextId() })
      }
      const imported = { revision: draft.revision + 1, paths, parameters: request.parameters.map(parameterDraft), transform: transformDraft({ ...request.transform, dr: 0 }) }
      requestFromDraft(imported, version ?? 0)
      if (abort.signal.aborted || contextRef.current !== requestContext) return
      setDraft(imported)
      setResult(null)
      setNotice("Loaded the model and verified its FEFF files. Review it for the selected spectrum, then run a new fit.")
    } catch (error) { if (!abort.signal.aborted) setError(errorText(error)) }
    finally { if (!abort.signal.aborted) setBusy(null) }
  }
  async function fit() {
    if (reason || !projectId || !group || version === undefined || busy) return
    let request: ArtemisFitRequest
    try { request = requestFromDraft(draft, version) }
    catch (error) { setError(errorText(error)); return }
    const abort = begin("fit")
    const requestContext = context
    setResult(null)
    try {
      const response = await artemisApi<ArtemisFitResult>(`/projects/${encodeURIComponent(projectId)}/groups/${encodeURIComponent(group.id)}/fit`, request, abort.signal)
      if (abort.signal.aborted || contextRef.current !== requestContext) return
      if (!validArtemisResult(response, projectId, group.id, version)) throw new Error("The fit result does not match this spectrum or contains invalid curves. Try the fit again.")
      setResult({ revision: draft.revision, data: { ...response, request } })
    } catch (error) { if (!abort.signal.aborted && contextRef.current === requestContext) setError(errorText(error)) }
    finally { if (!abort.signal.aborted) setBusy(null) }
  }

  const disabled = !!busy || pending
  const freeCount = draft.parameters.filter(parameter => parameter.kind === "guess").length
  return <section className={styles.editor} aria-label="Artemis EXAFS fitting setup">
    <header className={styles.intro}><h3><FlaskConical size={16} />EXAFS fitting</h3><p>Artemis-style path models · Larch fitting core</p></header>
    <div className={styles.actions}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button type="button" className={styles.fitButton} onClick={fit} disabled={!!reason || version === undefined || !!busy || !draft.paths.some(path => path.enabled)}>{busy === "fit" ? "Fitting…" : error ? "Retry fit" : "Run EXAFS fit"}</button>
      <div className={styles.toolbar}><button type="button" disabled={!!busy || !draft.paths.length} onClick={saveModel}>Export model JSON</button><button type="button" disabled={!!busy} onClick={() => modelInputRef.current?.click()}>Import model JSON</button><input className={styles.fileInput} ref={modelInputRef} type="file" accept=".json,application/json" aria-label="Import Artemis model JSON" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void loadModel(file) }} /></div>
      <p className={styles.help}>Fit runs only when requested. Drafts stay in this workspace session; use model JSON to keep them after reload. Athena project exports do not include fitting models.</p>
    </div>
    {notice && <p className={styles.message} role="status">{notice}</p>}
    {busy && <p className={styles.message} role="status">{busy === "fit" ? "Fitting with Larch…" : busy === "upload" ? "Reading FEFF paths…" : "Loading Cu₂O CIF and FEFF paths…"}</p>}
    {currentResult && <p className={styles.message} role="status">{currentResult.success ? "Fit completed. Results are in the plot panel." : `Fit did not converge: ${currentResult.message}`}</p>}
    <p className={styles.spectrum}><span>Current spectrum</span><strong>{group?.label ?? "None selected"}</strong></p>
    {reason && <p className={styles.message} role="status">{reason}</p>}
    <ArtemisStructures contextKey={`${projectId}:${group?.id}`} projectId={projectId} version={version} onProjectChange={onProjectChange} onViewStructure={onViewStructure} disabled={disabled} existingPaths={draft.paths}
      availableSlots={24 - draft.paths.length} onAddPaths={paths => {
        if (disabled) return "Wait for the current fit or file operation to finish before adding paths."
        if (draft.paths.length + paths.length > 24) return "A model can contain up to 24 FEFF paths. Remove some existing paths first."
        const missing = defaultParameters.filter(parameter => !draft.parameters.some(existing => existing.name.trim() === parameter.name))
        if (draft.parameters.length + missing.length > 32) return "Adding these paths requires the amp, del_e0, del_r, and sig2 parameters. Remove unused parameters to leave room within the 32-parameter limit."
        edit(previous => ({ ...previous, paths: [...previous.paths, ...paths.map(path => ({ ...pathDraft(path), label: path.label }))],
          parameters: [...previous.parameters, ...missing.map(parameterDraft)] }))
        return null
      }} />
    <fieldset className={styles.section} disabled={disabled}>
      <legend>FEFF paths <span>{draft.paths.filter(path => path.enabled).length} included</span></legend>
      <div className={styles.toolbar}>
        <button type="button" onClick={() => inputRef.current?.click()}><Upload size={13} />Add feff*.dat</button>
        <button type="button" onClick={loadExample} disabled={draft.paths.length > 0 || !projectId || version === undefined || !group || !onProjectChange} title={draft.paths.length ? "Remove existing paths to load the Cu₂O example." : "Attach Cuprite AMCSD 0015851 and load four precomputed Cu K-edge FEFF paths."}>Cu₂O example</button>
        <input ref={inputRef} className={styles.fileInput} type="file" multiple accept=".dat" aria-label="Upload FEFF path files"
          onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void upload(files) }} />
      </div>
      {draft.paths.length === 0 && <p className={styles.help}>Add calculated FEFF scattering paths, or load the Cuprite CIF and its first four precomputed paths with the Cu₂O example.</p>}
      {draft.paths.map((path, i) => <div className={styles.path} key={path.id}>
        <div className={styles.pathHeader}>
          <label className={styles.check}><input type="checkbox" checked={path.enabled} aria-label={`Include path ${i + 1}`} onChange={event => editPath(path.id, "enabled", event.target.checked)} /><span>{path.filename}</span></label>
          <button type="button" aria-label={`Remove path ${i + 1}`} onClick={() => edit(previous => ({ ...previous, paths: previous.paths.filter(item => item.id !== path.id) }))}><Trash2 size={13} /></button>
        </div>
        <p className={styles.metadata}>{path.metadata.absorber} {path.metadata.edge} · R<sub>eff</sub> {format(path.metadata.reff)} Å · N {format(path.metadata.degen)} · {path.metadata.nleg} legs</p>
        <label className={styles.fullField}>Path label<input value={path.label} aria-label={`Path ${i + 1} label`} onChange={event => editPath(path.id, "label", event.target.value)} /></label>
        <div className={styles.grid}>
          {([
            ["s02", "S₀²", "Amplitude factor; FEFF degeneracy N is already included."],
            ["e0", "ΔE₀ (eV)", "Fitted energy correction, separate from the Athena edge energy."],
            ["deltar", "ΔR (Å)", "Change in the FEFF effective half-path length."],
            ["sigma2", "σ² (Å²)", "Mean-square relative displacement."],
          ] as const).map(([field, label, title]) => <label key={field} title={title}>{label}<input value={path[field]} aria-label={`Path ${i + 1} ${label}`} onChange={event => editPath(path.id, field, event.target.value)} spellCheck={false} /></label>)}
        </div>
      </div>)}
      {draft.paths.length > 0 && <p className={styles.help}>N is fixed by FEFF; the amplitude is N × S₀². Shared parameter names couple paths. Give distinct shells their own ΔR and σ² parameters when needed.</p>}
    </fieldset>

    <fieldset className={styles.section} disabled={disabled}>
      <legend>Parameters <span>{freeCount} free</span></legend>
      <div className={styles.toolbar}><button type="button" className={styles.syncButton} disabled={!draft.paths.some(path => path.enabled)} onClick={syncParameters}><RefreshCw size={13} />Sync parameters</button></div>
      <p className={styles.help}>Sync adds missing parameters and removes those unused by included paths, including Def dependencies. Existing values and constraints are kept.</p>
      <p className={styles.help}>Guess refines a value, Set fixes it, Def evaluates an expression.</p>
      {draft.parameters.map((parameter, i) => <div key={parameter.id} className={styles.parameter}>
        <div className={styles.parameterHeader}>
          <input aria-label={`Parameter ${i + 1} name`} value={parameter.name} maxLength={32} placeholder="Parameter name" onChange={event => editParameter(parameter.id, "name", event.target.value)} spellCheck={false} />
          <select aria-label={`Parameter ${i + 1} kind`} value={parameter.kind} onChange={event => editParameter(parameter.id, "kind", event.target.value)}><option value="guess">Guess</option><option value="set">Set</option><option value="def">Def</option></select>
          <button type="button" aria-label={`Remove parameter ${i + 1}`} onClick={() => edit(previous => ({ ...previous, parameters: previous.parameters.filter(item => item.id !== parameter.id) }))}><Trash2 size={13} /></button>
        </div>
        {parameter.kind === "def" ? <label className={styles.fullField}>Expression<input aria-label={`Parameter ${i + 1} expression`} value={parameter.expression} placeholder="e.g. amp * 0.5" onChange={event => editParameter(parameter.id, "expression", event.target.value)} spellCheck={false} /></label>
          : <div className={parameter.kind === "guess" ? styles.parameterValues : styles.grid}>
            <label>{parameter.kind === "guess" ? "Start" : "Value"}<input aria-label={`Parameter ${i + 1} value`} inputMode="decimal" value={parameter.value} onChange={event => editParameter(parameter.id, "value", event.target.value)} /></label>
            {parameter.kind === "guess" && <><label>Min<input aria-label={`Parameter ${i + 1} minimum`} inputMode="decimal" value={parameter.min} placeholder="−∞" onChange={event => editParameter(parameter.id, "min", event.target.value)} /></label><label>Max<input aria-label={`Parameter ${i + 1} maximum`} inputMode="decimal" value={parameter.max} placeholder="∞" onChange={event => editParameter(parameter.id, "max", event.target.value)} /></label></>}
          </div>}
      </div>)}
      <button type="button" disabled={draft.parameters.length >= 32} onClick={() => edit(previous => ({ ...previous, parameters: [...previous.parameters, parameterDraft({ name: `param${previous.parameters.length + 1}`, kind: "guess", value: 0, expression: "", min: null, max: null })] }))}><Plus size={13} />Add parameter</button>
    </fieldset>

    <fieldset className={styles.section} disabled={disabled}>
      <legend>Fit range & transform</legend>
      <div className={styles.choice} role="group" aria-label="Fit space">{(["r", "k"] as const).map(space => <button key={space} type="button" aria-pressed={draft.transform.fitspace === space} onClick={() => edit(previous => ({ ...previous, transform: { ...previous.transform, fitspace: space } }))}>{space === "r" ? "R space" : "k space"}</button>)}</div>
      <div className={styles.grid}>
        {([
          ["kmin", "k min (Å⁻¹)"], ["kmax", "k max (Å⁻¹)"], ["rmin", "R min (Å)"], ["rmax", "R max (Å)"], ["dk", "k taper dk (Å⁻¹)"],
        ] as const).map(([field, label]) => <label key={field}>{label}<input aria-label={label} inputMode="decimal" value={draft.transform[field]} onChange={event => edit(previous => ({ ...previous, transform: { ...previous.transform, [field]: event.target.value } }))} /></label>)}
        <label>k window<select value={draft.transform.window} aria-label="Fit k window" onChange={event => edit(previous => ({ ...previous, transform: { ...previous.transform, window: event.target.value as ArtemisTransform["window"] } }))}><option value="hanning">Hanning</option><option value="kaiser">Kaiser–Bessel</option><option value="parzen">Parzen</option><option value="welch">Welch</option></select></label>
      </div>
      <div className={styles.weights} role="group" aria-label="Fit k-weight"><span>Fit k-weight</span>{[0, 1, 2, 3].map(weight => <label key={weight}><input type="checkbox" aria-label={`Fit k-weight ${weight}`} checked={draft.transform.kweight.includes(weight)} onChange={event => edit(previous => ({ ...previous, transform: { ...previous.transform, kweight: (event.target.checked ? [...previous.transform.kweight, weight] : previous.transform.kweight.filter(value => value !== weight)).sort() } }))} />{weight}</label>)}</div>
      <p className={styles.help}>{draft.transform.fitspace === "r" ? "R fitting uses the real and imaginary components within the selected R range. " : "k fitting uses the selected k range; the R range sets the independent-point estimate. "}Multiple k-weights share one fit and do not add independent data.</p>
    </fieldset>
  </section>
}

export function ArtemisFitResultViewer({ result, group, pending = false }: { result?: ArtemisFitResult | null; group?: AthenaGroup; pending?: boolean }) {
  const [space, setSpace] = useState<"k" | "r">("r")
  const [component, setComponent] = useState<"mag" | "re" | "im">("mag")
  const [showPaths, setShowPaths] = useState(false)
  const [offsetPlot, setOffsetPlot] = useState(false)
  const [offsetDraft, setOffsetDraft] = useState<{ result: ArtemisFitResult; space: "k" | "r"; component: "mag" | "re" | "im"; value: string } | null>(null)
  const [plotError, setPlotError] = useState(false)
  const visible = !pending && result?.group_id === group?.id ? result : null
  useEffect(() => { setPlotError(false) }, [visible, space, component, showPaths, offsetPlot])
  const series = visible ? space === "k" ? { x: visible.k.x, data: visible.k.data, model: visible.k.model, residual: visible.k.residual }
    : { x: visible.r.x, data: visible.r[`data_${component}`], model: visible.r[`model_${component}`], residual: visible.r[`residual_${component}`] } : null
  const paths = visible?.paths ?? []
  const pathCurves = paths.map(path => space === "k" ? path.k?.chi : path.r?.[component])
  const pathsAvailable = paths.length > 0 && pathCurves.every(values => Array.isArray(values) && values.length === series?.x.length && values.every(Number.isFinite))
  const pathsShown = showPaths && pathsAvailable
  const curves = series ? [
    { name: "Data", y: series.data, color: "#166d8d", dash: "solid", tier: 0 },
    { name: "Model", y: series.model, color: "#db7835", dash: "solid", tier: 0 },
    { name: "Residual", y: series.residual, color: "#8d5bab", dash: "dot", tier: 1 },
    ...(pathsShown ? paths.map((path, i) => ({ name: `Path ${i + 1} · ${path.label || path.filename}`, y: pathCurves[i]!,
      color: `hsl(${((i * 137.508 + 145) % 360).toFixed(1)}, 58%, 40%)`, dash: "solid", tier: i + 2 })) : []),
  ] : []
  // Use the full vertical excursion, including zero, so signed and magnitude curves both separate clearly.
  const largestSpan = curves.reduce((span, curve) => {
    let low = 0, high = 0
    for (const value of curve.y) { low = Math.min(low, value); high = Math.max(high, value) }
    return Math.max(span, high - low)
  }, 0)
  const automaticSpacing = largestSpan > 0 && Number.isFinite(largestSpan * 1.15) ? Number((largestSpan * 1.15).toPrecision(4)) : 1
  const offsetText = offsetDraft && offsetDraft.result === visible && offsetDraft.space === space && offsetDraft.component === component ? offsetDraft.value : String(automaticSpacing)
  const validSpacing = offsetText.trim() !== "" && Number.isFinite(Number(offsetText)) && Number(offsetText) >= 0 && Number(offsetText) <= Number.MAX_VALUE / Math.max(curves.length, 1)
  const spacing = validSpacing ? Number(offsetText) : automaticSpacing
  const traces = series ? curves.map(curve => {
    const offset = offsetPlot ? -curve.tier * spacing : 0
    return { type: "scatter", mode: "lines", name: curve.name, x: series.x.slice(), y: curve.y.map(value => value + offset),
      visible: curve.name === "Residual" ? "legendonly" : true,
      customdata: curve.y.map(value => [value, offset]),
      hovertemplate: `${space === "k" ? "k" : "R"} = %{x:.3f} ${space === "k" ? "Å⁻¹" : "Å"}<br>Unshifted value = %{customdata[0]:.5g}<br>Display offset = %{customdata[1]:+.5g}<extra>%{fullData.name}</extra>`,
      line: { color: curve.color, width: curve.tier > 0 ? 1.4 : 1.8, dash: curve.dash } }
  }) : []
  return <ViewerPanel title="EXAFS fit" label="EXAFS fit results" className={styles.viewer} actions={<div className={styles.resultActions}>
    <div className={styles.choice} role="group" aria-label="Fit plot space">{(["k", "r"] as const).map(value => <button type="button" key={value} aria-pressed={space === value} onClick={() => setSpace(value)}>{value === "r" ? "R space" : "k space"}</button>)}</div>
    {visible && space === "r" && <div className={styles.choice} role="group" aria-label="R plot component">{([ ["mag", "Magnitude"], ["re", "Real"], ["im", "Imaginary"] ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={component === value} onClick={() => setComponent(value)}>{label}</button>)}</div>}
  </div>}>
    <ResizablePlotCard storageKey="artemis.fit.height.v1" defaultHeight={380} plotSelector="#artemis-fit-plot" resizeLabel="Resize EXAFS fit plot height" controlsId="artemis-fit-plot">
      {visible && <p className={styles.resultSummary}>{visible.group_label} · fit in {visible.transform.fitspace.toUpperCase()} · k-weights {visible.transform.kweight.join(", ")}</p>}
      <div id="artemis-fit-plot" className={styles.plot}>
        {!visible || !series ? <p className={styles.empty} role="status">{pending ? "Waiting for spectrum processing…" : "Build a FEFF path model in the EXAFS fitting tab, then run the fit to compare data and model."}</p>
          : plotError ? <p className={styles.empty} role="alert">Could not render the fit plot. The numerical results and report remain available below.</p>
            : <Plot data={traces}
              layout={{ autosize: true, margin: { l: 65, r: 22, t: 18, b: 56 }, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
                font: { color: "#52665b" },
                xaxis: { title: { text: space === "k" ? "k (Å⁻¹)" : "R (Å, not phase corrected)" }, gridcolor: "#e6ece4", ...(space === "r" ? { range: [0, Math.max(6, visible.transform.rmax + 1)] } : {}) },
                yaxis: { title: { text: (space === "k" ? `k<sup>${visible.k.weight}</sup>χ(k) (Å<sup>−${visible.k.weight}</sup>)` : `${component === "mag" ? "|χ(R)|" : component === "re" ? "Re χ(R)" : "Im χ(R)"} (Å<sup>−${visible.k.weight + 1}</sup>)`) + (offsetPlot ? " + display offset" : "") }, gridcolor: "#e6ece4", zerolinecolor: "#cbd7cf" },
                legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", maxheight: 0.24, ...(pathsShown ? { entrywidth: 0.49, entrywidthmode: "fraction" } : {}) }, uirevision: `${visible.project_id}:${visible.group_id}:${visible.version}:${space}:${component}:${pathsShown}:${offsetPlot}:${offsetPlot ? spacing : 0}`,
                shapes: [{ type: "rect", xref: "x", yref: "paper", x0: space === "k" ? visible.transform.kmin : visible.transform.rmin,
                  x1: space === "k" ? visible.transform.kmax : visible.transform.rmax, y0: 0, y1: 1, fillcolor: "#25844c", opacity: 0.06, line: { width: 0 }, layer: "below" }],
              }} config={{ responsive: true, displaylogo: false, toImageButtonOptions: { filename: `artemis-fit-${space}`, scale: 2 } }} useResizeHandler style={{ width: "100%", height: "100%" }} onError={() => setPlotError(true)} />}
      </div>
      {visible && <ViewerDisplayControls label="Fit plot display options">
        <ViewerControlGroup>
          <ViewerToggle label="Offset plot" checked={offsetPlot} onChange={setOffsetPlot} />
          {offsetPlot && <>
            <ViewerControlField label="Spacing"><input type="number" min="0" step="any" aria-label="Offset spacing" aria-invalid={!validSpacing} value={offsetText}
              onChange={event => setOffsetDraft({ result: visible, space, component, value: event.target.value })} /></ViewerControlField>
            <button type="button" onClick={() => setOffsetDraft(null)} title="Use automatic spacing for the visible curves">Auto</button>
          </>}
        </ViewerControlGroup>
        <ViewerControlGroup>
          <ViewerToggle label="Show paths" checked={pathsShown} disabled={!pathsAvailable} onChange={setShowPaths} title={pathsAvailable ? "Display the individual FEFF paths evaluated at the fitted parameters." : "Run the fit again to include individual path curves in its results."} />
          {!pathsAvailable && <span className={styles.optionHint}>Run the fit again to include path curves.</span>}
        </ViewerControlGroup>
        {offsetPlot && !validSpacing && <span className={styles.optionHint} role="status">Enter a finite, nonnegative spacing. Automatic spacing is shown until the value is valid.</span>}
      </ViewerDisplayControls>}
      {visible && <p className={styles.plotNote}>{space === "r" && component === "mag" ? "Residual is |FT(data − model)|, not the difference of magnitudes. " : "Residual = data − model. "}{pathsShown && space === "r" && component === "mag" && "Individual path magnitudes do not add to the model magnitude; the complex path contributions add before taking the magnitude. "}{offsetPlot && "Offsets affect display only: Data and Model share zero offset; Residual and each path use successively lower baselines. "}Plot k-weight {visible.k.weight}; fit weights {visible.transform.kweight.join(", ")}.</p>}
    </ResizablePlotCard>
    {visible && <div className={styles.results}>
      {!visible.success && <p className={styles.error} role="alert">Fit did not converge: {visible.message}</p>}
      {visible.warnings.length > 0 && <ul className={styles.warnings}>{visible.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      <dl className={styles.statistics}>
        {([
          ["R factor", visible.statistics.r_factor], ["Reduced χ²", visible.statistics.reduced_chi_square], ["χ²", visible.statistics.chi_square],
          ["Independent points", visible.statistics.n_independent], ["Free parameters", visible.statistics.n_varys], ["Fit evaluations", visible.statistics.nfev],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(value)}</dd></div>)}
      </dl>
      <div className={styles.tableScroll}><table><caption>Fitted parameters</caption><thead><tr><th>Name</th><th>Kind</th><th>Value</th><th>Uncertainty</th><th>Expression</th></tr></thead><tbody>{visible.parameters.map(parameter => <tr key={parameter.name}><th scope="row">{parameter.name}</th><td>{parameter.kind}</td><td>{format(parameter.value, 7)}</td><td>{format(parameter.stderr, 3)}</td><td>{parameter.expression || "—"}</td></tr>)}</tbody></table></div>
      {!visible.statistics.errorbars && <p className={styles.help}>Parameter uncertainties could not be estimated for this fit.</p>}
      {visible.correlations.length > 0 && <details><summary>Parameter correlations ({visible.correlations.length})</summary><div className={styles.tableScroll}><table><thead><tr><th>Parameter pair</th><th>Correlation</th></tr></thead><tbody>{visible.correlations.map(pair => <tr key={`${pair.left}:${pair.right}`}><td>{pair.left} / {pair.right}</td><td>{format(pair.value, 4)}</td></tr>)}</tbody></table></div></details>}
      <details><summary>Larch fit report</summary><pre className={styles.report}>{visible.report}</pre></details>
      <div className={styles.toolbar}>{visible.request && <button type="button" onClick={() => download("artemis-fit.json", exportBundle(visible.request!, visible, { project_id: visible.project_id, group_id: visible.group_id, group_label: visible.group_label }))}>Download fit + model JSON</button>}<button type="button" onClick={() => download("artemis-fit-report.txt", visible.report, "text/plain")}>Download report</button></div>
    </div>}
  </ViewerPanel>
}
