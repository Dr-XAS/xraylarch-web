"use client"

import styles from "./structure-display-legend.module.css"

interface UnitCellControl {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** Compact display toggles placed beside the atom color legend in a structure canvas. */
export function StructureDisplayLegend({ bonds, onBondsChange, unitCell }: {
  bonds: boolean
  onBondsChange: (checked: boolean) => void
  unitCell?: UnitCellControl
}) {
  return <div className={styles.legend} role="group" aria-label="Structure display">
    <label className={styles.item}><input type="checkbox" checked={bonds} onChange={event => onBondsChange(event.target.checked)} />Bonds</label>
    {unitCell && <label className={styles.item}><input type="checkbox" checked={unitCell.checked} disabled={unitCell.disabled}
      onChange={event => unitCell.onChange(event.target.checked)} />Unit cell outline</label>}
  </div>
}
