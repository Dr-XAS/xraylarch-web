import { expect, test, type Locator } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

async function curves(viewer: Locator, space: string) {
  const plot = viewer.getByLabel(`${space}-space spectrum plot`, { exact: true })
  await expect(plot.locator(".js-line").first()).toBeAttached()
  return plot.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { data: { x: number[]; y: number[] }[] }).data.map(trace => ({
      x: [...trace.x], y: [...trace.y],
    })),
  )
}

test("each spectrum and wavelet viewer controls its own k-weight", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1500, height: 1100 })
  await page.goto("/")
  const examples = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const loaded = await examples
  expect(loaded.ok()).toBe(true)
  const project = await loaded.json() as AthenaProject
  const single = page.getByRole("region", { name: "Single spectrum viewer", exact: true })
  const multiple = page.getByRole("region", { name: "Multiple spectra viewer", exact: true })
  const wavelet = page.getByRole("region", { name: "Wavelet plotter", exact: true })
  const singleWeight = single.getByRole("combobox", { name: "Single spectrum k-weight", exact: true })
  const multipleWeight = multiple.getByRole("combobox", { name: "Multiple spectra k-weight", exact: true })
  const waveletWeight = wavelet.getByRole("combobox", { name: "Wavelet k-weight", exact: true })

  await expect(page.getByRole("combobox", { name: "Viewer k-weight", exact: true })).toHaveCount(0)
  await expect(singleWeight).toHaveCount(0)
  await expect(multipleWeight).toHaveCount(0)
  await expect(waveletWeight).toHaveValue("2")
  await single.getByRole("tab", { name: "k EXAFS", exact: true }).click()
  await multiple.getByRole("tab", { name: "k EXAFS", exact: true }).click()
  await expect(singleWeight).toHaveValue("2")
  await expect(multipleWeight).toHaveValue("2")
  const originalSingle = await curves(single, "k")
  const originalMultiple = await curves(multiple, "k")

  await singleWeight.selectOption("1")
  await expect.poll(() => curves(single, "k")).not.toEqual(originalSingle)
  const singleK1 = await curves(single, "k")
  const usefulPoint = originalSingle[0].x.findIndex((x, index) => x > 3 && Math.abs(originalSingle[0].y[index]) > 1e-5)
  expect(usefulPoint).toBeGreaterThanOrEqual(0)
  expect(singleK1[0].y[usefulPoint] * singleK1[0].x[usefulPoint]).toBeCloseTo(originalSingle[0].y[usefulPoint], 10)
  expect(await curves(multiple, "k")).toEqual(originalMultiple)
  await expect(multipleWeight).toHaveValue("2")
  await expect(waveletWeight).toHaveValue("2")

  await multipleWeight.selectOption("3")
  await expect.poll(() => curves(multiple, "k")).not.toEqual(originalMultiple)
  const multipleK3 = await curves(multiple, "k")
  expect(await curves(single, "k")).toEqual(singleK1)
  await expect(singleWeight).toHaveValue("1")
  await expect(waveletWeight).toHaveValue("2")

  const waveletChange = page.waitForResponse(response => response.url().endsWith("/wavelet") && response.request().postDataJSON().kweight === 0)
  await waveletWeight.selectOption("0")
  const waveletResponse = await waveletChange
  expect(waveletResponse.ok()).toBe(true)
  expect((await waveletResponse.json()).kweight).toBe(0)
  await expect(wavelet.getByText("Cauchy wavelet · |WT| · k-weight 0", { exact: true })).toBeVisible()
  await expect(wavelet.getByLabel("2D wavelet heatmap", { exact: true }).locator(".js-plotly-plot")).toBeVisible()
  expect(await curves(single, "k")).toEqual(singleK1)
  expect(await curves(multiple, "k")).toEqual(multipleK3)
  await single.screenshot({ path: info.outputPath("single-kweight-desktop.png") })
  await multiple.screenshot({ path: info.outputPath("multiple-kweight-desktop.png") })
  await wavelet.screenshot({ path: info.outputPath("wavelet-kweight-desktop.png") })

  for (const [tab, space] of [["R Fourier", "R"], ["q Back transform", "q"]]) {
    await single.getByRole("tab", { name: tab, exact: true }).click()
    await expect(singleWeight).toHaveValue("1")
    const before = await curves(single, space)
    const transformed = page.waitForResponse(response => response.url().endsWith("/plot-transform") && response.request().postDataJSON().kweight === 4)
    await singleWeight.selectOption("4")
    const response = await transformed
    expect(response.ok()).toBe(true)
    expect((await response.json()).kweight).toBe(4)
    await expect.poll(() => curves(single, space)).not.toEqual(before)
    expect(await curves(multiple, "k")).toEqual(multipleK3)
    await expect(multipleWeight).toHaveValue("3")
    await expect(waveletWeight).toHaveValue("0")
    await singleWeight.selectOption("1")
    await expect.poll(() => curves(single, space)).toEqual(before)
  }

  await single.getByRole("tab", { name: "E Energy", exact: true }).click()
  await expect(singleWeight).toHaveCount(0)
  await single.getByRole("tab", { name: "k EXAFS", exact: true }).click()
  await expect(singleWeight).toHaveValue("1")
  await single.getByRole("button", { name: "Collapse Single spectrum viewer", exact: true }).click()
  await single.getByRole("button", { name: "Expand Single spectrum viewer", exact: true }).click()
  await expect(singleWeight).toHaveValue("1")

  const savedResponse = await page.request.get(`/api/backend/api/athena/projects/${project.id}`)
  expect(savedResponse.ok()).toBe(true)
  const saved = await savedResponse.json() as AthenaProject
  expect(saved.version).toBe(project.version)
  expect(saved.groups.map(group => ({ parameters: group.parameters, result: group.result })))
    .toEqual(project.groups.map(group => ({ parameters: group.parameters, result: group.result })))

  await page.setViewportSize({ width: 390, height: 844 })
  for (const [name, viewer, control, weight] of [
    ["single", single, singleWeight, "1"],
    ["multiple", multiple, multipleWeight, "3"],
    ["wavelet", wavelet, waveletWeight, "0"],
  ] as const) {
    await control.scrollIntoViewIfNeeded()
    await expect(control).toBeVisible()
    await expect(control).toHaveValue(weight)
    expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    const viewerBox = (await viewer.boundingBox())!
    const controlBox = (await control.boundingBox())!
    expect(controlBox.x).toBeGreaterThanOrEqual(viewerBox.x)
    expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(viewerBox.x + viewerBox.width)
    await viewer.screenshot({ path: info.outputPath(`${name}-kweight-mobile.png`) })
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})

