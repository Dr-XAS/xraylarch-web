import { fileURLToPath } from 'node:url'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { ShortcutPlot } from '../../components/athena-special-plot'

test.use({ actionTimeout: 15000 })
async function curves(figure: Locator) {
  await expect(figure.locator('.js-line').first()).toBeAttached()
  return figure.locator('.js-plotly-plot').evaluate(el => (el as HTMLElement & { data: { x: number[]; y: number[]; name: string }[] }).data.map(t => ({ x: [...t.x], y: [...t.y], name: t.name })))
}
async function review(page: Page, dialog: Locator, kind: string) {
  await dialog.getByLabel('Plot shortcut', { exact: true }).selectOption(kind)
  const button = dialog.getByRole('button', { name: 'Replot shortcut', exact: true })
  await expect(button).toBeEnabled()
  const waiting = page.waitForResponse(r => r.url().endsWith('/plots/shortcut') && r.request().postDataJSON().kind === kind)
  await button.click(); const response = await waiting
  expect(response.ok()).toBe(true)
  const value = await response.json() as ShortcutPlot
  await expect(dialog.getByRole('status')).toHaveText(value.result.curves.length + ' shortcut curves · project revision ' + value.version + '.')
  await expect.poll(() => curves(dialog.getByLabel('Athena shortcut figure', { exact: true }))).toEqual(value.result.curves.map(({ name, x, y }) => ({ name, x, y })))
  return value
}
async function open(page: Page) {
  await page.getByRole('button', { name: 'Plot shortcuts…', exact: true }).click()
  return page.getByRole('dialog', { name: 'Athena plot shortcuts', exact: true })
}
async function close(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Close plot shortcuts', exact: true }).click()
}

