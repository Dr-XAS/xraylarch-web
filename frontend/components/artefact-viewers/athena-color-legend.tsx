"use client"

import { useEffect } from "react"
import { isPlotPalette, MIN_PLOT_COLOR_SPAN, normalizePlotColorRange, plotPaletteOptions, type PlotColorSettings } from "@/lib/athena-plot-colors"
import { AthenaColorLegendControl } from "./athena-color-legend-control"

export function AthenaColorLegend({ value, onChange, disabled = false, storageKey = "athena.plot-colors" }: {
  value: PlotColorSettings; onChange: (value: PlotColorSettings) => void; disabled?: boolean; storageKey?: string
}) {
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null")
      if (saved && isPlotPalette(saved.palette) && typeof saved.reversed === "boolean") {
        const vmin = typeof saved.vmin === "number" && Number.isFinite(saved.vmin) ? saved.vmin : undefined
        const vmax = typeof saved.vmax === "number" && Number.isFinite(saved.vmax) ? saved.vmax : undefined
        onChange({ palette: saved.palette, reversed: saved.reversed,
          ...(vmin !== undefined || vmax !== undefined ? normalizePlotColorRange({ vmin, vmax }) : {}) })
      }
    } catch { /* Unavailable storage should not prevent plotting. */ }
  }, [onChange, storageKey])

  function update(next: PlotColorSettings) {
    onChange(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Keep the session preference. */ }
  }

  const range = normalizePlotColorRange(value)
  const continuous = value.palette !== "classic" && value.palette !== "colorblind"
  return <AthenaColorLegendControl label="Spectrum colors" pickerLabel="Color legend" endpoints={["First", "Last"]}
    title="Click the colorbar to choose how plotted groups are colored."
    options={plotPaletteOptions(value.reversed)} value={value.palette} reversed={value.reversed} disabled={disabled}
    range={{ ...(continuous ? range : { vmin: 0, vmax: 1 }), minGap: MIN_PLOT_COLOR_SPAN,
      disabled: !continuous,
      disabledReason: disabled ? "Color range is unavailable for this plot." : undefined,
      onChange: (vmin, vmax) => update({ ...value, vmin, vmax }) }}
    onPaletteChange={palette => update({ ...value, palette })}
    onReverseChange={reversed => update({ ...value, reversed })} />
}
