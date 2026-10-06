"use client"

import type { ReactNode } from "react"
import { SectionHelp } from "./section-help"
import styles from "./artefact-viewers/cif-viewer.module.css"

interface LocalStructureControlsProps {
  radius: number
  min: number
  max: number
  onRadiusChange: (radius: number) => void
  radiusLabel?: string
  radiusAriaLabel: string
  radiusDisabled?: boolean
  extentControl?: ReactNode
  bonds: boolean
  onBondsChange: (bonds: boolean) => void
  showBondsControl?: boolean
  atomCount: number
  children?: ReactNode
}

/** Shared display controls; each viewer owns its geometry and presentation state. */
export function LocalStructureControls({
  radius, min, max, onRadiusChange, radiusLabel = "Display radius", radiusAriaLabel, radiusDisabled = false,
  extentControl, bonds, onBondsChange, showBondsControl = true, atomCount, children,
}: LocalStructureControlsProps) {
  return <div className={styles.localControls}>
    {extentControl ?? <label className={styles.radius}><span>{radiusLabel}<SectionHelp label={radiusAriaLabel}>Radius in Å of the displayed local environment around the absorbing site. Changing this display does not recalculate FEFF paths or change fit parameters.</SectionHelp></span> <output>{radius.toFixed(1)} Å</output><input aria-label={radiusAriaLabel} type="range" min={min} max={max} step="0.1" value={radius} disabled={radiusDisabled} onChange={event => onRadiusChange(Number(event.target.value))} /></label>}
    <div className={styles.options}>
      {showBondsControl && <label><input type="checkbox" checked={bonds} onChange={event => onBondsChange(event.target.checked)} />Bonds<SectionHelp label="Structure bonds">Show connecting lines for the viewer’s neighboring atoms. These are a visual guide, not a measurement of chemical bond order.</SectionHelp></label>}
      {children}
      <span>{atomCount} atom{atomCount === 1 ? "" : "s"} shown</span>
    </div>
  </div>
}
