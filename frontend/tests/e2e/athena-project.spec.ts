import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const native = path.join(root, "examples/xafsdata/AthenaProjectFiles")
const examples = [
  { file: path.join(native, "cu.prj"), count: 3 },
  { file: path.join(native, "zirconolite.prj"), count: 9 },
  { file: path.join(root, "backend/tests/fixtures/demeter-athena-json.prj"), count: 17 },
]

for (const example of examples) {
  test(`ordinary import, plots and saved-project roundtrip: ${path.basename(example.file)}`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Import data", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Import data", exact: true }).click()
    await page.getByLabel("Choose data files", { exact: true }).setInputFiles(example.file)
    const dialog = page.getByRole("dialog", { name: "Open a project" })
    await expect(dialog.getByRole("button", { name: "Import all groups", exact: true })).toBeEnabled()
    await dialog.getByLabel("Preview signal").selectOption("norm")
    await expect(dialog.locator(".js-line").first()).toBeVisible()
    await expect(dialog.getByRole("alert")).toHaveCount(0)
    const restored = page.waitForResponse(r => r.url().endsWith("/restore-upload"))
    await dialog.getByRole("button", { name: "Import all groups", exact: true }).click()
    const response = await restored
    expect(response.ok()).toBeTruthy()
    const original = await response.json()
    expect(original.groups).toHaveLength(example.count)
    expect(original.groups.every((g: { processing_error: unknown }) => g.processing_error === null)).toBeTruthy()
    await expect(dialog).toHaveCount(0)
    for (const [name, space] of [["E Energy", "E"], ["k EXAFS", "k"], ["R Fourier", "R"], ["q Back transform", "q"]]) {
      await page.getByRole("tab", { name, exact: true }).click()
      await expect(page.getByLabel(`${space}-space spectrum plot`, { exact: true }).locator(".js-line").first()).toBeVisible()
    }
    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("link", { name: "Save project", exact: true }).click()
    const downloaded = await downloadPromise
    const saved = info.outputPath("roundtrip.prj")
    await downloaded.saveAs(saved)
    await page.getByRole("button", { name: "Open project", exact: true }).click()
    await page.getByLabel("Open project file", { exact: true }).setInputFiles(saved)
    await expect(dialog.getByRole("button", { name: "Import all groups", exact: true })).toBeEnabled()
    const roundtrip = page.waitForResponse(r => r.url().endsWith("/restore-upload"))
    await dialog.getByRole("button", { name: "Import all groups", exact: true }).click()
    const reread = await (await roundtrip).json()
    expect(reread.groups).toHaveLength(example.count * 2)
    for (let i = 0; i < example.count; i++) {
      expect(reread.groups[example.count + i].energy).toEqual(original.groups[i].energy)
      expect(reread.groups[example.count + i].mu).toEqual(original.groups[i].mu)
      expect(reread.groups[example.count + i].parameters).toEqual(original.groups[i].parameters)
      expect(reread.groups[example.count + i].result.arrays).toEqual(original.groups[i].result.arrays)
    }
    await page.reload()
    await expect(page.getByRole("heading", { name: `Data groups ${example.count * 2}`, exact: true })).toBeVisible()
  })
}

test("mixed raw/project/raw batch keeps order through both import panels", async ({ page }) => {
  test.setTimeout(90000)
  await page.goto("/")
  await page.getByRole("button", { name: "Import data", exact: true }).click()
  await page.getByLabel("Choose data files", { exact: true }).setInputFiles([
    path.join(root, "examples/xafsdata/cu_10k.xmu"), examples[0].file,
    path.join(root, "examples/xafsdata/cu_50k.xmu"),
  ])
  await page.getByRole("button", { name: "Import spectrum", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Open a project" })
  await expect(dialog.getByRole("button", { name: "Import all groups", exact: true })).toBeEnabled()
  await dialog.getByRole("button", { name: "Import all groups", exact: true }).click()
  await expect(page.getByRole("button", { name: "Import spectrum", exact: true })).toBeEnabled()
  const accepted = page.waitForResponse(r => r.url().endsWith("/import"))
  await page.getByRole("button", { name: "Import spectrum", exact: true }).click()
  const project = await (await accepted).json()
  expect(project.groups.map((g: { label: string }) => g.label)).toEqual([
    "cu_10k.xmu", "cu010k.dat", "cu050k.dat", "cu150k.dat", "cu_50k.xmu",
  ])
  await expect(page.getByRole("heading", { name: "Data groups 5", exact: true })).toBeVisible()
})
