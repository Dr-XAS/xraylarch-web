import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ArtemisPathMetadata } from "@/lib/artemis"
import { FeffPathPreviews, FeffPathThumbnail } from "./feff-path-thumbnail"

const { createViewer } = vi.hoisted(() => ({ createViewer: vi.fn() }))
vi.mock("3dmol", () => ({ createViewer, Vector2: class { constructor(public x: number, public y: number) {} } }))
const origin = { atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }
function paths() {
  const metadata: ArtemisPathMetadata = { reff: 2.5, degen: 1, nleg: 2, absorber: "Cu", edge: "K", kmin: 0, kmax: 20,
    geometry: [origin, { atom: "Cu", x: 0, y: 0, z: 2.5, ipot: 1 }] }
  return [{ id: "a", filename: "feff0001.dat", metadata },
    { id: "b", filename: "feff0002.dat", metadata: { ...metadata, nleg: 3,
      geometry: [...metadata.geometry, { atom: "O", x: 2, y: 1, z: 0, ipot: 2 }] } }]
}
function Gallery({ items = paths() }: { items?: ReturnType<typeof paths> }) {
  return <FeffPathPreviews paths={items}>{items.map(path => <FeffPathThumbnail key={path.id} pathId={path.id} />)}</FeffPathPreviews>
}
let live = 0, peak = 0
function mockScene() {
  let view = [0, 0, 0, 20, 0, 0, 0, 1]
  let changed: ((value: number[]) => void) | null = null
  let disposed = false
  live++; peak = Math.max(peak, live)
  return { clear: vi.fn(), stopAnimate: vi.fn(() => { if (!disposed) { live--; disposed = true } }),
    addModel: vi.fn(() => ({ selectedAtoms: () => [] })), setStyle: vi.fn(), setBackgroundColor: vi.fn(),
    addSphere: vi.fn(), addCylinder: vi.fn(), addArrow: vi.fn(), addLabel: vi.fn(), removeLabel: vi.fn(),
    setHoverDuration: vi.fn(), render: vi.fn(),
    getView: vi.fn(() => view.slice()), setView: vi.fn((value: number[]) => { view = value.slice(); changed?.(view) }),
    setViewChangeCallback: vi.fn((callback: typeof changed) => { changed = callback }),
    zoomTo: vi.fn(() => { view[3] = 20 }), rotate: vi.fn(),
    pngURI: vi.fn(() => `data:image/png;base64,${btoa(JSON.stringify(view))}`),
  }
}
let scenes: ReturnType<typeof mockScene>[]
const originalShowModal = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
beforeEach(() => {
  live = 0; peak = 0; scenes = []
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", "") } })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open") } })
  createViewer.mockReset().mockImplementation((host: HTMLElement, config: { canvas: HTMLCanvasElement }) => {
    host.append(config.canvas)
    const viewer = mockScene(); scenes.push(viewer); return viewer
  })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks()
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: originalShowModal })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: originalClose })
})
async function thumbnails(count = 2) {
  await waitFor(() => expect(screen.getAllByRole("img", { name: /^FEFF path preview/ })).toHaveLength(count))
  await waitFor(() => expect(live).toBe(0))
}
async function openFirst() {
  fireEvent.click(screen.getByRole("button", { name: "Open 3D preview for feff0001.dat" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
  return scenes.at(-1)!
}

describe("FEFF summary previews", () => {
  it("renders all static thumbnails through one temporary renderer and releases it", async () => {
    render(<Gallery />)
    await thumbnails()
    expect(createViewer).toHaveBeenCalledTimes(1)
    expect(peak).toBe(1)
    expect(scenes[0].addArrow).toHaveBeenCalledTimes(5)
    expect(scenes[0].pngURI).toHaveBeenCalledTimes(2)
    expect(document.querySelectorAll("[data-feff-snapshot-host] canvas")).toHaveLength(0)
    for (const [sphere] of scenes[0].addSphere.mock.calls) {
      expect(Object.values(sphere.center).every(Number.isFinite)).toBe(true)
    }
  })

  it("remembers each path's camera, updates its PNG on close and keeps one renderer live", async () => {
    render(<Gallery />)
    await thumbnails()
    const before = screen.getByAltText("FEFF path preview for feff0001.dat").getAttribute("src")
    const scene = await openFirst()
    const custom = [1, 2, 3, 14, .1, .2, .3, .9]
    scene.setView(custom)
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await thumbnails()
    expect(screen.getByAltText("FEFF path preview for feff0001.dat")).not.toHaveAttribute("src", before)
    const reopened = await openFirst()
    expect(reopened.getView()).toEqual(custom)
    fireEvent.click(screen.getByRole("button", { name: "Close 3D preview" }))
    await thumbnails()
    fireEvent.click(screen.getByRole("button", { name: "Open 3D preview for feff0002.dat" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled())
    expect(scenes.at(-1)!.getView()).not.toEqual(custom)
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    expect(peak).toBe(1)
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }))
    await thumbnails()
  })

  it("does not carry camera or snapshots into changed geometry with the same path id", async () => {
    const items = paths()
    const view = render(<Gallery items={items} />)
    await thumbnails()
    const old = await openFirst()
    old.setView([1, 2, 3, 8, 0, 0, 1, 0])
    const changed = structuredClone(items)
    changed[0].metadata.geometry[1].z = 3
    view.rerender(<Gallery items={changed} />)
    await thumbnails()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    const fresh = await openFirst()
    expect(fresh.getView()).not.toEqual([1, 2, 3, 8, 0, 0, 1, 0])
    expect(peak).toBe(1)
  })

  it("cancels unfinished imports and disposes failed preview renderers", async () => {
    const first = render(<Gallery />)
    first.unmount()
    await act(async () => { await Promise.resolve() })
    expect(live).toBe(0)
    createViewer.mockImplementationOnce((host: HTMLElement, config: { canvas: HTMLCanvasElement }) => {
      host.append(config.canvas)
      const scene = mockScene(); scenes.push(scene)
      scene.pngURI.mockImplementation(() => { throw new Error("lost context") })
      return scene
    })
    render(<Gallery />)
    await waitFor(() => expect(screen.getAllByText("3D preview unavailable")).toHaveLength(2))
    await waitFor(() => expect(live).toBe(0))
    const interactive = await openFirst()
    expect(interactive.render).toHaveBeenCalled()
    cleanup()
    expect(live).toBe(0)
  })
})
