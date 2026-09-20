"use client"

import dynamic from "next/dynamic"
import type { ComponentProps } from "react"
import type Plotly from "react-plotly.js"
import { useTheme } from "./theme-provider"
import { plotDataForTheme, plotLayoutForTheme } from "@/lib/plot-theme"
import { plotDataWithTypography, plotLayoutWithTypography } from "@/lib/plot-typography"
import { loadPlotly } from "@/lib/plotly-runtime"

const Plot = dynamic(async () => {
  const [{ default: createPlotlyComponent }, plotly] = await Promise.all([
    import("react-plotly.js/factory"), loadPlotly(),
  ])
  return createPlotlyComponent(plotly)
}, {
  ssr: false, loading: () => <div className="ath-plot-loading">Loading plot…</div>,
})

// Plotly renders SVG and WebGL, so CSS variables alone cannot theme its canvas.
// Keep all interaction props, view revisions and scientific arrays unchanged.
export function ThemedPlot({ data, layout, config, ...props }: ComponentProps<typeof Plotly>) {
  const { theme } = useTheme()
  return <Plot {...props}
    config={{ doubleClickDelay: 300, ...config, showSendToCloud: false }}
    data={plotDataForTheme(plotDataWithTypography(data), theme)}
    layout={plotLayoutForTheme(plotLayoutWithTypography(layout), theme)} />
}
