"use client"

import { useState } from "react"
import type { ArtemisPath } from "@/lib/artemis"
import { ViewerPanel } from "./viewer-panel"
import styles from "./feff-path-viewer.module.css"

export type FeffPathSummary = Pick<ArtemisPath, "id" | "label" | "filename" | "enabled" | "metadata">

const number = (value: number) => Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : "—"

export function FeffPathViewer({ paths, groupLabel, onOpenModel }: {
  paths: FeffPathSummary[]
  groupLabel?: string
  onOpenModel: () => void
}) {
  const [selectedId, setSelectedId] = useState("")
  const selected = paths.find(path => path.id === selectedId) ?? paths[0]

  return <ViewerPanel title="FEFF path viewer" className={styles.panel}>
    <div className={styles.content}>
      <div className={styles.heading}><span>Current spectrum <strong>{groupLabel ?? "None selected"}</strong></span><button type="button" onClick={onOpenModel}>{paths.length ? "Edit paths" : "Open EXAFS fitting"}</button></div>
      {!selected ? <p className={styles.empty}>Add or generate FEFF paths in the EXAFS fitting tab to inspect their geometry here.</p> : <>
        <label className={styles.selector}>Path
          <select aria-label="Viewed FEFF path" value={selected.id} onChange={event => setSelectedId(event.target.value)}>
            {paths.map(path => <option key={path.id} value={path.id}>{path.label || path.filename}{path.enabled ? "" : " · excluded"}</option>)}
          </select>
        </label>
        <dl className={styles.facts}>
          <div><dt>Absorber / edge</dt><dd>{selected.metadata.absorber} {selected.metadata.edge}</dd></div>
          <div><dt>R<sub>eff</sub></dt><dd>{number(selected.metadata.reff)} Å</dd></div>
          <div><dt>Degeneracy N</dt><dd>{number(selected.metadata.degen)}</dd></div>
          <div><dt>Legs</dt><dd>{selected.metadata.nleg}</dd></div>
        </dl>
        {selected.metadata.geometry.length ? <div className={styles.tableScroll}><table>
          <caption>Scattering path geometry · {selected.filename}</caption>
          <thead><tr><th scope="col">Step</th><th scope="col">Atom</th><th scope="col">x (Å)</th><th scope="col">y (Å)</th><th scope="col">z (Å)</th></tr></thead>
          <tbody>{selected.metadata.geometry.map((atom, index) => <tr key={`${index}:${atom.ipot}`}><th scope="row">{index + 1}</th><td>{atom.atom}</td><td>{number(atom.x)}</td><td>{number(atom.y)}</td><td>{number(atom.z)}</td></tr>)}</tbody>
        </table></div> : <p className={styles.empty}>This path has no atom geometry in its FEFF metadata.</p>}
        <p className={styles.note}>Coordinates and degeneracy come from FEFF. The fitted path curves appear in the EXAFS fit viewer after a fit.</p>
      </>}
    </div>
  </ViewerPanel>
}
