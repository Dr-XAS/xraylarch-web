import type { AtomSpec, GLViewer } from "3dmol"

type Point = { x: number; y: number; z: number }
export const measurementDistance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Angle ABC, with B as the vertex, in the displayed Cartesian coordinates. */
export function measurementAngle(a: Point, b: Point, c: Point): number | null {
  const ab = measurementDistance(a, b)
  const cb = measurementDistance(c, b)
  if (ab < 1e-8 || cb < 1e-8) return null
  const cosine = ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) + (a.z - b.z) * (c.z - b.z)) / (ab * cb)
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI
}

function selectionOutline(viewer: GLViewer, center: Point, color: string) {
  const vertexArr: Point[] = [], normalArr: Point[] = [], faceArr: number[] = []
  const rings = 16, segments = 32, radius = 0.62
  for (let ring = 0; ring <= rings; ring++) {
    const theta = Math.PI * ring / rings
    for (let segment = 0; segment <= segments; segment++) {
      const phi = 2 * Math.PI * segment / segments
      const x = Math.sin(theta) * Math.cos(phi), y = Math.cos(theta), z = Math.sin(theta) * Math.sin(phi)
      vertexArr.push({ x: center.x + radius * x, y: center.y + radius * y, z: center.z + radius * z })
      // Light the inside of the shell: its back faces form the visible rim.
      normalArr.push({ x: -x, y: -y, z: -z })
      if (ring < rings && segment < segments) {
        const a = ring * (segments + 1) + segment, b = a + segments + 1
        faceArr.push(a, a + 1, b, a + 1, b + 1, b)
      }
    }
  }
  // BackSide = 1. The original atom hides the rear shell, preserving its color.
  return viewer.addCustom({ vertexArr, normalArr, faceArr, color, opacity: 1, side: 1 })
}

/** Own only measurement objects: hover and the structure keep their own lifetimes. */
export function drawCifMeasurement(viewer: GLViewer, atoms: Point[]) {
  const labels: ReturnType<GLViewer["addLabel"]>[] = []
  const shapes: ReturnType<GLViewer["addSphere"]>[] = []
  const color = "#7c3aed"
  const label = (text: string, position: Point, alignment = "bottomCenter") => labels.push(viewer.addLabel(text, {
    position, fontSize: 12, fontColor: "white", backgroundColor: color,
    backgroundOpacity: 0.95, inFront: true, alignment,
  }))
  atoms.forEach((atom, index) => {
    shapes.push(selectionOutline(viewer, atom, color))
    label(String(index + 1), { x: atom.x, y: atom.y + 0.55, z: atom.z })
    if (index === 0) return
    const previous = atoms[index - 1]
    shapes.push(viewer.addLine({ start: previous, end: atom, color, dashed: true }))
    label(`${measurementDistance(previous, atom).toFixed(3)} Å`, {
      x: (previous.x + atom.x) / 2, y: (previous.y + atom.y) / 2, z: (previous.z + atom.z) / 2,
    }, index === 1 ? "bottomLeft" : "topRight")
  })
  if (atoms.length === 3) {
    const angle = measurementAngle(atoms[0], atoms[1], atoms[2])
    if (angle !== null) label(`∠ ${angle.toFixed(2)}°`, { x: atoms[1].x, y: atoms[1].y - 0.65, z: atoms[1].z }, "topCenter")
  }
  viewer.render()
  return () => {
    labels.forEach(item => viewer.removeLabel(item))
    shapes.forEach(item => viewer.removeShape(item))
    viewer.render()
  }
}

/** Tolerate hand jitter without confusing a drag, pinch, or long press with a pick.
 * Hoverable atoms already have picking geometry; no native click callbacks are
 * registered, so compatibility mouse/touch events cannot pick a second time.
 */
export function bindCifAtomPicking(host: HTMLElement, viewer: GLViewer, atoms: AtomSpec[], onPick: (index: number) => void) {
  const pointers = new Set<number>()
  let gesture: { id: number; x: number; y: number; time: number; view: ReturnType<GLViewer["getView"]> } | null = null
  const cancel = () => { gesture = null }
  const reset = () => { cancel(); pointers.clear() }
  const down = (event: PointerEvent) => {
    pointers.add(event.pointerId)
    if (pointers.size !== 1 || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) { cancel(); return }
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, view: viewer.getView() }
  }
  const move = (event: PointerEvent) => {
    if (gesture?.id === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) cancel()
  }
  const up = (event: PointerEvent) => {
    const start = gesture
    pointers.delete(event.pointerId)
    cancel()
    if (!start || start.id !== event.pointerId || event.timeStamp - start.time > 750 ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || !host.contains(event.target as Node)) return
    const rect = host.getBoundingClientRect()
    if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
    // 3Dmol may have rotated slightly during a sub-threshold movement.
    viewer.setView(start.view)
    const hit = viewer.targetedObjects(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height, atoms)[0]?.clickable as AtomSpec | undefined
    if (hit?.index !== undefined) onPick(hit.index)
  }
  const cancelled = (event: PointerEvent) => { pointers.delete(event.pointerId); cancel() }
  host.addEventListener("pointerdown", down)
  host.addEventListener("pointerleave", cancel)
  host.addEventListener("wheel", cancel)
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
  window.addEventListener("pointercancel", cancelled)
  window.addEventListener("blur", reset)
  return () => {
    reset()
    host.removeEventListener("pointerdown", down)
    host.removeEventListener("pointerleave", cancel)
    host.removeEventListener("wheel", cancel)
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    window.removeEventListener("pointercancel", cancelled)
    window.removeEventListener("blur", reset)
  }
}
