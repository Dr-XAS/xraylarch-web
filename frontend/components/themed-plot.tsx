"use client"

import dynamic from "next/dynamic"
import type { ComponentProps } from "react"
import type Plotly from "react-plotly.js"
import { useTheme } from "./theme-provider"
import { plotDataForTheme, plotLayoutForTheme } from "@/lib/plot-theme"

const Plot = dynamic(() => import("react-plotly.js").then(module => module.default), {
  ssr: false, loading: () => <div className="ath-plot-loading">Loading plot…</div>,
})

// Plotly renders SVG and WebGL, so CSS variables alone cannot theme its canvas.
// Keep all interaction props, view revisions and scientific arrays unchanged.
export function ThemedPlot({ data, layout, ...props }: ComponentProps<typeof Plotly>) {
  const { theme } = useTheme()
  return <Plot {...props} data={plotDataForTheme(data, theme)} layout={plotLayoutForTheme(layout, theme)} />
}
