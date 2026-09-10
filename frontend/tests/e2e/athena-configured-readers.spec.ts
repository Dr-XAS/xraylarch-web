import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator, type Page } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`, import.meta.url))
async function curve(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node => {
    const trace = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: [...trace.x], y: [...trace.y] }
  })
}
async function signal(plot: Locator, rows: number[][], channels: number) {
  await expect.poll(async () => (await curve(plot)).x).toEqual(rows.map(row => row[0]))
  await expect.poll(async () => {
    const actual = (await curve(plot)).y, expected = rows.map(row => row.slice(2, 2 + channels).reduce((a, b) => a + b, 0) / row[1])
    return actual.length === expected.length ? Math.max(...actual.map((v, i) => Math.abs(v - expected[i]))) : Infinity
  }).toBeLessThan(1e-10)
}
async function registry(page: Page) {
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
  return page.getByRole('dialog', { name: 'Plugin registry', exact: true })
}
async function configure(panel: Locator, name: string) {
  await panel.getByRole('button', { name: `Configure ${name}`, exact: true }).click()
  const editor = panel.getByRole('region', { name: `${name} configuration`, exact: true })
  await expect(editor.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  return editor
}
async function apply(page: Page, editor: Locator, save: boolean) {
  const response = page.waitForResponse(r => r.url().endsWith('/configuration') && r.request().method() === 'PUT')
  await editor.getByRole('button', { name: save ? 'Apply and Save' : 'Apply', exact: true }).click()
  const result = await response; expect(result.ok()).toBe(true)
  await expect(editor.getByText(save ? /Applied and saved reader settings/ : /Applied for this server session/)).toBeVisible()
  return result.json()
}

for (const name of ['X15B', 'X23A2MED']) {
  test(`${name} configuration changes real preview columns, imports and survives PRJ exchange`, async ({ page }, info) => {
    test.setTimeout(90000)
    const manifest = JSON.parse(readFileSync(fixture(`athena-${name.toLowerCase()}-fixtures.json`), 'utf8'))
    const original = manifest.references.find((r: { name: string }) => r.name === 'defaults')
    const variant = manifest.references.find((r: { name: string }) => r.name === (name === 'X15B' ? 'comment-columns' : 'constant-time'))
    const columns = (ref: { file: string }): number[][] => {
      const data = JSON.parse(gunzipSync(readFileSync(fixture(ref.file))).toString())
      return name === 'X15B' ? data : data.columns
    }
    const before = columns(original), after = columns(variant), channels = name === 'X15B' ? 1 : 4
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    let panel = await registry(page)
    const toggle = panel.getByRole('checkbox', { name: `Enable ${name}`, exact: true })
    await expect(toggle).toBeEnabled()
    if (!await toggle.isChecked()) {
      const enabled = page.waitForResponse(r => r.url().endsWith('/preferences/plugins') && r.request().method() === 'PUT')
      await toggle.click(); expect((await enabled).ok()).toBe(true); await expect(toggle).toBeChecked()
    }
    let editor = await configure(panel, name)
    await editor.getByRole('button', { name: 'Use Athena defaults' }).click(); await apply(page, editor, true)
    await panel.getByRole('button', { name: 'Close registry', exact: true }).click()
    await page.getByRole('button', { name: 'Import data', exact: true }).click()
    const inspected = page.waitForResponse(r => r.url().endsWith('/inspect'))
    await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fixture(manifest.file.file))
    const inspection = await (await inspected).json()
    const dialog = page.getByRole('dialog', { name: 'Import spectra', exact: true })
    await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
    const plot = dialog.getByLabel('Imported signal preview plot', { exact: true })
    await signal(plot, before, channels)
    await dialog.getByRole('button', { name: 'File plugins…', exact: true }).click()
    panel = page.getByRole('dialog', { name: 'Plugin registry', exact: true }); editor = await configure(panel, name)
    if (name === 'X15B') {
      for (const [label, value] of [['I0 column', '7'], ['Narrow ROI column', '9'], ['Wide ROI column', '10'], ['Transmission column', '11']]) {
        await editor.getByRole('spinbutton', { name: label, exact: true }).fill(value)
      }
    } else {
      await editor.getByRole('combobox', { name: 'Integration time source', exact: true }).selectOption('constant')
      await editor.getByRole('spinbutton', { name: 'Constant integration time (s)', exact: true }).fill('2')
    }
    const applied = await apply(page, editor, name === 'X23A2MED')
    await editor.getByRole('heading').scrollIntoViewIfNeeded()
    await panel.screenshot({ path: info.outputPath('configuration.png') })
    await panel.getByRole('button', { name: 'Return to import', exact: true }).click()
    await signal(plot, before, channels) // Returning alone cannot reinterpret the staged upload.
    const reinspection = page.waitForResponse(r => r.url().endsWith('/inspect'))
    await dialog.getByRole('button', { name: 'Reinspect selected file', exact: true }).click()
    const next = await (await reinspection).json()
    expect(next.upload_id).not.toBe(inspection.upload_id)
    expect(next.file_plugin.configuration.values).toEqual(applied.values)
    await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
    await signal(plot, after, channels)
    if (name === 'X23A2MED') await expect(dialog.getByLabel('File conversion')).toContainText('Integration time: constant 2 s.')
    const sourceSummary = dialog.getByText(name === 'X15B' ? /^Binary source bytes \(hex\)( \(first section\))?$/ : /^Source file contents( \(first section\))?$/)
    await sourceSummary.click()
    const rawDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download original file', exact: true }).click()
    const raw = info.outputPath('original.dat'); await (await rawDownload).saveAs(raw)
    expect(readFileSync(raw)).toEqual(readFileSync(fixture(manifest.file.file))); await sourceSummary.click()
    const convertedSummary = dialog.getByText(/^Converted columns( \(first section\))?$/)
    await convertedSummary.click()
    const convertedDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download converted file', exact: true }).click()
    const converted = info.outputPath('converted.dat'); await (await convertedDownload).saveAs(converted)
    expect(readFileSync(converted, 'utf8').split('\n').filter(line => line.trim() && !line.startsWith('#'))
      .map(line => line.trim().split(/\s+/).map(Number))).toEqual(after)
    await convertedSummary.click()
    await plot.scrollIntoViewIfNeeded(); await dialog.screenshot({ path: info.outputPath('configured-preview.png') })
    const imported = page.waitForResponse(r => r.url().endsWith('/import'))
    await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const result = await imported; expect(result.ok()).toBe(true)
    const project = await result.json(), group = project.groups[0]
    expect(group.processing_error).toBeNull(); expect(group.source.file_plugin.configuration.values).toEqual(applied.values)
    expect(group.energy).toEqual(after.map(row => row[0]))
    const expectedMu = after.map(row => row.slice(2, 2 + channels).reduce((a, b) => a + b, 0) / row[1])
    group.mu.forEach((v: number, i: number) => expect(Math.abs(v - expectedMu[i])).toBeLessThan(1e-10))
    await expect(dialog).not.toBeVisible()
    for (const [tab, space, xkey, ykey] of [['E Energy', 'E', 'energy', 'norm'], ['k EXAFS', 'k', 'k', 'weighted_chi'],
      ['R Fourier', 'R', 'r', 'chir_mag'], ['q Back transform', 'q', 'q', 'chiq_mag']]) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await expect.poll(() => curve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
        .toEqual({ x: group.result.arrays[xkey], y: group.result.arrays[ykey].map((v: number) => v === 0 ? 0 : v) })
    }
    const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Save project', exact: true }).click()
    const prj = info.outputPath('configured.prj'); await (await download).saveAs(prj)
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(prj)
    const restored = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const restoredProject = await (await restored).json()
    expect(restoredProject.groups[1].source).toEqual(group.source)
    expect(restoredProject.groups[1].result.arrays).toEqual(group.result.arrays)
    await page.reload(); await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
    panel = await registry(page); editor = await configure(panel, name)
    await expect(editor.getByRole(name === 'X15B' ? 'spinbutton' : 'combobox', {
      name: name === 'X15B' ? 'I0 column' : 'Integration time source', exact: true,
    })).toHaveValue(name === 'X15B' ? '7' : 'constant')
    expect(errors).toEqual([])
  })
}

test('configuration detects another window, reloads saved values, and restores native defaults', async ({ page, context }, info) => {
  await page.goto('/')
  const panel = await registry(page), editor = await configure(panel, 'X15B')
  const other = await context.newPage(); await other.goto('/')
  const second = await configure(await registry(other), 'X15B')
  await editor.getByRole('spinbutton', { name: 'I0 column', exact: true }).fill('8')
  const saved = await apply(page, editor, true)
  await second.getByRole('spinbutton', { name: 'I0 column', exact: true }).fill('9')
  const conflict = other.waitForResponse(r => r.url().endsWith('/configuration') && r.request().method() === 'PUT')
  await second.getByRole('button', { name: 'Apply', exact: true }).click()
  expect((await conflict).status()).toBe(409)
  await expect(second.getByRole('alert')).toContainText('Reader configuration changed')
  await second.getByRole('button', { name: 'Reload configuration' }).click()
  await expect(second.getByRole('spinbutton', { name: 'I0 column', exact: true })).toHaveValue('8')
  await second.getByRole('button', { name: 'Use Athena defaults' }).click()
  const stillSaved = await (await other.request.get('/api/backend/api/athena/preferences/plugins/X15B/configuration')).json()
  expect(stillSaved.values).toEqual(saved.values)
  const restored = await apply(other, second, true)
  expect(restored.values).toEqual(restored.defaults)
  await other.setViewportSize({ width: 390, height: 844 })
  await second.getByRole('heading').scrollIntoViewIfNeeded()
  const mobile = other.getByRole('dialog', { name: 'Plugin registry', exact: true })
  await mobile.screenshot({ path: info.outputPath('configuration-mobile.png') })
  expect(await mobile.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  const bounds = await second.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await other.close()
})
