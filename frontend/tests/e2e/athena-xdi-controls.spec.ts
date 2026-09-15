import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

const fixtures = fileURLToPath(new URL('../../../backend/tests/fixtures/', import.meta.url))
async function openMetadata(page: Page) {
  await page.getByRole('button', { name: 'Group', exact: true }).click()
  const loading = page.waitForResponse(r => r.url().endsWith('/xdi'))
  await page.getByRole('button', { name: 'File metadata…', exact: true }).click()
  const response = await loading; expect(response.ok()).toBe(true)
  const dialog = page.getByRole('dialog', { name: 'File metadata', exact: true })
  await expect(dialog.getByLabel('XDI comments', { exact: true })).toBeEnabled()
  return { dialog, data: await response.json() }
}
async function command(page: Page, action: string, button: () => Promise<unknown>) {
  const waiting = page.waitForResponse(r => r.url().endsWith('/command') && r.request().postDataJSON().action === action)
  await button(); const response = await waiting
  return response
}

for (const file of ['xdi-official-cu_metal_rt.xdi', 'demeter-x11a-cu.012']) {
  test(`${file}: native field validation, frozen comment save, undo and independent PRJ restore`, async ({ page }, info) => {
    test.setTimeout(90000)
    const mobile = file.endsWith('.012'), errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.setViewportSize({ width: mobile ? 390 : 1500, height: mobile ? 844 : 1040 })
    await page.goto('/'); await page.getByRole('button', { name: 'Import data', exact: true }).click()
    await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fixtures+file)
    const importing = page.waitForResponse(r => r.url().endsWith('/import'))
    await page.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const imported = await importing; expect(imported.ok()).toBe(true)
    const initial = await imported.json(), original = initial.groups[0]
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Group', exact: true }).click()
    const frozen = await command(page, 'metadata', () => page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Freeze group', exact: true }).click())
    expect(frozen.ok()).toBe(true)
    let { dialog, data } = await openMetadata(page)
    await expect(dialog.getByText('Required metadata: 3 of 3 present', { exact: true })).toBeVisible()
    const validating = page.waitForResponse(r => r.url().endsWith('/xdi/validate'))
    await dialog.getByRole('button', { name: 'Validate all', exact: true }).click()
    const validation = await validating; expect(validation.ok()).toBe(true)
    expect((await validation.json()).engine).toBe('Larch XDI')
    await expect(dialog.getByRole('region', { name: 'Validation results' })).toBeVisible()
    await dialog.evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: info.outputPath(mobile ? 'xdi-fields-mobile.png' : 'xdi-fields-desktop.png') })
    await dialog.getByRole('button', { name: 'Collapse all families' }).click()
    await expect(dialog.getByRole('rowheader')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Expand all families' }).click()
    const checking = page.waitForResponse(r => r.url().endsWith('/xdi/validate'))
    await dialog.getByRole('button', { name: 'Validate Element.symbol' }).click()
    expect((await checking).ok()).toBe(true)
    await expect(dialog.getByRole('region', { name: 'Validation results' })).toContainText('1 field checked · 0 need attention')
    const comments = '  Reviewed μ 铜 "Cu" $notes @beamline\nSecond line\twith details\n'
    await dialog.getByLabel('XDI comments').fill(comments)
    if (mobile) {
      const changed = await page.request.post(`/api/backend/api/athena/projects/${initial.id}/command`, { data: {
        version: data.version, action: 'metadata', group_ids: [original.id], options: { notes: 'Second window note' },
      } })
      expect(changed.ok()).toBe(true)
      const conflict = await command(page, 'xdi_comments', () => dialog.getByRole('button', { name: 'Save comments' }).click())
      expect(conflict.status()).toBe(409)
      await expect(dialog.getByRole('alert')).toBeVisible()
      await expect(dialog.getByLabel('XDI comments')).toHaveValue(comments)
      await dialog.getByRole('button', { name: 'Reload saved metadata' }).click()
      await expect(dialog.getByLabel('XDI comments')).toHaveValue(data.comments)
      await dialog.getByLabel('XDI comments').fill(comments)
    }
    const saving = await command(page, 'xdi_comments', () => dialog.getByRole('button', { name: 'Save comments' }).click())
    expect(saving.ok()).toBe(true)
    const saved = await saving.json(), group = saved.groups[0]
    expect(group.frozen).toBe(true)
    expect(group.parameters).toEqual(original.parameters); expect(group.result).toEqual(original.result)
    expect(group.energy).toEqual(original.energy); expect(group.mu).toEqual(original.mu)
    expect(group.source.xdi_metadata.comments_text).toBe(comments)
    expect(group.notes).toBe(mobile ? 'Second window note' : original.notes)
    await expect(dialog.getByText(/XDI comments saved/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Save comments' })).toBeDisabled()
    await dialog.getByLabel('XDI comments').scrollIntoViewIfNeeded()
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth+1)).toBe(true)
    await page.screenshot({ path: info.outputPath(mobile ? 'xdi-comments-mobile.png' : 'xdi-comments-desktop.png') })
    await dialog.getByRole('button', { name: 'Close metadata' }).click()
    const undone = await command(page, 'undo', () => page.getByRole('button', { name: 'Undo', exact: true }).click())
    expect(undone.ok()).toBe(true)
    ;({ dialog } = await openMetadata(page)); await expect(dialog.getByLabel('XDI comments')).toHaveValue(data.comments)
    await dialog.getByRole('button', { name: 'Close metadata' }).click()
    const redone = await command(page, 'redo', () => page.getByRole('button', { name: 'Redo', exact: true }).click())
    expect(redone.ok()).toBe(true); await page.reload()
    ;({ dialog } = await openMetadata(page)); await expect(dialog.getByLabel('XDI comments')).toHaveValue(comments)
    await dialog.getByRole('button', { name: 'Close metadata' }).click()
    await page.getByRole('button', { name: 'File', exact: true }).click()
    const downloading = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Save Athena project (.prj)', exact: true }).click()
    const download = await downloading, path = info.outputPath('comments.prj'); await download.saveAs(path)
    writeFileSync(path, gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(l => !l.startsWith('# Athena-Web ')).join('\n'))
    const menu = page.getByRole('button', { name: 'File', exact: true })
    if (await menu.getAttribute('aria-expanded') !== 'true') await menu.click()
    await page.getByRole('button', { name: 'Open project…', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(path)
    const restoring = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const restored = await restoring; expect(restored.ok()).toBe(true)
    const native = (await restored.json()).groups.at(-1)
    expect(native.source.xdi_metadata.comments_text).toBe(comments)
    expect(native.mu).toEqual(original.mu)
    expect(native.notes).toBe(mobile ? 'Second window note' : original.notes)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    ;({ dialog } = await openMetadata(page))
    const rechecking = page.waitForResponse(r => r.url().endsWith('/xdi/validate'))
    await dialog.getByRole('button', { name: 'Validate all', exact: true }).click()
    const rechecked = await rechecking; expect(rechecked.ok()).toBe(true)
    if (!mobile) expect((await rechecked.json()).valid).toBe(true)
    expect(errors).toEqual([])
  })
}

test('ordinary groups expose absorber metadata and missing field status', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load copper foil example', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit group information', exact: true })).toBeVisible()
  const { dialog } = await openMetadata(page)
  await expect(dialog.getByText('Required metadata: 2 of 3 present', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Recommended metadata: 0 of 5 present', { exact: true })).toBeVisible()
  await dialog.getByText('Required metadata: 2 of 3 present', { exact: true }).click()
  await expect(dialog.getByText('Mono.d_spacing:', { exact: false })).toContainText('missing')
  await dialog.getByLabel('XDI comments').fill('Example-specific XDI comments')
  const saved = await command(page, 'xdi_comments', () => dialog.getByRole('button', { name: 'Save comments' }).click())
  expect(saved.ok()).toBe(true)
  expect((await saved.json()).groups[0].notes).toBe('')
})
