"use client"

import { useId, useState, type ReactNode } from "react"
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
  const radiusId = useId()
  const [radiusDraft, setRadiusDraft] = useState<string | null>(null)
  return <div className={styles.localControls}>
    {extentControl ?? <div className={styles.radius}>
      <label htmlFor={radiusId}>{radiusLabel}<SectionHelp label={radiusAriaLabel}>Radius in Å of the displayed local environment around the absorbing site, from {min} to {max} Å. Type a custom value or use the slider. Changing this display does not recalculate FEFF paths or change fit parameters.</SectionHelp></label>
      <span className={styles.radiusValue}><input id={radiusId} aria-label={radiusAriaLabel} type="number" min={min} max={max} step="any"
        value={radiusDraft ?? radius} disabled={radiusDisabled} onChange={event => {
          const text = event.target.value
          setRadiusDraft(text)
          const value = Number(text)
          if (text !== "" && Number.isFinite(value) && value >= min && value <= max) onRadiusChange(value)
        }} onBlur={event => {
          const text = event.target.value
          const value = Number(text)
          if (text !== "" && Number.isFinite(value)) onRadiusChange(Math.min(max, Math.max(min, value)))
          setRadiusDraft(null)
        }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur() }} /><span>Å</span></span>
      <input aria-label={radiusAriaLabel} type="range" min={min} max={max} step="0.1" value={radius} disabled={radiusDisabled} onChange={event => {
        setRadiusDraft(null)
        onRadiusChange(Number(event.target.value))
      }} />
    </div>}
    <div className={styles.options}>
      {showBondsControl && <label><input type="checkbox" checked={bonds} onChange={event => onBondsChange(event.target.checked)} />Bonds<SectionHelp label="Structure bonds">Show connecting lines for the viewer’s neighboring atoms. These are a visual guide, not a measurement of chemical bond order.</SectionHelp></label>}
      {children}
      <span>{atomCount} atom{atomCount === 1 ? "" : "s"} shown</span>
    </div>
  </div>
}
