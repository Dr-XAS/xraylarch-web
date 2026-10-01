import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import type { AthenaGroup, AthenaProject } from "../../lib/athena"

const measuredCu = readFileSync(fileURLToPath(new URL("../../../examples/xafsdata/cu_10k.xmu", import.meta.url)))

test.use({ actionTimeout: 15000 })

async function command(page: Page, action: string, trigger: () => Promise<unknown>) {
  const waiting = page.waitForResponse(response => response.url().endsWith("/command") &&
    response.request().postDataJSON().action === action)
  await trigger()
  const response = await waiting
  expect(response.ok(), await response.text()).toBe(true)
  return await response.json() as AthenaProject
}

function row(page: Page, group: AthenaGroup) {
  return page.locator(`.ath-group[data-group-id="${group.id}"]`)
}

function referenceLink(page: Page, sample: AthenaGroup, reference: AthenaGroup) {
  return row(page, sample).getByRole("button", {
    name: `View reference ${reference.label} for ${sample.label}`, exact: true,
  })
}

async function currentProject(page: Page, id: string) {
  const response = await page.request.get(`/api/backend/api/athena/projects/${id}`)
  expect(response.ok()).toBe(true)
  return await response.json() as AthenaProject
}

async function chooseReference(page: Page, reference: AthenaGroup, trigger: Locator) {
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Assign reference foil", exact: true })
  await dialog.getByRole("combobox", { name: "Reference foil", exact: true }).selectOption(reference.id)
  return dialog
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} copper demo shows a shared foil tree and opens its real spectrum`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto("/")
    const loaded = await command(page, "example", () =>
      page.getByRole("button", { name: "Load copper examples", exact: true }).click())
    expect(loaded.groups).toHaveLength(5)
    const samples = loaded.groups.filter(group => group.reference_id)
    expect(samples.length).toBeGreaterThanOrEqual(2)
    const reference = loaded.groups.find(group => group.id === samples[0].reference_id)!
    expect(reference).toBeDefined()
    expect(reference.reference_id).toBeNull()
    expect(reference.energy.length).toBeGreaterThan(100)
    expect(reference.mu.length).toBe(reference.energy.length)
    expect(samples.every(group => group.reference_id === reference.id)).toBe(true)
    for (const sample of samples) {
      await expect(referenceLink(page, sample, reference)).toBeVisible()
    }
    await expect(row(page, reference)).toHaveCount(1)
    const groups = page.locator("#athena-data-groups")
    if (mobile) {
      const listBounds = (await groups.locator(".ath-group-list").boundingBox())!
      const linkBounds = (await referenceLink(page, samples[0], reference).boundingBox())!
      expect(linkBounds.y).toBeGreaterThanOrEqual(listBounds.y)
      expect(linkBounds.y + linkBounds.height).toBeLessThanOrEqual(listBounds.y + listBounds.height + 1)
    }
    const bounds = (await groups.boundingBox())!
    await page.screenshot({ path: info.outputPath("shared-reference-tree.png"), animations: "disabled",
      clip: { ...bounds, height: Math.min(bounds.height, 760) } })
    expect(await groups.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)

    if (!mobile) {
      const saved = await page.request.post(`/api/backend/api/athena/projects/${loaded.id}/command`, { data: {
        version: loaded.version, action: "project", group_ids: [],
        options: { group_folders: [{ id: "reference-foils", name: "Reference foils", group_ids: [reference.id] }] },
      } })
      expect(saved.ok(), await saved.text()).toBe(true)
      await page.reload()
      await page.getByRole("button", { name: "Collapse Reference foils group", exact: true }).click()
      await expect(row(page, reference)).toHaveCount(0)
      await page.getByRole("textbox", { name: "Search groups", exact: true }).fill(samples[0].label)
    }
    await referenceLink(page, samples[0], reference).click()
    await expect(row(page, reference)).toHaveClass(/\bselected\b/)
    await expect(row(page, reference)).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Search groups", exact: true })).toHaveValue("")
    await expect(page.locator(".ath-param-current strong")).toContainText(reference.label)
    const plot = page.getByRole("region", { name: "Single spectrum viewer", exact: true })
      .getByLabel("E-space spectrum plot", { exact: true })
    await expect(plot.locator(".js-line").first()).toBeAttached()
    await expect.poll(() => plot.locator(".js-plotly-plot").evaluate(element =>
      (element as HTMLElement & { data: { name: string }[] }).data.map(trace => trace.name)))
      .toContain(reference.label)
    expect((await currentProject(page, loaded.id)).groups).toEqual(loaded.groups)

    const dialog = await chooseReference(page, reference, page.getByRole("button", {
      name: `Change reference for ${samples[0].label}`, exact: true,
    }))
    await expect(dialog.getByRole("checkbox", { name: `Link ${samples[0].label}`, exact: true })).toBeChecked()
    for (const sample of samples.slice(1)) {
      await expect(dialog.getByRole("checkbox", { name: `Link ${sample.label}`, exact: true })).not.toBeChecked()
    }
    await expect(dialog.getByRole("checkbox", { name: `Link ${reference.label}`, exact: true })).toBeDisabled()
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await dialog.screenshot({ path: info.outputPath("reference-assignment.png"), animations: "disabled" })
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    expect((await currentProject(page, loaded.id)).groups).toEqual(loaded.groups)
    expect(errors).toEqual([])
  })
}

test("assigns imported scans to one foil, removes only one link, and persists undo and redo", async ({ page }, info) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto("/")
  let imported!: AthenaProject
  for (const name of ["sample-A.xmu", "sample-B.xmu", "shared-Cu-reference.xmu"]) {
    await page.getByRole("button", { name: "Import data", exact: true }).click()
    await page.getByLabel("Choose data files", { exact: true }).setInputFiles({
      name, mimeType: "text/plain", buffer: measuredCu,
    })
    const importDialog = page.getByRole("dialog", { name: "Import spectra", exact: true })
    const waiting = page.waitForResponse(response => response.url().endsWith("/import"))
    await importDialog.getByRole("button", { name: "Import spectrum", exact: true }).click()
    const response = await waiting
    expect(response.ok(), await response.text()).toBe(true)
    imported = await response.json() as AthenaProject
    await expect(importDialog).toHaveCount(0)
  }
  const [first, second, reference] = imported.groups
  expect(imported.groups).toHaveLength(3)
  for (const group of imported.groups) {
    const mark = page.getByRole("checkbox", { name: `Mark ${group.label}`, exact: true })
    const marked = group.id !== reference.id
    if (await mark.isChecked() !== marked) {
      await command(page, "metadata", () => mark.setChecked(marked))
    }
  }
  const before = await currentProject(page, imported.id)
  const dialog = await chooseReference(page, reference,
    page.getByRole("button", { name: "Assign reference foil", exact: true }))
  await expect(dialog.getByRole("checkbox", { name: `Link ${first.label}`, exact: true })).toBeChecked()
  await expect(dialog.getByRole("checkbox", { name: `Link ${second.label}`, exact: true })).toBeChecked()
  await expect(dialog.getByRole("checkbox", { name: `Link ${reference.label}`, exact: true })).not.toBeChecked()
  await expect(dialog.getByRole("checkbox", { name: `Link ${reference.label}`, exact: true })).toBeDisabled()
  const assigned = await command(page, "assign_reference", () =>
    dialog.getByRole("button", { name: "Assign reference", exact: true }).click())
  await expect(dialog).toHaveCount(0)
  expect(assigned.groups.map(group => group.reference_id)).toEqual([reference.id, reference.id, null])
  for (let index = 0; index < before.groups.length; index++) {
    expect({ ...assigned.groups[index], reference_id: before.groups[index].reference_id }).toEqual(before.groups[index])
  }
  await expect(referenceLink(page, first, reference)).toBeVisible()
  await expect(referenceLink(page, second, reference)).toBeVisible()
  await page.locator("#athena-data-groups").screenshot({ path: info.outputPath("imported-shared-reference.png") })

  await page.getByRole("button", { name: `Change reference for ${first.label}`, exact: true }).click()
  await dialog.getByRole("combobox", { name: "Reference foil", exact: true })
    .selectOption({ label: "None — remove reference links" })
  await expect(dialog.getByRole("checkbox", { name: `Link ${first.label}`, exact: true })).toBeChecked()
  await expect(dialog.getByRole("checkbox", { name: `Link ${second.label}`, exact: true })).not.toBeChecked()
  const removed = await command(page, "assign_reference", () =>
    dialog.getByRole("button", { name: "Remove reference", exact: true }).click())
  expect(removed.groups.map(group => group.reference_id)).toEqual([null, reference.id, null])
  await expect(referenceLink(page, first, reference)).toHaveCount(0)
  await expect(referenceLink(page, second, reference)).toBeVisible()
  await expect(page.getByRole("button", { name: `Assign reference for ${first.label}`, exact: true })).toBeVisible()

  const undone = await command(page, "undo", () => page.getByRole("button", { name: "Undo", exact: true }).click())
  expect(undone.groups).toEqual(assigned.groups)
  await page.reload()
  await expect(referenceLink(page, first, reference)).toBeVisible()
  await expect(referenceLink(page, second, reference)).toBeVisible()
  expect((await currentProject(page, assigned.id)).groups).toEqual(assigned.groups)
  const redone = await command(page, "redo", () => page.getByRole("button", { name: "Redo", exact: true }).click())
  expect(redone.groups).toEqual(removed.groups)
  await page.reload()
  await expect(referenceLink(page, first, reference)).toHaveCount(0)
  await expect(referenceLink(page, second, reference)).toBeVisible()
  expect((await currentProject(page, assigned.id)).groups).toEqual(removed.groups)
  expect(errors).toEqual([])
})
