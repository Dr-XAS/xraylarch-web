declare module "react-plotly.js" {
  import type { CSSProperties, ComponentType } from "react"

  const Plot: ComponentType<{
    data: Array<Record<string, unknown>>
    layout?: Record<string, unknown>
    config?: Record<string, unknown>
    useResizeHandler?: boolean
    style?: CSSProperties
    onClick?: (event: { points?: Array<{ x?: unknown; y?: unknown }> }) => void
    onRelayout?: (event: Record<string, unknown>) => void
    onInitialized?: () => void
    onError?: (error: Error) => void
  }>

  export default Plot
}

declare module "react-plotly.js/factory" {
  function createPlotlyComponent(
    plotly: typeof import("plotly.js-dist-min").default,
  ): typeof import("react-plotly.js").default
  export default createPlotlyComponent
}
