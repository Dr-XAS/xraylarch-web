"use client"

import { SectionHelp } from "../section-help"
import { useId, useMemo, useState } from "react"
import type { ArtemisPath } from "@/lib/artemis"
import { format } from "@/lib/artemis-fit-utils"
import {
  ALL_PATHS, filterPathRows, sortPathRows, useArtemisPathPreview,
  type ArtemisPreviewRequest, type ArtemisPreviewState, type PathFilter, type PathRow, type PathSortKey,
} from "@/lib/artemis-path-preview"
import type { ArtemisStructureAttachment } from "@/lib/artemis-structures"
import { CIF_VIEWER_DEFAULT_RADIUS } from "@/lib/cif-viewer"
import { ThemedPlot as Plot } from "../themed-plot"
import { resolveFeffMultipathContext } from "@/lib/feff-multipath-context"
import { resolveFeffPathEquivalents } from "@/lib/feff-path-equivalents"
import { buildFeffPathGeometry, type FeffPathGeometry } from "@/lib/feff-path-geometry"
import { groupFeffPathSources } from "@/lib/feff-path-sources"
import { resolveFeffStructureContext, type FeffContextAtom } from "@/lib/feff-structure-context"
import { FeffPathScene } from "../feff-path-scene"
import { ViewerPanel } from "./viewer-panel"
import { ResizablePlotCard } from "./athena-plot-card"
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
      <span className={styles.kind}>{geometry?.classification.label ?? `${path.metadata.nleg} legs`}{geometry && <SectionHelp label="Scattering type">{geometry.classification.description}</SectionHelp>}</span>
    </div>
    <dl className={styles.facts}>
      <div><dt>Absorber / edge</dt><dd>{path.metadata.absorber} {path.metadata.edge}</dd></div>
      <div><dt>R<sub>eff</sub> · half length</dt><dd>{number(path.metadata.reff)} Å</dd></div>
      <div><dt>Degeneracy N</dt><dd>{number(path.metadata.degen)}</dd></div>
      <div><dt>Legs</dt><dd>{path.metadata.nleg}</dd></div>
    </dl>
    {geometry ? <>
      <div className={styles.scattering}>
        <div className={styles.route} aria-label="Scattering sequence"><SectionHelp label="Scattering sequence">When verified, equivalent path atoms and bonds are also opaque. Arrows replace bonds along one representative trajectory per selected FEFF file; overlapping legs stay closely spaced for clarity. Path atoms remain visible outside the display radius.</SectionHelp>{geometry.visits.map((atom, index) => <span key={index}>
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
      <details className={styles.geometryDetails}>
        <summary>Coordinates and scattering angles<SectionHelp label="Coordinates and scattering angles">Coordinates are relative to absorber A. β is the change in travel direction: 0° forward, 180° backscattering. R<sub>eff</sub> is half the total path length, not generally the absorber–neighbor distance for multiple scattering.</SectionHelp></summary>
        <div className={styles.tableScroll}><table>
          <caption>Scattering path geometry · {path.filename}</caption>
          <thead><tr><th scope="col">Visit</th><th scope="col">Atom</th><th scope="col">x (Å)</th><th scope="col">y (Å)</th><th scope="col">z (Å)</th><th scope="col">β (°)</th></tr></thead>
          <tbody>{geometry.visits.map((atom, index) => <tr key={index}><th scope="row">{index === 0 ? "Start" : index === geometry.legs.length ? "Return" : index}</th><td>{siteLabel(atom)}</td><td>{number(atom.x)}</td><td>{number(atom.y)}</td><td>{number(atom.z)}</td><td>{index > 0 && index < geometry.legs.length ? geometry.legs[index - 1].scatteringAngle.toFixed(1) : "—"}</td></tr>)}</tbody>
        </table></div>
      </details>
    </> : <p className={styles.empty} role="status">{error} The FEFF header metadata is shown above.</p>}
  </div>
}

const SORT_COLUMNS: { key: PathSortKey; label: string; help: string }[] = [
  { key: "model", label: "Path", help: "Keep the order the fitting model lists" },
  { key: "legs", label: "Legs", help: "Sort by the number of scattering legs" },
  { key: "reff", label: "R<sub>eff</sub> (Å)", help: "Sort by half path length" },
  { key: "degen", label: "N", help: "Sort by degeneracy" },
  { key: "amplitude", label: "Peak |χ(R)|", help: "Sort by the tallest point of this path's own χ(R)" },
]

/** Each path's own χ(k) and χ(R) at the model's starting values, with the sort
 *  and filter a user needs to decide which paths are worth fitting. */
function PathContributions({ state, rows, shown, filter, onFilter, sort, onSort, enabled, onEnabled, colors, transform, scoped }: {
  state: ArtemisPreviewState
  rows: PathRow[]
  shown: PathRow[]
  filter: PathFilter
  onFilter: (filter: PathFilter) => void
  sort: { key: PathSortKey; descending: boolean }
  onSort: (sort: { key: PathSortKey; descending: boolean }) => void
  enabled: boolean
  onEnabled: (enabled: boolean) => void
  colors: Map<string, string>
  transform?: ArtemisPreviewRequest["transform"]
  scoped: boolean
}) {
  const [space, setSpace] = useState<"k" | "r">("r")
  const [component, setComponent] = useState<"mag" | "re" | "im">("mag")
  const [plotError, setPlotError] = useState(false)
  const plotId = useId()
  const preview = state.preview
  const curves = useMemo(() => {
    if (!preview) return null
    const byId = new Map(preview.paths.map(path => [path.id, path]))
    const drawn = shown.map(row => byId.get(row.id)).filter(path => path !== undefined)
    const x = space === "k" ? preview.k.x : preview.r.x
    // The server's total is the starting model: every path included in the fit.
    const full = space === "k" ? preview.k.total : preview.r[`total_${component}`]
    // When a filter hides some of those paths, the sum of what is on screen is a
    // different curve. χ(k) and both parts of χ(R) are linear in the paths, so the
    // shown sum is exact; its magnitude comes from the summed complex parts.
    let partial: number[] | null = null
    if (drawn.length && drawn.length < preview.paths.length) {
      const add = (pick: (path: typeof drawn[number]) => number[]) =>
        x.map((_, i) => drawn.reduce((sum, path) => sum + pick(path)[i], 0))
      if (space === "k") partial = add(path => path.k.chi)
      else {
        const re = add(path => path.r.re), im = add(path => path.r.im)
        partial = component === "re" ? re : component === "im" ? im : re.map((value, i) => Math.hypot(value, im[i]))
      }
    }
    return { x, full, partial, count: drawn.length, included: preview.paths.length,
      drawn: drawn.map(path => ({ path, y: space === "k" ? path.k.chi : path.r[component] })) }
  }, [preview, shown, space, component])
  const weight = preview?.k.weight ?? 0
  const hover = `${space === "k" ? "k = %{x:.3f} Å⁻¹" : "R = %{x:.3f} Å"}<br>%{y:.5g}<extra>%{fullData.name}</extra>`
  const totalLabel = scoped ? "Selected source" : "Full model"
  const traces = curves ? [
    // The model the fit would start from; a path on its own is only a part of
    // it, and in magnitude the parts do not add.
    curves.partial
      ? { type: "scatter", mode: "lines", name: `${totalLabel} · all ${curves.included} included paths`, x: curves.x.slice(), y: curves.full.slice(),
        line: { color: "#8a948e", width: 1.6, dash: "dash" }, hovertemplate: hover }
      : { type: "scatter", mode: "lines", name: curves.count ? `${scoped ? "Selected source" : "Model"} · sum of all ${curves.included} included paths` : `${totalLabel} · all ${curves.included} included paths`,
        x: curves.x.slice(), y: curves.full.slice(), line: { color: "#2d3b33", width: 2 }, hovertemplate: hover },
    ...(curves.partial ? [{ type: "scatter", mode: "lines", name: `Sum of shown paths · ${curves.count} of ${curves.included}`,
      x: curves.x.slice(), y: curves.partial, line: { color: "#2d3b33", width: 2 }, hovertemplate: hover }] : []),
    ...curves.drawn.map(({ path, y }) => ({ type: "scatter", mode: "lines", name: path.label || path.filename,
      x: curves.x.slice(), y: y.slice(), line: { color: colors.get(path.id) ?? "#777777", width: 1.4 }, hovertemplate: hover })),
  ] : []
  // A new column starts in the order a user expects of it: smallest first for
  // the geometric columns, largest first for size.
  const sortBy = (key: PathSortKey) => onSort({ key, descending: sort.key === key ? !sort.descending : key === "amplitude" })
  return <section className={styles.contributions} aria-label="Path contributions">
    <div className={styles.contributionsHeading}>
      <label className={styles.contributionsToggle}><input type="checkbox" checked={enabled} onChange={event => onEnabled(event.target.checked)} />Show χ(k) and χ(R) contributions</label>
      {enabled && <div className={styles.choice} role="group" aria-label="Contribution plot space">{(["k", "r"] as const).map(value =>
        <button type="button" key={value} aria-pressed={space === value} onClick={() => setSpace(value)}>{value === "r" ? "R space" : "k space"}</button>)}</div>}
      {enabled && space === "r" && <div className={styles.choice} role="group" aria-label="Contribution R component">{([["mag", "Magnitude"], ["re", "Real"], ["im", "Imaginary"]] as const).map(([value, label]) =>
        <button type="button" key={value} aria-pressed={component === value} onClick={() => setComponent(value)}>{label}</button>)}</div>}
    </div>
    {enabled && <>
      {state.loading && <p className={styles.note} role="status">Computing each path’s contribution…</p>}
      {state.error && <p className={styles.empty} role="alert">{state.error} <button type="button" onClick={state.retry}>Retry</button></p>}
      {preview?.warnings.map(warning => <p className={styles.note} key={warning}>{warning}</p>)}
      {curves && (plotError ? <p className={styles.empty} role="alert">Could not render the contribution plot. The table below still lists each path’s size.</p>
        : <ResizablePlotCard className={styles.contributionCard} storageKey="artemis.feff.contributions.height.v1"
          defaultHeight={330} plotSelector="[data-feff-contributions-plot]" resizeLabel="Resize FEFF path contributions plot height" controlsId={plotId}>
          <div id={plotId} data-feff-contributions-plot className={styles.contributionPlot}><Plot data={traces}
          layout={{ autosize: true, margin: { l: 62, r: 18, t: 14, b: 50 }, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
            font: { color: "#52665b" },
            xaxis: { title: { text: space === "k" ? "k (Å⁻¹)" : "R (Å, not phase corrected)" }, gridcolor: "#e6ece4",
              ...(space === "r" && transform ? { range: [0, Math.max(6, transform.rmax + 1)] } : {}) },
            yaxis: { title: { text: space === "k" ? `k<sup>${weight}</sup>χ(k) (Å<sup>−${weight}</sup>)`
              : `${component === "mag" ? "|χ(R)|" : component === "re" ? "Re χ(R)" : "Im χ(R)"} (Å<sup>−${weight + 1}</sup>)` }, gridcolor: "#e6ece4", zerolinecolor: "#cbd7cf" },
            legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", maxheight: 0.26, entrywidth: 0.49, entrywidthmode: "fraction" },
            uirevision: `${space}:${component}`,
            shapes: transform ? [{ type: "rect", xref: "x", yref: "paper", x0: space === "k" ? transform.kmin : transform.rmin,
              x1: space === "k" ? transform.kmax : transform.rmax, y0: 0, y1: 1, fillcolor: "#25844c", opacity: 0.06, line: { width: 0 }, layer: "below" }] : [],
          }} config={{ responsive: true, displaylogo: false, toImageButtonOptions: { filename: `feff-path-contributions-${space}`, scale: 2 } }}
          useResizeHandler style={{ width: "100%", height: "100%" }} onError={() => setPlotError(true)} /></div>
        </ResizablePlotCard>)}
      {preview && <p className={styles.note}>Starting values only: no fit has been run and no measured spectrum is used. The shaded band is the fit range. Magnitudes do not add — the complex contributions are summed before the magnitude is taken, so the sum can be smaller than a single path.{scoped ? " Contributions cover only the selected source." : ""}{curves?.partial ? ` While a filter hides paths, the solid sum covers only the paths shown and the dashed curve includes all paths in ${scoped ? "the selected source" : "the starting model"}.` : ""}</p>}
    </>}
    <div className={styles.filters} role="group" aria-label="Path filters">
      <label>Legs<select aria-label="Filter by legs" value={filter.legs} onChange={event => onFilter({ ...filter, legs: event.target.value as PathFilter["legs"] })}>
        <option value="all">All</option><option value="single">Single scattering (2)</option><option value="multiple">Multiple scattering (3+)</option>
      </select></label>
      <label>R<sub>eff</sub> at most (Å)<input inputMode="decimal" aria-label="Filter by maximum Reff" value={filter.reffMax === null ? "" : String(filter.reffMax)}
        onChange={event => { const text = event.target.value.trim(); onFilter({ ...filter, reffMax: text && Number.isFinite(Number(text)) ? Number(text) : null }) }} /></label>
      <label>Peak |χ(R)| at least<select aria-label="Filter by smallest peak amplitude" value={String(filter.minAmplitude)} disabled={!preview}
        onChange={event => onFilter({ ...filter, minAmplitude: Number(event.target.value) })}>
        <option value="0">Any</option><option value="0.01">1% of the largest</option><option value="0.05">5% of the largest</option><option value="0.2">20% of the largest</option>
      </select></label>
      {!preview && <span className={styles.optionHint}>Amplitude filtering needs the contributions above.</span>}
      <span className={styles.optionHint} role="status">{shown.length} of {rows.length} paths shown</span>
      {shown.length < rows.length && <button type="button" onClick={() => onFilter(ALL_PATHS)}>Clear filters</button>}
    </div>
    <div className={styles.tableScroll}><table>
      <caption>FEFF paths at the model’s starting values</caption>
      <thead><tr>{SORT_COLUMNS.map(column => <th scope="col" key={column.key} aria-sort={sort.key === column.key ? (sort.descending ? "descending" : "ascending") : "none"}>
        <button type="button" onClick={() => sortBy(column.key)} title={column.help}
          aria-label={`Sort by ${column.label.replace(/<[^>]+>/g, "")}`} dangerouslySetInnerHTML={{ __html: column.label + (sort.key === column.key && column.key !== "model" ? (sort.descending ? " ↓" : " ↑") : "") }} />
      </th>)}<th scope="col">R at peak (Å)</th><th scope="col">Area in R window</th></tr></thead>
      <tbody>{shown.map(row => <tr key={row.id}>
        <th scope="row"><i style={{ background: colors.get(row.id) }} />{row.filename}{row.label && row.label !== row.filename && <small>{row.label}</small>}{!row.enabled && <small>excluded from fit</small>}</th>
        <td>{row.metadata.nleg}</td><td>{format(row.metadata.reff, 4)}</td><td>{format(row.metadata.degen, 4)}</td>
        <td>{format(row.metrics?.amplitude, 4)}</td><td>{format(row.metrics?.r_at_amplitude, 4)}</td><td>{format(row.metrics?.window_area, 4)}</td>
      </tr>)}</tbody>
    </table></div>
    {!shown.length && <p className={styles.empty} role="status">No path matches these filters.</p>}
  </section>
}

const NO_STRUCTURES: ArtemisStructureAttachment[] = []

function PathWorkspace({ paths: allPaths, attachments: allAttachments, model }: { paths: FeffPathSummary[]; attachments: ArtemisStructureAttachment[]; model: ArtemisPreviewRequest | null }) {
  const sources = useMemo(() => groupFeffPathSources(allPaths, allAttachments), [allPaths, allAttachments])
  const [sourceChoice, setSourceChoice] = useState("")
  const source = sources.find(item => item.key === sourceChoice) ?? sources[0]
  const paths = source.paths
  const attachments = useMemo(() => source.cifSha256
    ? allAttachments.filter(attachment => attachment.sha256 === source.cifSha256) : allAttachments, [allAttachments, source.cifSha256])
  const [selection, setSelection] = useState<{ source: string; ids: string[] } | null>(null)
  const [focusedId, setFocusedId] = useState("")
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null)
  const [radius, setRadius] = useState(CIF_VIEWER_DEFAULT_RADIUS)
  const [structureSelection, setStructureSelection] = useState({ source: "", value: "" })
  const structureChoice = structureSelection.source === source.key ? structureSelection.value : ""
  const setStructureChoice = (value: string) => setStructureSelection({ source: source.key, value })
  const [contributions, setContributions] = useState(false)
  const [sort, setSort] = useState<{ key: PathSortKey; descending: boolean }>({ key: "model", descending: false })
  const [filter, setFilter] = useState<PathFilter>(ALL_PATHS)
  const entries = useMemo(() => paths.map((path, index) => ({ path, ...buildFeffPathGeometry(path.metadata), color: PATH_COLORS[index % PATH_COLORS.length] })), [paths])
  const fullPreview = useArtemisPathPreview(model, contributions)
  // Reuse the model preview when changing CIFs, but sum only this source's
  // complex contributions. Switching a display source never refits the model.
  const scopedPreview = useMemo(() => {
    const preview = fullPreview.preview
    if (!preview || sources.length === 1) return preview
    const ids = new Set(paths.map(path => path.id))
    const selected = preview.paths.filter(path => ids.has(path.id))
    const total = preview.k.x.map((_, i) => selected.reduce((sum, path) => sum + path.k.chi[i], 0))
    const total_re = preview.r.x.map((_, i) => selected.reduce((sum, path) => sum + path.r.re[i], 0))
    const total_im = preview.r.x.map((_, i) => selected.reduce((sum, path) => sum + path.r.im[i], 0))
    return { ...preview, paths: selected, k: { ...preview.k, total },
      r: { ...preview.r, total_re, total_im, total_mag: total_re.map((value, i) => Math.hypot(value, total_im[i])) } }
  }, [fullPreview.preview, paths, sources.length])
  const preview = { ...fullPreview, preview: scopedPreview }
  const rows = useMemo<PathRow[]>(() => {
    const metrics = new Map(preview.preview?.paths.map(path => [path.id, path.metrics]) ?? [])
    return paths.map(path => ({ id: path.id, filename: path.filename, label: path.label, enabled: path.enabled,
      metadata: path.metadata, metrics: metrics.get(path.id) }))
  }, [paths, preview.preview])
  const shown = useMemo(() => sortPathRows(filterPathRows(rows, filter), sort.key, sort.descending), [rows, filter, sort])
  const colors = useMemo(() => new Map(entries.map(entry => [entry.path.id, entry.color])), [entries])
  // The filter and sort reorder the legend too, so the list a user narrowed is the
  // list they click in; the 3D scene still falls back to the unfiltered paths.
  const legendEntries = useMemo(() => shown.map(row => entries.find(entry => entry.path.id === row.id))
    .filter(entry => entry !== undefined), [shown, entries])
  const selectedIds = useMemo(() => {
    if (selection === null || selection.source !== source.key) return [paths[0].id]
    const remaining = selection.ids.filter(id => paths.some(path => path.id === id))
    return selection.ids.length && !remaining.length ? [paths[0].id] : remaining
  }, [selection, paths, source.key])
  // A filtered-out path leaves the scene with its legend button, so the scene,
  // the legend, the plot and the table always describe the same set of paths.
  const selected = useMemo(() => entries.filter(entry => selectedIds.includes(entry.path.id) && shown.some(row => row.id === entry.path.id)), [entries, selectedIds, shown])
  const focused = selected.find(entry => entry.path.id === focusedId) ?? selected.at(-1)
    ?? entries.find(entry => entry.path.id === focusedId) ?? entries[0]
  const context = useMemo(() => {
    const choice = structureChoice ? JSON.parse(structureChoice) as [string, number] : undefined
    const ordered = [focused, ...selected.filter(entry => entry !== focused)]
    return resolveFeffMultipathContext(ordered.map(entry => entry.path.metadata), attachments, {
      radius, selectedAttachmentId: choice?.[0], selectedSiteIndex: source.siteIndex ?? choice?.[1],
    })
  }, [focused, selected, attachments, radius, structureChoice, source.siteIndex])
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
    setSelection({ source: source.key, ids: selectedIds.includes(id) ? selectedIds.filter(item => item !== id) : [...selectedIds, id] })
    if (!selectedIds.includes(id)) setFocusedId(id)
    setSelectedLeg(null)
    setStructureChoice("")
  }
  const legend = <div className={styles.pathLegend} role="group" aria-label="FEFF path legend">
    <span className={styles.legendHint}>Paths<SectionHelp label="FEFF path legend">Click a FEFF legend to show or hide its path. You can display several paths from the selected CIF together.</SectionHelp></span>
    <div className={styles.legendItems}>{legendEntries.map(({ path, color }) => {
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
    <div className={structureStyles.controls}><label>CIF source
      <select aria-label="FEFF path CIF source" value={source.key} onChange={event => {
        setSourceChoice(event.target.value); setSelection(null); setFocusedId(""); setSelectedLeg(null); setFilter(ALL_PATHS)
      }}>
        {sources.map(item => <option key={item.key} value={item.key}>{item.label} · {item.paths.length} {item.paths.length === 1 ? "path" : "paths"}</option>)}
      </select>
    </label></div>
    <FeffPathScene paths={scenePaths} activePathId={focused.path.id} selectedLeg={selectedLeg} context={context.atoms}
      contextLabel={context.source ? context.sourceLabel : undefined} radius={context.radius} maxRadius={context.maxRadius} onRadiusChange={setRadius}
      legend={legend}
      structureControls={source.siteIndex === undefined && context.candidates.length > 1 ? <div className={structureStyles.controls}><label>Project CIF
        <select aria-label="FEFF local structure source" value={context.attachmentId ? JSON.stringify([context.attachmentId, context.siteIndex]) : ""} onChange={event => setStructureChoice(event.target.value)}>
          <option value="" disabled>Select matching structure</option>
          {context.candidates.map(candidate => <option key={`${candidate.attachmentId}:${candidate.siteIndex}`} value={JSON.stringify([candidate.attachmentId, candidate.siteIndex])}>{candidate.label}</option>)}
        </select>
      </label></div> : undefined} />
    {context.warnings.filter(warning => warning !== focused.error).map(warning => <p className={styles.note} key={warning}>{warning}</p>)}
    {matchingContext.source && matchingContext.truncated && <p className={styles.note}>Representative paths only<SectionHelp label="Equivalent paths warning">Equivalent paths were not expanded: the CIF preview is limited at the path extent. Showing representative paths.</SectionHelp></p>}
    {scenePaths.map(path => path.equivalents?.warning && <p className={styles.note} key={path.id}>{path.filename}: {path.equivalents.warning}</p>)}
    {scenePaths.map(path => path.equivalenceWarning && <p className={styles.note} key={`${path.id}-source`}>{path.filename}: {path.equivalenceWarning}</p>)}
    {!context.source && !context.requiresSelection && <p className={styles.note}>Path atoms only<SectionHelp label="Missing local structure">Attach a matching project CIF or generate paths from a CIF to show the surrounding local structure. These files contain path atoms only.</SectionHelp></p>}
    {!selected.length ? <p className={styles.note} role="status">No paths shown</p> : <>
      {selected.length > 1 && <label className={styles.detailPicker}>Path details <select aria-label="Path details" value={focused.path.id} onChange={event => { setFocusedId(event.target.value); setSelectedLeg(null) }}>
        {selected.map(({ path }) => <option key={path.id} value={path.id}>{path.filename}{paths.filter(item => item.filename === path.filename).length > 1 ? ` · ${path.label}` : ""}</option>)}
      </select><span>{selected.length} paths shown</span></label>}
      {!focused.path.enabled && <p className={styles.note}>Excluded from fit · displayed for inspection</p>}
      <PathDetail path={focused.path} color={focused.color} selectedLeg={selectedLeg} onSelectLeg={setSelectedLeg} />
    </>}
    {model ? <PathContributions state={preview} rows={rows} shown={shown} filter={filter} onFilter={setFilter}
      sort={sort} onSort={setSort} enabled={contributions} onEnabled={setContributions} colors={colors} transform={model.transform} scoped={sources.length > 1} />
      : <p className={styles.note}>Finish the fitting model’s parameters and ranges to compare each path’s χ(k) and χ(R).</p>}
  </div>
}

export function FeffPathViewer({ paths, groupLabel, onOpenModel, attachments = NO_STRUCTURES, model = null }: {
  paths: FeffPathSummary[]
  groupLabel?: string
  onOpenModel: () => void
  attachments?: ArtemisStructureAttachment[]
  /** The fitting editor's current model, or null while its numbers cannot be read. */
  model?: ArtemisPreviewRequest | null
}) {
  return <ViewerPanel title="FEFF path viewer" viewerId="feff" className={styles.panel} help="Add or generate FEFF paths in the EXAFS fitting tab to inspect their geometry here.">
    <div className={styles.content}>
      <div className={styles.heading}><span>Current spectrum <strong>{groupLabel ?? "None selected"}</strong></span><button type="button" onClick={onOpenModel}>{paths.length ? "Edit paths" : "Open EXAFS fitting"}</button></div>
      {!paths.length ? <p className={styles.empty}>No FEFF paths</p>
        : <PathWorkspace paths={paths} attachments={attachments} model={model} />}
    </div>
  </ViewerPanel>
}
