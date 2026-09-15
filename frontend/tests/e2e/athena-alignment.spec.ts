import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { AlignmentPreview } from '../../components/athena-alignment'

const file=fileURLToPath(new URL('../../../backend/tests/fixtures/xdi-official-cu_metal_rt.xdi',import.meta.url))
const original=readFileSync(file,'utf8')
test.use({actionTimeout:15000})
async function curves(plot:Locator){
  await expect(plot.locator('.js-line').first()).toBeVisible()
  return plot.locator('.js-plotly-plot').evaluate(el=>(el as HTMLElement&{data:{x:number[];y:number[];name:string}[]}).data.map(t=>({x:[...t.x],y:[...t.y],name:t.name})))
}
async function load(page:Page){
  await page.goto('/');let project:AthenaProject|undefined
  for(const shifted of [false,true]){
    await page.getByRole('button',{name:'Import data',exact:true}).click()
    const content=original.split('\n').map(l=>{if(!shifted||!l.trim()||l.startsWith('#'))return l;const a=l.trim().split(/\s+/).map(Number);a[0]+=3.1254;a[3]*=2;return a.join(' ')}).join('\n')
    await page.getByLabel('Choose data files',{exact:true}).setInputFiles({name:shifted?'Cu-shifted.xdi':'Cu-standard.xdi',mimeType:'text/plain',buffer:Buffer.from(content)})
    const dialog=page.getByRole('dialog',{name:'Import spectra',exact:true})
    await dialog.getByRole('checkbox',{name:'Numerator i0',exact:true}).uncheck()
    await dialog.getByRole('checkbox',{name:'Numerator mutrans',exact:true}).check()
    await dialog.getByRole('checkbox',{name:'Denominator itrans',exact:true}).uncheck()
    await dialog.getByRole('checkbox',{name:'Natural log',exact:true}).uncheck()
    const rows=content.split('\n').filter(l=>l.trim()&&!l.startsWith('#')).map(l=>l.trim().split(/\s+/).map(Number))
    await expect.poll(async()=>{const t=(await curves(dialog.getByLabel('Imported signal preview plot',{exact:true})))[0];return {x:t.x,y:t.y}}).toEqual({x:rows.map(r=>r[0]),y:rows.map(r=>r[3])})
    const wait=page.waitForResponse(r=>r.url().endsWith('/import'));await dialog.getByRole('button',{name:'Import spectrum',exact:true}).click()
    const response=await wait;expect(response.ok()).toBe(true);project=await response.json();await expect(dialog).toHaveCount(0)
  }
  return project!
}
async function open(page:Page){
  await page.getByRole('button',{name:'Process',exact:true}).click();await page.getByRole('button',{name:'Align scans',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Align scans',exact:true})
  await expect(dialog.getByText(/Preview ready at project revision/)).toBeVisible();return dialog
}
async function review(page:Page,dialog:Locator){
  const replot=dialog.getByRole('button',{name:'Replot alignment',exact:true});await expect(replot).toBeEnabled()
  const wait=page.waitForResponse(r=>r.url().endsWith('/alignment/preview'));await replot.click();const response=await wait
  expect(response.ok()).toBe(true);const v=await response.json() as AlignmentPreview,r=v.rows[0]
  await expect(dialog.getByText(/Preview ready at project revision/)).toBeVisible()
  await expect.poll(()=>curves(dialog.getByLabel('Alignment plot',{exact:true}))).toEqual([
    {x:r.standard.x,y:r.standard.y,name:`Standard · ${r.standard.label}`},{x:r.before.x,y:r.before.y,name:'Before alignment'},
    {x:r.after.x,y:r.after.y,name:`Aligned · ${r.after.label}`}])
  return v
}

for(const mobile of [false,true])test(`${mobile?'mobile':'desktop'} Cu column previews, alignment, fixed E0 and native PRJ uncertainty`,async({page},info)=>{
  test.setTimeout(180000);await page.setViewportSize(mobile?{width:390,height:844}:{width:1500,height:1100})
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const initial=await load(page);let dialog=await open(page)
  expect(initial.groups).toHaveLength(2);await expect(dialog.getByRole('button',{name:'Save alignment',exact:true})).toBeDisabled()
  for(const display of mobile?['norm','smoothed']:['mu','norm','derivative','smoothed']){
    await dialog.getByLabel('Alignment display',{exact:true}).selectOption(display);await review(page,dialog)
  }
  await dialog.getByRole('button',{name:'+0.5 eV',exact:true}).click();let v=await review(page,dialog)
  expect(v.rows[0].energy_shift).toBe(.5);expect(v.changes[0].e0).toBe(initial.groups[1].result!.effective.e0)
  await dialog.getByRole('button',{name:'Cancel alignment',exact:true}).click();await expect(dialog).toHaveCount(0)
  const unchanged=await(await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json();expect(unchanged.version).toBe(initial.version)
  dialog=await open(page)
  await dialog.getByRole('button',{name:'Auto align',exact:true}).click();v=await review(page,dialog)
  expect(v.rows[0].energy_shift).toBe(-3.125);expect(v.rows[0].fit!.summary.derivative_scale).toBeCloseTo(.5,5)
  await expect(dialog.getByText(/Shift uncertainty/)).toBeVisible()
  if(!mobile){await dialog.getByText('Fit and residual',{exact:true}).click();await expect(dialog.locator('.js-plotly-plot')).toHaveCount(2)}
  await dialog.getByLabel('Alignment plot',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('alignment-preview.png'),animations:'disabled'})
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  const wait=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='align')
  await dialog.getByRole('button',{name:'Save alignment',exact:true}).click();const response=await wait
  expect(response.ok()).toBe(true);const saved=await response.json() as AthenaProject;await expect(dialog).toHaveCount(0)
  expect(saved.groups[0]).toEqual(initial.groups[0]);expect(saved.groups[1].energy).toEqual(initial.groups[1].energy);expect(saved.groups[1].mu).toEqual(initial.groups[1].mu)
  expect(saved.groups[1].parameters.e0).toBe(initial.groups[1].parameters.e0??initial.groups[1].result!.effective.e0)
  expect(saved.groups[1].parameters.energy_shift).toBe(-3.125)
  const undo=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='undo');await page.getByRole('button',{name:'Undo',exact:true}).click();expect((await(await undo).json()).groups).toEqual(initial.groups)
  const redo=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='redo');await page.getByRole('button',{name:'Redo',exact:true}).click();expect((await(await redo).json()).groups).toEqual(saved.groups)
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click();const path=info.outputPath('aligned-native.prj');await(await download).saveAs(path)
  const native=gunzipSync(readFileSync(path)).toString().split('\n').filter(l=>!l.startsWith('# Athena-Web ')).join('\n');expect(native).toContain('bkg_delta_eshift');writeFileSync(path,native)
  await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Open project…',exact:true}).click();await page.getByLabel('Open project file',{exact:true}).setInputFiles(path)
  const restoring=page.waitForResponse(r=>r.url().endsWith('/restore-upload'));await page.getByRole('button',{name:'Import all groups',exact:true}).click();const restoredResponse=await restoring;expect(restoredResponse.ok()).toBe(true)
  const restored=(await restoredResponse.json()).groups.at(-1);expect(restored.parameters.energy_shift).toBe(-3.125);expect(restored.parameters.e0).toBe(saved.groups[1].parameters.e0)
  expect(restored.source.alignment.native_shift_stderr).toBe(v.rows[0].fit!.summary.native_shift_stderr);expect(errors).toEqual([])
})
