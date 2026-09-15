import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaConvolution, type ConvolutionPreview } from './athena-convolution'

type PlotProps = ComponentProps<typeof Plot>
const plot = vi.hoisted(() => vi.fn<(p: PlotProps) => void>())
vi.mock('next/dynamic', () => ({ default: () => (props: PlotProps) => { useLayoutEffect(() => { plot(props) }); return <div /> } }))
vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const x = Array.from({length: 31}, (_, i) => 8900 + i * 2), y = x.map((_, i) => Math.sin(i) + i / 10)
const project = { id: 'p', version: 4, groups: [{ id: 'g', label: 'Cu', data_type: 'mu', frozen: true,
  energy: x, mu: y, source: {}, parameters: {energy_shift: 2, kweight: 2},
  result: {arrays: {k: [0,1,2], weighted_chi: [0,.1,-.1], r: [0,1,2], chir_mag: [0,1,.5]}} }] } as unknown as AthenaProject
const props = () => ({project, activeId: 'g', selectGroup: vi.fn(), setBusy: vi.fn(), saved: vi.fn(), close: vi.fn(), disabled: false})
function preview(options: ConvolutionPreview['options'] = {form: 'gaussian', width: 0, noise: 0}): ConvolutionPreview {
  const energy = x.map(v => v+2), mu = y.map(v => v + (options.noise ? .001 * (options.seed ?? 42) : options.width * .01))
  return {project_id: 'p', version: 4, options: {...options, seed: options.noise ? options.seed ?? 42 : null}, results: [{group_id: 'g', label: 'Cu: modified', input_space: 'E', data_type: 'mu', kweight: 2,
    modified_energy: energy, modified_mu: mu, details: {input_points: x.length, output_points: mu.length, noise_sigma: options.noise * 2.5, seed: options.noise ? options.seed ?? 42 : null, edge_step: 2.5, warnings: []}, errors: {},
    traces: Object.fromEntries(['E','k','R'].map(space => [space, [
      {role: 'original', label: 'Cu', x: space === 'E' ? energy : [0,1,2], y: space === 'E' ? y : [0,.1,-.1]},
      {role: 'modified', label: 'Cu: modified', x: space === 'E' ? energy : [0,1,2], y: space === 'E' ? mu : [0,.09,-.09]},
    ]])) as ConvolutionPreview['results'][0]['traces']}]}
}
const saveButton = () => screen.getByRole('button', {name: 'Make modified group'})
const replot = () => fireEvent.click(screen.getByRole('button', {name: 'Plot data and modified'}))
const handoff = () => plot.mock.calls.at(-1)![0]
const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), {target: {value}})
async function ready() { await waitFor(() => expect(saveButton()).toBeEnabled(), {timeout: 2000}) }
function savedProject(result: ConvolutionPreview) {
  return {...project, version: 5, groups: [...project.groups, {...project.groups[0], id: 'child', source: {parent: 'g'},
    energy: result.results[0].modified_energy, mu: result.results[0].modified_mu}]}
}
afterEach(() => {cleanup(); vi.clearAllMocks(); api.mockReset()})

it('shows calibrated source immediately, native zero defaults, and saves the confirmed derived arrays', async () => {
  const result = preview(); api.mockResolvedValue(result); const p=props(); render(<AthenaConvolution {...p}/>);
  expect(handoff().data[0].x).toEqual(x.map(v=>v+2)); expect(handoff().data[0].y).toEqual(y)
  expect(screen.getByLabelText('Gaussian σ · eV')).toHaveValue(0)
  expect(screen.getByLabelText('Noise σ · fraction of edge step')).toHaveValue(0)
  await ready(); expect(api.mock.calls[0][1]).toEqual({version:4,action:'convolve',group_ids:['g'],options:{form:'gaussian',width:0,noise:0}})
  const next=savedProject(result);api.mockResolvedValueOnce(next);fireEvent.click(saveButton())
  await waitFor(()=>expect(p.saved).toHaveBeenCalledWith(next));expect(p.close).toHaveBeenCalledOnce()
})

it('captures server noise seed across E/k/R and sends it unchanged on save',async()=>{
  api.mockImplementation(async(_path,body)=>preview((body as {options:ConvolutionPreview['options']}).options))
  const p=props();render(<AthenaConvolution {...p}/>);await ready()
  change('Noise σ · fraction of edge step','.01');await ready()
  const expected=preview({form:'gaussian',width:0,noise:.01});expect(handoff().data[1].y).toEqual(expected.results[0].modified_mu)
  fireEvent.click(screen.getByRole('button',{name:'Plot in k'}));fireEvent.click(screen.getByRole('button',{name:'Plot in R'}))
  expect(api).toHaveBeenCalledTimes(2);expect(handoff().data[1].y).toEqual(expected.results[0].traces.R[1].y)
  api.mockResolvedValueOnce(savedProject(expected));fireEvent.click(saveButton());await waitFor(()=>expect(p.saved).toHaveBeenCalledOnce())
  expect(api.mock.calls.at(-1)?.[1]).toEqual({version:4,action:'convolve',group_ids:['g'],options:expected.options})
})

