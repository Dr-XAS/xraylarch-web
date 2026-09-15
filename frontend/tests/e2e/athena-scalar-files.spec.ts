import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`, import.meta.url))
const manifest = JSON.parse(readFileSync(fixture('athena-scalar-fixtures.json'), 'utf8'))

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

for (const name of ['cmc', 'hxma', 'lnls']) {
  test(`${name} native scalar columns, live detector edits and PRJ exchange`, async ({ page }, info) => {
    test.setTimeout(90000)
    const reader = name.toUpperCase(), source = readFileSync(fixture(`demeter-${name}.dat`))
    const ref = manifest.references.find((r: { sample: string }) => r.sample === name)
    const rows: number[][] = JSON.parse(gunzipSync(readFileSync(fixture(ref.file))).toString())
    const choice = name === 'cmc' ? ref.native.fluorescence : ref.native.default
    const x = rows.map(row => row[Number(choice.energy.slice(1)) - 1])
    const num: number[] = choice.numerator.split('+').map((v: string) => Number(v.slice(1)) - 1)
    const den = Number(choice.denominator.slice(1)) - 1
    const y = rows.map(row => {
      const ratio = num.reduce((sum, i) => sum + row[i], 0) / row[den]
      return choice.ln ? Math.log(Math.abs(ratio)) : ratio
    })
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
    await expect(dialog.getByLabel('File conversion')).toContainText(reader)
    await expect(dialog.getByLabel('Energy column')).toBeVisible()
    if (await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).count()) {
      await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).click()
    }
    const preview = dialog.getByLabel('Imported signal preview plot', { exact: true })
    if (name === 'cmc') {
      await expect(dialog.getByLabel('Column selection preview')).toContainText('zero detector counts')
      await dialog.getByLabel('Column selection preview').screenshot({ path: info.outputPath('cmc-zero-transmission.png') })
      const invalid = page.waitForResponse(r => r.url().endsWith('/import'))
      await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
      expect((await invalid).status()).toBe(400)
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
      await dialog.getByRole('combobox', { name: 'Data type', exact: true }).selectOption('xanes')
    }
    await signal(preview, x, y)
    await expect(dialog.getByRole('combobox', { name: 'Energy units', exact: true })).toHaveValue('eV')
    if (name === 'cmc') {
      // Native omits MCA1 and MCA7; show that adding them changes the live sum.
      await dialog.getByLabel('Numerator mca1', { exact: true }).check()
      await dialog.getByLabel('Numerator mca7', { exact: true }).check()
      await signal(preview, x, rows.map(row => row.slice(5).reduce((sum, v) => sum + v, 0) / row[1]))
      await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
    } else if (name === 'hxma') {
      await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
      await signal(preview, x, rows.map(row => row[4] / row[1]))
      await dialog.getByRole('button', { name: 'Use transmission columns', exact: true }).click()
    } else {
      // The final source column is an already-written ratio; its precision
      // differs from dividing Ge15/Curta again in the preview.
      await dialog.getByRole('button', { name: 'Clear numerator', exact: true }).click()
      await dialog.getByRole('button', { name: 'Clear denominator', exact: true }).click()
      await dialog.getByLabel('Numerator fluorescencia', { exact: true }).check()
      await signal(preview, x, rows.map(row => row[7]))
      await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
    }
    await signal(preview, x, y)
    await dialog.getByLabel('Invert signal', { exact: true }).check()
    await signal(preview, x, y.map(v => -v))
    await dialog.getByLabel('Invert signal', { exact: true }).uncheck()
    await signal(preview, x, y)
    const originalSummary = dialog.getByText(/^Source file contents( \(first section\))?$/)
    await originalSummary.click()
    const originalDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download original file', exact: true }).click()
    const original = info.outputPath('original.dat'); await (await originalDownload).saveAs(original)
    expect(readFileSync(original)).toEqual(source); await originalSummary.click()
    const convertedSummary = dialog.getByText(/^Converted columns( \(first section\))?$/)
    await convertedSummary.click()
    const convertedDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download converted file', exact: true }).click()
    const converted = info.outputPath('converted.dat'); await (await convertedDownload).saveAs(converted)
    expect(readFileSync(converted, 'utf8').split('\n').filter(line => line.trim() && !line.startsWith('#'))
      .map(line => line.trim().split(/\s+/).map(Number))).toEqual(rows)
    await convertedSummary.click()
    await preview.scrollIntoViewIfNeeded(); await dialog.screenshot({ path: info.outputPath('scalar-preview.png') })
    const imported = page.waitForResponse(r => r.url().endsWith('/import'))
    await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const response = await imported; expect(response.ok()).toBe(true)
    const project = await response.json(), group = project.groups[0]
    expect(project.groups).toHaveLength(1); expect(group.processing_error).toBeNull(); expect(group.energy).toEqual(x)
    group.mu.forEach((v: number, i: number) => expect(Math.abs(v - y[i])).toBeLessThan(1e-12))
    expect(group.source.file_plugin.id).toBe(reader)
    if (name === 'cmc') { expect(group.data_type).toBe('xanes'); expect(group.result.arrays.chi).toEqual([]) }
    if (name === 'lnls') {
      const records = source.toString().split(/\r?\n/).slice(1).filter(line => line.trim()).map(line => line.split(/\s+/))
      expect(group.source.file_plugin.conversion.date_values).toEqual(records.map(row => row[0]))
      expect(group.source.file_plugin.conversion.time_values).toEqual(records.map(row => row[1]))
    }
    await expect(dialog).not.toBeVisible()
    const plots = [['E Energy', 'E', 'energy', 'norm'], ['k EXAFS', 'k', 'k', 'weighted_chi'],
      ['R Fourier', 'R', 'r', 'chir_mag'], ['q Back transform', 'q', 'q', 'chiq_mag']]
    for (const [tab, space, xkey, ykey] of name === 'cmc' ? plots.slice(0, 1) : plots) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await expect.poll(() => curve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
        .toEqual({ x: group.result.arrays[xkey], y: group.result.arrays[ykey].map((v: number) => v === 0 ? 0 : v) })
    }
    const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Save project', exact: true }).click()
    const prj = info.outputPath('scalar.prj'); await (await download).saveAs(prj)
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(prj)
    const restored = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const result = await (await restored).json()
    expect(result.groups).toHaveLength(2); expect(result.groups[1].source).toEqual(group.source)
    expect(result.groups[1].result.arrays).toEqual(group.result.arrays)
    await page.reload(); await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
