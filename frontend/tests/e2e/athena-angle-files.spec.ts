import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`, import.meta.url))
const manifest = JSON.parse(readFileSync(fixture('athena-angle-fixtures.json'), 'utf8'))
const samples = [{ name: 'srs9', reader: 'SRS' }, { name: 'srs32', reader: 'SRS' },
  { name: 'dubble', reader: 'DUBBLE' }, { name: 'pfbl12c', reader: 'PFBL12C' }, { name: 'srsc', reader: 'SRS' }]

async function curve(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node => {
    const trace = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: [...trace.x], y: [...trace.y] }
  })
}

async function signal(plot: Locator, x: number[], y: number[]) {
  await expect.poll(async () => (await curve(plot)).x).toEqual(x)
  await expect.poll(async () => {
    const actual = (await curve(plot)).y
    return actual.length === y.length ? Math.max(...actual.map((v, i) => Math.abs(v - y[i]))) : Infinity
  }).toBeLessThan(1e-12)
}

for (const { name, reader } of samples) {
  test(`${name} measured columns, edited preview, Larch plots and PRJ exchange`, async ({ page }, info) => {
    test.setTimeout(90000)
    const source = readFileSync(fixture(`demeter-${name}.dat`))
    const native = manifest.references.find((r: { sample: string }) => r.sample === name)
    // SRSC's native converter fails: use its explicitly declared numerical
    // table as the independent reference, without inventing a native output.
    const rows: number[][] = name === 'srsc' ? source.toString().split(/\r?\n/)
      .filter(line => /^\s*\d+\.\d+\s/.test(line)).map(line => line.trim().split(/\s+/).map(Number))
      : JSON.parse(gunzipSync(readFileSync(fixture(native.file))).toString())
    const choice = native?.native.transmission
    const xi = choice ? Number(choice.energy.slice(1)) - 1 : 0
    const num: number[] = choice ? choice.numerator.split('+').map((v: string) => Number(v.slice(1)) - 1) : [3]
    const den = choice ? Number(choice.denominator.slice(1)) - 1 : 2
    const x = rows.map(row => row[xi])
    const y = rows.map(row => { const ratio = num.reduce((sum, i) => sum + row[i], 0) / row[den]; return choice?.ln ? Math.log(Math.abs(ratio)) : ratio })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    await page.getByRole('button', { name: 'File', exact: true }).click()
    await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
    const registry = page.getByRole('dialog', { name: 'Plugin registry', exact: true })
    const enable = registry.getByRole('checkbox', { name: `Enable ${reader}`, exact: true })
    await expect(enable).toBeEnabled()
    if (!await enable.isChecked()) {
      const saved = page.waitForResponse(r => r.url().endsWith('/preferences/plugins') && r.request().method() === 'PUT')
      await enable.click(); expect((await saved).ok()).toBe(true); await expect(enable).toBeChecked()
    }
    await registry.getByRole('button', { name: 'Close registry', exact: true }).click()
    await page.getByRole('button', { name: 'Import data', exact: true }).click()
    await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fixture(`demeter-${name}.dat`))
    const dialog = page.getByRole('dialog', { name: 'Import spectra', exact: true })
    await expect(dialog.getByLabel('File conversion')).toContainText(reader === 'PFBL12C' ? 'Photon Factory' : reader)
    await expect(dialog.getByRole('button', { name: 'Import spectrum', exact: true })).toBeEnabled()
    if (await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).count()) {
      await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).click()
    }
    const preview = dialog.getByLabel('Imported signal preview plot', { exact: true })
    if (name === 'srsc') {
      await signal(preview, x, rows.map(row => Math.log(Math.abs(row[2] / row[3]))))
      await dialog.getByRole('button', { name: 'Clear numerator', exact: true }).click()
      await dialog.getByRole('button', { name: 'Clear denominator', exact: true }).click()
      await dialog.getByLabel('Natural log', { exact: true }).uncheck()
      await dialog.getByLabel('Numerator signal1', { exact: true }).check()
      await dialog.getByLabel('Denominator refer', { exact: true }).check()
    }
    await signal(preview, x, y)
    if (name === 'pfbl12c') {
      await expect(dialog.getByLabel('Energy column').getByRole('option', { name: 'energy_requested · column 1', exact: true })).toBeAttached()
      await expect(dialog.getByLabel('Energy column').getByRole('option', { name: 'energy_attained · column 2', exact: true })).toBeAttached()
      await expect(dialog.getByLabel('Energy column')).toHaveValue('column_0002')
      await dialog.getByLabel('Energy column').selectOption('column_0001')
      await signal(preview, rows.map(row => row[0]), y)
      await dialog.getByLabel('Energy column').selectOption('column_0002')
    } else if (name !== 'srsc') {
      await dialog.getByRole('button', { name: 'Clear numerator', exact: true }).click()
      await dialog.getByLabel('Numerator column numbers').fill(`7-${rows[0].length}`)
      await dialog.getByRole('button', { name: 'Select range', exact: true }).click()
      await signal(preview, x, rows.map(row => row.slice(6).reduce((sum, v) => sum + v, 0) / row[2]))
      await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
    }
    await signal(preview, x, y)
    await dialog.getByLabel('Invert signal', { exact: true }).check()
    await signal(preview, x, y.map(v => -v))
    await dialog.getByLabel('Invert signal', { exact: true }).uncheck()
    await signal(preview, x, y)
    await dialog.getByText('Source file contents (first section)', { exact: true }).click()
    const originalDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download original file', exact: true }).click()
    const original = info.outputPath('original.dat'); await (await originalDownload).saveAs(original)
    expect(readFileSync(original)).toEqual(source)
    await dialog.getByText('Source file contents (first section)', { exact: true }).click()
    await dialog.getByText('Converted columns (first section)', { exact: true }).click()
    const convertedDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download converted file', exact: true }).click()
    const converted = info.outputPath('converted.dat'); await (await convertedDownload).saveAs(converted)
    const convertedRows = readFileSync(converted, 'utf8').split('\n').filter(line => line.trim() && !line.startsWith('#'))
      .map(line => line.trim().split(/\s+/).map(Number))
    expect(convertedRows).toEqual(rows)
    await dialog.getByText('Converted columns (first section)', { exact: true }).click()
    await preview.scrollIntoViewIfNeeded(); await dialog.screenshot({ path: info.outputPath('angle-preview.png') })
    const imported = page.waitForResponse(r => r.url().endsWith('/import'))
    await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const response = await imported; expect(response.ok()).toBe(true)
    const project = await response.json(), group = project.groups[0]
    expect(group.processing_error).toBeNull(); expect(group.energy).toEqual(x)
    group.mu.forEach((value: number, i: number) => expect(Math.abs(value - y[i])).toBeLessThan(1e-12))
    expect(group.source.file_plugin.id).toBe(reader)
    await expect(dialog).not.toBeVisible()
    for (const [tab, space, xkey, ykey] of [['E Energy','E','energy','norm'], ['k EXAFS','k','k','weighted_chi'],
      ['R Fourier','R','r','chir_mag'], ['q Back transform','q','q','chiq_mag']]) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await expect.poll(() => curve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
        .toEqual({ x: group.result.arrays[xkey], y: group.result.arrays[ykey].map((v: number) => v === 0 ? 0 : v) })
    }
    const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Save project', exact: true }).click()
    const prj = info.outputPath('angles.prj'); await (await download).saveAs(prj)
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(prj)
    const restored = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const result = await (await restored).json()
    expect(result.groups).toHaveLength(2)
    expect(result.groups[1].source).toEqual(group.source)
    expect(result.groups[1].result.arrays).toEqual(group.result.arrays)
    await page.reload(); await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
    if (name === 'pfbl12c') {
      // The native converter accepts a missing D with 2D=1. Show that fallback
      // explicitly and verify its preview without accepting the altered data.
      await page.getByRole('button', { name: 'Import data', exact: true }).click()
      await page.getByLabel('Choose data files', { exact: true }).setInputFiles({ name: 'missing-spacing.dat', mimeType: 'text/plain',
        buffer: Buffer.from(source.toString().replace('D=  3.13551 A', 'monochromator spacing absent')) })
      await expect(dialog.getByLabel('File conversion')).toContainText('2d = 1 Å')
      await expect(dialog.getByRole('button', { name: 'Import spectrum', exact: true })).toBeEnabled()
      const fallback: number[][] = JSON.parse(gunzipSync(readFileSync(fixture(manifest.pf_missing_spacing.file))).toString())
      await signal(preview, fallback.map(row => row[1]), y)
      await dialog.getByLabel('File conversion').scrollIntoViewIfNeeded()
      await dialog.screenshot({ path: info.outputPath('pf-default-spacing.png') })
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
    }
    expect(errors).toEqual([])
  })
}
