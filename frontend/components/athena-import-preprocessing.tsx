"use client"

import type { AthenaGroup } from "@/lib/athena"
import { isDifferenceGroup } from "@/lib/athena"
import { defaultPreprocessing, type ImportPreprocessing } from "@/lib/athena-import"

export function AthenaImportPreprocessing({ value = defaultPreprocessing, groups, chi, onChange }: {
  value?: ImportPreprocessing; groups: AthenaGroup[]; chi: boolean; onChange: (value: ImportPreprocessing) => void
}) {
  const valid = groups.filter(g => !['chi', 'detector'].includes(g.data_type) && !isDifferenceGroup(g) && !g.processing_error && g.result)
  const missing = !!value.standard_id && !valid.some(g => g.id === value.standard_id)
  return <details><summary>Preprocess imported groups</summary>
    <label className="ath-check"><input type="checkbox" checked={value.mark} onChange={e => onChange({ ...value, mark: e.target.checked })} />Mark each imported sample</label>
    <p className="ath-hint">References remain unmarked. Preprocessing choices are remembered after a successful import and reused within matching batches.</p>
    <label className="ath-field"><span>Preprocessing standard</span><select disabled={chi} value={value.standard_id ?? ''}
      onChange={e => onChange({ ...value, standard_id: e.target.value || null, ...(!e.target.value ? { align: false, copy_parameters: false } : {}) })}>
      <option value="">None</option>{missing && <option value={value.standard_id!}>Previous standard unavailable · choose another</option>}
      {valid.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
    </select></label>
    <label className="ath-check"><input type="checkbox" checked={value.copy_parameters} disabled={chi || !value.standard_id || missing}
      onChange={e => onChange({ ...value, copy_parameters: e.target.checked })} />Set parameters to the standard</label>
    <label className="ath-check"><input type="checkbox" checked={value.align} disabled={chi || !value.standard_id || missing}
      onChange={e => onChange({ ...value, align: e.target.checked })} />Align to the standard</label>
    <p className="ath-hint">Copy processing parameters, element/edge and plot scale/offset; preserve the imported energy shift. Alignment fits smoothed edge derivatives and uses reference channels when both scans have them. Separate detector groups share one fitted shift.</p>
    {chi && <p className="ath-hint">Parameter copying and energy alignment require μ(E), XANES or normalized energy data.</p>}
    {missing && <p role="alert" className="ath-error">The chosen standard is no longer usable. Select another standard or None.</p>}
  </details>
}
