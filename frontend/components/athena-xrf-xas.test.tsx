import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AthenaProject } from '@/lib/athena'
import { differenceProject } from './athena-difference.fixtures'
import { AthenaXrfXas } from './athena-xrf-xas'

const { api, busy, saved }=vi.hoisted(()=>({api:vi.fn(),busy:vi.fn(),saved:vi.fn()}))
vi.mock('@/lib/athena',async original=>({...await original<typeof import('@/lib/athena')>(),athenaApi:api}))
// The stub keeps the layout's uirevision, because a panel that loses the
// reader's zoom on every checkbox is the failure one of these tests names.
vi.mock('next/dynamic',()=>({default:()=>({data,layout}:{data:unknown;layout:{uirevision?:string;yaxis?:{range?:number[]}}})=>
  <pre data-testid="plot" data-revision={layout.uirevision} data-range={JSON.stringify(layout.yaxis?.range??null)}>{JSON.stringify(data)}</pre>}))

// usable_i0 is the subset of channels the extraction would accept -- strictly
// positive everywhere -- and suggested_i0 the server's guess at the incident
// monitor among them. 'It' is downstream of the sample and 'SRcurrent' is the
// ring, so neither is offered, and the dead scaler sorts first among all three.
const inspection={upload_id:'scan',display_name:'mn_scan.mda',points:40,energy_min:6400,energy_max:7100,
  detectors:[{name:'mca',elements:4,channels:400}],
  channels:['I0','It','SRcurrent','I0-channels-0-net_count'],
  usable_i0:['I0','It','SRcurrent'],suggested_i0:'I0',engines:['larch','mapstorch']}
function report(over:Record<string,unknown>={}) {
  return {redchi:1.07,nfev:142,success:true,ier:1,message:'converged',
    calibration_subset_only:true,at_bounds:[],bounded_points:0,unconverged_points:0,max_optimality:1e-6,...over}
}
function nullTest(mean:number){return {points:8,mean_frac_of_jump:mean,drift_frac_of_jump:mean*2,detrended_rms_frac_of_jump:mean*3}}
function postEdge(negative:number){return {points:20,negative_fraction:negative,min_frac_of_jump:-negative,normalized_rms_about_one:.04}}
// The verdicts arrive decided. The fixtures carry them separately from the
// measurements so a test can hand the panel a passing measurement with a
// failing verdict, and see which of the two it believes.
function checks(over:Record<string,unknown>={}) {
  return {edge_direction:true,pre_edge_null:true,post_edge_positive:true,...over}
}
function result(over:Record<string,unknown>={},quality:Record<string,unknown>={}) {
  return {version:7,scan_id:'scan',display_name:'mn_scan.mda',
    energy_ev:[6530,6550,6570],fit_over_i0:[.1,.5,.9],roi_over_i0:[.2,.6,1],
    fit_norm:[0,.5,1],roi_norm:[.05,.55,1.05],per_detector:[[.1,.5,.9],[.11,.51,.91]],
    spectrum:{point:0,detector:0,incident_ev:6539,energy_kev:[5,5.5,6],measured:[10,20,30],
      background:[1,2,3],total:[9,19,29],components:{'Mn Ka':[8,1,0],Elastic:[0,1,20]},redchi:1.07},
    quality:{fit:{e0:6539,edge_step:.2475,signed_jump:.2475,null_test:nullTest(.001),
        post_edge:postEdge(0),checks:checks()},
      roi:{e0:6539,edge_step:.2610,signed_jump:.2610,null_test:nullTest(.09),
        post_edge:postEdge(.15),checks:checks({pre_edge_null:false,post_edge_positive:false})},
      detector_agreement:{detectors:4,edge_step_spread:.01,worst_pairwise_rms:.03,
        checks:{shape_agreement:true}},
      elements_without_edge:[],
      limits:{pre_edge_mean:.02,pre_edge_rms:.02,post_edge_negative:.02,detector_shape_rms:.05},
      ...quality},
    detector_reports:[report(),report()],
    detector_parameters:[{cal_offset:-0.0096,cal_slope:0.0097,compton_angle:109.9},
      {cal_offset:-0.0093,cal_slope:0.0097,compton_angle:110.2}],
    metadata:{points:40,detectors:4,engine:'larch',engine_notes:[]},...over}
}
function handler(url:string):Promise<any> {
  if(url.endsWith('/inspect'))return Promise.resolve(inspection)
  if(url.endsWith('/preview'))return Promise.resolve(result())
  return Promise.resolve({...differenceProject(),version:8})
}
function Harness() {
  const [p,setP]=useState(differenceProject())
  return <AthenaXrfXas project={p} setBusy={busy} onSaved={(next:AthenaProject)=>{saved(next);setP(next)}} />
}
async function tick(){await act(()=>vi.advanceTimersByTimeAsync(200))}
async function click(name:string){fireEvent.click(screen.getByRole('button',{name}));await tick();await tick()}
async function upload() {
  fireEvent.change(screen.getByLabelText('Choose fluorescence scan file'),{target:{files:[new File(['counts'],'mn_scan.mda')]}})
  await tick();await tick()
}
async function setup() {
  render(<Harness/>);await tick();await upload()
  fireEvent.change(screen.getByLabelText('Target element'),{target:{value:'Mn'}});await tick()
}
const traces=(figure:string)=>JSON.parse(within(screen.getByLabelText(figure)).getByTestId('plot').textContent!) as
  {name:string;y:number[];line:{dash?:string}}[]
