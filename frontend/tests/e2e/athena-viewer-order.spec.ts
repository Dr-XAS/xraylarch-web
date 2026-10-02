import { expect, test, type Locator, type Page } from "@playwright/test"

const defaultOrder = ["single", "multiple", "wavelet", "cif", "feff", "fit"]

function chooser(page: Page) {
  return page.getByRole("group", { name: "Choose viewers", exact: true })
}

function chipOrder(page: Page) {
  return chooser(page).locator("[data-viewer-chip-id]").evaluateAll(elements =>
    elements.map(element => element.getAttribute("data-viewer-chip-id")),
  )
}

async function expectOrder(page: Page, order: string[]) {
  await expect.poll(() => chipOrder(page)).toEqual(order)
  await expect.poll(() => page.locator(".ath-viewer-stack > [data-viewer-id]").evaluateAll(elements =>
    elements.map(element => element.getAttribute("data-viewer-id")),
  )).toEqual(order)
  await expect(chooser(page).locator(":scope > :first-child")).toHaveText("All viewers")
}

async function shownState(page: Page) {
  return chooser(page).locator("[data-viewer-chip-id]").evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [
      element.getAttribute("data-viewer-chip-id"),
      element.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed"),
    ])),
  )
}

async function dragWithMouse(page: Page, handle: Locator, target: Locator) {
  await chooser(page).scrollIntoViewIfNeeded()
  const from = (await handle.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
}

test("dragging viewer handles orders chips and panels and survives loading and reloading a project", async ({ page }, info) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const loadExamples = page.getByRole("button", { name: "Load copper examples", exact: true })
  await expect(loadExamples).toBeEnabled()
  await expectOrder(page, defaultOrder)
  const controls = chooser(page)
  const sort = page.getByRole("combobox", { name: "Sort viewers", exact: true })
  const waveletToggle = controls.getByRole("button", { name: "Wavelet plotter", exact: true })
  await waveletToggle.click()
  const beforeDrag = await shownState(page)
  const fitHandle = controls.getByRole("button", { name: "Reorder EXAFS fit viewer", exact: true })
  await dragWithMouse(page, fitHandle, controls.locator('[data-viewer-chip-id="single"]'))
  const firstOrder = ["fit", "single", "multiple", "wavelet", "cif", "feff"]
  await expectOrder(page, firstOrder)
  await expect(sort).toHaveValue("custom")
  await expect(fitHandle).toBeFocused()
  expect(await shownState(page)).toEqual(beforeDrag)
  await expect(page.locator('.ath-viewer-stack > [data-viewer-id="wavelet"]')).toBeHidden()
  await expect(controls.getByRole("button", { name: "All viewers", exact: true })).toHaveAttribute("aria-pressed", "false")

  const loading = page.waitForResponse(response => response.url().endsWith("/command") &&
    response.request().postDataJSON().action === "example")
  const savingExampleModel = page.waitForResponse(response => response.url().includes("/api/artemis/projects/") &&
    response.url().endsWith("/model") && response.request().method() === "POST")
  await loadExamples.click()
  const loaded = await loading
  expect(loaded.ok()).toBe(true)
  const project = await loaded.json() as { id: string; version: number }
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  expect((await savingExampleModel).ok()).toBe(true)
  const beforeReorder = await page.request.get(`/api/backend/api/athena/projects/${project.id}?view=summary`)
  expect(beforeReorder.ok()).toBe(true)
  const versionBeforeReorder = (await beforeReorder.json()).version
  await expectOrder(page, firstOrder)
  await expect(sort).toHaveValue("custom")

  await waveletToggle.click()
  const shownAfterLoading = await shownState(page)
  const singleHandle = controls.getByRole("button", { name: "Reorder Single spectrum viewer", exact: true })
  await dragWithMouse(page, singleHandle, controls.locator('[data-viewer-chip-id="feff"]'))
  const savedOrder = ["fit", "multiple", "wavelet", "cif", "feff", "single"]
  await expectOrder(page, savedOrder)
  expect(await shownState(page)).toEqual(shownAfterLoading)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("athena.viewer-order.v1") ?? "null")))
    .toEqual({ sort: "custom", order: savedOrder })
  const saved = await page.request.get(`/api/backend/api/athena/projects/${project.id}?view=summary`)
  expect(saved.ok()).toBe(true)
  expect((await saved.json()).version).toBe(versionBeforeReorder)
  await controls.screenshot({ path: info.outputPath("viewer-custom-order-desktop.png") })

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(loadExamples).toBeEnabled()
  await expectOrder(page, savedOrder)
  await expect(sort).toHaveValue("custom")
  await sort.selectOption("default")
  await expectOrder(page, defaultOrder)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(loadExamples).toBeEnabled()
  await expectOrder(page, defaultOrder)
  await expect(sort).toHaveValue("default")
  expect(errors).toEqual([])
})

test.describe("viewer order on a narrow touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("keyboard and touch handles reorder wrapped chips without toggling viewers", async ({ page }, info) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Load copper examples", exact: true })).toBeEnabled()
    const controls = chooser(page)
    await controls.getByRole("button", { name: "Wavelet plotter", exact: true }).click()
    const originalShown = await shownState(page)
    const handle = controls.getByRole("button", { name: "Reorder Single spectrum viewer", exact: true })
    await handle.focus()
    for (const [key, order] of [
      ["ArrowRight", ["multiple", "single", "wavelet", "cif", "feff", "fit"]],
      ["ArrowLeft", defaultOrder],
      ["ArrowDown", ["multiple", "single", "wavelet", "cif", "feff", "fit"]],
      ["ArrowUp", defaultOrder],
      ["End", ["multiple", "wavelet", "cif", "feff", "fit", "single"]],
      ["Home", defaultOrder],
    ] as const) {
      await handle.press(key)
      await expectOrder(page, [...order])
      await expect(handle).toBeFocused()
    }
    expect(await shownState(page)).toEqual(originalShown)
    await expect(page.getByRole("combobox", { name: "Sort viewers", exact: true })).toHaveValue("custom")

    await controls.scrollIntoViewIfNeeded()
    const fitHandle = controls.getByRole("button", { name: "Reorder EXAFS fit viewer", exact: true })
    const from = (await fitHandle.boundingBox())!
    const to = (await controls.locator('[data-viewer-chip-id="single"]').boundingBox())!
    expect(from.y).toBeGreaterThan(to.y + to.height)
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
    const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
    // Native touch events exercise pointer capture and touch-action on the drag handle.
    const session = await page.context().newCDPSession(page)
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] })
    for (let step = 1; step <= 12; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x + (end.x - start.x) * step / 12, y: start.y + (end.y - start.y) * step / 12, id: 1 }],
      })
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await session.detach()
    await expectOrder(page, ["fit", "single", "multiple", "wavelet", "cif", "feff"])
    await expect(fitHandle).toBeFocused()
    expect(await shownState(page)).toEqual(originalShown)
    await expect(page.locator('.ath-viewer-stack > [data-viewer-id="wavelet"]')).toBeHidden()
    expect(await controls.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await controls.screenshot({ path: info.outputPath("viewer-custom-order-mobile.png") })
    expect(errors).toEqual([])
  })
})
