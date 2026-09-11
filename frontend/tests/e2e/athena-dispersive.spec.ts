import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'

const fixture=(name:string)=>fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`,import.meta.url))
const source=(metal:string,kind:string)=>fixture(`demeter-dxas-${metal}-${kind}.${metal==='pd'&&kind==='pixels'?'csv':'dat'}`)
const pixelRows=(metal:string)=>readFileSync(source(metal,'pixels'),'utf8').split('\n').slice(metal==='cu'?12:1).filter(l=>l.trim()).map(l=>l.trim().split(metal==='cu'?/\s+/:/\s*,\s*/).map(Number))
async function curve(plot:Locator,index=0) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate((node,i)=>{
    const t=(node as HTMLElement & {data:{x:number[];y:number[]}[]}).data[i]
    return {x:[...t.x],y:[...t.y]}
  },index)
}
async function signal(plot:Locator,x:number[],y:number[]) {
  await expect.poll(async()=>(await curve(plot)).x).toEqual(x)
  await expect.poll(async()=>{
    const actual=(await curve(plot)).y
    return actual.length===y.length?Math.max(...actual.map((v,i)=>Math.abs(v-y[i]))):Infinity
  }).toBeLessThan(2e-10)
}
async function standard(page:Page,metal:string) {
  await page.goto('/')
  await page.getByRole('button',{name:'Import data',exact:true}).click()
  await page.getByLabel('Choose data files',{exact:true}).setInputFiles(source(metal,'standard'))
  const panel=page.getByRole('dialog',{name:'Import spectra',exact:true})
  await panel.getByRole('combobox',{name:'Energy units',exact:true}).selectOption(metal==='cu'?'keV':'eV')
  await expect(panel.getByLabel('Imported signal preview plot',{exact:true}).locator('.js-line').first()).toBeVisible()
  const accepting=page.waitForResponse(r=>r.url().endsWith('/import'))
  await panel.getByRole('button',{name:'Import spectrum',exact:true}).click()
  const response=await accepting;expect(response.ok()).toBe(true)
  await expect(panel).toHaveCount(0)
  return response.json()
}
async function open(page:Page) {
  await page.getByRole('button',{name:'Process',exact:true}).click()
  await page.getByRole('button',{name:'Dispersive energy calibration',exact:true}).click()
  return page.getByRole('dialog',{name:'Dispersive energy calibration',exact:true})
}
async function action(page:Page,panel:Locator,name:string,endpoint:string) {
  const response=page.waitForResponse(r=>r.url().endsWith('/dispersive/'+endpoint)&&r.request().method()==='POST')
  await panel.getByRole('button',{name,exact:true}).click()
  const r=await response;expect(r.ok(),await r.text()).toBe(true)
  await expect(panel.getByRole('button',{name,exact:true})).toBeEnabled()
  return r.json()
}

test('ESRF Cu: live pixel columns, fitted calibration, native settings, make, undo and PRJ roundtrip',async({page},info)=>{
  test.setTimeout(90000)
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const p=await standard(page,'cu');const panel=await open(page)
  await panel.getByLabel('Choose pixel standard file',{exact:true}).setInputFiles(source('cu','pixels'))
  const rows=pixelRows('cu'),x=rows.map(r=>r[0]),y=rows.map(r=>r[1])
  const raw=panel.getByLabel('Pixel column preview',{exact:true}),cal=panel.getByLabel('Dispersive calibration preview',{exact:true})
  await signal(raw,x,y)
  await panel.getByLabel('Invert pixel signal',{exact:true}).check();await signal(raw,x,y.map(v=>-v))
  await panel.getByLabel('Invert pixel signal',{exact:true}).uncheck();await signal(raw,x,y)
  await panel.getByRole('button',{name:'Use Athena ESRF log columns',exact:true}).click()
  await signal(raw,x,y.map(v=>Math.log(Math.abs(v))))
  await panel.getByRole('button',{name:'Use μ(pixel) columns',exact:true}).click();await signal(raw,x,y)
  const initial=await action(page,panel,'Estimate initial coefficients','guess')
  expect(initial.coefficients.offset).toBeGreaterThan(8950)
  const fitted=await action(page,panel,'Refine calibration parameters','refine')
  expect(fitted.details.sum_squares).toBeLessThan(fitted.details.initial_sum_squares*.25)
  await signal(cal,fitted.normalized.x,fitted.normalized.y)
  expect(await curve(cal,1)).toEqual({x:fitted.standard.x,y:fitted.standard.y})
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect.poll(async()=>{
    const bounds=await panel.boundingBox(),a=await raw.boundingBox(),b=await cal.boundingBox()
    return !!bounds&&!!a&&!!b&&a.y>bounds.y&&b.y+b.height<bounds.y+bounds.height
  }).toBe(true)
  await panel.screenshot({path:info.outputPath('cu-calibration-desktop.png')})
  await panel.getByText('Pixel source file',{exact:true}).click()
  const original=page.waitForEvent('download');await panel.getByRole('link',{name:'Download original pixel file',exact:true}).click()
  const originalPath=info.outputPath('cu_08');await (await original).saveAs(originalPath)
  expect(readFileSync(originalPath)).toEqual(readFileSync(source('cu','pixels')))
  const native=page.waitForEvent('download');await panel.getByRole('link',{name:'Export saved athena.dxas',exact:true}).click()
  const nativePath=info.outputPath('athena.dxas');await (await native).saveAs(nativePath)
  const saved=Object.fromEntries(readFileSync(nativePath,'utf8').split('\n').filter(l=>l.includes(':')).map(l=>{const [k,v]=l.split(':');return [k,Number(v)]}))
  expect(saved).toEqual(fitted.coefficients)
  const make=page.waitForResponse(r=>r.url().endsWith('/dispersive/make'))
  await panel.getByRole('button',{name:'Make calibrated data group',exact:true}).click()
  const made=await (await make).json(),g=made.groups[1]
  expect(made.groups).toHaveLength(2);expect(made.groups[0]).toEqual(p.groups[0])
  expect(g.energy).toEqual(fitted.calibrated.x);expect(g.mu).toEqual(y)
  expect(g.source.calibration).toEqual(fitted.coefficients);expect(g.processing_error).toBeNull()
  await panel.getByRole('button',{name:'Close dialog',exact:true}).click()
  await page.getByLabel('Plot marked',{exact:true}).uncheck()
  for(const [tab,space,xkey,ykey] of [['E Energy','E','energy','norm'],['k EXAFS','k','k','weighted_chi'],['R Fourier','R','r','chir_mag'],['q Back transform','q','q','chiq_mag']]) {
    await page.getByRole('tab',{name:tab,exact:true}).click()
    await signal(page.getByLabel(`${space}-space spectrum plot`,{exact:true}),g.result.arrays[xkey],g.result.arrays[ykey])
  }
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.getByRole('heading',{name:'Data groups 1',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Redo',exact:true}).click();await expect(page.getByRole('heading',{name:'Data groups 2',exact:true})).toBeVisible()
  const projectFile=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click()
  const projectPath=info.outputPath('calibrated.prj');await (await projectFile).saveAs(projectPath)
  await page.getByRole('button',{name:'Open project',exact:true}).click()
  await page.getByLabel('Open project file',{exact:true}).setInputFiles(projectPath)
  const reopened=page.waitForResponse(r=>r.url().endsWith('/restore-upload'))
  await page.getByRole('button',{name:'Import all groups',exact:true}).click()
  const restored=await (await reopened).json();expect(restored.groups).toHaveLength(4)
  expect(restored.groups[3].source).toEqual(g.source)
  expect(restored.groups[3].energy).toEqual(g.energy)
  expect(errors).toEqual([])
})

test('Photon Factory Pd: numeric CSV header, signal reversal, mobile curves and saved calibration import',async({page},info)=>{
  test.setTimeout(90000)
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  await standard(page,'pd');const panel=await open(page)
  await panel.getByLabel('Choose pixel standard file',{exact:true}).setInputFiles(source('pd','pixels'))
  const rows=pixelRows('pd'),x=rows.map(r=>r[0]),y=rows.map(r=>r[1])
  const raw=panel.getByLabel('Pixel column preview',{exact:true})
  await signal(raw,x,y)
  await panel.getByLabel('Reverse signal order (high energy at first pixel)',{exact:true}).check();await signal(raw,x,[...y].reverse())
  await panel.getByText('Pixel normalization for initial guess',{exact:true}).click()
  for(const [label,value] of [['Pixel pre-edge start','-410'],['Pixel pre-edge end','-120'],['Pixel post-edge start','150'],['Pixel post-edge end','600']])await panel.getByLabel(label,{exact:true}).fill(value)
  await action(page,panel,'Estimate initial coefficients','guess')
  const fitted=await action(page,panel,'Refine calibration parameters','refine')
  expect(fitted.details.sum_squares).toBeLessThan(fitted.details.initial_sum_squares*.25)
  await signal(panel.getByLabel('Dispersive calibration preview',{exact:true}),fitted.normalized.x,fitted.normalized.y)
  await page.setViewportSize({width:390,height:844})
  await expect.poll(()=>panel.evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true)
  await panel.getByLabel('Dispersive calibration preview',{exact:true}).scrollIntoViewIfNeeded()
  await panel.screenshot({path:info.outputPath('pd-calibration-mobile.png')})
  await page.setViewportSize({width:1280,height:900})
  const making=page.waitForResponse(r=>r.url().endsWith('/dispersive/make'))
  await panel.getByRole('button',{name:'Make calibrated data group',exact:true}).click()
  const p=await (await making).json();expect(p.groups[1].mu).toEqual([...y].reverse());expect(p.groups[1].processing_error).toBeNull()
  expect(p.groups[1].source.pixel_columns.reverse_signal).toBe(true)
  // A native settings file can be loaded independently of the current pixel data.
  await panel.getByLabel('Import athena.dxas calibration',{exact:true}).setInputFiles({name:'athena.dxas',mimeType:'text/yaml',buffer:Buffer.from('---\noffset: 8952\nlinear: 0.29\nquadratic: 0\n')})
  await expect(panel.getByText('Imported and saved athena.dxas calibration.',{exact:true})).toBeVisible()
  await panel.getByRole('button',{name:'Close dialog',exact:true}).click()
  await page.getByRole('button',{name:'File',exact:true}).click()
  await page.getByRole('button',{name:'Plugin registry…',exact:true}).click()
  const registry=page.getByRole('dialog',{name:'Plugin registry',exact:true})
  await registry.getByRole('checkbox',{name:'Enable SLRIBL4',exact:true}).check()
  await registry.getByRole('button',{name:'Close registry',exact:true}).click()
  await page.getByRole('button',{name:'Import data',exact:true}).click()
  await page.getByLabel('Choose data files',{exact:true}).setInputFiles(source('cu','pixels'))
  const importing=page.getByRole('dialog',{name:'Import spectra',exact:true})
  const cu=pixelRows('cu')
  await signal(importing.getByLabel('Imported signal preview plot',{exact:true}),cu.map(r=>8952+.29*r[0]),cu.map(r=>r[1]))
  await expect(importing).toContainText('SLRIBL4')
  const accepted=page.waitForResponse(r=>r.url().endsWith('/import'))
  await importing.getByRole('button',{name:'Import spectrum',exact:true}).click()
  const final=await (await accepted).json()
  expect(final.groups.at(-1).source.file_plugin.calibration).toEqual({offset:8952,linear:.29,quadratic:0})
  expect(final.groups.at(-1).processing_error).toBeNull()
  expect(errors).toEqual([])
})
