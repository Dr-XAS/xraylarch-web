"use client"

import { useState } from "react"
import { SectionHelp } from "./section-help"

import type { ApiRequestError } from "@/lib/backend-client"
import type { RecipeDraft } from "@/lib/contracts"

type NumericKey = "e0" | "step" | "nnorm" | "pre1" | "pre2" | "norm1" | "norm2" | "rbkg" | "kmin" | "kmax" | "kweight"
type AdvancedFieldKey = "autobk_dk" | "autobk_window" | "ft_dk" | "ft_dk2" | "ft_window" | "nfft" | "kstep" | "rmax_out"

function recipeProblems(recipe: RecipeDraft): string[] {
  const problems: string[] = []
  if (["rbkg", "kmin", "kweight", "ft_dk", "nfft", "kstep", "rmax_out"].some(key => recipe[key as keyof RecipeDraft] === null)) problems.push("Complete the required numeric parameters.")
  const positive = ["e0", "step", "rbkg", "autobk_dk", "ft_dk", "ft_dk2", "rmax_out"] as const
  if (Object.values(recipe).some(value => typeof value === "number" && !Number.isFinite(value))) problems.push("Enter finite parameter values.")
  if (positive.some(key => recipe[key] !== null && recipe[key]! <= 0)) problems.push("Energy, edge step, background radius, tapers and output radius must be positive.")
  if (recipe.kmin < 0 || (recipe.kmax !== null && recipe.kmax <= recipe.kmin)) problems.push("Use a nonnegative k minimum and a larger k maximum.")
  if (![0, 1, 2, 3].includes(recipe.kweight) || (recipe.nnorm !== null && ![0, 1, 2, 3].includes(recipe.nnorm))) problems.push("k-weight and normalization degree must be integers from 0 to 3.")
  if ((recipe.pre1 !== null && recipe.pre1 >= 0) || (recipe.pre2 !== null && recipe.pre2 > 0)
    || (recipe.norm1 !== null && recipe.norm1 < 0) || (recipe.norm2 !== null && recipe.norm2 <= 0)) problems.push("Pre-edge limits must lie below E₀ and post-edge limits above E₀.")
  if ((recipe.pre1 !== null && recipe.pre2 !== null && recipe.pre1 >= recipe.pre2)
    || (recipe.norm1 !== null && recipe.norm2 !== null && recipe.norm1 >= recipe.norm2)) problems.push("Each interval must end above its start.")
  if (!Number.isInteger(Math.log2(recipe.nfft)) || recipe.nfft < 128 || recipe.nfft > 262144) problems.push("FFT points must be a power of two from 128 to 262144.")
  if (recipe.kstep < 0.001 || recipe.rmax_out > Math.PI / (2 * recipe.kstep)) problems.push("Use a k step of at least 0.001 Å⁻¹ and an output radius no larger than π/(2 × k step).")
  return problems
}

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