const requests=(suffix:string)=>api.mock.calls.filter(c=>c[0].endsWith(suffix))
beforeEach(()=>{vi.useFakeTimers();api.mockReset().mockImplementation(handler);busy.mockClear();saved.mockClear()})
afterEach(()=>{cleanup();vi.useRealTimers()})

it('renders only the preview that matches the current settings',async()=>{
  await setup();await click('Fit preview')
  expect(screen.getAllByTestId('plot')).toHaveLength(3)
  expect(requests('/preview')).toHaveLength(1)
  fireEvent.change(screen.getByLabelText('Compton scattering angle (°)'),{target:{value:'120'}});await tick()
  // A fit made at 110° must not be presented as the fit at 120°, and changing
  // a setting must not silently spend seconds of server time either.
  expect(screen.queryAllByTestId('plot')).toHaveLength(0)
  expect(requests('/preview')).toHaveLength(1)
  expect(screen.getByRole('status')).toHaveTextContent('Settings changed since the last fit')
  await click('Fit preview')
  expect(requests('/preview')).toHaveLength(2)
  expect(requests('/preview').at(-1)![1].compton_angle).toBe(120)
  expect(screen.getAllByTestId('plot')).toHaveLength(3)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('sends the scatter tail length the user set, not the default',async()=>{
  // The tail length is the one shape setting the calibration does not fit, so
  // it reaches the model only if the panel puts it in the request. Dropped on
  // the way, the field looks like a working remedy for a failed pre-edge test
  // while every fit is still made at Larch's default of 0.5.
  await setup();await click('Fit preview')
  expect(requests('/preview').at(-1)![1].scatter_beta).toBe(0.5)
  fireEvent.change(screen.getByLabelText('Scatter tail length (peak widths)'),{target:{value:'8'}});await tick()
  await click('Fit preview')
  expect(requests('/preview').at(-1)![1].scatter_beta).toBe(8)
})

it('draws the fitted extraction and the window sum side by side, each in its own plot',async()=>{
  // Neither curve is the answer: a fit is not automatically better than a
  // well-placed window, so the two are drawn as equals, not one under the other.
  await setup();await click('Fit preview')
  const fit=traces('Fluorescence XAS preview'),window=traces('Window sum preview')
  expect(fit.map(t=>t.name)).toEqual(['Fitted extraction'])
  expect(window.map(t=>t.name)).toEqual(['Window sum'])
  expect(fit[0].y).toEqual([0,.5,1])
  expect(window[0].y).toEqual([.05,.55,1.05])
  const spectrum=traces('XRF spectrum preview')
  expect(spectrum.map(t=>t.name)).toEqual(['Measured counts','Fitted total','Fitted continuum','Mn Ka','Elastic'])
  // The counts are shown as recorded. Subtracting the continuum from them
  // here would hide the one comparison that says whether the model fits, and
  // it would show a curve the fit never saw: the continuum is fitted, not
  // removed, so the measured points and the total belong on the same axis.
  expect(spectrum[0].y).toEqual([10,20,30])
  expect(spectrum[2].y).toEqual([1,2,3])
})

it('clears a stale preview when the request fails',async()=>{
  await setup();await click('Fit preview')
  expect(screen.getAllByTestId('plot')).toHaveLength(3)
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.reject(new Error('The calibration did not converge.')) : handler(url))
  fireEvent.change(screen.getByLabelText('Compton scattering angle (°)'),{target:{value:'120'}});await tick()
  await click('Fit preview')
  expect(screen.queryAllByTestId('plot')).toHaveLength(0)
  expect(screen.getByRole('alert')).toHaveTextContent('The calibration did not converge.')
  expect(screen.getByRole('button',{name:'Make fluorescence XAS group'})).toBeDisabled()
})

it('reports the pre-edge, the post-edge and detector agreement with a pass or fail',async()=>{
  await setup();await click('Fit preview')
  const quality=within(screen.getByLabelText('Extraction quality'))
  const lines=quality.getAllByText(/^Pre-edge baseline ·/).map(node=>node.textContent)
  expect(lines[0]).toContain('mean 0.10%, drift 0.20%, RMS about the drift 0.30% of the edge step — Within limits')
  // The same limits fail the fixed window, whose pre-edge carries scatter and
  // whose post-edge is driven negative where the scatter peak leaves it.
  expect(lines[1]).toContain('mean 9.00%, drift 18.00%, RMS about the drift 27.00% of the edge step — Outside limits')
  const post=quality.getAllByText(/^Post-edge ·/).map(node=>node.textContent)
  expect(post[0]).toContain('0.00% of points negative, lowest 0.00% of the edge step, oscillation RMS 0.0400 — Pass')
  expect(post[1]).toContain('15.00% of points negative, lowest -15.00% of the edge step, oscillation RMS 0.0400 — Check')
  expect(quality.getByText('Detector agreement').closest('p'))
    .toHaveTextContent('4 elements, worst pairwise RMS between normalized curves 0.0300 (limit 0.05) — Within limit')
})
it('says detector agreement over its limit is outside it, not merely "Check"', async()=>{
  // A scan whose elements disagree by 0.07 against a 0.05 limit was labelled only "Check".
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.resolve(result({},{detector_agreement:{detectors:8,edge_step_spread:.01,worst_pairwise_rms:.07,checks:{shape_agreement:false}}}))
    : handler(url))
  await setup();await click('Fit preview')
  const quality=within(screen.getByLabelText('Extraction quality'))
  expect(quality.getByText('Detector agreement').closest('p')).toHaveTextContent('0.0700 (limit 0.05) — Outside limit')
})

