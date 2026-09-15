import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaMergePlot, type SavedMergePlot } from './athena-merge-plot'

const plot=vi.hoisted(()=>vi.fn<(p:ComponentProps<typeof Plot>)=>void>())
vi.mock('next/dynamic',()=>({default:()=>(props:ComponentProps<typeof Plot>)=>{useLayoutEffect(()=>plot(props));return <div data-testid="saved-spread-traces"/>}}))
vi.mock('@/lib/athena',async original=>({...await original<typeof import('@/lib/athena')>(),athenaApi:vi.fn()}))
const api=vi.mocked(athenaApi),x=[1,2,3,4]
const project={id:'p',version:4,groups:['mu','norm','chi'].map((id,i)=>({id,label:id,energy:x,mu:x,data_type:id==='chi'?'chi':'mu',multiplier:1,offset:0,
  parameters:{flatten:true,energy_shift:0,kweight:2},source:{native:{args:{is_merge:['e','n','k'][i]}},raw_arrays:{stddev:[.1,.1,.1,.1]}}}))} as unknown as AthenaProject
const props=()=>({project,groupId:'mu',selectGroup:vi.fn(),close:vi.fn()})
type Options=SavedMergePlot['options']
function response(options:Options,id='mu'):SavedMergePlot{
  return {project_id:'p',version:4,options,result:{group_id:id,label:id,merge_space:id as 'mu',origin:'native',display:'mu',kweight:null,multiplier:1,offset:0,spread_scale:null,points:4,
    curves:Array.from({length:options.view==='stddev'?3:2},(_,i)=>({name:`curve ${i}`,x,y:x.map(v=>v+i)})),notes:['Saved scatter note'],x_label:'Energy (eV)',y_label:'μ(E)'}}
}
function serve(mutate?:(v:SavedMergePlot)=>void){api.mockImplementation(async(path,body)=>{const id=path.split('/groups/')[1].split('/')[0],v=response(body as Options,id);mutate?.(v);return v})}
async function ready(){await waitFor(()=>expect(screen.getByText('4 saved points · project revision 4.')).toBeVisible(),{timeout:2500})}
const change=(name:string,value:string)=>fireEvent.change(screen.getByLabelText(name,{exact:true}),{target:{value}})
afterEach(()=>{cleanup();vi.clearAllMocks();api.mockReset()})

it('plots the stored spread and variance as read-only requests and keeps display controls visible during refresh',async()=>{
  serve();const p=props();render(<AthenaMergePlot {...p}/>);await ready()
  expect(plot.mock.calls.at(-1)![0].data).toHaveLength(3)
  change('Saved merge display','variance');expect(screen.getByLabelText('Saved merge energy display')).toBeVisible();await ready()
  change('Saved merge energy display','flat');expect(screen.getByLabelText('Saved merge energy display')).toHaveValue('flat');await ready()
  expect(plot.mock.calls.at(-1)![0].data).toHaveLength(2)
  expect(api.mock.calls.every(([path,,method])=>path.endsWith('/merge/plot')&&method==='POST')).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'Close merge plot'}));expect(p.close).toHaveBeenCalledOnce()
})

it.each(['project','version','group','options','axis','signal'])('rejects a mismatched %s response',async(kind)=>{
  serve(v=>{
    if(kind==='project')v.project_id='elsewhere'
    if(kind==='version')v.version--
    if(kind==='group')v.result.group_id='other'
    if(kind==='options')v.options={...v.options,view:'variance'}
    if(kind==='axis')v.result.curves[0].x=[0,2,3,4]
    if(kind==='signal')v.result.curves[0].y[0]=NaN
  });render(<AthenaMergePlot {...props()}/>);await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('does not match'),{timeout:2500})
  expect(screen.queryByTestId('saved-spread-traces')).not.toBeInTheDocument()
})

it('ignores an older group response after switching to a different merged spectrum',async()=>{
  serve();const original=api.getMockImplementation()!;let resolve!:(v:SavedMergePlot)=>void,old:SavedMergePlot|undefined
  api.mockImplementation(async(path,body,...rest)=>{
    if(path.includes('/groups/mu/')){old=response(body as Options);return new Promise<SavedMergePlot>(r=>{resolve=r})}
    return original(path,body,...rest)
  })
  const p=props(),view=render(<AthenaMergePlot {...p}/>);await waitFor(()=>expect(old).toBeDefined(),{timeout:2500})
  view.rerender(<AthenaMergePlot {...p} groupId="chi"/>);await ready();await act(async()=>resolve(old!))
  expect(screen.getByLabelText('Saved merged spectrum')).toHaveValue('chi');expect(screen.getByLabelText('Saved merge k weight')).toBeVisible()
  expect(api.mock.calls.at(-1)![0]).toContain('/groups/chi/')
})

it('disables invalid k weights and retries a failed read without changing group parameters',async()=>{
  serve();api.mockRejectedValueOnce(new Error('Saved scatter is missing.'))
  const p=props();render(<AthenaMergePlot {...p} groupId="chi"/>);await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Saved scatter is missing'))
  fireEvent.click(screen.getByRole('button',{name:'Replot saved merge'}));await ready()
  change('Saved merge k weight','-1');expect(screen.getByRole('button',{name:'Replot saved merge'})).toBeDisabled()
  change('Saved merge k weight','1.5');await ready();expect((api.mock.calls.at(-1)![1] as Options).kweight).toBe(1.5)
  expect(project.groups[2].parameters.kweight).toBe(2)
})

it('keeps the normalization toggle available while a new plot is loading',async()=>{
  serve();render(<AthenaMergePlot {...props()} groupId="norm"/>);await ready()
  fireEvent.click(screen.getByRole('checkbox',{name:'Flatten normalized merge'}));expect(screen.getByRole('checkbox',{name:'Flatten normalized merge'})).not.toBeChecked();await ready()
  expect((api.mock.calls.at(-1)![1] as Options).flatten).toBe(false)
})