it('replot asks for fresh noise but retains width/form, then saves the new realization',async()=>{
  const initialDraft={form:'lorentzian' as const,width:'2',noise:'.01'},p=props()
  const first=preview({form:'lorentzian',width:2,noise:.01,seed:1}),second=preview({...first.options,seed:2})
  api.mockResolvedValueOnce(first).mockResolvedValueOnce(second);render(<AthenaConvolution {...p} initialDraft={initialDraft}/>);await ready()
  expect(handoff().data[1].y).toEqual(first.results[0].modified_mu);replot();expect(saveButton()).toBeDisabled();await ready()
  expect(handoff().data[1].y).toEqual(second.results[0].modified_mu)
  expect(api.mock.calls[1][1]).toEqual({version:4,action:'convolve',group_ids:['g'],options:{form:'lorentzian',width:2,noise:.01}})
  api.mockResolvedValueOnce(savedProject(second));fireEvent.click(saveButton());await waitFor(()=>expect(p.saved).toHaveBeenCalledOnce())
  expect((api.mock.calls[2][1] as {options:ConvolutionPreview['options']}).options.seed).toBe(2)
})

it('discards late previews after editing and rejects a response for the old revision',async()=>{
  let resolve!:(v:ConvolutionPreview)=>void
  api.mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValueOnce(preview({form:'gaussian',width:1,noise:0}))
  render(<AthenaConvolution {...props()}/>);await waitFor(()=>expect(api).toHaveBeenCalledOnce())
  change('Gaussian σ · eV','1');await ready();await act(async()=>resolve(preview()))
  expect(handoff().data[1].y).toEqual(preview({form:'gaussian',width:1,noise:0}).results[0].modified_mu)
  api.mockResolvedValueOnce({...preview({form:'gaussian',width:2,noise:0}),version:3});change('Gaussian σ · eV','2')
  expect(await screen.findByRole('alert')).toHaveTextContent('does not match');expect(saveButton()).toBeDisabled()
})

it.each(['','-1','1001'])('rejects invalid widths %s without starting a new request',async value=>{
  api.mockResolvedValue(preview());render(<AthenaConvolution {...props()}/>);await ready();change('Gaussian σ · eV',value)
  expect(saveButton()).toBeDisabled();expect(screen.getByText('Enter a width from 0 to 1000 eV and noise from 0 to 100.')).toBeVisible()
  await act(async()=>{await new Promise(r=>setTimeout(r,450))});expect(api).toHaveBeenCalledOnce()
})

it.each(['seed','sigma','points','trace'])('rejects malformed %s instead of allowing save',async what=>{
  const result=preview({form:'gaussian',width:0,noise:.01})
  if(what==='seed')result.options.seed=-1
  if(what==='sigma')result.results[0].details.noise_sigma=NaN
  if(what==='points')result.results[0].modified_mu.pop()
  if(what==='trace')result.results[0].traces.E.pop()
  api.mockResolvedValue(result);render(<AthenaConvolution {...props()} initialDraft={{form:'gaussian',width:'0',noise:'.01'}}/>);
  expect(await screen.findByRole('alert')).toBeVisible();expect(saveButton()).toBeDisabled()
})

it('keeps editable values after a failed save and releases busy state',async()=>{
  const result=preview({form:'lorentzian',width:1,noise:.01}),p=props()
  api.mockResolvedValueOnce(result).mockRejectedValueOnce(new Error('Project changed. Reload.'))
  render(<AthenaConvolution {...p} initialDraft={{form:'lorentzian',width:'1',noise:'.01'}}/>);await ready();fireEvent.click(saveButton())
  expect(await screen.findByRole('alert')).toHaveTextContent('Project changed')
  expect(screen.getByLabelText('Lorentzian HWHM · eV')).toHaveValue(1);expect(saveButton()).toBeDisabled()
  expect(p.setBusy).toHaveBeenLastCalledWith('');expect(p.close).not.toHaveBeenCalled()
})

it('keeps the requested width in the draft while chi accepts only absolute noise',async()=>{
  const p=props(),rememberDraft=vi.fn();const chi=structuredClone(project);chi.groups[0].data_type='chi'
  const result=preview({form:'gaussian',width:0,noise:.01});result.results[0].input_space='k';result.results[0].traces.E=[]
  api.mockResolvedValue(result);render(<AthenaConvolution {...p} project={chi} rememberDraft={rememberDraft} initialDraft={{form:'gaussian',width:'2',noise:'.01'}}/>);await ready()
  expect(screen.getByLabelText('Gaussian σ · eV')).toBeDisabled();expect(screen.getByLabelText('Gaussian σ · eV')).toHaveValue(0)
  expect(screen.getByLabelText('Line shape')).toBeDisabled();expect(screen.getByLabelText('Noise σ · χ(k) units')).toHaveValue(.01)
  expect(api.mock.calls[0][1]).toEqual(expect.objectContaining({options:{form:'gaussian',width:0,noise:.01}}))
  expect(rememberDraft).toHaveBeenLastCalledWith({form:'gaussian',width:'2',noise:'.01'})
})
