import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'

// The component tests run against a mocked API, so a field renamed on one side
// alone still passes there. These two run the real upload, the real solve and
// the real project store, which is the only place that disagreement shows.
const python=fileURLToPath(new URL('../../../backend/.venv/bin/python',import.meta.url))
const generator=fileURLToPath(new URL('../../../backend/tests/xrf_xas_scan_fixture.py',import.meta.url))
const backend=fileURLToPath(new URL('../../../backend',import.meta.url))
const scan=join(mkdtempSync(join(tmpdir(),'xrf-xas-')),'synthetic.h5')
// 120 points: below about that many over this range Larch refuses the spline
// background, and the exported group has to process the way a real one would.
const settings=JSON.parse(execFileSync(python,[generator,scan,'120'],
  {encoding:'utf8',cwd:backend,env:{...process.env,PYTHONPATH:`${backend}:${join(backend,'tests')}`}})
  .trim().split('\n').pop() as string)

type Curve={x:number[];y:number[]}
async function curve(plot:Locator,index:number):Promise<Curve> {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate((node,i)=>{
    const t=(node as HTMLElement & {data:{x:number[];y:number[]}[]}).data[i]
    return {x:[...t.x],y:[...t.y]}
  },index)
}
const far=(a:number[],b:number[])=>a.length===b.length?Math.max(...a.map((v,i)=>Math.abs(v-b[i]))):Infinity

async function open(page:Page) {
  await page.goto('/')
  await page.getByRole('button',{name:'Process',exact:true}).click()
  await page.getByRole('button',{name:'Fluorescence XAS from XRF fit',exact:true}).click()
  return page.getByRole('dialog',{name:'Fluorescence XAS from XRF fit',exact:true})
}

/** Upload the synthetic scan and type in the settings that describe it. */
async function prepare(page:Page,panel:Locator) {
  const inspecting=page.waitForResponse(r=>r.url().endsWith('/xrf-xas/inspect'))
  await panel.getByLabel('Choose fluorescence scan file',{exact:true}).setInputFiles(scan)
  expect((await inspecting).ok()).toBe(true)
  await expect(panel.getByRole('heading',{name:new RegExp(`${settings.points} points`)})).toBeVisible()
  await panel.getByLabel('Target element',{exact:true}).fill(settings.target)
  await panel.getByLabel('Matrix elements',{exact:true}).fill(settings.matrix)
  for (const [label,value] of [['Fit window first channel',settings.channel_lo],
    ['Fit window end channel (exclusive)',settings.channel_hi],
    ['Comparison window first channel',settings.roi_lo],
    ['Comparison window end channel (exclusive)',settings.roi_hi]] as [string,number][])
    await panel.getByLabel(label,{exact:true}).fill(String(value))
  await panel.getByText('Detector model and calibration',{exact:true}).click()
  // The panel strides only past 400 points (ceil(points/400)), so on these
  // 120 it chooses 1. The tests below are about a strided preview -- the
  // export refits every point, so the two must agree where they overlap --
  // so the stride is set to 2 by hand after checking the panel's own choice.
  const stride=panel.getByLabel('Preview point stride',{exact:true})
  await expect(stride).toHaveValue(String(Math.max(1,Math.ceil(settings.points/400))))
  await stride.fill('2')
  await panel.getByText('Normalization',{exact:true}).click()
  await panel.getByLabel('Edge energy E₀ (eV)',{exact:true}).fill(String(settings.e0))
  await panel.getByLabel('Post-edge end (eV)',{exact:true}).fill('560')
  await expect(panel.getByRole('alert')).toHaveCount(0)
}

async function fit(page:Page,panel:Locator) {
  const fitting=page.waitForResponse(r=>r.url().endsWith('/xrf-xas/preview'))
  await panel.getByRole('button',{name:'Fit preview',exact:true}).click()
  const response=await fitting;expect(response.ok(),await response.text()).toBe(true)
  await expect(panel.getByRole('button',{name:'Fit preview',exact:true})).toBeEnabled()
  return response.json()
}

