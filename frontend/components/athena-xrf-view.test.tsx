import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { differenceProject } from './athena-difference.fixtures'
import { AthenaXrfView } from './athena-xrf-view'

const { api, busy }=vi.hoisted(()=>({api:vi.fn(),busy:vi.fn()}))
vi.mock('@/lib/athena',async original=>({...await original<typeof import('@/lib/athena')>(),athenaApi:api}))
// The stub keeps the layout's uirevision and the ordinate type, because a
// panel that loses the reader's zoom on every checkbox, and a logarithmic
// toggle that changes nothing, are two of the failures named below.
vi.mock('next/dynamic',()=>({default:()=>({data,layout}:{data:unknown;layout:{uirevision?:string;yaxis?:{type?:string}}})=>
  <pre data-testid="plot" data-revision={layout.uirevision} data-ytype={layout.yaxis?.type}>{JSON.stringify(data)}</pre>}))

const POINTS=4
const raster={fast:'sample_x',slow:'sample_y',columns:2,rows:2,serpentine:false}
const inspection={kind:'xrf_cube',upload_id:'cube',display_name:'mn_scan.hdf',filename:'mn_scan.hdf',
  points:POINTS,detectors:[{name:'ge_8element',elements:3,channels:400},{name:'xspress',elements:1,channels:4096}],
  axes:[{name:'energy',min:6400,max:7200},{name:'sample_x',min:0,max:3}],
  raster:null as typeof raster|null}
// One pixel of the image recorded nothing. On a logarithmic colour scale it
// cannot be drawn, and what the panel does with it is tested below.
const image={rows:2,columns:2,fast:'sample_x',slow:'sample_y',x:[0,1],y:[0,1],values:[[0,12],[14,16]]}

let file=inspection
function frame(request:{point:number;elements:number[];axis:string|null;roi_range:number[]}) {
  const chosen=request.elements.length?request.elements:[0,1,2]
  return {version:7,cube_id:'cube',display_name:'mn_scan.hdf',points:POINTS,point:request.point,
    averaged:[request.point,request.point+1],elements:chosen,channel_lo:0,rebin:1,
    energy_kev:[5.0,5.9,6.4],
    spectra:chosen.map(index=>[1,10*(index+1),1]),
    total:[chosen.length,chosen.reduce((sum,index)=>sum+10*(index+1),0),chosen.length],
    element_counts:chosen.map(index=>10*(index+1)),
    axis_name:request.axis,trace_stride:1,
    axis:request.axis==='energy'?[6400,6600,6800,7000]:[0,1,2,3],
    roi:[10,12,14,16],roi_range:request.roi_range,
    map:file.raster?image:null}
}
function handler(url:string,body?:Record<string,any>):Promise<any> {
  if(url.endsWith('/inspect'))return Promise.resolve(file)
  if(url.endsWith('/frame'))return Promise.resolve(frame(body as any))
  return Promise.resolve(differenceProject())
}
function Harness() {
  const [p]=useState(differenceProject())
  return <AthenaXrfView project={p} setBusy={busy} />
}
async function tick(){await act(()=>vi.advanceTimersByTimeAsync(250))}
async function upload() {
  fireEvent.change(screen.getByLabelText('Choose detector file'),
    {target:{files:[new File(['counts'],'mn_scan.hdf')]}})
  await tick();await tick()
}
async function setup(){render(<Harness/>);await tick();await upload()}
const frames=()=>api.mock.calls.filter(call=>String(call[0]).endsWith('/frame'))
const plots=()=>screen.queryAllByTestId('plot')
const traces=(figure:string)=>JSON.parse(within(screen.getByLabelText(figure)).getByTestId('plot').textContent!) as
  {name?:string;type:string;x:number[];y:number[];z?:(number|null)[][]}[]

beforeEach(()=>{vi.useFakeTimers();file={...inspection,raster:null};api.mockReset().mockImplementation(handler);busy.mockClear()})
afterEach(()=>{cleanup();vi.useRealTimers()})

it.each([
  ['Last channel read','401'], ['Energy offset (keV)','0.6'],
  ['Energy per channel (keV)','0.0001'], ['Energy per channel (keV)','0.2'],
])('rejects invalid %s=%s before reading another frame',async(label,value)=>{
  await setup()
  expect(frames()).toHaveLength(1)
  fireEvent.change(screen.getByLabelText(label),{target:{value}})
  await tick()
  expect(frames()).toHaveLength(1)
  expect(screen.getByRole('alert')).not.toBeEmptyDOMElement()
})


