import { expect, test, type Locator, type Page } from "@playwright/test"

function plottedColors(viewer: Locator) {
  return viewer.getByLabel("E-space spectrum plot", { exact: true }).locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { data: { line: { color: string } }[] }).data.map(trace => trace.line.color),
  )
}

async function dragHandle(page: Page, handle: Locator, distance: number) {
  const bounds = (await handle.boundingBox())!
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + distance, y, { steps: 6 })
  await page.mouse.up()
}

test("spectrum color range arrows recolor plots and keep viewer preferences separate", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()

  const multiple = page.getByRole("region", { name: "Multiple spectra viewer", exact: true })
  const single = page.getByRole("region", { name: "Single spectrum viewer", exact: true })
  await expect(multiple.getByLabel("E-space spectrum plot", { exact: true }).locator(".js-line").first()).toBeAttached()

  await multiple.getByRole("combobox", { name: "Color legend" }).click()
  await page.getByRole("option", { name: "Rainbow · violet–red" }).click()
  const before = await plottedColors(multiple)
  const min = multiple.getByRole("slider", { name: "Color vmin" })
  const max = multiple.getByRole("slider", { name: "Color vmax" })
  await expect(min).toHaveAttribute("aria-valuenow", "0")
  await expect(max).toHaveAttribute("aria-valuenow", "100")
  await multiple.getByRole("group", { name: "Spectrum colors" }).screenshot({ path: info.outputPath("spectrum-color-range-default.png") })
  await dragHandle(page, min, 45)
  await expect.poll(async () => Number(await min.getAttribute("aria-valuenow"))).toBeGreaterThan(0)
  await expect.poll(() => plottedColors(multiple)).not.toEqual(before)
  await dragHandle(page, max, -45)
  await expect.poll(async () => Number(await max.getAttribute("aria-valuenow"))).toBeLessThan(100)
  await multiple.getByRole("group", { name: "Spectrum colors" }).screenshot({ path: info.outputPath("spectrum-color-range.png") })

  const multipleSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("athena.plot-colors") ?? "null"))
  expect(multipleSettings.vmin).toBeGreaterThan(0)
  expect(multipleSettings.vmax).toBeLessThan(1)

  await single.getByRole("combobox", { name: "Color legend" }).click()
  await page.getByRole("option", { name: "Viridis · purple–green–yellow" }).click()
  const singleMin = single.getByRole("slider", { name: "Color vmin" })
  await singleMin.press("ArrowRight")
  await expect.poll(async () => Number(await singleMin.getAttribute("aria-valuenow"))).toBeGreaterThan(0)
  const singleSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("athena.plot-colors.single") ?? "null"))
  expect(singleSettings.vmin).toBeGreaterThan(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("athena.plot-colors") ?? "null"))).toEqual(multipleSettings)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect.poll(async () => Number(await multiple.getByRole("slider", { name: "Color vmin" }).getAttribute("aria-valuenow")))
    .toBeGreaterThan(0)
  await expect.poll(async () => Number(await single.getByRole("slider", { name: "Color vmin" }).getAttribute("aria-valuenow")))
    .toBeGreaterThan(0)
})
