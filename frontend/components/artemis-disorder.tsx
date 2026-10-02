"use client"

import { useState } from "react"
import type { DisorderModel, DisorderOptions } from "@/lib/artemis-disorder"
import { SectionHelp } from "./section-help"
import styles from "./artemis-fitting.module.css"

export function ArtemisDisorderControl({ index, enabled, onApply, onPreview }: {
  index: number; enabled: boolean; onApply: (options: DisorderOptions) => void
  onPreview: (options: DisorderOptions) => { expression: string; removed: string[] }
}) {
  const [options, setOptions] = useState<DisorderOptions>({ model: "einstein", value: "0.003", temperature: "",
    theta: "300", staticOffset: false, staticValue: "0", refineTheta: true })
  const thermal = options.model === "einstein" || options.model === "debye"
  const label = (name: string) => `Path ${index} ${name}`
  let preview: { expression: string; removed: string[] } | undefined
  try { preview = onPreview(options) } catch { /* Apply reports incomplete input. */ }
  return <details className={styles.disorder}>
    <summary>Insert Debye–Waller factor<SectionHelp label="Debye–Waller factor">σ² is the mean-square relative displacement (Å²), used in exp(−2k²σ²).</SectionHelp></summary>
    <label className={styles.fullField}><span>σ² model{thermal && <SectionHelp label="Thermal disorder model">Uses this FEFF path’s masses{options.model === "debye" ? ", geometry and Norman radius. The Debye approximation is best suited to simple, nearly isotropic solids" : "; single-scattering paths use the pair’s reduced mass"}. Includes zero-point motion.</SectionHelp>}</span><select aria-label={label("disorder model")} value={options.model}
      onChange={event => setOptions(previous => ({ ...previous, model: event.target.value as DisorderModel }))}>
      <option value="guess">Independent σ² · Guess</option><option value="set">Fixed σ² · Set</option>
      <option value="einstein">Einstein</option><option value="debye">Correlated Debye</option>
    </select></label>
    <div className={styles.grid}>
      {thermal ? <>
        <label>Sample temperature (K)<input aria-label={label("sample temperature (K)")} inputMode="decimal" placeholder="Measured temperature" value={options.temperature}
          onChange={event => setOptions(previous => ({ ...previous, temperature: event.target.value }))} /></label>
        <label>{options.model === "einstein" ? "Einstein" : "Debye"} temperature (K)<input aria-label={label("characteristic temperature (K)")} inputMode="decimal" value={options.theta}
          onChange={event => setOptions(previous => ({ ...previous, theta: event.target.value }))} /></label>
      </> : <label className={styles.fullField}>σ² (Å²)<input aria-label={label("disorder value (Å²)")} inputMode="decimal" value={options.value}
        onChange={event => setOptions(previous => ({ ...previous, value: event.target.value }))} /></label>}
    </div>
    {thermal && <>
      <label className={styles.check}><input type="checkbox" aria-label={label("refine characteristic temperature")} checked={options.refineTheta}
        onChange={event => setOptions(previous => ({ ...previous, refineTheta: event.target.checked }))} />Refine characteristic temperature</label>
      <label className={styles.check}><input type="checkbox" aria-label={label("add static disorder")} checked={options.staticOffset}
        onChange={event => setOptions(previous => ({ ...previous, staticOffset: event.target.checked }))} />Add static σ²<SectionHelp label="Static disorder">Static σ² starts fixed. At one sample temperature, constrain either static σ² or the characteristic temperature; they usually cannot be refined independently.</SectionHelp></label>
      {options.staticOffset && <label className={styles.fullField}>Static σ² (Å²) · Set<input aria-label={label("static disorder (Å²)")} inputMode="decimal" value={options.staticValue}
        onChange={event => setOptions(previous => ({ ...previous, staticValue: event.target.value }))} /></label>}
    </>}
    {preview && <div className={styles.help}>
      <p className={styles.disorderExpression}>On apply: σ² = <code>{preview.expression}</code></p>
      {preview.removed.length > 0 && <p>Sync removes unused parameters: {preview.removed.join(", ")}, including any used only by excluded paths. Project Undo restores their values and bounds.</p>}
    </div>}
    <button type="button" disabled={!enabled} onClick={() => onApply(options)}>Apply σ² model and sync</button>
    <SectionHelp label="Apply σ² model">Apply replaces this path’s σ² expression and syncs parameters for included paths. Share names in the σ² fields to couple paths, or enter a justified constraint such as 2 * sig2_1.</SectionHelp>
  </details>
}
