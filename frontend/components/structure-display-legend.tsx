"use client"

import { SectionHelp } from "./section-help"
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
    <label className={styles.item}><input type="checkbox" aria-label="Bonds" checked={bonds} onChange={event => onBondsChange(event.target.checked)} />Bonds<SectionHelp label="Structure bonds">Show connections inferred from atom distances. These are visual guides; FEFF scattering paths and coordination analysis use their own definitions.</SectionHelp></label>
    {unitCell && <label className={styles.item}><input type="checkbox" aria-label="Unit cell outline" checked={unitCell.checked} disabled={unitCell.disabled}
      onChange={event => unitCell.onChange(event.target.checked)} />Unit cell outline<SectionHelp label="Unit cell outline">Draw the crystallographic cell edges to show the lattice orientation. The unit-cell view keeps this outline visible.</SectionHelp></label>}
  </div>
}
