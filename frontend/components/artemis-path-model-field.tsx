"use client"

import { useId, useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { SectionHelp } from "./section-help"
import styles from "./artemis-fitting.module.css"

export function ArtemisPathModelField({ index, quantity, unit, help, value, onChange, children }: {
  index: number; quantity: "ΔR" | "σ²"; unit: string; help: string; value: string
  onChange: (value: string) => void; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const label = `Path ${index} ${quantity} (${unit})`
  return <div className={styles.modelField}>
    <label className={styles.fullField}><span>{quantity} ({unit})<SectionHelp label={label}>{help} Enter a number, parameter name or expression; use the same name to share a parameter across paths.</SectionHelp></span>
      <input value={value} aria-label={label} onChange={event => onChange(event.target.value)} spellCheck={false} />
    </label>
    <button type="button" className={styles.insertModel} aria-label={`Insert ${quantity} model for path ${index}`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(previous => !previous)}>
      Insert model<ChevronDown size={14} aria-hidden="true" />
    </button>
    <div id={panelId} role="region" aria-label={`Path ${index} ${quantity} model`} className={styles.modelPanel} hidden={!open}>{children}</div>
  </div>
}
