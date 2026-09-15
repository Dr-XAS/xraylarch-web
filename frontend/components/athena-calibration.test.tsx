import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, useState, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaCalibration, type CalibrationPreview } from './athena-calibration'

type PlotProps=ComponentProps<typeof Plot>
type Options=CalibrationPreview['options']
const plot=vi.hoisted(()=>vi.fn<(p:PlotProps)=>void>())
vi.mock('next/dynamic',()=>({default:()=>(props:PlotProps)=>{useLayoutEffect(()=>plot(props));return <div/>}}))
vi.mock('@/lib/athena',()=>({athenaApi:vi.fn()}))
const api=vi.mocked(athenaApi), x=Array.from({length:41},(_,i)=>8960+i),y=x.map((_,i)=>i/40)
const project={id:'p',version:4,groups:[{id:'g',label:'Measured Cu',data_type:'mu',energy:x,mu:y,frozen:false,
  parameters:{e0:8982,energy_shift:2,kweight:2},result:{effective:{e0:8982}},source:{}}]} as unknown as AthenaProject
const props=()=>({project,activeId:'g',selectGroup:vi.fn(),setBusy:vi.fn(),saved:vi.fn(),close:vi.fn(),disabled:false,rememberDraft:vi.fn()})
function preview(options:Options,zero=false):CalibrationPreview {
  const observed=zero?8981.12345:options.observed??8982,target=options.target??8979,shift=Number((target-observed+2).toFixed(3))
  const raw=y.map(v=>options.display==='second'?v-.5:options.display==='derivative'?v*.1:v),smooth=raw.map(v=>options.smoothing?v*.9:v)
  return {project_id:'p',version:4,group_id:'g',requested_options:options,options:{...options,observed,target,...(options.smoothing_method==='savitzky_golay'&&options.smoothing?{sg_window:31,sg_order:9}:{})},
    curve:{x:x.map(v=>v+2),y:smooth,unsmoothed:raw,marker:{x:observed,y:smooth[20]},range:[observed-30,observed+50],smoothing:{}},
    energy_shift:shift,shift_delta:shift-2,actual_reference:observed+shift-2,atomic_target:{element:'Cu',edge:'K',energy:8979},zero_crossing:zero?observed:null,
    changes:[{group_id:'g',label:'Measured Cu',e0:target,energy_shift:shift}],processing_errors:{}}
}
function serve(){api.mockImplementation(async(path,body)=>preview((body as {options:Options}).options,path.endsWith('/zero')))}
const save=()=>screen.getByRole('button',{name:'Calibrate'})
const change=(name:string,value:string)=>fireEvent.change(screen.getByLabelText(name,{exact:true}),{target:{value}})
const handoff=()=>plot.mock.calls.at(-1)![0]
async function ready(){await waitFor(()=>expect(save()).toBeEnabled(),{timeout:2500})}
afterEach(()=>{cleanup();vi.clearAllMocks();api.mockReset()})

it('starts with raw derivative and tabulated target, then previews four native display choices',async()=>{
  serve();render(<AthenaCalibration {...props()}/>);expect(save()).toBeDisabled();await ready()
  expect(screen.getByLabelText('Observed reference · eV',{exact:true})).toHaveValue(8982)
  expect(screen.getByLabelText('Calibrate to · eV',{exact:true})).toHaveValue(8979)
  expect(screen.getByLabelText('Calibration display')).toHaveValue('derivative')
  expect(handoff().data[0].x).toEqual(x.map(v=>v+2));expect(handoff().layout).toEqual(expect.objectContaining({xaxis:expect.objectContaining({range:[8952,9032]})}))
  for(const display of ['mu','norm','second']){change('Calibration display',display);await ready();expect((api.mock.calls.at(-1)?.[1] as {options:Options}).options.display).toBe(display)}
  expect(screen.getByRole('button',{name:'Find zero crossing'})).toBeEnabled()
})

