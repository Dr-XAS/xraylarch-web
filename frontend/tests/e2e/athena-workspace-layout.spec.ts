import { expect, test, type Locator } from "@playwright/test"

async function width(locator: Locator) {
  return (await locator.boundingBox())!.width
}

test("orders and resizes the desktop Athena workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => localStorage.removeItem("athena.workspace.sizes.v1"))
  await page.goto("/", { waitUntil: "domcontentloaded" })

  const workspace = page.getByTestId("athena-workspace")
  const groups = page.locator("#athena-data-groups")
  const processing = page.locator("#athena-processing-parameters")
  const spectrum = page.locator("#athena-spectrum-viewer")
  const first = page.getByRole("separator", { name: "Resize data groups and processing parameters" })
  const second = page.getByRole("separator", { name: "Resize processing parameters and spectrum viewer" })
  await expect(workspace).toBeVisible()
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()

  const children = await workspace.locator(":scope > *").evaluateAll(elements => elements.map(element => element.id || element.getAttribute("aria-label")))
  expect(children).toEqual([
    "athena-data-groups",
    "Resize data groups and processing parameters",
    "athena-processing-parameters",
    "Resize processing parameters and spectrum viewer",
    "athena-spectrum-viewer",
  ])

  const groupsBefore = await width(groups)
  const processingBefore = await width(processing)
  const spectrumBefore = await width(spectrum)
  const firstBox = (await first.boundingBox())!
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + 220)
  await page.mouse.down()
  await page.mouse.move(firstBox.x + firstBox.width / 2 + 32, firstBox.y + 220)
  await page.mouse.up()
  expect(await width(groups)).toBeGreaterThan(groupsBefore + 30)
  expect(await width(processing)).toBeLessThan(processingBefore - 30)
  expect(Math.abs(await width(spectrum) - spectrumBefore)).toBeLessThan(2)

  const processingAfterFirst = await width(processing)
  const spectrumAfterFirst = await width(spectrum)
  const secondBox = (await second.boundingBox())!
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + 220)
  await page.mouse.down()
  await page.mouse.move(secondBox.x + secondBox.width / 2 + 40, secondBox.y + 220)
  await page.mouse.up()
  expect(await width(processing)).toBeGreaterThan(processingAfterFirst + 38)
  expect(await width(spectrum)).toBeLessThan(spectrumAfterFirst - 38)

  await second.press("ArrowLeft")
  await expect(second).toHaveAttribute("aria-valuenow", String(Math.round(await width(processing))))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test("stacks panes in reading order without splitters or overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const workspace = page.getByTestId("athena-workspace")
  await expect(workspace).toBeVisible()
  const splitters = page.locator(".ath-workspace-resizer")
  await expect(splitters).toHaveCount(2)
  await expect(splitters.first()).toBeHidden()
  expect(await workspace.locator(":scope > *:visible").evaluateAll(elements => elements.map(element => element.id))).toEqual([
    "athena-data-groups",
    "athena-processing-parameters",
    "athena-spectrum-viewer",
  ])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
