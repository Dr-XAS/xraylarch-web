import { colormapOptions, colorscaleGradient, isAthenaColormap, sampleColormap, type AthenaColormap } from "./athena-colormaps"

const classicColors = ["#16736b", "#c37b38", "#7470b0", "#c85a65", "#467cac", "#8e9c47", "#967055"] as const

// Okabe and Ito, Color Universal Design: https://jfly.uni-koeln.de/color/#pallet
const colorblindColors = ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#d55e00", "#56b4e9", "#000000"] as const
const categoricalColors = { classic: classicColors, colorblind: colorblindColors } as const

export type PlotPalette = keyof typeof categoricalColors | AthenaColormap
export type PlotColorSettings = { palette: PlotPalette; reversed: boolean; vmin?: number; vmax?: number }
export const defaultPlotColors: PlotColorSettings = { palette: "classic", reversed: false }
export const MIN_PLOT_COLOR_SPAN = 0.02

/** Bounds refer to positions on the visible ramp, even when it is reversed. */
export function normalizePlotColorRange({ vmin, vmax }: Pick<PlotColorSettings, "vmin" | "vmax">): { vmin: number; vmax: number } {
  const clamp = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
  const lower = clamp(vmin, 0)
  const upper = clamp(vmax, 1)
  if (upper - lower >= MIN_PLOT_COLOR_SPAN) return { vmin: lower, vmax: upper }
  if (lower > 1 - MIN_PLOT_COLOR_SPAN) return { vmin: 1 - MIN_PLOT_COLOR_SPAN, vmax: 1 }
  return { vmin: lower, vmax: lower + MIN_PLOT_COLOR_SPAN }
}

export function isPlotPalette(value: unknown): value is PlotPalette {
  return value === "classic" || value === "colorblind" || isAthenaColormap(value)
}

export function plotPaletteOptions(reversed = false): { value: PlotPalette; label: string; background: string }[] {
  const categorical = Object.entries(categoricalColors).map(([value, palette]) => {
    const colors = reversed ? [...palette].reverse() : palette
    const stops = colors.flatMap((color, index): [number, string][] => [
      [index / colors.length, color], [(index + 1) / colors.length, color],
    ])
    return { value: value as PlotPalette, label: value === "classic" ? "Classic · categorical" : "Colorblind · Okabe–Ito", background: colorscaleGradient(stops) }
  })
  return [...categorical, ...colormapOptions(reversed)]
}

export function spectrumColors(count: number, { palette, reversed, vmin, vmax }: PlotColorSettings): string[] {
  const range = normalizePlotColorRange({ vmin, vmax })
  const start = reversed ? 1 - range.vmax : range.vmin
  const end = reversed ? 1 - range.vmin : range.vmax
  const colors = Array.from({ length: count }, (_, index) => palette === "classic" || palette === "colorblind"
    ? categoricalColors[palette][index % categoricalColors[palette].length]
    : sampleColormap(palette, start + (count === 1 ? 0.5 : index / (count - 1)) * (end - start)))
  return reversed ? colors.reverse() : colors
}
