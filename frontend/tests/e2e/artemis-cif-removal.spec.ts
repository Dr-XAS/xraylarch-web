import { expect, test, type Page } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

const cuprite = (project: AthenaProject) => project.groups.find(group => group.label === "Cu₂O · room temperature")!

async function projectCommand(page: Page, action: "undo" | "redo") {
  const response = page.waitForResponse(result => result.url().endsWith("/command") && result.request().postDataJSON().action === action)
  await page.getByRole("button", { name: action === "undo" ? "Undo" : "Redo", exact: true }).click()
  const result = await response
  expect(result.ok()).toBe(true)
  return await result.json() as AthenaProject
}

test("visible CIF removal persists without changing FEFF paths and can be undone", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  const exampleResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const initial = await (await exampleResponse).json() as AthenaProject
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)

  // Save explicitly when using the manual model editor; autosave also supports this flow.
  const saveModel = page.getByRole("button", { name: "Save model to project", exact: true })
  if (await saveModel.count()) {
    const modelResponse = page.waitForResponse(response => response.url().endsWith("/model") && response.request().method() === "POST")
    await saveModel.click()
    expect((await modelResponse).ok()).toBe(true)
  }
  const savedProject = async () => await (await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json() as AthenaProject
  await expect.poll(async () => cuprite(await savedProject()).artemis?.model.paths.length).toBe(4)
  const baseline = await savedProject()
  const attachment = baseline.artemis_structures!.find(item => item.structure.mineral === "Cuprite")!
  const structures = page.getByRole("region", { name: "Project CIF structures", exact: true })
  const removeName = "Remove Cuprite CIF from project"
  const remove = structures.getByRole("button", { name: removeName, exact: true })
  const open = structures.getByRole("button", { name: "Open attached Cuprite CIF", exact: true })
  await expect(remove).toBeVisible()
  await expect(remove).toHaveText("Remove CIF")
  await expect(remove.locator("svg")).toBeVisible()
  await expect(open).toBeVisible()
  const removeBounds = (await remove.boundingBox())!
  const openBounds = (await open.boundingBox())!
  expect(Math.abs(removeBounds.y - openBounds.y)).toBeLessThanOrEqual(1)
  expect(removeBounds.x).toBeGreaterThanOrEqual(openBounds.x + openBounds.width)
  await structures.screenshot({ path: info.outputPath("cif-remove-desktop.png") })

  const removeResponse = page.waitForResponse(response => response.url().endsWith(`/structures/${attachment.id}/remove`))
  await remove.click()
  const removedResponse = await removeResponse
  expect(removedResponse.ok()).toBe(true)
  expect(removedResponse.request().postDataJSON()).toEqual({ version: baseline.version })
  const removed = await removedResponse.json() as AthenaProject
  expect(removed.artemis_structures?.some(item => item.id === attachment.id)).toBe(false)
  expect(cuprite(removed).artemis).toEqual(cuprite(baseline).artemis)
  await expect(remove).toHaveCount(0)
  await expect(structures.getByText("No CIF structures attached to this project.", { exact: true })).toBeVisible()
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)

  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(remove).toHaveCount(0)
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  const reloaded = await savedProject()
  expect(reloaded.artemis_structures?.some(item => item.id === attachment.id)).toBe(false)
  expect(cuprite(reloaded).artemis).toEqual(cuprite(baseline).artemis)

  const undone = await projectCommand(page, "undo")
  expect(undone.artemis_structures).toEqual(baseline.artemis_structures)
  expect(cuprite(undone).artemis).toEqual(cuprite(baseline).artemis)
  await expect(remove).toBeVisible()
  const redone = await projectCommand(page, "redo")
  expect(redone.artemis_structures).toEqual(removed.artemis_structures)
  expect(cuprite(redone).artemis).toEqual(cuprite(baseline).artemis)
  await expect(remove).toHaveCount(0)
  await projectCommand(page, "undo")
  await expect(remove).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await remove.scrollIntoViewIfNeeded()
  const mobileBounds = (await remove.boundingBox())!
  expect(mobileBounds.x).toBeGreaterThanOrEqual(0)
  expect(mobileBounds.x + mobileBounds.width).toBeLessThanOrEqual(391)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await structures.screenshot({ path: info.outputPath("cif-remove-mobile.png") })

  await structures.getByRole("button", { name: "Search / attach CIF", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Crystal structures & FEFF paths", exact: true })
  const modalRemove = dialog.getByRole("button", { name: removeName, exact: true })
  await expect(modalRemove).toBeVisible()
  await expect(modalRemove).toHaveText("Remove CIF")
  await expect(modalRemove.locator("svg")).toBeVisible()
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await dialog.screenshot({ path: info.outputPath("cif-remove-modal-mobile.png") })
  const modalRemoveResponse = page.waitForResponse(response => response.url().endsWith(`/structures/${attachment.id}/remove`))
  await modalRemove.click()
  const modalRemovedResponse = await modalRemoveResponse
  expect(modalRemovedResponse.ok()).toBe(true)
  const modalRemoved = await modalRemovedResponse.json() as AthenaProject
  expect(cuprite(modalRemoved).artemis).toEqual(cuprite(baseline).artemis)
  await expect(modalRemove).toHaveCount(0)
  await dialog.getByRole("button", { name: "Close CIF search", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  expect(errors).toEqual([])
})

test("CIF removal waits for an in-flight model save and uses its committed revision", async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  const exampleResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const initial = await (await exampleResponse).json() as AthenaProject
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  const savedProject = async () => await (await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json() as AthenaProject
  await expect.poll(async () => cuprite(await savedProject()).artemis?.model.paths.length).toBe(4)
  const baseline = await savedProject()
  const group = cuprite(baseline)
  const attachment = baseline.artemis_structures!.find(item => item.structure.mineral === "Cuprite")!

  let releaseSave!: () => void
  let receiveCommitted!: (project: AthenaProject) => void
  const saveReleased = new Promise<void>(resolve => { releaseSave = resolve })
  const modelCommitted = new Promise<AthenaProject>(resolve => { receiveCommitted = resolve })
  const modelEndpoint = `/api/backend/api/artemis/projects/${initial.id}/groups/${group.id}/model`
  await page.route(`**${modelEndpoint}`, async route => {
    // The server has saved the edit, but the browser still has the previous revision.
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    receiveCommitted(await response.json() as AthenaProject)
    await saveReleased
    await route.fulfill({ response })
  }, { times: 1 })
  const removalRequests: number[] = []
  page.on("request", request => {
    if (request.url().endsWith(`/structures/${attachment.id}/remove`)) removalRequests.push(request.postDataJSON().version)
  })
  await page.getByLabel("Parameter 1 value", { exact: true }).fill("0.87")
  const committed = await modelCommitted
  expect(committed.version).toBeGreaterThan(baseline.version)
  expect(cuprite(committed).artemis!.model.parameters[0].value).toBe("0.87")
  const remove = page.getByRole("region", { name: "Project CIF structures", exact: true }).getByRole("button", { name: "Remove Cuprite CIF from project", exact: true })
  const removalResponse = page.waitForResponse(response => response.url().endsWith(`/structures/${attachment.id}/remove`))
  try {
    await remove.click()
    await expect(remove).toHaveText("Removing CIF…")
    await expect(remove).toBeDisabled()
    // Keep the committed save response held long enough to expose a premature remove request.
    await page.waitForTimeout(300)
    expect(removalRequests).toEqual([])
  } finally {
    releaseSave()
  }
  const response = await removalResponse
  expect(response.ok()).toBe(true)
  expect(removalRequests).toEqual([committed.version])
  const removed = await response.json() as AthenaProject
  expect(removed.artemis_structures?.some(item => item.id === attachment.id)).toBe(false)
  expect(cuprite(removed).artemis).toEqual(cuprite(committed).artemis)
  await expect(remove).toHaveCount(0)
  await expect(page.getByLabel("Parameter 1 value", { exact: true })).toHaveValue("0.87")
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  const undone = await projectCommand(page, "undo")
  expect(undone.artemis_structures).toEqual(baseline.artemis_structures)
  expect(cuprite(undone).artemis).toEqual(cuprite(committed).artemis)
  await expect(remove).toBeVisible()
  expect(errors).toEqual([])
})