it('shows the verdict the server reached, not one recomputed from part of it',async()=>{
  // A pre-edge that sits on zero on average but scatters wildly about its own
  // drift line is not a clean pre-edge. A panel that judges on the mean and
  // the drift alone -- the two numbers it happened to display first -- calls
  // it a pass while showing the RMS that fails it. The same panel, reading an
  // absolute edge step, calls an upside-down edge healthy.
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.resolve(result({},{
        fit:{e0:6539,edge_step:.2475,signed_jump:-.2475,
          null_test:{points:8,mean_frac_of_jump:.0001,drift_frac_of_jump:.0002,
            detrended_rms_frac_of_jump:.31},
          post_edge:postEdge(.4),
          checks:checks({edge_direction:false,pre_edge_null:false,post_edge_positive:false})},
      }))
    : handler(url))
  await setup();await click('Fit preview')
  const quality=within(screen.getByLabelText('Extraction quality'))
  expect(quality.getByText('Fitted extraction').closest('p'))
    .toHaveTextContent('edge step -0.2475 (fluorescence counts per I₀ count) at E₀ 6539.0 eV — the edge runs the wrong way Check')
  expect(quality.getAllByText(/^Pre-edge baseline ·/)[0].textContent)
    .toContain('mean 0.01%, drift 0.02%, RMS about the drift 31.00% of the edge step — Outside limits')
})

