"use client"

import { useState, type Dispatch, type SetStateAction } from "react"
import type { InspectionResponse } from "@/lib/contracts"
import { numeratorRange, type ColumnMapping } from "@/lib/athena-import"
import { AthenaImportPreview } from "./athena-import-preview"
import styles from "./athena-column-selection.module.css"

export function AthenaColumnSelection({ projectId, version, inspection, mapping, setMapping, busy, remaining, reuseMapping,
  setReuseMapping, chooseAnother, importCurrent }: {
  projectId: string; version: number; inspection: InspectionResponse; mapping: ColumnMapping
  setMapping: Dispatch<SetStateAction<ColumnMapping>>; busy: boolean; remaining: number
  reuseMapping: boolean; setReuseMapping: (value: boolean) => void; chooseAnother: () => void; importCurrent: () => void
}) {
  const [range, setRange] = useState("")
  const [rangeError, setRangeError] = useState("")
  function selectRange() {
    try {
      const indices = numeratorRange(range, inspection.columns.length)
      setMapping(m => ({ ...m, numerator: indices.map(i => inspection.columns[i].column_id) }))
      setRangeError("")
    } catch (err) { setRangeError(err instanceof Error ? err.message : "Check the column range.") }
  }
  const hasReference = !!(mapping.reference_numerator || mapping.reference_denominator)
  return <>
    <p><strong>{inspection.display_name}</strong><span className="ath-chip">{inspection.row_count} points{remaining > 1 ? ` · ${remaining} files remaining` : ""}</span></p>
    <div className={styles.layout}>
      <div className={styles.controls}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="ath-fields">
            <label className="ath-field"><span>Data type</span><select value={mapping.data_type} onChange={e => setMapping(m => ({ ...m, data_type: e.target.value as ColumnMapping["data_type"], ...(e.target.value === "chi" ? { reference_numerator: "", reference_denominator: "" } : {}) }))}><option value="mu">μ(E) · absorption</option><option value="xanes">XANES · short energy range</option><option value="norm">Normalized μ(E)</option><option value="chi">χ(k) · extracted EXAFS</option></select></label>
            <label className="ath-field"><span>Measurement</span><select value={mapping.mode} onChange={e => setMapping(m => ({ ...m, mode: e.target.value as ColumnMapping["mode"] }))}><option value="mu">Direct signal</option><option value="transmission">Transmission · ln(I₀ / It)</option><option value="fluorescence">Fluorescence / yield · signal / I₀</option></select></label>
            <label className="ath-field"><span>{mapping.data_type === "chi" ? "k column" : "Energy column"}</span><select value={mapping.energy_column} onChange={e => setMapping(m => ({ ...m, energy_column: e.target.value }))}>{inspection.columns.map(c => <option value={c.column_id} key={c.column_id}>{c.name} · column {c.index + 1}</option>)}</select></label>
            <label className="ath-field"><span>Energy units</span><select value={mapping.units} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, units: e.target.value as ColumnMapping["units"] }))}><option>eV</option><option>keV</option></select></label>
          </div>
          <div className={styles.range}>
            <label className="ath-field"><span>Numerator column numbers</span><input value={range} placeholder="4-8, 11" onChange={e => { setRange(e.target.value); setRangeError("") }} /></label>
            <button type="button" onClick={selectRange}>Select range</button>
            <button type="button" onClick={() => { setMapping(m => ({ ...m, numerator: [] })); setRangeError("") }}>Clear numerator</button>
          </div>
          {rangeError && <p role="alert" className="ath-error">{rangeError}</p>}
          <div className="ath-column-table"><table><thead><tr><th>Numerator</th><th>Denominator</th><th>Column</th><th>First values</th></tr></thead><tbody>{inspection.columns.map(c => <tr key={c.column_id}>
            <td><input type="checkbox" aria-label={`Numerator ${c.name}`} checked={mapping.numerator.includes(c.column_id)} onChange={e => setMapping(m => ({ ...m, numerator: e.target.checked ? [...m.numerator, c.column_id] : m.numerator.filter(v => v !== c.column_id) }))} /></td>
            <td><input type="radio" aria-label={`Denominator ${c.name}`} name="denominator" disabled={mapping.mode === "mu"} checked={mapping.denominator === c.column_id} onChange={() => setMapping(m => ({ ...m, denominator: c.column_id }))} /></td>
            <td>{c.index + 1}. {c.name}</td><td>{c.preview.slice(0, 3).map(v => v.toPrecision(5)).join(", ")}</td>
          </tr>)}</tbody></table></div>
          <p className="ath-formula">{mapping.data_type === "chi" ? "χ(k)" : "μ(E)"} = {mapping.mode === "transmission" ? "ln(" : ""}({mapping.individual_channels ? "each of: " : ""}{mapping.numerator.map(id => inspection.columns.find(c => c.column_id === id)?.name).join(mapping.individual_channels ? ", " : " + ") || "…"}){mapping.mode !== "mu" && ` / ${inspection.columns.find(c => c.column_id === mapping.denominator)?.name ?? "…"}`}{mapping.mode === "transmission" ? ")" : ""}</p>
          <label className="ath-check"><input type="checkbox" checked={mapping.individual_channels ?? false} onChange={e => setMapping(m => ({ ...m, individual_channels: e.target.checked }))} />Save each channel as its own group</label>
          <details><summary>Reference channel & ordering</summary>
            <p className="ath-hint">The reference uses the same energy column and units. Its energy shift stays linked to the sample after import.</p>
            <div className="ath-fields">{(["reference_numerator", "reference_denominator"] as const).map(key => <label key={key} className="ath-field"><span>{key.replaceAll("_", " ")}</span><select value={mapping[key]} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, [key]: e.target.value }))}><option value="">None</option>{inspection.columns.map(c => <option value={c.column_id} key={c.column_id}>{c.name} · column {c.index + 1}</option>)}</select></label>)}</div>
            <label className="ath-check"><input type="checkbox" disabled={!hasReference} checked={mapping.reference_log ?? true} onChange={e => setMapping(m => ({ ...m, reference_log: e.target.checked }))} />Reference natural log</label>
            <label className="ath-check"><input type="checkbox" disabled={!hasReference} checked={mapping.reference_same_element ?? true} onChange={e => setMapping(m => ({ ...m, reference_same_element: e.target.checked }))} />Same element</label>
            {hasReference && <p className="ath-formula">Reference = {(mapping.reference_log ?? true) ? "ln(" : ""}{inspection.columns.find(c => c.column_id === mapping.reference_numerator)?.name ?? "…"} / {inspection.columns.find(c => c.column_id === mapping.reference_denominator)?.name ?? "…"}{(mapping.reference_log ?? true) ? ")" : ""}</p>}
            {hasReference && mapping.reference_same_element === false && <p className="ath-hint">The reference finds its own edge independently of sample edge enforcement.</p>}
            <label className="ath-check"><input type="checkbox" checked={mapping.sort} onChange={e => setMapping(m => ({ ...m, sort: e.target.checked }))} />Sort ascending by energy (duplicate energies still require repair)</label>
          </details>
          {remaining > 1 && <label className="ath-check"><input type="checkbox" checked={reuseMapping} onChange={e => setReuseMapping(e.target.checked)} />Reuse this mapping for remaining files with matching column labels</label>}
        </fieldset>
      </div>
      <div className={styles.preview}>
        <AthenaImportPreview projectId={projectId} version={version} uploadId={inspection.upload_id} mapping={mapping} disabled={busy} />
        {inspection.source_preview && <details className={styles.raw}><summary>Source file contents{inspection.source_preview_truncated ? " (first section)" : ""}</summary><pre>{inspection.source_preview}</pre></details>}
      </div>
    </div>
    {inspection.warnings.map(w => <p className="ath-warning" key={w}>{w}</p>)}
    <div className="ath-modal-actions"><button disabled={busy} onClick={chooseAnother}>Choose another file</button><button className="ath-primary" disabled={busy || !mapping.numerator.length} onClick={importCurrent}>{busy ? "Importing…" : "Import spectrum"}</button></div>
  </>
}
