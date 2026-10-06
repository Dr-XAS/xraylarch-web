"use client"

import { SectionHelp } from "./section-help"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Search, Trash2, Upload, X } from "lucide-react"
import { CifViewer } from "./artefact-viewers/cif-viewer"
import { useFirstShell } from "@/lib/use-first-shell"
import { isFirstShellPath, type FirstShellSelection } from "@/lib/first-shell"
import { useRadialShells } from "@/lib/use-radial-shells"
import { radialPathNeighbor, type RadialShellContext } from "@/lib/radial-shells"
import { RadialShellPanel } from "./radial-shell-panel"
import { RadialPathGroups } from "./radial-path-groups"
import { FeffPathShellLabel } from "./feff-path-shell-label"
import type { AthenaProject, EdgePair } from "@/lib/athena"
import { artemisApi, type ArtemisInspectedPath } from "@/lib/artemis"
import { parseFeffCluster } from "@/lib/feff-cluster"
import {
  downloadArtemisText, sameFeffRequest, sameStructure, structureLabel, type ArtemisFeffJob, type ArtemisFeffRequest, type ArtemisGeneratedPath,
  type ArtemisStructure, type ArtemisStructureSearchResult, type ArtemisStructureAttachment, type ArtemisProjectStructures,
} from "@/lib/artemis-structures"
import styles from "./artemis-structures.module.css"

interface Props {
  children?: (sections: { structures: ReactNode; feff: ReactNode }) => ReactNode
  contextKey: string
  spectrumEdge?: EdgePair | null
  projectId?: string
  version?: number
  onProjectChange?: (project: AthenaProject) => void
  prepareMutation?: () => Promise<{ version: number; finish: () => void }>
  onViewStructure?: (attachmentId: string, siteIndex?: number) => void
  onFirstShellChange?: (selection: FirstShellSelection | null) => void
  onRadialContextChange?: (selection: RadialShellContext | null) => void
  disabled?: boolean
  availableSlots: number
  existingPaths?: (Pick<ArtemisInspectedPath, "filename" | "content"> & { enabled?: boolean })[]
  // replace: the selected paths become the whole model instead of joining it.
  onAddPaths: (paths: ArtemisGeneratedPath[], replace?: boolean) => string | null
}
const errorText = (error: unknown) => error instanceof Error ? error.message : "The structure request failed. Please try again."
const numberText = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "—" : Number(value.toPrecision(5)).toString()
const feffEdges = ["K", "L1", "L2", "L3"] as const
function spectrumDefaults(structure: ArtemisStructure, spectrumEdge?: EdgePair | null) {
  if (!spectrumEdge) return { absorber: structure.elements[0] ?? "", site: "" }
  const sites = structure.sites.filter(item => item.element === spectrumEdge.element)
  const absorber = structure.elements.includes(spectrumEdge.element) && sites.length ? spectrumEdge.element : ""
  return { absorber, site: absorber && sites.length === 1 ? String(sites[0].index) : "" }
}

