import { afterEach, describe, expect, it, vi } from "vitest"
import type { GLViewer } from "3dmol"
import { bindCifAtomPicking, measurementAngle, measurementDistance } from "./cif-measurement"
import { cartesian, latticeVectors } from "./cif-viewer"

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it("measures displayed Cartesian geometry, including an oblique cell and degenerate angles", () => {
  const lattice = latticeVectors({ a: 4, b: 4, c: 6, alpha: 90, beta: 90, gamma: 60 })!
  const point = (v: number[]) => ({ x: v[0], y: v[1], z: v[2] })
  const origin = point([0, 0, 0])
  const a = point(cartesian([1, 0, 0], lattice))
  const b = point(cartesian([0, 1, 0], lattice))
  expect(measurementDistance(a, b)).toBeCloseTo(4, 10)
  expect(measurementAngle(a, origin, b)).toBeCloseTo(60, 10)
  expect(measurementAngle(a, origin, point([-4, 0, 0]))).toBe(180)
  expect(measurementAngle(a, origin, point([8, 0, 0]))).toBe(0)
  expect(measurementAngle(origin, origin, b)).toBeNull()
})

function fixture() {
  const host = document.createElement("div")
  const canvas = document.createElement("canvas")
  host.append(canvas)
  document.body.append(host)
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, right: 210, bottom: 220, width: 200, height: 200 } as DOMRect)
  const atom = { index: 7, x: 1, y: 2, z: 3 }
  const view = [1, 2, 3, 4, 5, 6, 7, 8]
  const viewer = { getView: vi.fn(() => view), setView: vi.fn(), targetedObjects: vi.fn(() => [{ clickable: atom }]) }
  const onPick = vi.fn()
  const dispose = bindCifAtomPicking(host, viewer as unknown as GLViewer, [atom], onPick)
  const pointer = (type: string, x = 110, y = 120, id = 1, target: EventTarget = canvas, options: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...options })
    Object.defineProperty(event, "pointerId", { value: id })
    target.dispatchEvent(event)
  }
  return { host, canvas, viewer, view, onPick, dispose, pointer, atom }
}

describe("CIF atom picking gestures", () => {
  it("picks once for a click or small jitter and restores the pre-gesture camera", () => {
    const f = fixture()
    try {
      f.pointer("pointerdown")
      f.pointer("pointerup")
      f.canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
      f.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      expect(f.onPick.mock.calls).toEqual([[7]])
      expect(f.viewer.targetedObjects).toHaveBeenLastCalledWith(0, 0, [f.atom])
      f.pointer("pointerdown")
      f.pointer("pointermove", 113)
      f.pointer("pointerup", 113)
      expect(f.onPick.mock.calls).toEqual([[7], [7]])
      expect(f.viewer.setView).toHaveBeenLastCalledWith(f.view)
      f.viewer.targetedObjects.mockReturnValue([])
      f.pointer("pointerdown"); f.pointer("pointerup")
      expect(f.onPick).toHaveBeenCalledTimes(2)
    } finally { f.dispose() }
  })

  it("rejects a drag even after returning to its start, right clicks, modifier clicks, and cancelled gestures", () => {
    const f = fixture()
    try {
      f.pointer("pointerdown"); f.pointer("pointermove", 150); f.pointer("pointermove"); f.pointer("pointerup")
      f.pointer("pointerdown", 110, 120, 1, f.canvas, { button: 2 }); f.pointer("pointerup")
      f.pointer("pointerdown", 110, 120, 1, f.canvas, { shiftKey: true }); f.pointer("pointerup")
      f.pointer("pointerdown"); f.pointer("pointercancel"); f.pointer("pointerup")
      f.pointer("pointerdown"); f.host.dispatchEvent(new Event("pointerleave")); f.pointer("pointerup")
      f.pointer("pointerdown"); f.pointer("pointerup", 110, 120, 1, document.body)
      f.pointer("pointerdown"); f.pointer("pointerup", 500, 500)
      f.pointer("pointerdown"); f.host.dispatchEvent(new Event("wheel")); f.pointer("pointerup")
      f.pointer("pointerdown"); window.dispatchEvent(new Event("blur")); f.pointer("pointerup")
      expect(f.onPick).not.toHaveBeenCalled()
      expect(f.viewer.setView).not.toHaveBeenCalled()
      f.pointer("pointerdown"); f.pointer("pointerup")
      expect(f.onPick).toHaveBeenCalledOnce()
    } finally { f.dispose() }
  })

  it("cancels a pinch until all fingers lift and removes listeners on disposal", () => {
    const f = fixture()
    f.pointer("pointerdown")
    f.pointer("pointerdown", 130, 120, 2)
    f.pointer("pointerup", 130, 120, 2)
    f.pointer("pointerup")
    expect(f.onPick).not.toHaveBeenCalled()
    f.pointer("pointerdown"); f.pointer("pointerup")
    expect(f.onPick).toHaveBeenCalledOnce()
    f.dispose()
    f.pointer("pointerdown"); f.pointer("pointerup")
    expect(f.onPick).toHaveBeenCalledOnce()
  })
})
