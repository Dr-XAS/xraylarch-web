export type AthenaColormap =
  | "magma"
  | "viridis"
  | "plasma"
  | "inferno"
  | "cividis"
  | "coolwarm"
  | "ylgnbu"
  | "turbo"
  | "hot"
  | "greys"
  | "rainbow"

export const DEFAULT_COLORMAP: AthenaColormap = "magma"

export const ATHENA_COLORMAPS: readonly { value: AthenaColormap; label: string }[] = [
  { value: "magma", label: "Magma · black–purple–yellow" },
  { value: "viridis", label: "Viridis · purple–green–yellow" },
  { value: "plasma", label: "Plasma · purple–orange–yellow" },
  { value: "inferno", label: "Inferno · black–red–yellow" },
  { value: "cividis", label: "Cividis · blue–gold" },
  { value: "coolwarm", label: "Coolwarm · blue–red" },
  { value: "ylgnbu", label: "YlGnBu · yellow–green–blue" },
  { value: "turbo", label: "Turbo · blue–green–red" },
  { value: "hot", label: "Hot · black–red–white" },
  { value: "greys", label: "Greys · white–black" },
  { value: "rainbow", label: "Rainbow · violet–red" },
]

export function isAthenaColormap(value: unknown): value is AthenaColormap {
  return typeof value === "string" && ATHENA_COLORMAPS.some(option => option.value === value)
}

// Canonical Matplotlib colormaps: continuous maps sampled at LUT
// indices 0, 16, ..., 240, 255, plus the nine ColorBrewer YlGnBu anchors.
// Keep these stops shared by spectrum interpolation and the wavelet colorscale.
const COLOR_STOPS: Record<AthenaColormap, readonly [number, string][]> = {
  magma: [
    [0, "#000004"], [16 / 255, "#0a0822"], [32 / 255, "#1d1147"], [48 / 255, "#36106b"],
    [64 / 255, "#51127c"], [80 / 255, "#6a1c81"], [96 / 255, "#832681"], [112 / 255, "#9c2e7f"],
    [128 / 255, "#b73779"], [144 / 255, "#d0416f"], [160 / 255, "#e75263"], [176 / 255, "#f56b5c"],
    [192 / 255, "#fc8961"], [208 / 255, "#fea772"], [224 / 255, "#fec488"], [240 / 255, "#fde2a3"],
    [1, "#fcfdbf"],
  ],
  viridis: [
    [0, "#440154"], [16 / 255, "#48186a"], [32 / 255, "#472d7b"], [48 / 255, "#424086"],
    [64 / 255, "#3b528b"], [80 / 255, "#33638d"], [96 / 255, "#2c728e"], [112 / 255, "#26828e"],
    [128 / 255, "#21918c"], [144 / 255, "#1fa088"], [160 / 255, "#28ae80"], [176 / 255, "#3fbc73"],
    [192 / 255, "#5ec962"], [208 / 255, "#84d44b"], [224 / 255, "#addc30"], [240 / 255, "#d8e219"],
    [1, "#fde725"],
  ],
  plasma: [
    [0, "#0d0887"], [16 / 255, "#310597"], [32 / 255, "#4c02a1"], [48 / 255, "#6600a7"],
    [64 / 255, "#7e03a8"], [80 / 255, "#9511a1"], [96 / 255, "#aa2395"], [112 / 255, "#bc3587"],
    [128 / 255, "#cc4778"], [144 / 255, "#da5a6a"], [160 / 255, "#e66c5c"], [176 / 255, "#f0804e"],
    [192 / 255, "#f89540"], [208 / 255, "#fdac33"], [224 / 255, "#fdc527"], [240 / 255, "#f8df25"],
    [1, "#f0f921"],
  ],
  inferno: [
    [0, "#000004"], [16 / 255, "#0b0724"], [32 / 255, "#210c4a"], [48 / 255, "#3d0965"],
    [64 / 255, "#57106e"], [80 / 255, "#71196e"], [96 / 255, "#8a226a"], [112 / 255, "#a32c61"],
    [128 / 255, "#bc3754"], [144 / 255, "#d24644"], [160 / 255, "#e45a31"], [176 / 255, "#f1731d"],
    [192 / 255, "#f98e09"], [208 / 255, "#fcac11"], [224 / 255, "#f9cb35"], [240 / 255, "#f2ea69"],
    [1, "#fcffa4"],
  ],
  cividis: [
    [0, "#00224e"], [16 / 255, "#002e6a"], [32 / 255, "#1a386f"], [48 / 255, "#32436d"],
    [64 / 255, "#434e6c"], [80 / 255, "#535a6d"], [96 / 255, "#61656f"], [112 / 255, "#6f7073"],
    [128 / 255, "#7d7c78"], [144 / 255, "#8c8878"], [160 / 255, "#9b9476"], [176 / 255, "#aba072"],
    [192 / 255, "#bcae6c"], [208 / 255, "#cdbb63"], [224 / 255, "#dec958"], [240 / 255, "#f0d846"],
    [1, "#fee838"],
  ],
  coolwarm: [
    [0, "#3b4cc0"], [1 / 8, "#6282ea"], [2 / 8, "#8db0fe"], [3 / 8, "#b9d0f9"],
    [4 / 8, "#dddcdc"], [5 / 8, "#f5c4ac"], [6 / 8, "#f4987a"], [7 / 8, "#dd5f4b"],
    [1, "#b40426"],
  ],
  ylgnbu: [
    [0, "#ffffd9"], [1 / 8, "#edf8b1"], [2 / 8, "#c7e9b4"], [3 / 8, "#7fcdbb"],
    [4 / 8, "#41b6c4"], [5 / 8, "#1d91c0"], [6 / 8, "#225ea8"], [7 / 8, "#253494"],
    [1, "#081d58"],
  ],
  turbo: [
    [0, "#30123b"], [1 / 8, "#466be3"], [2 / 8, "#28bceb"], [3 / 8, "#32f298"],
    [4 / 8, "#a4fc3c"], [5 / 8, "#eecf3a"], [6 / 8, "#fb7e21"], [7 / 8, "#d02f05"],
    [1, "#7a0403"],
  ],
  hot: [
    [0, "#0b0000"], [1 / 8, "#5f0000"], [2 / 8, "#b30000"], [3 / 8, "#ff0800"],
    [4 / 8, "#ff5c00"], [5 / 8, "#ffb000"], [6 / 8, "#ffff07"], [7 / 8, "#ffff85"],
    [1, "#ffffff"],
  ],
  greys: [
    [0, "#ffffff"], [1 / 8, "#f0f0f0"], [2 / 8, "#d9d9d9"], [3 / 8, "#bdbdbd"],
    [4 / 8, "#959595"], [5 / 8, "#727272"], [6 / 8, "#515151"], [7 / 8, "#242424"],
    [1, "#000000"],
  ],
  rainbow: [
    [0, "#8000ff"], [16 / 255, "#6032fe"], [32 / 255, "#4062fa"], [48 / 255, "#208ef4"],
    [64 / 255, "#00b5eb"], [80 / 255, "#20d5e1"], [96 / 255, "#40ecd4"], [112 / 255, "#60fac5"],
    [128 / 255, "#80ffb4"], [144 / 255, "#a0faa1"], [160 / 255, "#c0eb8d"], [176 / 255, "#e0d377"],
    [192 / 255, "#ffb360"], [208 / 255, "#ff8c49"], [224 / 255, "#ff5f30"], [240 / 255, "#ff2f18"],
    [1, "#ff0000"],
  ],
}

