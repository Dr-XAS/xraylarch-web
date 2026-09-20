import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ThemeProvider, useTheme } from "./theme-provider"
import { ThemedPlot } from "./themed-plot"

const plotly = vi.hoisted(() => vi.fn((_props: { layout?: Record<string, unknown>; config?: Record<string, unknown> }) => null))
vi.mock("next/dynamic", () => ({ default: () => plotly }))

beforeEach(() => {
  localStorage.clear()
  document.documentElement.dataset.theme = "light"
  plotly.mockClear()
})
afterEach(cleanup)

function Toggle() {
  const { toggleTheme } = useTheme()
  return <button onClick={toggleTheme}>Toggle theme</button>
}

it("updates an already mounted plot when the application theme changes", () => {
  const layout = { uirevision: "keep-zoom", xaxis: { range: [3, 12] }, paper_bgcolor: "#fff" }
  render(<ThemeProvider><Toggle /><ThemedPlot data={[{ x: [1, 2], y: [3, 4] }]} layout={layout} /></ThemeProvider>)
  expect(plotly.mock.calls.at(-1)?.[0].layout).toMatchObject(layout)
  const lightLayout = plotly.mock.calls.at(-1)?.[0].layout
  fireEvent.click(screen.getByText("Toggle theme"))
  expect(plotly.mock.calls.at(-1)?.[0].layout).toMatchObject({
    paper_bgcolor: "#17171c", uirevision: "keep-zoom", xaxis: { range: [3, 12] },
  })
  fireEvent.click(screen.getByText("Toggle theme"))
  expect(plotly.mock.calls.at(-1)?.[0].layout).toEqual(lightLayout)
})

it("keeps plots local and preserves the existing double-click timing with Plotly 4", () => {
  render(<ThemedPlot data={[]} />)
  expect(plotly.mock.calls.at(-1)?.[0].config).toMatchObject({
    showSendToCloud: false, doubleClickDelay: 300,
  })
})

it("preserves plot-specific export and interaction options without enabling cloud upload", () => {
  const config = {
    responsive: true, doubleClickDelay: 450, showSendToCloud: true,
    toImageButtonOptions: { format: "svg", filename: "athena-spectrum" },
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  }
  render(<ThemedPlot data={[]} config={config} />)
  expect(plotly.mock.calls.at(-1)?.[0].config).toEqual({ ...config, showSendToCloud: false })
  expect(config.showSendToCloud).toBe(true)
})
