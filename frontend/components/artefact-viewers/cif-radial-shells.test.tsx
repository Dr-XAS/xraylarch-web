import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { CifViewer } from "./cif-viewer"
import { radialFixture, radialStructure } from "@/tests/fixtures/radial-shells"
const { renderer } = vi.hoisted(() => ({ renderer: { clear: vi.fn(), setBackgroundColor: vi.fn(), setHoverDuration: vi.fn(), addModel: vi.fn(), setStyle: vi.fn(), addStyle: vi.fn(), addLine: vi.fn(), setHoverable: vi.fn(), removeAllLabels: vi.fn(), addLabel: vi.fn(), zoomTo: vi.fn(), zoom: vi.fn(), render: vi.fn() } }))
vi.mock("3dmol", () => ({}))
vi.mock("@/lib/cif-renderer", () => ({ createCifRenderer: () => ({ viewer: renderer, dispose: vi.fn() }) }))
vi.mock("@/lib/use-first-shell", () => ({ useFirstShell: () => ({ shell: null, loading: false, error: "", retry: vi.fn() }) }))
vi.mock("@/lib/use-radial-shells", () => ({ useRadialShells: () => ({ data: null, loading: false, error: "", retry: vi.fn(), settings: { radius: 6, tolerance: 0.05 }, setSettings: vi.fn() }) }))
const state = { contextKey: "fixture-site-1", data: radialFixture, error: "", loading: false, retry: vi.fn(), settings: { radius: 6, tolerance: 0.05 }, setSettings: vi.fn() }
afterEach(() => { cleanup(); vi.clearAllMocks() })

it("renders selected complete shells independently of cluster radius with stable colors and hover indices", async () => {
  render(<CifViewer structure={radialStructure} selectedSite={1} radialAnalysis={state} />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "1" } })
  fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "radial" } })
  expect(screen.getByText("5 atoms shown")).toBeVisible()
  expect(screen.getByRole("table", { name: "Radial shell distances" })).toHaveTextContent("2.000–2.000")
  expect(renderer.addStyle).toHaveBeenCalledWith({ index: 3 }, { sphere: { color: "#a78bfa", radius: 0.36 } })
  renderer.addStyle.mockClear()
  fireEvent.click(screen.getByRole("checkbox", { name: "Show shell 1" }))
  expect(screen.getByText("3 atoms shown")).toBeVisible()
  expect(renderer.addStyle).toHaveBeenCalledWith({ index: 1 }, { sphere: { color: "#a78bfa", radius: 0.36 } })
  const hover = renderer.setHoverable.mock.calls.at(-1)![2]
  hover({ index: 1 })
  expect(renderer.addLabel.mock.calls.at(-1)![0]).toContain("Shell 2 · pair 2.1")
  fireEvent.click(screen.getByRole("checkbox", { name: "Show shell 2" }))
  expect(screen.getByText("1 atom shown")).toBeVisible()
  fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cluster" } })
  expect(screen.getByRole("slider", { name: "CIF display radius" })).toHaveValue("1")
})

it("clears old center membership and validates settings without changing FEFF or FT parameters", async () => {
  const view = render(<CifViewer structure={radialStructure} selectedSite={1} radialAnalysis={state} />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "radial" } })
  fireEvent.change(screen.getByRole("spinbutton", { name: "Shell search radius" }), { target: { value: "20" } })
  fireEvent.click(screen.getByRole("button", { name: "Apply shell settings" }))
  expect(screen.getByRole("alert")).toHaveTextContent("0.5–12")
  expect(state.setSettings).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole("spinbutton", { name: "Shell search radius" }), { target: { value: "8" } })
  fireEvent.click(screen.getByRole("button", { name: "Apply shell settings" }))
  expect(state.setSettings).toHaveBeenCalledExactlyOnceWith({ radius: 8, tolerance: 0.05 })
  view.rerender(<CifViewer structure={radialStructure} selectedSite={2} radialAnalysis={state} />)
  expect(screen.queryByRole("table", { name: "Radial shell distances" })).toBeNull()
})
