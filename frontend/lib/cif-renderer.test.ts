import { afterEach, describe, expect, it, vi } from "vitest"
import type { GLViewer, ViewerSpec } from "3dmol"
import { createCifRenderer } from "./cif-renderer"

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren() })

function rendererFixture(fail = false) {
  const host = document.createElement("div")
  document.body.append(host)
  const event = vi.fn()
  const delayed = vi.fn()
  const loseContext = vi.fn()
  const instance = {
    clear: vi.fn(), stopAnimate: vi.fn(),
    divwatcher: { disconnect: vi.fn() }, intwatcher: { disconnect: vi.fn() },
    hoverTimeout: window.setTimeout(delayed, 80), longTouchTimeout: window.setTimeout(delayed, 100),
    spinInterval: window.setInterval(delayed, 100),
  }
  let canvas: (HTMLCanvasElement & { _3dmol_viewer?: GLViewer }) | undefined
  const createViewer = vi.fn((_host: HTMLDivElement, config: ViewerSpec) => {
    canvas = config.canvas!
    Object.defineProperty(canvas, "getContext", { value: vi.fn(() => ({ getExtension: () => ({ loseContext }) })) })
    canvas._3dmol_viewer = instance as unknown as GLViewer
    host.append(canvas)
    window.addEventListener("resize", event)
    document.body.addEventListener("mouseup", event)
    document.body.addEventListener("touchend", event)
    canvas.addEventListener("webglcontextlost", event)
    if (fail) throw new Error("GPU unavailable")
    return instance as unknown as GLViewer
  })
  return { host, event, delayed, loseContext, instance, canvas: () => canvas!, createViewer, module: { createViewer } as unknown as typeof import("3dmol") }
}

describe("CIF renderer lifecycle", () => {
  it("restores globals immediately and removes only this viewer's resources on disposal", () => {
    vi.useFakeTimers()
    const fixture = rendererFixture()
    const originalWindow = window.addEventListener
    const originalBody = document.body.addEventListener
    const windowDescriptor = Object.getOwnPropertyDescriptor(window, "addEventListener")
    const bodyDescriptor = Object.getOwnPropertyDescriptor(document.body, "addEventListener")
    const otherListener = vi.fn()
    window.addEventListener("resize", otherListener)
    const { viewer, dispose } = createCifRenderer(fixture.module, fixture.host)
    expect(viewer).toBe(fixture.instance)
    expect(window.addEventListener).toBe(originalWindow)
    expect(document.body.addEventListener).toBe(originalBody)
    expect(Object.getOwnPropertyDescriptor(window, "addEventListener")).toEqual(windowDescriptor)
    expect(Object.getOwnPropertyDescriptor(document.body, "addEventListener")).toEqual(bodyDescriptor)
    window.dispatchEvent(new Event("resize"))
    expect(fixture.event).toHaveBeenCalledTimes(1)
    dispose()
    dispose()
    window.dispatchEvent(new Event("resize"))
    document.body.dispatchEvent(new Event("mouseup"))
    document.body.dispatchEvent(new Event("touchend"))
    fixture.canvas().dispatchEvent(new Event("webglcontextlost"))
    vi.advanceTimersByTime(200)
    expect(fixture.event).toHaveBeenCalledTimes(1)
    expect(otherListener).toHaveBeenCalledTimes(2)
    expect(fixture.delayed).not.toHaveBeenCalled()
    expect(fixture.instance.clear).toHaveBeenCalledTimes(1)
    expect(fixture.instance.stopAnimate).toHaveBeenCalledTimes(1)
    expect(fixture.instance.divwatcher.disconnect).toHaveBeenCalledTimes(1)
    expect(fixture.instance.intwatcher.disconnect).toHaveBeenCalledTimes(1)
    expect(fixture.loseContext).toHaveBeenCalledTimes(1)
    expect(fixture.host.children).toHaveLength(0)
    expect(fixture.canvas()._3dmol_viewer).toBeUndefined()
    window.removeEventListener("resize", otherListener)
  })

  it("cleans partial construction and restores global methods even when initialization throws", () => {
    vi.useFakeTimers()
    const fixture = rendererFixture(true)
    const originalWindow = window.addEventListener
    const originalBody = document.body.addEventListener
    expect(() => createCifRenderer(fixture.module, fixture.host)).toThrow("GPU unavailable")
    expect(window.addEventListener).toBe(originalWindow)
    expect(document.body.addEventListener).toBe(originalBody)
    window.dispatchEvent(new Event("resize"))
    document.body.dispatchEvent(new Event("mouseup"))
    vi.advanceTimersByTime(200)
    expect(fixture.event).not.toHaveBeenCalled()
    expect(fixture.delayed).not.toHaveBeenCalled()
    expect(fixture.instance.clear).toHaveBeenCalledTimes(1)
    expect(fixture.loseContext).toHaveBeenCalledTimes(1)
    expect(fixture.host.children).toHaveLength(0)
  })

  it("continues disposing after a scene cleanup failure", () => {
    vi.useFakeTimers()
    const fixture = rendererFixture()
    fixture.instance.clear.mockImplementation(() => { throw new Error("lost context") })
    const { dispose } = createCifRenderer(fixture.module, fixture.host)
    expect(dispose).not.toThrow()
    expect(fixture.loseContext).toHaveBeenCalledTimes(1)
    expect(fixture.host.children).toHaveLength(0)
  })
})
