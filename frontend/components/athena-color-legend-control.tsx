"use client"

import { AthenaRampPicker, type RampOption } from "./athena-ramp-picker"

/** Shared viewer UI; callers own palette semantics and persisted preferences. */
export function AthenaColorLegendControl<T extends string>({
  label, pickerLabel, endpoints, title, options, value, reversed,
  onPaletteChange, onReverseChange, disabled = false, className = "",
}: {
  label: string; pickerLabel: string; endpoints: readonly [string, string]; title: string
  options: readonly RampOption<T>[]; value: T; reversed: boolean
  onPaletteChange: (value: T) => void; onReverseChange: (reversed: boolean) => void
  disabled?: boolean; className?: string
}) {
  return <div className={`ath-color-legend ${className}`.trim()} role="group" aria-label={label} aria-disabled={disabled}>
    <div className="ath-color-preview" title={title}>
      <span>{endpoints[0]}</span>
      <AthenaRampPicker label={pickerLabel} options={options} value={value} disabled={disabled} onChange={onPaletteChange} />
      <span>{endpoints[1]}</span>
    </div>
    <label className="ath-check"><input type="checkbox" checked={reversed} disabled={disabled}
      onChange={event => onReverseChange(event.target.checked)} />Reverse</label>
  </div>
}