for (const mobile of [false, true]) test((mobile ? 'mobile' : 'desktop') + ' original Fe PRJ and measured detector scan: seven shortcuts and project roundtrip', async ({ page }, info) => {
  test.setTimeout(180000)
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1500, height: 1100 })
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fileURLToPath(new URL('../../../examples/xafsdata/AthenaProjectFiles/Fe.prj', import.meta.url)))
  const importing = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
  await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
  expect((await importing).ok()).toBe(true)
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fileURLToPath(new URL('../../../backend/tests/fixtures/demeter-merge-fe.060', import.meta.url)))
  const columns = page.getByRole('dialog', { name: 'Import spectra', exact: true })
  await columns.getByRole('button', { name: 'Clear numerator', exact: true }).click()
  await columns.getByRole('checkbox', { name: 'Numerator i0', exact: true }).check()
  await columns.getByRole('button', { name: 'Clear denominator', exact: true }).click()
  await columns.getByRole('checkbox', { name: 'Denominator it', exact: true }).check()
  await columns.getByRole('checkbox', { name: 'Natural log', exact: true }).check()
  const accepted = page.waitForResponse(r => r.url().endsWith('/import'))
  await columns.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const result = await accepted; expect(result.ok()).toBe(true)
  let project = await result.json() as AthenaProject
  expect(project.groups).toHaveLength(6)
  const activeId = project.groups.at(-1)!.id
  // Set display modifiers and marks only on this isolated test project.
  for (const [group_ids, options] of [
    [project.groups.map(g => g.id), { marked: true }],
    [[activeId], { multiplier: -1.2, offset: .375 }],
  ] as [string[], Record<string, unknown>][]) {
    const response = await page.request.post('/api/backend/api/athena/projects/' + project.id + '/command', { data: { version: project.version, action: 'metadata', group_ids, options } })
    expect(response.ok()).toBe(true); project = await response.json()
  }
  await page.reload()
  await page.getByRole('button', { name: /demeter-merge-fe\.060 μ\(E\)/ }).click()
  const active = project.groups.find(g => g.id === activeId)!
  let dialog = await open(page)
  for (const kind of ['normderiv', 'i0sig', 'i0', 'normscaled', 'e00', 'k123', 'r123']) {
    const value = await review(page, dialog, kind)
    if (kind === 'normderiv') {
      expect(value.result.curves).toHaveLength(2)
      expect(value.result.curves[0].y).toEqual(active.result!.arrays.flat.map(y => y * -1.2 + .375))
      await dialog.screenshot({ path: info.outputPath('normalized-derivative.png') })
    }
    if (kind === 'i0sig') {
      expect(value.result.curves).toHaveLength(3)
      expect(value.result.skipped).toHaveLength(0)
      await dialog.screenshot({ path: info.outputPath('detector-comparison.png') })
    }
    if (kind === 'i0') { expect(value.result.curves).toHaveLength(2); expect(value.result.skipped).toHaveLength(4) }
    if (kind === 'normscaled' || kind === 'e00') expect(value.result.group_ids).toEqual(project.groups.map(g => g.id))
    if (kind.endsWith('123')) expect(value.result.curves.map(c => c.kweight)).toEqual([1, 2, 3])
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
  await close(dialog)
  expect(await (await page.request.get('/api/backend/api/athena/projects/' + project.id)).json()).toEqual(project)

  // Native normalized shortcuts must follow a saved Flatten change.
  const changing = page.waitForResponse(r => r.url().endsWith('/command') && r.request().postDataJSON().action === 'parameters')
  await page.getByRole('checkbox', { name: 'Flatten normalized data', exact: true }).uncheck()
  const changed = await changing; expect(changed.ok()).toBe(true); project = await changed.json()
  dialog = await open(page)
  const unflat = await review(page, dialog, 'normderiv')
  expect(unflat.result.curves[0].y).toEqual(project.groups.find(g => g.id === activeId)!.result!.arrays.norm.map(y => y * -1.2 + .375))
  await close(dialog)

  await page.getByRole('tab', { name: /^R(?: Fourier)?$/ }).click()
  await page.getByLabel('Complex component', { exact: true }).selectOption('pha')
  dialog = await open(page)
  const phase = await review(page, dialog, 'r123')
  expect(phase.options.component).toBe('pha')
  await dialog.screenshot({ path: info.outputPath('r123-phase.png') })
  await close(dialog)
  await page.getByRole('tab', { name: /^E(?: Energy)?$/ }).click()
  await page.getByRole('radio', { name: 'Derivative dμ/dE', exact: true }).check()
  dialog = await open(page)
  const zero = await review(page, dialog, 'e00')
  expect(zero.options.energy_mode).toBe('dmude')
  const current = project.groups.find(g => g.id === activeId)!
  expect(zero.result.curves.at(-1)!.y).toEqual(current.result!.arrays.norm.map(y => y * -1.2 + .375))
  await close(dialog)
  expect(await (await page.request.get('/api/backend/api/athena/projects/' + project.id)).json()).toEqual(project)

  const downloading = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Save project', exact: true }).click()
  const path = info.outputPath('shortcuts.prj'); await (await downloading).saveAs(path)
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await page.getByLabel('Open project file', { exact: true }).setInputFiles(path)
  const restoring = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
  await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
  const restored = await restoring; expect(restored.ok()).toBe(true)
  const roundtrip = await restored.json() as AthenaProject
  const copy = roundtrip.groups.at(-1)!
  expect(copy.energy).toEqual(current.energy)
  expect(copy.source.detector_plot_scales).toEqual(current.source.detector_plot_scales)
  expect(copy.result!.arrays).toEqual(current.result!.arrays)
  await page.reload()
  // Select by position because native import intentionally retains duplicate labels.
  await page.getByRole('button', { name: /demeter-merge-fe\.060 μ\(E\)/ }).last().click()
  dialog = await open(page)
  const after = await review(page, dialog, 'i0sig')
  expect(after.result.curves).toHaveLength(3)
  expect(after.result.curves[0].y).toEqual(current.mu.map(y => y * -1.2 + .375))
  expect(errors).toEqual([])
})
