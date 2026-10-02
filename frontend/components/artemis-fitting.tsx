"use client"

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { ChevronRight, History, Plus, RefreshCw, SlidersHorizontal, Trash2, Upload, type LucideIcon } from "lucide-react"
import { athenaApi, type AthenaGroup, type AthenaProject } from "@/lib/athena"
import { ApiRequestError } from "@/lib/backend-client"
import {
  artemisApi, validArtemisResult, type ArtemisExample, type ArtemisExampleSetup, type ArtemisFitRequest, type ArtemisFitResult,
  type ArtemisInspectedPath, type ArtemisParameter, type ArtemisPath, type ArtemisTransform,
  artemisModelKey, type ArtemisModelDraft as Draft, type ArtemisParameterDraft as ParameterDraft, type ArtemisTransformDraft as TransformDraft,
} from "@/lib/artemis"
import { download, exportBundle, format } from "@/lib/artemis-fit-utils"
import { planArtemisParameterSync } from "@/lib/artemis-parameters"
import { ArtemisModelAutosave, type ArtemisSaveStatus } from "@/lib/artemis-model-autosave"
import { parseFeffCluster } from "@/lib/feff-cluster"
import { isFirstShellPath, type FirstShellSelection } from "@/lib/first-shell"
import { radialPathNeighbor, type RadialShellContext } from "@/lib/radial-shells"
import { useRadialShells } from "@/lib/use-radial-shells"
import { RadialShellPanel } from "./radial-shell-panel"
import { RadialPathGroups } from "./radial-path-groups"
import { FeffPathShellLabel } from "./feff-path-shell-label"
import { ArtemisStructures } from "./artemis-structures"
import { CrystalLatticeIcon, FeffScatteringIcon, FitCurvesIcon } from "./athena-viewer-icons"
import { FitRangeIcon } from "./athena-parameter-icons"
import { ParameterSectionHeading } from "./parameter-section-heading"
import type { FeffPathSummary } from "./artefact-viewers/feff-path-viewer"
import styles from "./artemis-fitting.module.css"

export type { ArtemisFitResult } from "@/lib/artemis"

interface SavedDraft { draft: Draft; base?: Draft; persisted?: boolean; selectedFitId?: string; result: { revision: number; data: ArtemisFitResult } | null }
export type ArtemisModelActions = {
  flush: () => Promise<void>
  importModel: () => void
  exportModel: () => void
  canExportModel: boolean
  status: ArtemisSaveStatus
  error?: string
  retry: () => Promise<void>
}
type EditorActions = Pick<ArtemisModelActions, "importModel" | "exportModel" | "canExportModel">
type ModelMutation = { version: number; finish: () => void }
interface PanelProps {
  exampleSetup?: ArtemisExampleSetup
  projectId?: string
  version?: number
  group?: AthenaGroup
  groups?: AthenaGroup[]
  pending?: boolean
  onFitResult?: (result: ArtemisFitResult | null) => void
  onPathsChange?: (paths: FeffPathSummary[], projectId?: string, groupId?: string) => void
  onProjectChange?: (project: AthenaProject) => void
  onViewStructure?: (attachmentId: string, siteIndex?: number) => void
  onDirtyChange?: (groupId: string, dirty: boolean) => void
  onActionsChange?: (actions: ArtemisModelActions | null) => void
}

// getRandomValues also works on HTTP workspaces opened on a lab network.
const nextId = () => `artemis-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`
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
function exampleDraft(example: ArtemisExample, revision = 0): Draft {
  const viewerCluster = parseFeffCluster(example.feff_input)
  return { revision, paths: example.paths.map(path => ({ ...pathDraft(path),
    label: `Cuprite · AMCSD 0015851 · Cu site 1 · ${path.filename}`,
    metadata: viewerCluster ? { ...path.metadata, viewerCluster } : path.metadata })),
    parameters: example.parameters.map(parameterDraft), transform: transformDraft(example.transform) }
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
    dk: numberValue(t.dk, "k taper dk"), rmin: numberValue(t.rmin, "R minimum"), rmax: numberValue(t.rmax, "R maximum"), dr: numberValue(t.dr, "R taper dr") }
  if (transform.kmin < 0 || transform.kmax <= transform.kmin) throw new Error("The k range must have 0 ≤ minimum < maximum.")
  if (transform.rmin < 0 || transform.rmax <= transform.rmin) throw new Error("The R range must have 0 ≤ minimum < maximum.")
  if (transform.dk < 0 || transform.dr < 0) throw new Error("Window tapers dk and dr cannot be negative.")
  if (!transform.kweight.length) throw new Error("Select at least one fit k-weight.")
  return { version, parameters, transform, paths: draft.paths.map(path => ({ id: path.id, label: path.label,
    filename: path.filename, content: path.content, enabled: path.enabled, s02: path.s02, e0: path.e0, deltar: path.deltar, sigma2: path.sigma2 })) }
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "The request failed. Please try again." }
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

