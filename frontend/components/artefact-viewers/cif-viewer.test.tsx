import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ArtemisStructure } from "@/lib/artemis-structures"
import type { FirstShell } from "@/lib/first-shell"
import { CifViewer } from "./cif-viewer"

const { createViewer } = vi.hoisted(() => ({ createViewer: vi.fn() }))
vi.mock("3dmol", () => ({ createViewer }))
vi.mock("@/lib/use-first-shell", () => ({ useFirstShell: () => ({ shell: null, loading: false, error: "", retry: () => {} }) }))
vi.mock("@/lib/use-radial-shells", () => ({ useRadialShells: () => ({ data: null, loading: false, error: "", retry: () => {}, settings: { radius: 6, tolerance: 0.05 }, setSettings: () => {} }) }))

function structure(overrides: Partial<ArtemisStructure> = {}): ArtemisStructure {
  return {
    id: 1, mineral: "Copper oxide", formula: "CuO", space_group: "P 1", authors: "", year: null, journal: "", title: "",
    cif: "data_CuO\n_space_group_symop_operation_xyz 'x,y,z'", elements: ["Cu", "O"], ordered: true, supported: true, warnings: [],
    cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 },
    sites: [
      { index: 3, element: "Cu", species: "Cu", multiplicity: 1, wyckoff: "1a", x: 0, y: 0, z: 0, occupancy: 1 },
      { index: 7, element: "O", species: "O", multiplicity: 1, wyckoff: "1a", x: 0.2, y: 0, z: 0, occupancy: 1 },
    ],
    ...overrides,
  }
}

function renderer() {
  let modelAtoms: { index: number; bonds: number[]; elem?: string; x?: number; y?: number; z?: number }[] = []
  const selectedAtoms = () => modelAtoms
  return {
    clear: vi.fn(), setBackgroundColor: vi.fn(), setHoverDuration: vi.fn(), addModel: vi.fn((xyz: string) => {
      modelAtoms = xyz.split("\n").slice(2).map((line, index) => {
        const [elem, x, y, z] = line.split(" ")
        return { index, elem, x: Number(x), y: Number(y), z: Number(z), bonds: [] }
      })
      return { selectedAtoms }
    }),
    setStyle: vi.fn(), addStyle: vi.fn(), addLine: vi.fn(), addCylinder: vi.fn(), setHoverable: vi.fn(), removeAllLabels: vi.fn(),
    addLabel: vi.fn((text: string, options: unknown) => ({ text, options })), removeLabel: vi.fn(),
    addSphere: vi.fn(), addCustom: vi.fn(), removeShape: vi.fn(), getView: vi.fn(() => [0, 0, 0, 0, 0, 0, 1, 0]), setView: vi.fn(),
    getModel: vi.fn((): { selectedAtoms: typeof selectedAtoms } | undefined => ({ selectedAtoms })), targetedObjects: vi.fn(() => [] as { clickable: { index: number } }[]),
    zoomTo: vi.fn(), zoom: vi.fn(), render: vi.fn(), stopAnimate: vi.fn(),
    divwatcher: { disconnect: vi.fn() }, intwatcher: { disconnect: vi.fn() },
  }
}
type Renderer = ReturnType<typeof renderer>
let renderers: Renderer[] = []
const loseContext = vi.fn()

async function ready() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  const instance = renderers.at(-1)!
  // The structure is drawn in an effect after the render that enables the
  // button; under a loaded full run assertions landed before the first draw.
  await waitFor(() => {
    expect(instance.addModel).toHaveBeenCalled()
    expect(instance.render).toHaveBeenCalled()
  })
  return instance
}
function atoms(instance: Renderer) {
  const xyz = instance.addModel.mock.calls.at(-1)?.[0] as string
  return xyz.split("\n").slice(2).map(line => {
    const [element, ...coordinates] = line.split(" ")
    return { element, coordinates: coordinates.map(Number) }
  })
}

