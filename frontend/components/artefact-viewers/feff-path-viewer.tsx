"use client"

import { useMemo, useState } from "react"
import type { ArtemisPath } from "@/lib/artemis"
import type { ArtemisStructureAttachment } from "@/lib/artemis-structures"
import { CIF_VIEWER_DEFAULT_RADIUS } from "@/lib/cif-viewer"
import { resolveFeffMultipathContext } from "@/lib/feff-multipath-context"
import { resolveFeffPathEquivalents } from "@/lib/feff-path-equivalents"
import { buildFeffPathGeometry, type FeffPathGeometry } from "@/lib/feff-path-geometry"
import { resolveFeffStructureContext, type FeffContextAtom } from "@/lib/feff-structure-context"
import { FeffPathScene } from "../feff-path-scene"
import { ViewerPanel } from "./viewer-panel"
import styles from "./feff-path-viewer.module.css"
import structureStyles from "./cif-viewer.module.css"

export type FeffPathSummary = Pick<ArtemisPath, "id" | "label" | "filename" | "enabled" | "metadata">
const number = (value: number) => Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : "—"
const siteLabel = (atom: FeffPathGeometry["visits"][number]) => `${atom.atom} ${atom.atomIndex === 0 ? "A" : atom.atomIndex}`
const PATH_COLORS = [
  "#AF2168", "#3285AD", "#8061B0", "#C27332", "#348778", "#BD4B53",
  "#597D24", "#4B57B8", "#A66C27", "#AF428E", "#188EA4", "#65865C",
  "#916643", "#57576D", "#B53D35", "#366DB7", "#897934", "#526795",
  "#A25B79", "#377665", "#7E47B0", "#CF7025", "#64798A", "#8B586A",
]
const clusterKey = (atoms: readonly FeffContextAtom[]) => atoms.map(atom =>
  `${atom.atom}:${atom.ipot ?? "?"}:${atom.x.toFixed(5)},${atom.y.toFixed(5)},${atom.z.toFixed(5)}`,
).sort().join(";")

function PathDetail({ path, color, selectedLeg, onSelectLeg }: { path: FeffPathSummary; color: string; selectedLeg: number | null; onSelectLeg: (leg: number | null) => void }) {
  const { geometry, error } = useMemo(() => buildFeffPathGeometry(path.metadata), [path.metadata])
  const leg = geometry?.legs.find(item => item.index === selectedLeg)

  return <div className={styles.detail}>
    <div className={styles.pathHeading}>
      <div><h3>{path.filename}</h3>{path.label && path.label !== path.filename && <p>{path.label}</p>}</div>
      <span className={styles.kind}>{geometry?.classification.label ?? `${path.metadata.nleg} legs`}</span>
    </div>
    <dl className={styles.facts}>
      <div><dt>Absorber / edge</dt><dd>{path.metadata.absorber} {path.metadata.edge}</dd></div>
      <div><dt>R<sub>eff</sub> · half length</dt><dd>{number(path.metadata.reff)} Å</dd></div>
      <div><dt>Degeneracy N</dt><dd>{number(path.metadata.degen)}</dd></div>
      <div><dt>Legs</dt><dd>{path.metadata.nleg}</dd></div>
    </dl>
    {geometry ? <>
      <div className={styles.scattering}>
        <p>{geometry.classification.description}</p>
        <div className={styles.route} aria-label="Scattering sequence">{geometry.visits.map((atom, index) => <span key={index}>
          {index > 0 && <span className={styles.routeArrow} aria-hidden="true"> → </span>}
          <span className={atom.atomIndex === 0 ? styles.absorber : undefined}>{siteLabel(atom)}</span>
        </span>)}</div>
        <div className={styles.legControls} role="group" aria-label="Highlight scattering leg">
          <button type="button" aria-pressed={selectedLeg === null} onClick={() => onSelectLeg(null)}>All legs</button>
          {geometry.legs.map(item => <button type="button" key={item.index} aria-pressed={selectedLeg === item.index} onClick={() => onSelectLeg(item.index)} title={`${siteLabel(item.from)} → ${siteLabel(item.to)} · ${number(item.length)} Å`}>
            <i style={{ background: color }} />Leg {item.index}
          </button>)}
        </div>
        <p className={styles.legDescription} aria-live="polite">{leg
          ? <>Leg {leg.index}: {siteLabel(leg.from)} → {siteLabel(leg.to)} · {number(leg.length)} Å{leg.index === geometry.legs.length ? " · return to absorber" : ` · scattering angle β = ${leg.scatteringAngle.toFixed(1)}°${leg.scatteringAngle < 1 ? " (forward)" : leg.scatteringAngle > 179 ? " (backscattering)" : ""}`}</>
          : <>Total travel {number(geometry.totalLength)} Å · {geometry.legs.length} directed legs · returns to absorber A</>}</p>
      </div>
      <p className={styles.note}>When verified, equivalent path atoms and bonds are also opaque. Arrows replace bonds along one representative trajectory per selected FEFF file; overlapping legs stay closely spaced for clarity. Path atoms remain visible outside the display radius.</p>
      <details className={styles.geometryDetails}>
        <summary>Coordinates and scattering angles</summary>
        <div className={styles.tableScroll}><table>
          <caption>Scattering path geometry · {path.filename}</caption>
          <thead><tr><th scope="col">Visit</th><th scope="col">Atom</th><th scope="col">x (Å)</th><th scope="col">y (Å)</th><th scope="col">z (Å)</th><th scope="col">β (°)</th></tr></thead>
          <tbody>{geometry.visits.map((atom, index) => <tr key={index}><th scope="row">{index === 0 ? "Start" : index === geometry.legs.length ? "Return" : index}</th><td>{siteLabel(atom)}</td><td>{number(atom.x)}</td><td>{number(atom.y)}</td><td>{number(atom.z)}</td><td>{index > 0 && index < geometry.legs.length ? geometry.legs[index - 1].scatteringAngle.toFixed(1) : "—"}</td></tr>)}</tbody>
        </table></div>
        <p className={styles.note}>Coordinates are relative to absorber A. β is the change in travel direction: 0° forward, 180° backscattering. R<sub>eff</sub> is half the total path length, not generally the absorber–neighbor distance for multiple scattering.</p>
      </details>
    </> : <p className={styles.empty} role="status">{error} The FEFF header metadata is shown above.</p>}
  </div>
}

