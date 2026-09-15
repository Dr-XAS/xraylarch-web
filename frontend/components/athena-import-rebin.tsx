"use client"

import { defaultRebin, type ImportRebinOptions } from "@/lib/athena-import"

export function AthenaImportRebin({ value = defaultRebin, chi, onChange }: {
  value?: ImportRebinOptions; chi: boolean; onChange: (value: ImportRebinOptions) => void
}) {
  return <details><summary>Rebin quick scans</summary>
    <label className="ath-check"><input type="checkbox" checked={value.enabled} disabled={chi}
      onChange={e => onChange({ ...value, enabled: e.target.checked })} />Perform rebinning</label>
    <p className="ath-hint">Use a sparse energy grid before the edge, a fine grid through the edge, and a uniform k grid for EXAFS. Compare the original and rebinned signals in the preview.</p>
    <fieldset disabled={chi || !value.enabled} style={{ border: 0, padding: 0, margin: 0 }}><div className="ath-fields">
      <label className="ath-field"><span>Rebin grid E₀ · eV</span><input type="number" step="any" placeholder="Automatic" value={value.e0 ?? ''}
        onChange={e => onChange({ ...value, e0: e.target.value === '' ? null : Number(e.target.value) })} /></label>
      {([
        ['emin', 'Rebin edge start · eV relative to E₀'], ['emax', 'Rebin edge end · eV relative to E₀'],
        ['pre', 'Rebin pre-edge step · eV'], ['xanes', 'Rebin XANES step · eV'],
        ['exafs', 'Rebin EXAFS step · Å⁻¹'], ['width', 'Rebin smoothing width · points'],
      ] as const).map(([key, label]) => <label key={key} className="ath-field"><span>{label}</span>
        <input type="number" step={key === 'width' ? 1 : 'any'} value={value[key]}
          onChange={e => onChange({ ...value, [key]: e.target.value === '' ? '' : Number(e.target.value) })} /></label>)}
    </div></fieldset>
    <p className="ath-hint">Grid E₀ is in eV even when the file uses keV. Leave it blank to find the edge. References find their own grid E₀. Original data and columns are retained in the project.</p>
    <p className="ath-hint">Grid choices are remembered after import and shared with the rebin processing tool. Matching column layouts restore the last rebin choice; different layouts start with rebinning off.</p>
    {chi && <p className="ath-hint">Three-region rebinning requires energy data and is unavailable for χ(k).</p>}
  </details>
}