beforeEach(() => {
  renderers = []
  loseContext.mockReset()
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ getExtension: () => ({ loseContext }) } as unknown as WebGLRenderingContext)
  createViewer.mockReset().mockImplementation((host: HTMLElement, config: { canvas: HTMLCanvasElement }) => {
    host.appendChild(config.canvas)
    const instance = renderer()
    renderers.push(instance)
    return instance
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("CifViewer", () => {
  it("reports the hovered bond's endpoint distance, independently of the center atom", async () => {
    const attached = structure()
    attached.sites.push({ ...attached.sites[1], index: 8, element: "S", species: "S", x: 0.2, y: 0.1, z: 0.15 })
    render(<CifViewer structure={attached} />)
    const instance = await ready()
    instance.addModel.mockReturnValue({ selectedAtoms: () => [{ index: 1, bonds: [2] }, { index: 2, bonds: [1] }] })
    // Rebuild using the inferred O–S bond; neither endpoint is the center Cu.
    fireEvent.click(screen.getByRole("checkbox", { name: "Unit cell outline" }))
    expect(instance.addCylinder).toHaveBeenCalledOnce()
    const bond = instance.addCylinder.mock.calls[0][0]
    expect(bond).toMatchObject({ hoverable: true, radius: 0.08, color: "#8a8f98" })
    bond.hover_callback()
    expect(instance.addLabel).toHaveBeenLastCalledWith("O–S · 1.803 Å", expect.objectContaining({
      position: { x: expect.closeTo(2), y: expect.closeTo(0.5), z: expect.closeTo(0.75) },
    }))
    instance.removeLabel.mockClear()
    bond.unhover_callback()
    expect(instance.removeLabel).toHaveBeenCalledOnce()

    instance.setHoverable.mock.calls.at(-1)![2]({ index: 2 })
    expect(instance.addLabel.mock.calls.at(-1)![0]).toContain("S · site 8 · 2.693 Å")
    instance.addCylinder.mockClear()
    fireEvent.click(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(instance.addCylinder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Show S atoms" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(instance.addCylinder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Show S atoms" }))
    expect(instance.addCylinder).toHaveBeenCalledOnce()
    instance.setHoverable.mock.calls.at(-1)![2]({ index: 2 })
    instance.removeLabel.mockClear()
    fireEvent.mouseLeave(screen.getByRole("img", { name: /Interactive 3D crystal structure/ }))
    expect(instance.removeLabel).toHaveBeenCalledOnce()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("measures two distances and the angle at atom 2 without rebuilding or resetting the view", async () => {
    const attached = structure()
    attached.sites.push({ ...attached.sites[1], index: 8, element: "S", species: "S", x: 0.2, y: 0.1 })
    render(<CifViewer structure={attached} />)
    const instance = await ready()
    const plot = screen.getByRole("img", { name: /Interactive 3D/ })
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 } as DOMRect)
    const pick = (index: number) => {
      instance.targetedObjects.mockReturnValue([{ clickable: { index } }])
      act(() => {
        for (const type of ["pointerdown", "pointerup"]) {
          const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 100, button: 0 })
          Object.defineProperty(event, "pointerId", { value: 1 })
          plot.dispatchEvent(event)
        }
      })
    }
    pick(0)
    expect(screen.queryByRole("group", { name: "CIF measurements" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Measure" }))
    instance.clear.mockClear(); instance.zoomTo.mockClear(); instance.addModel.mockClear()
    pick(0); pick(0); pick(1)
    const results = screen.getByRole("status", { name: "Measurement results" })
    expect(results).toHaveTextContent("1–22.000 Å")
    expect(within(results).getAllByRole("listitem")).toHaveLength(2)
    const measurementLabels = instance.addLabel.mock.results.map(result => result.value)
    instance.removeLabel.mockClear()
    instance.setHoverable.mock.calls.at(-1)![2]({ index: 1 })
    fireEvent.mouseLeave(plot)
    expect(instance.removeLabel).toHaveBeenCalledOnce()
    expect(measurementLabels).not.toContain(instance.removeLabel.mock.calls[0][0])
    expect(instance.removeAllLabels).not.toHaveBeenCalled()
    pick(2)
    expect(results).toHaveTextContent("2–31.000 Å")
    expect(results).toHaveTextContent("∠1–2–390.00°")
    expect(results).toHaveTextContent("1–32.236 Å")
    expect(instance.clear).not.toHaveBeenCalled()
    expect(instance.addModel).not.toHaveBeenCalled()
    expect(instance.zoomTo).not.toHaveBeenCalled()
    pick(0)
    expect(within(results).getAllByRole("listitem")).toHaveLength(3)
    fireEvent.click(screen.getByRole("button", { name: "Undo atom" }))
    expect(within(results).getAllByRole("listitem")).toHaveLength(2)
    expect(results).not.toHaveTextContent("90.00°")
    pick(2)
    fireEvent.keyDown(plot, { key: "Escape" })
    expect(results).toBeEmptyDOMElement()
    pick(0); pick(1)
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect(results).toBeEmptyDOMElement()
    expect(screen.getByRole("button", { name: "Undo atom" })).toBeDisabled()
  })

  it("keeps periodic images distinct and clears measurements when selected atoms leave the scene", async () => {
    const attached = structure({ cell: { a: 2, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 }, sites: [structure().sites[0]] })
    const view = render(<CifViewer structure={attached} />)
    const instance = await ready()
    const plot = screen.getByRole("img", { name: /Interactive 3D/ })
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 } as DOMRect)
    const pick = (index: number) => {
      instance.targetedObjects.mockReturnValue([{ clickable: { index } }])
      act(() => {
        for (const type of ["pointerdown", "pointerup"]) {
          const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 100 })
          Object.defineProperty(event, "pointerId", { value: 1 })
          plot.dispatchEvent(event)
        }
      })
    }
    fireEvent.click(screen.getByRole("button", { name: "Measure" }))
    const results = screen.getByRole("status", { name: "Measurement results" })
    pick(1); pick(2)
    expect(results).toHaveTextContent("4.000 Å")
    expect(within(results).getAllByText("Cu · site 3")).toHaveLength(2)
    fireEvent.click(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(results).toHaveTextContent("4.000 Å")
    fireEvent.click(screen.getByRole("button", { name: "Show Cu atoms" }))
    expect(results).toBeEmptyDOMElement()
    pick(0)
    expect(instance.targetedObjects).toHaveBeenLastCalledWith(0, 0, [])
    fireEvent.click(screen.getByRole("button", { name: "Show Cu atoms" }))
    expect(results).toBeEmptyDOMElement()
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    pick(0); pick(1)
    fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "1" } })
    expect(results).toBeEmptyDOMElement()
    pick(0)
    view.rerender(<CifViewer structure={{ ...attached, cif: "data_another" }} />)
    expect(results).toBeEmptyDOMElement()
    pick(0)
    fireEvent.click(screen.getByRole("button", { name: "Measure" }))
    fireEvent.click(screen.getByRole("button", { name: "Measure" }))
    expect(screen.getByRole("status", { name: "Measurement results" })).toBeEmptyDOMElement()
  })

  it("keeps the retry UI usable if a scene redraw fails during measurement", async () => {
    render(<CifViewer structure={structure()} />)
    const instance = await ready()
    fireEvent.click(screen.getByRole("button", { name: "Measure" }))
    instance.addModel.mockImplementationOnce(() => { throw new Error("Lost context") })
    instance.getModel.mockReturnValue(undefined)
    fireEvent.click(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to render this crystal structure.")
    fireEvent.click(screen.getByRole("button", { name: "Retry 3D viewer" }))
    await waitFor(() => expect(createViewer).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Measure" })).toHaveAttribute("aria-pressed", "true")
  })

  it("calculates finite-cluster CNs and preserves results across display-only controls", async () => {
    const attached = structure()
    const original = structuredClone(attached)
    render(<CifViewer structure={attached} collapsible />)
    await ready()
    expect(screen.queryByRole("table", { name: "Cluster coordination numbers" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Coordination numbers" }))
    const table = screen.getByRole("table", { name: "Cluster coordination numbers" })
    const row = within(table).getByRole("row", { name: /Cu → O/ })
    expect(within(row).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["1", "2.000", "1.000", "1", "ViewCN 1: 1 atom"])
    expect(screen.getByText("Uses all 2 cluster atoms, including hidden elements. Neighbors outside this finite cluster are excluded.")).not.toBeVisible()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About Cluster coordination calculation" }))
    expect(screen.getByText("Uses all 2 cluster atoms, including hidden elements. Neighbors outside this finite cluster are excluded.")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Show O atoms" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(screen.getByText("1 atom shown")).toBeVisible()
    expect(table).toBeVisible()
    expect(within(row).getByText("1.000")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Coordination numbers" }))
    expect(table).not.toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Coordination numbers" }))
    fireEvent.click(screen.getByRole("button", { name: "Collapse CIF structure viewer" }))
    fireEvent.click(screen.getByRole("button", { name: "Expand CIF structure viewer" }))
    expect(table).toBeVisible()
    expect(createViewer).toHaveBeenCalledOnce()
    expect(attached).toEqual(original)
  })

  it("retains cluster results when asynchronous CrystalNN analysis completes", async () => {
    const attached = structure()
    const analysis = { shell: null, loading: true, error: "", retry: vi.fn() }
    const view = render(<CifViewer structure={attached} selectedSite={3} analysis={analysis} />)
    await ready()
    fireEvent.click(screen.getByRole("button", { name: "Coordination numbers" }))
    const table = screen.getByRole("table", { name: "Cluster coordination numbers" })
    const shell: FirstShell = {
      method: "CrystalNN", pymatgen_version: "test", cif: attached.cif, cif_sha256: "test",
      absorber: "Cu", site_index: 3, coordination_number: 1, coordination_weight: 1,
      alternatives: [], warnings: [],
      neighbors: [{ element: "O", structure_index: 1, image: [0, 0, 0], fractional_offset: [0.2, 0, 0], cartesian_offset: [2, 0, 0], distance: 2, weight: 1 }],
    }
    view.rerender(<CifViewer structure={attached} selectedSite={3} analysis={{ ...analysis, shell, loading: false }} />)
    expect(table).toBeVisible()
    expect(screen.queryByText("Cluster or settings changed. Calculate to update coordination numbers.")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Highlight CrystalNN first shell" }))
    expect(table).toBeVisible()
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "shell" } })
    expect(screen.getByText("Switch to Local cluster to calculate coordination numbers.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Calculate" })).toBeDisabled()
    expect(screen.queryByRole("table", { name: "Cluster coordination numbers" })).not.toBeInTheDocument()
  })

  it("invalidates results on cutoff, tolerance, center, radius, and structure changes", async () => {
    const view = render(<CifViewer structure={structure()} />)
    await ready()
    fireEvent.click(screen.getByRole("button", { name: "Coordination numbers" }))
    const calculate = () => fireEvent.click(screen.getByRole("button", { name: "Calculate" }))
    const expectStale = () => {
      expect(screen.queryByRole("table", { name: "Cluster coordination numbers" })).not.toBeInTheDocument()
      expect(screen.getByText("Cluster or settings changed. Calculate to update coordination numbers.")).toBeVisible()
    }
    fireEvent.change(screen.getByRole("spinbutton", { name: "CN distance cutoff" }), { target: { value: "2" } })
    expectStale()
    calculate()
    expect(screen.getAllByText("No neighbors within cutoff (CN 0)")).toHaveLength(2)
    fireEvent.change(screen.getByRole("spinbutton", { name: "CN distance cutoff" }), { target: { value: "3" } })
    calculate()
    fireEvent.change(screen.getByRole("spinbutton", { name: "CN shell tolerance" }), { target: { value: "0.05" } })
    expectStale()
    calculate()
    fireEvent.change(screen.getByRole("combobox", { name: "CIF center site" }), { target: { value: "7" } })
    expectStale()
    calculate()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "About Cluster coordination numbers" }))
    expect(screen.getByText(/Center CN refers to O · site 7/)).toBeVisible()
    fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "1" } })
    expectStale()
    calculate()
    expect(screen.getByText("1 atom · 0 coordination shells · distances < 3 Å")).toBeVisible()
    view.rerender(<CifViewer structure={structure({ mineral: "Another CIF" })} />)
    expectStale()
    calculate()
    expect(screen.getByRole("table", { name: "Cluster coordination numbers" })).toBeVisible()
  })

  it("blocks calculation for unit-cell views, incomplete previews, and disordered sites", async () => {
    const view = render(<CifViewer structure={structure()} />)
    await ready()
    fireEvent.click(screen.getByRole("button", { name: "Coordination numbers" }))
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cell" } })
    expect(screen.getByText("Switch to Local cluster to calculate coordination numbers.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Calculate" })).toBeDisabled()
    expect(screen.queryByRole("table", { name: "Cluster coordination numbers" })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cluster" } })
    view.rerender(<CifViewer structure={structure({ ordered: false })} />)
    expect(screen.getByText("Coordination numbers require fully occupied, ordered sites.")).toBeVisible()
    const partial = structure()
    partial.sites[0].occupancy = 0.5
    view.rerender(<CifViewer structure={partial} />)
    expect(screen.getByRole("button", { name: "Calculate" })).toBeDisabled()
    const dense = structure({ cell: { a: 1, b: 1, c: 1, alpha: 90, beta: 90, gamma: 90 }, sites: [structure().sites[0]] })
    view.rerender(<CifViewer structure={dense} />)
    fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "10" } })
    expect(screen.getByText("Reduce the display radius to calculate coordination numbers for a complete cluster.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Calculate" })).toBeDisabled()
  })

  it("preserves the display radius and renderer when the docked viewer is collapsed", async () => {
    render(<CifViewer structure={structure()} collapsible structureControls={<p>Saved crystal structure</p>} />)
    await ready()
    expect(screen.getByRole("button", { name: "Collapse CIF structure viewer" })).toBeVisible()
    expect(screen.getByText("Saved crystal structure")).toBeVisible()
    fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "5" } })

    fireEvent.click(screen.getByRole("button", { name: "Collapse CIF structure viewer" }))
    expect(screen.getByRole("button", { name: "Expand CIF structure viewer" })).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("slider", { name: "CIF display radius" })).not.toBeInTheDocument()
    expect(screen.getByText("Saved crystal structure")).not.toBeVisible()
    expect(createViewer).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole("button", { name: "Expand CIF structure viewer" }))
    expect(screen.getByRole("slider", { name: "CIF display radius" })).toHaveValue("5")
    expect(screen.getByText("Saved crystal structure")).toBeVisible()
    expect(createViewer).toHaveBeenCalledOnce()
  })

  it("updates radius and center geometry while retaining one renderer", async () => {
    const attached = structure()
    const original = structuredClone(attached)
    render(<CifViewer structure={attached} />)
    const instance = await ready()
    expect(atoms(instance).map(atom => atom.element)).toEqual(["Cu", "O"])
    expect(atoms(instance)[1].coordinates[0]).toBeCloseTo(2)
    expect(screen.getByText("2 atoms shown")).toBeVisible()

    fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "1" } })
    expect(atoms(instance)).toEqual([{ element: "Cu", coordinates: [0, 0, 0] }])
    expect(screen.getByText("1 atom shown")).toBeVisible()

    fireEvent.change(screen.getByRole("combobox", { name: "CIF center site" }), { target: { value: "7" } })
    expect(atoms(instance)).toEqual([{ element: "O", coordinates: [0, 0, 0] }])
    fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "3.5" } })
    expect(atoms(instance).map(atom => atom.element)).toEqual(["O", "Cu"])
    expect(atoms(instance)[1].coordinates[0]).toBeCloseTo(-2)
    expect(createViewer).toHaveBeenCalledTimes(1)
    expect(attached).toEqual(original)

    instance.zoomTo.mockClear()
    instance.render.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }))
    expect(instance.zoomTo).toHaveBeenCalledOnce()
    expect(instance.render).toHaveBeenCalledOnce()
  })

  it("updates element visibility, bonds, and unit-cell outlines without recreating the renderer", async () => {
    render(<CifViewer structure={structure()} />)
    const instance = await ready()
    const canvas = screen.getByRole("img", { name: "Interactive 3D crystal structure of Copper oxide" }).parentElement
    expect(canvas).toContainElement(screen.getByRole("group", { name: "Visible CIF elements" }))
    expect(canvas).toContainElement(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(canvas).toContainElement(screen.getByRole("checkbox", { name: "Unit cell outline" }))
    expect(screen.getAllByRole("checkbox")).toHaveLength(2)
    expect(instance.addStyle).toHaveBeenCalledWith({ elem: "O" }, { sphere: expect.any(Object) })

    instance.addStyle.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Show O atoms" }))
    expect(screen.getByRole("button", { name: "Show O atoms" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByText("1 atom shown")).toBeVisible()
    expect(instance.addStyle.mock.calls.map(([selection]) => selection)).toEqual([{ elem: "Cu" }, { index: 0 }])
    expect(screen.getByText("Center: Cu · site 3")).toBeVisible()
    expect(atoms(instance)).toHaveLength(2)

    instance.addStyle.mockClear()
    fireEvent.click(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(instance.addStyle.mock.calls[0][1]).not.toHaveProperty("stick")
    fireEvent.click(screen.getByRole("checkbox", { name: "Unit cell outline" }))
    expect(instance.addLine).toHaveBeenCalledTimes(12)

    instance.addLine.mockClear()
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cell" } })
    expect(screen.queryByRole("slider", { name: "CIF display radius" })).not.toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Unit cell repetitions" })).toBeVisible()
    expect(screen.getByRole("checkbox", { name: "Unit cell outline" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Unit cell outline" })).toBeDisabled()
    expect(instance.addLine).toHaveBeenCalledTimes(12)
    expect(createViewer).toHaveBeenCalledTimes(1)
  })

  it("expands unit cells along each lattice direction and keeps both view settings", async () => {
    const attached = structure()
    const original = structuredClone(attached)
    render(<CifViewer structure={attached} collapsible />)
    const instance = await ready()
    fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "5" } })
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cell" } })
    for (const axis of ["a", "b", "c"]) expect(screen.getByRole("spinbutton", { name: `CIF repeats along ${axis}` })).toHaveValue(1)

    instance.addLine.mockClear()
    fireEvent.change(screen.getByRole("spinbutton", { name: "CIF repeats along a" }), { target: { value: "2" } })
    expect(atoms(instance)).toHaveLength(4)
    expect(atoms(instance).map(atom => atom.coordinates[0]).sort((a, b) => a - b)).toEqual([0, expect.closeTo(2), 10, 12])
    expect(instance.addLine).toHaveBeenCalledTimes(20)
    fireEvent.change(screen.getByRole("spinbutton", { name: "CIF repeats along b" }), { target: { value: "3" } })
    expect(atoms(instance)).toHaveLength(12)
    fireEvent.change(screen.getByRole("spinbutton", { name: "CIF repeats along c" }), { target: { value: "2" } })
    expect(screen.getByText("24 atoms shown")).toBeVisible()
    expect(atoms(instance)).toHaveLength(24)

    fireEvent.click(screen.getByRole("button", { name: "Collapse CIF structure viewer" }))
    fireEvent.click(screen.getByRole("button", { name: "Expand CIF structure viewer" }))
    expect(screen.getByRole("spinbutton", { name: "CIF repeats along b" })).toHaveValue(3)
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cluster" } })
    expect(screen.getByRole("slider", { name: "CIF display radius" })).toHaveValue("5")
    expect(screen.queryByRole("group", { name: "Unit cell repetitions" })).not.toBeInTheDocument()
    expect(atoms(instance)).toHaveLength(2)
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cell" } })
    expect(screen.getByText("24 atoms shown")).toBeVisible()
    expect(createViewer).toHaveBeenCalledOnce()
    expect(attached).toEqual(original)
  })

  it("keeps unit-cell repeat values within whole-cell display limits", async () => {
    render(<CifViewer structure={structure()} />)
    await ready()
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cell" } })
    const repeat = screen.getByRole("spinbutton", { name: "CIF repeats along a" })
    fireEvent.change(repeat, { target: { value: "" } })
    expect(repeat).toHaveValue(null)
    expect(screen.getByText("2 atoms shown")).toBeVisible()
    fireEvent.change(repeat, { target: { value: "2" } })
    expect(repeat).toHaveValue(2)
    expect(screen.getByText("4 atoms shown")).toBeVisible()
    fireEvent.change(repeat, { target: { value: "2.8" } })
    fireEvent.blur(repeat)
    expect(repeat).toHaveValue(2)
    fireEvent.change(repeat, { target: { value: "100" } })
    fireEvent.blur(repeat)
    expect(repeat).toHaveValue(6)
    expect(screen.getByText("12 atoms shown")).toBeVisible()
    fireEvent.change(repeat, { target: { value: "0" } })
    fireEvent.blur(repeat)
    expect(repeat).toHaveValue(1)
    expect(screen.getByText("2 atoms shown")).toBeVisible()
  })

  it("keeps unavailable geometry readable and starts the viewer when valid geometry arrives", async () => {
    const view = render(<CifViewer structure={structure({ cell: {} })} />)
    expect(screen.getByText(/A 3D preview is unavailable/)).toBeVisible()
    expect(screen.getByText(/valid, non-degenerate unit cell/)).toBeVisible()
    expect(screen.queryByRole("slider")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reset view" })).toBeDisabled()
    expect(createViewer).not.toHaveBeenCalled()

    view.rerender(<CifViewer structure={structure()} />)
    const instance = await ready()
    expect(screen.queryByText(/A 3D preview is unavailable/)).not.toBeInTheDocument()
    expect(createViewer).toHaveBeenCalledOnce()
    view.rerender(<CifViewer structure={structure({ cell: {} })} />)
    expect(screen.getByRole("button", { name: "Reset view" })).toBeDisabled()
    expect(screen.getByText(/A 3D preview is unavailable/)).toBeVisible()
    expect(instance.divwatcher.disconnect).toHaveBeenCalledOnce()
  })

  it("allows reducing the display radius to recover from the periodic-image limit", async () => {
    render(<CifViewer structure={structure({ cell: { a: 0.1, b: 0.1, c: 0.1, alpha: 90, beta: 90, gamma: 90 } })} />)
    expect(screen.getByText(/Too many periodic images/)).toBeVisible()
    expect(createViewer).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("slider", { name: "CIF display radius" }), { target: { value: "1" } })
    const instance = await ready()
    expect(atoms(instance).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Too many periodic images/)).not.toBeInTheDocument()
    expect(createViewer).toHaveBeenCalledOnce()
  })

  it("retries a WebGL initialization failure", async () => {
    createViewer.mockImplementationOnce(() => { throw new Error("No WebGL context") })
    render(<CifViewer structure={structure()} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load the 3D viewer")
    expect(screen.getByRole("button", { name: "Reset view" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Retry 3D viewer" }))
    const instance = await ready()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(instance.addModel).toHaveBeenCalled()
    expect(createViewer).toHaveBeenCalledTimes(2)
  })

  it("releases the failed renderer and retries a rendering failure", async () => {
    const broken = renderer()
    broken.addModel.mockImplementationOnce(() => { throw new Error("Bad model") })
    createViewer.mockImplementationOnce((host: HTMLElement, config: { canvas: HTMLCanvasElement }) => {
      host.appendChild(config.canvas)
      renderers.push(broken)
      return broken
    })
    render(<CifViewer structure={structure()} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to render this crystal structure")
    fireEvent.click(screen.getByRole("button", { name: "Retry 3D viewer" }))
    const recovered = await ready()
    expect(recovered).not.toBe(broken)
    expect(recovered.addModel).toHaveBeenCalled()
    expect(broken.divwatcher.disconnect).toHaveBeenCalledOnce()
    expect(broken.intwatcher.disconnect).toHaveBeenCalledOnce()
    expect(loseContext).toHaveBeenCalledOnce()
    expect(createViewer).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("clears the canvas, observers, and WebGL context on unmount", async () => {
    const externalListener = vi.fn()
    const create = createViewer.getMockImplementation()!
    createViewer.mockImplementationOnce((host: HTMLElement, config: { canvas: HTMLCanvasElement }) => {
      window.addEventListener("resize", externalListener)
      document.body.addEventListener("mouseup", externalListener)
      return create(host, config)
    })
    const view = render(<CifViewer structure={structure()} />)
    const instance = await ready()
    const host = screen.getByRole("img", { name: "Interactive 3D crystal structure of Copper oxide" })
    expect(host.querySelector("canvas")).not.toBeNull()
    window.dispatchEvent(new Event("resize"))
    document.body.dispatchEvent(new Event("mouseup"))
    expect(externalListener).toHaveBeenCalledTimes(2)
    externalListener.mockClear()
    instance.clear.mockClear()
    view.unmount()
    expect(instance.clear).toHaveBeenCalledOnce()
    expect(instance.stopAnimate).toHaveBeenCalledOnce()
    expect(instance.divwatcher.disconnect).toHaveBeenCalledOnce()
    expect(instance.intwatcher.disconnect).toHaveBeenCalledOnce()
    expect(loseContext).toHaveBeenCalledOnce()
    expect(host).toBeEmptyDOMElement()
    window.dispatchEvent(new Event("resize"))
    document.body.dispatchEvent(new Event("mouseup"))
    expect(externalListener).not.toHaveBeenCalled()
  })

  it("does not initialize a viewer after unmounting during the dynamic import", async () => {
    const view = render(<CifViewer structure={structure()} />)
    view.unmount()
    await act(async () => { await vi.dynamicImportSettled() })
    expect(createViewer).not.toHaveBeenCalled()
  })
})
