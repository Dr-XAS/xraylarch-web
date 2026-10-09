import { expect, test, type Page } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

const cuprite = (project: AthenaProject) => project.groups.find(group => group.label === "Cu₂O · room temperature")!

async function expectSeparateModelRows(page: Page) {
  const deltaR = page.getByLabel("Path 1 ΔR (Å)", { exact: true })
  const sigma2 = page.getByLabel("Path 1 σ² (Å²)", { exact: true })
  const deltaRInsert = page.getByRole("button", { name: "Insert ΔR model for path 1", exact: true })
  const sigma2Insert = page.getByRole("button", { name: "Insert σ² model for path 1", exact: true })
  await deltaR.scrollIntoViewIfNeeded()
  await expect(deltaRInsert).toHaveText("Insert model")
  await expect(sigma2Insert).toHaveText("Insert model")
  await expect(sigma2).toBeVisible()
  await expect(async () => {
    // The completed fit can scroll to its result after a delay. Measure every
    // rectangle in one frame so that scrolling cannot mix coordinate systems.
    const [deltaRBox, sigma2Box, deltaRButtonBox, sigma2ButtonBox] = await page.evaluate(() =>
      ["Path 1 ΔR (Å)", "Path 1 σ² (Å²)", "Insert ΔR model for path 1", "Insert σ² model for path 1"].map(label => {
        const element = document.querySelector(`[aria-label="${label}"]`)
        return element ? element.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number } : null
      }),
    )
    expect(deltaRBox).not.toBeNull()
    expect(sigma2Box).not.toBeNull()
    expect(deltaRButtonBox).not.toBeNull()
    expect(sigma2ButtonBox).not.toBeNull()
    expect(deltaRBox!.y + deltaRBox!.height).toBeLessThanOrEqual(sigma2Box!.y)
    expect(Math.abs(deltaRBox!.x - sigma2Box!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(deltaRBox!.width - sigma2Box!.width)).toBeLessThanOrEqual(1)
    for (const [input, button] of [[deltaRBox!, deltaRButtonBox!], [sigma2Box!, sigma2ButtonBox!]]) {
      expect(input.width).toBeGreaterThan(0)
      expect(button.width).toBeGreaterThan(0)
      expect(input.x + input.width).toBeLessThanOrEqual(button.x)
      expect(Math.abs(input.y + input.height / 2 - button.y - button.height / 2)).toBeLessThanOrEqual(2)
    }
  }).toPass({ timeout: 5000 })
}

test("inserts, saves, reopens and fits fractional expansion using each FEFF path's Reff", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  await expectSeparateModelRows(page)
  const pathCard = page.locator("[data-path-id]").filter({ has: page.getByLabel("Path 1 ΔR (Å)", { exact: true }) })
  await pathCard.screenshot({ path: info.outputPath("path-model-rows-desktop.png") })

  const unaffectedDeltaR = await Promise.all([2, 3, 4].map(index =>
    page.getByLabel(`Path ${index} ΔR (Å)`, { exact: true }).inputValue(),
  ))
  const insert = page.getByRole("button", { name: "Insert ΔR model for path 1", exact: true })
  await expect(insert).toHaveAttribute("aria-expanded", "false")
  await insert.click()
  await expect(insert).toHaveAttribute("aria-expanded", "true")
  const panel = page.getByRole("region", { name: "Path 1 ΔR model", exact: true })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole("combobox", { name: "Path 1 ΔR model", exact: true })).toHaveValue("expansion")
  const alphaInput = panel.getByLabel("Path 1 expansion factor α", { exact: true })
  await expect(alphaInput).toHaveValue("0")
  // A contraction is a valid initial value for the same fractional expansion model.
  await alphaInput.fill("-0.01")
  const expression = "alpha_1 * reff"
  const saving = page.waitForResponse(response => response.url().endsWith("/model") &&
    response.request().postDataJSON()?.model.paths[0].deltar === expression)
  await page.getByRole("button", { name: "Apply ΔR model for path 1", exact: true }).click()
  const savedResponse = await saving
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true)
  const model = cuprite(await savedResponse.json() as AthenaProject).artemis!.model
  expect(model.paths[0].deltar).toBe(expression)
  expect(model.paths.slice(1).map(path => path.deltar)).toEqual(unaffectedDeltaR)
  const alpha = model.parameters.find(parameter => parameter.name === "alpha_1")!
  expect(alpha).toMatchObject({ kind: "guess", value: "-0.01", max: "" })
  expect(Number(alpha.min)).toBeGreaterThan(-1)
  expect(Number(alpha.min)).toBeLessThan(-0.01)
  await expect(page.getByLabel("Path 1 ΔR (Å)", { exact: true })).toHaveValue(expression)
  await panel.screenshot({ path: info.outputPath("expansion-insertion-desktop.png") })

  // Reusing α across distinct shells must keep Reff local to each FEFF path.
  expect(model.paths[0].metadata.reff).not.toBe(model.paths[1].metadata.reff)
  const sharing = page.waitForResponse(response => response.url().endsWith("/model") &&
    response.request().postDataJSON()?.model.paths[1].deltar === expression)
  await page.getByLabel("Path 2 ΔR (Å)", { exact: true }).fill(expression)
  await page.getByLabel("Path 2 ΔR (Å)", { exact: true }).press("Tab")
  expect((await sharing).ok()).toBe(true)

  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await page.getByRole("button", { name: "Expand all path details", exact: true }).click()
  for (const index of [1, 2]) await expect(page.getByLabel(`Path ${index} ΔR (Å)`, { exact: true })).toHaveValue(expression)
  const alphaIndex = model.parameters.findIndex(parameter => parameter.name === "alpha_1") + 1
  await expect(page.getByLabel(`Parameter ${alphaIndex} kind`, { exact: true })).toHaveValue("guess")
  await expect(page.getByLabel(`Parameter ${alphaIndex} value`, { exact: true })).toHaveValue("-0.01")
  await expect(page.getByLabel(`Parameter ${alphaIndex} minimum`, { exact: true })).toHaveValue(alpha.min)
  await expect(page.getByLabel(`Parameter ${alphaIndex} maximum`, { exact: true })).toHaveValue("")

  const fitting = page.waitForResponse(response => response.url().endsWith("/fit-saved"))
  await page.getByRole("button", { name: "Run EXAFS fit", exact: true }).click()
  const fitResponse = await fitting
  expect(fitResponse.ok(), await fitResponse.text()).toBe(true)
  const result = cuprite((await fitResponse.json()).project as AthenaProject).artemis!.history.at(-1)!.result
  expect(result.success).toBe(true)
  const fittedAlpha = result.parameters.find(parameter => parameter.name === "alpha_1")!
  expect(fittedAlpha.kind).toBe("guess")
  expect(fittedAlpha.initial).toBe(-0.01)
  expect(Number.isFinite(fittedAlpha.value)).toBe(true)
  expect(fittedAlpha.value).toBeGreaterThan(-1)
  for (const path of result.paths.slice(0, 2)) {
    expect(path.values!.deltar).toBeCloseTo(fittedAlpha.value * path.metadata.reff, 10)
    expect(path.metadata.reff + path.values!.deltar).toBeGreaterThan(0)
  }
  await expect(page.getByRole("table", { name: "Fitted parameters", exact: true })
    .getByRole("rowheader", { name: "alpha_1", exact: true })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expectSeparateModelRows(page)
  await pathCard.screenshot({ path: info.outputPath("path-model-rows-mobile.png") })
  await insert.click()
  await expect(panel).toBeVisible()
  await panel.screenshot({ path: info.outputPath("expansion-insertion-mobile.png") })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})
