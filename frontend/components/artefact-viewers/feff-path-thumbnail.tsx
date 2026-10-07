"use client"

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Expand, RotateCcw, X } from "lucide-react"
import type { GLViewer, Vector2 } from "3dmol"
import type { ArtemisPathMetadata } from "@/lib/artemis"
import { createCifRenderer } from "@/lib/cif-renderer"
import { buildFeffPathGeometry } from "@/lib/feff-path-geometry"
import { resolveFeffPathEquivalents } from "@/lib/feff-path-equivalents"
import { resolveFeffStructureContext } from "@/lib/feff-structure-context"
import { drawFeffScene, FEFF_LEG_COLORS, feffSceneAtoms, type FeffScenePath, type FeffContextAtom } from "@/lib/feff-scene"
import { AtomLegend } from "../atom-legend"
import styles from "./feff-path-thumbnail.module.css"

type PreviewPath = { id: string; filename: string; metadata: ArtemisPathMetadata }
type Camera = ReturnType<GLViewer["getView"]>
type Theme = { background: string; ink: string }
type Entry = { id: string; filename: string; key: string; path: FeffScenePath | null; context: FeffContextAtom[] }
type Snapshot = { token: string; image?: string; failed?: boolean }
type PreviewContext = { entries: Entry[]; snapshots: Record<string, Snapshot>; open: (key: string, trigger: HTMLButtonElement) => void }
const Previews = createContext<PreviewContext | null>(null)

function camera(viewer: GLViewer): Camera | undefined {
  const view = viewer.getView()
  return view.length === 8 && view.every(Number.isFinite) ? view.slice() : undefined
}

function initialCamera(viewer: GLViewer, saved?: Camera) {
  // clear() retains the old pose. Each path must start from its own saved camera.
  viewer.setView([0, 0, 0, 0, 0, 0, 0, 1])
  viewer.zoomTo()
  if (saved) viewer.setView(saved)
  else { viewer.rotate(20, "y"); viewer.rotate(12, "x") }
}

