type PlotTheme = "light" | "dark"
type PlotObject = Record<string, unknown>

const dark = {
  canvas: "#17171c", text: "#fafafa", muted: "#a1a1aa", grid: "#313032",
  border: "#52525b", hover: "#27272a", accent: "#a78bfa",
}

function object(value: unknown): PlotObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PlotObject : {}
}

function font(value: unknown, color = dark.text) {
  return { ...object(value), color }
}

function title(value: unknown) {
  const original = typeof value === "string" ? { text: value } : object(value)
  return { ...original, font: font(original.font) }
}

function axis(value: unknown, surface = false) {
  const original = object(value)
  return {
    ...original, color: dark.muted, gridcolor: dark.grid, zerolinecolor: dark.border, linecolor: dark.border,
    tickfont: font(original.tickfont, dark.muted), title: title(original.title),
    ...(surface ? { backgroundcolor: dark.canvas, showbackground: true } : {}),
  }
}

function colorbar(value: unknown) {
  const original = object(value)
  return { ...original, tickfont: font(original.tickfont, dark.muted), title: title(original.title),
    outlinecolor: dark.border, bordercolor: dark.border, bgcolor: "rgba(0,0,0,0)" }
}

const canvasChannels = [23, 23, 28] // dark.canvas

function luminance(rgb: number[]) {
  return rgb.map(channel => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
}

function channelsForColor(color: string): number[] | null {
  if (/^#[\da-f]{6}$/i.test(color)) return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16))
  if (/^#[\da-f]{3}$/i.test(color)) return [1, 2, 3].map(index => parseInt(color[index].repeat(2), 16))
  const rgb = color.match(/^rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i)
  if (rgb) return rgb.slice(1).map(channel => Math.min(255, Number(channel)))
  const hsl = color.match(/^hsl\(\s*([\d.-]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i)
  if (!hsl) return null
  const hue = ((Number(hsl[1]) % 360) + 360) % 360 / 60
  const saturation = Math.min(1, Number(hsl[2]) / 100), lightness = Math.min(1, Number(hsl[3]) / 100)
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const secondary = chroma * (1 - Math.abs(hue % 2 - 1)), offset = lightness - chroma / 2
  const channels = hue < 1 ? [chroma, secondary, 0] : hue < 2 ? [secondary, chroma, 0]
    : hue < 3 ? [0, chroma, secondary] : hue < 4 ? [0, secondary, chroma]
      : hue < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary]
  return channels.map(channel => Math.round((channel + offset) * 255))
}

// Keep the chosen scientific palette and brighten only thin marks that would
// disappear on the dark canvas. Continuous heatmap/surface scales are untouched.
export function plotColorForTheme(value: string, theme: PlotTheme): string
export function plotColorForTheme(value: unknown, theme: PlotTheme): unknown
export function plotColorForTheme(value: unknown, theme: PlotTheme): unknown {
  if (theme === "light" || typeof value !== "string") return value
  const channels = channelsForColor(value)
  if (!channels) return value
  const background = luminance(canvasChannels)
  if ((luminance(channels) + 0.05) / (background + 0.05) >= 3.5) return value
  let adjusted = channels
  for (let step = 1; step <= 20; step++) {
    adjusted = channels.map(channel => Math.round(channel + (255 - channel) * step / 20))
    if ((luminance(adjusted) + 0.05) / (background + 0.05) >= 3.5) break
  }
  return `#${adjusted.map(channel => channel.toString(16).padStart(2, "0")).join("")}`
}

// Pale fills (highlight bands, white marker halos) exist to sit just off the
// light canvas. On the dark canvas the same job needs a faint tint above it,
// keeping only the fill's hue offset; lifting them would paint bright slabs.
function surfaceColorForTheme(value: unknown): unknown {
  if (typeof value !== "string") return value
  const channels = channelsForColor(value)
  if (!channels || luminance(channels) < 0.6) return value
  const floor = Math.min(...channels)
  return `#${channels.map((channel, index) => Math.min(255, canvasChannels[index] + 20 + channel - floor).toString(16).padStart(2, "0")).join("")}`
}

function halo(value: unknown) {
  const original = object(value)
  const pale = typeof original.color === "string" && (channelsForColor(original.color) ?? [0]).every(channel => channel >= 240)
  return pale ? { ...original, color: dark.canvas } : mark(original)
}

function mark(value: unknown) {
  const original = object(value)
  return { ...original, ...(original.color !== undefined ? { color: plotColorForTheme(original.color, "dark") } : {}) }
}

export function plotDataForTheme(data: PlotObject[], theme: PlotTheme): PlotObject[] {
  if (theme === "light") return data
  return data.map(trace => ({
    ...trace,
    ...(trace.line ? { line: mark(trace.line) } : {}),
    ...(trace.marker ? { marker: { ...mark(trace.marker),
      ...(object(trace.marker).line ? { line: halo(object(trace.marker).line) } : {}) } } : {}),
    ...(trace.textfont ? { textfont: font(trace.textfont) } : {}),
    ...(trace.colorbar ? { colorbar: colorbar(trace.colorbar) } : {}),
  }))
}

export function plotLayoutForTheme(layout: PlotObject = {}, theme: PlotTheme): PlotObject {
  if (theme === "light") return layout
  const legend = object(layout.legend), hover = object(layout.hoverlabel)
  const result: PlotObject = {
    ...layout, paper_bgcolor: dark.canvas, plot_bgcolor: dark.canvas, font: font(layout.font),
    colorway: ["#a78bfa", "#fb923c", "#5eead4", "#f472b6", "#60a5fa", "#d9e879"],
    hoverlabel: { ...hover, bgcolor: dark.hover, bordercolor: dark.border, font: font(hover.font) },
    legend: { ...legend, bgcolor: "rgba(0,0,0,0)", bordercolor: dark.grid, font: font(legend.font) },
    modebar: { ...object(layout.modebar), bgcolor: "rgba(0,0,0,0)", color: dark.muted, activecolor: dark.accent },
    xaxis: axis(layout.xaxis), yaxis: axis(layout.yaxis),
  }
  if (layout.title) result.title = title(layout.title)
  for (const [key, value] of Object.entries(layout)) {
    if (/^[xy]axis\d*$/.test(key)) result[key] = axis(value)
    if (/^scene\d*$/.test(key)) {
      const scene = object(value)
      result[key] = { ...scene, bgcolor: dark.canvas,
        xaxis: axis(scene.xaxis, true), yaxis: axis(scene.yaxis, true), zaxis: axis(scene.zaxis, true) }
    }
    if (/^coloraxis\d*$/.test(key)) result[key] = { ...object(value), colorbar: colorbar(object(value).colorbar) }
  }
  if (Array.isArray(layout.annotations)) result.annotations = layout.annotations.map(value => {
    const annotation = object(value)
    return { ...annotation, font: font(annotation.font), arrowcolor: dark.muted }
  })
  if (Array.isArray(layout.shapes)) result.shapes = layout.shapes.map(value => {
    const shape = object(value)
    return { ...shape, ...(shape.line ? { line: mark(shape.line) } : {}),
      ...(shape.fillcolor !== undefined ? { fillcolor: surfaceColorForTheme(shape.fillcolor) } : {}) }
  })
  return result
}
