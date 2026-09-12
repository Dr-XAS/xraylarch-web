import { fileURLToPath } from 'node:url'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { MEEPreview } from '../../components/athena-mee'

const fixture = fileURLToPath(new URL('../../../backend/tests/fixtures/demeter-mee-LaCoO3.prj',import.meta.url))
async function load(page:Page) {
  await page.goto('/');await page.getByRole('button',{name:'Import data',exact:true}).click()
  await page.getByLabel('Choose data files',{exact:true}).setInputFiles(fixture)
  const dialog=page.getByRole('dialog',{name:'Open a project',exact:true})
  await dialog.getByLabel('Preview signal').selectOption('norm')
  await expect(dialog.locator('.js-line').first()).toBeVisible()
  const response=page.waitForResponse(r=>r.url().endsWith('/restore-upload'))
  await dialog.getByRole('button',{name:'Import all groups',exact:true}).click()
  const p=await response;expect(p.ok()).toBe(true)
  return await p.json() as AthenaProject
}
async function open(page:Page) {
  await page.getByRole('button',{name:'Process',exact:true}).click()
  await page.getByRole('button',{name:'Multi-electron excitation',exact:true}).click()
  return page.getByRole('dialog',{name:'Multi-electron excitation',exact:true})
}
async function configure(page:Page,dialog:Locator,method='reflection') {
  await dialog.getByLabel('Algorithm',{exact:true}).selectOption(method)
  await dialog.getByLabel('Scale by (edge-step fraction)',{exact:true}).fill('0.014')
  await dialog.getByLabel('Broadening (eV)',{exact:true}).fill('2')
  const waiting=page.waitForResponse(r=>r.url().endsWith('/mee/preview')&&r.request().postDataJSON().options.shift===122)
  await dialog.getByLabel('Energy shift (eV)',{exact:true}).fill('122')
  const response=await waiting;expect(response.ok()).toBe(true)
  await expect(dialog.getByRole('button',{name:'Make group from MEE-corrected data',exact:true})).toBeEnabled()
  return await response.json() as MEEPreview
}
async function curves(plot:Locator) {
  await expect(plot.locator('.js-line').first()).toBeVisible()
  return plot.locator('.js-plotly-plot').evaluate(node=>(node as HTMLElement & {data:{x:number[];y:number[]}[]}).data.map(t=>({x:[...t.x],y:[...t.y]})))
}