it('says a test was not run rather than passing it by default',async()=>{
  // Too few points below or above the edge means no verdict. Rendering the
  // missing measurement as a pass is how a scan with nothing to test on looks
  // like a scan that was tested and found clean.
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.resolve(result({},{
        fit:{e0:6539,edge_step:.2475,signed_jump:.2475,null_test:null,post_edge:null,
          checks:checks({pre_edge_null:null,post_edge_positive:null})},
      }))
    : handler(url))
  await setup();await click('Fit preview')
  const quality=within(screen.getByLabelText('Extraction quality'))
  expect(quality.getAllByText(/^Pre-edge baseline ·/)[0].textContent)
    .toContain('too few points below the edge to test — Not tested')
  expect(quality.getAllByText(/^Post-edge ·/)[0].textContent)
    .toContain('too few points above the edge to test — Not tested')
})

it('names the detector elements it left out of the agreement check',async()=>{
  // Elements whose edge runs downhill are dropped before the curves are
  // compared. Dropping them silently turns a detector that half failed into a
  // detector that agreed with itself.
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.resolve(result({},{elements_without_edge:[1,3]}))
    : handler(url))
  await setup();await click('Fit preview')
  expect(within(screen.getByLabelText('Extraction quality')).getByText('Detector agreement').closest('p'))
    .toHaveTextContent('elements 2, 4 gave no upward edge on their own and are left out of this comparison only — still in the summed signal')
})

it('disables export until a preview has arrived',async()=>{
  render(<Harness/>);await tick()
  expect(screen.queryByRole('button',{name:'Make fluorescence XAS group'})).not.toBeInTheDocument()
  await upload()
  // No target element yet, so there is nothing to fit and nothing to export.
  expect(screen.getByRole('button',{name:'Fit preview'})).toBeDisabled()
  expect(screen.getByRole('button',{name:'Make fluorescence XAS group'})).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('Name the target element by its symbol')
  fireEvent.change(screen.getByLabelText('Target element'),{target:{value:'Mn'}});await tick()
  expect(screen.getByRole('button',{name:'Make fluorescence XAS group'})).toBeDisabled()
  await click('Fit preview')
  expect(screen.getByRole('button',{name:'Make fluorescence XAS group'})).toBeEnabled()
  await click('Make fluorescence XAS group')
  expect(requests('/make').at(-1)![1]).toMatchObject({point_stride:1,include_window_sum:true,target:'Mn'})
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({version:8}))
})

it('offers only the I₀ channels the extraction would accept, and starts on the suggested one',async()=>{
  // The extraction divides by I₀ and refuses a channel that is not strictly
  // positive, so a channel it would refuse must not be offered. The panel used
  // to pick the first name matching /i0/, or failing that the first channel of
  // all, which on a beamline whose monitors are named after hardware lands on
  // a scaler's unused first channel: the fit then runs on noise and returns a
  // spectrum-shaped curve rather than an error.
  render(<Harness/>);await tick();await upload()
  const channel=screen.getByLabelText('I₀ channel') as HTMLSelectElement
  expect([...channel.options].map(o=>o.value)).toEqual(['','I0','It','SRcurrent'])
  expect(channel.value).toBe('I0')
  fireEvent.change(screen.getByLabelText('Target element'),{target:{value:'Mn'}});await tick()
  await click('Fit preview')
  expect(requests('/preview').at(-1)![1].i0_channel).toBe('I0')
})

