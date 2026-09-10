"use client"

import { useState, type Dispatch, type SetStateAction, type ReactNode } from "react"
import type { InspectionResponse } from "@/lib/contracts"
import type { AthenaGroup } from "@/lib/athena"
import { numeratorRange, denominatorColumns, columnExpression, columnProblem, changeInputType, initialColumnMapping, defaultPreprocessing, type ColumnMapping } from "@/lib/athena-import"
import { AthenaImportPreview } from "./athena-import-preview"
import { AthenaImportPreprocessing } from "./athena-import-preprocessing"
import { AthenaImportRebin } from "./athena-import-rebin"
import styles from "./athena-column-selection.module.css"

export function AthenaColumnSelection({ projectId, version, inspection, mapping, setMapping, busy, remaining, reuseMapping, groups = [],
  setReuseMapping, chooseAnother, importCurrent, rebinDefaults }: {
  projectId: string; version: number; inspection: InspectionResponse; mapping: ColumnMapping
  setMapping: Dispatch<SetStateAction<ColumnMapping>>; busy: boolean; remaining: number
  groups?: AthenaGroup[]
  rebinDefaults?: ReactNode
  reuseMapping: boolean; setReuseMapping: (value: boolean) => void; chooseAnother: () => void; importCurrent: () => void
}) {
  const [range, setRange] = useState("")
  const [rangeError, setRangeError] = useState("")
  function selectRange() {
    try {
      const indices = numeratorRange(range, inspection.columns.length)
      setMapping(m => ({ ...m, numerator: inspection.columns.filter((c, i) => m.numerator.includes(c.column_id)
        || (indices.includes(i) && c.column_id !== m.energy_column)).map(c => c.column_id) }))
      setRangeError("")
    } catch (err) { setRangeError(err instanceof Error ? err.message : "Check the column range.") }
  }
  const denominator = denominatorColumns(mapping)
  const problem = columnProblem(mapping)
  const hasReference = !!(mapping.reference_numerator || mapping.reference_denominator)
  return <>
    <p><strong>{inspection.display_name}</strong><span className="ath-chip">{inspection.row_count} points{remaining > 1 ? ` · ${remaining} files remaining` : ""}</span></p>
    {inspection.file_plugin && <section aria-label="File conversion"><strong>{inspection.file_plugin.description}</strong><p className="ath-hint">{inspection.file_plugin.summary}</p></section>}
    <div className={styles.layout}>
      <div className={styles.controls}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {inspection.remembered_columns && <section aria-label="Remembered import choices">
            <p className="ath-hint">{inspection.remembered_columns.matching_columns
              ? 'Matching column labels: started with the previous successful import choices. Check the expression and preview before importing.'
              : 'Different column labels: suggested detector columns, with references and rebinning off. The previous grid and preprocessing choices are available.'}</p>
            {inspection.remembered_columns.warnings.map(w => <p key={w} className="ath-warning">{w}</p>)}
            <button type="button" onClick={() => setMapping(m => initialColumnMapping(inspection, { ...m,
              preprocessing: { ...defaultPreprocessing }, ...(m.rebin ? { rebin: { ...m.rebin, enabled: false, e0: null } } : {}) }, false))}>Use suggested columns</button>
          </section>}
          <div className="ath-fields">
            <label className="ath-field"><span>Data type</span><select value={mapping.data_type} onChange={e => setMapping(m => changeInputType(m, e.target.value as ColumnMapping["data_type"]))}><option value="mu">μ(E) · absorption</option><option value="xanes">XANES · short energy range</option><option value="norm">Normalized μ(E)</option><option value="chi">χ(k) · extracted EXAFS</option><option value="xmudat">FEFF xmu.dat · normalized μ(E)</option></select></label>
            <label className="ath-field"><span>Measurement</span><select value={mapping.mode} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, mode: e.target.value as ColumnMapping["mode"], ...(e.target.value === "mu" ? { denominator: "" } : {}) }))}><option value="mu">Direct signal</option><option value="transmission">Transmission · ln(I₀ / It)</option><option value="fluorescence">Fluorescence / yield · signal / I₀</option></select></label>
            <label className="ath-field"><span>{mapping.data_type === "chi" ? "k column" : "Energy column"}</span><select value={mapping.energy_column} onChange={e => setMapping(m => ({ ...m, energy_column: e.target.value, units: m.data_type === "chi" ? "eV" : inspection.column_units?.[e.target.value] ?? m.units }))}>{inspection.columns.map(c => <option value={c.column_id} key={c.column_id}>{c.name} · column {c.index + 1}</option>)}</select></label>
            <label className="ath-field"><span>Energy units</span><select value={mapping.units} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, units: e.target.value as ColumnMapping["units"] }))}><option>eV</option><option>keV</option></select></label>
          </div>
          {inspection.plugin_suggestions && mapping.data_type !== 'chi' && <div aria-label="Reader column suggestions">
            <p className="ath-hint">Apply this reader’s suggested detector columns, then check the preview.</p>
            {(['transmission', 'fluorescence'] as const).map(mode => {
              const suggestion = inspection.plugin_suggestions?.[mode]
              return suggestion && <button key={mode} type="button" onClick={() => setMapping(m => ({ ...m,
                energy_column: suggestion.energy_column, numerator: suggestion.numerator,
                denominator: suggestion.denominator ?? '', units: suggestion.units, mode: suggestion.mode,
                individual_channels: false }))}>Use {mode} columns</button>
            })}
          </div>}
          {mapping.data_type === "xmudat" && <p className="ath-hint">FEFF μ(E) is already normalized. Select photon energy (omega) and μ; the relative e and k columns have different meanings. Normalization is not refitted.</p>}
          {mapping.data_type !== "chi" && inspection.column_units && <p className="ath-hint">{inspection.column_units[mapping.energy_column]
            ? `Suggested energy units: ${inspection.column_units[mapping.energy_column]}. You can override this choice.`
            : "Energy units could not be inferred from these rows. Choose eV or keV and inspect the plotted energy range."}</p>}
          <div className={styles.range}>
            <label className="ath-field"><span>Numerator column numbers</span><input value={range} placeholder="4-8, 11" onChange={e => { setRange(e.target.value); setRangeError("") }} /></label>
            <button type="button" onClick={selectRange}>Select range</button>
            <button type="button" onClick={() => { setMapping(m => ({ ...m, numerator: [] })); setRangeError("") }}>Clear numerator</button>
            <button type="button" disabled={mapping.data_type === "chi"} onClick={() => setMapping(m => ({ ...m, denominator: "" }))}>Clear denominator</button>
          </div>
          {rangeError && <p role="alert" className="ath-error">{rangeError}</p>}
          <div className="ath-column-table"><table><thead><tr><th>Numerator</th><th>Denominator</th><th>Column</th><th>First values</th></tr></thead><tbody>{inspection.columns.map(c => <tr key={c.column_id}>
            <td><input type="checkbox" aria-label={`Numerator ${c.name}`} checked={mapping.numerator.includes(c.column_id)} onChange={e => setMapping(m => ({ ...m, numerator: e.target.checked ? [...m.numerator, c.column_id] : m.numerator.filter(v => v !== c.column_id) }))} /></td>
            <td><input type="checkbox" aria-label={`Denominator ${c.name}`} disabled={mapping.data_type === "chi"} checked={mapping.mode !== "mu" && denominator.includes(c.column_id)} onChange={e => setMapping(m => ({ ...m, mode: m.mode === "mu" ? "fluorescence" : m.mode, denominator: e.target.checked ? [...(m.mode === "mu" ? [] : denominatorColumns(m)), c.column_id] : denominatorColumns(m).filter(id => id !== c.column_id) }))} /></td>
            <td>{c.index + 1}. {c.name}</td><td>{c.preview.slice(0, 3).map(v => v.toPrecision(5)).join(", ")}</td>
          </tr>)}</tbody></table></div>
          <p className="ath-formula">{columnExpression(mapping, inspection.columns)}</p>
          <div className="ath-fields">
            <label className="ath-check"><input type="checkbox" checked={mapping.mode === "transmission"} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, mode: e.target.checked ? "transmission" : "fluorescence", ...(m.mode === "mu" ? { denominator: "" } : {}) }))} />Natural log</label>
            <label className="ath-check"><input type="checkbox" checked={mapping.invert ?? false} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, invert: e.target.checked }))} />Invert signal</label>
            <label className="ath-field"><span>Multiplicative constant</span><input type="number" step="any" value={mapping.signal_multiplier ?? 1} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, signal_multiplier: e.target.value === "" ? "" : Number(e.target.value) }))} /></label>
          </div>
          <p className="ath-hint">{mapping.data_type === 'chi' ? 'χ(k) is read directly from the numerator columns. Absorption measurement controls are inactive.' : 'Unselected numerator or denominator uses 1. Multiple checked columns are added together. Invert changes the sign; the constant scales the imported signal.'}</p>
          {problem && <p role="alert" className="ath-error">{problem}</p>}
          <label className="ath-check"><input type="checkbox" checked={mapping.individual_channels ?? false} onChange={e => setMapping(m => ({ ...m, individual_channels: e.target.checked }))} />Save each channel as its own group</label>
          <AthenaImportRebin value={mapping.rebin} chi={mapping.data_type === 'chi'} onChange={rebin => setMapping(m => ({ ...m, rebin }))} />
          {rebinDefaults}
          <AthenaImportPreprocessing value={mapping.preprocessing} groups={groups} chi={mapping.data_type === 'chi'}
            onChange={preprocessing => setMapping(m => ({ ...m, preprocessing }))} />
          <details><summary>Reference channel & ordering</summary>
            <p className="ath-hint">The reference uses the same energy column and units. Its energy shift stays linked to the sample after import.</p>
            <div className="ath-fields">{(["reference_numerator", "reference_denominator"] as const).map(key => <label key={key} className="ath-field"><span>{key.replaceAll("_", " ")}</span><select value={mapping[key]} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, [key]: e.target.value }))}><option value="">None · constant 1 when reference enabled</option><option value="1">Constant 1</option>{inspection.columns.map(c => <option value={c.column_id} key={c.column_id}>{c.name} · column {c.index + 1}</option>)}</select></label>)}</div>
            <label className="ath-check"><input type="checkbox" disabled={!hasReference} checked={mapping.reference_log ?? true} onChange={e => setMapping(m => ({ ...m, reference_log: e.target.checked }))} />Reference natural log</label>
            <label className="ath-check"><input type="checkbox" disabled={!hasReference} checked={mapping.reference_same_element ?? true} onChange={e => setMapping(m => ({ ...m, reference_same_element: e.target.checked }))} />Same element</label>
            {hasReference && mapping.reference_same_element !== false && <p className="ath-hint">Use the sample’s element and edge. If the reference E₀ differs by more than 25 eV, use that element’s tabulated edge.</p>}
            {hasReference && <p className="ath-formula">Reference = {(mapping.reference_log ?? true) ? "ln(|" : ""}{inspection.columns.find(c => c.column_id === mapping.reference_numerator)?.name ?? "1"} / {inspection.columns.find(c => c.column_id === mapping.reference_denominator)?.name ?? "1"}{(mapping.reference_log ?? true) ? "|)" : ""}</p>}
            {hasReference && mapping.reference_same_element === false && <p className="ath-hint">The reference finds its own edge independently of sample edge enforcement.</p>}
            <label className="ath-check"><input type="checkbox" checked={mapping.sort} onChange={e => setMapping(m => ({ ...m, sort: e.target.checked }))} />Sort ascending by energy (duplicate energies still require repair)</label>
          </details>
          {remaining > 1 && <label className="ath-check"><input type="checkbox" checked={reuseMapping} onChange={e => setReuseMapping(e.target.checked)} />Reuse this mapping for remaining files with matching column labels</label>}
        </fieldset>
        {inspection.warnings.map(w => <p className="ath-warning" key={w}>{w}</p>)}
        <div className="ath-modal-actions"><button disabled={busy} onClick={chooseAnother}>Choose another file</button><button className="ath-primary" disabled={busy || !!problem} onClick={importCurrent}>{busy ? "Importing…" : "Import spectrum"}</button></div>
      </div>
      <div className={styles.preview}>
        <AthenaImportPreview projectId={projectId} version={version} uploadId={inspection.upload_id} mapping={mapping} disabled={busy} />
        {inspection.source_preview && <details className={styles.raw}><summary>{inspection.source_preview_format === 'hex' ? 'Binary source bytes (hex)' : 'Source file contents'}{inspection.source_preview_truncated ? " (first section)" : ""}</summary><a href={`/api/backend/api/athena/projects/${projectId}/uploads/${inspection.upload_id}/file`} download>Download original file</a><pre>{inspection.source_preview.replaceAll('\0', '␀')}</pre></details>}
        {inspection.converted_preview && <details className={styles.raw}><summary>Converted columns{inspection.converted_preview_truncated ? " (first section)" : ""}</summary><a href={`/api/backend/api/athena/projects/${projectId}/uploads/${inspection.upload_id}/file?variant=converted`} download>Download converted file</a><pre>{inspection.converted_preview}</pre></details>}
      </div>
    </div>
  </>
}
