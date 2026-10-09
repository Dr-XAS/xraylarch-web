import { expect, test } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

const cuprite = (project: AthenaProject) => project.groups.find(group => group.label === "Cu₂O · room temperature")!

test("discovers, saves, reopens and fits an explicit coordination number", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)

  const amplitude = page.getByLabel("Path 1 S₀²", { exact: true })
  const control = page.getByRole("group", { name: "Path 1 coordination number controls", exact: true })
  const amplitudeRow = page.locator("[data-amplitude-row]").filter({ has: amplitude })
  const options = page.getByLabel("Path 1 coordination options", { exact: true })
  // CN shares the amplitude row and folds together with the path expressions.
  await page.getByRole("button", { name: "Collapse path 1 details", exact: true }).click()
  await expect(page.getByRole("button", { name: "Expand path 1 details", exact: true })).toBeVisible()
  await expect(amplitude).not.toBeVisible()
  await expect(control).not.toBeVisible()
  await page.getByRole("button", { name: "Expand path 1 details", exact: true }).click()
  await expect(control).toBeVisible()
  await expect(page.getByLabel("Path 1 coordination number", { exact: true })).toHaveValue("2")
  await expect(page.getByLabel("Path 1 fit coordination number", { exact: true })).toBeChecked()
  await expect(page.getByLabel("Path 1 fixed S₀²", { exact: true })).toHaveValue("")
  // The default narrow parameter pane wraps; widen it to check the inline row.
  expect(await control.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const divider = page.getByRole("separator", { name: "Resize processing parameters and spectrum viewer" })
  const dividerBox = (await divider.boundingBox())!
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 100)
  await page.mouse.down()
  await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 280, dividerBox.y + 100)
  await page.mouse.up()
  const amplitudeBox = await amplitude.boundingBox()
  const cnBox = await page.getByLabel("Path 1 coordination number", { exact: true }).boundingBox()
  expect(amplitudeBox).not.toBeNull()
  expect(cnBox).not.toBeNull()
  expect(cnBox!.x).toBeGreaterThanOrEqual(amplitudeBox!.x + amplitudeBox!.width)
  expect(Math.abs(cnBox!.y - amplitudeBox!.y)).toBeLessThanOrEqual(2)

  // This supplied S₀² is an example input, not a calibration recommendation.
  await page.getByLabel("Path 1 fixed S₀²", { exact: true }).fill("0.85")
  await expect(page.getByLabel("Path 1 coordination number", { exact: true })).toBeDisabled()
  await options.locator("summary").click()
  await page.getByLabel("Path 1 coordination maximum", { exact: true }).fill("4")
  await page.getByRole("button", { name: "Collapse path 1 details", exact: true }).click()
  await expect(control).not.toBeVisible()
  await page.getByRole("button", { name: "Expand path 1 details", exact: true }).click()
  await expect(page.getByLabel("Path 1 coordination number", { exact: true })).toHaveValue("2")
  await expect(page.getByLabel("Path 1 fixed S₀²", { exact: true })).toHaveValue("0.85")
  await expect(page.getByLabel("Path 1 coordination maximum", { exact: true })).toHaveValue("4")
  await expect(page.getByLabel("Path 1 fit coordination number", { exact: true })).toBeChecked()
  const expression = "s02_1 * cn_1 / degen"
  const saving = page.waitForResponse(response => response.url().endsWith("/model") &&
    response.request().postDataJSON()?.model.paths[0].s02 === expression)
  await page.getByRole("button", { name: "Apply coordination number for path 1", exact: true }).click()
  const savedResponse = await saving
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true)
  const saved = await savedResponse.json() as AthenaProject
  const model = cuprite(saved).artemis!.model
  expect(model.paths[0].s02).toBe(expression)
  expect(model.paths.slice(1).map(path => path.s02)).toEqual(["amp", "amp", "amp"])
  expect(model.parameters.find(parameter => parameter.name === "cn_1")).toMatchObject({ kind: "guess", value: "2", min: "0", max: "4" })
  expect(model.parameters.find(parameter => parameter.name === "s02_1")).toMatchObject({ kind: "set", value: "0.85" })
  expect(model.parameters.find(parameter => parameter.name === "amp")?.kind).toBe("guess")
  await expect(page.getByRole("button", { name: "Collapse path 1 details", exact: true })).toBeVisible()
  if (await options.evaluate(element => (element as HTMLDetailsElement).open)) await options.locator("summary").click()
  await amplitudeRow.screenshot({ path: info.outputPath("coordination-number-desktop.png") })

  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await page.getByRole("button", { name: "Expand path 1 details", exact: true }).click()
  await expect(page.getByLabel("Path 1 S₀²", { exact: true })).toHaveValue(expression)
  for (const name of ["cn_1", "s02_1"]) {
    const index = model.parameters.findIndex(parameter => parameter.name === name)
    const parameter = model.parameters[index]
    await expect(page.getByLabel(`Parameter ${index + 1} name`, { exact: true })).toHaveValue(name)
    await expect(page.getByLabel(`Parameter ${index + 1} kind`, { exact: true })).toHaveValue(parameter.kind)
    await expect(page.getByLabel(`Parameter ${index + 1} value`, { exact: true })).toHaveValue(parameter.value)
  }
  const cnIndex = model.parameters.findIndex(parameter => parameter.name === "cn_1") + 1
  await expect(page.getByLabel(`Parameter ${cnIndex} minimum`, { exact: true })).toHaveValue("0")
  await expect(page.getByLabel(`Parameter ${cnIndex} maximum`, { exact: true })).toHaveValue("4")

  const fitting = page.waitForResponse(response => response.url().endsWith("/fit-saved"))
  await page.getByRole("button", { name: "Run EXAFS fit", exact: true }).click()
  const fitResponse = await fitting
  expect(fitResponse.ok(), await fitResponse.text()).toBe(true)
  const fitted = (await fitResponse.json()).project as AthenaProject
  const result = cuprite(fitted).artemis!.history.at(-1)!.result
  expect(result.success).toBe(true)
  const cn = result.parameters.find(parameter => parameter.name === "cn_1")!
  const s02 = result.parameters.find(parameter => parameter.name === "s02_1")!
  expect(cn.kind).toBe("guess")
  expect(Number.isFinite(cn.value)).toBe(true)
  expect(cn.value).toBeGreaterThanOrEqual(0)
  expect(cn.value).toBeLessThanOrEqual(4)
  expect(s02.kind).toBe("set")
  expect(s02.value).toBeCloseTo(0.85, 12)
  expect(result.paths[0].values!.s02).toBeCloseTo(s02.value * cn.value / model.paths[0].metadata.degen, 10)
  const viewer = page.getByRole("region", { name: "EXAFS fit results", exact: true })
  const parameters = viewer.getByRole("table", { name: "Fitted parameters", exact: true })
  await expect(parameters.getByRole("rowheader", { name: "cn_1", exact: true })).toBeVisible()
  await expect(parameters.getByRole("rowheader", { name: "s02_1", exact: true })).toBeVisible()
  const pathSummary = viewer.getByRole("table", { name: "Fitted path summary", exact: true })
  const cnCell = pathSummary.getByRole("row").nth(1).getByRole("cell").nth(1)
  await expect(cnCell).toContainText(String(Number(cn.value.toPrecision(6))))
  await expect(cnCell).toContainText("Varied · cn_1")
  await expect(cnCell).not.toContainText("FEFF N")

  await page.getByRole("button", { name: "Collapse path 1 details", exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Expand path 1 details", exact: true }).click()
  await page.getByLabel("Path 1 coordination number", { exact: true }).scrollIntoViewIfNeeded()
  await expect(amplitude).toBeVisible()
  await expect(control).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await amplitudeRow.screenshot({ path: info.outputPath("coordination-number-mobile.png") })
  expect(errors).toEqual([])
})
