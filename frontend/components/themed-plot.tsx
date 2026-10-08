"use client"

import dynamic from "next/dynamic"
import { useMemo, type ComponentProps } from "react"
import type Plotly from "react-plotly.js"
import { useTheme } from "./theme-provider"
import { plotDataForTheme, plotLayoutForTheme } from "@/lib/plot-theme"
import { plotDataWithTypography, plotLayoutWithTypography } from "@/lib/plot-typography"
import { loadPlotly } from "@/lib/plotly-runtime"

const Plot = dynamic(async () => {
  const [{ createRemountSafePlotlyComponent }, plotly] = await Promise.all([
    import("@/lib/plotly-component"), loadPlotly(),
  ])
  return createRemountSafePlotlyComponent(plotly)
}, {
  ssr: false, loading: () => <div className="ath-plot-loading">Loading plot…</div>,
})

// Plotly renders SVG and WebGL, so CSS variables alone cannot theme its canvas.
// Keep all interaction props, view revisions and scientific arrays unchanged.
export function ThemedPlot({ data, layout, config, ...props }: ComponentProps<typeof Plotly>) {
  const { theme } = useTheme()
  const plotConfig = useMemo(() => ({ doubleClickDelay: 300, ...config, showSendToCloud: false }), [config])
  const plotData = useMemo(() => plotDataForTheme(plotDataWithTypography(data), theme), [data, theme])
  const plotLayout = useMemo(() => plotLayoutForTheme(plotLayoutWithTypography(layout), theme), [layout, theme])
  return <Plot {...props} config={plotConfig} data={plotData} layout={plotLayout} />
}
