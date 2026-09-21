import { colormapOptions, colorscaleGradient, isAthenaColormap, sampleColormap, type AthenaColormap } from "./athena-colormaps"

const classicColors = ["#16736b", "#c37b38", "#7470b0", "#c85a65", "#467cac", "#8e9c47", "#967055"] as const

export type PlotPalette = "classic" | AthenaColormap
export type PlotColorSettings = { palette: PlotPalette; reversed: boolean }
export const defaultPlotColors: PlotColorSettings = { palette: "classic", reversed: false }

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

export function spectrumColors(count: number, { palette, reversed }: PlotColorSettings): string[] {
  const colors = Array.from({ length: count }, (_, index) => palette === "classic"
    ? classicColors[index % classicColors.length]
    : sampleColormap(palette, count === 1 ? 0.5 : index / (count - 1)))
  return reversed ? colors.reverse() : colors
}
