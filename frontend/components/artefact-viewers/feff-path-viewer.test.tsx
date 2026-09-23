import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FeffPathViewer, type FeffPathSummary } from "./feff-path-viewer"
import { feffArrow } from "../feff-path-scene"
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
type Coordinates = [number, number, number]
// Supply a known bond graph in the few tests that inspect bond highlighting;
// chemical bond inference belongs to 3Dmol, not this component.
let perceivedBondEdges: [Coordinates, Coordinates][] = []
const coordinatesMatch = (atom: { x: number; y: number; z: number }, position: Coordinates) =>
  atom.x === position[0] && atom.y === position[1] && atom.z === position[2]
function cupritePath(id = "cuprite1", filename = "feff0001.dat", direction = 1): FeffPathSummary {
  const absorber = { atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }
  const oxygen = (x: number) => ({ atom: "O", x, y: 0, z: 0, ipot: 1 })
  return { id, filename, label: "Cuprite first shell", enabled: true,
    metadata: { absorber: "Cu", edge: "K", reff: 1.8, degen: 2, nleg: 2, kmin: 0, kmax: 15,
      geometry: [absorber, oxygen(direction * 1.8)],
      viewerCluster: { source: "feff.inp", atoms: [absorber, oxygen(1.8), oxygen(-1.8),
        { atom: "Cu", x: 0, y: 2.5, z: 0, ipot: 2 }] },
    },
  }
}
function cupriteBonds(): [Coordinates, Coordinates][] {
  return [[[0, 0, 0], [1.8, 0, 0]], [[0, 0, 0], [-1.8, 0, 0]], [[0, 0, 0], [0, 2.5, 0]]]
}
const mockScene = () => {
  const scene = {
    clear: vi.fn(), addSphere: vi.fn(), addCylinder: vi.fn(), addArrow: vi.fn(), addLabel: vi.fn(),
    getView: vi.fn(() => [0, 0, 0, 20, 0, 0, 0, 1]), setView: vi.fn(), zoomTo: vi.fn(), zoom: vi.fn(), rotate: vi.fn(),
    render: vi.fn(), stopAnimate: vi.fn(),
    addModel: vi.fn((xyz: string) => ({ selectedAtoms: () => {
      const atoms = xyz.split("\n").slice(2).filter(Boolean).map((row, index) => {
        const [elem, ...values] = row.split(" ")
        const [x, y, z] = values.map(Number)
        return { index, elem, x, y, z, bonds: [] as number[] }
      })
      for (const [left, right] of perceivedBondEdges) {
        const i = atoms.findIndex(atom => coordinatesMatch(atom, left)), j = atoms.findIndex(atom => coordinatesMatch(atom, right))
        if (i >= 0 && j >= 0) { atoms[i].bonds.push(j); atoms[j].bonds.push(i) }
      }
      return atoms
    } })),
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
  perceivedBondEdges = []
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
    const canvas = within(panel).getByRole("img", { name: /Interactive 3D scattering path/ }).parentElement
    expect(canvas).toContainElement(screen.getByRole("group", { name: "Visible FEFF elements" }))
    expect(canvas).toContainElement(screen.getByRole("checkbox", { name: "Bonds" }))
    expect(within(panel).getAllByRole("checkbox", { name: "Bonds" })).toHaveLength(1)
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
    expect(screen.getByText(/Equivalent paths were not expanded:/)).toBeVisible()
    expect(screen.getByRole("checkbox", { name: "Local structure" })).toBeChecked()
    fireEvent.click(screen.getByRole("checkbox", { name: "Local structure" }))
    expect(scene.addModel.mock.calls.at(-1)?.[0]).toMatch(/^2\n/)
    const mismatched = structuredClone(enriched)
    mismatched.metadata.viewerCluster!.atoms[1].x = 10
    rerender(<FeffPathViewer paths={[mismatched]} onOpenModel={vi.fn()} />)
    expect(screen.queryByRole("checkbox", { name: "Local structure" })).not.toBeInTheDocument()
    expect(screen.getByText(/These files contain path atoms only/)).toBeVisible()
  })

  it("replaces the representative bond with arrows while retaining the other equivalent bond", async () => {
    perceivedBondEdges = cupriteBonds()
    const path = cupritePath()
    const original = structuredClone(path)
    render(<FeffPathViewer paths={[path]} onOpenModel={vi.fn()} />)
    const scene = await ready()
    const opaqueAtoms = scene.addSphere.mock.calls.filter(([sphere]) => sphere.opacity === 1).map(([sphere]) => sphere.center)
    expect(opaqueAtoms).toHaveLength(3)
    expect(opaqueAtoms).toEqual(expect.arrayContaining([
      { x: 0, y: 0, z: 0 }, { x: 1.8, y: 0, z: 0 }, { x: -1.8, y: 0, z: 0 },
    ]))
    expect(scene.addSphere).toHaveBeenCalledTimes(4)
    const unrelated = scene.addSphere.mock.calls.find(([sphere]) => coordinatesMatch(sphere.center, [0, 2.5, 0]))![0]
    expect(unrelated.opacity ** 2).toBeCloseTo(0.3)
    expect(scene.addCylinder).toHaveBeenCalledTimes(4)
    expect(scene.addCylinder.mock.calls.filter(([bond]) => bond.opacity === 1)).toHaveLength(2)
    const equivalentHalf = scene.addCylinder.mock.calls.find(([bond]) => coordinatesMatch(bond.start, [-1.8, 0, 0]))![0]
    expect(equivalentHalf.opacity).toBe(1)
    expect(scene.addCylinder.mock.calls.some(([bond]) => bond.start.x > 0 || bond.end.x > 0)).toBe(false)
    const nonPathBond = scene.addCylinder.mock.calls.filter(([bond]) => bond.start.y > 0 || bond.end.y > 0)
    expect(nonPathBond).toHaveLength(2)
    expect(nonPathBond.every(([bond]) => Math.abs(bond.opacity ** 2 - 0.3) < 1e-8)).toBe(true)
    expect(scene.addArrow).toHaveBeenCalledTimes(2)
    expect(scene.addArrow.mock.calls.every(([arrow]) => arrow.start.x > 0 && arrow.end.x > 0)).toBe(true)
    for (const [arrow] of scene.addArrow.mock.calls) {
      expect(arrow.radius).toBe(0.065)
      expect(Math.abs(arrow.start.y)).toBeCloseTo(0.07)
      expect(Math.abs(arrow.end.y)).toBeCloseTo(0.07)
    }
    expect(screen.queryByText(/Equivalent paths were not expanded:/)).not.toBeInTheDocument()
    expect(path).toEqual(original)
  })

  it("deduplicates shared equivalents across selected paths and restores transparency after the last deselection", async () => {
    perceivedBondEdges = cupriteBonds()
    const first = cupritePath(), second = cupritePath("cuprite2", "feff0002.dat", -1)
    second.metadata.viewerCluster!.atoms.reverse() // Reordered input is still the same source cluster.
    render(<FeffPathViewer paths={[first, second]} onOpenModel={vi.fn()} />)
    const scene = await ready()
    scene.zoomTo.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Show feff0002.dat" }))
    expect(scene.addSphere).toHaveBeenCalledTimes(4)
    expect(scene.addSphere.mock.calls.filter(([sphere]) => sphere.opacity === 1)).toHaveLength(3)
    expect(scene.addCylinder).toHaveBeenCalledTimes(2)
    expect(scene.addCylinder.mock.calls.filter(([bond]) => bond.opacity === 1)).toHaveLength(0)
    expect(scene.addArrow).toHaveBeenCalledTimes(4)
    expect(new Set(scene.addArrow.mock.calls.map(([arrow]) => arrow.color)).size).toBe(2)
    expect(screen.queryByText(/recorded source is unavailable or differs/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show feff0001.dat" }))
    expect(scene.addSphere.mock.calls.filter(([sphere]) => sphere.opacity === 1)).toHaveLength(3)
    expect(scene.addCylinder.mock.calls.filter(([bond]) => bond.opacity === 1)).toHaveLength(2)
    expect(scene.addArrow).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole("button", { name: "Show feff0002.dat" }))
    expect(scene.addSphere).toHaveBeenCalledTimes(4)
    expect(scene.addSphere.mock.calls.every(([sphere]) => Math.abs(sphere.opacity ** 2 - 0.3) < 1e-8)).toBe(true)
    expect(scene.addCylinder).toHaveBeenCalledTimes(6)
    expect(scene.addCylinder.mock.calls.every(([bond]) => Math.abs(bond.opacity ** 2 - 0.3) < 1e-8)).toBe(true)
    expect(scene.addArrow).not.toHaveBeenCalled()
    expect(scene.zoomTo).not.toHaveBeenCalled()
    expect(createViewer).toHaveBeenCalledOnce()
  })

  it("does not borrow equivalent atoms from another selected path's FEFF source", async () => {
    const cu = { atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }
    const o = (x: number, y: number) => ({ atom: "O", x, y, z: 0, ipot: 1 })
    const n = (x: number, y: number) => ({ atom: "N", x, y, z: 0, ipot: 2 })
    const first: FeffPathSummary = {
      id: "first", filename: "first.dat", label: "First source", enabled: true,
      metadata: { absorber: "Cu", edge: "K", reff: 2, degen: 2, nleg: 2, kmin: 0, kmax: 15,
        geometry: [cu, o(2, 0)],
        viewerCluster: { source: "feff.inp", atoms: [cu, o(2, 0), o(-2, 0), n(2, 1), n(-2, 1)] },
      },
    }
    const second: FeffPathSummary = {
      id: "second", filename: "second.dat", label: "Second source", enabled: true,
      metadata: { absorber: "Cu", edge: "K", reff: (3 + Math.sqrt(5)) / 2, degen: 4, nleg: 3, kmin: 0, kmax: 15,
        geometry: [cu, o(2, 0), n(2, 1)],
        viewerCluster: { source: "feff.inp", atoms: [cu, o(2, 0), n(2, 1), o(0, 2), n(-1, 2)] },
      },
    }
    render(<FeffPathViewer paths={[first, second]} onOpenModel={vi.fn()} />)
    const scene = await ready()
    fireEvent.click(screen.getByRole("button", { name: "Show second.dat" }))
    expect(screen.getByText(/first.dat: Equivalent paths were not expanded: this file's recorded source/)).toBeVisible()

    fireEvent.change(screen.getByRole("combobox", { name: "Path details" }), { target: { value: "first" } })
    expect(screen.getByText(/second.dat: Equivalent paths were not expanded: this file's recorded source/)).toBeVisible()
    const unrelatedNitrogen = scene.addSphere.mock.calls.find(([sphere]) => coordinatesMatch(sphere.center, [-2, 1, 0]))?.[0]
    expect(unrelatedNitrogen).toBeDefined()
    expect(unrelatedNitrogen.opacity ** 2).toBeCloseTo(0.3)
    expect(scene.addSphere.mock.calls.find(([sphere]) => coordinatesMatch(sphere.center, [2, 1, 0]))?.[0].opacity).toBe(1)
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

  it("centers outgoing and returning arrows tightly around the bond with tips outside the atoms", () => {
    const geometry = buildFeffPathGeometry(paths[0].metadata).geometry!
    const outgoing = feffArrow(geometry, 0), returning = feffArrow(geometry, 1)
    expect(outgoing.end.x).toBeGreaterThan(outgoing.start.x)
    expect(returning.end.x).toBeLessThan(returning.start.x)
    expect(outgoing.start.y).toBeCloseTo(0.07)
    expect(returning.start.y).toBeCloseTo(-0.07)
    expect(outgoing.start.x).toBeCloseTo(0.41)
    expect(returning.end.x).toBeCloseTo(0.41)
    expect(outgoing.end.x).toBeCloseTo(2.56 - 0.41)
    expect(geometry.atoms.map(atom => atom.y)).toEqual([0, 0])
  })

  it("places unshared triangular legs directly on their bond axes", () => {
    const geometry = buildFeffPathGeometry(paths[1].metadata).geometry!
    for (const [index, leg] of geometry.legs.entries()) {
      const arrow = feffArrow(geometry, index)
      const dx = leg.to.x - leg.from.x, dy = leg.to.y - leg.from.y
      for (const endpoint of [arrow.start, arrow.end]) {
        expect((endpoint.x - leg.from.x) * dy - (endpoint.y - leg.from.y) * dx).toBeCloseTo(0)
        expect(endpoint.z).toBe(0)
      }
    }
  })

  it("keeps unequal overlapping collinear legs in distinct arrow lanes", () => {
    const geometry = buildFeffPathGeometry({ ...paths[0].metadata, nleg: 5,
      geometry: [site(0, 0, 0), site(1.25), site(-1.25), site(1.25), site(3.75)] }).geometry!
    const offsets = geometry.legs.map((_, index) => feffArrow(geometry, index).start.y)
    expect(new Set(offsets).size).toBe(5)
  })

  it("keeps long repeated paths close to the bond axis", () => {
    const geometry = buildFeffPathGeometry({ ...paths[0].metadata, nleg: 20,
      geometry: Array.from({ length: 20 }, (_, index) => index % 2 ? site(2.56) : site(0, 0, 0)) }).geometry!
    expect(geometry).toBeTruthy()
    const offsets = geometry.legs.map((_, index) => feffArrow(geometry, index).start.y)
    expect(new Set(offsets).size).toBe(20)
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(0.28)
  })
})
