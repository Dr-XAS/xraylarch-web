type PlotObject = Record<string, unknown>

// Match the application typeface with concrete values for SVG and WebGL text.
export const PLOT_FONT = {
  family: 'Figtree, "Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif',
  size: 12,
}
export const PLOT_AXIS_TITLE_FONT = { ...PLOT_FONT, size: 13 }
const PLOT_TITLE_FONT = { ...PLOT_FONT, size: 14 }

function object(value: unknown): PlotObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PlotObject : {}
}

function font(value: unknown, defaults = PLOT_FONT) {
  return { ...object(value), ...defaults }
}

function title(value: unknown, defaults = PLOT_AXIS_TITLE_FONT) {
  const original = typeof value === "string" ? { text: value } : object(value)
  return { ...original, font: font(original.font, defaults) }
}

function axis(value: unknown) {
  const original = object(value)
  return { ...original, tickfont: font(original.tickfont), title: title(original.title) }
}

function colorbar(value: unknown) {
  const original = object(value)
  return { ...original, tickfont: font(original.tickfont), title: title(original.title) }
}

function annotations(value: unknown[]) {
  return value.map(value => {
    const original = object(value)
    return { ...original, font: font(original.font) }
  })
}

// Only presentation objects are copied; scientific arrays and view state retain
// their references, ranges and revisions when typography is applied.
export function plotDataWithTypography(data: PlotObject[]): PlotObject[] {
  return data.map(trace => ({
    ...trace,
    ...(trace.textfont ? { textfont: font(trace.textfont) } : {}),
    ...(trace.colorbar ? { colorbar: colorbar(trace.colorbar) } : {}),
  }))
}

export function plotLayoutWithTypography(layout: PlotObject = {}): PlotObject {
  const legend = object(layout.legend), hover = object(layout.hoverlabel)
  const result: PlotObject = {
    ...layout, font: font(layout.font),
    legend: { ...legend, font: font(legend.font) },
    hoverlabel: { ...hover, font: font(hover.font) },
    xaxis: axis(layout.xaxis), yaxis: axis(layout.yaxis),
  }
  if (layout.title) result.title = title(layout.title, PLOT_TITLE_FONT)
  for (const [key, value] of Object.entries(layout)) {
    if (/^[xy]axis\d*$/.test(key)) result[key] = axis(value)
    if (/^scene\d*$/.test(key)) {
      const scene = object(value)
      result[key] = { ...scene,
        xaxis: axis(scene.xaxis), yaxis: axis(scene.yaxis), zaxis: axis(scene.zaxis),
        ...(Array.isArray(scene.annotations) ? { annotations: annotations(scene.annotations) } : {}),
      }
    }
    if (/^coloraxis\d*$/.test(key)) result[key] = { ...object(value), colorbar: colorbar(object(value).colorbar) }
  }
  if (Array.isArray(layout.annotations)) result.annotations = annotations(layout.annotations)
  return result
}
