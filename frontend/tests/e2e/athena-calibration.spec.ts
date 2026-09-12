import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { CalibrationPreview } from '../../components/athena-calibration'

const fixture=fileURLToPath(new URL('../../../backend/tests/fixtures/xdi-official-cu_metal_rt.xdi',import.meta.url))
test.use({actionTimeout:15000})
async function curves(plot:Locator){
  await expect(plot.locator('.js-line').first()).toBeVisible()
  return plot.locator('.js-plotly-plot').evaluate(el=>(el as HTMLElement&{data:{x:number[];y:number[];name:string}[]}).data.map(t=>({x:[...t.x],y:[...t.y],name:t.name})))
}
async function load(page:Page){
  await page.goto('/');await page.getByRole('button',{name:'Import data',exact:true}).click()
  await page.getByLabel('Choose data files',{exact:true}).setInputFiles(fixture)
  const dialog=page.getByRole('dialog',{name:'Import spectra',exact:true})
  await dialog.getByRole('checkbox',{name:'Numerator i0',exact:true}).uncheck()
  await dialog.getByRole('checkbox',{name:'Numerator mutrans',exact:true}).check()
  await dialog.getByRole('checkbox',{name:'Denominator itrans',exact:true}).uncheck()
  await dialog.getByRole('checkbox',{name:'Natural log',exact:true}).uncheck()
  const rows=readFileSync(fixture,'utf8').split('\n').filter(l=>l.trim()&&!l.startsWith('#')).map(l=>l.trim().split(/\s+/).map(Number))
  await expect.poll(async()=>{const t=(await curves(dialog.getByLabel('Imported signal preview plot',{exact:true})))[0];return {x:t.x,y:t.y}}).toEqual({x:rows.map(r=>r[0]),y:rows.map(r=>r[3])})
  const waiting=page.waitForResponse(r=>r.url().endsWith('/import'));await dialog.getByRole('button',{name:'Import spectrum',exact:true}).click()
  const response=await waiting;expect(response.ok()).toBe(true);return await response.json() as AthenaProject
}
async function open(page:Page){
  await page.getByRole('button',{name:'Process',exact:true}).click();await page.getByRole('button',{name:'Calibrate energy',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Calibrate energy',exact:true})
  await expect(dialog.getByRole('button',{name:'Calibrate',exact:true})).toBeEnabled();return dialog
}
async function review(page:Page,dialog:Locator){
  const replot=dialog.getByRole('button',{name:'Replot calibration',exact:true});await expect(replot).toBeEnabled()
  const waiting=page.waitForResponse(r=>r.url().endsWith('/calibration/preview'));await replot.click()
  const response=await waiting;expect(response.ok()).toBe(true);const result=await response.json() as CalibrationPreview
  await expect(dialog.getByRole('button',{name:'Calibrate',exact:true})).toBeEnabled()
  const c=result.curve,expected=[{x:c.x,y:c.y,name:'Current energy axis'},{x:result.calibrated_curve?.x??c.x.map(x=>x+result.shift_delta),y:result.calibrated_curve?.y??c.y,name:'Calibrated energy axis'},{x:[c.marker.x],y:[c.marker.y],name:'Reference point'}]
  if(result.options.smoothing)expected.unshift({x:c.x,y:c.unsmoothed,name:'Without display smoothing'})
  await expect.poll(()=>curves(dialog.getByLabel('Calibration plot',{exact:true}))).toEqual(expected)
  return result
}
async function save(page:Page,dialog:Locator){
  const waiting=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='calibrate')
  await dialog.getByRole('button',{name:'Calibrate',exact:true}).click();const response=await waiting
  expect(response.ok()).toBe(true);await expect(dialog).toHaveCount(0);return await response.json() as AthenaProject
}

test('Cu import figure, four calibration displays, raw/SG smoothing, zero crossing, exact save and PRJ',async({page},info)=>{
  test.setTimeout(150000);await page.setViewportSize({width:1500,height:1040})
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const initial=await load(page),dialog=await open(page)
  await expect(dialog.getByLabel('Calibrate to · eV',{exact:true})).toHaveValue('8979')
  for(const display of ['mu','norm','derivative','second']){
    await dialog.getByLabel('Calibration display',{exact:true}).selectOption(display)
    const preview=await review(page,dialog);expect(preview.options.display).toBe(display)
  }
  await dialog.getByLabel('Calibration smoothing',{exact:true}).fill('3')
  const three=await review(page,dialog);expect(three.curve.y).not.toEqual(three.curve.unsmoothed)
  await page.screenshot({path:info.outputPath('calibration-second-three-point.png'),animations:'disabled'})
  await dialog.getByLabel('Calibration smoothing method',{exact:true}).selectOption('savitzky_golay')
  const sg=await review(page,dialog);expect(sg.options.sg_window).toBe(31);expect(sg.options.sg_order).toBe(9)
  const waiting=page.waitForResponse(r=>r.url().endsWith('/calibration/zero'))
  await dialog.getByRole('button',{name:'Find zero crossing',exact:true}).click()
  const zero=await waiting;expect(zero.ok()).toBe(true);const z=await zero.json() as CalibrationPreview
  await expect(dialog.getByLabel('Observed reference · eV',{exact:true})).toHaveValue(String(z.zero_crossing))
  const preview=await review(page,dialog)
  await page.screenshot({path:info.outputPath('calibration-zero-sg.png'),animations:'disabled'})
  expect((await(await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json()).version).toBe(initial.version)
  const calibrated=await save(page,dialog),before=initial.groups[0],after=calibrated.groups[0]
  expect(after.id).toBe(before.id);expect(after.energy).toEqual(before.energy);expect(after.mu).toEqual(before.mu);expect(after.source).toEqual(before.source)
  expect(after.parameters.e0).toBe(preview.options.target);expect(after.parameters.energy_shift).toBe(preview.energy_shift)
  expect(Math.abs(preview.actual_reference-preview.options.target!)).toBeLessThanOrEqual(.000501)
  const undo=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='undo');await page.getByRole('button',{name:'Undo',exact:true}).click();expect((await(await undo).json()).groups).toEqual(initial.groups)
  const redo=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='redo');await page.getByRole('button',{name:'Redo',exact:true}).click();expect((await(await redo).json()).groups).toEqual(calibrated.groups)
  const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click()
  const path=info.outputPath('Cu-calibrated-native.prj');await(await downloading).saveAs(path)
  writeFileSync(path,gunzipSync(readFileSync(path)).toString().split('\n').filter(l=>!l.startsWith('# Athena-Web ')).join('\n'))
  await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Open project…',exact:true}).click()
  await page.getByLabel('Open project file',{exact:true}).setInputFiles(path)
  const restoring=page.waitForResponse(r=>r.url().endsWith('/restore-upload'));await page.getByRole('button',{name:'Import all groups',exact:true}).click()
  const response=await restoring;expect(response.ok()).toBe(true);const restored=(await response.json()).groups.at(-1)
  expect(restored.energy).toEqual(after.energy);expect(restored.mu).toEqual(after.mu)
  expect(restored.parameters.e0).toBe(after.parameters.e0);expect(restored.parameters.energy_shift).toBe(after.parameters.energy_shift)
  expect(errors).toEqual([])
})

