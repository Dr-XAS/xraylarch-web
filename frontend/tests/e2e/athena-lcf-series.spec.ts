/**
 * Series LCF on the public vanadium-glass project: the order the targets are
 * fitted and plotted in, and the fit view of one target.
 *
 * A natural walk selects one scan, opens the tool (which ticks
 * that scan as the first target) and then ticks the rest. The targets were
 * sent, fitted and trended in click order, so the preselected scan led the
 * trend and made a step that is not in the data. The fit view overlaid every
 * target's observed and fitted curve with no residual.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function openProject(page: Page, file: string) {
  await expect(page.locator('.ath-project-name')).not.toHaveText('Opening workspace…', { timeout: 120000 })
  const dialog = page.getByRole('dialog', { name: 'Open a project' })
  await expect(async () => {
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await expect(dialog).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 120000 })
  await dialog.getByLabel('Open project file', { exact: true }).setInputFiles(file)
  await expect(dialog.getByRole('button', { name: 'Import all groups', exact: true })).toBeEnabled({ timeout: 120000 })
  const restored = page.waitForResponse(r => r.url().endsWith('/restore-upload'), { timeout: 180000 })
  await dialog.getByRole('button', { name: 'Import all groups', exact: true }).click()
  const project = await (await restored).json()
  await expect(dialog).toHaveCount(0, { timeout: 60000 })
  return project as { groups: { id: string; label: string }[] }
}

/** Names of every trace on every plot in the page. */
async function traceNames(page: Page) {
  return page.locator('.js-plotly-plot').evaluateAll(plots => plots.flatMap(plot =>
    ((plot as HTMLElement & { data?: { name?: string }[] }).data ?? []).map(trace => String(trace.name ?? ''))))
}

test('series LCF fits targets in project order and draws one target with its residual', async ({ page }) => {
  test.setTimeout(600000)
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto('/')
  const { groups } = await openProject(page, join(root, 'examples/xanes/Vglasses.prj'))
  expect(groups.length).toBeGreaterThanOrEqual(8)
  const current = groups[4]
  const others = [groups[1], groups[2], groups[3]]
  const standards = [groups[0], groups[7]]
  await page.locator('.ath-group-select').filter({ hasText: current.label }).last().click()

  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await page.getByRole('button', { name: 'Linear combination fitting', exact: true }).click()
  const lcf = page.getByRole('dialog', { name: 'Linear combination fitting', exact: true })
  await lcf.getByRole('checkbox', { name: 'Fit a series: each target against the same standards' }).check()
  // The current scan arrives ticked; the others are ticked after it.
  await expect(lcf.getByRole('checkbox', { name: `Target ${current.label}`, exact: true })).toBeChecked()
  for (const g of others) await lcf.getByRole('checkbox', { name: `Target ${g.label}`, exact: true }).check()
  const list = lcf.getByRole('group', { name: 'Standards' })
  const keep = new Set(standards.map(g => g.label))
  for (const g of groups) {
    const box = list.getByRole('checkbox', { name: g.label, exact: true })
    if (await box.count() && await box.isEnabled() && (await box.isChecked()) !== keep.has(g.label)) await box.setChecked(keep.has(g.label))
  }

  const sent = page.waitForRequest(r => r.url().endsWith('/analyze'))
  const answered = page.waitForResponse(r => r.url().endsWith('/analyze'), { timeout: 180000 })
  await lcf.getByRole('button', { name: 'Run analysis', exact: true }).click()
  const inProjectOrder = [groups[1], groups[2], groups[3], groups[4]].map(g => g.id)
  expect((await sent).postDataJSON().group_ids).toEqual(inProjectOrder)
  const response = await answered
  expect(response.ok(), await response.text()).toBe(true)
  const rows = (await response.json()).result.targets as { group_id: string }[]
  expect(rows.map(row => row.group_id)).toEqual(inProjectOrder)

  // The fit view draws the current spectrum's fit and residual, nothing else.
  await expect(page.getByRole('button', { name: 'Show spectra', exact: true })).toBeVisible({ timeout: 60000 })
  await expect.poll(() => traceNames(page).then(names => names.filter(n => /^(Observed|Fit|Residual) · /.test(n))))
    .toEqual([`Observed · ${current.label}`, `Fit · ${current.label}`, `Residual · ${current.label}`])
  await expect(page.locator('.ath-plot-current-spectrum')).toContainText(current.label)
  await page.getByLabel('Plotted target').selectOption(groups[2].id)
  await expect.poll(() => traceNames(page).then(names => names.filter(n => /^(Observed|Fit|Residual) · /.test(n))))
    .toEqual([`Observed · ${groups[2].label}`, `Fit · ${groups[2].label}`, `Residual · ${groups[2].label}`])
  await expect(page.locator('.ath-plot-current-spectrum')).toContainText(groups[2].label)
})
