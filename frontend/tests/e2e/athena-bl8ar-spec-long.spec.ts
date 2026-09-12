import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator, type Page } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`, import.meta.url))
const oracle = (name: string): number[][] => JSON.parse(gunzipSync(readFileSync(fixture(`athena-bl8ar-spec-${name}-native.json.gz`))).toString()).columns
async function curve(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node => {
    const data = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data
    return data.map(t => ({ x: [...t.x], y: [...t.y] }))
  })
}
async function signal(plot: Locator, x: number[], y: number[], index = 0) {
  await expect.poll(async () => (await curve(plot))[index]?.x).toEqual(x)
  await expect.poll(async () => {
    const actual = (await curve(plot))[index]?.y ?? []
    return actual.length === y.length ? Math.max(...actual.map((v, i) => Math.abs(v-y[i]))) : Infinity
  }).toBeLessThan(1e-10)
}
async function registry(page: Page, reader: string) {
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Plugin registry', exact: true })
  const toggle = panel.getByRole('checkbox', { name: `Enable ${reader}`, exact: true })
  await expect(toggle).toBeEnabled()
  if (!await toggle.isChecked()) {
    const enabling = page.waitForResponse(r => r.url().endsWith('/preferences/plugins') && r.request().method() === 'PUT')
    await toggle.click(); expect((await enabling).ok()).toBe(true); await expect(toggle).toBeChecked()
  }
  return panel
}
async function inspect(page: Page, files: string[]) {
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  const inspected = page.waitForResponse(r => r.url().endsWith('/inspect'))
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles(files.map(fixture))
  const response = await inspected; expect(response.ok()).toBe(true)
  return response.json()
}
async function restore(page: Page, path: string) {
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await page.getByLabel('Open project file', { exact: true }).setInputFiles(path)
  const restoring = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
  await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
  const response = await restoring; expect(response.ok()).toBe(true)
  return response.json()
}

test('BL8Ar fits, per-file review, live Ge13 and reference columns, batch import and PRJ exchange', async ({ page }, info) => {
  test.setTimeout(90000)
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  const panel = await registry(page, 'BL8Ar')
  await panel.getByRole('button', { name: 'Configure BL8Ar', exact: true }).click()
  const editor = panel.getByRole('region', { name: 'BL8Ar configuration', exact: true })
  await expect(editor.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  await editor.getByRole('button', { name: 'Use Athena defaults' }).click()
  await editor.getByRole('checkbox', { name: 'Review I0 correction before import', exact: true }).check()
  const applying = page.waitForResponse(r => r.url().endsWith('/configuration') && r.request().method() === 'PUT')
  await editor.getByRole('button', { name: 'Apply and Save', exact: true }).click()
  expect((await applying).ok()).toBe(true)
  await expect(editor.getByText(/Applied and saved/)).toBeVisible()
  await panel.getByRole('button', { name: 'Close registry', exact: true }).click()
  const inspected = await inspect(page, ['constructed-bl8ar-ge.dat', 'constructed-bl8ar-ge.dat'])
  const dialog = page.getByRole('dialog', { name: 'Import spectra', exact: true })
  const i0Plot = dialog.getByLabel('I0 correction plot', { exact: true })
  await expect.poll(async () => (await curve(i0Plot)).length).toBe(4)
  expect((await curve(i0Plot)).map(t => t.y)).toEqual(inspected.reader_preview.traces.map((t: { y: number[] }) => t.y))
  await expect(dialog.getByRole('button', { name: 'Import spectrum', exact: true })).toBeDisabled()
  await i0Plot.scrollIntoViewIfNeeded(); await dialog.screenshot({ path: info.outputPath('bl8ar-i0-review.png') })
  const approve = dialog.getByRole('checkbox', { name: 'I reviewed the I0 correction for this file', exact: true })
  await expect(approve).toBeEnabled(); await approve.check()
  await expect(i0Plot).toHaveCount(0)
  const plot = dialog.getByLabel('Imported signal preview plot', { exact: true })
  const rows = oracle('ge'), x = rows.map(r => r[0])
  await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
  await signal(plot, x, rows.map(r => r.slice(6, 10).reduce((a, b) => a+b, 0)/r[3]))
  for (const column of inspected.columns.slice(10, 19)) await dialog.getByRole('checkbox', { name: `Numerator ${column.name}`, exact: true }).check()
  const y = rows.map(r => r.slice(6, 19).reduce((a, b) => a+b, 0)/r[3])
  await signal(plot, x, y)
  await dialog.getByText('Reference channel & ordering', { exact: true }).click()
  await dialog.getByRole('combobox', { name: 'reference numerator', exact: true }).selectOption(inspected.columns[5].column_id)
  await dialog.getByRole('checkbox', { name: 'Reference natural log', exact: true }).uncheck()
  await dialog.getByRole('combobox', { name: 'Data type', exact: true }).selectOption('xanes')
  await signal(plot, x, rows.map(r => r[5]), 1)
  const reuse = dialog.getByRole('checkbox', { name: 'Reuse this mapping for remaining files with matching column labels', exact: true })
  await reuse.check()
  await dialog.getByText(/^Source file contents/).click()
  const downloading = page.waitForEvent('download')
  await dialog.getByRole('link', { name: 'Download original file', exact: true }).click()
  const source = info.outputPath('bl8ar-original.dat'); await (await downloading).saveAs(source)
  expect(readFileSync(source)).toEqual(readFileSync(fixture('constructed-bl8ar-ge.dat')))
  await dialog.getByText(/^Source file contents/).click()
  const importing = page.waitForResponse(r => r.url().endsWith('/import'))
  const nextInspection = page.waitForResponse(r => r.url().endsWith('/inspect'))
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const response = await importing; expect(response.ok()).toBe(true)
  const project = await response.json(); expect(project.groups).toHaveLength(2)
  expect(project.groups[0].processing_error).toBeNull()
  project.groups[0].mu.forEach((v: number, i: number) => expect(Math.abs(v-y[i])).toBeLessThan(1e-10))
  expect(project.groups[0].source.mapping.reader_reviewed).toBe(true)
  expect((await nextInspection).ok()).toBe(true)
  await expect(approve).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Import spectrum', exact: true })).toBeDisabled()
  await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
  await expect(approve).toBeEnabled(); await approve.check()
  const again = page.waitForResponse(r => r.url().endsWith('/import'))
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const second = await again; expect(second.ok()).toBe(true)
  const finished = await second.json(); expect(finished.groups).toHaveLength(4)
  const saving = page.waitForEvent('download'); await page.getByRole('link', { name: 'Save project', exact: true }).click()
  const prj = info.outputPath('bl8ar.prj'); await (await saving).saveAs(prj)
  const restored = await restore(page, prj)
  expect(restored.groups).toHaveLength(8)
  expect(restored.groups[4].source).toEqual(finished.groups[0].source)
  expect(restored.groups[4].result.arrays).toEqual(finished.groups[0].result.arrays)
  expect(errors).toEqual([])
})

test('SPEC long labels keep exact converted bytes and editable native columns on mobile', async ({ page }, info) => {
  test.setTimeout(60000)
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/')
  const panel = await registry(page, 'SpecFileLongLine')
  await panel.getByRole('button', { name: 'Close registry', exact: true }).click()
  const inspected = await inspect(page, ['constructed-spec-long.dat'])
  expect(inspected.columns).toHaveLength(60)
  const dialog = page.getByRole('dialog', { name: 'Import spectra', exact: true })
  await dialog.getByRole('button', { name: 'Use transmission columns', exact: true }).click()
  const plot = dialog.getByLabel('Imported signal preview plot', { exact: true }), rows = oracle('spec'), x = rows.map(r => r[0])
  await signal(plot, x, rows.map(r => Math.log(Math.abs(r[55]/r[56]))))
  await dialog.getByRole('checkbox', { name: `Denominator ${inspected.columns[56].name}`, exact: true }).uncheck()
  await dialog.getByRole('checkbox', { name: `Denominator ${inspected.columns[54].name}`, exact: true }).check()
  const y = rows.map(r => Math.log(Math.abs(r[55]/r[54])))
  await signal(plot, x, y)
  await plot.scrollIntoViewIfNeeded(); await dialog.screenshot({ path: info.outputPath('spec-long-mobile.png') })
  await dialog.getByText(/^Converted columns/).click()
  const download = page.waitForEvent('download'); await dialog.getByRole('link', { name: 'Download converted file', exact: true }).click()
  const converted = info.outputPath('spec-converted.dat'); await (await download).saveAs(converted)
  const original = readFileSync(fixture('constructed-spec-long.dat'), 'utf8')
  expect(readFileSync(converted, 'utf8')).toBe(original.split(/(?<=\n)/).filter(line => !line.startsWith('#L')).join(''))
  await dialog.getByRole('combobox', { name: 'Data type', exact: true }).selectOption('xanes')
  const importing = page.waitForResponse(r => r.url().endsWith('/import'))
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const response = await importing; expect(response.ok()).toBe(true)
  const group = (await response.json()).groups[0]
  group.mu.forEach((v: number, i: number) => expect(Math.abs(v-y[i])).toBeLessThan(1e-10))
  expect(Object.keys(group.source.column_arrays)).toHaveLength(60)
})
