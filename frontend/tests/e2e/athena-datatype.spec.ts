import { confirmProjectSave } from "./project-save"
import { expect, test, type Page } from '@playwright/test'
import type { AthenaGroup, AthenaProject } from '../../lib/athena'

test.use({ actionTimeout: 10000 })

async function command(page: Page, name: string, action: () => Promise<unknown>) {
  const response = page.waitForResponse(r => r.url().endsWith('/command') && r.request().method() === 'POST'
    && r.request().postDataJSON().action === name, { timeout: 30000 })
  await action(); const saved = await response; expect(saved.ok()).toBe(true)
  const project = await saved.json() as AthenaProject
  await expect(page.locator('footer.ath-status')).toContainText(`revision ${project.version}`)
  return project
}
async function openSettings(page: Page) {
  await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Group', exact: true }).click()
  await page.getByRole('button', { name: 'Processing settings…', exact: true }).click()
  return page.getByRole('dialog', { name: 'Processing settings', exact: true })
}
function expectRetainedInput(actual: AthenaGroup, expected: AthenaGroup) {
  for (const key of ['energy', 'mu', 'parameters', 'source', 'reference_id', 'frozen', 'notes', 'multiplier', 'offset'] as const) {
    expect(actual[key], key).toEqual(expected[key])
  }
}
async function energyCurve(page: Page) {
  const plot = page.getByRole('region', { name: 'Single spectrum viewer', exact: true }).getByLabel('E-space spectrum plot', { exact: true })
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node => {
    const curve = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: [...curve.x], y: [...curve.y] }
  })
}

test('real copper processing settings: four combinations, frozen recipes, scopes and undo', async ({ page }, info) => {
  test.setTimeout(90000)
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  const initial = await command(page, 'example', () => page.getByRole('button', { name: 'Load copper examples', exact: true }).click())
  const [, second, third, reference] = initial.groups
  await page.locator('.ath-group-select').filter({ hasText: 'Cu foil · 10 K' }).click()
  await page.getByRole('tab', { name: 'Processing', exact: true }).click()
  // Main-pane edits process on blur. Preserve this saved recipe, not the original example defaults.
  const processed = await command(page, 'parameters', async () => {
    const rbkg = page.getByRole('spinbutton', { name: /^Rbkg/ })
    await rbkg.fill('1.9'); await rbkg.press('Tab')
  })
  expect(processed.groups[0].parameters.rbkg).toBe(1.9)
  expect(processed.groups[0].result?.arrays.chi).not.toEqual(initial.groups[0].result?.arrays.chi)
  const frozen = await command(page, 'metadata', () => page.getByRole('button', { name: 'Freeze group', exact: true }).click())
  // Freeze returns selection flags only; retain arrays and recipe from the completed processing response.
  const frozenFlags = frozen.groups.find(group => group.id === processed.groups[0].id)!
  expect(frozenFlags.frozen).toBe(true)
  const first = { ...processed.groups[0], ...frozenFlags }
  let panel = await openSettings(page)
  await expect(panel.getByRole('checkbox', { name: 'Input already normalized', exact: true })).not.toBeChecked()
  await expect(panel.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true })).toBeChecked()
  await expect(panel.getByRole('combobox', { name: 'Change data type to', exact: true })).toHaveCount(0)
  await panel.getByRole('checkbox', { name: 'Input already normalized', exact: true }).check()
  let saved = await command(page, 'change_datatype', () => panel.getByRole('button', { name: 'Apply settings', exact: true }).click())
  expect(saved.groups[0].data_type).toBe('norm'); expect(saved.groups[0].frozen).toBe(true)
  expect(saved.groups[0].is_normalized).toBe(true)
  expect(saved.groups[0].result?.arrays.chi.length).toBeGreaterThan(0)
  expectRetainedInput(saved.groups[0], first)
  // Processing flushes the opened demo's model autosave before applying Rbkg.
  // Subsequent data-type changes must leave every other saved group intact.
  expect(saved.groups.slice(1)).toEqual(processed.groups.slice(1))
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: /^Rbkg/ })).toHaveValue('1.9')
  await expect.poll(() => energyCurve(page)).toEqual({ x: saved.groups[0].result?.arrays.energy, y: first.mu })
  await page.getByRole('button', { name: 'Spectrum processing settings', exact: true }).click()
  panel = page.getByRole('dialog', { name: 'Processing settings', exact: true })
  await expect(panel.getByRole('checkbox', { name: 'Input already normalized', exact: true })).toBeChecked()
  await expect(panel.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true })).toBeChecked()
  await panel.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true }).uncheck()
  saved = await command(page, 'change_datatype', () => panel.getByRole('button', { name: 'Apply settings', exact: true }).click())
  expect(saved.groups[0].data_type).toBe('xanes'); expect(saved.groups[0].is_normalized).toBe(true)
  expect(saved.groups[0].result?.arrays.chi).toEqual([])
  expectRetainedInput(saved.groups[0], first)
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(() => energyCurve(page)).toEqual({ x: saved.groups[0].result?.arrays.energy, y: first.mu })
  const undone = await command(page, 'undo', () => page.getByRole('button', { name: 'Undo', exact: true }).click())
  expect(undone.groups[0].data_type).toBe('norm')
  expect(undone.groups[0].is_normalized).toBe(true)
  expect(undone.groups[0].result?.arrays.chi.length).toBeGreaterThan(0)
  panel = await openSettings(page)
  await expect(panel.getByRole('checkbox', { name: 'Input already normalized', exact: true })).toBeChecked()
  await expect(panel.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true })).toBeChecked()
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  const redone = await command(page, 'redo', () => page.getByRole('button', { name: 'Redo', exact: true }).click())
  expect(redone.groups).toEqual(saved.groups)
  await command(page, 'metadata', () => page.getByLabel(`Mark ${third.label}`, { exact: true }).click())
  await expect(page.getByLabel(`Mark ${third.label}`, { exact: true })).not.toBeChecked()
  await command(page, 'metadata', () => page.getByLabel(`Mark ${reference.label}`, { exact: true }).click())
  await expect(page.getByLabel(`Mark ${reference.label}`, { exact: true })).not.toBeChecked()
  panel = await openSettings(page)
  await expect(panel.getByRole('checkbox', { name: 'Input already normalized', exact: true })).toBeChecked()
  await expect(panel.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true })).not.toBeChecked()
  await panel.getByRole('combobox', { name: 'Apply settings to', exact: true }).selectOption('marked')
  await panel.getByRole('checkbox', { name: 'Input already normalized', exact: true }).uncheck()
  saved = await command(page, 'change_datatype', () => panel.getByRole('button', { name: 'Apply settings', exact: true }).click())
  expect(saved.last_operation?.datatype_results?.map(g => g.group_id)).toEqual([first.id, second.id])
  expect(saved.groups.map(g => g.data_type)).toEqual(initial.groups.map((group, index) => index < 2 ? 'xanes' : group.data_type))
  expect(saved.groups[0].is_normalized).toBe(false)
  expect(saved.groups[0].result?.arrays.norm).toEqual(first.result?.arrays.norm)
  expect(saved.groups[0].result?.arrays.chi).toEqual([])
  expectRetainedInput(saved.groups[0], first)
  await panel.screenshot({ path: info.outputPath('processing-marked.png') })
  await panel.getByRole('combobox', { name: 'Apply settings to', exact: true }).selectOption('all')
  await panel.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true }).check()
  saved = await command(page, 'change_datatype', () => panel.getByRole('button', { name: 'Apply settings', exact: true }).click())
  expect(saved.groups.map(g => g.data_type)).toEqual(initial.groups.map(() => 'mu'))
  expect(saved.groups.every(g => !g.is_normalized)).toBe(true)
  expect(saved.groups[0].result?.arrays.chi).toEqual(first.result?.arrays.chi)
  expectRetainedInput(saved.groups[0], first)
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('region', { name: 'Single spectrum viewer', exact: true }).getByRole('radio', { name: 'μ(E) · normalized', exact: true }).check()
  await expect.poll(() => energyCurve(page)).toEqual({ x: first.result?.arrays.energy, y: first.result?.arrays.norm })
  await expect(page.getByRole('spinbutton', { name: /^Rbkg/ })).toHaveValue('1.9')
  expect(errors).toEqual([])
})