// Avoid pale sequential-map ends for thin lines on the white spectrum canvas.
// Rainbow retains its full hue range; wavelets always use each full scale.
const SPECTRUM_RANGES: Record<AthenaColormap, readonly [number, number]> = {
  magma: [0.12, 0.68],
  viridis: [0.06, 0.59],
  plasma: [0.06, 0.64],
  inferno: [0.12, 0.67],
  cividis: [0.06, 0.62],
  coolwarm: [0, 1],
  ylgnbu: [0.58, 0.95],
  turbo: [0, 1],
  hot: [0.08, 0.72],
  greys: [0.35, 1],
  rainbow: [0, 1],
}

export function plotlyColorscale(colormap: AthenaColormap, reversed = false): [number, string][] {
  // Plotly may mutate its inputs; do not expose the shared source arrays.
  const stops = COLOR_STOPS[colormap]
  return reversed
    ? stops.map(([position, color]) => [1 - position, color] as [number, string]).reverse()
    : stops.map(([position, color]) => [position, color])
}

export function spectrumColor(colormap: AthenaColormap, index: number, count: number): string {
  const [start, end] = SPECTRUM_RANGES[colormap]
  const fraction = count <= 1 ? 0.5 : Math.max(0, Math.min(1, index / (count - 1)))
  const position = start + fraction * (end - start)
  const stops = COLOR_STOPS[colormap]
  const right = stops.findIndex(([stop]) => stop >= position)
  const [leftPosition, leftColor] = stops[Math.max(0, right - 1)]
  const [rightPosition, rightColor] = stops[right]
  const mix = rightPosition === leftPosition ? 0 : (position - leftPosition) / (rightPosition - leftPosition)
  const channels = [1, 3, 5].map(offset => {
    const left = parseInt(leftColor.slice(offset, offset + 2), 16)
    const right = parseInt(rightColor.slice(offset, offset + 2), 16)
    return Math.round(left + (right - left) * mix).toString(16).padStart(2, "0")
  })
  return `#${channels.join("")}`
}
