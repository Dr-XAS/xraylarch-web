import { colormapOptions, colorscaleGradient, isAthenaColormap, sampleColormap, type AthenaColormap } from "./athena-colormaps"

const classicColors = ["#16736b", "#c37b38", "#7470b0", "#c85a65", "#467cac", "#8e9c47", "#967055"] as const

export type PlotPalette = "classic" | AthenaColormap
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
  return value === "classic" || isAthenaColormap(value)
}

export function plotPaletteOptions(reversed = false): { value: PlotPalette; label: string; background: string }[] {
  const colors = reversed ? [...classicColors].reverse() : classicColors
  const stops = colors.flatMap((color, index): [number, string][] => [
    [index / colors.length, color], [(index + 1) / colors.length, color],
  ])
  return [
    { value: "classic", label: "Classic · categorical", background: colorscaleGradient(stops) },
    ...colormapOptions(reversed),
  ]
}

export function spectrumColors(count: number, { palette, reversed, vmin, vmax }: PlotColorSettings): string[] {
  const range = normalizePlotColorRange({ vmin, vmax })
  const start = reversed ? 1 - range.vmax : range.vmin
  const end = reversed ? 1 - range.vmin : range.vmax
  const colors = Array.from({ length: count }, (_, index) => palette === "classic"
    ? classicColors[index % classicColors.length]
    : sampleColormap(palette, start + (count === 1 ? 0.5 : index / (count - 1)) * (end - start)))
  return reversed ? colors.reverse() : colors
}