it('asks for the I₀ channel when the server recognizes none',async()=>{
  // Guessing wrong here is worse than not guessing: a curve normalized by a
  // motor position or a downstream monitor still looks like a spectrum.
  api.mockImplementation((url:string)=>url.endsWith('/inspect')
    ? Promise.resolve({...inspection,suggested_i0:null}) : handler(url))
  render(<Harness/>);await tick();await upload()
  fireEvent.change(screen.getByLabelText('Target element'),{target:{value:'Mn'}});await tick()
  expect((screen.getByLabelText('I₀ channel') as HTMLSelectElement).value).toBe('')
  expect(screen.getByRole('alert')).toHaveTextContent('Choose the I₀ channel that recorded the incident flux')
  expect(screen.getByRole('button',{name:'Fit preview'})).toBeDisabled()
})

it('reports a detector element whose calibration did not converge',async()=>{
  // The shared-shape calibration runs once per element before any amplitude is
  // solved, and it can stop without converging or leave a shape parameter
  // resting on a limit -- which pushes whatever the data wanted past that limit
  // into the other columns, the target's among them. None of the pre-edge,
  // post-edge or agreement checks sees this, so hiding it leaves the reader
  // with a fit that looks fine and a calibration that did not finish.
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.resolve(result({detector_reports:[report({response_model:'intrinsic'}),
        report({success:false,ier:5,nfev:600,message:'Number of calls exceeded',
          response_model:'calibrated',at_bounds:['compton_angle'],unconverged_points:3,bounded_points:7})]}))
    : handler(url))
  await setup();await click('Fit preview')
  const panel=within(screen.getByLabelText('Extraction quality'))
  expect(panel.getByText(/^Detector calibration ·/))
    .toHaveTextContent('1 of 2 elements converged, 1 resting on a limit')
  // Folded away under a summary line, an unconverged calibration was easy to miss.
  expect(panel.getByRole('alert')).toHaveTextContent('Detector calibration did not converge for 1 of 2 elements')
  // Below the passing checks and the plots, the warning sat off screen while the curves were read.
  expect(screen.getByLabelText('Extraction quality').querySelector('h3 + p')).toBe(panel.getByRole('alert'))
  expect(screen.getByLabelText('Calibration warning')).toHaveTextContent('Calibration did not converge for 1 of 2 detector elements')
  expect(screen.getByLabelText('Calibration warning').compareDocumentPosition(screen.getByLabelText('XRF spectrum preview')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const lines=panel.getAllByRole('listitem').map(node=>node.textContent)
  expect(lines[0]).toContain('selected response converged (142 total evaluations)')
  expect(lines[0]).toContain('intrinsic response')
  expect(lines[1]).toContain('expanded response (nested-model comparison)')
  expect(lines[1]).toContain('selected response stopped after 600 total evaluations without converging (Number of calls exceeded)')
  expect(lines[1]).toContain('resting on a limit: compton_angle')
  expect(lines[1]).toContain('3 point(s) whose amplitude solve did not converge')
  expect(lines[1]).toContain('7 point(s) with an amplitude held at zero')
})

it('preserves the plot ui revision across presentation-only changes',async()=>{
  await setup();await click('Fit preview')
  const revisions=()=>screen.getAllByTestId('plot').map(node=>node.getAttribute('data-revision'))
  const before=revisions()
  expect(before).toEqual(['xrf-xas:scan:spectrum','xrf-xas:scan:xas','xrf-xas:scan:roi'])
  fireEvent.click(screen.getByLabelText('Fitted components'))
  fireEvent.click(screen.getByLabelText('Logarithmic counts'))
  fireEvent.click(screen.getByLabelText('Normalized'))
  fireEvent.click(screen.getByLabelText('Each detector element (contributions)'));await tick()
  expect(revisions()).toEqual(before)
  expect(requests('/preview')).toHaveLength(1)
  // The toggles did change what is drawn, so the unchanged revision above is
  // not an artefact of nothing having happened.
  expect(traces('XRF spectrum preview').map(t=>t.name)).toEqual(['Measured counts','Fitted total','Fitted continuum'])
  expect(traces('Fluorescence XAS preview').map(t=>t.name))
    .toEqual(['Fitted extraction','Detector element 1','Detector element 2'])
  expect(traces('Window sum preview').map(t=>t.name)).toEqual(['Window sum'])
})

it('recovers the raw yield step when the returned curve uses edge-step units',async()=>{
  const preview=result()
  api.mockImplementation((url:string)=>url.endsWith('/preview')?Promise.resolve(result({
    metadata:{...preview.metadata,mu_units:'edge_step',raw_edge_steps:{fit:.2475,roi:.2610}},
  },{
    fit:{...preview.quality.fit,edge_step:1,signed_jump:1},
    roi:{...preview.quality.roi,edge_step:1,signed_jump:1},
  })):handler(url))
  await setup();await click('Fit preview')
  const quality=screen.getByLabelText('Extraction quality')
  expect(quality).toHaveTextContent('raw yield edge step 0.2475 (fluorescence counts per I₀ count)')
  expect(quality).toHaveTextContent('raw yield edge step 0.2610 (fluorescence counts per I₀ count)')
  expect(screen.getByText(/Both yields are divided by their own full-scan edge step/)).toBeInTheDocument()
})

it('offers only the engines the server has, and fits with the one chosen',async()=>{
  // The engine decides which model draws the peaks. Left out of the request it
  // would silently stay Larch, and a demo that claims to compare two models
  // would be comparing one with itself.
  await setup()
  const picker=screen.getByLabelText('Spectral model') as HTMLSelectElement
  expect([...picker.options].map(o=>o.value)).toEqual(['larch','mapstorch'])
  await click('Fit preview')
  expect(requests('/preview').at(-1)![1].engine).toBe('larch')
  fireEvent.change(picker,{target:{value:'mapstorch'}});await tick()
  // A different peak model is a different fit, so the Larch preview must not
  // be left on screen under the MapsTorch setting.
  expect(screen.getByRole('status')).toHaveTextContent('Settings changed since the last fit')
  await click('Fit preview')
  expect(requests('/preview').at(-1)![1].engine).toBe('mapstorch')
  await click('Make fluorescence XAS group')
  expect(requests('/make').at(-1)![1].engine).toBe('mapstorch')
})

it('falls back to Larch on a server without the engine last chosen',async()=>{
  // MapsTorch is optional. Keeping the chosen engine across a file whose
  // server cannot run it would make every fit fail with a server error the
  // reader can do nothing about.
  await setup()
  fireEvent.change(screen.getByLabelText('Spectral model'),{target:{value:'mapstorch'}});await tick()
  api.mockImplementation((url:string)=>url.endsWith('/inspect')
    ? Promise.resolve({...inspection,engines:['larch']}) : handler(url))
  await upload()
  const picker=screen.getByLabelText('Spectral model') as HTMLSelectElement
  expect([...picker.options].map(o=>o.value)).toEqual(['larch'])
  expect(picker.value).toBe('larch')
  fireEvent.change(screen.getByLabelText('Target element'),{target:{value:'Mn'}});await tick()
  await click('Fit preview')
  expect(requests('/preview').at(-1)![1].engine).toBe('larch')
})

it('extracts from the ticked detector elements, at the shifts typed, and never from an unusable one',async()=>{
  // The raw viewer's element choice did not reach the extraction, and one
  // element with an unusable deadtime factor refused the whole scan. The
  // element set and the per-element channel shifts now travel with the
  // request, and an unusable element starts unticked with its reason shown.
  api.mockImplementation((url:string)=>url.endsWith('/inspect')
    ? Promise.resolve({...inspection,detectors:[{name:'mca',elements:4,channels:400,
        unusable_elements:[{element:2,reason:'The deadtime factor is zero.'}]}]})
    : handler(url))
  await setup()
  expect(screen.getByText(/Element 3 is left out: The deadtime factor is zero/)).toBeInTheDocument()
  await click('Fit preview')
  expect(requests('/preview').at(-1)![1].elements).toEqual([0,1,3])
  fireEvent.click(screen.getByLabelText('Element 2'))
  fireEvent.change(screen.getByLabelText('Channel shifts (element:channels)'),{target:{value:'4:3'}});await tick()
  await click('Fit preview')
  expect(requests('/preview').at(-1)![1]).toMatchObject({elements:[0,3],channel_shifts:[[3,3]]})
  fireEvent.change(screen.getByLabelText('Channel shifts (element:channels)'),{target:{value:'9:3'}});await tick()
  expect(screen.getByRole('alert')).toHaveTextContent('Write channel shifts as element:channels')
  expect(screen.getByRole('button',{name:'Fit preview'})).toBeDisabled()
})

it('leaves the windows to the server when they are empty, and says what it chose',async()=>{
  // The fit window used to default to every channel the detector has, which
  // on a full-size scan is over the basis limit, and an empty comparison
  // window meant the whole fit window. Empty now means automatic, and the
  // result says which window and which preview point were derived.
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.resolve(result({metadata:{points:40,detectors:4,engine:'larch',engine_notes:[],
        elements:[0,1,2,3],excluded_elements:[],channel_range:[470,778],roi_range:[570,613],
        windows:{automatic:['channel_range','preview_point','roi_range'],edge:'K',edge_ev:6539,line_kev:5.8965},
        request:{pre1:-170,pre2:-40,norm1:100,norm2:700,preview_point:42}}}))
    : handler(url))
  await setup();await click('Fit preview')
  const sent=requests('/preview').at(-1)![1]
  expect(sent).toMatchObject({channel_range:null,roi_range:null,preview_point:null})
  expect(within(screen.getByLabelText('Extraction quality')).getByText(/Fit window channels/))
    .toHaveTextContent('Fit window channels 470–778 (automatic), comparison window 570–613 (automatic, around the 5.896 keV line), spectrum at scan point 42 (automatic, past the K edge)')
  // One end of a window alone is neither a window nor a request for one.
  fireEvent.change(screen.getByLabelText('Fit window first channel'),{target:{value:'380'}});await tick()
  expect(screen.getByRole('alert')).toHaveTextContent('Leave both ends of a window empty')
})

