import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator } from '@playwright/test'

const fixtures = fileURLToPath(new URL('../../../backend/tests/fixtures/', import.meta.url))
async function signal(plot: Locator, rows: number[][], column: number) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  await expect.poll(() => plot.locator('.js-plotly-plot').evaluate(node =>
    [...(node as HTMLElement & { data: { x: number[] }[] }).data[0].x])).toEqual(rows.map(r => r[0]))
  await expect.poll(() => plot.locator('.js-plotly-plot').evaluate((node, expected) => {
    const y = (node as HTMLElement & { data: { y: number[] }[] }).data[0].y
    return y.length === expected.length ? Math.max(...y.map((v, i) => Math.abs(v-expected[i]))) : Infinity
  }, rows.map(r => column === -1 ? Math.log(r[1]/r[2]) : r[column]))).toBeLessThan(1e-10)
}

for (const [file, element, count, width] of [['cu_metal_rt', 'Cu', 408, 1500], ['fe2o3_rt', 'Fe', 348, 390]] as const) {
  test(`official ${element} XDI live columns, acquisition fields and independent PRJ restore`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    const filePath = `${fixtures}xdi-official-${file}.xdi`
    const rows = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/).map(Number))
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1040 }); await page.goto('/')
    await page.getByRole('button', { name: 'Import data', exact: true }).click()
    const inspecting = page.waitForResponse(r => r.url().endsWith('/inspect'))
    await page.getByLabel('Choose data files', { exact: true }).setInputFiles(filePath)
    const inspection = await inspecting; expect(inspection.ok()).toBe(true)
    const i = await inspection.json(); expect(i.row_count).toBe(count)
    const dialog = page.getByRole('dialog', { name: 'Import spectra', exact: true })
    const plot = dialog.getByLabel('Imported signal preview plot', { exact: true })
    await signal(plot, rows, element === 'Cu' ? -1 : 1)
    const metadata = dialog.getByRole('region', { name: 'XDI metadata' })
    await expect(metadata).toContainText('XDI 1.0 · GSE/1.0')
    await metadata.getByText('View XDI metadata').click()
    await expect(metadata.getByRole('rowheader', { name: 'element.symbol' }).locator('..')).toContainText(element)
    await expect(metadata).toContainText('APS')
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await metadata.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`${element}-xdi-metadata.png`) })
    if (element === 'Cu') {
      await dialog.getByRole('checkbox', { name: 'Numerator i0', exact: true }).uncheck()
      await dialog.getByRole('checkbox', { name: 'Numerator mutrans', exact: true }).check()
      await dialog.getByRole('checkbox', { name: 'Denominator itrans', exact: true }).uncheck()
      await dialog.getByRole('checkbox', { name: 'Natural log', exact: true }).uncheck()
      await signal(plot, rows, 3)
    }
    const importing = page.waitForResponse(r => r.url().endsWith('/import'))
    await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const imported = await importing; expect(imported.ok()).toBe(true)
    const project = await imported.json(), group = project.groups.at(-1)
    expect(group.processing_error).toBeNull(); expect(group.mu.length).toBe(count)
    expect(group.source.edge_identity).toEqual({ element, edge: 'K', origin: 'xdi' })
    expect(group.source.xdi_metadata).toEqual(i.xdi_metadata)
    await expect(dialog).toHaveCount(0); await page.reload()
    await page.getByRole('button', { name: 'Edit group information', exact: true }).click()
    const groupInfo = page.getByRole('dialog', { name: 'Group information', exact: true })
    await expect(groupInfo.getByRole('region', { name: 'XDI metadata' })).toContainText('APS')
    await groupInfo.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'File', exact: true }).click()
    const downloading = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Save Athena project (.prj)', exact: true }).click()
    const downloaded = await downloading, path = info.outputPath('xdi.prj'); await downloaded.saveAs(path)
    const text = gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(l => !l.startsWith('# Athena-Web ')).join('\n')
    expect(text).toContain("'Xray::XDI'"); writeFileSync(path, text)
    const fileMenu = page.getByRole('button', { name: 'File', exact: true })
    if (await fileMenu.getAttribute('aria-expanded') !== 'true') await fileMenu.click()
    await page.getByRole('button', { name: 'Open project…', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(path)
    const restoring = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const restored = await restoring; expect(restored.ok()).toBe(true)
    const native = (await restored.json()).groups.at(-1)
    expect(native.source.xdi_metadata.attributes).toEqual(i.xdi_metadata.attributes)
    expect(native.source.xdi_metadata.comments_text).toBe(i.xdi_metadata.comments_text)
    expect(native.energy).toEqual(group.energy); expect(native.mu).toEqual(group.mu)
    expect(native.processing_error).toBeNull(); expect(errors).toEqual([])
  })
}
