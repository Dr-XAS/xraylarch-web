import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ThemeProvider, useTheme } from "./theme-provider"
import { ThemedPlot } from "./themed-plot"

const plotly = vi.hoisted(() => vi.fn((_props: { layout?: Record<string, unknown> }) => null))
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
  expect(plotly.mock.calls.at(-1)?.[0].layout).toBe(layout)
  fireEvent.click(screen.getByText("Toggle theme"))
  expect(plotly.mock.calls.at(-1)?.[0].layout).toMatchObject({
    paper_bgcolor: "#17171c", uirevision: "keep-zoom", xaxis: { range: [3, 12] },
  })
  fireEvent.click(screen.getByText("Toggle theme"))
  expect(plotly.mock.calls.at(-1)?.[0].layout).toBe(layout)
})