/** Native disclosures keep form and CIF-dialog state mounted while folded. */
function FittingSection({ title, icon, summary, disabled, children }: {
  title: string; icon: LucideIcon; summary?: string; disabled?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return <details className={styles.section} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <ParameterSectionHeading icon={icon} detail={summary}>{title}</ParameterSectionHeading>
    <fieldset className={styles.sectionBody} aria-label={`${title} controls`} disabled={disabled}>{children}</fieldset>
  </details>
}

/** The workbench keeps this wrapper mounted; drafts survive group and processing-tab changes. */
export function ArtemisFittingPanel(props: PanelProps) {
  const cache = useRef(new Map<string, SavedDraft>())
  const propsRef = useRef(props)
  propsRef.current = props
  const [, refresh] = useState(0)
  const editorActions = useRef<EditorActions | null>(null)
  const [canExportModel, setCanExportModel] = useState(false)
  const receiveProject = useRef<(project: AthenaProject) => void>(() => {})
  const mutationPending = useRef(false)
  const mutationCount = useRef(0)
  const mutationTail = useRef(Promise.resolve())
  const [saver] = useState(() => new ArtemisModelAutosave({
    save: (projectId, groupId, version, model) => artemisApi<AthenaProject>(`/projects/${encodeURIComponent(projectId)}/groups/${encodeURIComponent(groupId)}/model`, { version, model }),
    recover: (projectId, error) => error instanceof ApiRequestError && error.code === "stale_revision"
      ? athenaApi<AthenaProject>(`/projects/${encodeURIComponent(projectId)}`) : Promise.resolve(null),
    accept: project => receiveProject.current(project),
    changed: () => refresh(value => value + 1),
  }))
  receiveProject.current = project => {
    if (project.version < saver.version(project.id, project.version)) return
    for (const group of project.groups) {
      const saved = group.artemis?.model
      const cached = cache.current.get(`${project.id}:${group.id}`)
      if (!saved || !cached) continue
      const clean = !saver.hasChanges(project.id, group.id) && cached.base && artemisModelKey(cached.draft) === artemisModelKey(cached.base)
      cache.current.set(`${project.id}:${group.id}`, { ...cached, draft: clean ? saved : cached.draft, base: saved, persisted: true })
    }
    saver.observe(project.id, project.version, project.groups)
    propsRef.current.onProjectChange?.(project)
  }
  const acceptProject = useCallback((project: AthenaProject) => receiveProject.current(project), [])
  const registerEditorActions = useCallback((actions: EditorActions) => {
    editorActions.current = actions
    setCanExportModel(previous => previous === actions.canExportModel ? previous : actions.canExportModel)
  }, [])
  const updatePause = useCallback(() => saver.setPaused(mutationCount.current > 0 || mutationPending.current || !!propsRef.current.pending || !propsRef.current.onProjectChange), [saver])
  const pause = useCallback((busy: boolean) => { mutationPending.current = busy; updatePause() }, [updatePause])
  const prepareMutation = useCallback(async () => {
    const previous = mutationTail.current
    let release!: () => void
    mutationTail.current = new Promise<void>(resolve => { release = resolve })
    mutationCount.current += 1
    updatePause()
    await previous
    await saver.settle()
    const current = propsRef.current
    let finished = false
    return { version: current.projectId ? saver.version(current.projectId, current.version ?? 0) : current.version ?? 0,
      finish: () => { if (finished) return; finished = true; mutationCount.current -= 1; release(); updatePause() } }
  }, [saver, updatePause])
  const flushModels = useCallback(async (projectId: string | undefined, retry = false) => {
    // Another spectrum can queue a fit while an earlier mutation is still running.
    // Wait for the latest tail before starting a model write or project export.
    for (;;) {
      const tail = mutationTail.current
      await tail
      if (tail === mutationTail.current) break
    }
    if (projectId) await saver.flush(projectId, retry)
  }, [saver])
  const status = saver.state(props.projectId)
  const actions = useMemo<ArtemisModelActions>(() => ({
    flush: () => flushModels(props.projectId),
    retry: () => flushModels(props.projectId, true),
    importModel: () => editorActions.current?.importModel(),
    exportModel: () => editorActions.current?.exportModel(),
    canExportModel, ...status,
  }), [props.projectId, flushModels, canExportModel, status.status, status.error]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { propsRef.current.onActionsChange?.(actions) }, [actions])
  useEffect(() => { saver.activate(); return () => { saver.dispose(); propsRef.current.onActionsChange?.(null) } }, [saver])
  useEffect(() => {
    if (props.projectId && props.version !== undefined) saver.observe(props.projectId, props.version, props.groups ?? (props.group ? [props.group] : []), !!props.groups)
  }, [props.projectId, props.version, props.groups, props.group, saver])
  useEffect(updatePause, [props.pending, props.onProjectChange, updatePause])
  useEffect(() => {
    if (props.projectId) for (const group of saver.dirtyGroups(props.projectId)) propsRef.current.onDirtyChange?.(group.id, group.dirty)
  })
  const setup = props.exampleSetup
  if (setup && setup.projectId === props.projectId) {
    const exampleKey = `${setup.projectId}:${setup.groupId}`
    // Prepare the Cu₂O model even while a foil is selected. Never replace a
    // saved draft, including a model whose paths the user deliberately removed.
    if (!cache.current.has(exampleKey) && !(props.group?.id === setup.groupId && props.group.artemis)) cache.current.set(exampleKey, { draft: exampleDraft(setup.example), result: null })
  }
  const key = `${props.projectId ?? "none"}:${props.group?.id ?? "none"}`
  useEffect(() => {
    if (!props.projectId || !props.onProjectChange) return
    for (const [cacheKey, saved] of cache.current) {
      if (!cacheKey.startsWith(`${props.projectId}:`)) continue
      const groupId = cacheKey.slice(props.projectId.length + 1)
      const group = props.groups?.find(item => item.id === groupId)
      if (group && !group.artemis && saved.draft.paths.length && !saved.persisted) saver.update(props.projectId, groupId, saved.draft, undefined, true)
    }
  }, [props.projectId, props.groups, props.onProjectChange, setup, saver])
  return <FittingEditor key={key} {...props} onProjectChange={props.onProjectChange ? acceptProject : undefined}
    initial={cache.current.get(key)} actions={actions} onEditorActions={registerEditorActions} onMutationPending={pause} prepareMutation={prepareMutation}
    preserveDraft={!!props.projectId && !!props.group && saver.hasChanges(props.projectId, props.group.id)}
    onSave={(saved, dirty) => {
      cache.current.set(key, saved)
      if (props.projectId && props.group && props.onProjectChange) saver.update(props.projectId, props.group.id, saved.draft, props.group.artemis?.model, dirty)
    }} />
}

function FittingEditor({ projectId, version, group, pending = false, onFitResult, onPathsChange, onProjectChange, onViewStructure, onDirtyChange, initial, onSave, actions, onEditorActions, onMutationPending, prepareMutation, preserveDraft }: PanelProps & {
  initial?: SavedDraft; onSave: (saved: SavedDraft, dirty: boolean) => void
  actions: ArtemisModelActions; onEditorActions: (actions: EditorActions) => void
  onMutationPending: (busy: boolean) => void; prepareMutation: () => Promise<ModelMutation>
  preserveDraft: boolean
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    if (group?.artemis && (!initial?.base || artemisModelKey(initial.draft) === artemisModelKey(initial.base))) return group.artemis.model
    if (!group?.artemis && initial?.persisted && initial.base && artemisModelKey(initial.draft) === artemisModelKey(initial.base)) return newDraft()
    return initial?.draft ?? group?.artemis?.model ?? newDraft()
  })
  const base = useRef(group?.artemis?.model ?? (initial?.persisted ? draft : initial?.base ?? draft))
  const persisted = group?.artemis
  const previousSaved = useRef(persisted?.model)
  const [selectedFitId, setSelectedFitId] = useState(initial?.selectedFitId)
  const archive = persisted?.history.find(item => item.id === selectedFitId) ?? persisted?.history.at(-1)
  const modelDirty = artemisModelKey(draft) !== artemisModelKey(persisted?.model ?? base.current) || (!persisted && draft.paths.length > 0)
  const [result, setResult] = useState<SavedDraft["result"]>(initial?.result ?? null)
  const [busy, setBusy] = useState<"fit" | "upload" | "save" | "remove" | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const pathDetailsId = useId()
  const [expandedPathIds, setExpandedPathIds] = useState<Set<string>>(() => new Set())
  const [shellSelection, setShellSelection] = useState<FirstShellSelection | null>(null)
  const [radialContext, setRadialContext] = useState<RadialShellContext | null>(null)
  const radialState = useRadialShells(radialContext?.structure ?? null, radialContext?.siteIndex)
  const shellPathIds = useMemo(() => shellSelection ? draft.paths.filter(path => isFirstShellPath(path.metadata, shellSelection.structure, shellSelection.shell)).map(path => path.id) : [], [draft.paths, shellSelection])
  const controller = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const callbacks = useRef({ onFitResult, onPathsChange, onSave, onDirtyChange })
  callbacks.current = { onFitResult, onPathsChange, onSave, onDirtyChange }
  const reason = !projectId || !group ? "Select a spectrum to build an EXAFS fit."
    : pending ? "Waiting for spectrum processing…"
    : group.processing_error ? "Resolve this spectrum’s processing error before fitting."
    : !group.result?.arrays.k?.length || group.result.arrays.k.length !== group.result.arrays.chi?.length
      ? "EXAFS fitting requires processed χ(k). Select an EXAFS spectrum or process its background first." : ""
  const context = `${projectId}:${group?.id}:${version}:${draft.revision}:${reason}`
  const contextRef = useRef(context)
  contextRef.current = context
  const savedResult = useMemo(() => {
    if (!archive || !projectId || !group) return null
    let request: ArtemisFitRequest | undefined
    try { request = requestFromDraft(archive.model, archive.origin.project_version) } catch { /* Imported archives are inert, even if their model is incomplete. */ }
    return { ...archive.result, project_id: projectId, group_id: group.id, group_label: group.label,
      request,
      archive: { id: archive.id, created: archive.created, imported: archive.imported,
        stale: !persisted?.current_input_sha256 || persisted.current_input_sha256 !== archive.input_sha256,
        modelChanged: artemisModelKey(draft) !== artemisModelKey(archive.model), origin: archive.origin } }
  }, [archive, projectId, group?.id, group?.label, persisted?.current_input_sha256, draft])
  const currentResult = savedResult ?? (!reason && result?.revision === draft.revision && result.data.project_id === projectId &&
    result.data.group_id === group?.id && result.data.version === version ? result.data : null)

  useEffect(() => {
    const saved = persisted?.model
    if (saved === previousSaved.current) return
    previousSaved.current = saved
    // External saves and Undo/Redo update clean editors; unfinished edits stay in memory.
    const previousBase = base.current
    const nextBase = saved ?? newDraft()
    setDraft(previous => !preserveDraft && artemisModelKey(previous) === artemisModelKey(previousBase) ? nextBase : previous)
    base.current = nextBase
  }, [persisted?.model])

  useEffect(() => {
    callbacks.current.onSave({ draft, base: base.current, persisted: !!persisted, selectedFitId, result }, modelDirty)
    callbacks.current.onFitResult?.(currentResult)
    if (group) callbacks.current.onDirtyChange?.(group.id, modelDirty)
  }, [draft, result, currentResult, selectedFitId, modelDirty, group?.id, persisted])
  const localActions = useRef<EditorActions>({ importModel: () => {}, exportModel: () => {}, canExportModel: false })
  localActions.current = { importModel: () => modelInputRef.current?.click(), exportModel: saveModel, canExportModel: !!group && !busy && draft.paths.length > 0 }
  useEffect(() => {
    onEditorActions({ importModel: () => localActions.current.importModel(), exportModel: () => localActions.current.exportModel(), canExportModel: localActions.current.canExportModel })
  }, [group?.id, busy, draft.paths.length, onEditorActions])
  useEffect(() => { onMutationPending(!!busy); return () => onMutationPending(false) }, [busy, onMutationPending])
  useEffect(() => {
    callbacks.current.onPathsChange?.(draft.paths.map(({ id, label, filename, enabled, metadata }) => ({ id, label, filename, enabled, metadata })), projectId, group?.id)
  }, [draft.paths, projectId, group?.id])
  useEffect(() => {
    controller.current?.abort()
    setBusy(null)
    setError("")
    return () => { controller.current?.abort() }
  }, [projectId, group?.id, reason])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

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
  async function recoverConflict(error: unknown) {
    if (!(error instanceof ApiRequestError) || error.code !== "stale_revision" || !projectId || !onProjectChange) return false
    try {
      const updated = await athenaApi<AthenaProject>(`/projects/${encodeURIComponent(projectId)}`)
      onProjectChange(updated)
      setNotice("Project state refreshed after another change. Your unsaved model is retained; review it and retry saving or fitting.")
      return true
    } catch { return false }
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
  function saveModel() {
    try {
      const request = requestFromDraft(draft, version ?? 0)
      download("artemis-model.json", exportBundle(request, currentResult?.archive?.modelChanged ? null : currentResult, { project_id: projectId, group_id: group?.id, group_label: group?.label }))
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
        paths.push({ ...inspected, id: nextId(), label: path.label, enabled: path.enabled, s02: path.s02, e0: path.e0, deltar: path.deltar, sigma2: path.sigma2 })
      }
      const t = request.transform
      const imported = { revision: draft.revision + 1, paths, parameters: request.parameters.map(({ name, kind, value, min, max, expression }) => parameterDraft({ name, kind, value, min, max, expression })),
        transform: transformDraft({ fitspace: t.fitspace, window: t.window, kweight: t.kweight, kmin: t.kmin, kmax: t.kmax, dk: t.dk, rmin: t.rmin, rmax: t.rmax, dr: 0 }) }
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
    setBusy("fit")
    const mutation = await prepareMutation()
    if (!alive.current) { mutation.finish(); return }
    const mutationVersion = mutation.version
    request = { ...request, version: mutationVersion }
    const abort = begin("fit")
    const requestContext = contextRef.current
    setResult(null)
    try {
      if (onProjectChange) {
        // A mutation may commit after the user changes tabs. Receive its new version even then.
        const response = await artemisApi<{ project: AthenaProject; fit_id: string }>(`/projects/${encodeURIComponent(projectId)}/groups/${encodeURIComponent(group.id)}/fit-saved`, { version: mutationVersion, model: draft })
        const state = response.project?.groups.find(item => item.id === group.id)?.artemis
        const record = state?.history.find(item => item.id === response.fit_id)
        const apply = !abort.signal.aborted && contextRef.current === requestContext
        if (response.project?.id === projectId && response.project.version >= mutationVersion) onProjectChange(response.project)
        if (!record || !validArtemisResult(record.result, projectId, group.id, mutationVersion)) throw new Error("The fit result does not match this spectrum or contains invalid curves. Reload this project to check its saved history.")
        if (apply) {
          setDraft(state!.model)
          setSelectedFitId(record.id)
          setResult({ revision: draft.revision, data: { ...record.result, request } })
          setNotice("Saved the model and fit result in this project.")
        }
        return
      }
      const response = await artemisApi<ArtemisFitResult>(`/projects/${encodeURIComponent(projectId)}/groups/${encodeURIComponent(group.id)}/fit`, request, abort.signal)
      if (abort.signal.aborted || contextRef.current !== requestContext) return
      if (!validArtemisResult(response, projectId, group.id, mutationVersion)) throw new Error("The fit result does not match this spectrum or contains invalid curves. Try the fit again.")
      setResult({ revision: draft.revision, data: { ...response, request } })
    } catch (error) { if (!await recoverConflict(error) && !abort.signal.aborted && contextRef.current === requestContext) setError(errorText(error)) }
    finally { mutation.finish(); if (!abort.signal.aborted) setBusy(null) }
  }

  async function removeSavedFit(removeId: string) {
    if (!projectId || !group || version === undefined || !onProjectChange || busy || pending) return
    setBusy("remove")
    const mutation = await prepareMutation()
    if (!alive.current) { mutation.finish(); return }
    const mutationVersion = mutation.version
    const abort = begin("remove")
    const requestContext = contextRef.current
    try {
      const updated = await artemisApi<AthenaProject>(`/projects/${encodeURIComponent(projectId)}/groups/${encodeURIComponent(group.id)}/remove-fit`, { version: mutationVersion, fit_id: removeId })
      if (updated.id !== projectId || updated.version < mutationVersion) throw new Error("The project response is invalid. Reload this project before saving again.")
      if (!abort.signal.aborted && contextRef.current === requestContext) {
        setNotice("Removed the saved fit. Undo restores it.")
      }
      onProjectChange(updated)
    } catch (error) { if (!await recoverConflict(error) && !abort.signal.aborted) setError(errorText(error)) }
    finally { mutation.finish(); if (!abort.signal.aborted) setBusy(null) }
  }

  const disabled = !!busy || pending
  const freeCount = draft.parameters.filter(parameter => parameter.kind === "guess").length
  return <section className={styles.editor} aria-label="Artemis EXAFS fitting setup">
    <header className={styles.intro}><h3><FitCurvesIcon size={20} aria-hidden="true" />EXAFS fitting</h3><p>Artemis-style path models · Larch fitting core</p></header>
    <div className={styles.actions}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button type="button" className={styles.fitButton} onClick={fit} disabled={!!reason || version === undefined || !!busy || !draft.paths.some(path => path.enabled)}>{busy === "fit" ? "Fitting…" : error ? "Retry fit" : "Run EXAFS fit"}</button>
    </div>
    {notice && <p className={styles.message} role="status">{notice}</p>}
    {busy && <p className={styles.message} role="status">{busy === "fit" ? "Fitting with Larch…" : busy === "upload" ? "Reading FEFF paths…" : "Saving project…"}</p>}
    {currentResult && <p className={styles.message} role="status">{currentResult.success ? "Fit completed. Results are in the plot panel." : `Fit did not converge: ${currentResult.message}`}</p>}
    <p className={styles.spectrum}><span>Current spectrum</span><strong>{group?.label ?? "None selected"}</strong></p>
    {reason && <p className={styles.message} role="status">{reason}</p>}
    <input className={styles.fileInput} ref={modelInputRef} type="file" accept=".json,application/json" aria-label="Import Artemis model JSON" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void loadModel(file) }} />
    {onProjectChange && actions.status !== "saved" && <div className={styles.toolbar}>
      <p className={styles.help} aria-live="polite">{actions.status === "saving" ? "Saving model…" : actions.status === "pending" ? "Model changes waiting to save…" : "Model could not be saved."}</p>
      {actions.status === "failed" && <><p className={styles.error} role="alert">{actions.error}</p><button type="button" disabled={disabled} onClick={() => void actions.retry().catch(() => {})}>Retry saving model</button></>}
    </div>}
    {!!persisted?.history.length && <FittingSection title="Saved fit history" icon={History} summary={`${persisted.history.length}/10`} disabled={disabled}>
        <label>Saved fit history ({persisted.history.length}/10)<select aria-label="Saved fit history" disabled={disabled} value={archive?.id ?? ""} onChange={event => setSelectedFitId(event.target.value)}>
          {persisted.history.slice().reverse().map((item, i) => <option key={item.id} value={item.id}>Fit {persisted.history.length - i} · {new Date(item.created).toLocaleString()}{item.imported ? " · Imported" : ""}{item.input_sha256 !== persisted.current_input_sha256 ? " · Outdated input" : ""}</option>)}
        </select></label>
        <div className={styles.toolbar}><button type="button" disabled={disabled || !archive} onClick={() => { if (archive) edit(() => archive.model) }}>Use this fit’s model</button>
          <button type="button" disabled={disabled || !archive} onClick={() => { if (archive) void removeSavedFit(archive.id) }}>Remove saved fit</button></div>
        <p className={styles.help}>Up to 10 fits per spectrum. Export the project before removing history you want to keep. Removal can be undone.</p>
    </FittingSection>}
    <FittingSection title="Crystal structures" icon={CrystalLatticeIcon} summary="CIF">
    <ArtemisStructures contextKey={`${projectId}:${group?.id}`} projectId={projectId} version={version} onProjectChange={onProjectChange} prepareMutation={prepareMutation} onViewStructure={onViewStructure} onFirstShellChange={setShellSelection} onRadialContextChange={setRadialContext} disabled={disabled} existingPaths={draft.paths}
      availableSlots={24 - draft.paths.length} onAddPaths={paths => {
        if (disabled) return "Wait for the current fit or file operation to finish before adding paths."
        if (draft.paths.length + paths.length > 24) return "A model can contain up to 24 FEFF paths. Remove some existing paths first."
        const missing = defaultParameters.filter(parameter => !draft.parameters.some(existing => existing.name.trim() === parameter.name))
        if (draft.parameters.length + missing.length > 32) return "Adding these paths requires the amp, del_e0, del_r, and sig2 parameters. Remove unused parameters to leave room within the 32-parameter limit."
        edit(previous => ({ ...previous, paths: [...previous.paths, ...paths.map(path => ({ ...pathDraft(path), label: path.label }))],
          parameters: [...previous.parameters, ...missing.map(parameterDraft)] }))
        return null
      }} />
    </FittingSection>
    <FittingSection title="FEFF paths" icon={FeffScatteringIcon} summary={`${draft.paths.filter(path => path.enabled).length} included`} disabled={disabled}>
      {radialContext ? <>
        <RadialShellPanel state={radialState} disabled={disabled} />
        <p className={styles.help}>Groups are geometric candidates for {radialContext.structure.mineral || radialContext.structure.formula}, {radialState.data?.absorber ?? "absorber"} site {radialContext.siteIndex}. Confirm the CIF and site used to calculate imported paths. Group selection changes inclusion only; path expressions and fit bounds stay under your control.</p>
      </> : <p className={styles.help}>Open an attached CIF and choose its absorber site to see shell ranges and group path candidates.</p>}
      {shellSelection && <div className={styles.help}>
        <p>CrystalNN · {shellSelection.structure.mineral || shellSelection.structure.formula} · {shellSelection.shell.absorber} site {shellSelection.shell.site_index} · CN {shellSelection.shell.coordination_number}. {shellPathIds.length} first-shell path candidate{shellPathIds.length === 1 ? "" : "s"}.</p>
        <p>Candidates match the selected shell by element and atomic position. Confirm that the paths use this CIF and absorber site.</p>
        <button type="button" disabled={!shellPathIds.length || disabled} onClick={() => edit(previous => ({ ...previous, paths: previous.paths.map(path => ({ ...path, enabled: shellPathIds.includes(path.id) })) }))}>Use only first-shell candidates</button>
      </div>}
      <div className={styles.toolbar}>
        <button type="button" onClick={() => inputRef.current?.click()}><Upload size={13} />Add feff*.dat</button>
        <input ref={inputRef} className={styles.fileInput} type="file" multiple accept=".dat" aria-label="Upload FEFF path files"
          onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void upload(files) }} />
        {draft.paths.length > 1 && <div className={styles.pathViewActions}>
          <button type="button" aria-label="Expand all path details" disabled={draft.paths.every(path => expandedPathIds.has(path.id))} onClick={() => setExpandedPathIds(new Set(draft.paths.map(path => path.id)))}>Expand all</button>
          <button type="button" aria-label="Collapse all path details" disabled={!draft.paths.some(path => expandedPathIds.has(path.id))} onClick={() => setExpandedPathIds(new Set())}>Collapse all</button>
        </div>}
      </div>
      <RadialPathGroups paths={draft.paths} structure={radialContext?.structure ?? null} analysis={radialState.data} selectedIds={draft.paths.filter(path => path.enabled).map(path => path.id)} disabled={disabled} action="Include"
        onSelection={(ids, include) => edit(previous => ({ ...previous, paths: previous.paths.map(path => ids.includes(path.id) ? { ...path, enabled: include } : path) }))}
        onUseOnly={ids => edit(previous => ({ ...previous, paths: previous.paths.map(path => ({ ...path, enabled: ids.includes(path.id) })) }))}
        renderPath={(path, shell) => {
          const i = draft.paths.findIndex(item => item.id === path.id)
          const member = radialContext && radialState.data ? radialPathNeighbor(path.metadata, radialContext.structure, radialState.data) : undefined
          const expanded = expandedPathIds.has(path.id)
          const detailsId = `${pathDetailsId}-${path.id}`
          return <div className={styles.path} data-path-id={path.id}>
        <div className={styles.pathHeader}>
          <label className={styles.pathInclude} title={`Include ${path.filename} in the fit`}><input type="checkbox" checked={path.enabled} aria-label={`Include path ${i + 1}`} onChange={event => editPath(path.id, "enabled", event.target.checked)} /></label>
          <button type="button" className={styles.pathToggle} aria-label={`${expanded ? "Collapse" : "Expand"} path ${i + 1} details`} aria-expanded={expanded} aria-controls={detailsId}
            onClick={() => setExpandedPathIds(previous => { const next = new Set(previous); if (next.has(path.id)) next.delete(path.id); else next.add(path.id); return next })}>
            <ChevronRight size={14} className={styles.pathChevron} aria-hidden="true" />
            <span className={styles.pathIdentity}>
              <span className={styles.pathFilename} title={path.filename}>{path.filename}</span>
              <FeffPathShellLabel shell={shell} nleg={path.metadata.nleg} hasContext={!!radialContext} hasAnalysis={!!radialState.data} loading={radialState.loading} error={radialState.error} />
            </span>
          </button>
          <button type="button" aria-label={`Remove path ${i + 1}`} title={`Remove ${path.filename}`} onClick={() => edit(previous => ({ ...previous, paths: previous.paths.filter(item => item.id !== path.id) }))}><Trash2 size={13} /></button>
        </div>
        {path.label && path.label !== path.filename && <p className={styles.pathLabel} title={path.label}>{path.label}</p>}
        <p className={styles.metadata}>{path.metadata.absorber} {path.metadata.edge} · R<sub>eff</sub> {format(path.metadata.reff)} Å · N {format(path.metadata.degen)} · {path.metadata.nleg} legs</p>
        {shellPathIds.includes(path.id) && <p className={styles.metadata}><strong>CrystalNN first-shell candidate</strong></p>}
        {member && <p className={styles.metadata}>{member.element} pair {member.group_id}</p>}
        {/* Keep the inputs mounted so folding a path preserves edits and native undo. */}
        <div id={detailsId} className={styles.pathDetails} hidden={!expanded}>
        <label className={styles.fullField}>Path label<input value={path.label} aria-label={`Path ${i + 1} label`} onChange={event => editPath(path.id, "label", event.target.value)} /></label>
        <div className={styles.grid}>
          {([
            ["s02", "S₀²", "Amplitude factor; FEFF degeneracy N is already included."],
            ["e0", "ΔE₀ (eV)", "Fitted energy correction, separate from the Athena edge energy."],
            ["deltar", "ΔR (Å)", "Change in the FEFF effective half-path length."],
            ["sigma2", "σ² (Å²)", "Mean-square relative displacement."],
          ] as const).map(([field, label, title]) => <label key={field} title={title}>{label}<input value={path[field]} aria-label={`Path ${i + 1} ${label}`} onChange={event => editPath(path.id, field, event.target.value)} spellCheck={false} /></label>)}
        </div>
        </div>
      </div>}} />
      {draft.paths.length > 0 && <p className={styles.help}>N is fixed by FEFF; the amplitude is N × S₀². Shared parameter names couple paths. Give distinct shells their own ΔR and σ² parameters when needed.</p>}
    </FittingSection>

    <FittingSection title="Parameters" icon={SlidersHorizontal} summary={`${freeCount} free`} disabled={disabled}>
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
    </FittingSection>

    <FittingSection title="Fit range & transform" icon={FitRangeIcon} summary={draft.transform.fitspace === "r" ? "R space" : "k space"} disabled={disabled}>
      <div className={styles.choice} role="group" aria-label="Fit space">{(["r", "k"] as const).map(space => <button key={space} type="button" aria-pressed={draft.transform.fitspace === space} onClick={() => edit(previous => ({ ...previous, transform: { ...previous.transform, fitspace: space } }))}>{space === "r" ? "R space" : "k space"}</button>)}</div>
      <div className={styles.grid}>
        {([
          ["kmin", "k min (Å⁻¹)"], ["kmax", "k max (Å⁻¹)"], ["rmin", "R min (Å)"], ["rmax", "R max (Å)"], ["dk", "k taper dk (Å⁻¹)"],
        ] as const).map(([field, label]) => <label key={field}>{label}<input aria-label={label} inputMode="decimal" value={draft.transform[field]} onChange={event => edit(previous => ({ ...previous, transform: { ...previous.transform, [field]: event.target.value } }))} /></label>)}
        <label>k window<select value={draft.transform.window} aria-label="Fit k window" onChange={event => edit(previous => ({ ...previous, transform: { ...previous.transform, window: event.target.value as ArtemisTransform["window"] } }))}><option value="hanning">Hanning</option><option value="kaiser">Kaiser–Bessel</option><option value="parzen">Parzen</option><option value="welch">Welch</option></select></label>
      </div>
      <div className={styles.weights} role="group" aria-label="Fit k-weight"><span>Fit k-weight</span>{[0, 1, 2, 3].map(weight => <label key={weight}><input type="checkbox" aria-label={`Fit k-weight ${weight}`} checked={draft.transform.kweight.includes(weight)} onChange={event => edit(previous => ({ ...previous, transform: { ...previous.transform, kweight: (event.target.checked ? [...previous.transform.kweight, weight] : previous.transform.kweight.filter(value => value !== weight)).sort() } }))} />{weight}</label>)}</div>
      <p className={styles.help}>{draft.transform.fitspace === "r" ? "R fitting uses the real and imaginary components within the selected R range. " : "k fitting uses the selected k range; the R range sets the independent-point estimate. "}Multiple k-weights share one fit and do not add independent data.</p>
    </FittingSection>
  </section>
}
