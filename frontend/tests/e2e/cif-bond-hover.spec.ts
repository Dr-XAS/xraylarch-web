import { expect, test, type Locator } from "@playwright/test"

type Point = { x: number; y: number; z: number }
type Atom = Point & { elem: string; hoverable?: boolean; style?: { sphere?: object } }
type Shape = { hoverable?: boolean; stylespec: { start?: Point; end?: Point; radius?: number } }
type CrystalViewer = {
  getModel: () => { selectedAtoms: (selection: object) => Atom[] }
  shapes: Shape[]
  labels: { text: string }[]
  modelToScreen: (point: Point) => { x: number; y: number }
  targetedObjects: (x: number, y: number, objects: (Atom | Shape)[]) => { clickable: Atom | Shape }[]
}
type CrystalCanvas = HTMLCanvasElement & { _3dmol_viewer: CrystalViewer }

async function sceneState(canvas: Locator) {
  return canvas.evaluate(element => {
    const viewer = (element as CrystalCanvas)._3dmol_viewer
    return {
      labels: viewer.labels.map(label => label.text),
      bonds: viewer.shapes.filter(shape => shape.hoverable && shape.stylespec.radius !== undefined).length,
    }
  })
}

// Use the actual camera and raycaster to find an exposed target. Mouse movement
// below still drives the real canvas events; callbacks are never invoked by tests.
async function hoverTarget(canvas: Locator, kind: "bond" | "atom" | "empty") {
  return canvas.evaluate((element, requested) => {
    const viewer = (element as CrystalCanvas)._3dmol_viewer
    const bounds = element.getBoundingClientRect()
    const atoms = viewer.getModel().selectedAtoms({ hoverable: true })
    const shapes = viewer.shapes.filter(shape => shape.hoverable)
    const objects = [...atoms, ...shapes]
    const project = (point: Point) => {
      const screen = viewer.modelToScreen(point)
      return { x: screen.x - window.scrollX, y: screen.y - window.scrollY }
    }
    const firstHit = (screen: { x: number; y: number }) => viewer.targetedObjects(
      2 * (screen.x - bounds.left) / bounds.width - 1,
      1 - 2 * (screen.y - bounds.top) / bounds.height,
      objects,
    )[0]?.clickable
    const accessible = (screen: { x: number; y: number }) => document.elementFromPoint(screen.x, screen.y) === element
    const distanceFromCenter = (point: Point) => Math.hypot(point.x, point.y, point.z)
    if (requested === "bond") {
      for (const shape of shapes) {
        const { start, end, radius } = shape.stylespec
        if (!start || !end || radius === undefined) continue
        const length = Math.hypot(start.x - end.x, start.y - end.y, start.z - end.z)
        const endpoint = (point: Point) => atoms.find(atom => Math.hypot(atom.x - point.x, atom.y - point.y, atom.z - point.z) < 1e-6)
        const left = endpoint(start)
        const right = endpoint(end)
        if (!left || !right || Math.min(distanceFromCenter(left), distanceFromCenter(right)) < 0.5) continue
        for (const fraction of [0.25, 0.75, 0.5]) {
          const nearestAtom = fraction <= 0.5 ? left : right
          // This is deliberately an outer bond: its length differs from the
          // nearby atom's distance to the absorber, which the old hover showed.
          if (Math.abs(distanceFromCenter(nearestAtom) - length) < 0.1) continue
          const screen = project({
            x: start.x + fraction * (end.x - start.x),
            y: start.y + fraction * (end.y - start.y),
            z: start.z + fraction * (end.z - start.z),
          })
          if (accessible(screen) && firstHit(screen) === shape) return {
            ...screen,
            label: `${left.elem}–${right.elem} · ${length.toFixed(3)} Å`,
            centerDistance: distanceFromCenter(nearestAtom).toFixed(3),
            length: length.toFixed(3),
          }
        }
      }
    } else if (requested === "atom") {
      for (const atom of atoms) {
        if (!atom.style?.sphere || distanceFromCenter(atom) < 0.5) continue
        const screen = project(atom)
        if (accessible(screen) && firstHit(screen) === atom) return {
          ...screen, label: atom.elem, centerDistance: distanceFromCenter(atom).toFixed(3), length: "",
        }
      }
    } else {
      for (const x of [0.9, 0.1, 0.8, 0.2]) {
        for (const y of [0.85, 0.65, 0.35]) {
          const screen = { x: bounds.left + x * bounds.width, y: bounds.top + y * bounds.height }
          if (accessible(screen) && !firstHit(screen)) return { ...screen, label: "", centerDistance: "", length: "" }
        }
      }
    }
    throw new Error(`No exposed ${requested} target found in the Cuprite scene`)
  }, kind)
}

