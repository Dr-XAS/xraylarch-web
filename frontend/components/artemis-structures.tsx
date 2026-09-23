"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Search, X } from "lucide-react"
import { CifViewer } from "./cif-viewer"
import type { AthenaProject } from "@/lib/athena"
import { artemisApi, type ArtemisInspectedPath } from "@/lib/artemis"
import { parseFeffCluster } from "@/lib/feff-cluster"
import {
  downloadArtemisText, sameFeffRequest, type ArtemisFeffJob, type ArtemisFeffRequest, type ArtemisGeneratedPath,
  type ArtemisStructure, type ArtemisStructureSearchResult, type ArtemisStructureAttachment, type ArtemisProjectStructures,
} from "@/lib/artemis-structures"
import styles from "./artemis-structures.module.css"

interface Props {
  contextKey: string
  projectId?: string
  version?: number
  onProjectChange?: (project: AthenaProject) => void
  onViewStructure?: (attachmentId: string) => void
  disabled?: boolean
  availableSlots: number
  existingPaths?: Pick<ArtemisInspectedPath, "filename" | "content">[]
  onAddPaths: (paths: ArtemisGeneratedPath[]) => string | null
}
const errorText = (error: unknown) => error instanceof Error ? error.message : "The structure request failed. Please try again."
const numberText = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "—" : Number(value.toPrecision(5)).toString()
const amcsdLabel = (id: number) => `AMCSD ${String(id).padStart(7, "0")}`

