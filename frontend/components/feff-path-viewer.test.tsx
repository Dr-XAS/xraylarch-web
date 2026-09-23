import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FeffPathViewer, type FeffPathSummary } from "./feff-path-viewer"
import { feffArrow } from "./feff-path-scene"
import { buildFeffPathGeometry } from "@/lib/feff-path-geometry"

const { createViewer } = vi.hoisted(() => ({ createViewer: vi.fn() }))
vi.mock("3dmol", () => ({ createViewer, Vector2: class { constructor(public x: number, public y: number) {} } }))
const site = (x: number, y = 0, ipot = 1) => ({ atom: "Cu", x, y, z: 0, ipot })
const paths: FeffPathSummary[] = [
  { id: "cu1", filename: "feff0001.dat", label: "Cu first shell", enabled: true,
    metadata: { absorber: "Cu", edge: "K", reff: 2.56, degen: 12, nleg: 2, kmin: 0, kmax: 15, geometry: [site(0, 0, 0), site(2.56)] } },
  { id: "cu2", filename: "feff0002.dat", label: "Cu triangle", enabled: false,
    metadata: { absorber: "Cu", edge: "K", reff: 3.4142, degen: 48, nleg: 3, kmin: 0, kmax: 15, geometry: [site(0, 0, 0), site(2), site(0, 2)] } },
]
const mockScene = () => {
  const scene = {
    clear: vi.fn(), addSphere: vi.fn(), addCylinder: vi.fn(), addArrow: vi.fn(), addLabel: vi.fn(),
    getView: vi.fn(() => [0, 0, 0, 20, 0, 0, 0, 1]), setView: vi.fn(), zoomTo: vi.fn(), zoom: vi.fn(), rotate: vi.fn(),
    render: vi.fn(), stopAnimate: vi.fn(),
    addModel: vi.fn((xyz: string) => ({ selectedAtoms: () => xyz.split("\n").slice(2).filter(Boolean).map((row, index) => {
      const [elem, ...values] = row.split(" ")
      const [x, y, z] = values.map(Number)
      return { index, elem, x, y, z, bonds: [] }
    }) })),
    setStyle: vi.fn(), addStyle: vi.fn(), setBackgroundColor: vi.fn(), setHoverDuration: vi.fn(), setHoverable: vi.fn(), removeLabel: vi.fn(),
  }
  scene.clear.mockImplementation(() => {
    scene.addSphere.mockClear(); scene.addCylinder.mockClear(); scene.addArrow.mockClear(); scene.addLabel.mockClear()
  })
  return scene
}
let scenes: ReturnType<typeof mockScene>[]
beforeEach(() => {
  scenes = []
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
  createViewer.mockReset().mockImplementation((host: HTMLElement, config: { canvas: HTMLCanvasElement }) => {
    host.append(config.canvas)
    const scene = mockScene()
    scenes.push(scene)
    return scene
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function ready() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  return scenes.at(-1)!
}

describe("FeffPathViewer", () => {
  it("toggles in-canvas legends, overlays paths with shared atoms once, and keeps excluded paths viewable", async () => {
    const openModel = vi.fn()
    render(<FeffPathViewer paths={paths} groupLabel="Copper foil" onOpenModel={openModel} />)
    const panel = screen.getByRole("region", { name: "FEFF path viewer" })
    expect(panel).toHaveTextContent("Copper foil")
    let scene = await ready()
    expect(scene.addArrow).toHaveBeenCalledTimes(2)
    expect(scene.addSphere).toHaveBeenCalledTimes(2) // N=12 is not twelve invented atoms.
    expect(panel).toHaveTextContent("Single scattering")
    fireEvent.click(screen.getByRole("button", { name: "Show feff0002.dat" }))
    scene = await ready()
    expect(scene.addArrow).toHaveBeenCalledTimes(5)
    expect(scene.addSphere).toHaveBeenCalledTimes(4)
    const legend = screen.getByRole("group", { name: "FEFF path legend" })
    expect(within(legend).getByRole("button", { name: "Show feff0001.dat" })).toHaveAttribute("aria-pressed", "true")
    expect(within(legend).getByRole("button", { name: "Show feff0002.dat" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByRole("navigation", { name: "FEFF paths" })).not.toBeInTheDocument()
    expect(new Set(scene.addArrow.mock.calls.map(([arrow]) => arrow.color)).size).toBe(2)
    fireEvent.change(screen.getByRole("combobox", { name: "Path details" }), { target: { value: "cu1" } })
    expect(screen.getByRole("heading", { name: "feff0001.dat" })).toBeVisible()
    fireEvent.change(screen.getByRole("combobox", { name: "Path details" }), { target: { value: "cu2" } })
    expect(panel).toHaveTextContent("Double scattering · triangle")
    expect(panel).toHaveTextContent("Excluded from fit")
    fireEvent.click(screen.getByText("Coordinates and scattering angles"))
    expect(within(panel).getByRole("table")).toHaveTextContent("Return")
    fireEvent.click(screen.getByRole("button", { name: "Edit paths" }))
    expect(openModel).toHaveBeenCalledOnce()
  })

  it("highlights a return leg and changes labels without recreating the renderer or resetting the camera", async () => {
    const original = structuredClone(paths)
    render(<FeffPathViewer paths={paths} onOpenModel={vi.fn()} />)
    const scene = await ready()
    scene.zoomTo.mockClear()
    scene.addArrow.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Leg 2" }))
    expect(scene.addArrow.mock.calls.map(([arrow]) => arrow.opacity)).toEqual([0.3, 1])
    expect(screen.getByText(/Leg 2: Cu 1 → Cu A/)).toHaveTextContent("return to absorber")
    fireEvent.click(screen.getByRole("checkbox", { name: "Labels" }))
    expect(scene.zoomTo).not.toHaveBeenCalled()
    expect(scene.setView).toHaveBeenCalled()
    expect(createViewer).toHaveBeenCalledOnce()
    expect(paths).toEqual(original)
  })

  it("shows only verified context from the selected path's own FEFF input", async () => {
    const enriched = structuredClone(paths[0])
    enriched.metadata.viewerCluster = { source: "feff.inp", atoms: [...structuredClone(enriched.metadata.geometry), site(-2.56)] }
    const { rerender } = render(<FeffPathViewer paths={[enriched]} onOpenModel={vi.fn()} />)
    const scene = await ready()
    expect(scene.addModel.mock.calls.at(-1)?.[0]).toMatch(/^3\n/)
    expect(scene.addSphere.mock.calls.map(([sphere]) => Number((sphere.opacity ** 2).toFixed(4))).sort()).toEqual([0.3, 1, 1])
    expect(scene.addSphere.mock.calls.every(([sphere]) => sphere.radius === 0.36 && sphere.color === "#225ea8")).toBe(true)
    expect(screen.getByRole("checkbox", { name: "Local structure" })).toBeChecked()
    fireEvent.click(screen.getByRole("checkbox", { name: "Local structure" }))
    expect(scene.addModel.mock.calls.at(-1)?.[0]).toMatch(/^2\n/)
    const mismatched = structuredClone(enriched)
    mismatched.metadata.viewerCluster!.atoms[1].x = 10
    rerender(<FeffPathViewer paths={[mismatched]} onOpenModel={vi.fn()} />)
    expect(screen.queryByRole("checkbox", { name: "Local structure" })).not.toBeInTheDocument()
    expect(screen.getByText(/These files contain path atoms only/)).toBeVisible()
  })

  it("falls back after the selected path is removed and clears when switching to an empty model", async () => {
    const { rerender } = render(<FeffPathViewer paths={paths} onOpenModel={vi.fn()} />)
    await ready()
    fireEvent.click(screen.getByRole("button", { name: "Show feff0002.dat" }))
    await ready()
    rerender(<FeffPathViewer paths={[paths[0]]} onOpenModel={vi.fn()} />)
    await ready()
    expect(screen.getByRole("button", { name: "Show feff0001.dat" })).toHaveAttribute("aria-pressed", "true")
    rerender(<FeffPathViewer paths={[]} onOpenModel={vi.fn()} />)
    expect(screen.getByRole("region", { name: "FEFF path viewer" })).toHaveTextContent("Add or generate FEFF paths")
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("reports missing geometry without creating a misleading 3D path", async () => {
    render(<FeffPathViewer paths={[{ ...paths[0], metadata: { ...paths[0].metadata, geometry: [] } }]} onOpenModel={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText("Loading 3D scattering path…")).not.toBeInTheDocument())
    const scene = scenes.at(-1)!
    expect(screen.getByText(/Expected 2 geometry entries/)).toBeVisible()
    expect(scene.addArrow).not.toHaveBeenCalled()
    expect(scene.addSphere).not.toHaveBeenCalled()
  })

  it("can hide every path while retaining translucent context and then re-enable a path", async () => {
    const enriched = structuredClone(paths[0])
    enriched.metadata.viewerCluster = { source: "feff.inp", atoms: [...structuredClone(enriched.metadata.geometry), site(-2.56)] }
    render(<FeffPathViewer paths={[enriched]} onOpenModel={vi.fn()} />)
    const scene = await ready()
    scene.zoomTo.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Show feff0001.dat" }))
    expect(scene.addArrow).not.toHaveBeenCalled()
    expect(scene.addSphere).toHaveBeenCalledTimes(3)
    expect(scene.addSphere.mock.calls.every(([sphere]) => Math.abs(sphere.opacity ** 2 - 0.3) < 1e-8)).toBe(true)
    expect(screen.getByText(/Click a FEFF legend/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Show feff0001.dat" }))
    expect(scene.addArrow).toHaveBeenCalledTimes(2)
    expect(scene.zoomTo).not.toHaveBeenCalled()
    expect(createViewer).toHaveBeenCalledOnce()
  })

  it("retains the last path's structure when its final legend is hidden", async () => {
    const enriched = structuredClone(paths[1])
    enriched.metadata.viewerCluster = { source: "feff.inp", atoms: [...structuredClone(enriched.metadata.geometry), site(-2)] }
    render(<FeffPathViewer paths={[paths[0], enriched]} onOpenModel={vi.fn()} />)
    const scene = await ready()
    fireEvent.click(screen.getByRole("button", { name: "Show feff0001.dat" }))
    fireEvent.click(screen.getByRole("button", { name: "Show feff0002.dat" }))
    expect(screen.getByRole("checkbox", { name: "Local structure" })).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Show feff0002.dat" }))
    expect(screen.getByRole("checkbox", { name: "Local structure" })).toBeChecked()
    expect(scene.addSphere).toHaveBeenCalledTimes(4)
    expect(scene.addSphere.mock.calls.every(([sphere]) => Math.abs(sphere.opacity ** 2 - 0.3) < 1e-8)).toBe(true)
  })

  it("retries WebGL failures and releases the renderer when removed", async () => {
    createViewer.mockImplementationOnce(() => { throw new Error("WebGL unavailable") })
    const { unmount } = render(<FeffPathViewer paths={paths} onOpenModel={vi.fn()} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Enable WebGL")
    fireEvent.click(screen.getByRole("button", { name: "Retry 3D viewer" }))
    const scene = await ready()
    unmount()
    expect(scene.stopAnimate).toHaveBeenCalledOnce()
  })

  it("draws outgoing and returning arrows in opposite directions on separate lanes", () => {
    const geometry = buildFeffPathGeometry(paths[0].metadata).geometry!
    const outgoing = feffArrow(geometry, 0), returning = feffArrow(geometry, 1)
    expect(outgoing.end.x).toBeGreaterThan(outgoing.start.x)
    expect(returning.end.x).toBeLessThan(returning.start.x)
    expect(outgoing.start.y).not.toBe(returning.start.y)
    expect(geometry.atoms.map(atom => atom.y)).toEqual([0, 0])
  })

  it("keeps unequal overlapping collinear legs in distinct arrow lanes", () => {
    const geometry = buildFeffPathGeometry({ ...paths[0].metadata, nleg: 5,
      geometry: [site(0, 0, 0), site(1.25), site(-1.25), site(1.25), site(3.75)] }).geometry!
    const offsets = geometry.legs.map((_, index) => feffArrow(geometry, index).start.y)
    expect(new Set(offsets).size).toBe(5)
  })
})
