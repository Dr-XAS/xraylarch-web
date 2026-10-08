"use client"

import type { AthenaGroup } from "@/lib/athena"
import { SectionHelp } from "../section-help"
import styles from "./viewer-kweight-control.module.css"

/** The displayed default follows the original spectra, never preview transforms. */
export function savedKWeight(groups: AthenaGroup[]): number | null {
  const weights = [...new Set(groups.map(group => {
    const effective = group.result?.effective.kweight
    return typeof effective === "number" && Number.isFinite(effective) ? effective : group.parameters.kweight
  }))]
  return weights.length > 1 ? null : weights[0] ?? 2
}

export function ViewerKWeightControl({ label, value, savedWeight, onChange, disabled = false }: {
  label: string
  value: number | null
  savedWeight: number | null
  onChange: (value: number | null) => void
  disabled?: boolean
}) {
  const displayed = value ?? savedWeight ?? ""
  return <label className={styles.control} title="k-weight for this viewer. Choosing the saved weight follows the spectrum’s saved settings."><span>k-weight<SectionHelp label={label}>Multiply χ(k) by k raised to this power before plotting or transforming. Larger weights emphasize high-k oscillations and noise. Choosing the saved weight follows the saved setting; Per spectrum retains each group’s weight. This viewer choice does not change processing or fit parameters.</SectionHelp></span>
    <select aria-label={label} value={displayed} disabled={disabled} onChange={event => {
      const next = event.target.value === "" ? null : Number(event.target.value)
      if (next !== null && (!Number.isFinite(next) || next < 0 || next > 3)) return
      onChange(next === savedWeight ? null : next)
    }}>
      {typeof displayed === "number" && (displayed < 0 || displayed > 3) && <option value={displayed} disabled>{displayed} (outside 0–3)</option>}
      {savedWeight === null && <option value="">Per spectrum</option>}
      {typeof displayed === "number" && displayed >= 0 && displayed <= 3 && ![0, 1, 2, 3].includes(displayed) && <option value={displayed}>{displayed}</option>}
      {[0, 1, 2, 3].map(weight => <option key={weight} value={weight}>{weight}</option>)}
    </select>
  </label>
}
