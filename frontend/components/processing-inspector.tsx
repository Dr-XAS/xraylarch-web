"use client"

import { useState } from "react"
import { SectionHelp } from "./section-help"

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

function FieldRecovery({ field, error, invalid }: {
  field: AdvancedFieldKey
  error: ApiRequestError | null
  invalid: boolean
}) {
  return invalid ? <small className="field-recovery" id={`${field}-recovery`}>{error?.recovery}</small> : null
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
            <div key={field.key} className="recipe-field">
              <span><label htmlFor={`recipe-${field.key}`}>{field.label}{field.unit ? <em>{field.unit}</em> : null}</label><SectionHelp label={field.label} id={helpId}>{field.help}</SectionHelp></span>
              <input
                id={`recipe-${field.key}`}
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
            </div>
          )
        })}
      </div>
      <details className="advanced-controls" open={hasAdvancedError}>
        <summary>Advanced Larch controls</summary>
        <div className="field-grid">
          <div className="recipe-field">
            <span><label htmlFor="recipe-autobk_dk">Autobk taper<em>Å⁻¹</em></label><SectionHelp label="Autobk taper" id="autobk-dk-help">Leave blank to retain the stage-specific Larch default.</SectionHelp></span>
            <input id="recipe-autobk_dk" type="number" step="0.1" value={recipe.autobk_dk ?? ""} aria-describedby={autobkDk.describedBy} aria-invalid={autobkDk.invalid || undefined} onChange={(event) => onChange({ autobk_dk: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} />
            <FieldRecovery field="autobk_dk" error={error} invalid={autobkDk.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-autobk_window">Autobk window</label><SectionHelp label="Autobk window" id="autobk-window-help">Background-removal window override.</SectionHelp></span>
            <select id="recipe-autobk_window" value={recipe.autobk_window ?? ""} aria-describedby={autobkWindow.describedBy} aria-invalid={autobkWindow.invalid || undefined} onChange={(event) => onChange({ autobk_window: event.currentTarget.value || null })}>
              <option value="">Automatic</option>
              <option value="kaiser">Kaiser</option>
              <option value="hanning">Hanning</option>
            </select>
            <FieldRecovery field="autobk_window" error={error} invalid={autobkWindow.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-ft_dk">Fourier taper<em>Å⁻¹</em></label><SectionHelp label="Fourier taper" id="ft-dk-help">Fourier transform window taper.</SectionHelp></span>
            <input id="recipe-ft_dk" type="number" step="0.1" value={recipe.ft_dk} aria-describedby={ftDk.describedBy} aria-invalid={ftDk.invalid || undefined} onChange={(event) => onChange({ ft_dk: Number(event.currentTarget.value) })} />
            <FieldRecovery field="ft_dk" error={error} invalid={ftDk.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-ft_dk2">Fourier taper 2<em>Å⁻¹</em></label><SectionHelp label="Fourier taper 2" id="ft-dk2-help">Optional second Fourier taper bound.</SectionHelp></span>
            <input id="recipe-ft_dk2" type="number" step="0.1" value={recipe.ft_dk2 ?? ""} aria-describedby={ftDk2.describedBy} aria-invalid={ftDk2.invalid || undefined} onChange={(event) => onChange({ ft_dk2: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} />
            <FieldRecovery field="ft_dk2" error={error} invalid={ftDk2.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-ft_window">Fourier window</label><SectionHelp label="Fourier window" id="ft-window-help">Fourier transform window function.</SectionHelp></span>
            <select id="recipe-ft_window" value={recipe.ft_window} aria-describedby={ftWindow.describedBy} aria-invalid={ftWindow.invalid || undefined} onChange={(event) => onChange({ ft_window: event.currentTarget.value })}>
              <option value="kaiser">Kaiser</option>
              <option value="hanning">Hanning</option>
            </select>
            <FieldRecovery field="ft_window" error={error} invalid={ftWindow.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-nfft">FFT points</label><SectionHelp label="FFT points" id="nfft-help">Number of Fourier transform points.</SectionHelp></span>
            <input id="recipe-nfft" type="number" step="1" value={recipe.nfft} aria-describedby={nfft.describedBy} aria-invalid={nfft.invalid || undefined} onChange={(event) => onChange({ nfft: Number(event.currentTarget.value) })} />
            <FieldRecovery field="nfft" error={error} invalid={nfft.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-kstep">k step<em>Å⁻¹</em></label><SectionHelp label="k step" id="kstep-help">Sampling step for the Fourier transform.</SectionHelp></span>
            <input id="recipe-kstep" type="number" step="0.01" value={recipe.kstep} aria-describedby={kstep.describedBy} aria-invalid={kstep.invalid || undefined} onChange={(event) => onChange({ kstep: Number(event.currentTarget.value) })} />
            <FieldRecovery field="kstep" error={error} invalid={kstep.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-rmax_out">Output range<em>Å</em></label><SectionHelp label="Output range" id="rmax-out-help">Maximum R written to the server-produced trace.</SectionHelp></span>
            <input id="recipe-rmax_out" type="number" step="0.1" value={recipe.rmax_out} aria-describedby={rmaxOut.describedBy} aria-invalid={rmaxOut.invalid || undefined} onChange={(event) => onChange({ rmax_out: Number(event.currentTarget.value) })} />
            <FieldRecovery field="rmax_out" error={error} invalid={rmaxOut.invalid} />
          </div>
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
