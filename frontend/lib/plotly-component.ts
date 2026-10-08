import type { Component, ComponentClass, ComponentProps } from "react"
import type Plot from "react-plotly.js"
import createPlotlyComponent from "react-plotly.js/factory"

type PlotProps = ComponentProps<typeof Plot>
type PlotlyAdapter = Component<PlotProps> & {
  handlers: Record<string, unknown>
  componentWillUnmount(): void
}

export function createRemountSafePlotlyComponent(plotly: Parameters<typeof createPlotlyComponent>[0]): ComponentClass<PlotProps> {
  const BasePlot = createPlotlyComponent(plotly) as new (props: PlotProps) => PlotlyAdapter
  return class RemountSafePlot extends BasePlot {
    componentWillUnmount() {
      super.componentWillUnmount()
      // react-plotly.js 2.6.0 purges Plotly's emitter but leaves this cache intact.
      // React can remount the same instance, so its listeners must be added again.
      this.handlers = {}
    }
  }
}
