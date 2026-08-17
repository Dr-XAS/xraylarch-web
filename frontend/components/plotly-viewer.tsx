"use client"

import dynamic from "next/dynamic"

import type { PlotTrace } from "@/lib/contracts"

const Plot = dynamic(
  () => import("react-plotly.js").then((module) => module.default),
  { ssr: false, loading: () => <p className="plot-loading">Loading scientific plot…</p> },
)

interface PlotlyViewerProps {
  trace: PlotTrace[]
  title: string
  xLabel: string
  yLabel: string
  testId: string
}

export function PlotlyViewer({ trace, title, xLabel, yLabel, testId }: PlotlyViewerProps) {
  return (
    <div className="plotly-viewer" data-testid={testId} aria-label={title}>
      <Plot
        data={trace.map((series) => ({ x: series.x, y: series.y, type: "scatter", mode: "lines", name: series.label }))}
        layout={{
          title,
          autosize: true,
          margin: { l: 60, r: 24, t: 48, b: 52 },
          paper_bgcolor: "#ffffff",
          plot_bgcolor: "#f6f8fa",
          font: { color: "#17212b" },
          xaxis: { title: xLabel, gridcolor: "#d8e0e8", zerolinecolor: "#b8c5d1" },
          yaxis: { title: yLabel, gridcolor: "#d8e0e8", zerolinecolor: "#b8c5d1" },
        }}
        config={{ displaylogo: false, responsive: true }}
        useResizeHandler
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  )
}
