"use client"

import dynamic from "next/dynamic"
import { useEffect, useRef, useState } from "react"
import { FolderOpen } from "lucide-react"
import { athenaApi, type AthenaProject } from "@/lib/athena"
import { isAthenaProjectFile } from "@/lib/athena-file-types"
import styles from "./athena-project-import.module.css"

const Plot = dynamic(() => import("react-plotly.js").then(m => m.default), { ssr: false })
type PreviewMode = "mu" | "norm" | "flat" | "dmude" | "chi"
interface PreviewGroup {
  id: string; label: string; data_type: string; points: number
  x: number[]; y: number[]; notes: string; reference_id: string | null
  background_standard_id?: string | null
}
interface ProjectPreview {
  upload_id: string; filename: string; name: string; journal: string
  groups: PreviewGroup[]; warnings: string[]
}
interface PreviewTrace {
  x: number[]; y: number[]; label: string; mode: PreviewMode
  data_type: string; warnings: string[]; processing_error?: string | null
}
interface Props {
  getProject: () => AthenaProject | null
  onImported: (project: AthenaProject) => void
  onComplete: () => void
  onBusyChange: (label: string) => void
  disabled?: boolean
  initialFiles?: File[]
  onRemainingFiles?: (files: File[]) => void
}

const modeLabels: Record<PreviewMode, string> = {
  mu: "μ(E)", norm: "Normalized μ(E)", flat: "Flattened μ(E)", dmude: "dμ/dE (eV⁻¹)", chi: "χ(k)",
}

