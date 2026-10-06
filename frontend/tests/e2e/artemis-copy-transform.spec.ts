import { expect, test, type Page, type Response } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

const sourceLabel = "Cu₂O · room temperature"
const firstLabel = "Cu foil · 10 K"
const secondLabel = "Cu foil · 50 K"
const unmarkedLabel = "Cu foil · 300 K"
const sectionAction = "Apply fit range & transform to marked groups"
const fieldAction = "Apply k min (Å⁻¹) to marked groups"

// Consume browser responses without putting spectral arrays in assertion output.
async function models(response: Response) {
  const project = await response.json() as AthenaProject
  return Object.fromEntries(project.groups.map(group => [group.label, {
    id: group.id, marked: group.marked, parameters: group.parameters, artemis: group.artemis,
  }]))
}

async function select(page: Page, label: string) {
  await page.locator(".ath-group-select").filter({ hasText: label }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
}

test("right-click copies live transform settings only to marked groups and restores them after reload", async ({ page }, info) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(30_000)
  const errors: string[] = []
  const fits: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (/\/fit(?:-saved)?(?:\?|$)/.test(request.url())) fits.push(request.url()) })
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  const examples = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const initial = await models(await examples)
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  await expect(page.locator(".ath-autosaved")).toHaveText("Saved locally")

  // Mark two different destinations. The third foil and shared reference stay unmarked.
  for (const [label, marked] of [[firstLabel, true], [secondLabel, true], [unmarkedLabel, false], [sourceLabel, false]] as const) {
    const checkbox = page.getByRole("checkbox", { name: `Mark ${label}`, exact: true })
    if (await checkbox.isChecked() !== marked) {
      const marking = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "metadata")
      await checkbox.setChecked(marked)
      expect((await marking).ok()).toBe(true)
    }
  }

  await select(page, firstLabel)
  const ownModelSave = page.waitForResponse(response => response.url().endsWith(`/groups/${initial[firstLabel].id}/model`) && response.request().postDataJSON().model.parameters[0].value === "0.65")
  await page.getByLabel("Parameter 1 value", { exact: true }).fill("0.65")
  const ownModels = await models(await ownModelSave)
  const ownModel = ownModels[firstLabel].artemis!.model
  expect(ownModel.paths).toEqual([])
  await expect(page.locator(".ath-autosaved")).toHaveText("Saved locally")
  await select(page, sourceLabel)

  for (const [label, value] of [["k min (Å⁻¹)", "4"], ["k max (Å⁻¹)", "15"], ["R min (Å)", "1.4"], ["R max (Å)", "3.8"], ["k taper dk (Å⁻¹)", "2"]]) {
    await page.getByLabel(label, { exact: true }).fill(value)
  }
  await page.getByLabel("Fit k window", { exact: true }).selectOption("kaiser")
  await page.getByRole("group", { name: "Fit space", exact: true }).getByRole("button", { name: "k space", exact: true }).click()
  for (const weight of [0, 1, 2, 3]) await page.getByLabel(`Fit k-weight ${weight}`, { exact: true }).setChecked([1, 3].includes(weight))
  const copied = page.waitForResponse(response => response.url().endsWith(`/groups/${initial[secondLabel].id}/model`) && response.request().postDataJSON().model.transform.kmin === "4")
  await page.locator("summary").filter({ hasText: "Fit range & transform" }).click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: sectionAction, exact: true })).toBeEnabled()
  await page.screenshot({ path: info.outputPath("transform-context-desktop.png"), style: "nextjs-portal { visibility: hidden; }" })
  await page.getByRole("menuitem", { name: sectionAction, exact: true }).click()
  await select(page, firstLabel)
  await expect(page.getByLabel("k min (Å⁻¹)", { exact: true })).toHaveValue("4")
  const whole = await models(await copied)
  await expect(page.locator(".ath-autosaved")).toHaveText("Saved locally")
  const transform = whole[sourceLabel].artemis!.model.transform
  expect(transform).toMatchObject({ fitspace: "k", kmin: "4", kmax: "15", rmin: "1.4", rmax: "3.8", dk: "2", window: "kaiser", kweight: [1, 3] })
  for (const label of [firstLabel, secondLabel]) {
    expect(whole[label].artemis!.model.transform).toEqual(transform)
    expect(whole[label].artemis!.model.paths).toEqual([])
    expect(whole[label].artemis!.history).toEqual([])
  }
  expect(whole[firstLabel].artemis!.model.parameters).toEqual(ownModel.parameters)
  expect(whole[secondLabel].artemis!.model.parameters[0].id).not.toBe(whole[sourceLabel].artemis!.model.parameters[0].id)
  expect(whole[sourceLabel].artemis!.model.paths).toHaveLength(4)
  expect(whole[unmarkedLabel].artemis).toBeUndefined()
  expect(whole[unmarkedLabel].parameters).toEqual(initial[unmarkedLabel].parameters)
  expect(whole["Cu foil · shared reference"].artemis).toBeUndefined()

  // A field copy preserves the destination's other transform settings and its own parameter.
  await page.getByLabel("k max (Å⁻¹)", { exact: true }).fill("18")
  const targetSave = page.waitForResponse(response => response.url().endsWith(`/groups/${initial[firstLabel].id}/model`) && response.request().postDataJSON().model.transform.window === "parzen")
  await page.getByLabel("Fit k window", { exact: true }).selectOption("parzen")
  expect((await targetSave).ok()).toBe(true)
  await select(page, sourceLabel)
  await page.getByLabel("k min (Å⁻¹)", { exact: true }).fill("5")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  const kmin = page.getByLabel("k min (Å⁻¹)", { exact: true })
  await kmin.scrollIntoViewIfNeeded()
  await kmin.click()
  await kmin.click({ button: "right" })
  const menu = page.getByRole("menu", { name: "Fit range & transform actions", exact: true })
  await expect(page.getByRole("menuitem", { name: fieldAction, exact: true })).toBeEnabled()
  await expect(page.getByRole("menuitem", { name: sectionAction, exact: true })).toBeEnabled()
  const menuBounds = await menu.boundingBox()
  expect(menuBounds).not.toBeNull()
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0)
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(390)
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(844)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath("transform-context-narrow.png"), style: "nextjs-portal { visibility: hidden; }" })
  const fieldCopied = page.waitForResponse(response => response.url().endsWith(`/groups/${initial[secondLabel].id}/model`) && response.request().postDataJSON().model.transform.kmin === "5")
  // The fixed menu is already in view; a physical pointer click must not scroll
  // the page, because outside scrolling deliberately dismisses context menus.
  const itemBounds = await page.getByRole("menuitem", { name: fieldAction, exact: true }).boundingBox()
  expect(itemBounds).not.toBeNull()
  await page.mouse.click(itemBounds!.x + itemBounds!.width / 2, itemBounds!.y + itemBounds!.height / 2)
  const field = await models(await fieldCopied)
  await expect(page.locator(".ath-autosaved")).toHaveText("Saved locally")
  expect(field[firstLabel].artemis!.model.transform).toEqual({ ...transform, kmin: "5", kmax: "18", window: "parzen" })
  expect(field[firstLabel].artemis!.model.parameters).toEqual(ownModel.parameters)
  expect(field[secondLabel].artemis!.model.transform).toEqual({ ...transform, kmin: "5" })
  expect(field[unmarkedLabel]).toEqual(whole[unmarkedLabel])

  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.reload()
  for (const [label, kmax, window] of [[firstLabel, "18", "parzen"], [secondLabel, "15", "kaiser"]]) {
    await select(page, label)
    await expect(page.getByLabel("k min (Å⁻¹)", { exact: true })).toHaveValue("5")
    await expect(page.getByLabel("k max (Å⁻¹)", { exact: true })).toHaveValue(kmax)
    await expect(page.getByLabel("Fit k window", { exact: true })).toHaveValue(window)
    await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(0)
  }
  await select(page, firstLabel)
  await expect(page.getByLabel("Parameter 1 value", { exact: true })).toHaveValue("0.65")
  await select(page, unmarkedLabel)
  await expect(page.getByLabel("k min (Å⁻¹)", { exact: true })).toHaveValue("3")
  await expect(page.getByLabel("k max (Å⁻¹)", { exact: true })).toHaveValue("12")
  expect(fits).toEqual([])
  expect(errors).toEqual([])
})
