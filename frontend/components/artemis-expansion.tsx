"use client"

import { useState } from "react"
import type { ExpansionOptions } from "@/lib/artemis-expansion"
import { SectionHelp } from "./section-help"
import styles from "./artemis-fitting.module.css"

export function ArtemisExpansionControl({ index, enabled, reff, onApply, onPreview }: {
  index: number; enabled: boolean; reff: number; onApply: (options: ExpansionOptions) => void
  onPreview: (options: ExpansionOptions) => { expression: string; removed: string[] }
}) {
  const [options, setOptions] = useState<ExpansionOptions>({ value: "0" })
  let preview: { expression: string; removed: string[] } | undefined
  try { preview = onPreview(options) } catch { /* Apply reports incomplete input. */ }
  return <>
    <label className={styles.fullField}><span>ΔR model<SectionHelp label={`Path ${index} expansion model`}>Isotropic expansion scales path lengths by the same fraction when paths share α. This assumes uniform expansion or contraction of the FEFF geometry.</SectionHelp></span>
      <select aria-label={`Path ${index} ΔR model`} defaultValue="expansion"><option value="expansion">Isotropic expansion · α × Reff</option></select>
    </label>
    <label className={styles.fullField}><span>Expansion factor α · Guess<SectionHelp label={`Path ${index} expansion factor`}>Dimensionless fractional length change, fitted from this starting value. α must exceed −1 so the path length stays positive. Share the inserted alpha parameter name in other paths’ ΔR expressions to fit a common expansion.</SectionHelp></span>
      <input aria-label={`Path ${index} expansion factor α`} type="number" min={-1 + Number.EPSILON / 2} step="any" inputMode="decimal" value={options.value} onChange={event => setOptions({ value: event.target.value })} />
    </label>
    <p className={styles.help}>ΔR = α × Reff; R = (1 + α) × Reff. This path uses Reff = {reff} Å from FEFF. α = 0.01 means 1% expansion; negative values mean contraction.</p>
    {preview && <div className={styles.help}>
      <p className={styles.disorderExpression}>On apply: ΔR = <code>{preview.expression}</code></p>
      {preview.removed.length > 0 && <p>Sync removes unused parameters: {preview.removed.join(", ")}, including any used only by excluded paths. Project Undo restores their values and bounds.</p>}
    </div>}
    <button type="button" disabled={!enabled} aria-label={`Apply ΔR model for path ${index}`} onClick={() => onApply(options)}>Apply ΔR model and sync</button>
  </>
}
