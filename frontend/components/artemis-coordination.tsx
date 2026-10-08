"use client"

import { useState } from "react"
import type { ArtemisParameterDraft, ArtemisPath } from "@/lib/artemis"
import type { CoordinationOptions } from "@/lib/artemis-coordination"
import { SectionHelp } from "./section-help"
import styles from "./artemis-fitting.module.css"

type Preview = { expression: string; removed: string[] }
type Props = {
  index: number; path: ArtemisPath; parameters: ArtemisParameterDraft[]
  onPreview: (options: CoordinationOptions) => Preview
  onApply: (options: CoordinationOptions) => void
}

export function ArtemisCoordinationControl({ index, path, parameters, onPreview, onApply }: Props) {
  // Recognize the helper's explicit model without interpreting arbitrary expressions.
  const match = path.s02.trim().match(/^(s02_\d+)\s*\*\s*(cn_\d+)\s*\/\s*degen$/)
  const amplitude = parameters.find(parameter => parameter.name.trim() === (match?.[1] ?? path.s02.trim()))
  const coordination = match && parameters.find(parameter => parameter.name.trim() === match[2])
  const numericAmplitude = path.s02.trim() && Number.isFinite(Number(path.s02)) && Number(path.s02) > 0 ? path.s02.trim() : ""
  const defaults: CoordinationOptions = {
    value: coordination && coordination.kind !== "def" ? coordination.value : String(path.metadata.degen),
    s02: amplitude?.kind === "set" ? amplitude.value : numericAmplitude,
    refine: coordination ? coordination.kind !== "set" : true,
    max: coordination?.kind === "guess" ? coordination.max : "",
  }
  return <details className={styles.coordination}>
    <summary>Set / fit coordination number<SectionHelp label="Coordination number">For this single-scattering path, CN counts equivalent neighbors. Split shells need separate CN values or justified constraints. FEFF N stays as file metadata; the amplitude expression accounts for your chosen CN.</SectionHelp></summary>
    {coordination && <p className={styles.help}>CN parameter: <strong>{coordination.name}</strong> · {coordination.kind === "guess" ? `fit from ${coordination.value}` : coordination.kind === "set" ? `fixed at ${coordination.value}` : coordination.expression}</p>}
    <CoordinationForm key={JSON.stringify([path.s02, defaults])} index={index} enabled={path.enabled} defaults={defaults} current={!!coordination && amplitude?.kind === "set" && coordination.kind !== "def"}
      expression={path.s02} onPreview={onPreview} onApply={onApply} />
  </details>
}

function CoordinationForm({ index, enabled, defaults, current, expression, onPreview, onApply }: {
  index: number; enabled: boolean; defaults: CoordinationOptions; current: boolean; expression: string
  onPreview: (options: CoordinationOptions) => Preview; onApply: (options: CoordinationOptions) => void
}) {
  const [options, setOptions] = useState(defaults)
  const [error, setError] = useState("")
  const unchanged = current && JSON.stringify(options) === JSON.stringify(defaults)
  const update = (change: Partial<CoordinationOptions>) => { setOptions(previous => ({ ...previous, ...change })); setError("") }
  const label = (name: string) => `Path ${index} ${name}`
  let preview: Preview | undefined
  try { if (!unchanged) preview = onPreview(options) } catch { /* Report incomplete values beside the form on Apply. */ }
  return <>
    <div className={styles.grid}>
      <label><span>Coordination number (CN)<SectionHelp label={label("coordination number")}>Number of equivalent neighbors represented by this single-scattering path. While Fit CN is on, the displayed value is retained as the starting value. Clear Fit CN to edit it or hold CN fixed.</SectionHelp></span><input aria-label={label("coordination number")} type="number" min={0} step="any" inputMode="decimal" value={options.value} disabled={options.refine}
        onChange={event => update({ value: event.target.value })} /></label>
      <label><span>Fixed S₀²<SectionHelp label={label("fixed S₀²")}>Dimensionless amplitude factor calibrated from a reference with known coordination. It stays fixed because CN and S₀² multiply the same path amplitude.</SectionHelp></span><input aria-label={label("fixed S₀²")} type="number" min={0} step="any" inputMode="decimal" placeholder="Calibrated value" value={options.s02}
        onChange={event => update({ s02: event.target.value })} /></label>
    </div>
    <label className={styles.check}><input type="checkbox" aria-label={label("fit coordination number")} checked={options.refine}
      onChange={event => update({ refine: event.target.checked })} />Fit CN (uncheck to fix)<SectionHelp label={label("fit coordination number")}>Create a nonnegative Guess parameter for CN. Clear this to create a Set parameter that holds the entered coordination number fixed.</SectionHelp></label>
    {options.refine && <label className={styles.fullField}><span>CN maximum (optional)<SectionHelp label={label("coordination maximum")}>Optional upper bound for fitted CN, at least as large as its starting value. Leave blank for no upper bound; choose any bound from structural evidence.</SectionHelp></span><input aria-label={label("coordination maximum")} type="number" min={0} step="any" inputMode="decimal" placeholder="No upper bound" value={options.max}
      onChange={event => update({ max: event.target.value })} /></label>}
    <p className={styles.help}>Use S₀² calibrated from a reference. CN and S₀² cannot both be freely fitted for this path.</p>
    {unchanged ? <p className={styles.help}>Applied. Edit values here, or edit bounds and constraints in Parameters.</p>
      : <p className={`${styles.help} ${styles.disorderExpression}`}>Replaces amplitude: <code>{expression}</code>
        {preview && <> → <code>{preview.expression}</code></>}</p>}
    {current && !unchanged && <p className={styles.help}>Reapplying creates new parameters{options.refine ? " with CN minimum 0" : ""}.</p>}
    {preview && preview.removed.length > 0 && <p className={styles.help}>Sync removes unused parameters: {preview.removed.join(", ")}, including those used only by excluded paths.</p>}
    {!enabled && <p className={styles.help}>Include this path to apply CN.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <button type="button" disabled={!enabled || unchanged} aria-label={`Apply coordination number for path ${index}`} onClick={() => {
      try { onPreview(options); setError(""); onApply(options) }
      catch (error) { setError(error instanceof Error ? error.message : "Check the coordination-number values.") }
    }}>Apply CN and sync</button>
  </>
}
