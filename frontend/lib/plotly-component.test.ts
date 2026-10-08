import { EventEmitter } from "node:events"
import type { ComponentProps } from "react"
import type Plot from "react-plotly.js"
import { describe, expect, it, vi } from "vitest"

import { createRemountSafePlotlyComponent } from "./plotly-component"

type PlotProps = ComponentProps<typeof Plot>
type Graph = HTMLDivElement & {
  data?: PlotProps["data"]
  layout?: PlotProps["layout"]
  on: EventEmitter["on"]
  removeListener: EventEmitter["removeListener"]
}
type Adapter = {
  p: Promise<void>
  getRef(element: Graph): void
  componentDidMount(): void
  componentDidUpdate(previousProps: PlotProps): void
  componentWillUnmount(): void
}

describe("Plotly component lifecycle", () => {
  it("reattaches unchanged handlers after the same instance is purged and remounted", async () => {
    const events = new EventEmitter()
    const graph = Object.assign(document.createElement("div"), {
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
    })
    const plotly = {
      version: "test",
      toImage: vi.fn(async () => ""),
      react: vi.fn(async (element: Graph, figure: Pick<PlotProps, "data" | "layout">) => {
        element.data = figure.data
        element.layout = figure.layout
      }),
      purge: vi.fn(() => events.removeAllListeners()),
      Plots: { resize: vi.fn() },
    }
    const onClick = vi.fn(), onRelayout = vi.fn(), onError = vi.fn()
    const props: PlotProps = { data: [], layout: {}, onClick, onRelayout, onError }
    // Use the installed react-plotly.js factory and its real lifecycle methods.
    // Only the underlying Plotly renderer/emitter is replaced.
    const PlotComponent = createRemountSafePlotlyComponent(plotly)
    const instance = new PlotComponent(props) as unknown as Adapter
    instance.getRef(graph)
    const point = { points: [{ x: 8980 }] }

    for (let mount = 1; mount <= 3; mount++) {
      instance.componentDidMount()
      await instance.p
      // Neither the callback nor figure changes on reactivation or this update.
      instance.componentDidUpdate(props)
      await instance.p
      events.emit("plotly_click", point)
      events.emit("plotly_relayout", { "xaxis.range": [8900, 9100] })
      expect(onClick).toHaveBeenCalledTimes(mount)
      expect(onClick).toHaveBeenLastCalledWith(point)
      expect(onRelayout).toHaveBeenCalledTimes(mount)
      expect(events.listenerCount("plotly_click")).toBe(1)
      instance.componentWillUnmount()
      expect(events.eventNames()).toEqual([])
      events.emit("plotly_click", point)
      expect(onClick).toHaveBeenCalledTimes(mount)
    }
    expect(plotly.react).toHaveBeenCalledTimes(3)
    expect(plotly.purge).toHaveBeenCalledTimes(3)
    expect(onError).not.toHaveBeenCalled()
  })
})