it('scales each plot to its own curve, not to component tails or the other extraction',async()=>{
  // On a log axis the fitted components' tails fall to 1e-15 and set the
  // range, spending twenty decades on counts no detector recorded; a window
  // sum that climbs to 17 would flatten the fitted edge on a shared axis, and
  // clipping it to the fit's axis would hide it. Each gets its own.
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.resolve(result({roi_norm:[0,8,17],
        spectrum:{point:3,detector:0,incident_ev:6560,energy_kev:[5,5.5,6],measured:[4,200,3000],
          background:[1,2,3],total:[4,190,3010],components:{'Mn K':[1e-15,150,2900]},redchi:1.1}}))
    : handler(url))
  await setup();await click('Fit preview')
  const range=(figure:string)=>JSON.parse(within(screen.getByLabelText(figure)).getByTestId('plot').getAttribute('data-range')!) as number[]
  const counts=range('XRF spectrum preview')
  expect(counts[0]).toBeCloseTo(Math.log10(2))
  expect(counts[1]).toBeCloseTo(Math.log10(2*3010))
  const xas=range('Fluorescence XAS preview')
  expect(xas[0]).toBeLessThan(0);expect(xas[1]).toBeGreaterThan(1);expect(xas[1]).toBeLessThan(2)
  const summed=range('Window sum preview')
  expect(summed[0]).toBeLessThan(0);expect(summed[1]).toBeGreaterThan(17)
})

