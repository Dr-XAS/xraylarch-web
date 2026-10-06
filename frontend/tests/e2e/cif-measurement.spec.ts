import { expect, test, type Locator } from "@playwright/test"

type Point = { x: number; y: number; z: number }
type Atom = Point & { index: number; elem: string; style?: { sphere?: object } }
type Viewer = {
  getModel: () => { selectedAtoms: (selection: object) => Atom[] }
  getView: () => number[]
  labels: { text: string }[]
  modelToScreen: (point: Point) => { x: number; y: number }
  targetedObjects: (x: number, y: number, objects: Atom[]) => { clickable: Atom }[]
}
type Canvas = HTMLCanvasElement & { _3dmol_viewer: Viewer }

async function scene(canvas: Locator) {
  return canvas.evaluate(element => {
    const viewer = (element as Canvas)._3dmol_viewer
    return { view: viewer.getView(), labels: viewer.labels.map(label => label.text) }
  })
}

// Locate visible balls with the real raycaster; selection still uses real mouse
// events, never callbacks or component state manipulation.
async function target(canvas: Locator, excluded: number[] = [], line?: [Point, Point]) {
  return canvas.evaluate((element, { excluded, line }) => {
    const viewer = (element as Canvas)._3dmol_viewer
    const rect = element.getBoundingClientRect()
    const atoms = viewer.getModel().selectedAtoms({}).filter(atom => atom.style?.sphere)
    for (const atom of atoms) {
      if (excluded.includes(atom.index)) continue
      if (line) {
        const u = { x: line[0].x - line[1].x, y: line[0].y - line[1].y, z: line[0].z - line[1].z }
        const v = { x: atom.x - line[1].x, y: atom.y - line[1].y, z: atom.z - line[1].z }
        if (Math.hypot(u.y * v.z - u.z * v.y, u.z * v.x - u.x * v.z, u.x * v.y - u.y * v.x) < 0.1) continue
      }
      const projected = viewer.modelToScreen(atom)
      const x = projected.x - window.scrollX
      const y = projected.y - window.scrollY
      if (document.elementFromPoint(x, y) !== element) continue
      if (viewer.targetedObjects(2 * (x - rect.left) / rect.width - 1, 1 - 2 * (y - rect.top) / rect.height, atoms)[0]?.clickable === atom) {
        return { screen: { x, y }, point: { x: atom.x, y: atom.y, z: atom.z }, index: atom.index, element: atom.elem }
      }
    }
    throw new Error("No exposed atom found")
  }, { excluded, line })
}