export function AthenaProjectImport({ getProject, onImported, onComplete, onBusyChange, disabled = false, initialFiles, onRemainingFiles }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [preview, setPreview] = useState<ProjectPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [activeId, setActiveId] = useState("")
  const [mode, setMode] = useState<PreviewMode>("mu")
  const [trace, setTrace] = useState<PreviewTrace | null>(null)
  const [plotError, setPlotError] = useState("")
  const [plotBusy, setPlotBusy] = useState(false)
  const [plotRetry, setPlotRetry] = useState(0)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [pattern, setPattern] = useState("")
  const [every, setEvery] = useState("2")
  const [start, setStart] = useState("1")
  const [selectionNote, setSelectionNote] = useState("")
  const anchor = useRef<number | null>(null)
  const initialChoice = useRef<File[] | undefined>(undefined)
  const active = preview?.groups.find(group => group.id === activeId)
  const all = !selected.length || selected.length === preview?.groups.length
  const compatibilityNotes = [...new Set([...(preview?.warnings ?? []), ...(trace?.warnings ?? [])])]
  const locked = !!busy || disabled

  function project() {
    const current = getProject()
    if (!current) throw new Error("Open a local workspace before importing a project.")
    return current
  }
  function acceptPreview(next: ProjectPreview) {
    setPreview(next); setSelected(next.groups.map(group => group.id)); setActiveId(next.groups[0]?.id ?? "")
    setMode(next.groups[0]?.data_type === "chi" ? "chi" : "mu")
    setSelectionNote(""); setError(""); anchor.current = null
  }
  async function inspect(file: File) {
    const form = new FormData(); form.append("file", file)
    const next = await athenaApi<ProjectPreview>(`/projects/${project().id}/preview-project`, form)
    acceptPreview(next)
    return next
  }
  async function task(label: string, work: () => Promise<void>) {
    setBusy(label); setError(""); onBusyChange(label)
    try { await work() }
    catch (err) { setError(err instanceof Error ? err.message : "Project import failed.") }
    finally { setBusy(""); onBusyChange("") }
  }
  async function choose(incoming: File[]) {
    if (!incoming.length) return
    setFiles(incoming); setPreview(null); setTrace(null)
    await task("Reading project preview", async () => { await inspect(incoming[0]) })
  }
  async function importSelected() {
    if (!preview || !files.length) return
    const wholeBatch = all
    let remainingData: File[] | null = null
    await task("Importing project groups", async () => {
      let current = preview
      let pending = files
      let selection = selected
      while (pending.length) {
        const destination = project()
        const imported = await athenaApi<AthenaProject>(`/projects/${destination.id}/restore-upload`, {
          version: destination.version, upload_id: current.upload_id, group_ids: selection,
        })
        onImported(imported)
        pending = pending.slice(1); setFiles(pending); setPreview(null); setTrace(null)
        if (!pending.length) { onComplete(); return }
        if (!isAthenaProjectFile(pending[0]) && onRemainingFiles) {
          remainingData = pending
          return
        }
        current = await inspect(pending[0])
        if (!wholeBatch) return
        selection = [] // Athena imports every remaining project after a whole-project choice.
      }
    })
    // Release this panel's busy state before the next raw-file inspection.
    if (remainingData) onRemainingFiles?.(remainingData)
  }

  useEffect(() => {
    if (initialFiles?.length && initialChoice.current !== initialFiles) {
      initialChoice.current = initialFiles
      void choose(initialFiles)
    }
    // A supplied file batch is consumed once, including React StrictMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles])

  useEffect(() => {
    let current = true
    setPlotError(""); setTrace(null); setPlotBusy(false)
    if (!active || !preview) return
    const raw = active.data_type === "chi" ? "chi" : "mu"
    if (mode === raw) {
      setTrace({ x: active.x, y: active.y, label: active.label, mode, data_type: active.data_type, warnings: [] })
      return
    }
    setPlotBusy(true)
    void athenaApi<PreviewTrace>(`/projects/${project().id}/preview-project/${preview.upload_id}/groups/${encodeURIComponent(active.id)}?mode=${mode}`)
      .then(value => { if (current) {
        if (value.mode !== mode) throw new Error("The requested preview signal was not returned. Try again.")
        setTrace(value); setPlotError(value.processing_error ?? "")
      } })
      .catch(err => { if (current) setPlotError(err instanceof Error ? err.message : "This preview could not be calculated.") })
      .finally(() => { if (current) setPlotBusy(false) })
    return () => { current = false }
    // Each upload/group/mode identifies a different read-only preview request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, activeId, mode, plotRetry])

  function selectGroup(index: number, checked: boolean, extend: boolean) {
    if (!preview) return
    const indices = extend && anchor.current !== null
      ? [Math.min(index, anchor.current), Math.max(index, anchor.current)] : [index, index]
    setSelected(ids => {
      const next = new Set(ids)
      for (let i = indices[0]; i <= indices[1]; i++) {
        if (checked) next.add(preview.groups[i].id)
        else next.delete(preview.groups[i].id)
      }
      return preview.groups.filter(group => next.has(group.id)).map(group => group.id)
    })
    anchor.current = index; setSelectionNote("")
  }
  function selectMatching() {
    try {
      const expression = new RegExp(pattern)
      const ids = preview?.groups.filter(group => expression.test(group.label)).map(group => group.id) ?? []
      setSelected(ids); setSelectionNote(`${ids.length} groups match the pattern.`); setError("")
    } catch { setError("Invalid regular expression. Check brackets and escaping, then try again.") }
  }
  function selectPeriodic() {
    const interval = Number(every), offset = Number(start)
    if (!Number.isInteger(interval) || interval < 1 || !Number.isInteger(offset) || offset < 1) {
      setError("Use positive whole numbers for the interval and first group."); return
    }
    const ids = preview?.groups.filter((_, index) => index >= offset - 1 && (index - offset + 1) % interval === 0).map(group => group.id) ?? []
    setSelected(ids); setSelectionNote(`${ids.length} groups selected by position.`); setError("")
  }

  return <section aria-label="Project file import">
    {!preview && <label className="ath-upload-zone"><FolderOpen size={26} /><strong>Open an Athena project</strong><span>.prj, .json or .gz · multiple projects supported</span><input type="file" aria-label="Open project file" multiple disabled={locked} accept=".prj,.json,.gz" onChange={event => { void choose(Array.from(event.target.files ?? [])); event.target.value = "" }} /></label>}
    {files.length > 0 && <p className={styles.progress} role="status">{busy || `Reviewing ${files[0].name}`} · {files.length} project file{files.length === 1 ? "" : "s"} remaining</p>}
    {preview && <>
      <h3 className={styles.title}>{preview.name || preview.filename}</h3>
      <div className={styles.layout}>
        <div>
          <div className={styles.selectionActions}>
            <button disabled={locked} onClick={() => { setSelected(preview.groups.map(group => group.id)); setSelectionNote("") }}>Select all</button>
            <button disabled={locked} onClick={() => { setSelected([]); setSelectionNote("") }}>Select none</button>
            <button disabled={locked} onClick={() => { setSelected(preview.groups.filter(group => !selected.includes(group.id)).map(group => group.id)); setSelectionNote("") }}>Invert</button>
          </div>
          <div className={styles.groups} aria-label="Groups in project">
            {preview.groups.map((group, index) => <div key={group.id} className={`${styles.group} ${activeId === group.id ? styles.active : ""}`}>
              <input type="checkbox" aria-label={`Import ${group.label}, group ${index + 1}`} checked={selected.includes(group.id)} disabled={locked} onChange={event => selectGroup(index, event.target.checked, (event.nativeEvent as MouseEvent).shiftKey)} />
              <button disabled={locked} aria-label={`Preview ${group.label}, group ${index + 1}`} aria-pressed={activeId === group.id} onClick={() => { setActiveId(group.id); setMode(group.data_type === "chi" ? "chi" : "mu") }}><strong>{group.label}</strong><small>{index + 1} · {group.data_type} · {group.points.toLocaleString()} points</small></button>
            </div>)}
            {!preview.groups.length && <p>No spectra in this project. Its journal and metadata can still be imported.</p>}
          </div>
          <div className={styles.periodic}>
            <label className="ath-field"><span>Select every</span><input aria-label="Selection interval" type="number" min="1" step="1" value={every} disabled={locked} onChange={event => setEvery(event.target.value)} /></label>
            <label className="ath-field"><span>Starting at group</span><input aria-label="Selection start" type="number" min="1" step="1" value={start} disabled={locked} onChange={event => setStart(event.target.value)} /></label>
            <button disabled={locked} onClick={selectPeriodic}>Select by position</button>
          </div>
          <label className="ath-field"><span>Matching labels (regular expression)</span><input value={pattern} disabled={locked} onChange={event => setPattern(event.target.value)} placeholder="e.g. foil|standard" /></label>
          <button disabled={locked} onClick={selectMatching}>Select matching</button>
          <p className="ath-hint">JavaScript regular expressions. Shift-click a checkbox to select a range.</p>
        </div>
        <div className={styles.details}>
          <h4>Project journal</h4><pre className={styles.journal}>{preview.journal || "No journal entries."}</pre>
          {active && <>
            <label className="ath-field"><span>Preview signal</span><select disabled={locked} value={mode} onChange={event => setMode(event.target.value as PreviewMode)}>{(active.data_type === "chi" ? ["chi"] : ["mu", "norm", "flat", "dmude"]).map(value => <option value={value} key={value}>{modeLabels[value as PreviewMode]}</option>)}</select></label>
            <div className={styles.plot} aria-label={`Preview of ${active.label}`}>
              {plotBusy ? <p role="status">Calculating preview…</p> : trace?.x.length && !plotError ? <Plot data={[{x: trace.x.slice(), y: trace.y.slice(), type: "scatter", mode: "lines", name: trace.label, line: {color: "#16736b", width: 1.5}}]} layout={{autosize: true, margin: {l: 60, r: 14, t: 15, b: 50}, xaxis: {title: {text: mode === "chi" ? "k (Å⁻¹)" : "Energy (eV)"}}, yaxis: {title: {text: modeLabels[mode]}, automargin: true}, font: {size: 10}, showlegend: false, uirevision: `${preview.upload_id}-${active.id}-${mode}`}} config={{responsive: true, displaylogo: false, displayModeBar: false}} useResizeHandler style={{width: "100%", height: "100%"}} /> : <p>{plotError || "No preview points available."}</p>}
            </div>
            {plotError && <button disabled={locked || plotBusy} onClick={() => setPlotRetry(value => value + 1)}>Retry plot preview</button>}
            {trace && active.points > trace.x.length && <p className="ath-hint">Displaying {trace.x.length} of {active.points.toLocaleString()} source points. The full data are imported.</p>}
            <h4>Group notes</h4><pre className={styles.notes}>{active.notes || "No group notes."}</pre>
            {active.reference_id && <p className="ath-hint">Reference: {preview.groups.find(group => group.id === active.reference_id)?.label ?? active.reference_id}. Include both groups to keep the link.</p>}
            {active.background_standard_id && <p className="ath-hint">Background standard: {preview.groups.find(group => group.id === active.background_standard_id)?.label ?? active.background_standard_id}. Include the standard and its dependencies to retain this processing.</p>}
          </>}
        </div>
      </div>
      {!!compatibilityNotes.length && <details><summary>{compatibilityNotes.length} compatibility notes · original settings retained</summary>{compatibilityNotes.map((warning, index) => <p className="ath-warning" key={index}>{warning}</p>)}</details>}
      {selectionNote && <p role="status">{selectionNote}</p>}
      <p className="ath-hint">{!selected.length ? "No groups selected: Import all will import the entire project." : `${selected.length} of ${preview.groups.length} groups selected.`} {all ? "Journal and supported analysis state are included. Compatibility notes identify settings retained only as metadata. Remaining project files will be imported in full." : "A subset imports data and recipes; saved analysis state is not restored. The next project will open for selection."}</p>
    </>}
    {error && <div className="ath-error" role="alert">{error}</div>}
    {files.length > 0 && <div className="ath-modal-actions">
      <button disabled={locked} onClick={() => { setFiles([]); setPreview(null); setError(""); setTrace(null) }}>Choose other projects</button>
      {!preview ? <button disabled={locked} onClick={() => { void task("Reading project preview", async () => { await inspect(files[0]) }) }}>Retry preview</button>
        : <button className="ath-primary" disabled={locked} onClick={() => { void importSelected() }}>{busy ? "Importing…" : !preview.groups.length ? "Import project" : all ? "Import all groups" : `Import ${selected.length} selected groups`}</button>}
    </div>}
  </section>
}
