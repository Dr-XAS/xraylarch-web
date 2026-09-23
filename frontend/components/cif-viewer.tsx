"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { AtomSpec, GLViewer } from "3dmol"
import type { ArtemisStructure } from "@/lib/artemis-structures"
import { buildCifGeometry, CIF_VIEWER_DEFAULT_RADIUS, CIF_VIEWER_MAX_RADIUS, CIF_VIEWER_MIN_RADIUS } from "@/lib/cif-viewer"
import { createCifRenderer } from "@/lib/cif-renderer"
import { cifAtomStyle } from "@/lib/cif-viewer-style"
import { AtomLegend } from "./atom-legend"
import { LocalStructureControls } from "./local-structure-controls"
import { StructureDisplayLegend } from "./structure-display-legend"
import { ViewerPanel } from "./viewer-panel"
import styles from "./cif-viewer.module.css"

const point = ([x, y, z]: [number, number, number]) => ({ x, y, z })

export function CifViewer({ structure, collapsible = false, structureControls }: {
  structure: ArtemisStructure
  collapsible?: boolean
  structureControls?: ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const viewer = useRef<GLViewer | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [radius, setRadius] = useState(CIF_VIEWER_DEFAULT_RADIUS)
  const [center, setCenter] = useState(structure.sites[0]?.index)
  const [mode, setMode] = useState<"cluster" | "cell">("cluster")
  const [hidden, setHidden] = useState<string[]>([])
  const [bonds, setBonds] = useState(true)
  const [cell, setCell] = useState(false)
  const centerSites = useMemo(() => structure.sites.filter((site, index, all) => all.findIndex(other => other.index === site.index) === index), [structure.sites])
  const geometry = useMemo(() => buildCifGeometry(structure, { siteIndex: center, radius, mode }), [structure, center, radius, mode])
  const elements = useMemo(() => [...new Set(geometry.atoms.map(atom => atom.element))].sort(), [geometry])
  const visibleCount = geometry.atoms.filter(atom => !hidden.includes(atom.element)).length

  useEffect(() => {
    const host = container.current
    setReady(false)
    if (!host || !geometry.atoms.length) return
    let disposed = false
    let instance: GLViewer | null = null
    let disposeRenderer: (() => void) | undefined
    setError("")
    import("3dmol").then(mol => {
      if (disposed) return
      const renderer = createCifRenderer(mol, host)
      instance = renderer.viewer
      disposeRenderer = renderer.dispose
      instance.setBackgroundColor("#000000", 0)
      instance.setHoverDuration(80)
      viewer.current = instance
      setReady(true)
    }).catch(() => {
      if (!disposed) setError("Unable to load the 3D viewer. Check that WebGL is enabled, then retry.")
    })
    return () => {
      disposed = true
      if (viewer.current === instance) viewer.current = null
      disposeRenderer?.()
      host.replaceChildren()
    }
    // Keep one renderer while changing display controls; rebuild only after a
    // failed load or when valid geometry becomes available.
  }, [attempt, !!geometry.atoms.length])

  useEffect(() => {
    const instance = viewer.current
    if (!ready || !instance) return
    try {
      instance.clear()
      const xyz = `${geometry.atoms.length}\nCrystal structure\n${geometry.atoms.map(atom => `${atom.element} ${atom.x} ${atom.y} ${atom.z}`).join("\n")}`
      instance.addModel(xyz, "xyz")
      instance.setStyle({}, {})
      for (const [index, element] of elements.entries()) {
        if (hidden.includes(element)) continue
        instance.addStyle({ elem: element }, cifAtomStyle(index, bonds))
      }
      if (cell || mode === "cell") {
        for (const [start, end] of geometry.cellEdges) instance.addLine({ start: point(start), end: point(end), color: "#92949e" })
      }
      instance.setHoverable({}, true, (atom: AtomSpec) => {
        const source = geometry.atoms[atom.index ?? -1]
        if (!source || hidden.includes(source.element)) return
        instance.removeAllLabels()
        instance.addLabel(`${source.element} · site ${source.siteIndex} · ${source.distance.toFixed(3)} Å`, {
          position: { x: source.x, y: source.y, z: source.z + 0.4 }, fontSize: 12,
          fontColor: "white", backgroundColor: "#27272a", backgroundOpacity: 0.9, inFront: true,
        })
        instance.render()
      }, () => { instance.removeAllLabels(); instance.render() })
      instance.zoomTo()
      instance.render()
      setError("")
    } catch {
      setError("Unable to render this crystal structure.")
    }
  }, [ready, geometry, elements, hidden, bonds, cell, mode])

  const resetButton = <button type="button" disabled={!ready || !!error} onClick={() => { viewer.current?.zoomTo(); viewer.current?.render() }}>Reset view</button>
  const content = <>
    {structureControls}
    <div className={styles.canvas}>
      <div ref={container} className={styles.surface} role="img" aria-label={`Interactive 3D crystal structure of ${structure.mineral || structure.formula}`} />
      {ready && !error && geometry.atoms.length > 0 && geometry.lattice && structure.sites.length > 0 && <div className={styles.legendCorner}>
        <AtomLegend elements={elements} hiddenElements={hidden}
          onToggle={element => setHidden(previous => previous.includes(element) ? previous.filter(item => item !== element) : [...previous, element])}
          ariaLabel="Visible CIF elements" />
        <StructureDisplayLegend bonds={bonds} onBondsChange={setBonds}
          unitCell={{ checked: cell || mode === "cell", disabled: mode === "cell", onChange: setCell }} />
      </div>}
      {!geometry.atoms.length ? <p className={styles.overlay}>A 3D preview is unavailable for this CIF.</p>
        : error ? <div className={styles.overlay} role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>Retry 3D viewer</button></div>
        : !ready ? <p className={styles.overlay} role="status">Loading 3D structure…</p> : null}
    </div>
    {geometry.lattice && structure.sites.length > 0 && <>
      <p className={styles.help}>Drag to rotate · scroll or pinch to zoom · hover for atom details</p>
      <div className={styles.controls}>
        <label>View<select aria-label="CIF view mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="cluster">Local cluster</option><option value="cell">Unit cell</option></select></label>
        <label>Center site<select aria-label="CIF center site" value={center} onChange={event => setCenter(Number(event.target.value))}>{centerSites.map(site => <option key={site.index} value={site.index}>{site.species} · site {site.index}</option>)}</select></label>
      </div>
      <LocalStructureControls radius={radius} min={CIF_VIEWER_MIN_RADIUS} max={CIF_VIEWER_MAX_RADIUS} onRadiusChange={setRadius}
        radiusAriaLabel="CIF display radius" radiusDisabled={mode === "cell"} bonds={bonds} onBondsChange={setBonds}
        showBondsControl={false} atomCount={visibleCount} />
      <p className={styles.help}>Bonds are inferred from distances. Display settings do not change FEFF parameters.</p>
    </>}
    {geometry.warnings.map(warning => <p className={styles.warning} key={warning}>{warning}</p>)}
  </>
  return collapsible
    ? <ViewerPanel title="CIF structure viewer" actions={resetButton} className={styles.docked}>{content}</ViewerPanel>
    : <section className={styles.viewer} aria-label="CIF structure viewer">
      <div className={styles.heading}><h4>CIF structure viewer</h4>{resetButton}</div>
      {content}
    </section>
}
