"use client"

import { SectionHelp } from "../section-help"
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import type { AtomSpec, GLViewer } from "3dmol"
import type { ArtemisStructure } from "@/lib/artemis-structures"
import { buildCifGeometry, CIF_VIEWER_DEFAULT_RADIUS, CIF_VIEWER_MAX_CELL_REPEATS, CIF_VIEWER_MAX_RADIUS, CIF_VIEWER_MIN_RADIUS, type CifVector } from "@/lib/cif-viewer"
import { createCifRenderer } from "@/lib/cif-renderer"
import { cifAtomStyle, CIF_SPHERE_RADIUS } from "@/lib/cif-viewer-style"
import { firstShellAtoms, isShellAtom } from "@/lib/first-shell"
import { useFirstShell, type FirstShellState } from "@/lib/use-first-shell"
import { FirstShellSummary } from "../first-shell-summary"
import { radialShellAtoms, shellColor } from "@/lib/radial-shells"
import { useRadialShells, type RadialShellState } from "@/lib/use-radial-shells"
import { RadialShellPanel } from "../radial-shell-panel"
import { AtomLegend } from "../atom-legend"
import { LocalStructureControls } from "../local-structure-controls"
import { StructureDisplayLegend } from "../structure-display-legend"
import { ViewerPanel } from "./viewer-panel"
import { ClusterCoordination } from "./cluster-coordination"
import styles from "./cif-viewer.module.css"

const point = ([x, y, z]: [number, number, number]) => ({ x, y, z })

