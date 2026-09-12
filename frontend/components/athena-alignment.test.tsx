import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaAlignment, type AlignmentPreview } from './athena-alignment'

type Options=AlignmentPreview['options']
const plot=vi.hoisted(()=>vi.fn<(p:ComponentProps<typeof Plot>)=>void>())
vi.mock('next/dynamic',()=>({default:()=>(props:ComponentProps<typeof Plot>)=>{useLayoutEffect(()=>plot(props));return <div/>}}))
vi.mock('@/lib/athena',()=>({athenaApi:vi.fn()}))
const api=vi.mocked(athenaApi),x=Array.from({length:41},(_,i)=>8960+i),y=x.map((_,i)=>i/40)
const project={id:'p',version:4,groups:['standard','moving'].map((id,i)=>({id,label:id,data_type:'mu',energy:x.map(v=>v+i*3),mu:y,frozen:false,marked:true,reference_id:null,
  parameters:{e0:8982+i*3,energy_shift:0},result:{effective:{e0:8982+i*3}},source:{}}))} as unknown as AthenaProject
const props=()=>({project,activeId:'moving',selectGroup:vi.fn(),setBusy:vi.fn(),saved:vi.fn(),close:vi.fn(),rememberDraft:vi.fn()})
function preview(options:Options,ids=['moving']):AlignmentPreview{
  const shift=options.operation==='auto'?-3.125:options.operation==='manual'?options.energy_shift!:0
  const curve=(i:number,esh=0)=>({group_id:project.groups[i].id,label:project.groups[i].label,e0:project.groups[i].parameters.e0!,x:project.groups[i].energy.map(v=>v+esh),y:y.map(v=>options.display==='derivative'?v*.1:v)})
  return {project_id:'p',version:4,group_ids:ids,options:{...options,sg_window:31,sg_order:9},requested_options:options,
    rows:[{group_id:'moving',label:'moving',moving_id:'moving',standard_id:'standard',used_references:false,energy_shift:shift,shift_delta:shift,
      before:curve(1),after:curve(1,shift),standard:curve(0),saved_fit:null,fit:options.operation==='auto'?{summary:{energy_shift:shift,fitted_shift:shift,shift_stderr:.0123,derivative_scale:.5,xmin:8962,xmax:9032,fit_points:10,smoothing_window:31,smoothing_order:9},
      curve:{x:x.slice(0,10),standard:y.slice(0,10),fitted:y.slice(0,10),residual:Array(10).fill(0)}}:null}],
    changes:options.operation==='inspect'?[]:[{group_id:'moving',label:'moving',e0:8985,energy_shift:shift}],processing_errors:{},skipped_reasons:ids.includes('standard')?{standard:'The alignment standard stays fixed.'}:{}}
}
function serve(){api.mockImplementation(async(_path,body)=>{const r=body as {options:Options;group_ids:string[]};return preview(r.options,r.group_ids)})}
const save=()=>screen.getByRole('button',{name:'Save alignment'})
const change=(name:string,value:string)=>fireEvent.change(screen.getByLabelText(name,{exact:true}),{target:{value}})
async function ready(){await waitFor(()=>expect(screen.getByText(/Preview ready at project revision/)).toBeVisible(),{timeout:2500})}
afterEach(()=>{cleanup();vi.clearAllMocks();api.mockReset()})

it('starts with smoothed derivative, plots all four views and keeps inspection read-only',async()=>{
  serve();const p=props();render(<AthenaAlignment {...p}/>);await ready();expect(save()).toBeDisabled()
  expect(screen.getByLabelText('Alignment display')).toHaveValue('smoothed')
  for(const display of ['mu','norm','derivative','smoothed']){
    change('Alignment display',display);await ready();expect(save()).toBeDisabled()
    const traces=plot.mock.calls.at(-1)![0].data;expect(traces).toHaveLength(3)
    expect(traces[0].x).toEqual(x);expect(traces[1].x).toEqual(x.map(v=>v+3))
  }
  expect(p.saved).not.toHaveBeenCalled()
})

