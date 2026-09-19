import { fileURLToPath } from 'node:url'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { DiagnosticPlot } from '../../components/athena-diagnostic-plot'

test.use({ actionTimeout: 15000 })
async function curves(figure: Locator) {
  await expect(figure.locator('.js-line').first()).toBeVisible()
  return figure.locator('.js-plotly-plot').evaluate(el => (el as HTMLElement & { data: { x: number[]; y: number[]; name: string }[] }).data.map(t => ({ x: [...t.x], y: [...t.y], name: t.name })))
}
async function review(page: Page, dialog: Locator) {
  const button = dialog.getByRole('button', { name: 'Replot diagnostics', exact: true })
  await expect(button).toBeEnabled()
  const waiting = page.waitForResponse(r => r.url().endsWith('/plots/special'))
  await button.click(); const response = await waiting
  expect(response.ok()).toBe(true)
  const value = await response.json() as DiagnosticPlot
  await expect(dialog.getByRole('status')).toHaveText(`${value.result.panels.length} diagnostic panels · k weight ${value.result.kweight} · project revision ${value.version}.`)
  for (const p of value.result.panels) {
    await expect.poll(() => curves(dialog.getByLabel(`${p.title} diagnostic figure`, { exact: true }))).toEqual(p.curves.map(({ name, x, y }) => ({ name, x, y })))
  }
  return value
}

for (const mobile of [false, true]) test(`${mobile ? 'mobile' : 'desktop'} original Fe project: Quad, Bi-Quad, k/q and shortcuts`, async ({ page }, info) => {
  test.setTimeout(180000)
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1500, height: 1100 })
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fileURLToPath(new URL('../../../examples/xafsdata/AthenaProjectFiles/Fe.prj', import.meta.url)))
  const importing = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
  await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
  const imported = await importing; expect(imported.ok()).toBe(true)
  let project = await imported.json() as AthenaProject
  const ids = project.groups.filter(g => g.result?.effective.exafs && !g.processing_error && !['chi', 'xanes', 'detector'].includes(g.data_type)).slice(0, 2).map(g => g.id)
  expect(ids).toHaveLength(2)
  // Selection setup changes only the isolated Playwright test project.
  for (const [group_ids, marked] of [[project.groups.map(g => g.id), false], [ids, true]] as [string[], boolean][]) {
    const response = await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`, { data: { version: project.version, action: 'metadata', group_ids, options: { marked } } })
    expect(response.ok()).toBe(true); project = await response.json()
  }
  await page.reload()
  await page.getByRole('button', { name: 'Plot', exact: true }).click()
  await page.getByRole('button', { name: 'Diagnostic plots…', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Diagnostic plots', exact: true })
  await dialog.getByLabel('Diagnostic spectrum', { exact: true }).selectOption(ids[0])
  let value = await review(page, dialog)
  expect(value.result.panels.map(p => p.curves.length)).toEqual([4, 1, 2, 1])
  const first = project.groups.find(g => g.id === ids[0])!
  expect(value.result.panels[0].curves[1].y).toEqual(first.result!.arrays.mu)
  await dialog.getByLabel('Energy diagnostic figure', { exact: true }).screenshot({ path: info.outputPath('quad-energy.png') })
  await dialog.getByLabel('Diagnostic plot', { exact: true }).selectOption('biquad')
  value = await review(page, dialog)
  expect(value.result.group_ids).toEqual(ids)
  expect(value.result.panels.every(p => p.curves.map(c => c.group_id).join() === ids.join())).toBe(true)
  await dialog.getByLabel('Diagnostic k weight', { exact: true }).fill('1.5')
  value = await review(page, dialog); expect(value.result.kweight).toBe(1.5)
  await dialog.getByLabel('R space diagnostic figure', { exact: true }).screenshot({ path: info.outputPath('biquad-r.png') })
  await dialog.getByLabel('Diagnostic plot', { exact: true }).selectOption('kq')
  await dialog.getByLabel('Diagnostic q component', { exact: true }).selectOption('im')
  value = await review(page, dialog); expect(value.result.panels).toHaveLength(1)
  await dialog.getByLabel('k / q comparison plot minimum', { exact: true }).fill('2')
  await dialog.getByLabel('k / q comparison plot maximum', { exact: true }).fill('10')
  const figure = dialog.getByLabel('k / q comparison diagnostic figure', { exact: true })
  await expect.poll(() => figure.locator('.js-plotly-plot').evaluate(el => (el as HTMLElement & { layout: { xaxis: { range: number[] } } }).layout.xaxis.range)).toEqual([2, 10])
  await figure.screenshot({ path: info.outputPath('kq.png') })
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await dialog.getByRole('button', { name: 'Close diagnostic plots', exact: true }).click()
  expect(await (await page.request.get(`/api/backend/api/athena/projects/${project.id}`)).json()).toEqual(project)
  await page.reload()
  await page.getByRole('button', { name: 'Plot shortcuts…', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Athena plot shortcuts', exact: true })
  await dialog.getByLabel('Plot shortcut', { exact: true }).selectOption('biquad')
  value = await review(page, dialog)
  expect(value.result.panels.map(p => p.curves.length)).toEqual([2, 2, 2, 2])
  expect(value.result.panels[0].curves[0].y).toEqual(first.result!.arrays.flat)
  expect(await (await page.request.get(`/api/backend/api/athena/projects/${project.id}`)).json()).toEqual(project)
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})