function CellRepeatInput({ axis, value, onChange }: { axis: string; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return <label>{axis}<input type="number" aria-label={`CIF repeats along ${axis}`} min={1} max={CIF_VIEWER_MAX_CELL_REPEATS} step={1}
    value={draft ?? value} onChange={event => {
      const text = event.target.value
      setDraft(text)
      const count = Number(text)
      if (text !== "" && Number.isInteger(count) && count >= 1 && count <= CIF_VIEWER_MAX_CELL_REPEATS) onChange(count)
    }} onBlur={event => {
      const count = Number(event.target.value)
      onChange(Number.isFinite(count) ? Math.min(CIF_VIEWER_MAX_CELL_REPEATS, Math.max(1, Math.floor(count))) : 1)
      setDraft(null)
    }} /></label>
}

export function CifViewer({ structure, collapsible = false, structureControls, selectedSite, onSiteChange, analysis, radialAnalysis }: {
  structure: ArtemisStructure
  collapsible?: boolean
  structureControls?: ReactNode
  selectedSite?: number
  onSiteChange?: (site: number) => void
  analysis?: FirstShellState
  radialAnalysis?: RadialShellState
}) {
  const container = useRef<HTMLDivElement>(null)
  const viewer = useRef<GLViewer | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [radius, setRadius] = useState(CIF_VIEWER_DEFAULT_RADIUS)
  const [cellRepeats, setCellRepeats] = useState<CifVector>([1, 1, 1])
  const centerKey = `${structure.cif}:${selectedSite ?? "default"}`
  const defaultCenter = selectedSite ?? structure.sites[0]?.index
  const [localCenter, setCenter] = useState({ key: centerKey, site: defaultCenter })
  const center = localCenter.key === centerKey ? localCenter.site : defaultCenter
  useEffect(() => { setCenter(previous => previous.key === centerKey ? previous : { key: centerKey, site: defaultCenter }) }, [centerKey, defaultCenter])
  const [mode, setMode] = useState<"cluster" | "cell" | "shell" | "radial">("cluster")
  const [highlightShell, setHighlightShell] = useState(true)
  const useExternalAnalysis = analysis !== undefined && center === selectedSite
  const localAnalysis = useFirstShell(structure, center, !useExternalAnalysis)
  const shellState = useExternalAnalysis ? analysis! : localAnalysis
  const shell = shellState.shell && shellState.shell.site_index === center && shellState.shell.cif === structure.cif ? shellState.shell : null
  const shellAtoms = useMemo(() => shell ? firstShellAtoms(structure, shell) : [], [structure, shell])
  const useExternalRadial = radialAnalysis !== undefined && center === selectedSite
  const localRadial = useRadialShells(structure, center, !useExternalRadial)
  const radialState = useExternalRadial ? radialAnalysis! : localRadial
  const radial = radialState.data?.cif === structure.cif && radialState.data.site_index === center ? radialState.data : null
  const radialAtoms = useMemo(() => radial ? radialShellAtoms(structure, radial) : [], [structure, radial])
  const radialKey = `${structure.cif}:${center}:${radialState.settings.radius}:${radialState.settings.tolerance}`
  const [shellVisibility, setShellVisibility] = useState({ key: radialKey, indices: [1, 2, 3] })
  const visibleShells = shellVisibility.key === radialKey ? shellVisibility.indices : [1, 2, 3]
  const [hidden, setHidden] = useState<string[]>([])
  const [bonds, setBonds] = useState(true)
  const [cell, setCell] = useState(false)
  const [coordinationPanel, setCoordinationPanel] = useState<"unopened" | "open" | "closed">("unopened")
  const coordinationId = useId()
  const centerSites = useMemo(() => structure.sites.filter((site, index, all) => all.findIndex(other => other.index === site.index) === index), [structure.sites])
  const geometryMode = mode === "cell" ? "cell" : "cluster"
  const baseGeometry = useMemo(() => buildCifGeometry(structure, { siteIndex: center, radius, mode: geometryMode, cellRepeats }),
    [structure, center, radius, geometryMode, cellRepeats])
  const geometry = useMemo(() => {
    // An asynchronously loaded CrystalNN overlay does not change the cluster
    // being analyzed, so keep its geometry and calculated CNs intact.
    if (mode === "radial") {
      const absorber = baseGeometry.atoms.find(atom => atom.isAbsorber)
      return { ...baseGeometry, atoms: radial && absorber ? [absorber, ...radialAtoms.filter(atom => visibleShells.includes(atom.shellIndex))] : [], truncated: false, warnings: [] }
    }
    if (mode !== "shell") return baseGeometry
    if (!shell) return { ...baseGeometry, atoms: [] }
    const absorber = baseGeometry.atoms.find(atom => atom.isAbsorber)
    return absorber ? { ...baseGeometry, atoms: [absorber, ...shellAtoms], truncated: false, warnings: [] } : baseGeometry
  }, [baseGeometry, mode, shell, shellAtoms, radial, radialAtoms, shellVisibility, radialKey])
  const elements = useMemo(() => [...new Set(geometry.atoms.map(atom => atom.element))].sort(), [geometry])
  const visibleCount = geometry.atoms.filter(atom => !hidden.includes(atom.element)).length
  const coordinationUnavailable = mode !== "cluster" ? "Switch to Local cluster to calculate coordination numbers."
    : geometry.truncated ? "Reduce the display radius to calculate coordination numbers for a complete cluster."
    : !geometry.atoms.length ? "Coordination numbers require a complete cluster."
    : !structure.ordered || structure.sites.some(site => Math.abs(site.occupancy - 1) > 1e-6) ? "Coordination numbers require fully occupied, ordered sites." : ""

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
      if (mode === "radial" && radial) {
        geometry.atoms.forEach((atom, index) => {
          if (hidden.includes(atom.element)) return
          const member = radialAtoms.find(neighbor => isShellAtom(atom, [neighbor]))
          if (atom.isAbsorber) instance.addStyle({ index }, { sphere: { color: "#f59e0b", radius: 0.45 } })
          else if (member) instance.addStyle({ index }, { sphere: { color: shellColor(member.shellIndex), radius: CIF_SPHERE_RADIUS } })
        })
      } else if (shell && (highlightShell || mode === "shell")) {
        geometry.atoms.forEach((atom, index) => {
          if (hidden.includes(atom.element)) return
          if (atom.isAbsorber) instance.addStyle({ index }, { sphere: { color: "#f59e0b", radius: 0.45 } })
          else if (isShellAtom(atom, shellAtoms)) {
            instance.addStyle({ index }, { sphere: { color: "#06b6d4", radius: CIF_SPHERE_RADIUS } })
            if (bonds && mode === "shell" && !hidden.includes(shell.absorber)) instance.addLine({ start: { x: 0, y: 0, z: 0 }, end: { x: atom.x, y: atom.y, z: atom.z }, color: "#06b6d4", linewidth: 3 })
          }
        })
      }
      if (cell || mode === "cell") {
        for (const [start, end] of geometry.cellEdges) instance.addLine({ start: point(start), end: point(end), color: "#92949e" })
      }
      instance.setHoverable({}, true, (atom: AtomSpec) => {
        const source = geometry.atoms[atom.index ?? -1]
        if (!source || hidden.includes(source.element)) return
        instance.removeAllLabels()
        const member = mode === "radial" ? radialAtoms.find(neighbor => isShellAtom(source, [neighbor])) : undefined
        instance.addLabel(`${source.siteIndex < 0 ? source.label : `${source.element} · site ${source.siteIndex}`} · ${source.distance.toFixed(3)} Å${member ? ` · Shell ${member.shellIndex} · pair ${member.groupId}` : isShellAtom(source, shellAtoms) ? " · CrystalNN first shell" : ""}`, {
          position: { x: source.x, y: source.y, z: source.z + 0.4 }, fontSize: 12,
          fontColor: "white", backgroundColor: "#27272a", backgroundOpacity: 0.9, inFront: true,
        })
        instance.render()
      }, () => { instance.removeAllLabels(); instance.render() })
      instance.zoomTo()
      if (mode === "shell") instance.zoom(1.8)
      instance.render()
      setError("")
    } catch {
      setError("Unable to render this crystal structure.")
    }
  }, [ready, geometry, elements, hidden, bonds, cell, mode, shell, shellAtoms, highlightShell, radial, radialAtoms])

  const resetButton = <button type="button" disabled={!ready || !!error} onClick={() => { viewer.current?.zoomTo(); if (mode === "shell") viewer.current?.zoom(1.8); viewer.current?.render() }}>Reset view</button>
  const actions = <div className={styles.headerActions}>
    <button type="button" aria-expanded={coordinationPanel === "open"} aria-controls={coordinationId}
      onClick={() => setCoordinationPanel(previous => previous === "open" ? "closed" : "open")}>Coordination numbers</button>
    {resetButton}
  </div>
  const viewerHelp = <>Drag to rotate; scroll or pinch to zoom; hover for atom details. Bonds are inferred from distances. Display settings do not change FEFF parameters. Amber marks the absorber; cyan marks CrystalNN neighbors. In radial view, shell colors and neighbor counts appear in the shell table. Element visibility does not change shell membership. Use CrystalNN first shell view to show all periodic neighbors.</>
  const content = <>
    {structureControls}
    <div className={styles.canvas}>
      <div ref={container} className={styles.surface} role="img" aria-label={`Interactive 3D crystal structure of ${structure.mineral || structure.formula}`} />
      {ready && !error && geometry.atoms.length > 0 && geometry.lattice && structure.sites.length > 0 && <div className={styles.legendCorner}>
        {mode === "radial" ? <div className={styles.options} aria-label="Visible CIF elements">{elements.map(element => <label key={element}><input type="checkbox" checked={!hidden.includes(element)} onChange={() => setHidden(previous => previous.includes(element) ? previous.filter(item => item !== element) : [...previous, element])} />{element}</label>)}</div> : <AtomLegend elements={elements} hiddenElements={hidden}
          onToggle={element => setHidden(previous => previous.includes(element) ? previous.filter(item => item !== element) : [...previous, element])}
          ariaLabel="Visible CIF elements" />}
        <StructureDisplayLegend bonds={bonds} onBondsChange={setBonds}
          unitCell={{ checked: cell || mode === "cell", disabled: mode === "cell", onChange: setCell }} />
      </div>}
      {!geometry.atoms.length ? <p className={styles.overlay}>{mode === "radial" && radialState.loading ? "Calculating periodic radial shells…" : "A 3D preview is unavailable for this CIF."}</p>
        : error ? <div className={styles.overlay} role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>Retry 3D viewer</button></div>
        : !ready ? <p className={styles.overlay} role="status">Loading 3D structure…</p> : null}
    </div>
    {geometry.lattice && structure.sites.length > 0 && <>
      <div className={styles.controls}>
        <label>View<select aria-label="CIF view mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="cluster">Local cluster</option><option value="cell">Unit cell</option><option value="shell" disabled={!shell}>CrystalNN first shell</option><option value="radial" disabled={!radial}>Radial shells</option></select></label>
        <label>Center site<select aria-label="CIF center site" value={center} onChange={event => { const site = Number(event.target.value); setCenter({ key: centerKey, site }); onSiteChange?.(site) }}>{centerSites.map(site => <option key={site.index} value={site.index}>{site.species} · site {site.index}</option>)}</select></label>
        {shell && mode !== "radial" && <label><input type="checkbox" aria-label="Highlight CrystalNN first shell" checked={highlightShell || mode === "shell"} disabled={mode === "shell"} onChange={event => setHighlightShell(event.target.checked)} />First shell</label>}
      </div>
      <LocalStructureControls radius={radius} min={CIF_VIEWER_MIN_RADIUS} max={CIF_VIEWER_MAX_RADIUS} onRadiusChange={setRadius}
        radiusAriaLabel="CIF display radius" bonds={bonds} onBondsChange={setBonds}
        extentControl={mode === "radial" ? <span>Selected radial shells · search to {radialState.settings.radius} Å</span> : mode === "shell" && shell ? <span>Complete first shell · {shell.coordination_number} neighbors</span> : mode === "cell" ? <div className={styles.cellRepeats} role="group" aria-label="Unit cell repetitions">
          <span>Unit cell repeats</span>
          <div className={styles.cellAxes}>{["a", "b", "c"].map((axis, index) => <CellRepeatInput key={axis} axis={axis}
            value={cellRepeats[index]} onChange={repeat => setCellRepeats(previous => previous.map((count, i) => i === index ? repeat : count) as CifVector)} />)}</div>
        </div> : undefined}
        showBondsControl={false} atomCount={visibleCount} />
      <div className={styles.help}><FirstShellSummary state={{ ...shellState, shell }} /></div>
      <details className={styles.help} open={mode === "radial" ? true : undefined}><summary>Radial shell ranges & display</summary>
        <RadialShellPanel state={{ ...radialState, data: radial }} selected={visibleShells} onToggle={index => {
          setShellVisibility({ key: radialKey, indices: visibleShells.includes(index) ? visibleShells.filter(value => value !== index) : [...visibleShells, index] })
          setMode("radial")
        }} />
      </details>
    </>}
    {geometry.warnings.map(warning => <p className={styles.warning} key={warning}>{warning}</p>)}
    {coordinationPanel !== "unopened" && <div id={coordinationId} hidden={coordinationPanel !== "open"}>
      <ClusterCoordination geometry={geometry} unavailableReason={coordinationUnavailable} />
    </div>}
  </>
  return collapsible
    ? <ViewerPanel title="CIF structure viewer" viewerId="cif" help={viewerHelp} actions={actions} className={styles.docked}>{content}</ViewerPanel>
    : <section className={styles.viewer} aria-label="CIF structure viewer">
      <div className={styles.heading}><h4>CIF structure viewer<SectionHelp label="CIF structure viewer">{viewerHelp}</SectionHelp></h4>{actions}</div>
      {content}
    </section>
}