it('picks a reference, previews the rounded total shift and saves reviewed settings without rewriting raw data',async()=>{
  serve();const p=props();render(<AthenaCalibration {...p}/>);await ready()
  fireEvent.click(screen.getByRole('button',{name:'Select a point'}))
  act(()=>handoff().onClick?.({points:[{x:8981.12345}]} as never));await ready()
  expect(screen.getByLabelText('Observed reference · eV',{exact:true})).toHaveValue(8981.12345)
  const opts=(api.mock.calls.at(-1)?.[1] as {options:Options}).options,r=preview(opts)
  const next={...project,version:5,groups:[{...project.groups[0],parameters:{...project.groups[0].parameters,e0:r.options.target!,energy_shift:r.energy_shift}}]}
  api.mockResolvedValueOnce(next);fireEvent.click(save());await waitFor(()=>expect(p.saved).toHaveBeenCalledWith(next))
  expect(p.close).toHaveBeenCalledOnce();expect(api.mock.calls.at(-1)?.[1]).toEqual({version:4,action:'calibrate',group_ids:['g'],options:r.options})
})

it('zero search uses the reviewed revision, updates the field, then replots before allowing save',async()=>{
  serve();const p=props();render(<AthenaCalibration {...p}/>);await ready();change('Calibration display','second');await ready()
  fireEvent.click(screen.getByRole('button',{name:'Find zero crossing'}))
  await waitFor(()=>expect(screen.getByLabelText('Observed reference · eV',{exact:true})).toHaveValue(8981.12345));await ready()
  expect(api.mock.calls.some(([path])=>path==='/projects/p/calibration/zero')).toBe(true)
  expect(p.saved).not.toHaveBeenCalled();expect(p.setBusy).toHaveBeenLastCalledWith('')
})

it('display smoothing keeps raw values, exposes captured SG settings and remembers view choices',async()=>{
  serve();const p=props();render(<AthenaCalibration {...p}/>);await ready()
  change('Calibration smoothing','3');await ready();expect(handoff().data).toHaveLength(4)
  expect(handoff().data[0].y).not.toEqual(handoff().data[1].y)
  change('Calibration smoothing method','savitzky_golay');await ready()
  expect(screen.getByText(/Requested SG window 31, order 9/)).toBeVisible()
  expect(p.rememberDraft).toHaveBeenLastCalledWith({display:'derivative',smoothing:'3',smoothing_method:'savitzky_golay'})
})

it('shows requested/effective fit endpoints and plots the refitted calibrated normalization',async()=>{
  serve();render(<AthenaCalibration {...props()}/>);await ready()
  api.mockImplementation(async(_path,body)=>{
    const r=preview((body as {options:Options}).options)
    r.curve.normalization=[{parameter:'norm2',requested:5000,used:18}]
    r.normalization_limits=[{group_id:'g',label:'Measured Cu',adjustments:[{parameter:'norm2',requested:5000,used:18.0004}]}]
    r.calibrated_curve={x:r.curve.x.map(x=>x+r.shift_delta),y:r.curve.y.map(y=>y*1.01)}
    return r
  })
  change('Calibration display','norm');await ready()
  expect(screen.getByRole('region',{name:'Normalization fit limits'})).toHaveTextContent('requested 5000, using 18 eV')
  expect(screen.getByRole('region',{name:'Normalization fit limits'})).toHaveTextContent('After calibration · Measured Cu')
  expect(handoff().data[1].y).not.toEqual(handoff().data[0].y)
  expect(handoff().data[1].y).toEqual(y.map(v=>v*1.01))
})

it('Escape cancels picking; an old handler cannot pick into another revision',async()=>{
  serve();const p=props(),rendered=render(<AthenaCalibration {...p}/>);await ready()
  fireEvent.click(screen.getByRole('button',{name:'Select a point'}))
  fireEvent.keyDown(screen.getByLabelText('Observed reference · eV',{exact:true}),{key:'Escape'})
  act(()=>handoff().onClick?.({points:[{x:8981}]} as never));expect(screen.getByLabelText('Observed reference · eV',{exact:true})).toHaveValue(8982)
  fireEvent.click(screen.getByRole('button',{name:'Select a point'}));const old=handoff().onClick
  rendered.rerender(<AthenaCalibration {...p} project={{...project,version:5}}/>);
  act(()=>old?.({points:[{x:8981}]} as never));expect(screen.getByLabelText('Observed reference · eV',{exact:true})).toHaveValue(8982)
})

