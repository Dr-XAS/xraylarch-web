"use client"

import { useState } from 'react'
import type { InspectionResponse, ScanInspectionResponse } from '@/lib/contracts'
import { columnExpression, initialColumnMapping, type ColumnMapping } from '@/lib/athena-import'
import { AthenaImportPreview } from './athena-import-preview'
import styles from './athena-column-selection.module.css'

const emptyMapping: ColumnMapping = { energy_column: '', numerator: [], denominator: '', mode: 'mu', units: 'eV',
  data_type: 'mu', reference_numerator: '', reference_denominator: '', sort: false }

export function AthenaScanSelection({ collection, projectId, version, busy, onContinue, onCancel }: {
  collection: ScanInspectionResponse; projectId: string; version: number; busy: boolean
  onContinue: (scans: InspectionResponse[]) => void; onCancel: () => void
}) {
  const [selected, setSelected] = useState(() => collection.scans.map(scan => scan.upload_id))
  const [active, setActive] = useState(collection.scans[0]?.upload_id)
  const shown = collection.scans.find(scan => scan.upload_id === active)
  const mapping = shown ? initialColumnMapping(shown, emptyMapping, false) : emptyMapping
  return <section aria-label="Scan selection">
    <h3>Scans in {collection.display_name}</h3>
    <p>{collection.scans.length} scans · {collection.file_plugin.total_points} points. Choose the scans to import, then review their detector columns.</p>
    <div className={styles.layout}>
      <div className={styles.controls}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <div className="ath-modal-actions">
            <button type="button" onClick={() => setSelected(collection.scans.map(scan => scan.upload_id))}>Select all scans</button>
            <button type="button" onClick={() => setSelected([])}>Select no scans</button>
            <button type="button" onClick={() => setSelected(collection.scans.filter(scan => !selected.includes(scan.upload_id)).map(scan => scan.upload_id))}>Invert scan selection</button>
          </div>
          <ul className="ath-scan-list">
            {collection.scans.map((scan, index) => {
              const native = scan.file_plugin?.scan
              const label = `Scan ${native?.number ?? index + 1} · entry ${native?.ordinal ?? index + 1}`
              return <li key={scan.upload_id}>
                <label className="ath-check"><input type="checkbox" aria-label={`Include ${label}`} checked={selected.includes(scan.upload_id)}
                  onChange={event => setSelected(ids => event.target.checked ? [...ids, scan.upload_id] : ids.filter(id => id !== scan.upload_id))} />{label}</label>
                <p className="ath-hint">{native?.command}<br />{scan.row_count} points · {scan.columns.length} columns{native?.date ? ` · ${native.date}` : ''}</p>
                <button type="button" aria-pressed={scan.upload_id === active} onClick={() => setActive(scan.upload_id)}>Preview {label}</button>
              </li>
            })}
          </ul>
          <p>{selected.length} scans selected. They will be imported in file order.</p>
          <div className="ath-modal-actions"><button type="button" onClick={onCancel}>Choose another file</button>
            <button type="button" className="ath-primary" disabled={!selected.length} onClick={() => onContinue(collection.scans.filter(scan => selected.includes(scan.upload_id)))}>Review selected scans</button></div>
        </fieldset>
        {!!collection.file_plugin.skipped_scans.length && <details><summary>Scans not available for import</summary>
          <ul>{collection.file_plugin.skipped_scans.map(scan => <li key={scan.ordinal}>Scan {scan.number}: {scan.command}. {scan.reason}</li>)}</ul>
          <p className="ath-hint">These entries remain in the original file.</p></details>}
      </div>
      <div className={styles.preview}>
        {shown && <><p className="ath-hint">{shown.file_plugin?.summary}</p><p className="ath-formula">{columnExpression(mapping, shown.columns)}</p>
          <AthenaImportPreview key={shown.upload_id} projectId={projectId} version={version} uploadId={shown.upload_id} mapping={mapping} disabled={busy} />
          <p className="ath-hint">This preview uses the reader’s suggested columns. You can change them in the next step.</p>
          <a href={`/api/backend/api/athena/projects/${projectId}/uploads/${shown.upload_id}/file`} download>Download original SPEC file</a></>}
      </div>
    </div>
  </section>
}
