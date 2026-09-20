// Keep Plotly browser-only and lazy. Both rendering and image export resolve
// this same bundle; react-plotly.js's default entry loads a separate bundle.
export async function loadPlotly() {
  return (await import("plotly.js-dist-min")).default
}