test("shows each CIF bond's endpoint distance on hover while preserving atom details", async ({ page }) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const loaded = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  const transformed = page.waitForResponse(response => response.url().endsWith("/plot-transform"))
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  expect((await loaded).ok()).toBe(true)
  expect((await transformed).ok()).toBe(true)
  const panel = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  await expect(panel.getByRole("button", { name: "Reset view", exact: true })).toBeEnabled()
  await expect(panel.getByText("15 atoms shown", { exact: true })).toBeVisible()
  const canvas = panel.getByRole("img", { name: "Interactive 3D crystal structure of Cuprite" }).locator("canvas")
  await canvas.scrollIntoViewIfNeeded()
  await expect.poll(async () => (await sceneState(canvas)).bonds).toBeGreaterThan(0)

  const bond = await hoverTarget(canvas, "bond")
  expect(bond.centerDistance).not.toBe(bond.length)
  await page.mouse.move(bond.x, bond.y)
  await expect.poll(async () => (await sceneState(canvas)).labels).toEqual([bond.label])

  const atom = await hoverTarget(canvas, "atom")
  await page.mouse.move(atom.x, atom.y)
  await expect.poll(async () => (await sceneState(canvas)).labels).toEqual([
    expect.stringMatching(new RegExp(`^${atom.label} · site \\d+ · ${atom.centerDistance.replace(".", "\\.")} Å`)),
  ])

  await page.mouse.move(bond.x, bond.y)
  await expect.poll(async () => (await sceneState(canvas)).labels).toEqual([bond.label])
  const empty = await hoverTarget(canvas, "empty")
  await page.mouse.move(empty.x, empty.y)
  await expect.poll(async () => (await sceneState(canvas)).labels).toEqual([])

  await page.mouse.move(bond.x, bond.y)
  await expect.poll(async () => (await sceneState(canvas)).labels).toEqual([bond.label])
  await page.mouse.move(1, 1)
  await expect.poll(async () => (await sceneState(canvas)).labels).toEqual([])
  await page.mouse.move(bond.x, bond.y)
  await expect.poll(async () => (await sceneState(canvas)).labels).toEqual([bond.label])

  const bonds = panel.getByRole("checkbox", { name: "Bonds", exact: true })
  await bonds.uncheck()
  await expect.poll(async () => sceneState(canvas)).toEqual({ labels: [], bonds: 0 })
  await bonds.check()
  await expect.poll(async () => (await sceneState(canvas)).bonds).toBeGreaterThan(0)
  const restoredBond = await hoverTarget(canvas, "bond")
  await page.mouse.move(restoredBond.x, restoredBond.y)
  await expect.poll(async () => (await sceneState(canvas)).labels).toEqual([restoredBond.label])

  // All Cuprite bonds involve Cu. Hiding Cu must remove both the visible
  // cylinders and their hover targets, including a currently displayed label.
  await panel.getByRole("button", { name: "Show Cu atoms", exact: true }).click()
  await expect(panel.getByText("2 atoms shown", { exact: true })).toBeVisible()
  await expect.poll(async () => sceneState(canvas)).toEqual({ labels: [], bonds: 0 })
  await panel.getByRole("button", { name: "Show Cu atoms", exact: true }).click()
  await expect(panel.getByText("15 atoms shown", { exact: true })).toBeVisible()
  await expect.poll(async () => (await sceneState(canvas)).bonds).toBeGreaterThan(0)
  await expect(panel.getByRole("alert")).toHaveCount(0)
})
