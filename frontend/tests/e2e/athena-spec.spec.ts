import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ScanInspectionResponse } from '../../lib/contracts'

const fixture = fileURLToPath(new URL('../../../backend/tests/fixtures/demeter-snbl.dat', import.meta.url))
const references: { scans: { columns: number[][] }[] } = JSON.parse(gunzipSync(readFileSync(
  fileURLToPath(new URL('../../../backend/tests/fixtures/athena-spec-native.json.gz', import.meta.url)))).toString())

async function curve(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node => {
    const c = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: [...c.x], y: [...c.y] }
  })
}

async function enable(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Plugin registry' })
  const checkbox = dialog.getByRole('checkbox', { name: 'Enable SPEC', exact: true })
  await expect(checkbox).toBeEnabled()
  if (!await checkbox.isChecked()) {
    const saved = page.waitForResponse(r => r.url().endsWith('/preferences/plugins') && r.request().method() === 'PUT')
    await checkbox.click(); expect((await saved).ok()).toBe(true); await expect(checkbox).toBeChecked()
  }
  await dialog.getByRole('button', { name: 'Close registry', exact: true }).click()
}

async function stage(page: Page, files = [fixture]) {
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  const picker = page.getByLabel('Choose data files', { exact: true }); await expect(picker).toBeEnabled()
  const inspected = page.waitForResponse(r => r.url().endsWith('/inspect'))
  await picker.setInputFiles(files)
  const response = await inspected; expect(response.ok()).toBe(true)
  const collection: ScanInspectionResponse = await response.json()
  expect(collection.kind).toBe('scan_list'); expect(collection.scans).toHaveLength(2)
  const panel = page.getByRole('region', { name: 'Scan selection', exact: true })
  await expect(panel.getByRole('button', { name: 'Review selected scans' })).toBeEnabled()
  return { collection, panel }
}

async function expectSignal(plot: Locator, index: number, invert = false) {
  const data = references.scans[index].columns
  const x = data.map(row => row[15] * 1000), y = data.map(row => (invert ? -1 : 1) * Math.log(row[7] / row[9]))
  await expect.poll(async () => (await curve(plot)).x).toEqual(x)
  await expect.poll(async () => Math.max(...(await curve(plot)).y.map((v, i) => Math.abs(v - y[i])))).toBeLessThan(1e-12)
  return { x, y }
}

async function review(page: Page, panel: Locator) {
  await panel.getByRole('button', { name: 'Review selected scans' }).click()
  const dialog = page.getByRole('dialog', { name: 'Import spectra' })
  await expect(dialog.getByRole('button', { name: 'Import spectrum', exact: true })).toBeEnabled()
  if (await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).count()) {
    await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).click()
  }
  await expect(dialog.getByLabel('Energy column')).toHaveValue('column_0016')
  await expect(dialog.getByLabel('Energy units')).toHaveValue('keV')
  await dialog.getByLabel('Invert signal', { exact: true }).check()
  return dialog
}