async function fitCurves(viewer: Locator) {
  const plot = viewer.locator("#artemis-fit-plot")
  await expect(plot.locator(".js-line").first()).toBeAttached()
  return plot.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { data: { name: string; x: number[]; y: number[] }[] }).data.map(trace => ({
      name: trace.name, x: [...trace.x], y: [...trace.y],
    })),
  )
}

test("EXAFS fit k-weight retransforms data, model and paths without changing the saved fit", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const fittingRequests: string[] = []
  page.on("request", request => {
    if (request.url().endsWith("/fit-saved")) fittingRequests.push(request.url())
  })
  await page.setViewportSize({ width: 1500, height: 1100 })
  await page.goto("/")
  const viewer = page.getByRole("region", { name: "EXAFS fit results", exact: true })
  const weight = viewer.getByRole("combobox", { name: "EXAFS fit k-weight", exact: true })
  await expect(weight).toHaveCount(0)
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  await page.getByRole("button", { name: "Open Cu₂O EXAFS", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  const fittedResponse = page.waitForResponse(response => response.url().endsWith("/fit-saved"))
  await page.getByRole("button", { name: "Run EXAFS fit", exact: true }).click()
  const fitted = await fittedResponse
  expect(fitted.ok()).toBe(true)
  const project = (await fitted.json()).project as AthenaProject
  const group = project.groups.find(item => item.label === "Cu₂O · room temperature")!
  const record = group.artemis!.history[0]
  expect(record.result.success).toBe(true)
  expect(record.result.paths).toHaveLength(4)
  await expect(weight).toHaveValue(String(record.result.k.weight))
  const statistics = await viewer.locator("dl").innerText()
  const parameters = await viewer.getByRole("table", { name: "Fitted parameters", exact: true }).innerText()
  await viewer.getByRole("checkbox", { name: "Show paths", exact: true }).check()
  const originalR = await fitCurves(viewer)
  expect(originalR).toHaveLength(7)
  await viewer.getByRole("button", { name: "k space", exact: true }).click()
  const originalK = await fitCurves(viewer)
  const single = page.getByRole("region", { name: "Single spectrum viewer", exact: true })
  const multiple = page.getByRole("region", { name: "Multiple spectra viewer", exact: true })
  const waveletWeight = page.getByRole("combobox", { name: "Wavelet k-weight", exact: true })
  await single.getByRole("tab", { name: "k EXAFS", exact: true }).click()
  await multiple.getByRole("tab", { name: "k EXAFS", exact: true }).click()
  const singleWeight = single.getByRole("combobox", { name: "Single spectrum k-weight", exact: true })
  const multipleWeight = multiple.getByRole("combobox", { name: "Multiple spectra k-weight", exact: true })
  await singleWeight.selectOption("1")
  await multipleWeight.selectOption("3")
  const singleBefore = await curves(single, "k")
  const multipleBefore = await curves(multiple, "k")
  const waveletBefore = await waveletWeight.inputValue()

  const selectedWeight = record.result.k.weight === 4 ? 3 : 4
  const changing = page.waitForResponse(response => response.url().includes("/api/artemis/") && response.url().endsWith("/plot-transform"))
  await weight.selectOption(String(selectedWeight))
  const transformed = await changing
  expect(transformed.ok()).toBe(true)
  expect((await transformed.json()).kweight).toBe(selectedWeight)
  await expect.poll(() => fitCurves(viewer)).not.toEqual(originalK)
  const changedK = await fitCurves(viewer)
  expect(changedK).toHaveLength(7)
  for (let trace = 0; trace < originalK.length; trace += 1) {
    expect(changedK[trace].x).toEqual(originalK[trace].x)
    const point = originalK[trace].x.findIndex((x, index) => x > 3 && Math.abs(originalK[trace].y[index]) > 1e-6)
    expect(point).toBeGreaterThanOrEqual(0)
    expect(changedK[trace].y[point]).toBeCloseTo(originalK[trace].y[point] * originalK[trace].x[point] ** (selectedWeight - record.result.k.weight), 7)
  }
  await viewer.screenshot({ path: info.outputPath("fit-kweight-k-desktop.png") })
  await viewer.getByRole("button", { name: "R space", exact: true }).click()
  const changedR = await fitCurves(viewer)
  expect(changedR).toHaveLength(7)
  changedR.forEach((trace, index) => expect(trace.y).not.toEqual(originalR[index].y))
  await expect(weight).toHaveValue(String(selectedWeight))
  expect(await viewer.locator("dl").innerText()).toBe(statistics)
  expect(await viewer.getByRole("table", { name: "Fitted parameters", exact: true }).innerText()).toBe(parameters)
  expect(await curves(single, "k")).toEqual(singleBefore)
  expect(await curves(multiple, "k")).toEqual(multipleBefore)
  await expect(singleWeight).toHaveValue("1")
  await expect(multipleWeight).toHaveValue("3")
  await expect(waveletWeight).toHaveValue(waveletBefore)
  await viewer.screenshot({ path: info.outputPath("fit-kweight-r-desktop.png") })

  const storedResponse = await page.request.get(`/api/backend/api/athena/projects/${project.id}`)
  expect(storedResponse.ok()).toBe(true)
  const stored = await storedResponse.json() as AthenaProject
  expect(stored.version).toBe(project.version)
  expect(stored.groups.find(item => item.id === group.id)?.artemis!.history[0]).toEqual(record)
  expect(fittingRequests).toHaveLength(1)

  await page.setViewportSize({ width: 390, height: 844 })
  await weight.scrollIntoViewIfNeeded()
  await expect(weight).toBeVisible()
  await expect(weight).toHaveValue(String(selectedWeight))
  expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await viewer.screenshot({ path: info.outputPath("fit-kweight-mobile.png") })
  await weight.selectOption(String(record.result.k.weight))
  await expect.poll(() => fitCurves(viewer)).toEqual(originalR)
  expect(errors).toEqual([])
})