it('shows what the engine that made the fit does not model',async()=>{
  // An engine that leaves a physical process out says so where the quality
  // checks are read. Dropped here, the omission would live only in a docstring.
  const note='Detector escape peaks are not modelled by this engine.'
  api.mockImplementation((url:string)=>url.endsWith('/preview')
    ? Promise.resolve(result({metadata:{points:40,detectors:4,engine:'mapstorch',engine_notes:[note]}}))
    : handler(url))
  await setup();await click('Fit preview')
  const panel=within(screen.getByLabelText('Extraction quality'))
  expect(panel.getByRole('note')).toHaveTextContent(note)
  expect(panel.getByText(/scan points over 4 detector elements/)).toHaveTextContent('MapsTorch')
})

// Catches a request that pins the calibration to a fixed guess: the server can
// read the file's own calibration only if the panel leaves it empty.
it('leaves the calibration empty by default, so the server reads the file\'s own',async()=>{
  await setup();await click('Fit preview')
  const body=requests('/preview').at(-1)![1]
  expect(body.cal_offset).toBeNull()
  expect(body.cal_slope).toBeNull()
  fireEvent.change(screen.getByLabelText('Energy per channel (keV)'),{target:{value:'0.0296'}});await tick()
  await click('Fit preview')
  expect(requests('/preview').at(-1)![1].cal_slope).toBe(0.0296)
  expect(requests('/preview').at(-1)![1].cal_offset).toBeNull()
})

