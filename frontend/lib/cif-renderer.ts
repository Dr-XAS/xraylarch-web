import type { GLViewer } from "3dmol"

type Listener = EventListenerOrEventListenerObject | null
type RegisteredListener = { target: EventTarget; type: string; listener: Listener; options?: boolean | AddEventListenerOptions }
type RendererResources = {
  divwatcher?: Pick<ResizeObserver, "disconnect">
  intwatcher?: Pick<IntersectionObserver, "disconnect">
  hoverTimeout?: number
  longTouchTimeout?: number
  spinInterval?: number
}
type ViewerCanvas = HTMLCanvasElement & { _3dmol_viewer?: GLViewer }

/** Own the otherwise undisposable global listeners installed by 3Dmol 2.5. */
export function createCifRenderer(mol: typeof import("3dmol"), host: HTMLDivElement): { viewer: GLViewer; dispose: () => void } {
  // Supplying our own canvas also makes early construction failures cleanable.
  const canvas: ViewerCanvas = document.createElement("canvas")
  const listeners: RegisteredListener[] = []
  const restore: (() => void)[] = []
  let viewer: GLViewer | undefined
  let disposed = false
  const safely = (action: () => void) => { try { action() } catch { /* Continue releasing the remaining resources. */ } }
  const dispose = () => {
    if (disposed) return
    disposed = true
    // Remove context-loss callbacks before deliberately releasing our context.
    for (const { target, type, listener, options } of listeners) safely(() => target.removeEventListener(type, listener, options))
    listeners.length = 0
    const instance = viewer ?? canvas._3dmol_viewer
    if (instance) {
      const resources = instance as unknown as RendererResources
      safely(() => resources.divwatcher?.disconnect())
      safely(() => resources.intwatcher?.disconnect())
      window.clearTimeout(resources.hoverTimeout)
      window.clearTimeout(resources.longTouchTimeout)
      window.clearInterval(resources.spinInterval)
      safely(() => instance.stopAnimate())
      safely(() => instance.clear())
    }
    delete canvas._3dmol_viewer
    canvas.remove()
    // OffscreenCanvas rendering in 3Dmol can share a context between viewers.
    // Release only a context owned by our canvas, never that shared context.
    safely(() => {
      const context = canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl") as WebGLRenderingContext | null
      context?.getExtension("WEBGL_lose_context")?.loseContext()
    })
    canvas.width = 0
    canvas.height = 0
  }

  try {
    // Construction is synchronous: no browser events or other React effects can
    // interleave here. Restore the exact property descriptors before returning.
    for (const target of [window, document.body, canvas]) {
      const original = target.addEventListener
      const descriptor = Object.getOwnPropertyDescriptor(target, "addEventListener")
      Object.defineProperty(target, "addEventListener", {
        configurable: true,
        writable: true,
        value(type: string, listener: Listener, options?: boolean | AddEventListenerOptions) {
          if (!listener) return
          listeners.push({ target, type, listener, options })
          original.call(target, type, listener, options)
        },
      })
      restore.push(() => {
        if (descriptor) Object.defineProperty(target, "addEventListener", descriptor)
        else delete (target as unknown as { addEventListener?: unknown }).addEventListener
      })
    }
    viewer = mol.createViewer(host, { canvas, backgroundColor: "#000000", backgroundAlpha: 0, antialias: true })
    if (!viewer) throw new Error("Unable to initialize the crystal structure renderer.")
    return { viewer, dispose }
  } catch (error) {
    dispose()
    throw error
  } finally {
    for (const reset of restore.reverse()) reset()
  }
}
