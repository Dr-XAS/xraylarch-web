import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ThemeProvider, useTheme } from "./theme-provider"
import { ThemedPlot } from "./themed-plot"

const plotly = vi.hoisted(() => vi.fn((_props: { data: Record<string, unknown>[]; layout?: Record<string, unknown>; config?: Record<string, unknown> }) => null))
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

it("keeps transformed inputs stable until their source or the theme changes", () => {
  const data = [{ x: [1, 2], y: [3, 4], line: { color: "#16736b" } }]
  const layout = { uirevision: "keep-zoom", xaxis: { range: [1, 2] } }
  const config = { responsive: true }
  const firstClick = vi.fn(), nextClick = vi.fn()
  const view = (onClick: typeof firstClick, plotConfig = config) =>
    <ThemeProvider><Toggle /><ThemedPlot data={data} layout={layout} config={plotConfig} onClick={onClick} /></ThemeProvider>
  const { rerender } = render(view(firstClick))
  const first = plotly.mock.calls.at(-1)![0]
  rerender(view(nextClick))
  const repeated = plotly.mock.calls.at(-1)![0]
  expect(repeated.data).toBe(first.data)
  expect(repeated.layout).toBe(first.layout)
  expect(repeated.config).toBe(first.config)

  fireEvent.click(screen.getByText("Toggle theme"))
  const dark = plotly.mock.calls.at(-1)![0]
  expect(dark.data).not.toBe(first.data)
  expect(dark.layout).not.toBe(first.layout)
  expect(dark.config).toBe(first.config)
  expect(dark.data[0].x).toBe(data[0].x)
  expect(dark.data[0].y).toBe(data[0].y)

  rerender(view(nextClick, { responsive: false }))
  const configured = plotly.mock.calls.at(-1)![0]
  expect(configured.data).toBe(dark.data)
  expect(configured.layout).toBe(dark.layout)
  expect(configured.config).not.toBe(dark.config)
  expect(configured.config?.responsive).toBe(false)
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