it('says the spectrum is being read, not "choose a file", while the first frame is on its way',async()=>{
  // The demo screenshot was taken in the gap between the file's inspection
  // and its first frame, and showed two empty plots telling the reader to
  // choose the file that was already chosen.
  let release:(value:unknown)=>void=()=>{}
  api.mockImplementation((url:string,body?:Record<string,any>)=>url.endsWith('/frame')
    ? new Promise(resolve=>{release=()=>resolve(frame(body as any))}) : handler(url,body))
  await setup()
  expect(within(screen.getByLabelText('XRF spectrum')).getByText('Reading the spectrum…')).toBeInTheDocument()
  expect(screen.queryByText(/Choose a detector file/)).not.toBeInTheDocument()
  await act(async()=>{release(undefined)});await tick()
  expect(plots()).toHaveLength(2)
})

it('keeps the default window of interest inside the channels read when they are narrowed',async()=>{
  // The script's first step narrows the channels read to 1024 of 4096. The
  // window of interest still ran to 4096, the form went invalid, and no frame
  // was asked for until the window was edited as well: the plots froze.
  await setup()
  fireEvent.change(screen.getByLabelText('Last channel read'),{target:{value:'300'}});await tick()
  expect((screen.getByLabelText('Window of interest, last channel') as HTMLInputElement).value).toBe('300')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(frames().at(-1)![1]).toMatchObject({channel_range:[0,300],roi_range:[0,300]})
  // A window set by hand is left where it was put.
  fireEvent.change(screen.getByLabelText('Window of interest, last channel'),{target:{value:'200'}});await tick()
  fireEvent.change(screen.getByLabelText('Last channel read'),{target:{value:'250'}});await tick()
  expect((screen.getByLabelText('Window of interest, last channel') as HTMLInputElement).value).toBe('200')
})

it('builds every control from the one response that read the file',async()=>{
  // The detector menu, the point slider and the abscissa menu all come from
  // the inspection. A panel that invents any of them -- a channel count, a
  // point count -- asks for a frame the file cannot answer, and the reader
  // sees an error instead of their data.
  await setup()
  const detector=screen.getByLabelText('Detector') as HTMLSelectElement
  expect([...detector.options].map(option=>option.textContent))
    .toEqual(['ge_8element · 3 elements · 400 channels','xspress · 1 elements · 4096 channels'])
  const abscissa=screen.getByLabelText('Trace abscissa') as HTMLSelectElement
  expect([...abscissa.options].map(option=>option.value)).toEqual(['','energy','sample_x'])
  expect((screen.getByLabelText('Move through the scan') as HTMLInputElement).max).toBe('3')
  expect((screen.getByLabelText('Last channel read') as HTMLInputElement).value).toBe('400')
  expect((screen.getByLabelText('Window of interest, last channel') as HTMLInputElement).value).toBe('400')
  expect(frames()).toHaveLength(1)
  expect(frames()[0][1]).toMatchObject({cube_id:'cube',detector:'ge_8element',point:0,
    elements:[],channel_range:[0,400],roi_range:[0,400],rebin:1,axis:null})
})

it('asks for one frame when the point slider is dragged, not one for every step',async()=>{
  // Each frame re-reads the detector file on the server. Sending one request
  // per slider step makes a drag across a scan hundreds of reads, and the
  // frames arrive out of order, so the spectrum left on screen is whichever
  // read finished last rather than the point under the reader's cursor.
  await setup()
  const slider=screen.getByLabelText('Move through the scan')
  fireEvent.change(slider,{target:{value:'1'}})
  fireEvent.change(slider,{target:{value:'2'}})
  fireEvent.change(slider,{target:{value:'3'}})
  await tick()
  expect(frames()).toHaveLength(2)
  expect(frames().at(-1)![1].point).toBe(3)
  expect(screen.getByRole('heading',{name:/Detector spectrum/})).toHaveTextContent('at point 3')
})

it('leaves an unticked detector element out of the request and out of the plot',async()=>{
  // A dead or shadowed element adds its noise to the sum and nothing else.
  // Dropping it only from the drawing, while the server still sums it, hides
  // the element without removing what it contributed.
  await setup()
  expect(traces('XRF spectrum').map(t=>t.name))
    .toEqual(['All chosen elements','Element 1','Element 2','Element 3'])
  fireEvent.click(screen.getByLabelText('Element 2'));await tick()
  expect(frames().at(-1)![1].elements).toEqual([0,2])
  expect(traces('XRF spectrum').map(t=>t.name)).toEqual(['All chosen elements','Element 1','Element 3'])
  expect(screen.getByText(/Counts in the window of interest at this point/))
    .toHaveTextContent('element 1 10.00 · element 3 30.00')
})

