import { expect, test } from "@playwright/test"
import { readFile, writeFile } from "node:fs/promises"
import type { AthenaProject } from "../../lib/athena"

test("real EXAFS fit has a readable report and preserves original downloads", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  const fits: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => {
    if (/\/fit(?:-saved)?$/.test(request.url())) fits.push(request.url())
  })
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  await page.getByRole("radio", { name: "Light theme", exact: true }).click()
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  const fitting = page.waitForResponse(response => response.url().endsWith("/fit-saved"))
  await page.getByRole("button", { name: "Run EXAFS fit", exact: true }).click()
  const response = await fitting
  expect(response.ok()).toBe(true)
  const fitted = (await response.json()).project as AthenaProject
  const group = fitted.groups.find(item => item.label === "Cu₂O · room temperature")!
  const record = group.artemis!.history.at(-1)!
  const result = record.result
  expect(result.success).toBe(true)

  const report = page.getByRole("region", { name: "Fit report", exact: true })
  await expect(report.getByRole("heading", { name: "Fit report", exact: true })).toBeVisible()
  await expect(report.getByText("Converged", { exact: true })).toBeVisible()
  await expect(report.getByText("R factor", { exact: true })).toBeVisible()
  await expect(report.getByText("Independent points", { exact: true })).toBeVisible()
  await expect(report.getByText(String(Number(result.statistics.r_factor!.toPrecision(5))), { exact: true })).toBeVisible()
  const parameters = report.getByRole("table", { name: "Fitted parameters", exact: true })
  await expect(parameters.getByRole("row")).toHaveCount(result.parameters.length + 1)
  for (const parameter of result.parameters) {
    await expect(parameters.getByRole("rowheader", { name: parameter.name, exact: true })).toBeVisible()
  }
  await expect(report.getByRole("heading", { name: /^Fitted paths\b/ })).toBeVisible()
  await expect(report.getByLabel("Fitted path lengths and disorder").getByRole("row")).toHaveCount(result.paths.length + 1)

  const rawText = report.getByLabel("Original Larch fit report", { exact: true })
  await expect(rawText).toBeHidden()
  const screenshotStyle = "nextjs-portal { visibility: hidden; }"
  await report.screenshot({ path: info.outputPath("fit-report-desktop.png"), style: screenshotStyle })
  await report.locator("summary").filter({ hasText: "Larch fit report" }).click()
  await expect(rawText).toBeVisible()
  expect(await rawText.textContent()).toBe(result.report)
  const downloading = page.waitForEvent("download")
  await report.getByRole("button", { name: "Download report", exact: true }).click()
  const reportPath = info.outputPath("artemis-fit-report.txt")
  await (await downloading).saveAs(reportPath)
  expect(await readFile(reportPath, "utf8")).toBe(result.report)
  await report.locator("summary").filter({ hasText: "Larch fit report" }).click()
  await expect(rawText).toBeHidden()

  const modelDownloading = page.waitForEvent("download")
  await report.getByRole("button", { name: "Download fit + model JSON", exact: true }).click()
  const modelPath = info.outputPath("artemis-fit.json")
  await (await modelDownloading).saveAs(modelPath)
  const bundle = JSON.parse(await readFile(modelPath, "utf8"))
  expect(bundle.schema).toBe("artemis-web/v1")
  expect(bundle.source).toEqual({ project_id: fitted.id, group_id: group.id, group_label: group.label })
  // JSON.stringify normalizes Python's negative-zero coordinates to zero.
  expect(bundle.result).toMatchObject(JSON.parse(JSON.stringify(result)))
  expect(bundle.request.paths.map((path: { content: string }) => path.content)).toEqual(record.model.paths.filter(path => path.enabled).map(path => path.content))
  expect(bundle.request.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(record.model.parameters.map(parameter => parameter.name))
  expect(bundle.request.transform).toEqual(result.transform)

  await report.locator("summary").filter({ hasText: "Fit settings & statistics" }).click()
  await expect(report.getByText("Akaike criterion (AIC)", { exact: true })).toBeVisible()
  await report.locator("summary").filter({ hasText: "Fit settings & statistics" }).click()
  await report.locator("summary").filter({ hasText: /^Parameter correlations/ }).click()
  await report.locator("summary").filter({ hasText: /^Parameter correlations/ }).click()

  await page.getByRole("radio", { name: "Dark theme", exact: true }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await report.screenshot({ path: info.outputPath("fit-report-dark.png"), style: screenshotStyle })
  await page.getByRole("radio", { name: "Light theme", exact: true }).click()
  await page.setViewportSize({ width: 1100, height: 1000 })
  await report.getByRole("heading", { name: "Fit report", exact: true }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(await report.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await report.screenshot({ path: info.outputPath("fit-report-narrow-desktop.png"), style: screenshotStyle })
  await page.setViewportSize({ width: 390, height: 844 })
  await report.getByRole("heading", { name: "Fit report", exact: true }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(await report.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const tableWidths = await report.locator('[role="region"]:has(> table)').evaluateAll(elements => elements.map(element => ({
    label: element.getAttribute("aria-label"), width: element.clientWidth, scrollWidth: element.scrollWidth,
  })))
  await writeFile(info.outputPath("mobile-table-widths.json"), JSON.stringify(tableWidths, null, 2))
  for (const table of tableWidths.filter(item => item.label === "Fitted parameter values" || item.label === "Fitted path lengths and disorder")) {
    expect(table.scrollWidth, table.label ?? "Table").toBeLessThanOrEqual(table.width + 1)
  }
  await report.screenshot({ path: info.outputPath("fit-report-mobile.png"), style: screenshotStyle })
  await report.locator("summary").filter({ hasText: "Larch fit report" }).click()
  await expect(rawText).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(fits).toHaveLength(1)
  expect(errors).toEqual([])
})