test('SPEC scan selection, actual column previews, both scans and PRJ roundtrip', async ({ page }, info) => {
  test.setTimeout(90000)
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await enable(page)
  const { collection, panel } = await stage(page)
  const plot = panel.getByLabel('Imported signal preview plot', { exact: true })
  await expectSignal(plot, 0)
  await panel.getByRole('button', { name: 'Preview Scan 2 · entry 2' }).click()
  await expectSignal(plot, 1)
  await panel.getByRole('button', { name: 'Select no scans' }).click()
  await expect(panel.getByRole('button', { name: 'Review selected scans' })).toBeDisabled()
  await panel.getByRole('button', { name: 'Invert scan selection' }).click()
  await expect(panel.getByLabel('Include Scan 1 · entry 1')).toBeChecked()
  await expect(panel.getByLabel('Include Scan 2 · entry 2')).toBeChecked()
  const download = page.waitForEvent('download'); await panel.getByRole('link', { name: 'Download original SPEC file' }).click()
  const original = info.outputPath('original.spec'); await (await download).saveAs(original)
  expect(readFileSync(original)).toEqual(readFileSync(fixture))
  await plot.scrollIntoViewIfNeeded()
  await page.getByRole('dialog').screenshot({ path: info.outputPath('scan-selection.png') })
  const dialog = await review(page, panel)
  const importedPlot = dialog.getByLabel('Imported signal preview plot', { exact: true })
  await expectSignal(importedPlot, 0, true)
  // The original fixed native energy column is constant in this sample.
  // Preview must show the selected constant axis, then restore ZapEnergy.
  await dialog.getByLabel('Energy column').selectOption('column_0013')
  await expect.poll(async () => (await curve(importedPlot)).x)
    .toEqual(references.scans[0].columns.map(row => row[12] * 1000))
  await dialog.getByLabel('Energy column').selectOption('column_0016')
  await expectSignal(importedPlot, 0, true)
  await importedPlot.scrollIntoViewIfNeeded()
  await dialog.screenshot({ path: info.outputPath('spec-columns.png') })
  const first = page.waitForResponse(r => r.url().endsWith('/import') && r.request().postDataJSON()?.upload_id === collection.scans[0].upload_id)
  const second = page.waitForResponse(r => r.url().endsWith('/import') && r.request().postDataJSON()?.upload_id === collection.scans[1].upload_id)
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  expect((await first).ok()).toBe(true)
  const response = await second; expect(response.ok()).toBe(true); const project = await response.json()
  expect(project.version).toBe(2); expect(project.groups).toHaveLength(2)
  for (const [index, group] of project.groups.entries()) {
    expect(group.processing_error).toBeNull()
    expect(group.source.file_plugin.scan.number).toBe(String(index + 1))
    expect(group.energy).toEqual(references.scans[index].columns.map(row => row[15] * 1000))
    group.mu.forEach((value: number, i: number) => expect(Math.abs(value + Math.log(references.scans[index].columns[i][7] / references.scans[index].columns[i][9]))).toBeLessThan(1e-12))
  }
  await expect(dialog).not.toBeVisible()
  const active = project.groups[1]
  for (const [tab, space, xkey, ykey] of [['E Energy', 'E', 'energy', 'norm'], ['k EXAFS', 'k', 'k', 'weighted_chi'],
    ['R Fourier', 'R', 'r', 'chir_mag'], ['q Back transform', 'q', 'q', 'chiq_mag']]) {
    await page.getByRole('tab', { name: tab, exact: true }).click()
    await expect.poll(() => curve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
      .toEqual({ x: active.result.arrays[xkey], y: active.result.arrays[ykey].map((v: number) => v === 0 ? 0 : v) })
  }
  const save = page.waitForEvent('download'); await page.getByRole('link', { name: 'Save project', exact: true }).click()
  const prj = info.outputPath('spec-roundtrip.prj'); await (await save).saveAs(prj)
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await page.getByLabel('Open project file', { exact: true }).setInputFiles(prj)
  const restored = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
  await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
  const result = await (await restored).json(); expect(result.groups).toHaveLength(4)
  for (let i = 0; i < 2; i++) {
    expect(result.groups[i+2].source).toEqual(project.groups[i].source)
    expect(result.groups[i+2].result.arrays).toEqual(project.groups[i].result.arrays)
  }
  await page.reload(); await expect(page.getByRole('heading', { name: 'Data groups 4', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('SPEC second-scan inspection retry preserves the first scan and continues into PRJ then raw data', async ({ page }) => {
  test.setTimeout(90000)
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await enable(page)
  const prj = fileURLToPath(new URL('../../../examples/xafsdata/AthenaProjectFiles/cu.prj', import.meta.url))
  const raw = fileURLToPath(new URL('../../../examples/xafsdata/cu_10k.xmu', import.meta.url))
  const { collection, panel } = await stage(page, [fixture, prj, raw])
  let rejected = false
  await page.route(`**/uploads/${collection.scans[1].upload_id}/inspection`, async route => {
    if (!rejected) {
      rejected = true
      await route.fulfill({ status: 503, json: { error: { code: 'test_retry', message: 'Temporary scan inspection failure', fields: [], recovery: 'Retry inspection.' } } })
    } else await route.continue()
  })
  const dialog = await review(page, panel)
  const imports: string[] = []; page.on('request', r => { if (r.url().endsWith('/import')) imports.push(r.postDataJSON().upload_id) })
  await expectSignal(dialog.getByLabel('Imported signal preview plot', { exact: true }), 0, true)
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Temporary scan inspection failure')
  expect(imports).toEqual([collection.scans[0].upload_id])
  await dialog.getByRole('button', { name: 'Retry file inspection', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Import spectrum', exact: true })).toBeEnabled()
  await expect(dialog.getByLabel('Invert signal')).toBeChecked()
  await expectSignal(dialog.getByLabel('Imported signal preview plot', { exact: true }), 1, true)
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const projectPanel = page.getByRole('dialog', { name: 'Open a project', exact: true })
  await expect(projectPanel.getByRole('button', { name: 'Import all groups', exact: true })).toBeEnabled()
  expect(imports).toEqual(collection.scans.map(scan => scan.upload_id))
  await projectPanel.getByRole('button', { name: 'Import all groups', exact: true }).click()
  await expect(dialog.getByText('cu_10k.xmu', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Import spectrum', exact: true })).toBeEnabled()
  // Native column memory retains sign even when detector labels change.
  // Review the actual preview before explicitly recovering the Cu suggestions.
  const rawData = readFileSync(raw, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => line.trim().split(/\s+/).map(Number))
  const rawPlot = dialog.getByLabel('Imported signal preview plot', { exact: true })
  await expect(dialog.getByLabel('Invert signal', { exact: true })).toBeChecked()
  await expect.poll(() => curve(rawPlot)).toEqual({ x: rawData.map(row => row[0]), y: rawData.map(row => -row[1]) })
  await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).click()
  await expect(dialog.getByLabel('Invert signal', { exact: true })).not.toBeChecked()
  await expect.poll(() => curve(rawPlot)).toEqual({ x: rawData.map(row => row[0]), y: rawData.map(row => row[1]) })
  const complete = page.waitForResponse(r => r.url().endsWith('/import'))
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const response = await complete; expect(response.ok()).toBe(true); const project = await response.json()
  expect(project.groups).toHaveLength(6)
  expect(project.groups.slice(0, 2).map((g: { source: { file_plugin: { scan: { number: string } } } }) => g.source.file_plugin.scan.number)).toEqual(['1', '2'])
  expect(project.groups.every((g: { processing_error: unknown }) => g.processing_error === null)).toBe(true)
  expect(project.groups[5].energy).toEqual(rawData.map(row => row[0]))
  expect(project.groups[5].mu).toEqual(rawData.map(row => row[1]))
  expect(imports).toHaveLength(3)
  await expect(dialog).not.toBeVisible()
  await page.reload(); await expect(page.getByRole('heading', { name: 'Data groups 6', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
