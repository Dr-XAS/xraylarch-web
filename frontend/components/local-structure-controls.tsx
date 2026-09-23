"use client"

import type { ReactNode } from "react"
import styles from "./cif-viewer.module.css"

interface LocalStructureControlsProps {
  radius: number
  min: number
  max: number
  onRadiusChange: (radius: number) => void
  radiusLabel?: string
  radiusAriaLabel: string
  radiusDisabled?: boolean
  bonds: boolean
  onBondsChange: (bonds: boolean) => void
  showBondsControl?: boolean
  atomCount: number
  children?: ReactNode
}

/** Shared display controls; each viewer owns its geometry and presentation state. */
export function LocalStructureControls({
  radius, min, max, onRadiusChange, radiusLabel = "Display radius", radiusAriaLabel, radiusDisabled = false,
  bonds, onBondsChange, showBondsControl = true, atomCount, children,
}: LocalStructureControlsProps) {
  return <div className={styles.localControls}>
    <label className={styles.radius}>{radiusLabel} <output>{radius.toFixed(1)} Å</output><input aria-label={radiusAriaLabel} type="range" min={min} max={max} step="0.1" value={radius} disabled={radiusDisabled} onChange={event => onRadiusChange(Number(event.target.value))} /></label>
    <div className={styles.options}>
      {showBondsControl && <label><input type="checkbox" checked={bonds} onChange={event => onBondsChange(event.target.checked)} />Bonds</label>}
      {children}
      <span>{atomCount} atom{atomCount === 1 ? "" : "s"} shown</span>
    </div>
  </div>
}