it('redraws presentation changes without reading the file again',async()=>{
  // Counts on a logarithmic ordinate is how a weak line is seen beside the
  // elastic peak, and it is a property of the drawing alone. Asking the
  // server for it would re-read the file, and losing the reader's zoom to a
  // new uirevision would undo the panning they did to find the line.
  await setup()
  const revisions=()=>plots().map(node=>node.getAttribute('data-revision'))
  const before=revisions()
  expect(before).toEqual(['xrf-view:cube:ge_8element:spectrum','xrf-view:cube:ge_8element:trace'])
  expect(plots()[0].getAttribute('data-ytype')).toBe('log')
  fireEvent.click(screen.getByLabelText('Logarithmic counts'));await tick()
  expect(revisions()).toEqual(before)
  expect(frames()).toHaveLength(1)
  expect(plots()[0].getAttribute('data-ytype')).toBe('linear')
})

it('says a file holds a line scan rather than drawing a one-row image',async()=>{
  // One file of a multi-file map holds a single row, and an energy scan holds
  // no positions at all. Presenting either as a map of the sample invents a
  // second dimension that was never measured.
  await setup()
  expect(plots()).toHaveLength(2)
  expect(screen.getByText(/This file holds a one-dimensional scan/)).toBeInTheDocument()
  expect(screen.queryByLabelText('Map display')).not.toBeInTheDocument()
})

it('draws a raster file at the stage positions it was measured at',async()=>{
  // The counts arrive as one long list and the positions with them. Drawing
  // the image on a pixel grid instead of on the positions silently rescales
  // the sample, which is read off the plot as a distance.
  file={...inspection,raster}
  await setup()
  const heatmap=traces('Map display')[0]
  expect(heatmap.type).toBe('heatmap')
  expect(heatmap.x).toEqual([0,1])
  expect(heatmap.y).toEqual([0,1])
  expect(heatmap.z).toEqual([[0,12],[14,16]])
  expect(screen.getByRole('heading',{name:'Map of the window of interest'})).toBeInTheDocument()
})

it('leaves an empty pixel empty on a logarithmic colour scale',async()=>{
  // Plotly has no logarithmic colour axis, so the logarithm is taken here. A
  // pixel with no counts has none, and clamping it to the bottom of the scale
  // would present an unmeasured or dead pixel as a weak but real signal.
  file={...inspection,raster}
  await setup()
  fireEvent.click(screen.getByLabelText('Logarithmic colour scale'));await tick()
  expect(traces('Map display')[0].z).toEqual([[null,Math.log10(12)],[Math.log10(14),Math.log10(16)]])
  expect(frames()).toHaveLength(1)
})

it('refuses a window of interest outside the channels read before sending it',async()=>{
  // An empty window sums to zero at every point, which plots as a flat trace
  // and a blank map: a dead detector and a misplaced window look identical.
  // The server refuses it; catching it here says which setting is wrong.
  await setup()
  fireEvent.change(screen.getByLabelText('Window of interest, last channel'),{target:{value:'500'}})
  await tick()
  expect(frames()).toHaveLength(1)
  expect(screen.getByRole('alert'))
    .toHaveTextContent('The window of interest must increase and lie inside the channels read.')
})

it('shows the server message instead of the frame it replaced',async()=>{
  // A frame that was refused leaves the previous one on screen unless it is
  // cleared, and the reader then reads a spectrum at the point they moved
  // away from as the spectrum at the point they moved to.
  await setup()
  expect(plots()).toHaveLength(2)
  api.mockImplementation((url:string,body?:Record<string,any>)=>url.endsWith('/frame')
    ? Promise.reject(new Error('This file has 4 points, numbered from 0; point 3 does not exist.'))
    : handler(url,body))
  fireEvent.change(screen.getByLabelText('Move through the scan'),{target:{value:'3'}});await tick()
  expect(plots()).toHaveLength(0)
  expect(screen.getByRole('alert')).toHaveTextContent('point 3 does not exist')
})

it('plots the trace against an array the file holds when one is chosen',async()=>{
  // Against the point number, a scan whose points are unevenly spaced in
  // energy is distorted, and a map row carries no distance at all.
  await setup()
  expect(traces('Window trace')[0].x).toEqual([0,1,2,3])
  fireEvent.change(screen.getByLabelText('Trace abscissa'),{target:{value:'energy'}});await tick()
  expect(frames().at(-1)![1].axis).toBe('energy')
  expect(traces('Window trace')[0].x).toEqual([6400,6600,6800,7000])
})