it.each(['0','2'])('picks only the current curve with smoothing %s, never the shifted overlay',async smoothing=>{
  serve();render(<AthenaCalibration {...props()}/>);await ready()
  if(smoothing!=='0'){change('Calibration smoothing',smoothing);await ready()}
  const current=smoothing==='0'?0:1
  fireEvent.click(screen.getByRole('button',{name:'Select a point'}))
  act(()=>handoff().onClick?.({points:[{x:8981,curveNumber:current+1}]} as never))
  expect(screen.getByLabelText('Observed reference · eV',{exact:true})).toHaveValue(8982)
  expect(screen.getByRole('button',{name:'Cancel point selection'})).toBeVisible()
  act(()=>handoff().onClick?.({points:[{x:8981,curveNumber:current}]} as never));await ready()
  expect(screen.getByLabelText('Observed reference · eV',{exact:true})).toHaveValue(8981)
})

it('keeps a zero-search error visible when the workbench resumes previewing after a busy action',async()=>{
  serve();const p=props()
  function Workbench(){const [busy,setBusy]=useState('');return <AthenaCalibration {...p} disabled={!!busy} setBusy={setBusy}/>}
  render(<Workbench/>);await ready();change('Calibration display','second');await ready()
  api.mockRejectedValueOnce(new Error('No second-derivative zero crossing.'))
  const count=api.mock.calls.length
  fireEvent.click(screen.getByRole('button',{name:'Find zero crossing'}))
  await waitFor(()=>expect(api.mock.calls.length).toBeGreaterThan(count+1));await ready()
  expect(screen.getByRole('alert')).toHaveTextContent('No second-derivative zero crossing.')
  expect(screen.getByLabelText('Observed reference · eV',{exact:true})).toHaveValue(8982)
  expect(p.saved).not.toHaveBeenCalled()
})

it.each(['axis','shift','marker','version','calibrated'])('rejects mismatched %s preview evidence',async what=>{
  serve();render(<AthenaCalibration {...props()}/>);await ready()
  const options={coordinate:'displayed' as const,observed:8981,target:8979,display:'derivative' as const,smoothing:0,smoothing_method:'three_point' as const},r=preview(options)
  if(what==='axis')r.curve.x[0]++
  if(what==='shift')r.shift_delta++
  if(what==='marker')r.curve.marker.x++
  if(what==='version')r.version--
  if(what==='calibrated')r.calibrated_curve={x:r.curve.x,y:r.curve.y}
  api.mockResolvedValueOnce(r);change('Observed reference · eV','8981')
  expect(await screen.findByRole('alert')).toBeVisible();expect(save()).toBeDisabled()
})

it('discards a late response after values change and revert',async()=>{
  serve();render(<AthenaCalibration {...props()}/>);await ready()
  let finish!:(v:CalibrationPreview)=>void
  api.mockImplementationOnce(()=>new Promise(r=>{finish=r}));change('Observed reference · eV','8981')
  await waitFor(()=>expect(api.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({options:expect.objectContaining({observed:8981})})))
  change('Observed reference · eV','8980');change('Observed reference · eV','8981');await ready()
  const correct=handoff().data
  await act(async()=>finish({...preview({coordinate:'displayed',observed:8981,target:8979,display:'derivative',smoothing:0,smoothing_method:'three_point'}),version:3}))
  expect(handoff().data).toEqual(correct);expect(screen.queryByRole('alert')).toBeNull()
})

it('clearing an entered energy hides stale plots; invalid smoothing cannot submit',async()=>{
  serve();render(<AthenaCalibration {...props()}/>);await ready()
  change('Calibrate to · eV','');expect(save()).toBeDisabled();expect(screen.getByText(/Enter positive finite energies/)).toBeVisible()
  change('Calibrate to · eV','8979');change('Calibration smoothing','11');expect(save()).toBeDisabled()
})

it('keeps inputs and the panel open after a revision conflict, with no duplicate save',async()=>{
  serve();const p=props();render(<AthenaCalibration {...p}/>);await ready()
  api.mockRejectedValueOnce(new Error('Project changed. Reload.'));fireEvent.click(save());fireEvent.click(save())
  expect(await screen.findByRole('alert')).toHaveTextContent('Project changed')
  expect(screen.getByLabelText('Calibrate to · eV',{exact:true})).toHaveValue(8979)
  expect(api.mock.calls.filter(([path])=>path.endsWith('/command'))).toHaveLength(1)
  expect(p.close).not.toHaveBeenCalled();expect(p.setBusy).toHaveBeenLastCalledWith('');expect(save()).toBeDisabled()
})