test('plots the extraction the server actually returned, through the real upload and solve',async({page},info)=>{
  test.setTimeout(180000)
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const panel=await open(page)
  await prepare(page,panel)
  const result=await fit(page,panel)

  const stride=result.metadata.request.point_stride
  expect(stride).toBeGreaterThan(1)
  expect(result.metadata.points).toBe(Math.ceil(settings.points/stride))
  expect(result.metadata.scan_points).toBe(settings.points)
  expect(result.metadata.detectors).toBe(2)
  const xas=panel.getByLabel('Fluorescence XAS preview',{exact:true})
  const extraction=await curve(xas,0)
  const window=await curve(panel.getByLabel('Window sum preview',{exact:true}),0)
  expect(extraction.x).toEqual(result.energy_ev)
  expect(far(extraction.y,result.fit_norm)).toBeLessThan(1e-12)
  expect(far(window.y,result.roi_norm)).toBeLessThan(1e-12)
  // Both curves describe the same edge, so they must not be the same curve:
  // the whole point of the panel is that the reader can see them differ.
  expect(far(extraction.y,window.y)).toBeGreaterThan(0.01)
  const spectrum=panel.getByLabel('XRF spectrum preview',{exact:true})
  expect((await curve(spectrum,0)).x).toEqual(result.spectrum.energy_kev)
  // The quality block has to carry the server's own numbers, not a second
  // opinion computed in the browser. The synthetic scan does not pass every
  // indicator -- Larch's arctan edge leaves a real tail in the pre-edge, and
  // the two detector elements are built with a 30% gain difference -- so what
  // is checked here is that the numbers on screen are the ones returned.
  const quality=panel.getByLabel('Extraction quality',{exact:true})
  const pc=(v:number)=>`${(v*100).toFixed(2)}%`
  await expect(quality).toContainText(`mean ${pc(result.quality.fit.null_test.mean_frac_of_jump)}`)
  await expect(quality).toContainText(`mean ${pc(result.quality.roi.null_test.mean_frac_of_jump)}`)
  await expect(quality).toContainText(`${result.metadata.detectors} elements`)
  // And the reason for the whole panel: the window sum's pre-edge is nowhere
  // near zero, while the fit's is inside the tolerance the hint states.
  expect(Math.abs(result.quality.fit.null_test.mean_frac_of_jump)).toBeLessThan(0.02)
  expect(Math.abs(result.quality.roi.null_test.mean_frac_of_jump)).toBeGreaterThan(1)
  await panel.screenshot({path:info.outputPath('xrf-xas-preview.png')})
  expect(errors).toEqual([])
})

test('exports a curve that passes through every point the reader was shown',async({page})=>{
  test.setTimeout(180000)
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const panel=await open(page)
  await prepare(page,panel)
  const result=await fit(page,panel)

  const making=page.waitForResponse(r=>r.url().endsWith('/xrf-xas/make'))
  await panel.getByRole('button',{name:'Make fluorescence XAS group',exact:true}).click()
  const response=await making;expect(response.ok(),await response.text()).toBe(true)
  const project=await response.json()
  const fitted=project.groups.find((g:{label:string})=>g.label.endsWith('Mn fluorescence'))
  const summed=project.groups.find((g:{label:string})=>g.label.endsWith('window sum'))
  expect(fitted).toBeTruthy();expect(summed).toBeTruthy()
  // The preview strides and the export does not, so the exported group is
  // longer. It still has to be the same extraction: every point the reader
  // saw must reappear, bit for bit, at the same incident energy. It did not
  // before, because the stride also thinned the calibration points and the
  // continuum estimate, so the export was a different fit with a different
  // answer -- the reader approved one curve and saved another.
  const stride=result.metadata.request.point_stride
  expect(fitted.energy).toHaveLength(settings.points)
  expect(result.energy_ev).toHaveLength(Math.ceil(settings.points/stride))
  const at=(series:number[])=>result.energy_ev.map((_:number,i:number)=>series[i*stride])
  expect(at(fitted.energy)).toEqual(result.energy_ev)
  expect(far(at(fitted.mu),result.fit_over_i0)).toBe(0)
  expect(far(at(summed.mu),result.roi_over_i0)).toBe(0)
  expect(fitted.processing_error).toBeNull()
  await expect(panel.getByRole('status')).toContainText('Created the fluorescence XAS group')
  await panel.getByRole('button',{name:'Close dialog',exact:true}).click()
  await expect(page.getByRole('heading',{name:/Data groups\s*2\b/})).toBeVisible()
  expect(errors).toEqual([])
})