test('official LaCoO3 PRJ, native reflection, E/k/R plots, curve picking, save and undo',async({page},info)=>{
  await page.setViewportSize({width:1500,height:1040});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const project=await load(page);expect(project.groups).toHaveLength(2)
  const dialog=await open(page);await dialog.getByLabel('Source group',{exact:true}).selectOption(project.groups[1].id)
  const preview=await configure(page,dialog);const result=preview.results[0]
  for (const space of ['E','k','R'] as const) {
    await dialog.getByRole('button',{name:space==='E'?'Plot in energy':`Plot in ${space}`,exact:true}).click()
    await expect.poll(()=>curves(dialog.getByLabel(`${space}-space MEE preview`,{exact:true}))).toEqual(result.traces[space].map(t=>({x:t.x,y:t.y})))
    await expect(dialog.getByRole('button',{name:space==='E'?'Plot in energy':`Plot in ${space}`,exact:true})).toHaveAttribute('aria-pressed','true')
    await expect(dialog.getByLabel(`${space}-space MEE preview`,{exact:true}).getByText(space==='E'?'Energy (eV)':space==='k'?'k (Å⁻¹)':'R (Å)',{exact:true})).toBeVisible()
  }
  await page.screenshot({path:info.outputPath('mee-desktop-R.png')})
  await dialog.getByRole('button',{name:'Plot in energy',exact:true}).click()
  const plot=dialog.getByLabel('E-space MEE preview',{exact:true}).locator('.js-plotly-plot')
  const point=await plot.evaluate(node=>{
    const p=node as HTMLElement & {data:{x:number[];y:number[]}[];_fullLayout:{xaxis:{l2p:(x:number)=>number;_offset:number};yaxis:{l2p:(y:number)=>number;_offset:number}}}
    const t=p.data[0],i=t.x.findIndex(x=>x>5610),l=p._fullLayout
    return {x:l.xaxis.l2p(t.x[i])+l.xaxis._offset,y:l.yaxis.l2p(t.y[i])+l.yaxis._offset,energy:t.x[i]}
  })
  await dialog.getByRole('button',{name:'Pick energy shift',exact:true}).click()
  await plot.click({position:{x:point.x,y:point.y}})
  await expect(dialog.getByLabel('Energy shift (eV)',{exact:true})).toHaveValue((point.energy-result.details.e0).toFixed(3))
  const picked=page.waitForResponse(r=>r.url().endsWith('/mee/preview'))
  const nextPreview=await (await picked).json() as MEEPreview
  await expect(dialog.getByRole('button',{name:'Make group from MEE-corrected data',exact:true})).toBeEnabled()
  const waiting=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='multi_electron')
  await dialog.getByRole('button',{name:'Make group from MEE-corrected data',exact:true}).click()
  const response=await waiting;expect(response.ok()).toBe(true);const saved=await response.json() as AthenaProject
  expect(saved.groups.slice(0,2)).toEqual(project.groups);expect(saved.groups[2].mu).toEqual(nextPreview.results[0].corrected_mu)
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.getByRole('heading',{name:'Data groups 2',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Redo',exact:true}).click();await expect(page.getByRole('heading',{name:'Data groups 3',exact:true})).toBeVisible()
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click()
  await (await download).saveAs(info.outputPath('LaCoO3-corrected.prj'))
  expect(errors).toEqual([])
})

test('mobile arctangent clamps and a cross-window conflict cannot save an obsolete preview',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});const project=await load(page),dialog=await open(page)
  await configure(page,dialog,'arctangent')
  const response=page.waitForResponse(r=>r.url().endsWith('/mee/preview')&&r.request().postDataJSON().options.amplitude===-1)
  await dialog.getByLabel('Scale by (edge-step fraction)',{exact:true}).fill('-1')
  expect((await response).ok()).toBe(true)
  await expect(dialog.getByText('Negative amplitude was reset to zero, as in Athena.',{exact:true})).toBeVisible()
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  const bounds=await dialog.boundingBox()
  for(const name of ['Close MEE tool','Preview again','Make group from MEE-corrected data']) {
    const button=await dialog.getByRole('button',{name,exact:true}).boundingBox()
    expect(button!.x).toBeGreaterThanOrEqual(bounds!.x)
    expect(button!.x+button!.width).toBeLessThanOrEqual(bounds!.x+bounds!.width)
  }
  await dialog.getByLabel('E-space MEE preview',{exact:true}).scrollIntoViewIfNeeded()
  await expect(dialog.getByLabel('E-space MEE preview',{exact:true}).getByText('Energy (eV)',{exact:true})).toBeVisible()
  await page.screenshot({path:info.outputPath('mee-mobile-energy.png')})
  await dialog.getByRole('button',{name:'Make group from MEE-corrected data',exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('mee-mobile-actions.png')})
  const changed=await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`,{data:{version:project.version,action:'project',options:{name:'Changed elsewhere'}}})
  expect(changed.ok()).toBe(true)
  await dialog.getByRole('button',{name:'Make group from MEE-corrected data',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('changed in another tab')
  await expect(dialog.getByRole('button',{name:'Make group from MEE-corrected data',exact:true})).toBeDisabled()
  expect((await (await page.request.get(`/api/backend/api/athena/projects/${project.id}`)).json()).groups).toHaveLength(2)
  await page.reload();const reopened=await open(page);await configure(page,reopened,'arctangent')
  const saved=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='multi_electron')
  await reopened.getByRole('button',{name:'Make group from MEE-corrected data',exact:true}).click()
  expect((await saved).ok()).toBe(true);await expect(page.getByRole('heading',{name:'Data groups 3',exact:true})).toBeVisible()
})