test('normalized input with EXAFS disabled survives downloaded .prj and reopened plots', async ({ page }, info) => {
  test.setTimeout(90000)
  await page.goto('/')
  await command(page, 'example', () => page.getByRole('button', { name: 'Load copper examples', exact: true }).click())
  await page.locator('.ath-group-select').filter({ hasText: 'Cu foil · 10 K' }).click()
  await page.getByRole('tab', { name: 'Processing', exact: true }).click()
  const panel = await openSettings(page)
  await panel.getByRole('checkbox', { name: 'Input already normalized', exact: true }).check()
  await panel.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true }).uncheck()
  const saved = await command(page, 'change_datatype', () => panel.getByRole('button', { name: 'Apply settings', exact: true }).click())
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save project', exact: true }).click(); await confirmProjectSave(page)
  const path = info.outputPath('normalized-xanes.prj'); await (await download).saveAs(path)
  await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^Data groups 0\b/ })).toBeVisible()
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await page.getByLabel('Open project file', { exact: true }).setInputFiles(path)
  const open = page.getByRole('dialog', { name: 'Open a project', exact: true })
  await expect(open.getByRole('button', { name: 'Import all groups', exact: true })).toBeEnabled()
  const response = page.waitForResponse(r => r.url().endsWith('/restore-upload'), { timeout: 30000 })
  await open.getByRole('button', { name: 'Import all groups', exact: true }).click()
  const accepted = await response; expect(accepted.ok()).toBe(true)
  await expect(open).not.toBeVisible()
  const next = await accepted.json() as AthenaProject
  expect(next.id).not.toBe(saved.id)
  expect(next.groups).toHaveLength(saved.groups.length)
  const actual = next.groups.find(group => group.label === saved.groups[0].label)!
  expect(actual.data_type).toBe('xanes'); expect(actual.is_normalized).toBe(true)
  expect(actual.result?.arrays.norm).toEqual(saved.groups[0].mu)
  expect(actual.result?.arrays.chi).toEqual([])
  const savedReference = saved.groups.find(group => group.id === saved.groups[0].reference_id)
  const restoredReference = next.groups.find(group => group.label === savedReference?.label)
  expect(restoredReference).toBeDefined()
  expectRetainedInput(actual, { ...saved.groups[0], reference_id: restoredReference!.id })
  await page.reload()
  await page.locator(`[data-group-id="${actual.id}"] .ath-group-select`).click()
  await page.getByRole('button', { name: 'Spectrum processing settings', exact: true }).click()
  await expect(panel.getByRole('checkbox', { name: 'Input already normalized', exact: true })).toBeChecked()
  await expect(panel.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true })).not.toBeChecked()
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect.poll(() => energyCurve(page)).toEqual({ x: actual.result?.arrays.energy, y: saved.groups[0].mu })
})
