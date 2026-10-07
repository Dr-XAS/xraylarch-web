"use client"

import { SectionHelp } from "./section-help"
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import type { GLViewer, Vector2 } from "3dmol"
import { createCifRenderer } from "@/lib/cif-renderer"
import { drawFeffScene, feffSceneAtoms, type FeffContextAtom, type FeffScenePath } from "@/lib/feff-scene"
import { AtomLegend } from "./atom-legend"
import { LocalStructureControls } from "./local-structure-controls"
import { StructureDisplayLegend } from "./structure-display-legend"
import { ResizablePlotCard } from "./artefact-viewers/athena-plot-card"
import structureStyles from "./artefact-viewers/cif-viewer.module.css"
import pathStyles from "./artefact-viewers/feff-path-viewer.module.css"

export { FEFF_LEG_COLORS, FEFF_CONTEXT_OPACITY, feffArrow } from "@/lib/feff-scene"
export type { FeffContextAtom, FeffScenePath } from "@/lib/feff-scene"
const EMPTY_CONTEXT: FeffContextAtom[] = []

export function FeffPathScene({ paths, activePathId, selectedLeg, context = EMPTY_CONTEXT, contextLabel,
  radius = 3.5, maxRadius = 10, onRadiusChange, structureControls, legend }: {
  paths: FeffScenePath[]
  activePathId?: string
  selectedLeg: number | null
  context?: FeffContextAtom[]
  contextLabel?: string
  radius?: number
  maxRadius?: number
  onRadiusChange?: (value: number) => void
  structureControls?: ReactNode
  legend?: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const plotId = useId()
  const viewer = useRef<GLViewer | null>(null)
  const renderedContext = useRef<string | null>(null)
  const labelOffset = useRef<Vector2 | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [themeRevision, setThemeRevision] = useState(0)
  const [labels, setLabels] = useState(true)
  const [showContext, setShowContext] = useState(true)
  const [bonds, setBonds] = useState(true)
  const atoms = useMemo(() => feffSceneAtoms(paths, context, showContext), [paths, context, showContext])
  const elements = useMemo(() => [...new Set(atoms.map(atom => atom.atom))].sort(), [atoms])
  // Resolvers may produce fresh arrays for the same crystal. Selection, label,
  // bond and local-structure toggles should not reset the user's camera.
  const contextKey = useMemo(() => JSON.stringify(context.map(atom => [atom.atom, atom.x, atom.y, atom.z].join(":")).sort()), [context])
  const activePath = paths.find(path => path.id === activePathId) ?? paths[0]
  const imageDescription = paths.length === 1
    ? `Interactive 3D scattering path for ${paths[0].filename}: ${paths[0].geometry.classification.label}`
    : `Interactive 3D scattering paths: ${paths.length ? paths.map(path => path.filename).join(", ") : "local structure; no paths selected"}`

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision(value => value + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const container = host.current
    if (!container) return
    let cancelled = false
    let dispose: (() => void) | undefined
    setReady(false)
    setError("")
    import("3dmol").then(mol => {
      if (cancelled) return
      const renderer = createCifRenderer(mol, container)
      dispose = renderer.dispose
      viewer.current = renderer.viewer
      labelOffset.current = new mol.Vector2(16, 16)
      renderedContext.current = null
      renderer.viewer.setHoverDuration(80)
      setReady(true)
    }).catch(() => { if (!cancelled) setError("Unable to load the 3D viewer. Enable WebGL, then retry. Path coordinates remain available below.") })
    return () => {
      cancelled = true
      viewer.current = null
      dispose?.()
      container.replaceChildren()
    }
  }, [attempt])

  useEffect(() => {
    const scene = viewer.current
    if (!ready || !scene) return
    try {
      const oldView = scene.getView()
      const canvas = host.current?.parentElement
      drawFeffScene(scene, { paths, activePathId, selectedLeg, context, showContext, labels, bonds,
        background: canvas ? getComputedStyle(canvas).backgroundColor || "#ffffff" : "#ffffff",
        ink: host.current ? getComputedStyle(host.current).getPropertyValue("--ath-ink").trim() || "#384150" : "#384150",
        labelOffset: labelOffset.current })
      if (atoms.length && renderedContext.current !== contextKey) {
        scene.zoomTo()
        renderedContext.current = contextKey
      } else scene.setView(oldView)
      scene.render()
      setError("")
    } catch {
      setError("Unable to render this path. Path coordinates remain available below.")
    }
  }, [ready, paths, activePath, atoms, elements, contextKey, selectedLeg, labels, bonds, themeRevision])

  return <section className={structureStyles.viewer} aria-label="FEFF local structure">
    <div className={structureStyles.heading}>
      <h4>Local structure<SectionHelp label="FEFF local structure">Drag to rotate; scroll or pinch to zoom; hover for atom details. Bonds are inferred from distances. Colored arrows show the scattering sequence.</SectionHelp></h4>
      <button type="button" disabled={!ready || !!error || !atoms.length} onClick={() => { viewer.current?.zoomTo(); viewer.current?.render() }}>Reset view</button>
    </div>
    <ResizablePlotCard className={structureStyles.resizeCard} storageKey="artemis.feff.structure.height.v1"
      defaultHeight={310} minHeight={250} plotSelector="[data-feff-plot]" resizeLabel="Resize FEFF structure height" controlsId={plotId}>
    {structureControls}
    <div className={`${structureStyles.canvas} ${pathStyles.sceneCanvas}`}>
      <div id={plotId} data-feff-plot ref={host} className={`${structureStyles.surface} ${pathStyles.sceneSurface}`} role="img" aria-label={imageDescription} />
      {ready && !error && elements.length > 0 && <div className={pathStyles.cornerLegend}>
        <AtomLegend elements={elements} className={pathStyles.atomLegend} ariaLabel="Visible FEFF elements" />
        <StructureDisplayLegend bonds={bonds} onBondsChange={setBonds} />
      </div>}
      {error ? <div className={structureStyles.overlay} role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>Retry 3D viewer</button></div>
        : !ready ? <p className={structureStyles.overlay} role="status">Loading 3D scattering path…</p>
        : !atoms.length ? <p className={structureStyles.overlay}>Select a path to view its scattering trajectory.</p> : null}
      {legend}
    </div>
    <LocalStructureControls radius={radius} min={1} max={maxRadius} onRadiusChange={onRadiusChange ?? (() => {})}
      radiusAriaLabel="FEFF display radius" radiusDisabled={!contextLabel || !showContext}
      bonds={bonds} onBondsChange={setBonds} showBondsControl={false} atomCount={atoms.length}>
      {contextLabel && <span>{contextLabel}</span>}
      <label><input type="checkbox" aria-label="Labels" checked={labels} onChange={event => setLabels(event.target.checked)} />Labels<SectionHelp label="FEFF atom labels">Show element and atom identifiers on the scattering path. Hide labels to reduce overlap; hover still provides atom details.</SectionHelp></label>
      {contextLabel && <label><input type="checkbox" aria-label="Local structure" checked={showContext} onChange={event => setShowContext(event.target.checked)} />Local structure<SectionHelp label="Show FEFF local structure">Show surrounding atoms from the verified FEFF input or matching CIF. The selected scattering paths remain visible when the context is hidden.</SectionHelp></label>}
    </LocalStructureControls>
    </ResizablePlotCard>
  </section>
}