export function ArtemisStructures({ children, contextKey, spectrumEdge, projectId, version, onProjectChange, prepareMutation, onViewStructure, onFirstShellChange, onRadialContextChange, disabled = false, availableSlots, existingPaths, onAddPaths }: Props) {
  const [open, setOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<"structure" | "feff">("structure")
  const dialog = useRef<HTMLDialogElement>(null)
  const viewerAnchor = useRef<HTMLDivElement>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const dialogUploadInput = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const [attachments, setAttachments] = useState<ArtemisStructureAttachment[]>([])
  const [attachmentId, setAttachmentId] = useState<string | null>(null)
  const [listRevision, setListRevision] = useState(0)
  const [listError, setListError] = useState("")
  const [listLoading, setListLoading] = useState(false)
  const [query, setQuery] = useState("")
  const [provider, setProvider] = useState<"amcsd" | "materials_project">("amcsd")
  const [element, setElement] = useState("")
  const [search, setSearch] = useState<ArtemisStructureSearchResult | null>(null)
  const [structure, setStructure] = useState<ArtemisStructure | null>(null)
  const [absorber, setAbsorber] = useState("")
  const [site, setSite] = useState("")
  const manualAbsorber = useRef(false)
  const spectrumIdentity = useRef(spectrumEdge)
  spectrumIdentity.current = spectrumEdge
  const shellState = useFirstShell(structure, site ? Number(site) : undefined)
  const radialState = useRadialShells(structure, site ? Number(site) : undefined)
  const radialCallback = useRef(onRadialContextChange)
  radialCallback.current = onRadialContextChange
  useEffect(() => {
    radialCallback.current?.(structure && attachmentId && site ? { structure, attachmentId, siteIndex: Number(site) } : null)
  }, [structure, attachmentId, site])
  const shellCallback = useRef(onFirstShellChange)
  shellCallback.current = onFirstShellChange
  useEffect(() => {
    shellCallback.current?.(structure && attachmentId && shellState.shell ? { structure, attachmentId, shell: shellState.shell } : null)
  }, [structure, attachmentId, shellState.shell])
  const [edgeChoice, setEdgeChoice] = useState<{ contextKey: string; projectId?: string; absorber: string; edge: ArtemisFeffRequest["edge"] } | null>(null)
  const defaultEdge = spectrumEdge && (!absorber || spectrumEdge.element === absorber) ? feffEdges.find(item => item === spectrumEdge.edge) ?? "" : "K"
  // An explicit choice belongs to this spectrum and absorbing element. Otherwise use its recorded edge.
  const edge = edgeChoice?.contextKey === contextKey && edgeChoice.projectId === projectId && edgeChoice.absorber === absorber ? edgeChoice.edge : defaultEdge
  const previousEdge = useRef(edge)
  const [clusterRadius, setClusterRadius] = useState("5")
  const [pathRadius, setPathRadius] = useState("4")
  const [maxLegs, setMaxLegs] = useState("4")
  const [maxPaths, setMaxPaths] = useState("60")
  const [busy, setBusy] = useState<"search" | "structure" | "job" | "attach" | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [job, setJob] = useState<ArtemisFeffJob | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [added, setAdded] = useState<string[]>([])
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [pollRevision, setPollRevision] = useState(0)
  const lookupAbort = useRef<AbortController | null>(null)
  const jobAbort = useRef<AbortController | null>(null)
  const attachAbort = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const generation = useRef(0)
  const context = useRef(contextKey)
  context.current = contextKey
  const callback = useRef(onAddPaths)
  callback.current = onAddPaths
  const projectCallback = useRef(onProjectChange)
  projectCallback.current = onProjectChange
  const viewCallback = useRef(onViewStructure)
  viewCallback.current = onViewStructure
  const currentProject = useRef(projectId)
  currentProject.current = projectId
  const attachPending = busy === "attach"
  const mutationPending = attachPending || removingId !== null
  const controlsDisabled = disabled || mutationPending
  const addedIds = existingPaths === undefined ? added : job?.paths.filter(path => existingPaths.some(existing => existing.filename === path.filename && existing.content === path.content)).map(path => path.id) ?? []
  // Replace swaps the whole model, so its selection may fill the model and may
  // keep a generated path already in it; Add only fills the open slots.
  const canReplace = !!existingPaths?.length
  const selectionLimit = canReplace ? availableSlots + existingPaths!.length : availableSlots
  const newSelected = selected.filter(id => !addedIds.includes(id))

  function openDialog(mode: "structure" | "feff" = "structure") {
    setDialogMode(mode)
    if (!open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(true)
    setListRevision(previous => previous + 1)
  }
  function closeDialog() {
    if (mutationPending) return
    setOpen(false)
  }
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    else if (!open && element.open) {
      element.close()
      if (opener.current?.isConnected) opener.current.focus()
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => { document.body.style.overflow = overflow }
  }, [open])
  useEffect(() => { setAttachments([]) }, [projectId])
  useEffect(() => {
    if (open && attachmentId) viewerAnchor.current?.scrollIntoView?.({ block: "start" })
  }, [open, attachmentId])

  useEffect(() => {
    if (!projectId) { setAttachments([]); return }
    const abort = new AbortController()
    setListLoading(true)
    setListError("")
    artemisApi<ArtemisProjectStructures>(`/projects/${encodeURIComponent(projectId)}/structures`, undefined, abort.signal)
      .then(response => {
        if (abort.signal.aborted || currentProject.current !== projectId) return
        if (response.project_id !== projectId || !Array.isArray(response.structures)) throw new Error("The attached CIF list does not match this project. Try again.")
        setAttachments(response.structures)
        if (attachmentId && !response.structures.some(item => item.id === attachmentId)) clearSelectedAttachment()
      })
      .catch(error => { if (!abort.signal.aborted && currentProject.current === projectId) setListError(errorText(error)) })
      .finally(() => { if (!abort.signal.aborted && currentProject.current === projectId) setListLoading(false) })
    return () => abort.abort()
  }, [projectId, version, listRevision])

  function openAttachment(attachment: ArtemisStructureAttachment, mode: "structure" | "feff" = "structure") {
    if (mutationPending) return
    const defaults = spectrumDefaults(attachment.structure, spectrumEdge)
    if (attachmentId !== attachment.id) {
      manualAbsorber.current = false
      lookupAbort.current?.abort()
      sequence.current += 1
      invalidateJob()
      setStructure(attachment.structure)
      setAttachmentId(attachment.id)
      setAbsorber(defaults.absorber)
      setSite(defaults.site)
      setBusy(null)
    }
    const selectedSite = attachmentId === attachment.id ? site : defaults.site
    viewCallback.current?.(attachment.id, selectedSite ? Number(selectedSite) : undefined)
    openDialog(mode)
  }

  function openFeffDialog() {
    if (!attachmentId && attachments.length === 1) openAttachment(attachments[0], "feff")
    else openDialog("feff")
  }

  function invalidateJob() {
    generation.current += 1
    jobAbort.current?.abort()
    setJob(null)
    setSelected([])
    setAdded([])
    setError("")
    setNotice("")
    setBusy(previous => previous === "job" ? null : previous)
  }
  useEffect(() => {
    if (previousEdge.current === edge) return
    previousEdge.current = edge
    invalidateJob()
  }, [edge])
  useEffect(() => {
    if (!structure || manualAbsorber.current) return
    const defaults = spectrumDefaults(structure, spectrumEdge)
    if (absorber === defaults.absorber && site === defaults.site) return
    invalidateJob()
    setAbsorber(defaults.absorber)
    setSite(defaults.site)
    if (attachmentId) viewCallback.current?.(attachmentId, defaults.site ? Number(defaults.site) : undefined)
    // Follow late spectrum identity updates until the user makes an explicit choice.
  }, [structure, spectrumEdge?.element])
  function clearSelectedAttachment() {
    manualAbsorber.current = false
    lookupAbort.current?.abort()
    sequence.current += 1
    invalidateJob()
    setStructure(null)
    setAttachmentId(null)
    setAbsorber("")
    setSite("")
  }
  useEffect(() => {
    manualAbsorber.current = false
    sequence.current += 1
    generation.current += 1
    lookupAbort.current?.abort()
    jobAbort.current?.abort()
    attachAbort.current?.abort()
    setOpen(false)
    setSearch(null)
    setStructure(null)
    setJob(null)
    setSelected([])
    setAdded([])
    setAbsorber("")
    setEdgeChoice(null)
    setSite("")
    setAttachmentId(null)
    setBusy(null)
    setRemovingId(null)
    setError("")
    setNotice("")
    return () => { lookupAbort.current?.abort(); jobAbort.current?.abort(); attachAbort.current?.abort() }
  }, [contextKey, projectId])

  async function findStructures() {
    if (controlsDisabled || (!query.trim() && !element.trim())) return
    lookupAbort.current?.abort()
    invalidateJob()
    const abort = new AbortController()
    lookupAbort.current = abort
    const request = ++sequence.current
    const requestContext = contextKey
    setBusy("search")
    setStructure(null)
    setAttachmentId(null)
    setSearch(null)
    const params = new URLSearchParams({ q: query.trim(), limit: "25" })
    if (provider !== "amcsd") params.set("provider", provider)
    if (element.trim()) params.set("element", element.trim())
    try {
      const response = await artemisApi<ArtemisStructureSearchResult>(`/structures?${params}`, undefined, abort.signal)
      if (abort.signal.aborted || sequence.current !== request || context.current !== requestContext) return
      setSearch(response)
    } catch (error) { if (!abort.signal.aborted && sequence.current === request && context.current === requestContext) setError(errorText(error)) }
    finally { if (!abort.signal.aborted && sequence.current === request && context.current === requestContext) setBusy(null) }
  }
  async function selectStructure(id: number | string) {
    if (controlsDisabled) return
    const attached = attachments.find(item => sameStructure(item.structure, { ...item.structure, id, provider }))
    if (attached) { openAttachment(attached); return }
    manualAbsorber.current = false
    lookupAbort.current?.abort()
    invalidateJob()
    const abort = new AbortController()
    lookupAbort.current = abort
    const request = ++sequence.current
    const requestContext = contextKey
    setBusy("structure")
    setStructure(null)
    setAttachmentId(null)
    setAbsorber("")
    setSite("")
    try {
      const response = await artemisApi<ArtemisStructure>(`/structures/${encodeURIComponent(id)}${provider === "materials_project" ? "?provider=materials_project" : ""}`, undefined, abort.signal)
      if (abort.signal.aborted || sequence.current !== request || context.current !== requestContext) return
      if (response.id !== id || (response.provider ?? "amcsd") !== provider) throw new Error("The returned CIF does not match the selected record. Select the structure again.")
      setStructure(response)
      const defaults = spectrumDefaults(response, spectrumIdentity.current)
      setAbsorber(defaults.absorber)
      setSite(defaults.site)
    } catch (error) { if (!abort.signal.aborted && sequence.current === request && context.current === requestContext) setError(errorText(error)) }
    finally { if (!abort.signal.aborted && sequence.current === request && context.current === requestContext) setBusy(null) }
  }
  async function attachStructure(file?: File) {
    if ((!structure && !file) || !projectId || version === undefined || controlsDisabled || !projectCallback.current) return
    const requestContext = contextKey
    const requestProject = projectId
    const selectedStructure = structure
    const receiveProject = projectCallback.current
    let mutation: { version: number; finish: () => void } | undefined
    const abort = new AbortController()
    attachAbort.current?.abort()
    attachAbort.current = abort
    setBusy("attach")
    if (file) setDialogMode("structure")
    setError("")
    setNotice("")
    lookupAbort.current?.abort()
    sequence.current += 1
    try {
      let identity: { provider?: string; material_id?: number | string; amcsd_id?: number | string; filename?: string; cif?: string }
      if (file) {
        if (!/\.cif$/i.test(file.name)) throw new Error("Choose a .cif file.")
        if (file.size > 500_000) throw new Error("Each attached CIF must be at most 500 KB.")
        identity = { provider: "uploaded", filename: file.name, cif: await file.text() }
      } else {
        identity = selectedStructure!.provider === "materials_project" ? { provider: "materials_project", material_id: selectedStructure!.id } : { amcsd_id: selectedStructure!.id }
      }
      if (abort.signal.aborted || context.current !== requestContext || currentProject.current !== requestProject) return
      mutation = prepareMutation ? await prepareMutation() : { version, finish: () => {} }
      if (abort.signal.aborted || context.current !== requestContext || currentProject.current !== requestProject) return
      // Receive committed project revisions even if the spectrum changes during the request.
      const response = await artemisApi<AthenaProject & { artemis_structures?: ArtemisStructureAttachment[] }>(`/projects/${encodeURIComponent(projectId)}/structures`, { version: mutation.version, ...identity })
      const attached = response.artemis_structures?.find(item => file ? item.provider === "uploaded" && item.structure.cif === identity.cif : sameStructure(item.structure, selectedStructure!))
      if (response.id !== requestProject || response.version < mutation.version || !attached) throw new Error("The saved CIF response does not match this project. Refresh the attachment list before retrying.")
      if (abort.signal.aborted || context.current !== requestContext || currentProject.current !== requestProject) { receiveProject(response); return }
      if (file) {
        invalidateJob()
        manualAbsorber.current = false
        const defaults = spectrumDefaults(attached.structure, spectrumIdentity.current)
        setAbsorber(defaults.absorber)
        setSite(defaults.site)
        openDialog("structure")
      }
      setAttachments(response.artemis_structures ?? [])
      setStructure(attached.structure)
      setAttachmentId(attached.id)
      setNotice(`${attached.structure.mineral || attached.structure.formula} CIF attached to the current project.`)
      receiveProject(response)
      const selectedSite = manualAbsorber.current ? site : spectrumDefaults(attached.structure, spectrumIdentity.current).site
      viewCallback.current?.(attached.id, selectedSite && attached.structure.sites.some(item => item.index === Number(selectedSite)) ? Number(selectedSite) : undefined)
      setListRevision(previous => previous + 1)
    } catch (error) { if (!abort.signal.aborted && context.current === requestContext && currentProject.current === requestProject) setError(errorText(error)) }
    finally { mutation?.finish(); if (!abort.signal.aborted && context.current === requestContext && currentProject.current === requestProject) setBusy(null) }
  }
  function uploadControl(inDialog = false) {
    const input = inDialog ? dialogUploadInput : uploadInput
    return <><button type="button" disabled={controlsDisabled || !projectId || version === undefined || !onProjectChange} onClick={() => input.current?.click()}><Upload size={14} />{attachPending ? "Attaching CIF…" : "Upload CIF"}</button><input ref={input} type="file" accept=".cif" aria-label={inDialog ? "Upload CIF file in dialog" : "Upload CIF file"} hidden disabled={controlsDisabled} onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ""
      if (file) void attachStructure(file)
    }} /></>
  }
  async function removeAttachment(attachment: ArtemisStructureAttachment) {
    if (!projectId || version === undefined || controlsDisabled || !projectCallback.current) return
    const requestContext = contextKey
    const requestProject = projectId
    const receiveProject = projectCallback.current
    let mutation: { version: number; finish: () => void } | undefined
    const abort = new AbortController()
    attachAbort.current?.abort()
    attachAbort.current = abort
    lookupAbort.current?.abort()
    sequence.current += 1
    setRemovingId(attachment.id)
    setError("")
    setNotice("")
    try {
      mutation = prepareMutation ? await prepareMutation() : { version, finish: () => {} }
      if (abort.signal.aborted || context.current !== requestContext || currentProject.current !== requestProject) return
      const response = await artemisApi<AthenaProject>(`/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(attachment.id)}/remove`, { version: mutation.version })
      if (response.id !== requestProject || response.version <= mutation.version || !Array.isArray(response.artemis_structures) || response.artemis_structures.some(item => item.id === attachment.id)) {
        throw new Error("The removed CIF response does not match this project. Reload the attachment list before retrying.")
      }
      if (abort.signal.aborted || context.current !== requestContext || currentProject.current !== requestProject) { receiveProject(response); return }
      setAttachments(response.artemis_structures)
      if (attachmentId === attachment.id) clearSelectedAttachment()
      setNotice(`${attachment.structure.mineral || attachment.structure.formula} CIF removed from this project. Existing FEFF paths are kept. Undo restores the CIF.`)
      receiveProject(response)
      setListRevision(previous => previous + 1)
    } catch (error) { if (!abort.signal.aborted && context.current === requestContext && currentProject.current === requestProject) setError(errorText(error)) }
    finally { mutation?.finish(); if (!abort.signal.aborted && context.current === requestContext && currentProject.current === requestProject) { setRemovingId(null); setBusy(previous => previous === "search" || previous === "structure" ? null : previous) } }
  }
  function removeButton(attachment: ArtemisStructureAttachment) {
    const name = attachment.structure.mineral || attachment.structure.formula
    return <button type="button" className={styles.removeButton} disabled={controlsDisabled || version === undefined || !onProjectChange}
      aria-label={`Remove ${name} CIF from project`} title="Remove this CIF from the project. Existing FEFF paths are kept; Undo restores the CIF."
      onClick={() => void removeAttachment(attachment)}><Trash2 size={14} aria-hidden="true" />{removingId === attachment.id ? "Removing CIF…" : "Remove CIF"}</button>
  }
  async function generate() {
    if (!structure || !structure.supported || controlsDisabled || site === "" || !absorber || !edge || !attachmentId || !projectId || version === undefined) return
    const request: ArtemisFeffRequest = {
      project_id: projectId, attachment_id: attachmentId, version, absorber, edge, site_index: Number(site), cluster_radius: Number(clusterRadius),
      path_radius: Number(pathRadius), max_legs: Number(maxLegs), max_paths: Number(maxPaths),
    }
    if (!clusterRadius.trim() || !pathRadius.trim() || !maxPaths.trim() || !Number.isFinite(request.cluster_radius) || request.cluster_radius < 3 || request.cluster_radius > 6 ||
      !Number.isFinite(request.path_radius) || request.path_radius < 2 || request.path_radius > 6 || request.path_radius > request.cluster_radius ||
      !Number.isInteger(request.max_paths) || request.max_paths < 1 || request.max_paths > 100) {
      setError("Use a cluster radius of 3–6 Å, a path radius of 2 Å up to the cluster radius, and 1–100 paths.")
      return
    }
    invalidateJob()
    const token = generation.current
    const requestContext = contextKey
    const abort = new AbortController()
    jobAbort.current = abort
    setBusy("job")
    try {
      const response = await artemisApi<ArtemisFeffJob>("/feff/jobs", request, abort.signal)
      if (abort.signal.aborted || generation.current !== token || context.current !== requestContext) return
      if (!sameFeffRequest(response.request, request)) throw new Error("The FEFF calculation does not match the selected structure and settings. Generate the paths again.")
      setJob(response)
    } catch (error) { if (!abort.signal.aborted && generation.current === token && context.current === requestContext) setError(errorText(error)) }
    finally { if (!abort.signal.aborted && generation.current === token && context.current === requestContext) setBusy(null) }
  }

  useEffect(() => {
    if (!job || job.status !== "running") return
    const abort = new AbortController()
    jobAbort.current = abort
    const token = generation.current
    const requestContext = contextKey
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const response = await artemisApi<ArtemisFeffJob>(`/feff/jobs/${encodeURIComponent(job!.id)}`, undefined, abort.signal)
        if (abort.signal.aborted || generation.current !== token || context.current !== requestContext) return
        if (response.id !== job!.id || !sameFeffRequest(response.request, job!.request)) throw new Error("The FEFF status does not match this calculation. Generate the paths again.")
        setJob(response)
        if (response.status === "running") timer = setTimeout(poll, 1200)
      } catch (error) { if (!abort.signal.aborted && generation.current === token && context.current === requestContext) setError(`${errorText(error)} Use “Check status” to reconnect.`) }
    }
    timer = setTimeout(poll, 1200)
    return () => { abort.abort(); if (timer) clearTimeout(timer) }
  }, [job?.id, job?.status, contextKey, pollRevision])

  function addPaths(replace = false) {
    if (!job || job.status !== "complete" || controlsDisabled || !selected.length) return
    if (!replace && newSelected.length > availableSlots) { setError(`This model has room for ${availableSlots} more path${availableSlots === 1 ? "" : "s"}. Select fewer paths or remove existing ones.`); return }
    const viewerCluster = parseFeffCluster(job.provenance?.feff_input)
    const paths = job.paths.filter(path => selected.includes(path.id) && (replace || !addedIds.includes(path.id))).map(path => {
      const suffix = ` · ${structureLabel(job.provenance.structure)} · ${job.request.absorber} site ${job.request.site_index} · ${path.filename}`
      const mineral = job.provenance.structure.mineral || job.provenance.structure.formula || "Structure"
      return { filename: path.filename, content: path.content, metadata: viewerCluster ? { ...path.metadata, viewerCluster } : path.metadata, label: mineral.slice(0, Math.max(0, 120 - suffix.length)) + suffix }
    })
    const error = replace ? callback.current(paths, true) : callback.current(paths)
    if (error) { setError(error); return }
    setAdded(previous => replace ? [...selected] : [...previous, ...selected])
    setSelected([])
    setError("")
    const count = `${paths.length} generated path${paths.length === 1 ? "" : "s"}`
    // Adding joins the model: a path already there (an uploaded feff*.dat of
    // the same shell, say) is still included and fitted alongside.
    const others = replace ? [] : otherIncluded.map(path => path.filename)
    setNotice(replace ? `Replaced the fit model's paths with ${count}. Review the path expressions before fitting.`
      : others.length ? `Added ${count}. The model's earlier path${others.length === 1 ? "" : "s"} ${others.join(", ")} ${others.length === 1 ? "is" : "are"} still included and will be fitted with ${paths.length === 1 ? "it" : "them"}; untick ${others.length === 1 ? "it" : "them"} under FEFF paths to fit the generated path${paths.length === 1 ? "" : "s"} alone.`
      : `Added ${count} to the current fit model. Review the path expressions before fitting.`)
  }
  // Included paths in the model that did not come from this calculation.
  const otherIncluded = (existingPaths ?? []).filter(existing => existing.enabled !== false
    && !job?.paths.some(path => path.filename === existing.filename && path.content === existing.content))

  const sites = structure?.sites.filter(item => item.element === absorber) ?? []
  const shellPaths = job?.status === "complete" && structure && shellState.shell && job.provenance.cif === structure.cif && job.request.site_index === shellState.shell.site_index
    ? job.paths.filter(path => isFirstShellPath(path.metadata, structure, shellState.shell!)).map(path => path.id) : []
  const jobRadial = job?.status === "complete" && radialState.data && job.provenance.cif === radialState.data.cif && job.request.site_index === radialState.data.site_index && job.request.absorber === radialState.data.absorber ? radialState.data : null
  function chooseSite(index: number) {
    if (controlsDisabled) return
    manualAbsorber.current = true
    invalidateJob()
    setAbsorber(structure!.sites.find(item => item.index === index)!.element)
    setSite(String(index))
    if (attachmentId) viewCallback.current?.(attachmentId, index)
  }
  const working = busy === "job" || job?.status === "running"
  const structures = <section className={styles.panel} aria-label="Project CIF structures">
    <div className={styles.toolbar}><button type="button" className={styles.openButton} disabled={controlsDisabled || !projectId} onClick={() => openDialog()}><Search size={14} />Search / attach CIF</button>{uploadControl()}</div>
    {listLoading && !attachments.length && <p className={styles.help}>Loading attached CIFs…</p>}
    {!projectId ? <p className={styles.help}>Select a project to attach crystal structures.</p> : !listLoading && !attachments.length && <p className={styles.help}>No CIF structures attached to this project.</p>}
    {attachments.length > 0 && <ul className={styles.attachedList}>{attachments.map(item => <li key={item.id}><span className={styles.attachmentInfo}><strong>{item.structure.mineral || item.structure.formula}</strong><small>{structureLabel(item.structure)}</small></span><div className={styles.attachedActions}><button type="button" disabled={controlsDisabled} onClick={() => openAttachment(item)} aria-label={`Open attached ${item.structure.mineral || item.structure.formula} CIF`}>Open</button>{removeButton(item)}</div></li>)}</ul>}
    {listError && !open && <p className={styles.error}>{listError}<button type="button" onClick={() => setListRevision(previous => previous + 1)}>Reload attached CIFs</button></p>}
    {error && !open && dialogMode === "structure" && <p className={styles.error} role="alert">{error}</p>}
    {notice && !open && dialogMode === "structure" && <p className={styles.status} role="status">{notice}</p>}
  </section>
  const feff = <div className={styles.feffLauncher}>
    <button type="button" className={styles.primaryButton} disabled={controlsDisabled || !projectId} onClick={openFeffDialog}>Generate FEFF paths</button>
    {!listLoading && !attachments.length && <p className={styles.help}>Attach a CIF in Crystal structures to calculate paths.</p>}
    {error && !open && dialogMode === "feff" && <p className={styles.error} role="alert">{error}</p>}
    {notice && !open && dialogMode === "feff" && <p className={styles.status} role="status">{notice}</p>}
  </div>
  return <>
    {children ? children({ structures, feff }) : <>{structures}{feff}</>}
    <dialog ref={dialog} className={`${styles.panel} ${styles.dialog}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); closeDialog() }} onClose={() => { setOpen(false); if (opener.current?.isConnected) opener.current.focus() }}>
      <header className={styles.dialogHeader}><div><h3 id={titleId}>{dialogMode === "feff" ? "FEFF paths" : "Crystal structures"}<SectionHelp label={dialogMode === "feff" ? "FEFF path generation" : "Crystal structures"}>{dialogMode === "feff" ? "Choose an attached CIF and absorber site, calculate paths, then add selected paths to the model. Closing this window keeps your calculation progress." : "Search and attach CIF structures to your project. Generate scattering paths from the FEFF paths section."}</SectionHelp></h3></div><button type="button" aria-label={dialogMode === "feff" ? "Close FEFF paths" : "Close CIF search"} disabled={mutationPending} onClick={closeDialog}><X size={18} /></button></header>
      {dialogMode === "feff" && attachmentId && (structure?.supported || job?.status === "complete") && <div className={styles.dialogActions} role="group" aria-label="FEFF path actions">
        {structure?.supported && <button type="button" className={styles.primaryButton} onClick={generate} disabled={controlsDisabled || !attachmentId || site === "" || !absorber || !edge || working}>{working ? "Calculating FEFF…" : job?.status === "failed" ? "Retry FEFF calculation" : "Run FEFF calculation"}</button>}
        {job?.status === "complete" && <button type="button" className={styles.primaryButton} disabled={controlsDisabled || !newSelected.length || newSelected.length > availableSlots} onClick={() => addPaths()}>Add selected paths ({newSelected.length})</button>}
        {job?.status === "complete" && canReplace && <button type="button" disabled={controlsDisabled || !selected.length} onClick={() => addPaths(true)}>Replace the model’s {existingPaths.length} path{existingPaths.length === 1 ? "" : "s"} with selected ({selected.length})</button>}
      </div>}
      <div className={`${styles.content} ${dialogMode === "feff" ? styles.feffContent : ""}`}>
      {dialogMode === "structure" && <div className={styles.searchColumn}>
      <div className={styles.toolbar}>{uploadControl(true)}<SectionHelp label="Upload your CIF">Attach one .cif file (up to 500 KB). The project retains the original CIF and filename. FEFF requires an ordered crystal structure.</SectionHelp></div>
      {listError && <p className={styles.error} role="alert">{listError}<button type="button" onClick={() => setListRevision(previous => previous + 1)}>Reload attached CIFs</button></p>}
      <label className={styles.provider}>Source<select aria-label="Structure source" value={provider} disabled={controlsDisabled} onChange={event => {
        clearSelectedAttachment(); setBusy(null); setSearch(null); setProvider(event.target.value as typeof provider)
      }}><option value="amcsd">AMCSD</option><option value="materials_project">Materials Project</option></select></label>
      <div className={styles.searchFields}>
        <label><span>{provider === "materials_project" ? "Formula, chemical system, or MP ID" : "Mineral, formula, or AMCSD ID"}<SectionHelp label="Structure search">{provider === "materials_project" ? "Search Materials Project: Cu2O for a formula, Cu-O for that chemical system, or mp-30 for a material. The element filter includes compounds containing that element." : "Search the local AMCSD database snapshot."}</SectionHelp></span><input aria-label={provider === "materials_project" ? "Materials Project search query" : "AMCSD search query"} value={query} placeholder={provider === "materials_project" ? "e.g. Cu2O, Cu-O, mp-30" : "e.g. copper or 13088"} disabled={controlsDisabled}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void findStructures() } }} /></label>
        <label>Contains element<input aria-label={provider === "materials_project" ? "Materials Project element filter" : "AMCSD element filter"} value={element} placeholder="e.g. Cu" maxLength={2} disabled={controlsDisabled} onChange={event => setElement(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void findStructures() } }} /></label>
      </div>
      <button type="button" disabled={controlsDisabled || busy === "search" || (!query.trim() && !element.trim())} onClick={findStructures}><Search size={13} />{busy === "search" ? "Searching…" : provider === "materials_project" ? "Search Materials Project" : "Search AMCSD"}</button>
      {search && <div className={styles.searchResults}>
        <p className={styles.help}>{search.results.length ? `${search.results.length} result${search.results.length === 1 ? "" : "s"}${search.limited ? " · refine the search for more" : ""}` : "No matching structures. Try another formula, element, or source ID."}</p>
        {search.results.map(item => <button type="button" key={item.id} disabled={controlsDisabled} className={styles.result} aria-pressed={!!structure && sameStructure(structure, item)} onClick={() => selectStructure(item.id)}>
          <strong>{item.mineral || item.formula}</strong><span>{item.formula} · {item.space_group}</span><small>{structureLabel(item)}{item.provider === "materials_project" ? " · DFT-relaxed" : item.year ? ` · ${item.year}` : ""}</small>
        </button>)}
        {search.source && <p className={styles.source}>{search.source}</p>}
      </div>}
      {attachments.length > 0 && <div className={styles.savedStructures}><h4>Attached to this project</h4>{attachments.map(item => <div key={item.id} className={styles.savedStructureRow}><button type="button" className={styles.result} disabled={controlsDisabled} aria-pressed={attachmentId === item.id} onClick={() => openAttachment(item)} aria-label={`Use attached ${item.structure.mineral || item.structure.formula} CIF`}><strong>{item.structure.mineral || item.structure.formula}</strong><small>{structureLabel(item.structure)} · Saved CIF</small></button>{removeButton(item)}</div>)}</div>}
      </div>}
      <div className={styles.detailColumn}>
      {dialogMode === "feff" && <>
        <label className={styles.provider}>Crystal structure<select aria-label="FEFF crystal structure" value={attachmentId ?? ""} disabled={controlsDisabled || listLoading} onChange={event => {
          const attachment = attachments.find(item => item.id === event.target.value)
          if (attachment) openAttachment(attachment, "feff")
        }}><option value="" disabled>Choose an attached CIF</option>{attachments.map(item => <option key={item.id} value={item.id}>{item.structure.mineral || item.structure.formula} · {structureLabel(item.structure)}</option>)}</select></label>
        {listError && <p className={styles.error} role="alert">{listError}<button type="button" onClick={() => setListRevision(previous => previous + 1)}>Reload attached CIFs</button></p>}
        {!attachmentId && <p className={styles.placeholder}>{attachments.length ? "Choose an attached CIF to configure the FEFF calculation." : "Attach a CIF in Crystal structures, then return here to calculate paths."}</p>}
      </>}
      {dialogMode === "structure" && !structure && busy !== "structure" && <p className={styles.placeholder}>Upload a CIF, select a search result, or open a CIF already attached to this project.</p>}
      {busy === "structure" && <p className={styles.status} role="status">Reading CIF and inequivalent atomic sites…</p>}
      {structure && (dialogMode === "structure" || attachmentId) && <div className={styles.structure}>
        <h4>{structure.mineral}{structure.title && <SectionHelp label="CIF citation">{structure.title}<br />{structure.authors}{structure.year ? ` (${structure.year})` : ""}{structure.journal ? ` · ${structure.journal}` : ""}</SectionHelp>} <span>{structureLabel(structure)}</span></h4>
        {structure.provider === "materials_project" && <p className={styles.help}>DFT-relaxed structure · <a href={`https://materialsproject.org/materials/${encodeURIComponent(structure.id)}`} target="_blank" rel="noreferrer">View on Materials Project</a><br />Database version: {structure.provenance?.database_version ?? "unavailable"}. Saved CIFs retain the retrieved geometry.</p>}
        {open && attachmentId && <div ref={viewerAnchor}><CifViewer key={attachmentId} structure={structure} selectedSite={site ? Number(site) : undefined} analysis={shellState} radialAnalysis={radialState} /></div>}
        <p className={styles.help}>{structure.formula} · {structure.space_group}<br />a {numberText(structure.cell.a)}, b {numberText(structure.cell.b)}, c {numberText(structure.cell.c)} Å<br />α {numberText(structure.cell.alpha)}, β {numberText(structure.cell.beta)}, γ {numberText(structure.cell.gamma)}°</p>
        {dialogMode === "structure" && <div className={styles.toolbar}><button type="button" className={styles.attachButton} disabled={controlsDisabled || !!attachmentId || !projectId || version === undefined || !onProjectChange} onClick={() => void attachStructure()}>{attachPending ? "Attaching CIF…" : attachmentId ? "Attached to project" : "Attach to project"}</button><SectionHelp label="Attach CIF">Attach this CIF to the project before generating FEFF paths. The saved CIF belongs to the current project; FEFF uses the attached snapshot.</SectionHelp></div>}
        <details className={styles.textDetails}><summary>View CIF</summary><pre>{structure.cif}</pre></details>
        {structure.warnings.map((warning, i) => <p className={styles.warning} key={i}>{warning}</p>)}
        {!structure.supported ? <p className={styles.warning} role="status">This structure cannot be used for FEFF generation. Choose an ordered structure with supported atomic sites.</p> : dialogMode === "feff" && <>
          <div className={styles.grid}>
            <label>Absorber<select aria-label="FEFF absorber" value={absorber} disabled={controlsDisabled} onChange={event => { manualAbsorber.current = true; invalidateJob(); setAbsorber(event.target.value); setSite("") }}><option value="" disabled>Choose absorber</option>{structure.elements.map(item => <option key={item}>{item}</option>)}</select></label>
            <label>Absorption edge<select aria-label="FEFF absorption edge" value={edge} disabled={controlsDisabled} onChange={event => setEdgeChoice({ contextKey, projectId, absorber, edge: event.target.value as ArtemisFeffRequest["edge"] })}><option value="" disabled>Choose edge</option>{feffEdges.map(item => <option key={item}>{item}</option>)}</select></label>
          </div>
          {!absorber && spectrumEdge && <p className={styles.warning}>The spectrum absorber {spectrumEdge.element} has no supported site in this CIF. Choose a matching structure or select an absorber manually.</p>}
          {!edge && spectrumEdge && <p className={styles.warning}>The spectrum edge {spectrumEdge.edge} is not supported here. Choose K, L1, L2, or L3 explicitly.</p>}
          <fieldset className={styles.sites} disabled={controlsDisabled}><legend>Inequivalent absorber site<SectionHelp label="Inequivalent absorber site">A unique site matching the spectrum is selected automatically. When several sites match, choose one explicitly. Site populations are not averaged automatically.</SectionHelp></legend>
            {sites.map(item => <label key={item.index}><input type="radio" name={`feff-site-${contextKey}`} checked={site === String(item.index)} onChange={() => chooseSite(item.index)} aria-label={`Absorber site ${item.index}`} /><span><strong>{item.species} · site {item.index} · Wyckoff {item.wyckoff}</strong><small>({numberText(item.x)}, {numberText(item.y)}, {numberText(item.z)}) · multiplicity {item.multiplicity} · occupancy {numberText(item.occupancy)}</small></span></label>)}
            {!sites.length && <p className={styles.help}>No supported sites for this absorber.</p>}
          </fieldset>
          {site && <details><summary>FEFF shell distance ranges · {absorber} site {site}</summary><RadialShellPanel state={radialState} disabled={controlsDisabled} /></details>}
          <div className={styles.grid}>
            <label>Cluster radius (Å)<input aria-label="FEFF cluster radius" inputMode="decimal" value={clusterRadius} disabled={controlsDisabled} onChange={event => { invalidateJob(); setClusterRadius(event.target.value) }} /></label>
            <label><span>Max path R (Å)<SectionHelp label="Maximum path R">Max path R is the effective half-path length.</SectionHelp></span><input aria-label="FEFF maximum path radius" inputMode="decimal" value={pathRadius} disabled={controlsDisabled} onChange={event => { invalidateJob(); setPathRadius(event.target.value) }} /></label>
            <label>Maximum legs<select aria-label="FEFF maximum legs" value={maxLegs} disabled={controlsDisabled} onChange={event => { invalidateJob(); setMaxLegs(event.target.value) }}>{[2, 3, 4].map(item => <option key={item}>{item}</option>)}</select></label>
            <label>Maximum paths<input aria-label="FEFF maximum paths" inputMode="numeric" value={maxPaths} disabled={controlsDisabled} onChange={event => { invalidateJob(); setMaxPaths(event.target.value) }} /></label>
          </div>
        </>}
      </div>}
      {dialogMode === "feff" && job && <div className={styles.job}>
        <p className={styles.status} role={job.status === "failed" ? "alert" : "status"}><strong>{job.status === "complete" ? "FEFF calculation complete" : job.status === "failed" ? "FEFF calculation failed" : job.stage || "Calculating FEFF"}</strong><span>{job.message}</span>{job.status === "running" && <small>{Math.round(job.elapsed_seconds)} s elapsed</small>}</p>
        {job.warnings.map((warning, i) => <p key={i} className={styles.warning}>{warning}</p>)}
        {job.provenance?.feff_input && <details className={styles.textDetails}><summary>FEFF input</summary><button type="button" onClick={() => downloadArtemisText(`${job.provenance.structure.provider === "uploaded" ? job.provenance.structure.filename?.replace(/\.cif$/i, "") : `${job.provenance.structure.provider === "materials_project" ? "" : "amcsd-"}${job.provenance.structure.id}`}-feff.inp`, job.provenance.feff_input)}>Download feff.inp</button><pre>{job.provenance.feff_input}</pre></details>}
        {job.log && <details className={styles.textDetails}><summary>Calculation log</summary><pre>{job.log}</pre></details>}
        {job.status === "complete" && <>
          <p className={styles.help}>{job.paths.length} path{job.paths.length === 1 ? "" : "s"}{job.truncated ? ` of ${job.total_paths}` : ""} · {availableSlots} open slot{availableSlots === 1 ? "" : "s"}{canReplace ? ` · a replacement can hold up to ${selectionLimit}` : ""}<SectionHelp label="Generated FEFF paths">Select the paths to add. {job.truncated && "Increase Maximum paths to include more. "}Single-scattering paths are grouped by the selected absorber’s radial shells. Multiple scattering is separate. Paths outside the shell search radius or without matching geometry remain unmatched.</SectionHelp></p>
          <button type="button" disabled={controlsDisabled || !shellPaths.some(id => canReplace || !addedIds.includes(id))} onClick={() => {
            // With a model to replace, the shell may include paths already in
            // it and may fill Replace's capacity; Add only fills open slots.
            const eligible = canReplace ? shellPaths : shellPaths.filter(id => !addedIds.includes(id))
            if (eligible.length > selectionLimit) { setError(`The first shell needs ${eligible.length} path slots; only ${selectionLimit} are available.`); return }
            setSelected(eligible); setError("")
          }}>Select first-shell paths</button>
          <RadialPathGroups paths={job.paths} structure={structure} analysis={jobRadial} selectedIds={selected} blockedIds={canReplace ? [] : addedIds} disabled={controlsDisabled}
            onSelection={(ids, include) => {
              const next = include ? [...new Set([...selected, ...ids])] : selected.filter(id => !ids.includes(id))
              if (next.length > selectionLimit) { setError(`These groups need ${next.length} path slots; only ${selectionLimit} are available.`); return }
              setSelected(next); setError("")
            }} renderPath={(path, shell) => {
              const member = structure && jobRadial ? radialPathNeighbor(path.metadata, structure, jobRadial) : undefined
              return <div className={styles.paths}><label>
                <input type="checkbox" aria-label={`Select generated ${path.filename}`} checked={selected.includes(path.id)} disabled={controlsDisabled || (addedIds.includes(path.id) && !canReplace) || (!selected.includes(path.id) && selected.length >= selectionLimit)} onChange={event => setSelected(previous => event.target.checked ? [...previous, path.id] : previous.filter(id => id !== path.id))} />
                <span>
                  <span className={styles.pathIdentity}>
                    <strong>{path.filename}{addedIds.includes(path.id) ? " · added" : ""}{shellPaths.includes(path.id) ? " · First shell" : ""}</strong>
                    <FeffPathShellLabel shell={shell} nleg={path.metadata.nleg} hasContext={!!structure && !!site} hasAnalysis={!!jobRadial} loading={radialState.loading} error={radialState.error} />
                  </span>
                  <small>R {numberText(path.metadata.reff)} Å · N {numberText(path.metadata.degen)} · {path.metadata.nleg} legs{member ? ` · ${member.element} pair ${member.group_id}` : ""}</small>
                  <small>{path.metadata.geometry.map(atom => atom.atom).join(" → ")}</small>
                </span>
              </label></div>
            }} />
          {canReplace && newSelected.length < selected.length && <p className={styles.help}>Selected paths marked added are already in the model: Add skips them; Replace keeps them with their current expressions.</p>}
          {!!otherIncluded.length && <p className={styles.help}>The model already includes {otherIncluded.map(path => path.filename).join(", ")}. Adding keeps {otherIncluded.length === 1 ? "it" : "them"} in the fit; Replace fits only the selected generated paths.</p>}
        </>}
      </div>}
      {error && <div className={styles.error} role="alert">{error}{job?.status === "running" && <button type="button" onClick={() => { setError(""); setPollRevision(previous => previous + 1) }}>Check status</button>}</div>}
      {notice && <p className={styles.status} role="status">{notice}</p>}
      </div>
      </div>
      <footer className={styles.dialogFooter}><span>{removingId ? "Removing the CIF from your project…" : attachPending ? "Saving the CIF to your project…" : ""}</span><button type="button" disabled={mutationPending} onClick={closeDialog}>Close</button></footer>
    </dialog>
  </>
}
