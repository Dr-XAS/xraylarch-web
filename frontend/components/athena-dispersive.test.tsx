import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AthenaProject } from '@/lib/athena'
import { differenceProject } from './athena-difference.fixtures'
import { AthenaDispersive } from './athena-dispersive'

const { api, busy, saved }=vi.hoisted(()=>({api:vi.fn(),busy:vi.fn(),saved:vi.fn()}))
vi.mock('@/lib/athena',async original=>({...await original<typeof import('@/lib/athena')>(),athenaApi:api}))
vi.mock('next/dynamic',()=>({default:()=>({data}:{data:unknown})=><pre data-testid="plot">{JSON.stringify(data)}</pre>}))
const coefficients={offset:8952,linear:.29,quadratic:0}
const inspection={upload_id:'pixels',display_name:'pixels.dat',row_count:10,source_preview:'original bytes',
  columns:['pixel','i0','it'].map((name,index)=>({name,index,column_id:`c${index}`,preview:[index]}))}
function response(body:any={version:7,upload_id:'pixels',coefficients}) {
  return {version:body.version,upload_id:body.upload_id,coefficients:body.coefficients,pixel:{label:'pixels',x:[0,1,2],y:body.columns?.invert?[-1,-2,-3]:[1,2,3]},
    calibrated:{label:'calibrated',x:[8952,8953,8954],y:[1,2,3]},normalized:{label:'normalized',x:[8952,8953,8954],y:[.1,.2,.3]},
    standard:{label:'standard',x:[8952,8953,8954],y:[.11,.22,.33]},warnings:[],plot_range:[8800,9300]}
}
let pref={version:0,coefficients:null as null|typeof coefficients}
function handler(url:string,body:any,method?:string):Promise<any> {
  if(url==='/preferences/dispersive') {
    if(method==='PUT')pref={version:pref.version+1,coefficients:body.coefficients}
    return Promise.resolve({...pref})
  }
  if(url.includes('/preferences/dispersive/import'))return Promise.resolve(pref={version:pref.version+1,coefficients})
  if(url.endsWith('/inspect'))return Promise.resolve(inspection)
  if(url.endsWith('/guess')||url.endsWith('/refine'))return Promise.resolve({...response({...body,coefficients}),details:{sum_squares:.01,initial_sum_squares:.2,evaluations:50,scale:2,warnings:[]}})
  return Promise.resolve(response(body))
}
function Harness({initial=differenceProject()}:{initial?:AthenaProject}) {
  const [p,setP]=useState(initial)
  return <AthenaDispersive project={p} activeId="data" setBusy={busy} onSaved={next=>{saved(next);setP(next)}} />
}
async function tick(){await act(()=>vi.advanceTimersByTimeAsync(200))}
async function upload(){fireEvent.change(screen.getByLabelText('Choose pixel standard file'),{target:{files:[new File(['pixels'],'pixels.dat')]}});await tick();await tick()}
async function click(name:string){fireEvent.click(screen.getByRole('button',{name}));await tick();await tick()}
const requests=(suffix:string)=>api.mock.calls.filter(c=>c[0].endsWith(suffix))
beforeEach(()=>{vi.useFakeTimers();pref={version:0,coefficients:null};api.mockReset().mockImplementation(handler);busy.mockClear();saved.mockClear()})
afterEach(()=>{cleanup();vi.useRealTimers()})

it('shows selected pixel columns before guessing and updates the server preview for detector edits',async()=>{
  render(<Harness/>);await tick();await upload()
  expect(screen.getAllByTestId('plot')).toHaveLength(1)
  expect(screen.getByTestId('plot')).toHaveTextContent('"x":[0,1,2]')
  expect(requests('/columns').at(-1)![1].columns).toMatchObject({pixel_column:'c0',numerator:['c1'],denominator:[],logarithm:false})
  await click('Use Athena SLRI I₀/Iₜ columns')
  expect(requests('/columns').at(-1)![1].columns).toMatchObject({numerator:['c1'],denominator:['c2'],logarithm:true})
  fireEvent.click(screen.getByLabelText('Pixel numerator it'));fireEvent.click(screen.getByLabelText('Invert pixel signal'));await tick()
  expect(requests('/columns').at(-1)![1].columns).toMatchObject({numerator:['c1','c2'],invert:true})
  expect(screen.getByTestId('plot')).toHaveTextContent('"y":[-1,-2,-3]')
  expect(requests('/guess')).toHaveLength(0)
  expect(api.mock.calls.filter(c=>c[2]==='PUT')).toHaveLength(0)
})

it('discards a stale raw response after column selection changes',async()=>{
  let finish!:(value:unknown)=>void
  api.mockImplementation((url,body,method)=>url.endsWith('/columns')&&!body.columns.invert?new Promise(r=>{finish=r}):handler(url,body,method))
  render(<Harness/>);await tick();await upload()
  const old=requests('/columns')[0]
  fireEvent.click(screen.getByLabelText('Invert pixel signal'));await tick()
  expect(old[3].aborted).toBe(true)
  await act(async()=>finish(response()))
  expect(screen.getByTestId('plot')).toHaveTextContent('"y":[-1,-2,-3]')
  expect(screen.queryByText('"y":[1,2,3]')).not.toBeInTheDocument()
})