test('mobile actual point pick, cancel, retained smoothing and concurrent-edit recovery',async({page,context},info)=>{
  test.setTimeout(120000);await page.setViewportSize({width:390,height:844})
  const initial=await load(page);let dialog=await open(page)
  const first=await review(page,dialog)
  await dialog.getByRole('button',{name:'Select a point',exact:true}).click()
  const index=first.curve.x.reduce((best,x,i)=>Math.abs(x-first.options.observed!)<Math.abs(first.curve.x[best]-first.options.observed!)?i:best,0)
  const point=dialog.getByLabel('Calibration plot',{exact:true}).locator('.scatterlayer .trace').first().locator('.point').nth(index)
  await point.click({force:true});await expect(dialog.getByLabel('Observed reference · eV',{exact:true})).toHaveValue(String(first.curve.x[index]))
  await dialog.getByLabel('Calibration smoothing',{exact:true}).fill('2');await review(page,dialog)
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  await dialog.getByLabel('Calibration plot',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('calibration-mobile-plot.png'),animations:'disabled'})
  const path=`/api/backend/api/athena/projects/${initial.id}`
  await dialog.getByRole('button',{name:'Cancel calibration',exact:true}).click()
  expect(await(await page.request.get(path)).json()).toEqual(initial)
  dialog=await open(page);await expect(dialog.getByLabel('Calibration smoothing',{exact:true})).toHaveValue('2')
  const other=await context.newPage();await other.goto('/')
  const update=await other.request.post(path+'/command',{data:{version:initial.version,action:'metadata',group_ids:[initial.groups[0].id],options:{notes:'Calibration reviewed elsewhere'}}})
  expect(update.ok()).toBe(true)
  const stale=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='calibrate')
  await dialog.getByRole('button',{name:'Calibrate',exact:true}).click();expect((await stale).status()).toBe(409)
  await expect(dialog.getByRole('alert')).toBeVisible()
  expect((await(await other.request.get(path)).json()).groups[0].parameters).toEqual(initial.groups[0].parameters)
  await dialog.getByRole('button',{name:'Cancel calibration',exact:true}).click();await page.reload();dialog=await open(page)
  const preview=await review(page,dialog)
  await dialog.getByRole('button',{name:'Calibrate',exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('calibration-mobile-actions.png'),animations:'disabled'})
  const after=await save(page,dialog);expect(after.groups[0].parameters.energy_shift).toBe(preview.energy_shift)
  await other.close()
})

