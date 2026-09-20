"use client"

import { useEffect } from "react"
import { isPlotPalette, plotPalettes, type PlotColorSettings } from "@/lib/athena-plot-colors"

const storageKey = "athena.plot-colors"

export function AthenaColorLegend({ value, onChange, disabled = false }: {
  value: PlotColorSettings; onChange: (value: PlotColorSettings) => void; disabled?: boolean
}) {
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null")
      if (saved && isPlotPalette(saved.palette) && typeof saved.reversed === "boolean") {
        onChange({ palette: saved.palette, reversed: saved.reversed })
      }
    } catch { /* Unavailable storage should not prevent plotting. */ }
  }, [onChange])

  function update(next: PlotColorSettings) {
    onChange(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Keep the session preference. */ }
  }

  const stops = [...plotPalettes[value.palette].colors]
  if (value.reversed) stops.reverse()
  const background = value.palette === "classic"
    ? `linear-gradient(to right, ${stops.map((color, index) => `${color} ${index / stops.length * 100}% ${(index + 1) / stops.length * 100}%`).join(", ")})`
    : `linear-gradient(to right, ${stops.join(", ")})`

  return <div className="ath-color-legend" role="group" aria-label="Spectrum colors" aria-disabled={disabled}>
    <label className="ath-color-select">Color legend
      <select aria-label="Color legend" value={value.palette} disabled={disabled} onChange={event => {
        if (isPlotPalette(event.target.value)) update({ ...value, palette: event.target.value })
      }}>
        {Object.entries(plotPalettes).map(([id, palette]) => <option key={id} value={id}>{palette.label}</option>)}
      </select>
    </label>
    <div className="ath-color-preview" title="Colors follow the plotted groups in data-list order.">
      <span>First</span><span className="ath-color-ramp" style={{ background }} aria-hidden="true" /><span>Last</span>
    </div>
    <label className="ath-check"><input type="checkbox" checked={value.reversed} disabled={disabled} onChange={event => update({ ...value, reversed: event.target.checked })} />Reverse</label>
  </div>
}