test("clicks atoms for persistent distances and angle, tolerates jitter, and keeps rotation independent", async ({ page }, info) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const loaded = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  expect((await loaded).ok()).toBe(true)
  const panel = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  await expect(panel.getByText("15 atoms shown", { exact: true })).toBeVisible()
  const measure = panel.getByRole("button", { name: "Measure", exact: true })
  await expect(measure).toBeEnabled()
  const canvas = panel.getByRole("img", { name: "Interactive 3D crystal structure of Cuprite" }).locator("canvas")
  await canvas.scrollIntoViewIfNeeded()
  // Wait for the async first-shell redraw before comparing camera values.
  await expect(panel.getByRole("checkbox", { name: "Highlight CrystalNN first shell" })).toBeVisible()
  await measure.click()
  await canvas.scrollIntoViewIfNeeded()
  const initial = (await scene(canvas)).view
  const a = await target(canvas)
  await page.mouse.click(a.screen.x, a.screen.y)
  const results = panel.getByRole("status", { name: "Measurement results" })
  await expect(results.getByRole("listitem")).toHaveCount(1)
  await page.mouse.click(a.screen.x, a.screen.y)
  await expect(results.getByRole("listitem")).toHaveCount(1)
  const b = await target(canvas, [a.index])
  await page.mouse.move(b.screen.x, b.screen.y)
  await page.mouse.down()
  await page.mouse.move(b.screen.x + 2, b.screen.y)
  await page.mouse.up()
  const length = (left: Point, right: Point) => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
  await expect(results.getByRole("listitem")).toHaveCount(2)
  await expect(results).toContainText(`${length(a.point, b.point).toFixed(3)} Å`)
  const c = await target(canvas, [a.index, b.index], [a.point, b.point])
  await page.mouse.click(c.screen.x, c.screen.y)
  await expect(results.getByRole("listitem")).toHaveCount(3)
  // Independent triangle cosine rule checks vertex order as well as the value.
  const ab = length(a.point, b.point), bc = length(b.point, c.point), ac = length(a.point, c.point)
  const angle = Math.acos(Math.max(-1, Math.min(1, (ab * ab + bc * bc - ac * ac) / (2 * ab * bc)))) * 180 / Math.PI
  await expect(results).toContainText(`${bc.toFixed(3)} Å`)
  await expect(results).toContainText(`${ac.toFixed(3)} Å`)
  await expect(results).toContainText(`${angle.toFixed(2)}°`)
  const after = await scene(canvas)
  after.view.forEach((value, index) => expect(value).toBeCloseTo(initial[index], 9))
  await page.mouse.move(1, 1)
  await expect.poll(async () => (await scene(canvas)).labels).toEqual(expect.arrayContaining(["1", "2", "3", `${ab.toFixed(3)} Å`, `${bc.toFixed(3)} Å`, `∠ ${angle.toFixed(2)}°`]))
  await panel.screenshot({ path: info.outputPath("cif-measurement.png") })

  await panel.getByRole("button", { name: "Undo atom" }).click()
  await expect(results.getByRole("listitem")).toHaveCount(2)
  await canvas.scrollIntoViewIfNeeded()
  const drag = await target(canvas, [a.index, b.index])
  await page.mouse.move(drag.screen.x, drag.screen.y)
  await page.mouse.down()
  await page.mouse.move(drag.screen.x + 35, drag.screen.y + 15, { steps: 5 })
  await page.mouse.up()
  await expect(results.getByRole("listitem")).toHaveCount(2)
  expect((await scene(canvas)).view).not.toEqual(initial)
  const afterDrag = await target(canvas, [a.index, b.index])
  await page.mouse.click(afterDrag.screen.x, afterDrag.screen.y)
  await expect(results.getByRole("listitem")).toHaveCount(3)
  await page.keyboard.press("Escape")
  await expect(results.getByRole("listitem")).toHaveCount(0)
  await expect.poll(async () => (await scene(canvas)).labels.filter(label => /^[123]$/.test(label))).toEqual([])
  await panel.getByRole("button", { name: "Reset view", exact: true }).click()
  await canvas.scrollIntoViewIfNeeded()
  const again = await target(canvas)
  await page.mouse.click(again.screen.x, again.screen.y)
  await panel.getByRole("button", { name: `Show ${again.element} atoms`, exact: true }).click()
  await expect(results.getByRole("listitem")).toHaveCount(0)
  await panel.getByRole("button", { name: `Show ${again.element} atoms`, exact: true }).click()
  await expect(results.getByRole("listitem")).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(measure).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await canvas.scrollIntoViewIfNeeded()
  const finger = await target(canvas)
  const cdp = await page.context().newCDPSession(page)
  const touch = { x: finger.screen.x, y: finger.screen.y, id: 1 }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] })
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect(results.getByRole("listitem")).toHaveCount(1)
  await panel.getByRole("button", { name: "Clear", exact: true }).click()
  await canvas.scrollIntoViewIfNeeded()
  const pinch = await target(canvas)
  const first = { x: pinch.screen.x, y: pinch.screen.y, id: 1 }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] })
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first, { ...first, x: first.x + 25, id: 2 }] })
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect(results.getByRole("listitem")).toHaveCount(0)
  await cdp.detach()
  await expect(panel.getByRole("alert")).toHaveCount(0)
})
