"use client"

import { AthenaRampPicker, type RampOption, type RampRange } from "./athena-ramp-picker"
import { SectionHelp } from "../section-help"

/** Shared viewer UI; callers own palette semantics and persisted preferences. */
export function AthenaColorLegendControl<T extends string>({
  label, pickerLabel, endpoints, title, options, value, reversed,
  onPaletteChange, onReverseChange, disabled = false, className = "", range,
}: {
  label: string; pickerLabel: string; endpoints: readonly [string, string]; title: string
  options: readonly RampOption<T>[]; value: T; reversed: boolean
  onPaletteChange: (value: T) => void; onReverseChange: (reversed: boolean) => void
  disabled?: boolean; className?: string; range?: RampRange
}) {
  return <div className={`ath-color-legend ${className}`.trim()} role="group" aria-label={label} aria-disabled={disabled}>
    <div className="ath-color-preview" title={title}>
      <span>{endpoints[0]}</span>
      <AthenaRampPicker label={pickerLabel} options={options} value={value} disabled={disabled} onChange={onPaletteChange} range={range} />
      <span>{endpoints[1]}</span>
      <SectionHelp label={pickerLabel}>{title} {range ? "First and Last follow the plotted group order. Drag the two handles to use a narrower part of a continuous palette; arrow keys adjust by 1%. Classic colors do not use these range handles." : "Low and High refer to wavelet magnitude; the palette changes the display colors without changing the transform."}</SectionHelp>
    </div>
    <label className="ath-check"><input type="checkbox" aria-label="Reverse" checked={reversed} disabled={disabled}
      onChange={event => onReverseChange(event.target.checked)} />Reverse<SectionHelp label={`${label} reverse`}>Reverse the palette direction while keeping the plotted data and order unchanged.</SectionHelp></label>
  </div>
}