const NO_STRUCTURES: ArtemisStructureAttachment[] = []

function PathWorkspace({ paths, attachments }: { paths: FeffPathSummary[]; attachments: ArtemisStructureAttachment[] }) {
  const [selection, setSelection] = useState<string[] | null>(null)
  const [focusedId, setFocusedId] = useState("")
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null)
  const [radius, setRadius] = useState(CIF_VIEWER_DEFAULT_RADIUS)
  const [structureChoice, setStructureChoice] = useState("")
  const entries = useMemo(() => paths.map((path, index) => ({ path, ...buildFeffPathGeometry(path.metadata), color: PATH_COLORS[index % PATH_COLORS.length] })), [paths])
  const selectedIds = useMemo(() => {
    if (selection === null) return [paths[0].id]
    const remaining = selection.filter(id => paths.some(path => path.id === id))
    return selection.length && !remaining.length ? [paths[0].id] : remaining
  }, [selection, paths])
  const selected = useMemo(() => entries.filter(entry => selectedIds.includes(entry.path.id)), [entries, selectedIds])
  const focused = selected.find(entry => entry.path.id === focusedId) ?? selected.at(-1)
    ?? entries.find(entry => entry.path.id === focusedId) ?? entries[0]
  const context = useMemo(() => {
    const choice = structureChoice ? JSON.parse(structureChoice) as [string, number] : undefined
    const ordered = [focused, ...selected.filter(entry => entry !== focused)]
    return resolveFeffMultipathContext(ordered.map(entry => entry.path.metadata), attachments, {
      radius, selectedAttachmentId: choice?.[0], selectedSiteIndex: choice?.[1],
    })
  }, [focused, selected, attachments, radius, structureChoice])
  // Equivalence must not depend on the display cutoff. Search the verified source
  // out to every selected path's extent, while retaining the smaller local view.
  const matchingContext = useMemo(() => {
    const pathRadius = Math.max(1, ...selected.flatMap(entry => entry.geometry?.atoms.map(atom => Math.hypot(atom.x, atom.y, atom.z)) ?? [])) + 0.01
    if (!context.source || (!context.truncated && context.radius >= pathRadius)) return context
    const ordered = [focused, ...selected.filter(entry => entry !== focused)]
    return resolveFeffMultipathContext(ordered.map(entry => entry.path.metadata), attachments, {
      radius: pathRadius, selectedAttachmentId: context.attachmentId, selectedSiteIndex: context.siteIndex,
    })
  }, [context, focused, selected, attachments])
  const scenePaths = useMemo(() => selected.flatMap(entry => {
    if (!entry.geometry) return []
    // One selected file must never borrow another file's FEFF cluster to infer
    // its equivalents. A shared CIF is eligible only for paths without their
    // own recorded FEFF source; multipath context already verifies those paths.
    let sourceMatches = true
    if (matchingContext.source === "feff.inp") {
      const own = resolveFeffStructureContext(entry.path.metadata, [], { radius: matchingContext.radius })
      sourceMatches = own.source === "feff.inp" && own.radius === matchingContext.radius &&
        clusterKey(own.atoms) === clusterKey(matchingContext.atoms)
    } else if (matchingContext.source === "cif" && entry.path.metadata.viewerCluster) {
      sourceMatches = false
    }
    const equivalents = matchingContext.source && !matchingContext.truncated && sourceMatches
      ? resolveFeffPathEquivalents(entry.geometry, entry.path.metadata.degen, matchingContext.atoms) : undefined
    const equivalenceWarning = matchingContext.source && !matchingContext.truncated && !sourceMatches
      ? "Equivalent paths were not expanded: this file's recorded source is unavailable or differs from the shared local structure. Showing its representative path."
      : undefined
    return [{ id: entry.path.id, filename: entry.path.filename, geometry: entry.geometry, color: entry.color, equivalents, equivalenceWarning }]
  }), [selected, matchingContext])
  const toggle = (id: string) => {
    setSelection(selectedIds.includes(id) ? selectedIds.filter(item => item !== id) : [...selectedIds, id])
    if (!selectedIds.includes(id)) setFocusedId(id)
    setSelectedLeg(null)
    setStructureChoice("")
  }
  const legend = <div className={styles.pathLegend} role="group" aria-label="FEFF path legend">
    <span className={styles.legendHint}>Paths · click to show / hide</span>
    <div className={styles.legendItems}>{entries.map(({ path, color }) => {
      const duplicate = paths.filter(item => item.filename === path.filename).length > 1
      const label = path.filename.replace(/\.dat$/i, "").toUpperCase()
      return <button type="button" key={path.id} aria-label={`Show ${path.filename}${duplicate ? ` · ${path.label}` : ""}`}
        aria-pressed={selectedIds.includes(path.id)} onClick={() => toggle(path.id)}
        title={`${path.filename} · ${path.label} · ${path.metadata.nleg} legs · Reff ${number(path.metadata.reff)} Å${!path.enabled ? " · Excluded from fit" : ""}`}>
        <i style={{ background: color }} />{label}{duplicate && <small>{path.label}</small>}
      </button>
    })}</div>
  </div>
  return <div className={styles.workspace}>
    <FeffPathScene paths={scenePaths} activePathId={focused.path.id} selectedLeg={selectedLeg} context={context.atoms}
      contextLabel={context.source ? context.sourceLabel : undefined} radius={context.radius} maxRadius={context.maxRadius} onRadiusChange={setRadius}
      legend={legend}
      structureControls={context.candidates.length > 1 ? <div className={structureStyles.controls}><label>Project CIF
        <select aria-label="FEFF local structure source" value={context.attachmentId ? JSON.stringify([context.attachmentId, context.siteIndex]) : ""} onChange={event => setStructureChoice(event.target.value)}>
          <option value="" disabled>Select matching structure</option>
          {context.candidates.map(candidate => <option key={`${candidate.attachmentId}:${candidate.siteIndex}`} value={JSON.stringify([candidate.attachmentId, candidate.siteIndex])}>{candidate.label}</option>)}
        </select>
      </label></div> : undefined} />
    {context.warnings.filter(warning => warning !== focused.error).map(warning => <p className={styles.note} key={warning}>{warning}</p>)}
    {matchingContext.source && matchingContext.truncated && <p className={styles.note}>Equivalent paths were not expanded: the CIF preview is limited at the path extent. Showing representative paths.</p>}
    {scenePaths.map(path => path.equivalents?.warning && <p className={styles.note} key={path.id}>{path.filename}: {path.equivalents.warning}</p>)}
    {scenePaths.map(path => path.equivalenceWarning && <p className={styles.note} key={`${path.id}-source`}>{path.filename}: {path.equivalenceWarning}</p>)}
    {!context.source && !context.requiresSelection && <p className={styles.note}>Attach a matching project CIF or generate paths from a CIF to show the surrounding local structure. These files contain path atoms only.</p>}
    {!selected.length ? <p className={styles.note} role="status">Click a FEFF legend to show its path. You can display several paths together.</p> : <>
      {selected.length > 1 && <label className={styles.detailPicker}>Path details <select aria-label="Path details" value={focused.path.id} onChange={event => { setFocusedId(event.target.value); setSelectedLeg(null) }}>
        {selected.map(({ path }) => <option key={path.id} value={path.id}>{path.filename}{paths.filter(item => item.filename === path.filename).length > 1 ? ` · ${path.label}` : ""}</option>)}
      </select><span>{selected.length} paths shown</span></label>}
      {!focused.path.enabled && <p className={styles.note}>Excluded from fit · displayed for inspection</p>}
      <PathDetail path={focused.path} color={focused.color} selectedLeg={selectedLeg} onSelectLeg={setSelectedLeg} />
    </>}
  </div>
}

export function FeffPathViewer({ paths, groupLabel, onOpenModel, attachments = NO_STRUCTURES }: {
  paths: FeffPathSummary[]
  groupLabel?: string
  onOpenModel: () => void
  attachments?: ArtemisStructureAttachment[]
}) {
  return <ViewerPanel title="FEFF path viewer" viewerId="feff" className={styles.panel}>
    <div className={styles.content}>
      <div className={styles.heading}><span>Current spectrum <strong>{groupLabel ?? "None selected"}</strong></span><button type="button" onClick={onOpenModel}>{paths.length ? "Edit paths" : "Open EXAFS fitting"}</button></div>
      {!paths.length ? <p className={styles.empty}>Add or generate FEFF paths in the EXAFS fitting tab to inspect their geometry here.</p>
        : <PathWorkspace paths={paths} attachments={attachments} />}
    </div>
  </ViewerPanel>
}