it('previews every native nudge, manual full precision and cancels without saving',async()=>{
  serve();const p=props();render(<AthenaAlignment {...p}/>);await ready();let total=0
  for(const n of [-5,-1,-.5,-.1,.1,.5,1,5]){
    fireEvent.click(screen.getByRole('button',{name:`${n>0?'+':''}${n} eV`,exact:true}));total=Number((total+n).toFixed(10));await ready()
    expect(screen.getByLabelText('Total energy shift · eV')).toHaveValue(total);expect(save()).toBeEnabled()
  }
  change('Total energy shift · eV','1.234567');await ready()
  expect(plot.mock.calls.at(-1)![0].data[2].x).toEqual(x.map(v=>v+3+1.234567))
  fireEvent.click(screen.getByRole('button',{name:'Cancel alignment'}));expect(p.close).toHaveBeenCalledOnce();expect(p.saved).not.toHaveBeenCalled()
})

it('fits only on Auto align, shows scale/error and saves the captured preferences without changing E0',async()=>{
  serve();const p=props();render(<AthenaAlignment {...p}/>);await ready()
  fireEvent.click(screen.getByRole('button',{name:'Auto align',exact:true}));await ready();expect(save()).toBeEnabled()
  expect(screen.getByText(/0.012300 eV/)).toBeVisible();expect(screen.getByText(/derivative scale 0.500000/)).toBeVisible()
  const r=api.mock.calls.at(-1)![1] as {options:Options};const next=structuredClone(project);next.version=5;next.groups[1].parameters.energy_shift=-3.125
  api.mockResolvedValueOnce(next);fireEvent.click(save());await waitFor(()=>expect(p.saved).toHaveBeenCalledWith(next))
  expect(api.mock.calls.at(-1)![1]).toEqual({version:4,action:'align',group_ids:['moving'],options:{...r.options,sg_window:31,sg_order:9}})
  expect(next.groups[1].parameters.e0).toBe(8985)
})

it('includes marked groups and reports the fixed standard skip',async()=>{
  serve();render(<AthenaAlignment {...props()}/>);await ready()
  fireEvent.click(screen.getByRole('button',{name:'Align marked groups'}));await ready()
  expect((api.mock.calls.at(-1)![1] as {group_ids:string[]}).group_ids).toEqual(['standard','moving'])
  expect(screen.getByText(/Skipped standard/)).toBeVisible()
})

it.each(['revision','request','axis','signal','e0','shift','residual'])('rejects malformed %s preview data',async(kind)=>{
  api.mockImplementation(async(_path,body)=>{
    const r=preview((body as {options:Options}).options)
    if(kind==='revision')r.version--
    if(kind==='request')r.options.display='mu'
    if(kind==='axis')r.rows[0].after.x[0]++
    if(kind==='signal')r.rows[0].after.y.pop()
    if(kind==='e0'&&r.changes.length)r.changes[0].e0=8999
    if(kind==='shift')r.rows[0].energy_shift=42
    if(kind==='residual'&&r.rows[0].fit)r.rows[0].fit.curve.residual[0]=99
    return r
  })
  render(<AthenaAlignment {...props()}/>);fireEvent.click(screen.getByRole('button',{name:'Auto align',exact:true}))
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('does not match'),{timeout:2500});expect(save()).toBeDisabled()
})

it('disables save immediately when input is cleared or the project revision changes',async()=>{
  serve();const p=props();const view=render(<AthenaAlignment {...p}/>);await ready();change('Total energy shift · eV','3');await ready()
  change('Total energy shift · eV','');expect(save()).toBeDisabled()
  change('Total energy shift · eV','2');await ready();view.rerender(<AthenaAlignment {...p} project={{...project,version:5}}/>);expect(save()).toBeDisabled()
})

it('rejects a save response that moves E0 and exposes server conflicts for retry',async()=>{
  serve();const p=props();render(<AthenaAlignment {...p}/>);await ready();change('Total energy shift · eV','2');await ready()
  const next=structuredClone(project);next.version=5;next.groups[1].parameters.energy_shift=2;next.groups[1].parameters.e0+=2
  api.mockResolvedValueOnce(next);fireEvent.click(save());await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('saved alignment does not match'))
  expect(p.saved).not.toHaveBeenCalled();expect(save()).toBeDisabled()
  serve();fireEvent.click(screen.getByRole('button',{name:'Replot alignment'}));await ready();api.mockRejectedValueOnce(new Error('Project changed in another tab.'))
  fireEvent.click(save());await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Project changed'));expect(p.setBusy).toHaveBeenLastCalledWith('')
})
