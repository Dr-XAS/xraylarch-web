declare module "react-plotly.js" {
  import type { CSSProperties, ComponentType } from "react"

  const Plot: ComponentType<{
    data: Array<Record<string, unknown>>
    layout?: Record<string, unknown>
    config?: Record<string, unknown>
    useResizeHandler?: boolean
    style?: CSSProperties
  }>

  export default Plot
}
