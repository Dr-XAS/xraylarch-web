"use client"

import { useEffect } from "react"
import { isPlotPalette, plotPaletteOptions, type PlotColorSettings } from "@/lib/athena-plot-colors"
import { AthenaColorLegendControl } from "./athena-color-legend-control"

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

  return <AthenaColorLegendControl label="Spectrum colors" pickerLabel="Color legend" endpoints={["First", "Last"]}
    title="Click the colorbar to choose how plotted groups are colored."
    options={plotPaletteOptions(value.reversed)} value={value.palette} reversed={value.reversed} disabled={disabled}
    onPaletteChange={palette => update({ ...value, palette })}
    onReverseChange={reversed => update({ ...value, reversed })} />
}