const fields: Array<{ key: NumericKey; label: string; unit: string; help: string; step?: string; min?: number; max?: number }> = [
  { key: "e0", label: "E0", unit: "eV", min: 0, help: "Positive energy within the measured spectrum. Leave blank for Larch's automatic edge energy." },
  { key: "step", label: "Edge step", unit: "", min: 0, help: "Positive normalization scale. Leave blank for Larch's automatic edge step." },
  { key: "nnorm", label: "Normalization degree", unit: "", min: 0, max: 3, help: "Polynomial degree 0–3; leave blank for automatic selection.", step: "1" },
  { key: "pre1", label: "Pre-edge start", unit: "eV", max: 0, help: "Negative fitting offset from E₀, below the pre-edge end." },
  { key: "pre2", label: "Pre-edge end", unit: "eV", max: 0, help: "Fitting offset at or below E₀, above the pre-edge start." },
  { key: "norm1", label: "Post-edge start", unit: "eV", min: 0, help: "Nonnegative fitting offset from E₀, below the post-edge end." },
  { key: "norm2", label: "Post-edge end", unit: "eV", min: 0, help: "Positive fitting offset from E₀, above the post-edge start." },
  { key: "rbkg", label: "Rbkg", unit: "Å", min: 0, help: "Positive background-removal radius; typically about 1 Å and below the first-shell peak.", step: "0.1" },
  { key: "kmin", label: "k minimum", unit: "Å⁻¹", min: 0, help: "Nonnegative lower EXAFS fitting bound.", step: "0.1" },
  { key: "kmax", label: "k maximum", unit: "Å⁻¹", min: 0, help: "Above k minimum. Leave blank for Larch's data-bound maximum.", step: "0.1" },
  { key: "kweight", label: "Shared k-weight", unit: "", min: 0, max: 3, help: "Integer 0–3, applied to background removal and Fourier transform. Larger weights emphasize high-k oscillations and noise.", step: "1" },
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
  const problems = recipeProblems(recipe)
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
                min={field.min}
                max={field.max}
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
            <input id="recipe-autobk_dk" type="number" min="0" step="0.1" value={recipe.autobk_dk ?? ""} aria-describedby={autobkDk.describedBy} aria-invalid={autobkDk.invalid || undefined} onChange={(event) => onChange({ autobk_dk: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} />
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
            <input id="recipe-ft_dk" type="number" min="0" step="0.1" value={recipe.ft_dk} aria-describedby={ftDk.describedBy} aria-invalid={ftDk.invalid || undefined} onChange={(event) => onChange({ ft_dk: Number(event.currentTarget.value) })} />
            <FieldRecovery field="ft_dk" error={error} invalid={ftDk.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-ft_dk2">Fourier taper 2<em>Å⁻¹</em></label><SectionHelp label="Fourier taper 2" id="ft-dk2-help">Optional second Fourier taper bound.</SectionHelp></span>
            <input id="recipe-ft_dk2" type="number" min="0" step="0.1" value={recipe.ft_dk2 ?? ""} aria-describedby={ftDk2.describedBy} aria-invalid={ftDk2.invalid || undefined} onChange={(event) => onChange({ ft_dk2: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} />
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
            <input id="recipe-nfft" type="number" min="128" max="262144" step="1" value={recipe.nfft} aria-describedby={nfft.describedBy} aria-invalid={nfft.invalid || undefined} onChange={(event) => onChange({ nfft: Number(event.currentTarget.value) })} />
            <FieldRecovery field="nfft" error={error} invalid={nfft.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-kstep">k step<em>Å⁻¹</em></label><SectionHelp label="k step" id="kstep-help">Sampling step for the Fourier transform.</SectionHelp></span>
            <input id="recipe-kstep" type="number" min="0.001" step="0.01" value={recipe.kstep} aria-describedby={kstep.describedBy} aria-invalid={kstep.invalid || undefined} onChange={(event) => onChange({ kstep: Number(event.currentTarget.value) })} />
            <FieldRecovery field="kstep" error={error} invalid={kstep.invalid} />
          </div>
          <div className="recipe-field">
            <span><label htmlFor="recipe-rmax_out">Output range<em>Å</em></label><SectionHelp label="Output range" id="rmax-out-help">Maximum R written to the server-produced trace.</SectionHelp></span>
            <input id="recipe-rmax_out" type="number" min="0" max={Math.PI / (2 * recipe.kstep)} step="0.1" value={recipe.rmax_out} aria-describedby={rmaxOut.describedBy} aria-invalid={rmaxOut.invalid || undefined} onChange={(event) => onChange({ rmax_out: Number(event.currentTarget.value) })} />
            <FieldRecovery field="rmax_out" error={error} invalid={rmaxOut.invalid} />
          </div>
        </div>
      </details>
      {problems.length > 0 && <div role="alert" className="error-callout">{problems.map(problem => <span key={problem}>{problem}</span>)}</div>}
      <div className="processing-actions">
        {isPreviewing ? (
          <button type="button" onClick={() => { setBusy(false); onCancelPreview() }}>Cancel preview</button>
        ) : (
          <button data-testid="preview-button" type="button" disabled={!canPreview || busy || problems.length > 0} onClick={() => void run(onPreview)}>Preview changes</button>
        )}
        <button data-testid="apply-button" className="primary-action" type="button" disabled={!canApply || busy || problems.length > 0} onClick={() => void run(onApply)}>Apply revision</button>
      </div>
    </section>
  )
}
