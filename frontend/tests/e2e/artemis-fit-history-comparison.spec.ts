import { readFile } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"
import type { ArtemisExample, ArtemisModelDraft } from "../../lib/artemis"

async function savedFits(page: Page) {
  const created = await page.request.post("/api/backend/api/athena/projects", { data: { name: "Saved Cu2O fit comparison" } })
  expect(created.ok()).toBe(true)
  let project = await created.json() as AthenaProject
  const examples = await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`, {
    data: { version: project.version, action: "example" },
  })
  expect(examples.ok()).toBe(true)
  project = await examples.json() as AthenaProject
  const groupId = project.groups.find(group => group.label === "Cu₂O · room temperature")!.id
  const response = await page.request.get("/api/backend/api/artemis/examples/cuprite")
  expect(response.ok()).toBe(true)
  const example = await response.json() as ArtemisExample
  const model: ArtemisModelDraft = {
    revision: 0,
    parameters: example.parameters.map((parameter, i) => ({ ...parameter, id: `parameter-${i}`,
      value: String(parameter.value), min: parameter.min === null ? "" : String(parameter.min), max: parameter.max === null ? "" : String(parameter.max) })),
    paths: example.paths.map((path, i) => ({ ...path, id: `path-${i}`, label: path.filename, enabled: true,
      s02: "amp", e0: "del_e0", deltar: "del_r", sigma2: "sig2", ...example.path_parameters?.[i] })),
    transform: { ...example.transform, kmin: String(example.transform.kmin), kmax: String(example.transform.kmax),
      dk: String(example.transform.dk), rmin: String(example.transform.rmin), rmax: String(example.transform.rmax), dr: String(example.transform.dr) },
  }
  for (const kmax of ["12", "10"]) {
    model.transform.kmax = kmax
    const fit = await page.request.post(`/api/backend/api/artemis/projects/${project.id}/groups/${groupId}/fit-saved`, {
      data: { version: project.version, model },
    })
    expect(fit.ok()).toBe(true)
    project = (await fit.json()).project as AthenaProject
  }
  const history = project.groups.find(group => group.id === groupId)!.artemis!.history
  expect(history).toHaveLength(2)
  expect(history.every(fit => fit.result.success)).toBe(true)
  await page.addInitScript(id => localStorage.setItem("athena.project", id), project.id)
  await page.goto("/")
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(page.getByRole("combobox", { name: "Saved fit history", exact: true })).toHaveValue(history[1].id)
  // Finish the initial plot-transform reads before measuring comparison requests.
  await page.waitForLoadState("networkidle")
  return { project, groupId, history }
}

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} saved fit comparison preserves real Cu2O fits and exports archived values`, async ({ page }, info) => {
  test.setTimeout(180_000)
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1500, height: 1040 })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const { project, groupId, history } = await savedFits(page)
  const writes: string[] = []
  page.on("request", request => {
    if (request.url().includes("/api/backend/") && request.method() !== "GET") writes.push(`${request.method()} ${request.url()}`)
  })
  await page.getByRole("button", { name: "Compare saved fits", exact: true }).click()
  const comparison = page.getByRole("region", { name: "Saved fit comparison", exact: true })
  await expect(comparison).toBeVisible()
  await expect(comparison.getByRole("combobox", { name: "Reference saved fit", exact: true })).toHaveValue(history[1].id)
  await comparison.getByRole("combobox", { name: "Reference saved fit", exact: true }).selectOption(history[0].id)
  await expect(comparison.getByRole("combobox", { name: "Comparison saved fit", exact: true })).toHaveValue(history[1].id)
  const downloading = page.waitForEvent("download")
  await comparison.getByRole("button", { name: "Download fit comparison JSON", exact: true }).click()
  const output = info.outputPath("fit-comparison.json")
  await (await downloading).saveAs(output)
  const report = JSON.parse(await readFile(output, "utf8"))
  expect(report.project_id).toBe(project.id)
  expect(report.version).toBe(project.version)
  expect(report.group_id).toBe(groupId)
  expect(report.baseline.id).toBe(history[0].id)
  expect(report.comparison.id).toBe(history[1].id)
  expect(report.same_input).toBe(true)
  expect(report.baseline.transform.kmax).toBe(12)
  expect(report.comparison.transform.kmax).toBe(10)
  expect(report.baseline.statistics.r_factor).toBe(history[0].result.statistics.r_factor)
  expect(report.comparison.statistics.r_factor).toBe(history[1].result.statistics.r_factor)
  const firstPath = history[0].result.paths[0]
  const nextPath = history[1].result.paths.find(path => path.id === firstPath.id)!
  const path = report.path_changes.find((item: { id: string }) => item.id === firstPath.id)
  expect(path.match).toBe("same_feff")
  expect(path.delta_r).toBeCloseTo(nextPath.metadata.reff + nextPath.values!.deltar - firstPath.metadata.reff - firstPath.values!.deltar, 12)
  expect(report.baseline).not.toHaveProperty("k")
  expect(JSON.stringify(report)).not.toContain('"content":')
  await expect(page.getByRole("combobox", { name: "Saved fit history", exact: true })).toHaveValue(history[1].id)
  expect(await comparison.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await comparison.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath(`fit-comparison-${mobile ? "mobile" : "desktop"}.png`) })
  expect(await (await page.request.get(`/api/backend/api/athena/projects/${project.id}`)).json()).toEqual(project)
  expect(writes).toEqual([])
  expect(errors).toEqual([])
})
