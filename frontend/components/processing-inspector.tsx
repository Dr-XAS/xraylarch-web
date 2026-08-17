"use client"

import { useState } from "react"

import type { ApiRequestError } from "@/lib/backend-client"
import type { RecipeDraft } from "@/lib/contracts"

type NumericKey = "e0" | "step" | "nnorm" | "pre1" | "pre2" | "norm1" | "norm2" | "rbkg" | "kmin" | "kmax" | "kweight"

interface ProcessingInspectorProps {
  recipe: RecipeDraft
  canPreview: boolean
  canApply: boolean
  statusText: string
  error: ApiRequestError | null
  onChange: (changes: Partial<RecipeDraft>) => void
  onPreview: () => Promise<void>
  onApply: () => Promise<void>
}

const fields: Array<{ key: NumericKey; label: string; unit: string; help: string; step?: string }> = [
  { key: "e0", label: "E0", unit: "eV", help: "Leave blank to retain Larch's automatic edge energy." },
  { key: "step", label: "Edge step", unit: "", help: "Leave blank to retain Larch's automatic edge step." },
  { key: "nnorm", label: "Normalization degree", unit: "", help: "Leave blank to retain Larch's automatic normalization degree.", step: "1" },
  { key: "pre1", label: "Pre-edge start", unit: "eV", help: "Relative pre-edge fitting bound." },
  { key: "pre2", label: "Pre-edge end", unit: "eV", help: "Relative pre-edge fitting bound." },
  { key: "norm1", label: "Post-edge start", unit: "eV", help: "Relative post-edge normalization bound." },
  { key: "norm2", label: "Post-edge end", unit: "eV", help: "Relative post-edge normalization bound." },
  { key: "rbkg", label: "Rbkg", unit: "Å", help: "Background removal radius.", step: "0.1" },
  { key: "kmin", label: "k minimum", unit: "Å⁻¹", help: "Lower EXAFS fitting bound.", step: "0.1" },
  { key: "kmax", label: "k maximum", unit: "Å⁻¹", help: "Leave blank for Larch's data-bound maximum.", step: "0.1" },
  { key: "kweight", label: "Shared k-weight", unit: "", help: "Applied consistently to background removal and Fourier transform.", step: "1" },
]

export function ProcessingInspector({ recipe, canPreview, canApply, statusText, error, onChange, onPreview, onApply }: ProcessingInspectorProps) {
  const [busy, setBusy] = useState(false)
  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="inspector-card" data-testid="processing-inspector" aria-labelledby="processing-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Normalize & EXAFS</p>
          <h2 id="processing-heading">Processing recipe</h2>
        </div>
        <span className="muted">{statusText}</span>
      </div>
      {error && <div className="error-callout" role="alert"><strong>{error.message}</strong><span>{error.recovery}</span></div>}
      <div className="field-grid">
        {fields.map((field) => {
          const helpId = `${field.key}-help`
          const invalid = Boolean(error?.fields.includes(field.key))
          return (
            <label key={field.key} className="recipe-field">
              <span>{field.label}{field.unit ? <em>{field.unit}</em> : null}</span>
              <input
                type="number"
                step={field.step ?? "any"}
                value={recipe[field.key] ?? ""}
                aria-describedby={helpId}
                aria-invalid={invalid || undefined}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  onChange({ [field.key]: value === "" ? null : Number(value) } as Partial<RecipeDraft>)
                }}
              />
              <small id={helpId}>{field.help}</small>
            </label>
          )
        })}
      </div>
      <details className="advanced-controls">
        <summary>Advanced Larch controls</summary>
        <div className="field-grid">
          <label className="recipe-field">
            <span>Autobk taper<em>Å⁻¹</em></span>
            <input type="number" step="0.1" value={recipe.autobk_dk ?? ""} aria-describedby="autobk-dk-help" onChange={(event) => onChange({ autobk_dk: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} />
            <small id="autobk-dk-help">Leave blank to retain the stage-specific Larch default.</small>
          </label>
          <label className="recipe-field">
            <span>Autobk window</span>
            <select value={recipe.autobk_window ?? ""} aria-describedby="autobk-window-help" onChange={(event) => onChange({ autobk_window: event.currentTarget.value || null })}>
              <option value="">Automatic</option>
              <option value="kaiser">Kaiser</option>
              <option value="hanning">Hanning</option>
            </select>
            <small id="autobk-window-help">Background-removal window override.</small>
          </label>
          <label className="recipe-field">
            <span>Fourier taper<em>Å⁻¹</em></span>
            <input type="number" step="0.1" value={recipe.ft_dk} aria-describedby="ft-dk-help" onChange={(event) => onChange({ ft_dk: Number(event.currentTarget.value) })} />
            <small id="ft-dk-help">Fourier transform window taper.</small>
          </label>
          <label className="recipe-field">
            <span>Fourier taper 2<em>Å⁻¹</em></span>
            <input type="number" step="0.1" value={recipe.ft_dk2 ?? ""} aria-describedby="ft-dk2-help" onChange={(event) => onChange({ ft_dk2: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} />
            <small id="ft-dk2-help">Optional second Fourier taper bound.</small>
          </label>
          <label className="recipe-field">
            <span>Fourier window</span>
            <select value={recipe.ft_window} aria-describedby="ft-window-help" onChange={(event) => onChange({ ft_window: event.currentTarget.value })}>
              <option value="kaiser">Kaiser</option>
              <option value="hanning">Hanning</option>
            </select>
            <small id="ft-window-help">Fourier transform window function.</small>
          </label>
          <label className="recipe-field">
            <span>Output range<em>Å</em></span>
            <input type="number" step="0.1" value={recipe.rmax_out} aria-describedby="rmax-out-help" onChange={(event) => onChange({ rmax_out: Number(event.currentTarget.value) })} />
            <small id="rmax-out-help">Maximum R written to the server-produced trace.</small>
          </label>
        </div>
      </details>
      <div className="processing-actions">
        <button data-testid="preview-button" type="button" disabled={!canPreview || busy} onClick={() => void run(onPreview)}>Preview changes</button>
        <button data-testid="apply-button" className="primary-action" type="button" disabled={!canApply || busy} onClick={() => void run(onApply)}>Apply revision</button>
      </div>
    </section>
  )
}