/** One temporary renderer serves the whole summary; table rows retain only PNGs. */
export function FeffPathPreviews({ paths, children }: { paths: PreviewPath[]; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const images = useRef<Record<string, Snapshot>>({})
  const views = useRef<Record<string, Camera>>({})
  const opener = useRef<HTMLButtonElement | null>(null)
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [theme, setTheme] = useState<Theme | null>(null)
  const entries = useMemo(() => paths.map((item, index): Entry => {
    const color = FEFF_LEG_COLORS[index % FEFF_LEG_COLORS.length]
    const { geometry } = buildFeffPathGeometry(item.metadata)
    const context = geometry ? resolveFeffStructureContext(item.metadata) : null
    const equivalents = geometry && context?.source && !context.truncated
      ? resolveFeffPathEquivalents(geometry, item.metadata.degen, context.atoms) : undefined
    return { id: item.id, filename: item.filename,
      key: JSON.stringify([item.id, item.filename, item.metadata.geometry, item.metadata.degen, item.metadata.viewerCluster, color]),
      path: geometry ? { id: item.id, filename: item.filename, geometry, equivalents, color } : null,
      context: context?.atoms ?? [] }
  }), [paths])
  const active = entries.find(entry => entry.key === activeKey && entry.path)

  useEffect(() => {
    const readTheme = () => {
      if (!host.current) return
      const css = getComputedStyle(host.current)
      const next = { background: css.backgroundColor || "#ffffff", ink: css.color || "#384150" }
      setTheme(previous => previous?.background === next.background && previous.ink === next.ink ? previous : next)
    }
    readTheme()
    const observer = new MutationObserver(readTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    // Bound memory to the paths in this result, including when the result changes.
    const keys = new Set(entries.map(entry => entry.key))
    images.current = Object.fromEntries(Object.entries(images.current).filter(([key]) => keys.has(key)))
    views.current = Object.fromEntries(Object.entries(views.current).filter(([key]) => keys.has(key)))
    setActiveKey(previous => previous && keys.has(previous) ? previous : null)
    setSnapshots(images.current)
  }, [entries])

  useEffect(() => {
    const container = host.current
    if (!container || !theme || active) return
    const pending = entries.filter(entry => entry.path && images.current[entry.key]?.token !== JSON.stringify([theme, views.current[entry.key]]))
    if (!pending.length) return
    let cancelled = false
    let release: (() => void) | undefined
    const save = (entry: Entry, snapshot: Snapshot) => {
      if (cancelled) return
      images.current = { ...images.current, [entry.key]: snapshot }
      setSnapshots(images.current)
    }
    // Yield between paths so a click can cancel the batch before opening the modal.
    const generate = async () => {
      try {
        const mol = await import("3dmol")
        if (cancelled) return
        const renderer = createCifRenderer(mol, container)
        release = renderer.dispose
        for (const entry of pending) {
          if (cancelled) break
          const token = JSON.stringify([theme, views.current[entry.key]])
          try {
            drawFeffScene(renderer.viewer, { paths: [entry.path!], context: entry.context, ...theme, labels: false, interactive: false })
            initialCamera(renderer.viewer, views.current[entry.key])
            renderer.viewer.render()
            const image = renderer.viewer.pngURI()
            if (!image.startsWith("data:image/png")) throw new Error("No preview image")
            save(entry, { token, image })
          } catch { save(entry, { token, failed: true }) }
          await new Promise<void>(resolve => window.setTimeout(resolve, 0))
        }
      } catch {
        for (const entry of pending) save(entry, { token: JSON.stringify([theme, views.current[entry.key]]), failed: true })
      } finally { release?.(); release = undefined }
    }
    void generate()
    return () => { cancelled = true; release?.(); release = undefined; container.replaceChildren() }
  }, [entries, theme, active, revision])

  const close = (view?: Camera) => {
    if (active && view) views.current[active.key] = view
    if (active) delete images.current[active.key]
    setActiveKey(null)
    setRevision(value => value + 1)
    opener.current?.focus({ preventScroll: true })
  }
  return <Previews.Provider value={{ entries, snapshots, open: (key, trigger) => { opener.current = trigger; setActiveKey(key) } }}>
    {children}
    <div ref={host} className={styles.snapshotHost} data-feff-snapshot-host aria-hidden="true" />
    {active?.path && theme && <PathPreviewDialog key={active.key} entry={active} theme={theme} savedView={views.current[active.key]} onClose={close} />}
  </Previews.Provider>
}

export function FeffPathThumbnail({ pathId }: { pathId: string }) {
  const previews = useContext(Previews)
  const entry = previews?.entries.find(item => item.id === pathId)
  const snapshot = entry && previews?.snapshots[entry.key]
  if (!entry?.path || !previews) return <span className={styles.unavailable}>Preview unavailable</span>
  return <button type="button" className={styles.thumbnail} aria-label={`Open 3D preview for ${entry.filename}`} aria-haspopup="dialog" onClick={event => previews.open(entry.key, event.currentTarget)}>
    {snapshot?.image ? <img src={snapshot.image} alt={`FEFF path preview for ${entry.filename}`} draggable={false} />
      : <span className={styles.placeholder}>{snapshot?.failed ? "3D preview unavailable" : "Rendering preview…"}</span>}
    <span className={styles.expand}><Expand size={12} aria-hidden="true" />Explore 3D</span>
  </button>
}

function PathPreviewDialog({ entry, theme, savedView, onClose }: { entry: Entry; theme: Theme; savedView?: Camera; onClose: (view?: Camera) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const renderer = useRef<ReturnType<typeof createCifRenderer> | null>(null)
  const labelOffset = useRef<Vector2 | undefined>(undefined)
  const lastView = useRef(savedView)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [labels, setLabels] = useState(true)
  const elements = useMemo(() => [...new Set(feffSceneAtoms([entry.path!], entry.context).map(atom => atom.atom))].sort(), [entry])

  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  useEffect(() => {
    const container = host.current!
    let cancelled = false
    let release: (() => void) | undefined
    setReady(false)
    setError("")
    import("3dmol").then(mol => {
      if (cancelled) return
      const instance = createCifRenderer(mol, container)
      renderer.current = instance
      release = instance.dispose
      labelOffset.current = new mol.Vector2(16, 16)
      instance.viewer.setHoverDuration(80)
      setReady(true)
    }).catch(() => { if (!cancelled) setError("Unable to open the 3D preview. Enable WebGL, then retry.") })
    return () => {
      cancelled = true
      if (renderer.current) lastView.current = camera(renderer.current.viewer) ?? lastView.current
      release?.()
      renderer.current = null
      container.replaceChildren()
    }
  }, [entry, attempt])

  useEffect(() => {
    if (!ready || !renderer.current) return
    const viewer = renderer.current.viewer
    try {
      drawFeffScene(viewer, { paths: [entry.path!], context: entry.context, ...theme, labels, labelOffset: labelOffset.current })
      initialCamera(viewer, lastView.current)
      viewer.render()
      lastView.current = camera(viewer)
      // Store camera changes without a React render on every mouse movement.
      viewer.setViewChangeCallback((view: Camera) => { lastView.current = view.slice() })
      setError("")
    } catch { setError("Unable to render this path. Try opening the preview again.") }
    return () => { viewer.setViewChangeCallback(null) }
  }, [entry, theme, ready, labels])

  const close = () => {
    const view = renderer.current ? camera(renderer.current.viewer) : lastView.current
    // Release before telling the parent to resume its snapshot queue.
    renderer.current?.viewer.setViewChangeCallback(null)
    renderer.current?.dispose()
    renderer.current = null
    dialog.current?.close()
    onClose(view)
  }
  return <dialog className={styles.dialog} ref={dialog} aria-label={`3D path preview · ${entry.filename}`}
    onCancel={event => { event.preventDefault(); close() }}>
    <header><div><span className={styles.eyebrow}>FEFF PATH</span><h2>{entry.filename}</h2></div><button type="button" onClick={close} aria-label="Close 3D preview" autoFocus><X size={19} /></button></header>
    <div className={styles.legend}><AtomLegend elements={elements} ariaLabel="Path preview elements" /><span>{entry.path!.geometry.classification.label}</span></div>
    <div className={styles.stage}>
      <div ref={host} className={styles.surface} data-feff-preview-surface role="img" aria-label={`Interactive 3D preview of ${entry.filename}`} />
      {error ? <div className={styles.overlay} role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry 3D preview</button></div>
        : !ready && <p className={styles.overlay} role="status">Loading 3D preview…</p>}
    </div>
    <div className={styles.controls}><span>Drag to rotate · Scroll or pinch to zoom</span><label><input type="checkbox" checked={labels} onChange={event => setLabels(event.target.checked)} />Labels</label>
      <button type="button" disabled={!ready || !!error} onClick={() => { const viewer = renderer.current?.viewer; if (viewer) { initialCamera(viewer); viewer.render(); lastView.current = camera(viewer) } }}><RotateCcw size={14} />Reset view</button></div>
    <footer><p>Original FEFF geometry · Your view is remembered for this result.</p><button type="button" onClick={close}>Done</button></footer>
  </dialog>
}