it('guess, reset, refine and explicit replot persist coefficients while live edits do not',async()=>{
  render(<Harness/>);await tick();await upload();await click('Estimate initial coefficients')
  expect(screen.getAllByTestId('plot')).toHaveLength(2)
  expect(pref).toEqual({version:1,coefficients})
  expect(screen.getByLabelText('Offset coefficient')).toHaveValue(8952)
  expect(screen.getByText(/Derivative fit sum of squares/)).toHaveTextContent('0.20000 → 0.010000')
  fireEvent.change(screen.getByLabelText('Offset coefficient'),{target:{value:'8953'}});await tick()
  expect(pref.version).toBe(1)
  expect(screen.queryByText(/Derivative fit sum of squares/)).not.toBeInTheDocument()
  await click('Replot calibration data');expect(pref).toEqual({version:2,coefficients:{...coefficients,offset:8953}})
  await click('Reset parameters');expect(requests('/guess').at(-1)![1].coefficients).toEqual({offset:0,linear:.4,quadratic:0});expect(pref.version).toBe(3)
  await click('Refine calibration parameters');expect(pref.version).toBe(4)
  expect(saved).not.toHaveBeenCalled()
})

it('an invalid draft hides the old calibrated plot and blocks making a group',async()=>{
  render(<Harness/>);await tick();await upload();await click('Estimate initial coefficients')
  fireEvent.change(screen.getByLabelText('Linear coefficient'),{target:{value:''}});await tick()
  expect(screen.getAllByTestId('plot')).toHaveLength(1)
  expect(screen.getByRole('button',{name:'Make calibrated data group'})).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('Enter finite coefficients')
  fireEvent.change(screen.getByLabelText('Linear coefficient'),{target:{value:'.29'}})
  fireEvent.change(screen.getByLabelText('Pixel polynomial degree'),{target:{value:'2.5'}});await tick()
  expect(screen.getByRole('button',{name:'Estimate initial coefficients'})).toBeDisabled()
})

it('accepts manual calibration without a standard but disables fitting',async()=>{
  const initial={...differenceProject(),groups:[]}
  render(<Harness initial={initial}/>);await tick();await upload()
  fireEvent.change(screen.getByLabelText('Offset coefficient'),{target:{value:'8952'}});await tick()
  expect(requests('/preview').at(-1)![1].standard_id).toBeNull()
  expect(screen.getByRole('button',{name:'Make calibrated data group'})).toBeEnabled()
  expect(screen.getByRole('button',{name:'Estimate initial coefficients'})).toBeDisabled()
})

it('preserves fit results and typed coefficients when saving conflicts, then loads the saved version',async()=>{
  api.mockImplementation((url,body,method)=>method==='PUT'?Promise.reject(new Error('Calibration changed in another window.')):handler(url,body,method))
  render(<Harness/>);await tick();await upload();await click('Estimate initial coefficients')
  expect(screen.getByRole('alert')).toHaveTextContent('changed in another window')
  expect(screen.getAllByTestId('plot')).toHaveLength(2)
  expect(screen.getByLabelText('Offset coefficient')).toHaveValue(8952)
  pref={version:8,coefficients:{...coefficients,offset:8956}}
  api.mockImplementation(handler);await click('Load saved calibration')
  expect(screen.getByLabelText('Offset coefficient')).toHaveValue(8956)
  await click('Save calibration')
  expect(api.mock.calls.findLast(c=>c[2]==='PUT')![1].version).toBe(8)
  expect(pref.version).toBe(9)
})

it('locks controls during creation, keeps a failed request retryable and adopts the accepted revision',async()=>{
  render(<Harness/>);await tick();await upload();await click('Estimate initial coefficients')
  let fail!:(e:Error)=>void
  api.mockImplementation((url,body,method)=>url.endsWith('/make')?new Promise((_,reject)=>{fail=reject}):handler(url,body,method))
  fireEvent.click(screen.getByRole('button',{name:'Make calibrated data group'}));await tick()
  expect(screen.getByLabelText('Offset coefficient')).toBeDisabled()
  expect(busy).toHaveBeenLastCalledWith('Making calibrated data group')
  await act(async()=>fail(new Error('disk full')))
  expect(screen.getByRole('alert')).toHaveTextContent('disk full')
  expect(saved).not.toHaveBeenCalled()
  const next={...differenceProject(),version:8}
  api.mockImplementation((url,body,method)=>url.endsWith('/make')?Promise.resolve(next):handler(url,body,method))
  await tick();await click('Make calibrated data group')
  expect(saved).toHaveBeenCalledWith(next)
  expect(requests('/preview').at(-1)![1].version).toBe(8)
  expect(busy).toHaveBeenLastCalledWith('')
})

it('imports and exports native calibration without requiring a pixel file',async()=>{
  render(<Harness/>);await tick()
  fireEvent.change(screen.getByLabelText('Import athena.dxas calibration'),{target:{files:[new File(['---'],'athena.dxas')]}});await tick()
  expect(api.mock.calls.find(c=>c[0].includes('/import?'))![0]).toBe('/preferences/dispersive/import?version=0')
  expect(screen.getByLabelText('Offset coefficient')).toHaveValue(8952)
  expect(screen.getByRole('link',{name:'Export saved athena.dxas'})).toHaveAttribute('href','/api/backend/api/athena/preferences/dispersive/file')
  expect(screen.getByRole('button',{name:'Make calibrated data group'})).toBeDisabled()
})

it('a delayed initial preference lookup cannot replace a newer explicit load',async()=>{
  let finish!:(v:unknown)=>void
  api.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  render(<Harness/>);await tick()
  pref={version:8,coefficients}
  await click('Load saved calibration')
  await act(async()=>finish({version:0,coefficients:null}))
  await click('Save calibration')
  expect(api.mock.calls.findLast(c=>c[2]==='PUT')![1].version).toBe(8)
  expect(screen.getByRole('link',{name:'Export saved athena.dxas'})).toBeInTheDocument()
})
