"use client"

import type { AthenaGroup } from "@/lib/athena"
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
  return <label className={styles.control} title="k-weight for this viewer. Choosing the saved weight follows the spectrum’s saved settings.">k-weight
    <select aria-label={label} value={displayed} disabled={disabled} onChange={event => {
      const next = event.target.value === "" ? null : Number(event.target.value)
      onChange(next === savedWeight ? null : next)
    }}>
      {savedWeight === null && <option value="">Per spectrum</option>}
      {typeof displayed === "number" && ![0, 1, 2, 3, 4].includes(displayed) && <option value={displayed}>{displayed}</option>}
      {[0, 1, 2, 3, 4].map(weight => <option key={weight} value={weight}>{weight}</option>)}
    </select>
  </label>
}
