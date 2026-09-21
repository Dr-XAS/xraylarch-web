import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ArtemisStructure } from "@/lib/artemis-structures"
import { CifViewer } from "./cif-viewer"

const { createViewer } = vi.hoisted(() => ({ createViewer: vi.fn() }))
vi.mock("3dmol", () => ({ createViewer }))

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
  return {
    clear: vi.fn(), setBackgroundColor: vi.fn(), setHoverDuration: vi.fn(), addModel: vi.fn(),
    setStyle: vi.fn(), addStyle: vi.fn(), addLine: vi.fn(), setHoverable: vi.fn(), removeAllLabels: vi.fn(),
    addLabel: vi.fn(), zoomTo: vi.fn(), render: vi.fn(), stopAnimate: vi.fn(),
    divwatcher: { disconnect: vi.fn() }, intwatcher: { disconnect: vi.fn() },
  }
}
type Renderer = ReturnType<typeof renderer>
let renderers: Renderer[] = []
const loseContext = vi.fn()

async function ready() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  return renderers.at(-1)!
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
  it("preserves the display radius and renderer when the docked viewer is collapsed", async () => {
    render(<CifViewer structure={structure()} collapsible structureControls={<p>Saved crystal structure</p>} />)
    await ready()
    expect(screen.getAllByText("CIF structure viewer")).toHaveLength(1)
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
    expect(instance.addStyle).toHaveBeenCalledWith({ elem: "O" }, expect.objectContaining({ sphere: expect.any(Object), stick: expect.any(Object) }))

    instance.addStyle.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Show O atoms" }))
    expect(screen.getByRole("button", { name: "Show O atoms" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByText("1 atom shown")).toBeVisible()
    expect(instance.addStyle.mock.calls.map(([selection]) => selection)).toEqual([{ elem: "Cu" }])
    expect(atoms(instance)).toHaveLength(2)

    instance.addStyle.mockClear()
    fireEvent.click(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(instance.addStyle.mock.calls[0][1]).not.toHaveProperty("stick")
    fireEvent.click(screen.getByRole("checkbox", { name: "Unit cell outline" }))
    expect(instance.addLine).toHaveBeenCalledTimes(12)

    instance.addLine.mockClear()
    fireEvent.change(screen.getByRole("combobox", { name: "CIF view mode" }), { target: { value: "cell" } })
    expect(screen.getByRole("slider", { name: "CIF display radius" })).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: "Unit cell outline" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Unit cell outline" })).toBeDisabled()
    expect(instance.addLine).toHaveBeenCalledTimes(12)
    expect(createViewer).toHaveBeenCalledTimes(1)
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