for(const viewport of [{width:1500,height:1150},{width:390,height:844}])test(`measured outer fit limits survive normalized calibration and bare PRJ at ${viewport.width}px`,async({page},info)=>{
  test.setTimeout(120000);await page.setViewportSize(viewport)
  const initial=await load(page)
  await page.getByRole('spinbutton',{name:/^Pre-edge start/}).fill('-1000')
  await page.getByRole('spinbutton',{name:/^Post-edge end/}).fill('5000')
  const applying=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='parameters')
  await page.getByRole('button',{name:'Apply parameters',exact:true}).click()
  const applied=await applying;expect(applied.ok()).toBe(true);const project=await applied.json() as AthenaProject
  expect(project.groups[0].processing_error).toBeNull()
  await expect(page.getByRole('spinbutton',{name:/^Pre-edge start/})).toHaveValue('-1000')
  await expect(page.getByRole('spinbutton',{name:/^Post-edge end/})).toHaveValue('5000')
  await expect(page.getByText(/^Used in saved result:/).first()).toBeVisible()
  const dialog=await open(page)
  await dialog.getByLabel('Calibration display',{exact:true}).selectOption('norm')
  await dialog.getByLabel('Observed reference · eV',{exact:true}).fill(String(Number(project.groups[0].result!.effective.e0)+3.12345))
  const preview=await review(page,dialog)
  expect(preview.curve.normalization).toHaveLength(2)
  expect(preview.normalization_limits?.[0].adjustments).toHaveLength(2)
  expect(preview.processing_errors).toEqual({})
  expect(preview.curve.y).not.toEqual(preview.calibrated_curve?.y)
  await expect(dialog.getByRole('region',{name:'Normalization fit limits'})).toContainText('requested 5000')
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  await dialog.getByLabel('Calibration plot',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('normalization-limits-plot.png'),animations:'disabled'})
  await dialog.getByRole('region',{name:'Normalization fit limits'}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('normalization-limits-values.png'),animations:'disabled'})
  const saved=await save(page,dialog),group=saved.groups[0]
  expect(group.parameters.pre1).toBe(-1000);expect(group.parameters.norm2).toBe(5000)
  expect(group.result!.arrays.flat).toEqual(preview.calibrated_curve?.y)
  expect(group.energy).toEqual(initial.groups[0].energy);expect(group.mu).toEqual(initial.groups[0].mu)
  const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click()
  const path=info.outputPath('Cu-normalization-limits.prj');await(await downloading).saveAs(path)
  writeFileSync(path,gunzipSync(readFileSync(path)).toString().split('\n').filter(l=>!l.startsWith('# Athena-Web ')).join('\n'))
  await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Open project…',exact:true}).click()
  await page.getByLabel('Open project file',{exact:true}).setInputFiles(path)
  const restoring=page.waitForResponse(r=>r.url().endsWith('/restore-upload'));await page.getByRole('button',{name:'Import all groups',exact:true}).click()
  const response=await restoring;expect(response.ok()).toBe(true);const restored=(await response.json()).groups.at(-1)
  expect(restored.parameters.pre1).toBe(-1000);expect(restored.parameters.norm2).toBe(5000)
  expect(restored.processing_error).toBeNull();expect(restored.result.arrays.flat).toEqual(group.result!.arrays.flat)
})
