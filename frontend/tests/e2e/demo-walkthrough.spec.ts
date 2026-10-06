/**
 * One walk per moment of the feature demonstration: import from ten facilities,
 * raw XRF and fluorescence XAS, EXAFS fitting with the fast backend, and the
 * analysis tools.
 *
 * These are not unit tests of the features -- each feature already has its own
 * spec, and the component tests cover the branches. What these walk is the
 * path a person takes through the app: the same clicks in the same order
 * against a real backend, failing if any of them has moved. Every input is a
 * public example file or a synthetic scan written here. The screenshots go to
 * test-results/demo-walkthrough/, which is not committed; do not assert on
 * the image bytes anywhere.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const shots = join(root, 'frontend', 'test-results', 'demo-walkthrough')
const python = join(root, 'backend', '.venv', 'bin', 'python')
const backend = join(root, 'backend')
mkdirSync(shots, { recursive: true })
const shot = (name: string) => join(shots, `${name}.png`)

/** The synthetic NeXus scans stand in for facilities with no example file. */
const nexus = mkdtempSync(join(tmpdir(), 'demo-nexus-'))
execFileSync(python, [join(backend, 'scripts', 'write_demo_hdf5.py'), '--output', nexus],
  { encoding: 'utf8', cwd: root })

/** The fluorescence scan W2 walks; the same generator the XRF spec uses. */
const scanDirectory = mkdtempSync(join(tmpdir(), 'demo-xrf-'))
const scan = join(scanDirectory, 'synthetic.h5')
const scanSettings = JSON.parse(
  execFileSync(python, [join(backend, 'tests', 'xrf_xas_scan_fixture.py'), scan, '120'],
    { encoding: 'utf8', cwd: backend, env: { ...process.env, PYTHONPATH: `${backend}:${join(backend, 'tests')}` } })
    .trim().split('\n').pop() as string)

/**
 * Stamp a dialog as synthetic before its screenshot is taken, so that a
 * picture of synthetic data cannot later be mistaken for a measurement.
 */
async function labelSynthetic(dialog: Locator, text: string) {
  await dialog.evaluate((element, label) => {
    element.querySelector('[data-synthetic-label]')?.remove()
    const stamp = document.createElement('div')
    stamp.setAttribute('data-synthetic-label', '')
    stamp.textContent = label
    stamp.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:10000;'
      + 'background:#b3261e;color:#fff;padding:5px 14px;border-radius:4px;font:600 15px system-ui,sans-serif;'
      + 'pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.3)'
    if (getComputedStyle(element).position === 'static') (element as HTMLElement).style.position = 'relative'
    element.prepend(stamp)
  }, text)
}

function watchForErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function openImport(page: Page) {
  await expect(page.getByRole('button', { name: 'Import data', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  return page.getByRole('dialog', { name: 'Import spectra', exact: true })
}

/**
 * Upload one file, read the beamline the reader claimed, and import it.
 *
 * `sort` ticks "Sort ascending by energy", under the import dialog's
 * collapsed "Reference channel & ordering" section. Some of the measured
 * files below need it -- where two scan regions overlap the energy steps
 * backwards once, and the app refuses the import rather than importing a
 * scrambled spectrum. Ticking it on a file whose axis already ascends does
 * nothing, so W1 ticks it for every column file: this walk is checking that
 * each reader names its facility, not which files need axis repair.
 *
 * A refused import is reported, not thrown: the caller closes over a list of
 * problems and asserts once at the end, so a run that breaks several readers
 * names all of them instead of one per run.
 */
async function importBeamlineFile(page: Page, file: string, { sort = false } = {}) {
  const dialog = await openImport(page)
  const inspecting = page.waitForResponse(r => r.url().endsWith('/inspect'))
  await dialog.getByLabel('Choose data files', { exact: true }).setInputFiles(file)
  expect((await inspecting).ok()).toBe(true)
  const badge = dialog.getByRole('region', { name: 'Recognized beamline', exact: true })
  await expect(badge).toBeVisible()
  // The badge's heading is "<facility> · <beamline>", with the beamline left
  // out when the file does not name one, so the facility is the first part.
  const recognized = (await badge.locator('strong').innerText()).trim()
  const facility = recognized.split('·')[0].trim()
  if (sort) {
    await dialog.getByText('Reference channel & ordering', { exact: true }).click()
    await dialog.getByRole('checkbox', { name: /^Sort ascending by energy/ }).check()
  }
  // A reference channel the reader recognized is applied by default and
  // imports as a second group; its formula line says so.
  const referenced = await dialog.getByText(/^Reference = /).first().isVisible()
  const imported = page.waitForResponse(r => r.url().endsWith('/import'))
  await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const response = await imported
  if (!response.ok()) {
    // A refused import leaves its reason on screen; carry it out rather than
    // a bare false, so the next run has something to act on. The dialog stays
    // open on a refusal, so close it before the next file.
    const reason = await dialog.getByRole('alert').first().innerText({ timeout: 5000 }).catch(() => '')
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    return { recognized, facility, badge, referenced, refused: reason || (await response.text()) }
  }
  await expect(dialog).toHaveCount(0)
  return { recognized, facility, badge, referenced, refused: '' }
}

async function openProject(page: Page, file: string) {
  // The workbench opens a local workspace of its own on load and refuses to
  // import a project before it has one -- the dialog answers "Open a local
  // workspace before importing a project" and never shows an import button.
  // The project bar reads "Opening workspace…" until then, so wait for it.
  await expect(page.locator('.ath-project-name'))
    .not.toHaveText('Opening workspace…', { timeout: 120000 })
  // A reload restores the last project from the server, and the toolbar is
  // live before that finishes; a click that lands in the gap is swallowed and
  // no dialog opens. Press until it does rather than once and hope.
  const dialog = page.getByRole('dialog', { name: 'Open a project' })
  await expect(async () => {
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await expect(dialog).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 120000 })
  await dialog.getByLabel('Open project file', { exact: true }).setInputFiles(file)
  // Reading the project and building its preview is a round trip over every
  // group in the file, which is slow for the 28-spectrum glasses project.
  await expect(dialog.getByRole('button', { name: 'Import all groups', exact: true }))
    .toBeEnabled({ timeout: 120000 })
  const restored = page.waitForResponse(r => r.url().endsWith('/restore-upload'), { timeout: 180000 })
  await dialog.getByRole('button', { name: 'Import all groups', exact: true }).click()
  const project = await (await restored).json()
  await expect(dialog).toHaveCount(0, { timeout: 60000 })
  return project as { groups: { id: string; label: string }[] }
}

/**
 * Turn on Demeter's file plugins by name. They ship disabled, and four of the
 * files W1 opens are unreadable until theirs is on, so the walk does what the
 * user has to do rather than assuming a prepared browser.
 */
async function enablePlugins(page: Page, names: string[]) {
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
  const registry = page.getByRole('dialog', { name: 'Plugin registry', exact: true })
  for (const name of names) {
    const enable = registry.getByRole('checkbox', { name: `Enable ${name}` })
    await expect(enable).toBeEnabled()
    if (!(await enable.isChecked())) {
      const saved = page.waitForResponse(
        r => r.url().endsWith('/preferences/plugins') && r.request().method() === 'PUT')
      await enable.click()
      expect((await saved).ok()).toBe(true)
    }
    await expect(enable).toBeChecked()
  }
  return registry
}

const tool = async (page: Page, menu: string, title: string) => {
  await page.getByRole('button', { name: menu, exact: true }).click()
  await page.getByRole('button', { name: title, exact: true }).click()
  return page.getByRole('dialog', { name: title, exact: true })
}

test.describe('demo walkthrough', () => {
  test.describe.configure({ mode: 'serial' })

  test('W1 — a file from each of ten facilities opens and names its beamline', async ({ page }) => {
    // Ten imports, each re-plotting a growing project: about a minute apiece.
    test.setTimeout(900000)
    const errors = watchForErrors(page)
    await page.setViewportSize({ width: 1600, height: 1100 })
    await page.goto('/')

    // Beat 1: the table of what the app claims to read, from the server.
    const dialog = await openImport(page)
    const formats = page.waitForResponse(r => r.url().endsWith('/formats'))
    await dialog.getByText('Which beamlines and formats open here?', { exact: true }).click()
    expect((await formats).ok()).toBe(true)
    const table = dialog.getByRole('table', { name: 'Recognized beamlines and formats' })
    await expect(table).toBeVisible()
    const claim = dialog.getByText(/\d+ readers covering \d+ facilities/)
    await expect(claim).toBeVisible()
    await dialog.screenshot({ path: shot('w1-1-formats-table') })
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()

    // Beat 2: several of the measured files below are read by a Demeter
    // plugin, and plugins ship off. Turning them on is part of the walk. CMC
    // is not needed by any file here but is commonly ticked with them, so the
    // walk also checks it claims none of these.
    const registry = await enablePlugins(page, ['CMC', 'HXMA', 'SSRLA', 'PFBL12C', 'X23A2MED'])
    await registry.screenshot({ path: shot('w1-2-plugin-registry') })
    await registry.getByRole('button', { name: 'Close registry', exact: true }).click()

    // Beats 3-10: one real measured file per facility, each naming its own.
    // These are the eight facilities docs/beamline-coverage.md calls "opens
    // here" -- a file in this repository that a reader claims and converts.
    // The facility string is whatever the file calls itself, so "NSLS-II" and
    // "National Synchrotron Light Source" are two different places here.
    // Where a facility has several example files the one chosen is a file the
    // app can actually import: APS10BM_2019.dat and PF9A_2022.dat repeat an
    // energy (the 10-BM quick scan holds its first point three times; the 9809
    // collector's attained monochromator energy repeats at six points). Import
    // now averages rows at a repeated energy, with a warning; the walk keeps to
    // files whose axes need no repair.
    const measured: [string, string][] = [
      ['examples/xafsdata/beamlines/NSLS6BM_2019.dat', 'NSLS-II'],
      ['examples/xafsdata/beamlines/CLSHXMA.dat', 'Canadian Light Source'],
      ['examples/xafsdata/beamlines/ESRF_BM08_LISA_2021.dat', 'ESRF'],
      ['examples/xafsdata/beamlines/SSRL1_2006.dat', 'Stanford Synchrotron Radiation Lightsource'],
      ['examples/xafsdata/beamlines/SLS_PHOENIX_2023.dat', 'Swiss Light Source'],
      ['examples/xafsdata/beamlines/APS12BM_2019.dat', 'Advanced Photon Source'],
      ['examples/xafsdata/beamlines/PFBL12C_2005.dat', 'Photon Factory, KEK'],
      ['examples/xafsdata/beamlines/NSLS_XDAC_2011.dat', 'National Synchrotron Light Source'],
    ]
    // Beats 11-12: the two facilities with no example file here. These scans
    // are written to the documented NeXus layout, so they show the reader
    // working on the layout -- not that the facility's own files open. The
    // third and fourth synthetic layouts are ESRF's, which a real file covers.
    const synthetic: [string, string][] = [
      [join(nexus, 'synthetic_nxdata.nxs'), 'Diamond Light Source'],
      [join(nexus, 'synthetic_soleil_nexus.nxs'), 'SOLEIL'],
    ]

    const seen: string[] = []
    const problems: string[] = []
    let references = 0
    const walk = async (file: string, expected: string, sort: boolean) => {
      const { recognized, facility, refused, referenced } = await importBeamlineFile(page, file, { sort })
      if (!refused && referenced) references += 1
      if (refused) problems.push(`${file} was refused: ${refused}`)
      else if (facility !== expected) problems.push(`${file} named "${recognized}", expected ${expected}`)
      else seen.push(facility)
    }
    for (const [relative, expected] of measured) await walk(join(root, relative), expected, true)
    for (const [file, expected] of synthetic) await walk(file, expected, false)
    expect(problems).toEqual([])
    expect([...new Set(seen)].sort()).toHaveLength(10)
    await expect(page.getByRole('heading', { name: new RegExp(`^Data groups ${seen.length + references}\\b`) })).toBeVisible()
    await page.screenshot({ path: shot('w1-3-ten-facilities-loaded'), fullPage: false })
    expect(errors).toEqual([])
  })

  test('W2 — a raw XRF scan becomes XANES and is corrected for self-absorption', async ({ page }) => {
    test.setTimeout(300000)
    const errors = watchForErrors(page)
    await page.setViewportSize({ width: 1600, height: 1100 })
    await page.goto('/')

    // Beat 1: the spectra themselves, before any model is fitted to them.
    const viewer = await tool(page, 'Process', 'Raw XRF spectra and maps')
    // The frame, not the inspection: both URLs contain '/xrf-view', and the
    // picture used to be taken between them, of two empty plots.
    const framing = page.waitForResponse(r => r.url().endsWith('/xrf-view/frame'))
    await viewer.getByLabel('Choose detector file', { exact: true }).setInputFiles(scan)
    const framed = await framing
    expect(framed.ok(), await framed.text()).toBe(true)
    const frame = await framed.json()
    expect(frame.spectra.length).toBeGreaterThan(0)
    expect(frame.roi.length).toBe(scanSettings.points)
    await expect(viewer.getByRole('heading', { name: /\d+ points/ })).toBeVisible()
    for (const plot of ['XRF spectrum', 'Window trace'])
      await expect(viewer.getByLabel(plot, { exact: true }).locator('.js-line').first()).toBeAttached()
    await labelSynthetic(viewer, 'Synthetic demonstration scan — not measured data')
    await viewer.screenshot({ path: shot('w2-1-raw-xrf-spectra') })
    await viewer.getByRole('button', { name: 'Close dialog', exact: true }).click()

    // Beat 2: fit the lines point by point and pull the edge out of the target
    // element's amplitude, next to the window sum the beamline would have used.
    const panel = await tool(page, 'Process', 'Fluorescence XAS from XRF fit')
    const inspecting = page.waitForResponse(r => r.url().endsWith('/xrf-xas/inspect'))
    await panel.getByLabel('Choose fluorescence scan file', { exact: true }).setInputFiles(scan)
    expect((await inspecting).ok()).toBe(true)
    await expect(panel.getByRole('heading', { name: new RegExp(`${scanSettings.points} points`) })).toBeVisible()
    await panel.getByLabel('Target element', { exact: true }).fill(scanSettings.target)
    await panel.getByLabel('Matrix elements', { exact: true }).fill(scanSettings.matrix)
    for (const [label, value] of [['Fit window first channel', scanSettings.channel_lo],
      ['Fit window end channel (exclusive)', scanSettings.channel_hi],
      ['Comparison window first channel', scanSettings.roi_lo],
      ['Comparison window end channel (exclusive)', scanSettings.roi_hi]] as [string, number][])
      await panel.getByLabel(label, { exact: true }).fill(String(value))
    await panel.getByText('Normalization', { exact: true }).click()
    await panel.getByLabel('Edge energy E₀ (eV)', { exact: true }).fill(String(scanSettings.e0))
    await panel.getByLabel('Post-edge end (eV)', { exact: true }).fill('560')
    await expect(panel.getByRole('alert')).toHaveCount(0)

    const fitting = page.waitForResponse(r => r.url().endsWith('/xrf-xas/preview'))
    await panel.getByRole('button', { name: 'Fit preview', exact: true }).click()
    const preview = await fitting
    expect(preview.ok(), await preview.text()).toBe(true)
    const result = await preview.json()
    await expect(panel.getByRole('button', { name: 'Fit preview', exact: true })).toBeEnabled()
    // The point of the panel, in one assertion: the fitted curve's pre-edge
    // sits at zero and the window sum's does not.
    expect(Math.abs(result.quality.fit.null_test.mean_frac_of_jump)).toBeLessThan(0.02)
    expect(Math.abs(result.quality.roi.null_test.mean_frac_of_jump)).toBeGreaterThan(1)
    // The previewed spectrum is past the edge, where the target lines are lit.
    expect(result.spectrum.incident_ev).toBeGreaterThan(scanSettings.e0)
    for (const plot of ['XRF spectrum preview', 'Fluorescence XAS preview'])
      await expect(panel.getByLabel(plot, { exact: true }).locator('.js-line').first()).toBeAttached()
    await labelSynthetic(panel, 'Synthetic demonstration scan — scatter exaggerated, not measured data')
    await panel.screenshot({ path: shot('w2-2-xrf-extraction') })

    const making = page.waitForResponse(r => r.url().endsWith('/xrf-xas/make'))
    await panel.getByRole('button', { name: 'Make fluorescence XAS group', exact: true }).click()
    expect((await making).ok()).toBe(true)
    await expect(panel.getByRole('status')).toContainText('Created the fluorescence XAS group')
    await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
    // Two groups arrive, not one: the edge pulled out of the fitted target
    // amplitude, and beside it the plain sum over the comparison window that a
    // beamline would normally record. Keeping both lets a reader compare the
    // two side by side, so assert both are there by name, and then make the
    // fitted one current before correcting it.
    await expect(page.getByRole('heading', { name: /^Data groups 2\b/ })).toBeVisible()
    const fitted = page.getByRole('button', { name: /^synthetic\.h5 · Mn fluorescence μ\(E\)/ })
    await expect(page.getByRole('button', { name: /· window sum μ\(E\)/ })).toBeVisible()
    await fitted.click()

    // Beat 3: correct the group for self-absorption, and say out loud which
    // numbers are assumptions. The scan is synthetic Mn K; the sample form,
    // thickness and angles are stated here, not measured.
    const correction = await tool(page, 'Process', 'Fluorescence self-absorption')
    await correction.getByLabel('Correction', { exact: true }).selectOption('booth')
    await correction.getByLabel('Sample formula').fill('MnO')
    await correction.getByLabel('Absorbing element').fill('Mn')
    await correction.getByLabel('Absorption edge').fill('K')
    await correction.getByLabel('Incident angle (degrees)').fill('45')
    await correction.getByLabel('Exit angle (degrees)').fill('45')
    await correction.getByLabel(/^Thickness \(µm\)/).fill('3')
    await correction.getByLabel(/^Density \(g\/cm³\)/).fill('5.37')
    const results = correction.getByRole('region', { name: 'Self-absorption preview results', exact: true })
    await expect(results.getByRole('status')).toContainText(/Preview at project revision \d+/, { timeout: 60000 })
    await expect(correction.getByLabel('Corrected spectrum preview', { exact: true })
      .locator('.js-line').first()).toBeAttached()
    // The synthetic scan was made with no self-absorption in it, so this shows
    // what the correction does for an assumed geometry -- sensitivity -- and
    // not that it recovers anything.
    const assumed = 'Synthetic scan, no self-absorption injected — assumed geometry: shows sensitivity, not recovery'
    await labelSynthetic(correction, assumed)
    await correction.screenshot({ path: shot('w2-3-self-absorption-corrected') })

    // And the other half of the story: how deep the signal came from.
    await results.getByRole('button', { name: 'Probing depth', exact: true }).click()
    await expect(correction.getByLabel('Probing depth preview', { exact: true })
      .locator('.js-line').first()).toBeAttached()
    await labelSynthetic(correction, assumed)
    await correction.screenshot({ path: shot('w2-4-probing-depth') })
    expect(errors).toEqual([])
  })

  test('W3 — an EXAFS fit with the paths on screen, then the same fit differentiated', async ({ page }) => {
    test.setTimeout(300000)
    const errors = watchForErrors(page)
    await page.setViewportSize({ width: 1600, height: 1100 })
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    const examples = page.waitForResponse(r =>
      r.url().endsWith('/command') && r.request().postDataJSON()?.action === 'example')
    await page.getByRole('button', { name: 'Load copper examples', exact: true }).click()
    expect((await examples).ok()).toBe(true)
    await expect(page.getByText('Cu₂O EXAFS example added', { exact: true })).toBeVisible()

    // Loading the examples opens the prepared Cu₂O model in the fitting tab.
    await expect(page.getByRole('tab', { name: 'EXAFS fitting', exact: true }))
      .toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('checkbox', { name: /^Include path \d+$/ })).toHaveCount(4)

    // Beat 1: the paths, as geometry rather than as a list of file names.
    const viewer = page.getByRole('region', { name: 'FEFF path viewer', exact: true })
    await expect(viewer.getByRole('group', { name: 'FEFF path legend' }).getByRole('button')).toHaveCount(4)
    // The walkthrough's beat 1 steps 2 and 4: the starting-value contributions, ranked
    // by size. The picture is of that feature, not of an unticked checkbox.
    const previewed = page.waitForResponse(r => r.url().endsWith('/paths/preview'), { timeout: 60000 })
    await viewer.getByRole('checkbox', { name: /Show χ\(k\) and χ\(R\) contributions/ }).check()
    expect((await previewed).ok()).toBe(true)
    const contributions = viewer.getByRole('region', { name: 'Path contributions', exact: true })
    await expect(contributions.locator('.js-plotly-plot')).toBeVisible({ timeout: 60000 })
    await contributions.getByRole('button', { name: /^Sort by Peak/ }).click()
    const ranked = contributions.getByRole('table').getByRole('rowheader')
    await expect(ranked).toHaveCount(4)
    await expect(contributions.getByRole('columnheader', { name: /Peak/ })).toHaveAttribute('aria-sort', 'descending')
    // The walkthrough: at the starting values the twelve Cu neighbours (feff0002)
    // outweigh the two oxygens (feff0001); the fit then shrinks them.
    await expect(ranked.first()).toContainText('feff0002.dat')
    await viewer.screenshot({ path: shot('w3-1-feff-path-viewer') })

    // Beat 2: run the fit Larch runs.
    const fitted = page.waitForResponse(r => r.url().endsWith('/fit-saved'), { timeout: 120000 })
    await page.getByRole('button', { name: 'Run EXAFS fit', exact: true }).click()
    const response = await fitted
    expect(response.ok(), await response.text()).toBe(true)
    await expect(page.getByText('Fit completed. Results are in the plot panel.', { exact: true })).toBeVisible()
    const fitResults = page.getByRole('region', { name: 'EXAFS fit results', exact: true })
    await expect(fitResults.getByText('Fitted parameters', { exact: true })).toBeVisible()
    await fitResults.screenshot({ path: shot('w3-2-exafs-fit-results') })

    // Beat 3: the same model on the differentiable backend, with its timing.
    // The backend is optional and a standard deployment leaves it out; there
    // the panel is not offered at all, and the walk records that rather than
    // passing silently.
    const status = await (await page.request.get('/api/backend/api/artemis/fast-fit/status')).json()
    if (!status.available) {
      test.info().annotations.push({ type: 'fast backend absent', description: String(status.reason) })
      await expect(page.getByRole('heading', { name: 'Fast fit backend', exact: true })).toHaveCount(0)
      expect(errors).toEqual([])
      return
    }
    await expect(page.getByRole('heading', { name: 'Fast fit backend', exact: true })).toBeVisible()
    const refit = page.getByRole('button', { name: 'Refit on the fast backend', exact: true })
    await expect(refit).toBeEnabled()
    const fast = page.waitForResponse(r => r.url().includes('fast'), { timeout: 180000 })
    await refit.click()
    const fastResponse = await fast
    expect(fastResponse.ok(), await fastResponse.text()).toBe(true)
    const comparison = await fastResponse.json()
    expect(comparison.error ?? null, 'the differentiable backend is not installed on this server')
      .toBeNull()
    expect(comparison.success, comparison.message).toBe(true)
    await expect(refit).toBeEnabled()
    // The two forward models must be the same function before any timing or
    // parameter difference means anything. The backend reports that agreement
    // as the largest absolute difference between the reference and
    // differentiable weighted residuals at the converged parameters.
    expect(comparison.metadata.engine_parity).toBeLessThan(1e-6)
    // Timing is the other half of the claim, so check the panel really has
    // numbers to show, phase for phase, rather than "not recorded".
    for (const phase of ['optimizer', 'fit', 'total', 'compile']) {
      expect(comparison.metadata.seconds[phase], phase).toBeGreaterThan(0)
    }
    const fastPanel = page.getByRole('heading', { name: 'Fast fit backend', exact: true }).locator('xpath=..')
    await expect(fastPanel.getByRole('table', { name: /Same model and data/ })).toBeVisible()
    await expect(fastPanel.getByText('not recorded')).toHaveCount(0)
    // The verdict shown must be the one stated with its tolerances.
    await expect(fastPanel.getByText(/^Same answer within the stated tolerances/)).toBeVisible()
    await page.getByRole('heading', { name: 'Fast fit backend', exact: true })
      .locator('xpath=..').screenshot({ path: shot('w3-3-fast-fit-comparison') })
    expect(errors).toEqual([])
  })

  test('W4 — an unknown identified by combination search, and a shared-peak series', async ({ page }) => {
    test.setTimeout(600000)
    const errors = watchForErrors(page)
    await page.setViewportSize({ width: 1600, height: 1100 })

    // Beat 1: the unknown arsenic spectrum, with its standards suggested from
    // the library rather than carried in the project.
    await page.goto('/')
    const arsenic = await openProject(page, join(root, 'examples/xafsdata/AthenaProjectFiles/AsKa.prj'))
    // The unknown the walkthrough names, by its exact label: the project holds twelve
    // YLO2 soil scans, and the first match was YLO2_a_5, not the scripted one.
    const unknown = arsenic.groups.find(g => g.label === 'YLO2_a_1_AsKa.mrg')
    expect(unknown, 'AsKa.prj should hold YLO2_a_1_AsKa.mrg').toBeTruthy()
    if (!unknown) return
    await page.locator('.ath-group-select').filter({ hasText: unknown.label }).last().click()

    const lcf = await tool(page, 'Analysis', 'Linear combination fitting')
    const suggesting = page.waitForResponse(r => /suggest|analyze/.test(r.url()), { timeout: 120000 })
    await lcf.getByRole('button', { name: 'Suggest standards from the library', exact: true }).click()
    expect((await suggesting).ok()).toBe(true)
    const suggestions = lcf.getByRole('checkbox', { name: /^Use / })
    await expect(suggestions.first()).toBeVisible({ timeout: 120000 })
    await lcf.screenshot({ path: shot('w4-1-suggested-standards') })
    const take = Math.min(3, await suggestions.count())
    for (let i = 0; i < take; i += 1) await suggestions.nth(i).check()
    const adding = page.waitForResponse(r => r.url().includes('/projects/'), { timeout: 120000 })
    await lcf.getByRole('button', { name: /^Add \d+ selected to project$/ }).click()
    const addResponse = await adding
    expect(addResponse.ok(), await addResponse.text()).toBe(true)

    // The project opens with every group marked, so the search would otherwise
    // fit this soil scan against its own siblings -- sister scans of the same
    // sample, which explain it almost exactly and say nothing about its
    // chemistry. Keep only the standards just fetched from the library.
    // Deleting the project's own standards first would do the same thing.
    // The library copies carry the
    // same labels as those standards, so identify them by group id, not by
    // name: the fit list is the project's groups in order, minus the target.
    const grown = (await addResponse.json()) as { groups: { id: string }[] }
    const fresh = new Set(grown.groups.map(g => g.id).filter(id => !arsenic.groups.some(g => g.id === id)))
    expect(fresh.size).toBe(take)
    const order = grown.groups.map(g => g.id).filter(id => id !== unknown.id)
    const choices = lcf.locator('.ath-fit-groups label.ath-check')
    await expect(choices).toHaveCount(order.length)
    for (let i = 0; i < order.length; i += 1) {
      const box = choices.nth(i).locator('input[type="checkbox"]')
      const wanted = fresh.has(order[i])
      if ((await box.isChecked()) !== wanted) await box.setChecked(wanted)
    }

    await lcf.getByRole('checkbox', { name: 'Fit every combination' }).check()
    await lcf.getByLabel('Most standards').fill('3')
    const searching = page.waitForResponse(r => r.url().endsWith('/analyze'), { timeout: 180000 })
    await lcf.getByRole('button', { name: 'Run analysis', exact: true }).click()
    const searchResponse = await searching
    expect(searchResponse.ok(), await searchResponse.text()).toBe(true)
    // The panel closes itself once the analysis lands, putting the result in
    // the main pane; waiting for that is also the check that it did land.
    await expect(lcf).toHaveCount(0, { timeout: 60000 })
    const summary = page.locator('.ath-analysis-result')
    await expect(summary.getByRole('heading', { name: 'Combination search' })).toBeVisible()
    // Three standards and nothing else: three singles, three pairs, the triple.
    // Getting a different number means the selection above did not hold, and
    // the fit on screen is not the one the walkthrough describes.
    await expect(summary.getByText(/7 combinations fitted/)).toBeVisible()
    await summary.screenshot({ path: shot('w4-2-combination-search') })

    // Beat 2: a peak that is too weak to fit on its own, fitted as a series
    // with its centre and width shared across the four glasses.
    await page.goto('/')
    // Opening a project adds its groups to the workspace rather than replacing
    // it, so the arsenic groups from beat 1 are still here and the vanadium
    // ones are whatever is new. Picking "the first group" would select an
    // arsenic scan and fit a 5462-5478 eV window outside its measured range.
    const seen = new Set(grown.groups.map(g => g.id))
    const combined = await openProject(page, join(root, 'examples/xanes/Vglasses.prj'))
    const glasses = combined.groups.filter(g => !seen.has(g.id))
    expect(glasses.length).toBeGreaterThanOrEqual(4)
    // The four the walkthrough names, by the stem of each label.
    const chosen = [/ALL_45/, /ALL_35/, /ALL_25/, /LW_20/].map(stem => {
      const hit = glasses.find(g => stem.test(g.label))
      expect(hit, `Vglasses.prj should hold a spectrum matching ${stem}`).toBeTruthy()
      return hit!
    })
    await page.locator('.ath-group-select').filter({ hasText: chosen[0].label }).last().click()

    const peaks = await tool(page, 'Analysis', 'XANES peak fitting')
    await peaks.getByLabel('Range minimum').fill('5462')
    await peaks.getByLabel('Range maximum').fill('5478')
    // The walkthrough: start peak 1 from the data in this window, not from fixed numbers.
    await peaks.getByRole('button', { name: 'Estimate peak 1 from the data', exact: true }).click()
    const startCentre = Number(await peaks.getByLabel('Peak 1 center').inputValue())
    expect(startCentre).toBeGreaterThan(5466)
    expect(startCentre).toBeLessThan(5471)
    await peaks.getByRole('checkbox', { name: 'Fit a series with shared peaks' }).check()
    await peaks.getByRole('checkbox', { name: 'Share peak centres' }).check()
    await peaks.getByRole('checkbox', { name: 'Share peak widths' }).check()
    // Vglasses.prj holds 28 spectra and opens with all of them marked, beside
    // the arsenic groups still in the workspace. The point of the series fit
    // is that four glasses share one peak position, so fit exactly those four
    // and nothing else. The list is the project's groups in order.
    const wanted = new Set(chosen.map(g => g.id))
    const listed = combined.groups.map(g => g.id)
    const members = peaks.locator('.ath-fit-groups label.ath-check')
    await expect(members).toHaveCount(listed.length)
    for (let i = 0; i < listed.length; i += 1) {
      const box = members.nth(i).locator('input[type="checkbox"]')
      const keep = wanted.has(listed[i])
      if ((await box.isChecked()) !== keep) await box.setChecked(keep)
    }
    const series = page.waitForResponse(r => r.url().endsWith('/analyze'), { timeout: 180000 })
    await peaks.getByRole('button', { name: 'Run analysis', exact: true }).click()
    const seriesResponse = await series
    expect(seriesResponse.ok(), await seriesResponse.text()).toBe(true)
    await expect(peaks).toHaveCount(0, { timeout: 60000 })
    await expect(summary.getByRole('heading', { name: 'Peak series fit' })).toBeVisible()
    // The series must show whether one-at-a-time fits support the sharing,
    // and the trend plot, before the shared numbers.
    await expect(summary.getByRole('table', { name: /Is sharing supported/ })).toBeVisible()
    await expect(summary.getByRole('region', { name: 'Peak series trend' })).toBeVisible()
    await summary.screenshot({ path: shot('w4-3-peak-series') })
    // The next run (other sharing, fewer spectra) starts from this one: a
    // reopened dialog that reset to its default window re-estimated a centre
    // on a point some spectra never measured, and the fit was refused.
    const again = await tool(page, 'Analysis', 'XANES peak fitting')
    await expect(again.getByLabel('Range minimum')).toHaveValue('5462')
    await expect(again.getByLabel('Range maximum')).toHaveValue('5478')
    await expect(again.getByLabel('Peak 1 center')).toHaveValue(String(startCentre))
    await expect(again.getByRole('checkbox', { name: 'Fit a series with shared peaks' })).toBeChecked()
    const kept = again.locator('.ath-fit-groups label.ath-check input[type="checkbox"]')
    for (let i = 0; i < listed.length; i += 1) {
      if (wanted.has(listed[i])) await expect(kept.nth(i)).toBeChecked()
      else await expect(kept.nth(i)).not.toBeChecked()
    }
    await again.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(errors).toEqual([])
  })
})