export function ArtemisStructures({ contextKey, projectId, version, onProjectChange, onViewStructure, disabled = false, availableSlots, existingPaths, onAddPaths }: Props) {
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const viewerAnchor = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const [attachments, setAttachments] = useState<ArtemisStructureAttachment[]>([])
  const [attachmentId, setAttachmentId] = useState<string | null>(null)
  const [listRevision, setListRevision] = useState(0)
  const [listError, setListError] = useState("")
  const [listLoading, setListLoading] = useState(false)
  const [query, setQuery] = useState("")
  const [element, setElement] = useState("")
  const [search, setSearch] = useState<ArtemisStructureSearchResult | null>(null)
  const [structure, setStructure] = useState<ArtemisStructure | null>(null)
  const [absorber, setAbsorber] = useState("")
  const [site, setSite] = useState("")
  const [edge, setEdge] = useState<ArtemisFeffRequest["edge"]>("K")
  const [clusterRadius, setClusterRadius] = useState("5")
  const [pathRadius, setPathRadius] = useState("4")
  const [maxLegs, setMaxLegs] = useState("4")
  const [maxPaths, setMaxPaths] = useState("60")
  const [busy, setBusy] = useState<"search" | "structure" | "job" | "attach" | null>(null)
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
  const controlsDisabled = disabled || attachPending
  const addedIds = existingPaths === undefined ? added : job?.paths.filter(path => existingPaths.some(existing => existing.filename === path.filename && existing.content === path.content)).map(path => path.id) ?? []
  useEffect(() => {
    if (!existingPaths) return
    const included = new Set(job?.paths.filter(path => existingPaths.some(existing => existing.filename === path.filename && existing.content === path.content)).map(path => path.id) ?? [])
    setSelected(previous => { const remaining = previous.filter(id => !included.has(id)); return remaining.length === previous.length ? previous : remaining })
  }, [existingPaths, job])

  function openDialog() {
    if (!open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(true)
    setListRevision(previous => previous + 1)
  }
  function closeDialog() {
    if (attachPending) return
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
        if (attachmentId && !response.structures.some(item => item.id === attachmentId)) setAttachmentId(null)
      })
      .catch(error => { if (!abort.signal.aborted && currentProject.current === projectId) setListError(errorText(error)) })
      .finally(() => { if (!abort.signal.aborted && currentProject.current === projectId) setListLoading(false) })
    return () => abort.abort()
  }, [projectId, version, listRevision])

  function openAttachment(attachment: ArtemisStructureAttachment) {
    if (attachPending) return
    if (attachmentId !== attachment.id) {
      lookupAbort.current?.abort()
      sequence.current += 1
      invalidateJob()
      setStructure(attachment.structure)
      setAttachmentId(attachment.id)
      setAbsorber(attachment.structure.elements[0] ?? "")
      setSite("")
      setBusy(null)
    }
    viewCallback.current?.(attachment.id)
    openDialog()
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
    setSite("")
    setAttachmentId(null)
    setBusy(null)
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
    if (element.trim()) params.set("element", element.trim())
    try {
      const response = await artemisApi<ArtemisStructureSearchResult>(`/structures?${params}`, undefined, abort.signal)
      if (abort.signal.aborted || sequence.current !== request || context.current !== requestContext) return
      setSearch(response)
    } catch (error) { if (!abort.signal.aborted && sequence.current === request && context.current === requestContext) setError(errorText(error)) }
    finally { if (!abort.signal.aborted && sequence.current === request && context.current === requestContext) setBusy(null) }
  }
  async function selectStructure(id: number) {
    if (controlsDisabled) return
    const attached = attachments.find(item => item.amcsd_id === id)
    if (attached) { openAttachment(attached); return }
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
      const response = await artemisApi<ArtemisStructure>(`/structures/${id}`, undefined, abort.signal)
      if (abort.signal.aborted || sequence.current !== request || context.current !== requestContext) return
      if (response.id !== id) throw new Error("The returned CIF does not match the selected AMCSD record. Select the structure again.")
      setStructure(response)
      // Even a single element can have several inequivalent sites; the site stays an explicit choice.
      setAbsorber(response.elements[0] ?? "")
    } catch (error) { if (!abort.signal.aborted && sequence.current === request && context.current === requestContext) setError(errorText(error)) }
    finally { if (!abort.signal.aborted && sequence.current === request && context.current === requestContext) setBusy(null) }
  }
  async function attachStructure() {
    if (!structure || !projectId || version === undefined || controlsDisabled || !projectCallback.current) return
    const requestContext = contextKey
    const requestProject = projectId
    const selectedId = structure.id
    const abort = new AbortController()
    attachAbort.current?.abort()
    attachAbort.current = abort
    setBusy("attach")
    setError("")
    setNotice("")
    try {
      const response = await artemisApi<AthenaProject & { artemis_structures?: ArtemisStructureAttachment[] }>(`/projects/${encodeURIComponent(projectId)}/structures`, { version, amcsd_id: selectedId }, abort.signal)
      if (abort.signal.aborted || context.current !== requestContext || currentProject.current !== requestProject) return
      const attached = response.artemis_structures?.find(item => item.amcsd_id === selectedId)
      if (response.id !== requestProject || response.version < version || !attached) throw new Error("The saved CIF response does not match this project. Refresh the attachment list before retrying.")
      setAttachments(response.artemis_structures ?? [])
      setStructure(attached.structure)
      setAttachmentId(attached.id)
      setNotice(`${attached.structure.mineral || attached.structure.formula} CIF attached to the current project.`)
      projectCallback.current?.(response)
      viewCallback.current?.(attached.id)
      setListRevision(previous => previous + 1)
    } catch (error) { if (!abort.signal.aborted && context.current === requestContext && currentProject.current === requestProject) setError(errorText(error)) }
    finally { if (!abort.signal.aborted && context.current === requestContext && currentProject.current === requestProject) setBusy(null) }
  }
  async function generate() {
    if (!structure || !structure.supported || controlsDisabled || site === "" || !absorber || !attachmentId || !projectId || version === undefined) return
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

  function addPaths() {
    if (!job || job.status !== "complete" || disabled || !selected.length) return
    if (selected.length > availableSlots) { setError(`This model has room for ${availableSlots} more path${availableSlots === 1 ? "" : "s"}. Select fewer paths or remove existing ones.`); return }
    const viewerCluster = parseFeffCluster(job.provenance?.feff_input)
    const paths = job.paths.filter(path => selected.includes(path.id) && !addedIds.includes(path.id)).map(path => {
      const suffix = ` · ${amcsdLabel(job.provenance.structure.id)} · ${job.request.absorber} site ${job.request.site_index} · ${path.filename}`
      const mineral = job.provenance.structure.mineral || job.provenance.structure.formula || "Structure"
      return { filename: path.filename, content: path.content, metadata: viewerCluster ? { ...path.metadata, viewerCluster } : path.metadata, label: mineral.slice(0, Math.max(0, 120 - suffix.length)) + suffix }
    })
    const error = callback.current(paths)
    if (error) { setError(error); return }
    setAdded(previous => [...previous, ...selected])
    setSelected([])
    setError("")
    setNotice(`Added ${paths.length} generated path${paths.length === 1 ? "" : "s"} to the current fit model. Review the path expressions before fitting.`)
  }

  const sites = structure?.sites.filter(item => item.element === absorber) ?? []
  const working = busy === "job" || job?.status === "running"
  return <section className={styles.panel} aria-label="Project CIF structures">
    <button type="button" className={styles.openButton} disabled={disabled || !projectId} onClick={openDialog}><Search size={14} />Search / attach CIF</button>
    {listLoading && !attachments.length && <p className={styles.help}>Loading attached CIFs…</p>}
    {!projectId ? <p className={styles.help}>Select a project to attach crystal structures.</p> : !listLoading && !attachments.length && <p className={styles.help}>No CIF structures attached to this project.</p>}
    {attachments.length > 0 && <ul className={styles.attachedList}>{attachments.map(item => <li key={item.id}><span><strong>{item.structure.mineral || item.structure.formula}</strong><small>{amcsdLabel(item.amcsd_id)}</small></span><button type="button" disabled={disabled || attachPending} onClick={() => openAttachment(item)} aria-label={`Open attached ${item.structure.mineral || item.structure.formula} CIF`}>Open</button></li>)}</ul>}
    {listError && !open && <p className={styles.error}>{listError}<button type="button" onClick={() => setListRevision(previous => previous + 1)}>Reload attached CIFs</button></p>}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); closeDialog() }} onClose={() => { setOpen(false); if (opener.current?.isConnected) opener.current.focus() }}>
      <header className={styles.dialogHeader}><div><h3 id={titleId}>Crystal structures & FEFF paths</h3><p>Attach a CIF to your project, then choose an absorber site to calculate paths.</p></div><button type="button" aria-label="Close CIF search" disabled={attachPending} onClick={closeDialog}><X size={18} /></button></header>
      <div className={styles.content}>
      <div className={styles.searchColumn}>
      <p className={styles.help}>Search the local AMCSD database snapshot.</p>
      {listError && <p className={styles.error} role="alert">{listError}<button type="button" onClick={() => setListRevision(previous => previous + 1)}>Reload attached CIFs</button></p>}
      <div className={styles.searchFields}>
        <label>Mineral, formula, or AMCSD ID<input aria-label="AMCSD search query" value={query} placeholder="e.g. copper or 13088" disabled={controlsDisabled}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void findStructures() } }} /></label>
        <label>Contains element<input aria-label="AMCSD element filter" value={element} placeholder="e.g. Cu" maxLength={2} disabled={controlsDisabled} onChange={event => setElement(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void findStructures() } }} /></label>
      </div>
      <button type="button" disabled={controlsDisabled || busy === "search" || (!query.trim() && !element.trim())} onClick={findStructures}><Search size={13} />{busy === "search" ? "Searching…" : "Search AMCSD"}</button>
      {search && <div className={styles.searchResults}>
        <p className={styles.help}>{search.results.length ? `${search.results.length} result${search.results.length === 1 ? "" : "s"}${search.limited ? " · refine the search for more" : ""}` : "No matching structures. Try another mineral, formula, element, or AMCSD ID."}</p>
        {search.results.map(item => <button type="button" key={item.id} disabled={controlsDisabled} className={styles.result} aria-pressed={structure?.id === item.id} onClick={() => selectStructure(item.id)}>
          <strong>{item.mineral || item.formula}</strong><span>{item.formula} · {item.space_group}</span><small>{amcsdLabel(item.id)}{item.year ? ` · ${item.year}` : ""}</small>
        </button>)}
        {search.source && <p className={styles.source}>{search.source}</p>}
      </div>}
      {attachments.length > 0 && <div className={styles.savedStructures}><h4>Attached to this project</h4>{attachments.map(item => <button type="button" key={item.id} className={styles.result} disabled={controlsDisabled} aria-pressed={attachmentId === item.id} onClick={() => openAttachment(item)} aria-label={`Use attached ${item.structure.mineral || item.structure.formula} CIF`}><strong>{item.structure.mineral || item.structure.formula}</strong><small>{amcsdLabel(item.amcsd_id)} · Saved CIF</small></button>)}</div>}
      </div>
      <div className={styles.detailColumn}>
      {!structure && busy !== "structure" && <p className={styles.placeholder}>Select a search result or open a CIF already attached to this project.</p>}
      {busy === "structure" && <p className={styles.status} role="status">Reading CIF and inequivalent atomic sites…</p>}
      {structure && <div className={styles.structure}>
        <h4>{structure.mineral} <span>{amcsdLabel(structure.id)}</span></h4>
        {open && attachmentId && <div ref={viewerAnchor}><CifViewer key={attachmentId} structure={structure} /></div>}
        <p className={styles.help}>{structure.formula} · {structure.space_group}<br />a {numberText(structure.cell.a)}, b {numberText(structure.cell.b)}, c {numberText(structure.cell.c)} Å<br />α {numberText(structure.cell.alpha)}, β {numberText(structure.cell.beta)}, γ {numberText(structure.cell.gamma)}°</p>
        {structure.title && <p className={styles.citation}>{structure.title}<br />{structure.authors}{structure.year ? ` (${structure.year})` : ""}{structure.journal ? ` · ${structure.journal}` : ""}</p>}
        <div className={styles.toolbar}><button type="button" className={styles.attachButton} disabled={controlsDisabled || !!attachmentId || !projectId || version === undefined || !onProjectChange} onClick={attachStructure}>{attachPending ? "Attaching CIF…" : attachmentId ? "Attached to project" : "Attach to project"}</button></div>
        {attachmentId && <p className={styles.help}>This saved CIF belongs to the current project. FEFF uses the attached snapshot.</p>}
        <details className={styles.textDetails}><summary>View CIF</summary><pre>{structure.cif}</pre></details>
        {structure.warnings.map((warning, i) => <p className={styles.warning} key={i}>{warning}</p>)}
        {!structure.supported ? <p className={styles.warning} role="status">This structure cannot be used for FEFF generation. Choose an ordered structure with supported atomic sites.</p> : <>
          <div className={styles.grid}>
            <label>Absorber<select aria-label="FEFF absorber" value={absorber} disabled={controlsDisabled} onChange={event => { invalidateJob(); setAbsorber(event.target.value); setSite("") }}>{structure.elements.map(item => <option key={item}>{item}</option>)}</select></label>
            <label>Absorption edge<select aria-label="FEFF absorption edge" value={edge} disabled={controlsDisabled} onChange={event => { invalidateJob(); setEdge(event.target.value as ArtemisFeffRequest["edge"]) }}>{["K", "L1", "L2", "L3"].map(item => <option key={item}>{item}</option>)}</select></label>
          </div>
          <fieldset className={styles.sites} disabled={controlsDisabled}><legend>Inequivalent absorber site</legend>
            {sites.map(item => <label key={item.index}><input type="radio" name={`feff-site-${contextKey}`} checked={site === String(item.index)} onChange={() => { invalidateJob(); setSite(String(item.index)) }} aria-label={`Absorber site ${item.index}`} /><span><strong>{item.species} · site {item.index} · Wyckoff {item.wyckoff}</strong><small>({numberText(item.x)}, {numberText(item.y)}, {numberText(item.z)}) · multiplicity {item.multiplicity} · occupancy {numberText(item.occupancy)}</small></span></label>)}
            {!sites.length && <p className={styles.help}>No supported sites for this absorber.</p>}
          </fieldset>
          <div className={styles.grid}>
            <label>Cluster radius (Å)<input aria-label="FEFF cluster radius" inputMode="decimal" value={clusterRadius} disabled={controlsDisabled} onChange={event => { invalidateJob(); setClusterRadius(event.target.value) }} /></label>
            <label>Max path R (Å)<input aria-label="FEFF maximum path radius" inputMode="decimal" value={pathRadius} disabled={controlsDisabled} onChange={event => { invalidateJob(); setPathRadius(event.target.value) }} /></label>
            <label>Maximum legs<select aria-label="FEFF maximum legs" value={maxLegs} disabled={controlsDisabled} onChange={event => { invalidateJob(); setMaxLegs(event.target.value) }}>{[2, 3, 4].map(item => <option key={item}>{item}</option>)}</select></label>
            <label>Maximum paths<input aria-label="FEFF maximum paths" inputMode="numeric" value={maxPaths} disabled={controlsDisabled} onChange={event => { invalidateJob(); setMaxPaths(event.target.value) }} /></label>
          </div>
          <p className={styles.help}>Choose one absorber site explicitly. Max path R is the effective half-path length; site populations are not averaged automatically.</p>
          {!attachmentId && <p className={styles.help}>Attach this CIF to the project before generating FEFF paths.</p>}
          <button type="button" onClick={generate} disabled={controlsDisabled || !attachmentId || site === "" || !absorber || working}>{working ? "Calculating FEFF…" : job?.status === "failed" ? "Retry FEFF calculation" : "Generate FEFF paths"}</button>
        </>}
      </div>}
      {job && <div className={styles.job}>
        <p className={styles.status} role={job.status === "failed" ? "alert" : "status"}><strong>{job.status === "complete" ? "FEFF calculation complete" : job.status === "failed" ? "FEFF calculation failed" : job.stage || "Calculating FEFF"}</strong><span>{job.message}</span>{job.status === "running" && <small>{Math.round(job.elapsed_seconds)} s elapsed</small>}</p>
        {job.warnings.map((warning, i) => <p key={i} className={styles.warning}>{warning}</p>)}
        {job.provenance?.feff_input && <details className={styles.textDetails}><summary>FEFF input</summary><button type="button" onClick={() => downloadArtemisText(`amcsd-${job.provenance.structure.id}-feff.inp`, job.provenance.feff_input)}>Download feff.inp</button><pre>{job.provenance.feff_input}</pre></details>}
        {job.log && <details className={styles.textDetails}><summary>Calculation log</summary><pre>{job.log}</pre></details>}
        {job.status === "complete" && <>
          <p className={styles.help}>{job.paths.length} path{job.paths.length === 1 ? "" : "s"} available{job.truncated ? ` of ${job.total_paths}; increase Maximum paths to include more` : ""}. Select the paths to add; this model has {availableSlots} open slot{availableSlots === 1 ? "" : "s"}.</p>
          <div className={styles.paths}>{job.paths.map(path => <label key={path.id}><input type="checkbox" aria-label={`Select generated ${path.filename}`} checked={selected.includes(path.id)} disabled={disabled || addedIds.includes(path.id) || (!selected.includes(path.id) && selected.length >= availableSlots)} onChange={event => setSelected(previous => event.target.checked ? [...previous, path.id] : previous.filter(id => id !== path.id))} /><span><strong>{path.filename}{addedIds.includes(path.id) ? " · added" : ""}</strong><small>R {numberText(path.metadata.reff)} Å · N {numberText(path.metadata.degen)} · {path.metadata.nleg} legs</small><small>{path.metadata.geometry.map(atom => atom.atom).join(" → ")}</small></span></label>)}</div>
          <button type="button" disabled={disabled || !selected.length || selected.length > availableSlots} onClick={addPaths}>Add selected paths ({selected.length})</button>
        </>}
      </div>}
      {error && <div className={styles.error} role="alert">{error}{job?.status === "running" && <button type="button" onClick={() => { setError(""); setPollRevision(previous => previous + 1) }}>Check status</button>}</div>}
      {notice && <p className={styles.status} role="status">{notice}</p>}
      </div>
      </div>
      <footer className={styles.dialogFooter}><span>{attachPending ? "Saving the CIF to your project…" : "Closing this window keeps your search and calculation progress."}</span><button type="button" disabled={attachPending} onClick={closeDialog}>Close</button></footer>
    </dialog>
  </section>
}