// Catches a calibration that is silently assumed: the reader must see where it
// came from, and be told plainly when the file gave none.
it('says where the energy calibration came from, and warns when the file gave none',async()=>{
  api.mockImplementation((url:string)=>url.endsWith('/inspect')
    ? Promise.resolve({...inspection,starting_calibration:{mca:{cal_offset:-0.05,cal_slope:0.03,source:'lines_and_elastic',found_for:4,of:4}}})
    : handler(url))
  await setup()
  expect(screen.getByLabelText('Energy calibration')).toHaveTextContent(
    "-0.050 keV + 30.00 eV per channel, read from fluorescence lines of known energy and the scatter peak (4 of 4 elements)")
  cleanup()
  api.mockImplementation((url:string)=>url.endsWith('/inspect')
    ? Promise.resolve({...inspection,starting_calibration:{mca:{cal_offset:0,cal_slope:0.01,source:'default',
        reason:'no line peaked in a beamline window and no elastic peak could be followed across the scan'}}})
    : handler(url))
  await setup()
  expect(screen.getByLabelText('Energy calibration')).toHaveClass('ath-warning')
  expect(screen.getByLabelText('Energy calibration')).toHaveTextContent(
    'no calibration could be read from this file (no line peaked in a beamline window and no elastic peak could be followed across the scan)')
  cleanup()
  // One scatter peak and no line: it may be Compton, and the reader is told how far off that would put lines.
  api.mockImplementation((url:string)=>url.endsWith('/inspect')
    ? Promise.resolve({...inspection,starting_calibration:{mca:{cal_offset:0.02,cal_slope:0.01,source:'elastic_peak',caution:'one scatter peak',found_for:1,of:1}}})
    : handler(url))
  await setup()
  expect(screen.getByLabelText('Energy calibration')).toHaveClass('ath-warning')
  expect(screen.getByLabelText('Energy calibration')).toHaveTextContent(/if that peak is Compton rather than elastic, lines sit up to \d+ channels low/)
})

// Catches the silent disabled button: the reason has to sit next to it.
it('says why Fit preview cannot run, next to the button',async()=>{
  render(<Harness/>);await tick();await upload()
  expect(screen.getByRole('button',{name:'Fit preview'})).toBeDisabled()
  expect(screen.getByLabelText('Why the fit cannot run')).toHaveTextContent('Name the target element by its symbol')
})
