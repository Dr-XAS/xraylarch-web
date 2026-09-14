// Gradient stops sampled uniformly from Matplotlib's named colormaps.
export const plotPalettes = {
  classic: { label: "Classic · categorical", colors: ["#16736b", "#c37b38", "#7470b0", "#c85a65", "#467cac", "#8e9c47", "#967055"] },
  viridis: { label: "Viridis · purple–green–yellow", colors: ["#440154", "#472d7b", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"] },
  plasma: { label: "Plasma · purple–orange–yellow", colors: ["#0d0887", "#4c02a1", "#7e03a8", "#aa2395", "#cc4778", "#e66c5c", "#f89540", "#fdc527", "#f0f921"] },
  inferno: { label: "Inferno · dark–red–yellow", colors: ["#000004", "#210c4a", "#57106e", "#8a226a", "#bc3754", "#e45a31", "#f98e09", "#f9cb35", "#fcffa4"] },
  cividis: { label: "Cividis · blue–gold", colors: ["#00224e", "#1a386f", "#434e6c", "#61656f", "#7d7c78", "#9b9476", "#bcae6c", "#dec958", "#fee838"] },
  coolwarm: { label: "Coolwarm · blue–red", colors: ["#3b4cc0", "#6282ea", "#8db0fe", "#b9d0f9", "#dddcdc", "#f5c4ac", "#f4987a", "#dd5f4b", "#b40426"] },
} as const

export type PlotPalette = keyof typeof plotPalettes
export type PlotColorSettings = { palette: PlotPalette; reversed: boolean }
export const defaultPlotColors: PlotColorSettings = { palette: "classic", reversed: false }

export function isPlotPalette(value: unknown): value is PlotPalette {
  return typeof value === "string" && Object.hasOwn(plotPalettes, value)
}

export function spectrumColors(count: number, { palette, reversed }: PlotColorSettings): string[] {
  const stops = plotPalettes[palette].colors
  const colors = Array.from({ length: count }, (_, index) => {
    if (palette === "classic") return stops[index % stops.length]
    const position = (count === 1 ? 0.5 : index / (count - 1)) * (stops.length - 1)
    const left = Math.floor(position), right = Math.min(left + 1, stops.length - 1)
    const fraction = position - left
    return "#" + [1, 3, 5].map(channel => {
      const start = parseInt(stops[left].slice(channel, channel + 2), 16)
      const end = parseInt(stops[right].slice(channel, channel + 2), 16)
      return Math.round(start + (end - start) * fraction).toString(16).padStart(2, "0")
    }).join("")
  })
  return reversed ? colors.reverse() : colors
}
