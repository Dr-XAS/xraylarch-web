import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator, type Page } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`, import.meta.url))
const manifest = JSON.parse(readFileSync(fixture('athena-header-fixtures.json'), 'utf8'))
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
    return actual.length === y.length ? Math.max(...actual.map((v,i) => Math.abs(v-y[i]))) : Infinity
  }).toBeLessThan(1e-12)
}
async function enable(page: Page, reader: string) {
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
  const registry = page.getByRole('dialog', { name: 'Plugin registry', exact: true })
  const toggle = registry.getByRole('checkbox', { name: `Enable ${reader}`, exact: true })
  await expect(toggle).toBeEnabled()
  if (!await toggle.isChecked()) {
    const enabled = page.waitForResponse(r => r.url().endsWith('/preferences/plugins') && r.request().method() === 'PUT')
    await toggle.click(); expect((await enabled).ok()).toBe(true)
  }
  await registry.getByRole('button', { name: 'Close registry', exact: true }).click()
}
for (const reader of ['B18','BM23']) {
  test(`${reader} native cleanup, edited detector preview and PRJ roundtrip`, async ({ page }, info) => {
    test.setTimeout(90000)
    const ref = manifest.references.find((r: { reader: string; backend: string }) => r.reader === reader && r.backend === 'larch')
    const oracle = JSON.parse(gunzipSync(readFileSync(fixture(ref.file))).toString())
    const rows: number[][] = oracle.columns, x = rows.map(row => row[0])
    const y = rows.map(row => reader === 'B18' ? row.slice(7,43).reduce((a,b) => a+b,0)/row[2] : Math.log(Math.abs(row[2]/row[3])))
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    await page.goto('/'); await enable(page,reader)
    await page.getByRole('button', { name: 'Import data', exact: true }).click()
    await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fixture(ref.input))
    const dialog = page.getByRole('dialog', { name: 'Import spectra', exact: true })
    await expect(dialog.getByLabel('File conversion')).toContainText(reader)
    const suggested = reader === 'B18' ? 'Use fluorescence columns' : 'Use transmission columns'
    await dialog.getByRole('button', { name: suggested, exact: true }).click()
    const plot = dialog.getByLabel('Imported signal preview plot', { exact: true })
    await signal(plot,x,y)
    await expect(dialog.getByRole('combobox', { name: 'Energy units', exact: true })).toHaveValue('eV')
    if (reader === 'B18') {
      await expect(dialog.getByRole('checkbox', { name: 'Natural log', exact: true })).not.toBeChecked()
      expect(await dialog.getByRole('checkbox', { name: /^Numerator ff\d+$/ }).count()).toBe(36)
      await dialog.getByRole('button', { name: 'Clear numerator', exact: true }).click()
      await dialog.getByLabel('Numerator ff1', { exact: true }).check()
      await signal(plot,x,rows.map(row => row[7]/row[2]))
    } else {
      await dialog.getByRole('button', { name: 'Clear denominator', exact: true }).click()
      await dialog.getByLabel('Denominator iref', { exact: true }).check()
      await signal(plot,x,rows.map(row => Math.log(Math.abs(row[2]/row[4]))))
    }
    await dialog.getByRole('button', { name: suggested, exact: true }).click(); await signal(plot,x,y)
    for (const variant of ['original','converted']) {
      const summary = dialog.getByText(variant === 'original' ? /^Source file contents( \(first section\))?$/ : /^Converted columns( \(first section\))?$/)
      await summary.click(); const downloading = page.waitForEvent('download')
      await dialog.getByRole('link', { name: `Download ${variant} file`, exact: true }).click()
      const file = info.outputPath(variant+'.dat'); await (await downloading).saveAs(file)
      if (variant === 'original') expect(readFileSync(file)).toEqual(readFileSync(fixture(ref.input)))
      else expect(readFileSync(file,'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/).map(Number))).toEqual(rows)
      await summary.click()
    }
    await plot.scrollIntoViewIfNeeded(); await dialog.screenshot({ path: info.outputPath('column-preview.png') })
    const importing = page.waitForResponse(r => r.url().endsWith('/import'))
    await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const response = await importing; expect(response.ok()).toBe(true)
    const project = await response.json(), group = project.groups[0]
    expect(group.energy).toEqual(x); expect(group.processing_error).toBeNull()
    group.mu.forEach((v: number,i: number) => expect(Math.abs(v-y[i])).toBeLessThan(1e-12))
    if (reader === 'B18') expect(group.source.file_plugin.conversion.decimated).toBe(false)
    for (const [tab,space,xkey,ykey] of [['E Energy','E','energy','norm'],['k EXAFS','k','k','weighted_chi'],['R Fourier','R','r','chir_mag'],['q Back transform','q','q','chiq_mag']]) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await expect.poll(() => curve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
        .toEqual({ x: group.result.arrays[xkey], y: group.result.arrays[ykey].map((v: number) => v === 0 ? 0 : v) })
    }
    const downloading = page.waitForEvent('download'); await page.getByRole('link', { name: 'Save project', exact: true }).click()
    const prj = info.outputPath('header-reader.prj'); await (await downloading).saveAs(prj)
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(prj)
    const restoring = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const result = await (await restoring).json(); expect(result.groups).toHaveLength(2)
    expect(result.groups[1].source).toEqual(group.source); expect(result.groups[1].result.arrays).toEqual(group.result.arrays)
    await page.reload(); await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}

test('BM23 multi-scan files preview independent sweeps and import the selected scan only', async ({ page },info) => {
  test.setTimeout(60000)
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const ref = manifest.references.find((r: { reader: string }) => r.reader === 'BM23')
  const rows: number[][] = JSON.parse(gunzipSync(readFileSync(fixture(ref.file))).toString()).columns
  await page.goto('/'); await enable(page,'BM23')
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fixture('constructed-bm23-multiscan.dat'))
  const dialog = page.getByRole('dialog', { name: 'Import spectra', exact: true })
  await expect(dialog.getByRole('region', { name: 'Scan selection', exact: true })).toContainText('2 scans · 774 points')
  await dialog.getByRole('button', { name: 'Preview Scan 9 · entry 2', exact: true }).click()
  await signal(dialog.getByLabel('Imported signal preview plot', { exact: true }),rows.map(r => r[0]),rows.map(r => Math.log(Math.abs(r[2]/r[3]))))
  await dialog.getByRole('checkbox', { name: 'Include Scan 7 · entry 1', exact: true }).uncheck()
  await dialog.screenshot({ path: info.outputPath('scan-preview.png') })
  await dialog.getByRole('button', { name: 'Review selected scans', exact: true }).click()
  await dialog.getByRole('button', { name: 'Use transmission columns', exact: true }).click()
  const importing = page.waitForResponse(r => r.url().endsWith('/import'))
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const response = await importing; expect(response.ok()).toBe(true)
  const result = await response.json(); expect(result.groups).toHaveLength(1)
  expect(result.groups[0].source.file_plugin.scan.number).toBe('9')
  expect(result.groups[0].energy).toEqual(rows.map(r => r[0])); expect(errors).toEqual([])
})
