import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { CifViewer } from "./cif-viewer"
import type { ArtemisStructure } from "@/lib/artemis-structures"
import type { FirstShell } from "@/lib/first-shell"
const { renderer } = vi.hoisted(() => ({ renderer: { clear: vi.fn(), setBackgroundColor: vi.fn(), setHoverDuration: vi.fn(), addModel: vi.fn(), setStyle: vi.fn(), addStyle: vi.fn(), addLine: vi.fn(), setHoverable: vi.fn(), removeAllLabels: vi.fn(), addLabel: vi.fn(), zoomTo: vi.fn(), zoom: vi.fn(), render: vi.fn() } }))
vi.mock("3dmol", () => ({}))
vi.mock("@/lib/cif-renderer", () => ({ createCifRenderer: () => ({ viewer: renderer, dispose: vi.fn() }) }))
vi.mock("@/lib/use-first-shell", () => ({ useFirstShell: () => ({ shell: null, loading: false, error: "", retry: vi.fn() }) }))
const structure: ArtemisStructure = { id: 1, mineral: "CuO", formula: "CuO", space_group: "P1", authors: "", year: null, journal: "", title: "", cif: "data_cuo", elements: ["Cu", "O"], supported: true, ordered: true, warnings: [], cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 }, sites: [
  { index: 1, element: "Cu", species: "Cu", occupancy: 1, multiplicity: 1, wyckoff: "1a", x: 0, y: 0, z: 0 },
  { index: 2, element: "O", species: "O", occupancy: 1, multiplicity: 1, wyckoff: "1a", x: 0.2, y: 0, z: 0 },
] }
const shell: FirstShell = { method: "CrystalNN", pymatgen_version: "test", cif: "data_cuo", cif_sha256: "a".repeat(64), absorber: "Cu", site_index: 1, coordination_number: 1, coordination_weight: 1, alternatives: [{ coordination_number: 1, weight: 1 }], warnings: [], neighbors: [{ element: "O", structure_index: 1, image: [0, 0, 0], fractional_offset: [0.2, 0, 0], cartesian_offset: [2, 0, 0], distance: 2, weight: 1 }] }
afterEach(() => { cleanup(); vi.clearAllMocks() })
it("shows complete shell beyond display radius, styles neighbors and respects hidden elements", async () => {
  render(<CifViewer structure={structure} selectedSite={1} analysis={{ shell, error: "", loading: false, retry: vi.fn() }} />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  expect(screen.getByText("CrystalNN first shell · CN 1")).toBeVisible()
  expect(renderer.addStyle).toHaveBeenCalledWith({ index: 1 }, { sphere: { color: "#06b6d4", radius: 0.36 } })
  fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "1" } })
  expect(screen.getByText("1 atom shown")).toBeVisible()
  fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "shell" } })
  expect(screen.getByText("2 atoms shown")).toBeVisible()
  expect(screen.queryByRole("slider", { name: "CIF display radius" })).toBeNull()
  renderer.addStyle.mockClear(); renderer.addLine.mockClear()
  fireEvent.click(screen.getByRole("button", { name: "Show O atoms" }))
  expect(renderer.addStyle).not.toHaveBeenCalledWith({ index: 1 }, expect.anything())
  expect(renderer.addLine).not.toHaveBeenCalled()
})
it("does not highlight a different center with an old shell", async () => {
  render(<CifViewer structure={structure} selectedSite={2} analysis={{ shell, error: "", loading: false, retry: vi.fn() }} />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  expect(renderer.addStyle.mock.calls.every(([selection]) => !("index" in selection))).toBe(true)
  expect(screen.queryByRole("checkbox", { name: "Highlight CrystalNN first shell" })).toBeNull()
})
it("follows an explicit absorber selection round trip after a local display edit", async () => {
  const view = render(<CifViewer structure={structure} selectedSite={1} />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  fireEvent.change(screen.getByRole("combobox", { name: "CIF center site" }), { target: { value: "2" } })
  expect(screen.getByRole("combobox", { name: "CIF center site" })).toHaveValue("2")
  view.rerender(<CifViewer structure={structure} selectedSite={2} />)
  view.rerender(<CifViewer structure={structure} selectedSite={1} />)
  expect(screen.getByRole("combobox", { name: "CIF center site" })).toHaveValue("1")
})
