"use client"

import { useState } from "react"

import type { ApiRequestError } from "@/lib/backend-client"
import type { RecipeDraft } from "@/lib/contracts"

type NumericKey = "e0" | "step" | "nnorm" | "pre1" | "pre2" | "norm1" | "norm2" | "rbkg" | "kmin" | "kmax" | "kweight"
type AdvancedFieldKey = "autobk_dk" | "autobk_window" | "ft_dk" | "ft_dk2" | "ft_window" | "nfft" | "kstep" | "rmax_out"

interface ProcessingInspectorProps {
  recipe: RecipeDraft
  canPreview: boolean
  canApply: boolean
  isPreviewing: boolean
  statusText: string
  error: ApiRequestError | null
  onChange: (changes: Partial<RecipeDraft>) => void
  onPreview: () => Promise<void>
  onCancelPreview: () => void
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

function fieldBinding(error: ApiRequestError | null, field: AdvancedFieldKey, helpId: string) {
  const invalid = Boolean(error?.fields.includes(field))
  return {
    invalid,
    describedBy: invalid ? `${helpId} ${field}-recovery` : helpId,
  }
}

function AdvancedFieldHelp({ field, helpId, help, error, invalid }: {
  field: AdvancedFieldKey
  helpId: string
  help: string
  error: ApiRequestError | null
  invalid: boolean
}) {
  return <>
    <small id={helpId}>{help}</small>
    {invalid && <small className="field-recovery" id={`${field}-recovery`}>{error?.recovery}</small>}
  </>
}

export function ProcessingInspector({ recipe, canPreview, canApply, isPreviewing, statusText, error, onChange, onPreview, onCancelPreview, onApply }: ProcessingInspectorProps) {
  const [busy, setBusy] = useState(false)
  const autobkDk = fieldBinding(error, "autobk_dk", "autobk-dk-help")
  const autobkWindow = fieldBinding(error, "autobk_window", "autobk-window-help")
  const ftDk = fieldBinding(error, "ft_dk", "ft-dk-help")
  const ftDk2 = fieldBinding(error, "ft_dk2", "ft-dk2-help")
  const ftWindow = fieldBinding(error, "ft_window", "ft-window-help")
  const nfft = fieldBinding(error, "nfft", "nfft-help")
  const kstep = fieldBinding(error, "kstep", "kstep-help")
  const rmaxOut = fieldBinding(error, "rmax_out", "rmax-out-help")
  const hasAdvancedError = [autobkDk, autobkWindow, ftDk, ftDk2, ftWindow, nfft, kstep, rmaxOut].some((field) => field.invalid)
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
      <details className="advanced-controls" open={hasAdvancedError}>
        <summary>Advanced Larch controls</summary>
        <div className="field-grid">
          <label className="recipe-field">
            <span>Autobk taper<em>Å⁻¹</em></span>
            <input type="number" step="0.1" value={recipe.autobk_dk ?? ""} aria-describedby={autobkDk.describedBy} aria-invalid={autobkDk.invalid || undefined} onChange={(event) => onChange({ autobk_dk: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} />
            <AdvancedFieldHelp field="autobk_dk" helpId="autobk-dk-help" help="Leave blank to retain the stage-specific Larch default." error={error} invalid={autobkDk.invalid} />
          </label>
          <label className="recipe-field">
            <span>Autobk window</span>
            <select value={recipe.autobk_window ?? ""} aria-describedby={autobkWindow.describedBy} aria-invalid={autobkWindow.invalid || undefined} onChange={(event) => onChange({ autobk_window: event.currentTarget.value || null })}>
              <option value="">Automatic</option>
              <option value="kaiser">Kaiser</option>
              <option value="hanning">Hanning</option>
            </select>
            <AdvancedFieldHelp field="autobk_window" helpId="autobk-window-help" help="Background-removal window override." error={error} invalid={autobkWindow.invalid} />
          </label>
          <label className="recipe-field">
            <span>Fourier taper<em>Å⁻¹</em></span>
            <input type="number" step="0.1" value={recipe.ft_dk} aria-describedby={ftDk.describedBy} aria-invalid={ftDk.invalid || undefined} onChange={(event) => onChange({ ft_dk: Number(event.currentTarget.value) })} />
            <AdvancedFieldHelp field="ft_dk" helpId="ft-dk-help" help="Fourier transform window taper." error={error} invalid={ftDk.invalid} />
          </label>
          <label className="recipe-field">
            <span>Fourier taper 2<em>Å⁻¹</em></span>
            <input type="number" step="0.1" value={recipe.ft_dk2 ?? ""} aria-describedby={ftDk2.describedBy} aria-invalid={ftDk2.invalid || undefined} onChange={(event) => onChange({ ft_dk2: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} />
            <AdvancedFieldHelp field="ft_dk2" helpId="ft-dk2-help" help="Optional second Fourier taper bound." error={error} invalid={ftDk2.invalid} />
          </label>
          <label className="recipe-field">
            <span>Fourier window</span>
            <select value={recipe.ft_window} aria-describedby={ftWindow.describedBy} aria-invalid={ftWindow.invalid || undefined} onChange={(event) => onChange({ ft_window: event.currentTarget.value })}>
              <option value="kaiser">Kaiser</option>
              <option value="hanning">Hanning</option>
            </select>
            <AdvancedFieldHelp field="ft_window" helpId="ft-window-help" help="Fourier transform window function." error={error} invalid={ftWindow.invalid} />
          </label>
          <label className="recipe-field">
            <span>FFT points</span>
            <input type="number" step="1" value={recipe.nfft} aria-describedby={nfft.describedBy} aria-invalid={nfft.invalid || undefined} onChange={(event) => onChange({ nfft: Number(event.currentTarget.value) })} />
            <AdvancedFieldHelp field="nfft" helpId="nfft-help" help="Number of Fourier transform points." error={error} invalid={nfft.invalid} />
          </label>
          <label className="recipe-field">
            <span>k step<em>Å⁻¹</em></span>
            <input type="number" step="0.01" value={recipe.kstep} aria-describedby={kstep.describedBy} aria-invalid={kstep.invalid || undefined} onChange={(event) => onChange({ kstep: Number(event.currentTarget.value) })} />
            <AdvancedFieldHelp field="kstep" helpId="kstep-help" help="Sampling step for the Fourier transform." error={error} invalid={kstep.invalid} />
          </label>
          <label className="recipe-field">
            <span>Output range<em>Å</em></span>
            <input type="number" step="0.1" value={recipe.rmax_out} aria-describedby={rmaxOut.describedBy} aria-invalid={rmaxOut.invalid || undefined} onChange={(event) => onChange({ rmax_out: Number(event.currentTarget.value) })} />
            <AdvancedFieldHelp field="rmax_out" helpId="rmax-out-help" help="Maximum R written to the server-produced trace." error={error} invalid={rmaxOut.invalid} />
          </label>
        </div>
      </details>
      <div className="processing-actions">
        {isPreviewing ? (
          <button type="button" onClick={() => { setBusy(false); onCancelPreview() }}>Cancel preview</button>
        ) : (
          <button data-testid="preview-button" type="button" disabled={!canPreview || busy} onClick={() => void run(onPreview)}>Preview changes</button>
        )}
        <button data-testid="apply-button" className="primary-action" type="button" disabled={!canApply || busy} onClick={() => void run(onApply)}>Apply revision</button>
      </div>
    </section>
  )
}
