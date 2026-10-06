"use client"

import { SectionHelp } from "./section-help"

import { ThemedPlot as Plot } from "./themed-plot"
import { useRef, useState } from 'react'
import type { AthenaProject } from '@/lib/athena'
import { useAthenaApi } from '@/lib/athena-context'
import { AthenaDownloadButton } from './athena-download-button'
import styles from './athena-xrf-xas.module.css'

const fieldInstructions: Record<string, string> = {
  "channel_lo": "First included detector channel used in fitting. Leave blank for a window derived from the target line and starting energy calibration.",
  "channel_hi": "Exclusive end of the detector fitting window. Leave blank for the automatic range; the channel at this index is not fitted.",
  "roi_lo": "First included channel of the plain window-sum comparison. Leave blank for the automatic window around the target fluorescence line.",
  "roi_hi": "Exclusive end of the plain window-sum comparison. Use this comparison to assess how overlapping lines affect conventional window extraction.",
  "e0": "Absorption-edge energy in eV used to normalize the extracted scan. This is incident-beam energy, distinct from the detector’s fluorescence-energy calibration.",
  "pre1": "Start of the pre-edge fitting interval in eV relative to E₀. Choose a region before the edge without interfering structure.",
  "pre2": "End of the pre-edge fitting interval in eV relative to E₀. Keep it below the edge rise and above the pre-edge start.",
  "norm1": "Start of the post-edge normalization interval in eV relative to E₀. Place it beyond the edge structure you want to retain.",
  "norm2": "End of the post-edge normalization interval in eV relative to E₀. Keep the interval within useful measured data.",
  "nnorm": "Degree of the post-edge normalization polynomial. Lower degrees reduce curvature; inspect the resulting edge step and normalized spectrum."
}

// unusable_elements are the elements whose deadtime factor the extraction
// would refuse; they start unticked, with the reason beside them.
type Detector={name:string;elements:number;channels:number;unusable_elements?:{element:number;reason:string}[]}
// usable_i0 lists the channels that are strictly positive everywhere, which
// is the test the extraction itself applies before dividing by one; the rest
// would be refused. suggested_i0 is the server's guess at the incident-flux
// monitor, and is null when no channel looks like one.
// engines are the fitting engines this server can run. MapsTorch is optional
// -- it brings PyTorch with it -- so the panel offers what is installed
// rather than an option whose first fit would fail.
type Inspection={upload_id:string;display_name:string;points:number;energy_min:number;energy_max:number;detectors:Detector[];channels:string[];usable_i0:string[];suggested_i0:string|null;engines?:string[];layout?:string;notes?:string[]}
type NullTest={points:number;mean_frac_of_jump:number;drift_frac_of_jump:number;drift_over_scan_frac_of_jump?:number;detrended_rms_frac_of_jump:number}
type PostEdge={points:number;negative_fraction:number;min_frac_of_jump:number;normalized_rms_about_one:number}
// Every verdict is decided where the numbers are made, against thresholds the
// server also sends, so the panel displays one judgement rather than forming a
// second one of its own from a subset of what it shows.
type Checks={edge_direction:boolean;pre_edge_null:boolean|null;post_edge_positive:boolean|null}
type Indicator={e0:number;edge_step:number;signed_jump:number;null_test:NullTest|null;post_edge:PostEdge|null;checks:Checks}
type Agreement={detectors:number;edge_step_spread:number;worst_pairwise_rms:number;checks:{shape_agreement:boolean}}
type Limits={pre_edge_mean:number;pre_edge_rms:number;pre_edge_drift_over_scan?:number;post_edge_negative:number;detector_shape_rms:number}
type Spectrum={point:number;detector:number;incident_ev:number;energy_kev:number[];measured:number[];background:number[];total:number[];components:Record<string,number[]>;redchi:number}
// One per detector element: how the shared-shape calibration went, and what
// the amplitude solve under it ran into. success is the optimizer's own
// convergence test, at_bounds the shape parameters it left resting on a
// limit; both were computed and then thrown away before this was shown.
type DetectorReport={redchi:number;nfev:number;success:boolean;ier:number;message:string;
  response_model?:'intrinsic'|'calibrated';
  model_selection?:{candidate_converged:boolean;accepted:boolean}|null;
  calibration_subset_only:boolean;at_bounds:string[];bounded_points:number;unconverged_points:number;max_optimality:number}
// windows says which of the fit window, comparison window and preview point
// the server derived because they were left empty, and from which line.
type Windows={automatic:string[];edge?:string;edge_ev?:number;line_kev?:number}
type Request={pre1:number;pre2:number;norm1:number;norm2:number;preview_point:number|null}
type Result={version:number;scan_id:string;display_name:string;energy_ev:number[];fit_over_i0:number[];roi_over_i0:number[];
  fit_norm:number[];roi_norm:number[];per_detector:number[][];spectrum:Spectrum;
  detector_reports:DetectorReport[];detector_parameters:Record<string,number>[];
  quality:{fit:Indicator;roi:Indicator;detector_agreement:Agreement|null;elements_without_edge?:number[];limits:Limits};
  metadata:{points:number;detectors:number;engine:string;engine_notes:string[];elements?:number[];excluded_elements?:number[];
    mu_units?:'edge_step';raw_edge_steps?:{fit:number;roi:number};
    channel_range?:number[];roi_range?:number[];windows?:Windows;notes?:string[];request?:Request}}
type Trace={x:number[];y:number[];name:string;dash?:'dot'|'dash';markers?:boolean}
type Shape=Record<string,unknown>

const SYMBOL=/^[A-Z][a-z]?$/
const SHIFT=/^\s*(\d+)\s*:\s*([+-]?\d+)\s*$/
const INTEGERS=['calibration_points','point_stride','preview_detector','nnorm'] as const
const OPTIONAL_INTEGERS=['channel_lo','channel_hi','roi_lo','roi_hi','preview_point'] as const
const REQUIRED=[...INTEGERS,'thickness','cal_offset','cal_slope','compton_angle','scatter_beta','pre1','pre2','norm1','norm2'] as const
const palette=['#16736b','#b76d37','#6a4fa3','#2c7fb8','#c0392b','#7f8c2a','#a0338e','#4d6b8a']
const blank={target:'',matrix:'',shifts:'',channel_lo:'',channel_hi:'',roi_lo:'',roi_hi:'',thickness:'1',cal_offset:'0',
  cal_slope:'0.01',compton_angle:'110',scatter_beta:'0.5',calibration_points:'6',point_stride:'1',preview_point:'',preview_detector:'0',
  e0:'',pre1:'-170',pre2:'-40',norm1:'100',norm2:'700',nnorm:'2'}
const labels:Record<string,string>={channel_lo:'Fit window first channel',channel_hi:'Fit window end channel (exclusive)',
  roi_lo:'Comparison window first channel',roi_hi:'Comparison window end channel (exclusive)',e0:'Edge energy E₀ (eV)',
  pre1:'Pre-edge start (eV)',pre2:'Pre-edge end (eV)',norm1:'Post-edge start (eV)',norm2:'Post-edge end (eV)',
  nnorm:'Normalization polynomial degree'}
const percent=(value:number)=>`${(value*100).toFixed(2)}%`
// The engines share the line families, gates, continuum and amplitude solve,
// but not the spectral model: MapsTorch brings its own line tables, detector
// response and escape treatment, so it is an alternative model, not the same
// model with other peak shapes.
const engines:Record<string,string>={larch:'Larch — xraylarch line model',mapstorch:'MapsTorch — an alternative spectral model (MAPS), exploratory'}

function Figure({label,traces,xlabel,ylabel,revision,log,range,shapes,annotations}: {
  label:string;traces:Trace[];xlabel:string;ylabel:string;revision:string;log?:boolean
  range?:[number,number];shapes?:Shape[];annotations?:Shape[]
}) {
  return <div className={styles.plot} aria-label={label}>{traces.length ? <Plot
    data={traces.map((t,i)=>({x:t.x,y:t.y,name:t.name,type:'scatter',mode:t.markers?'markers':'lines',
      marker:{size:3,color:palette[i%palette.length]},
      line:{color:palette[i%palette.length],width:1.6,dash:t.dash??'solid'}}))}
    layout={{autosize:true,margin:{l:62,r:15,t:48,b:45},xaxis:{title:{text:xlabel}},
      yaxis:{title:{text:ylabel},automargin:true,type:log?'log':'linear',...(range?{range,autorange:false}:{})},
      shapes:shapes??[],annotations:annotations??[],
      legend:{orientation:'h',y:1.05,yanchor:'bottom'},uirevision:revision}}
    config={{responsive:true,displaylogo:false,toImageButtonOptions:{format:'svg',filename:'athena-xrf-xas'}}}
    style={{width:'100%',height:'100%'}} useResizeHandler /> : <p>Choose a scan file, name the target element, then fit a preview.</p>}</div>
}

/** A display-only floor for logarithmic counts, set by what was measured: the
 * fitted components fall to 1e-15 in their tails, and letting them set the
 * axis spends twenty decades on numbers no detector recorded. */
function countRange(measured:number[],total:number[]):[number,number]|undefined {
  const positive=measured.filter(v=>v>0)
  if(!positive.length)return undefined
  const top=Math.max(...positive,...total)
  const floor=Math.max(0.5,0.5*Math.min(...positive))
  return [Math.log10(floor),Math.log10(2*top)]
}

/** The extraction axis follows the fitted curve, so the window sum may leave
 * it rather than flatten the curve the panel is about. */
function curveRange(curves:number[][]):[number,number]|undefined {
  const values=curves.flat().filter(Number.isFinite)
  if(!values.length)return undefined
  const lo=Math.min(...values),hi=Math.max(...values),pad=0.08*((hi-lo)||1)
  return [lo-pad,hi+pad]
}

export function AthenaXrfXas({project,onSaved,setBusy}: {
  project:AthenaProject;onSaved:(project:AthenaProject)=>void;setBusy:(label:string)=>void
}) {
  const athenaApi=useAthenaApi()
  const [inspection,setInspection]=useState<Inspection|null>(null)
  const [form,setForm]=useState(blank)
  const [detector,setDetector]=useState('')
  const [chosen,setChosen]=useState<number[]>([])
  const [i0,setI0]=useState('')
  const [material,setMaterial]=useState('Ge')
  const [background,setBackground]=useState('smooth')
  const [engine,setEngine]=useState('larch')
  const [gates,setGates]=useState<string[]>([])
  const [withWindow,setWithWindow]=useState(true)
  // Presentation only: none of these four asks the server for a new fit.
  const [showComponents,setShowComponents]=useState(true)
  const [logCounts,setLogCounts]=useState(true)
  const [normalized,setNormalized]=useState(true)
  const [showDetectors,setShowDetectors]=useState(false)
  const [preview,setPreview]=useState<{key:string;value?:Result;error?:string}|null>(null)
  const [pending,setPending]=useState(false),lock=useRef(false)
  const [error,setError]=useState(''),[notice,setNotice]=useState('')

  const value=(name:keyof typeof blank)=>Number(form[name])
  const optional=(name:keyof typeof blank)=>form[name].trim()===''?null:Number(form[name])
  const chosenDetector=inspection?.detectors.find(d=>d.name===detector)
  const count=chosenDetector?.elements??0
  const unusable=new Map((chosenDetector?.unusable_elements??[]).map(u=>[u.element,u.reason]))
  const selected=chosen.filter(index=>index<count).sort((a,b)=>a-b)
  const elements=form.matrix.split(',').map(s=>s.trim()).filter(Boolean)
  const open=gates.filter(g=>elements.includes(g))
  // Shifts are typed as 'element:channels' with elements numbered from 1, as
  // the checkboxes are; the request numbers them from 0.
  const shiftItems=form.shifts.split(',').map(s=>s.trim()).filter(Boolean)
  const shifts=shiftItems.map(item=>SHIFT.exec(item)).map(m=>m?[Number(m[1])-1,Number(m[2])]:null)
  const shiftsValid=shifts.every(s=>s!==null&&s[0]>=0&&s[0]<count&&Math.abs(s[1])<=64)
    &&new Set(shifts.map(s=>s?.[0])).size===shifts.length
  const fit=[optional('channel_lo'),optional('channel_hi')]
  const roi=[optional('roi_lo'),optional('roi_hi')]
  const fitAuto=fit.every(v=>v===null),roiAuto=roi.every(v=>v===null)
  const numbers=REQUIRED.every(f=>form[f].trim()!==''&&Number.isFinite(value(f)))
    &&INTEGERS.every(f=>Number.isInteger(value(f)))
    &&OPTIONAL_INTEGERS.every(f=>optional(f)===null||Number.isInteger(optional(f)))
    &&(form.e0.trim()===''||value('e0')>0)
  // A window is automatic when both of its ends are empty; one end alone is
  // neither a window nor a request for one.
  const windows=(fitAuto||(fit[0]!==null&&fit[1]!==null&&fit[0]>=0&&fit[1]-fit[0]>=32))
    &&(roiAuto||(roi[0]!==null&&roi[1]!==null&&roi[1]>roi[0]
      &&(fitAuto||(roi[0]>=fit[0]!&&roi[1]<=fit[1]!))))
  const ranges=value('pre1')<value('pre2')&&value('pre2')<0&&value('norm1')>0&&value('norm2')>value('norm1')
    &&value('nnorm')>=0&&value('nnorm')<=3
  const valid=!!inspection&&!!detector&&selected.length>0&&shiftsValid&&!!i0&&SYMBOL.test(form.target)&&elements.every(e=>SYMBOL.test(e))
    &&!elements.includes(form.target)&&numbers&&windows&&ranges
  const problem=!inspection?''
    : selected.length===0?'Choose at least one detector element to extract from.'
    : !shiftsValid?'Write channel shifts as element:channels, such as 11:3, one per element, each between −64 and 64.'
    : !i0?'Choose the I₀ channel that recorded the incident flux. Only the channels that stay positive across the scan are offered, because the extraction divides by this one.'
    : !SYMBOL.test(form.target)?'Name the target element by its symbol, such as Mn.'
    : !elements.every(e=>SYMBOL.test(e))?'Matrix elements must be a comma-separated list of element symbols.'
    : elements.includes(form.target)?'The target element must not be repeated among the matrix elements.'
    : !numbers?'Every setting must be a finite number, and the channel, point and degree fields whole numbers.'
    : !windows?'Leave both ends of a window empty for the automatic one, or give both: the fit window needs at least 32 channels, and the comparison window must lie inside it.'
    : !ranges?'Pre-edge limits must be negative and increasing, post-edge limits positive and increasing.'
    : ''

  const body={version:project.version,scan_id:inspection?.upload_id??'',detector,target:form.target,
    matrix_elements:elements,open_gates:open,i0_channel:i0,
    // Every element and no element mean the same thing to the server; the
    // empty list keeps the request key the same until a box is unticked.
    elements:selected.length===count?[]:selected,
    channel_shifts:shiftsValid?shifts as number[][]:[],
    channel_range:fitAuto?null:fit,roi_range:roiAuto?null:roi,
    detector_material:material,detector_thickness:value('thickness'),
    cal_offset:value('cal_offset'),cal_slope:value('cal_slope'),compton_angle:value('compton_angle'),scatter_beta:value('scatter_beta'),
    calibration_points:value('calibration_points'),point_stride:value('point_stride'),background,engine,
    e0:form.e0.trim()===''?null:value('e0'),pre1:value('pre1'),pre2:value('pre2'),
    norm1:value('norm1'),norm2:value('norm2'),nnorm:value('nnorm'),
    preview_point:optional('preview_point'),preview_detector:value('preview_detector')}
  // The project version is not a setting. Adding a group elsewhere bumps it,
  // and that must not blank a plotted fit, so it is left out of the key that
  // matches a preview to the controls. Requests still carry the true version.
  const key=JSON.stringify([project.id,{...body,version:0}])
  const current=preview?.key===key&&valid?preview.value:undefined
  const stale=!!preview&&preview.key!==key
  const failure=preview?.key===key?preview.error:''
  const revision=`xrf-xas:${inspection?.upload_id??''}`
  const mapstorch=engine==='mapstorch'

  function edit(name:keyof typeof blank,next:string){setForm(f=>({...f,[name]:next}))}
  function field(name:keyof typeof blank,step:'any'|1,placeholder?:string) {
    return <label className="ath-field" key={name}><span>{labels[name]} <SectionHelp label={labels[name]}>{fieldInstructions[name]}</SectionHelp></span>
      <input type="number" step={step} value={form[name]} placeholder={placeholder}
        onChange={e=>edit(name,e.target.value)} /></label>
  }
  function pickDetector(found:Inspection,name:string) {
    const picked=found.detectors.find(d=>d.name===name)
    const bad=new Set((picked?.unusable_elements??[]).map(u=>u.element))
    setDetector(name)
    setChosen(Array.from({length:picked?.elements??0},(_,i)=>i).filter(i=>!bad.has(i)))
  }
  async function task(label:string,work:()=>Promise<void>) {
    if(lock.current)return
    lock.current=true;setPending(true);setBusy(label);setError('');setNotice('')
    try{await work()}catch(e){setError(e instanceof Error?e.message:'The extraction failed.')}
    finally{lock.current=false;setPending(false);setBusy('')}
  }
  async function inspect(file:File) {
    setInspection(null);setPreview(null)
    await task('Reading the fluorescence scan',async()=>{
      const data=new FormData();data.append('file',file)
      const found=await athenaApi<Inspection>(`/projects/${project.id}/xrf-xas/inspect`,data)
      setInspection(found);pickDetector(found,found.detectors[0]?.name??'')
      // The server names the monitor; a beamline that calls it 'IpreKB' is not
      // going to be found by looking for 'i0', and falling back to whichever
      // channel sorts first picks a dead scaler as often as not. Empty when
      // nothing looks like a monitor, so the choice is asked for rather than
      // guessed.
      setI0(found.suggested_i0??'')
      setEngine(e=>found.engines&&!found.engines.includes(e)?'larch':e)
      // Windows and the preview point start empty: the server derives them
      // from the target line, the top incident energy and the calibration.
      setForm(f=>({...f,channel_lo:'',channel_hi:'',roi_lo:'',roi_hi:'',shifts:'',
        preview_point:'',preview_detector:'0',
        // Stride thins only the displayed curve. Fits, edge steps and quality
        // checks always use the full scan and are reusable by Make group.
        point_stride:String(Math.max(1,Math.ceil(found.points/400)))}))
    })
  }
  async function refit() {
    const requested=key
    await task('Fitting the XRF spectra',async()=>{
      try{setPreview({key:requested,value:await athenaApi<Result>(`/projects/${project.id}/xrf-xas/preview`,body)})}
      catch(e){setPreview({key:requested,error:e instanceof Error?e.message:'The fit failed.'})}
    })
  }
  async function make() {
    await task('Making the fluorescence XAS group',async()=>{
      onSaved(await athenaApi<AthenaProject>(`/projects/${project.id}/xrf-xas/make`,
        {...body,point_stride:1,include_window_sum:withWindow}))
      setNotice('Created the fluorescence XAS group from every scan point. Undo removes it.')
    })
  }

  const spectrum=current?.spectrum
  // The counts are drawn as they were recorded. Nothing is subtracted from
  // them before the fit, so nothing is subtracted from them here either: the
  // continuum is one of the fitted curves, shown under the rest.
  const counts:Trace[]=spectrum?[
    {x:spectrum.energy_kev,y:spectrum.measured,name:'Measured counts',markers:true},
    {x:spectrum.energy_kev,y:spectrum.total,name:'Fitted total'},
    {x:spectrum.energy_kev,y:spectrum.background,name:'Fitted continuum',dash:'dot'},
    ...(showComponents?Object.entries(spectrum.components).map(([name,y])=>({x:spectrum.energy_kev,y,name})):[]),
  ]:[]
  const energy=current?.energy_ev??[]
  const elementNumbers=current?.metadata.elements??current?.per_detector.map((_,i)=>i)??[]
  const fitted=current?(normalized?current.fit_norm:current.fit_over_i0):[]
  const summed=current?(normalized?current.roi_norm:current.roi_over_i0):[]
  const detectorsShown=!!current&&!normalized&&showDetectors
  // The fit and the window sum are drawn side by side, each on its own axis,
  // and neither is offered as the answer: which one to trust depends on the
  // scan, and the quality numbers under each are what decide it.
  const fitTraces:Trace[]=current?[
    {x:energy,y:fitted,name:'Fitted extraction'},
    ...(detectorsShown?current.per_detector.map((y,i)=>({x:energy,y,name:`Detector element ${(elementNumbers[i]??i)+1}`})):[]),
  ]:[]
  const windowTraces:Trace[]=current?[{x:energy,y:summed,name:'Window sum'}]:[]
  const fitRange=current?curveRange([fitted,...(detectorsShown?current.per_detector:[])]):undefined
  const windowRange=current?curveRange([summed]):undefined
  // E₀ and the two normalization ranges, where the quality numbers below are
  // measured, drawn on the curve they are measured on.
  const used=current?.metadata.request??{pre1:value('pre1'),pre2:value('pre2'),norm1:value('norm1'),norm2:value('norm2'),preview_point:null}
  const band=(x0:number,x1:number,color:string):Shape=>({type:'rect',xref:'x',yref:'paper',x0,x1,y0:0,y1:1,
    fillcolor:color,opacity:0.12,line:{width:0},layer:'below'})
  const marks=(e0:number|undefined):Shape[]=>e0===undefined?[]:[
    band(e0+used.pre1,e0+used.pre2,'#4d6b8a'),band(e0+used.norm1,e0+used.norm2,'#7f8c2a'),
    {type:'line',xref:'x',yref:'paper',x0:e0,x1:e0,y0:0,y1:1,line:{color:'#555',width:1,dash:'dot'}}]
  const notes=(e0:number|undefined):Shape[]=>e0===undefined?[]:[
    {x:e0,y:1,xref:'x',yref:'paper',text:'E₀',showarrow:false,yanchor:'bottom'},
    {x:e0+(used.pre1+used.pre2)/2,y:0,xref:'x',yref:'paper',text:'pre-edge',showarrow:false,yanchor:'bottom'},
    {x:e0+(used.norm1+used.norm2)/2,y:0,xref:'x',yref:'paper',text:'post-edge',showarrow:false,yanchor:'bottom'}]
  const yieldLabel=normalized?'Normalized μ(E)':current?.metadata.mu_units==='edge_step'?'Fluorescence yield (edge-step units)':'Fluorescence / I₀'

  function verdict(ok:boolean|null,words:[string,string]=['Pass','Check']) {
    return <span className={styles.verdict}>{ok===null?'Not tested':ok?words[0]:words[1]}</span>
  }
  function qualityLines(role:'fit'|'roi',indicator:Indicator) {
    const test=indicator.null_test, post=indicator.post_edge, checks=indicator.checks
    const label=role==='fit'?'Fitted extraction':'Window sum'
    const rawJump=indicator.signed_jump*(current?.metadata.raw_edge_steps?.[role]??1)
    return <><p><strong>{label}</strong> · raw yield edge step {rawJump.toPrecision(4)} (fluorescence counts per I₀ count) at E₀ {indicator.e0.toFixed(1)} eV{
      // Larch reports the edge step as an absolute value, so an extraction
      // that runs downhill across the edge looks healthy by its size alone.
      checks.edge_direction?<></>:<> — the edge runs the wrong way {verdict(false)}</>}</p>
      <p>Pre-edge baseline · {test
        ? <>mean {percent(test.mean_frac_of_jump)}, drift {percent(test.drift_frac_of_jump)}{test.drift_over_scan_frac_of_jump!==undefined?` (${percent(test.drift_over_scan_frac_of_jump)} carried across the scan)`:''}, RMS about the drift {percent(test.detrended_rms_frac_of_jump)} of the edge step — {verdict(checks.pre_edge_null,['Within limits','Outside limits'])}</>
        : <>too few points below the edge to test — {verdict(null)}</>}</p>
      <p>Post-edge · {post
        ? <>{percent(post.negative_fraction)} of points negative, lowest {percent(post.min_frac_of_jump)} of the edge step, oscillation RMS {post.normalized_rms_about_one.toPrecision(3)} — {verdict(checks.post_edge_positive)}</>
        : <>too few points above the edge to test — {verdict(null)}</>}</p></>
  }

  // The calibration fits the detector's shared shape -- the energy axis, the
  // peak shape, the scatter peaks -- on a subset of points, once per detector
  // element, before any amplitude is solved. It can end badly in ways no
  // quality indicator above would show: the optimizer can stop without
  // converging, and it can leave a shape parameter resting on a limit, which
  // pushes whatever the data wanted beyond that limit into the other columns,
  // the target's among them. Both were already computed; this shows them.
  const reports=current?.detector_reports??[]
  const converged=reports.filter(r=>r.success).length
  const resting=reports.filter(r=>r.at_bounds.length>0).length
  const unconverged=reports.length>0&&converged<reports.length
  const calibration=reports.length>0&&<details className={styles.calibration}>
    <summary>Detector calibration · {converged} of {reports.length} element{reports.length===1?'':'s'} converged{resting>0?`, ${resting} resting on a limit`:''}</summary>
    <p className="ath-hint">Each detector element is calibrated on its own, on the same subset of scan points. Reduced χ² here counts only the shape parameters, not the amplitudes eliminated inside the fit, so read it as a comparison between elements rather than as a goodness of fit. An element that did not converge, or whose shape parameters rest on a limit, may or may not have spoiled the extraction. The quality checks above cannot settle it: they test the summed curve, and a detector whose calibration went wrong can drop out of the sum while every check still passes. The server refuses a result in which the target line has left an element's fit window; short of that, compare the fitted energy axes below with the detector's known calibration.</p>
    <ul>{reports.map((r,i)=>{
      const p=current?.detector_parameters?.[i]
      return <li key={i}>Element {(elementNumbers[i]??i)+1} · reduced χ² {r.redchi.toPrecision(4)} · {r.success
        ? <>selected response converged ({r.nfev} total evaluations)</>
        : <>selected response stopped after {r.nfev} total evaluations without converging{r.message?` (${r.message})`:''}</>}
        {r.response_model&&<> · {r.response_model==='intrinsic'?'intrinsic response':'expanded response (nested-model comparison)'}</>}
        {r.model_selection&&!r.model_selection.candidate_converged&&<> · expanded response comparison did not converge; intrinsic response retained</>}
        {r.at_bounds.length>0&&<> · resting on a limit: {r.at_bounds.join(', ')}</>}
        {r.unconverged_points>0&&<> · {r.unconverged_points} point(s) whose amplitude solve did not converge</>}
        {r.bounded_points>0&&<> · {r.bounded_points} point(s) with an amplitude held at zero</>}
        {p&&<> · energy axis {p.cal_offset.toPrecision(3)} + {p.cal_slope.toPrecision(5)} keV per channel, Compton angle {p.compton_angle.toFixed(1)}°</>}</li>
    })}</ul>
  </details>

  const meta=current?.metadata
  const automatic=new Set(meta?.windows?.automatic??[])
  const edgeless=current?.quality.elements_without_edge??[]
  return <div className="ath-modal-body"><div className={styles.layout}>
    <fieldset disabled={pending} className={styles.controls}>
      <label className="ath-field"><span>Fluorescence scan file <SectionHelp label="Fluorescence scan file">Load a scan containing a full fluorescence spectrum at each incident energy. Fits use the original detector counts and retain the source file.</SectionHelp></span><input type="file" aria-label="Choose fluorescence scan file" onChange={e=>{const f=e.target.files?.[0];if(f)void inspect(f)}} /></label>
      <p className="ath-hint">A multi-element detector scan: one whole XRF spectrum per detector element at every incident energy, as a NeXus-style HDF5 scan or an APS 20-BM detector file. The file is kept whole, and every fit is made from the original counts.</p>
      {inspection&&<>
        <h3>{inspection.display_name} · {inspection.points} points · {inspection.energy_min.toFixed(1)}–{inspection.energy_max.toFixed(1)} eV</h3>
        {inspection.notes?.map((note,i)=><p key={i} role="note" className="ath-hint">{note}</p>)}
        <div className="ath-fields">
          <label className="ath-field"><span>Detector <SectionHelp label="Detector">Choose the detector array to fit. Inspect individual detector elements and exclude dead, shadowed or distorted channels before extracting the yield.</SectionHelp></span><select value={detector} onChange={e=>pickDetector(inspection,e.target.value)}>{inspection.detectors.map(d=><option key={d.name} value={d.name}>{d.name} · {d.elements} elements · {d.channels} channels</option>)}</select></label>
          <label className="ath-field"><span>I₀ channel <SectionHelp label="I₀ channel">Choose the incident-flux monitor used to divide the fitted fluorescence yield. It should track incoming beam intensity throughout the scan.</SectionHelp></span><select value={i0} onChange={e=>setI0(e.target.value)}>
            <option value="">Choose the incident-flux monitor</option>
            {inspection.usable_i0.map(c=><option key={c} value={c}>{c}</option>)}</select></label>
          <label className="ath-field"><span>Target element <SectionHelp label="Target element">Enter the chemical symbol of the element whose fluorescence yield will become XAS. Its edge gate remains open so the pre-edge baseline is determined by the data.</SectionHelp></span><input value={form.target} placeholder="Mn" onChange={e=>edit('target',e.target.value)} /></label>
          <label className="ath-field"><span>Matrix elements <SectionHelp label="Matrix elements">Enter comma-separated symbols for other elements whose lines overlap the fit window, for example Ti, V, Cr, Fe. Include plausible contributors to avoid assigning their intensity to the target.</SectionHelp></span><input value={form.matrix} placeholder="Ti, V, Cr, Fe" onChange={e=>edit('matrix',e.target.value)} /></label>
        </div>
        {count>1&&<div className={styles.gates} aria-label="Detector elements"><SectionHelp label="Detector elements">Select usable elements for fitting, deadtime correction and the comparison window. All three calculations use this same set; inspect detector consistency before extracting XAS.</SectionHelp>
          {Array.from({length:count},(_,index)=><label className="ath-check" key={index} title={unusable.get(index)}>
            <input type="checkbox" checked={selected.includes(index)}
              onChange={e=>setChosen(c=>e.target.checked?[...c,index]:c.filter(v=>v!==index))} />
            Element {index+1}{unusable.has(index)?' (unusable deadtime)':''}</label>)}
          <button type="button" onClick={()=>setChosen(Array.from({length:count},(_,i)=>i).filter(i=>!unusable.has(i)))}>All usable elements</button>
        </div>}
        {[...unusable].map(([index,reason])=><p key={index} className="ath-hint">Element {index+1} is left out: {reason}</p>)}
        <p className="ath-hint">The fit, the deadtime correction and the window sum all use exactly the ticked elements. Leave out an element the raw viewer shows dead, shadowed or with a broad, smeared line.</p>
        <label className="ath-field"><span>Channel shifts (element:channels) <SectionHelp label="Channel shifts (element:channels)">Enter one-based detector-element shifts such as 11:3 (element 11, plus 3 channels). Positive values read higher channels, negative values lower channels. These shifts mainly affect the comparison window; each detector element is calibrated separately for fitting.</SectionHelp></span><input value={form.shifts} placeholder="none, or 11:3" onChange={e=>edit('shifts',e.target.value)} /></label>
        <p className="ath-hint">An element whose spectrum sits a few channels off its neighbours is read that many channels higher (positive) or lower, so its line falls in the same comparison window. Each element is calibrated on its own for the fit, so the shift matters mostly to the window sum.</p>
        <p className="ath-hint">Matrix elements are the other lines in the window. The target&apos;s edge gate is always open, so its pre-edge is free to be whatever the data say.</p>
        {elements.length>0&&<div className={styles.gates} aria-label="Force the edge gate open">{elements.map(symbol=><label className="ath-check" key={symbol}><input type="checkbox" checked={open.includes(symbol)} onChange={e=>setGates(g=>e.target.checked?[...g,symbol]:g.filter(v=>v!==symbol))} />Fit {symbol} below its edge <SectionHelp label={`Fit ${symbol} below its edge`}>Allow this matrix element’s fluorescence at incident energies below its absorption edge, for example when it originates outside the illuminated sample volume. Set this from the measurement geometry and observed lines.</SectionHelp></label>)}</div>}
        <p className="ath-hint">Open a matrix element&apos;s gate when its lines reach the detector from outside the illuminated volume, so the monochromator never switches them off. Leaving a gate shut when it should be open puts a step in μ(E) at that element&apos;s edge.</p>
        <div className="ath-fields">{(['channel_lo','channel_hi'] as const).map(name=>field(name,1,'Automatic'))}{(['roi_lo','roi_hi'] as const).map(name=>field(name,1,'Automatic'))}</div>
        <p className="ath-hint">Leave a window empty and it is derived through the calibration below: the fit window from 1.2 keV under the target line to 0.5 keV over the top incident energy, the comparison window as the target line ± 1.2 detector widths — the fixed region a conventional analysis would sum. It is plotted beside the fit, never instead of it. End channels are exclusive.</p>
        <label className="ath-field"><span>Spectral model <SectionHelp label="Spectral model">Choose the fluorescence line and detector-response model. Differences between engines show sensitivity to the model, rather than an uncertainty bound.</SectionHelp></span><select value={engine} onChange={e=>setEngine(e.target.value)}>
          {(inspection.engines??['larch']).map(name=><option key={name} value={name}>{engines[name]??name}</option>)}</select></label>
        {(inspection.engines??['larch']).includes('mapstorch')&&<p className="ath-hint">Both engines fit the same line families at the same gates, with the same continuum and the same amplitude solve. MapsTorch is an alternative spectral model: its line tables, detector response and escape treatment differ from Larch&apos;s, so a disagreement between the two measures how sensitive the result is to the spectral model — it does not bound the error of either. MapsTorch models no detector escape peaks; it says so above the quality checks when the fit window could hold one.</p>}
        <details><summary>Detector model and calibration</summary><div className="ath-fields">
          <label className="ath-field"><span>Detector crystal <SectionHelp label="Detector crystal">Choose the detector material, Ge or Si, used by the response model. Use the material of the fluorescence detector, not the sample.</SectionHelp></span><select value={material} onChange={e=>setMaterial(e.target.value)}><option value="Ge">Ge</option><option value="Si">Si</option></select></label>
          <label className="ath-field"><span>Crystal thickness (mm) <SectionHelp label="Crystal thickness (mm)">Set the detector crystal’s active thickness for Larch’s detector response. This control is unavailable for the MapsTorch model.</SectionHelp></span><input type="number" step="any" disabled={mapstorch} value={form.thickness} onChange={e=>edit('thickness',e.target.value)} /></label>
          <label className="ath-field"><span>Energy offset (keV) <SectionHelp label="Energy offset (keV)">Initial intercept for detected energy = offset + slope × channel. Calibration refines it; the starting value also places automatic channel windows.</SectionHelp></span><input type="number" step="any" value={form.cal_offset} onChange={e=>edit('cal_offset',e.target.value)} /></label>
          <label className="ath-field"><span>Energy per channel (keV) <SectionHelp label="Energy per channel (keV)">Initial detector gain in keV per channel; 0.01 means 10 eV per channel. Calibration refines it. Set a realistic value before relying on automatic windows.</SectionHelp></span><input type="number" step="any" value={form.cal_slope} onChange={e=>edit('cal_slope',e.target.value)} /></label>
          <label className="ath-field"><span>Compton scattering angle (°) <SectionHelp label="Compton scattering angle (°)">Starting angle used to locate the Compton scattering contribution. It is refined during detector calibration along with line-shape parameters.</SectionHelp></span><input type="number" step="any" value={form.compton_angle} onChange={e=>edit('compton_angle',e.target.value)} /></label>
          <label className="ath-field"><span>Scatter tail length (peak widths) <SectionHelp label="Scatter tail length (peak widths)">Set the fixed low-energy scatter-tail length relative to peak width. This is held during calibration; use the residual and pre-edge quality checks to judge changes.</SectionHelp></span><input type="number" step="any" min={0} max={20} disabled={mapstorch} value={form.scatter_beta} onChange={e=>edit('scatter_beta',e.target.value)} /></label>
          <label className="ath-field"><span>Calibration scan points <SectionHelp label="Calibration scan points">Number of representative scan points used to calibrate each detector element. More points provide more spectral evidence but cost more computation.</SectionHelp></span><input type="number" step={1} min={2} max={32} value={form.calibration_points} onChange={e=>edit('calibration_points',e.target.value)} /></label>
          <label className="ath-field"><span>Continuum background <SectionHelp label="Continuum background">Fit a smooth continuum together with fluorescence lines, or omit it when justified. The continuum is not subtracted from counts before the line fit.</SectionHelp></span><select value={background} onChange={e=>setBackground(e.target.value)}><option value="smooth">Fitted with the lines</option><option value="none">None</option></select></label>
          <label className="ath-field"><span>Preview point stride <SectionHelp label="Preview point stride">Draw every nth scan point in the extracted-XAS preview. All scan points are still fitted and saved when you make a group.</SectionHelp></span><input type="number" step={1} min={1} max={64} value={form.point_stride} onChange={e=>edit('point_stride',e.target.value)} /></label>
        </div><p className="ath-hint">Offset, slope and angle are starting values only: the calibration fits them, with the peak widths and tails, on the calibration points. They also place the automatic windows, so a file whose detector is far from 10 eV per channel needs its own calibration typed here first. The scatter tail length is the exception — it is held where you set it, because fitting it lets the scatter peaks and the scattering angle trade against each other. Raise it above its default of 0.5 if the pre-edge baseline below is outside its limits and the model falls away faster than the data on the low side of the elastic peak. The continuum is fitted alongside the lines as a set of smooth falling shapes, never subtracted first, so the counts keep the noise the fit assumes they have.{mapstorch?' Under MapsTorch the crystal thickness and the scatter tail length do not enter the model, and the crystal only decides whether the missing escape peaks are mentioned.':''}</p></details>
        <details><summary>Normalization</summary><div className="ath-fields">{field('e0','any','Auto')}{(['pre1','pre2','norm1','norm2'] as const).map(name=>field(name,'any'))}{field('nnorm',1)}</div></details>
        <div className="ath-fields">
          <label className="ath-field"><span>Spectrum at scan point <SectionHelp label="Spectrum at scan point">Choose a zero-based scan index for the detailed measured/model spectrum. Leave blank to use an automatic point above the edge.</SectionHelp></span><input type="number" step={1} min={0} max={Math.max(0,inspection.points-1)} placeholder="Automatic: past the edge" value={form.preview_point} onChange={e=>edit('preview_point',e.target.value)} /></label>
          <label className="ath-field"><span>Spectrum from detector element <SectionHelp label="Spectrum from detector element">Choose the zero-based detector-element index for the detailed spectral fit. Element 0 is the first detector element.</SectionHelp></span><input type="number" step={1} min={0} max={Math.max(0,count-1)} value={form.preview_detector} onChange={e=>edit('preview_detector',e.target.value)} /></label>
        </div>
        <div className={styles.actions}>
          <button disabled={!valid} onClick={()=>{void refit()}}>Fit preview</button>
          <button className="ath-primary" disabled={!current} onClick={()=>{void make()}}>Make fluorescence XAS group</button>
        </div>
        <label className="ath-check"><input type="checkbox" checked={withWindow} onChange={e=>setWithWindow(e.target.checked)} />Also export the plain window sum for comparison <SectionHelp label="Also export the plain window sum for comparison">Create a separate group from counts summed in the comparison window using the same detector elements and I₀ correction. Compare it with the fitted extraction to assess line overlap.</SectionHelp></label>
        <p className="ath-hint">Every scan point is fitted; the preview displays {value('point_stride')>1?`one in ${value('point_stride')}`:'every point'}. Make group reuses matching detector fits from the preview and saves every point. Changed fitting settings, a changed scan, cache eviction or a server restart require a new fit.</p>
        <details><summary>Scan file</summary><AthenaDownloadButton path={`/projects/${project.id}/uploads/${inspection.upload_id}/file`}>Download original scan file</AthenaDownloadButton></details>
      </>}
    </fieldset>
    <section className={styles.previews}>
      {/* Beside the plots, so the curves are never shown without it. */}
      {unconverged&&<p className="ath-warning" aria-label="Calibration warning"><strong>Calibration did not converge for {reports.length-converged} of {reports.length} detector element{reports.length===1?'':'s'}</strong>: these curves are a demonstration, not a measurement. See Quality below.</p>}
      <h3>Detector spectrum{spectrum?` at ${spectrum.incident_ev.toFixed(1)} eV incident, element ${spectrum.detector+1}`:''}</h3>
      <div className={styles.display} aria-label="Spectrum display">
        <label className="ath-check"><input type="checkbox" checked={showComponents} onChange={e=>setShowComponents(e.target.checked)} />Fitted components <SectionHelp label="Fitted components">Show individual model contributions beside the total fitted spectrum and measured counts. This is a display change only.</SectionHelp></label>
        <label className="ath-check"><input type="checkbox" checked={logCounts} onChange={e=>setLogCounts(e.target.checked)} />Logarithmic counts <SectionHelp label="Logarithmic counts">Use a logarithmic count axis to inspect weak lines and tails. Nonpositive values cannot be shown on a logarithmic axis.</SectionHelp></label>
      </div>
      <Figure label="XRF spectrum preview" traces={counts} xlabel="Detected energy (keV)" ylabel="Counts" revision={`${revision}:spectrum`} log={logCounts}
        range={logCounts&&spectrum?countRange(spectrum.measured,spectrum.total):undefined} />
      {spectrum&&logCounts&&<p className="ath-hint">The count axis starts at half the smallest measured count; fitted components fall below it in their tails.</p>}
      <h3>Fitted extraction and window sum</h3>
      <div className={styles.display} aria-label="Extraction display">
        <label className="ath-check"><input type="checkbox" checked={normalized} onChange={e=>setNormalized(e.target.checked)} />Normalized <SectionHelp label="Normalized">Compare the fitted and window-sum curves after normalization. Turn off to inspect their fluorescence yields and detector contributions.</SectionHelp></label>
        <label className="ath-check"><input type="checkbox" disabled={normalized} checked={showDetectors} onChange={e=>setShowDetectors(e.target.checked)} />Each detector element (contributions) <SectionHelp label="Each detector element (contributions)">Overlay each detector element’s contribution to the extracted yield. Available with Normalized off; useful for spotting an inconsistent element.</SectionHelp></label>
      </div>
      <div className={styles.pair}>
        <div><h4>Fitted extraction</h4>
          <Figure label="Fluorescence XAS preview" traces={fitTraces} xlabel="Incident energy (eV)" ylabel={yieldLabel} revision={`${revision}:xas`}
            range={fitRange} shapes={marks(current?.quality.fit.e0)} annotations={notes(current?.quality.fit.e0)} /></div>
        <div><h4>Window sum</h4>
          <Figure label="Window sum preview" traces={windowTraces} xlabel="Incident energy (eV)" ylabel={yieldLabel} revision={`${revision}:roi`}
            range={windowRange} shapes={marks(current?.quality.roi.e0)} annotations={notes(current?.quality.roi.e0)} /></div>
      </div>
      {current?.metadata.mu_units==='edge_step'&&<p className="ath-hint">Both yields are divided by their own full-scan edge step before export. This changes units only: the pre-edge baseline is not subtracted, and negative values are preserved. The raw yield edge steps below are saved with the groups so the original scale remains recoverable.</p>}
      <p className="ath-hint">Each curve is a fluorescence yield, which stands in for μ(E) only while the emitted intensity stays proportional to absorption — a thin or dilute sample, a steady detector response, and the same exposure at every point. In a thick or concentrated sample self-absorption flattens the edge and damps the oscillations, and the curve wants Larch&apos;s self-absorption correction before anyone reads an amplitude off it.</p>
      <p className="ath-hint">A spectral fit is not automatically better than a well-placed window sum. Compare both, inspect the residuals and pre-edge baseline, and use an independent reference where available; passing the diagnostics does not establish EXAFS accuracy.</p>
      {current?.metadata.engine==='larch'&&<p className="ath-hint">Matrix K-beta/K-alpha ratios use tabulated atomic branching with detector attenuation. Differential sample absorption can invalidate this prior; the spectral fit does not estimate that correction.</p>}
      {current&&<div className={styles.quality} aria-label="Extraction quality">
        <h3>Quality</h3>
        {/* The failure leads, ahead of the checks that pass. */}
        {unconverged&&<p role="alert" className="ath-warning"><strong>Detector calibration did not converge for {reports.length-converged} of {reports.length} element{reports.length===1?'':'s'}</strong>{resting>0?`; ${resting} rest on a limit`:''}. The extraction above rests on that calibration: treat it as a demonstration, not a measurement, until it converges. Details below.</p>}
        {/* What the chosen engine does not model, in its own words. The Larch
            engine sends none; reading a blank list as "nothing to say" is the
            point, so nothing is written here when it is empty. */}
        {current.metadata.engine_notes?.map((note,i)=><p key={i} role="note" className="ath-hint">{note}</p>)}
        <div className={styles.pair}>
          <div>{qualityLines('fit',current.quality.fit)}</div>
          <div>{qualityLines('roi',current.quality.roi)}</div>
        </div>
        <p><strong>Detector agreement</strong> · {current.quality.detector_agreement
          ? <>{current.quality.detector_agreement.detectors} elements, worst pairwise RMS between normalized curves {current.quality.detector_agreement.worst_pairwise_rms.toPrecision(3)} (limit {current.quality.limits.detector_shape_rms}) — {verdict(current.quality.detector_agreement.checks.shape_agreement,['Within limit','Outside limit'])}{' '}(edge-step spread {percent(current.quality.detector_agreement.edge_step_spread)}, reported only: elements differ in solid angle by design)</>
          : <>a single usable element, nothing to compare</>}
          {edgeless.length>0&&<> · element{edgeless.length===1?'':'s'} {edgeless.map(i=>i+1).join(', ')} gave no upward edge on {edgeless.length===1?'its':'their'} own and {edgeless.length===1?'is':'are'} left out of this comparison only — still in the summed signal; untick {edgeless.length===1?'it':'them'} above to leave {edgeless.length===1?'it':'them'} out of the extraction</>}</p>
        <p className="ath-hint">These are diagnostics, not proof of a correct extraction. Below the edge the target&apos;s own edge contributes nothing, so the extracted signal should sit flat and near zero there: its mean, its drift carried across the whole scan by normalization (limit {percent(current.quality.limits.pre_edge_drift_over_scan??0.05)}) and its scatter (limit {percent(current.quality.limits.pre_edge_rms)}, mean {percent(current.quality.limits.pre_edge_mean)}) are judged as fractions of the edge step. Within limits is necessary, not sufficient: a bias shared above and below the edge passes it, and a real pre-edge pedestal from beam harmonics fails it. Above the edge a fluorescence yield cannot be negative. Detector elements see different solid angles, so what has to agree is the shape after normalization, to within {current.quality.limits.detector_shape_rms.toPrecision(2)} RMS; a bias shared by every element shows in neither check.</p>
        <p className="ath-hint">Showing {current.metadata.points} of {inspection?.points} scan points over {current.metadata.detectors} detector elements{meta?.excluded_elements?.length?` (left out: ${meta.excluded_elements.map(i=>i+1).join(', ')})`:''} with the {engines[current.metadata.engine]??current.metadata.engine}; reduced χ² {current.spectrum.redchi.toPrecision(3)} at the previewed point.
          {meta?.channel_range&&<> Fit window channels {meta.channel_range[0]}–{meta.channel_range[1]}{automatic.has('channel_range')?' (automatic)':''}, comparison window {meta.roi_range?.[0]}–{meta.roi_range?.[1]}{automatic.has('roi_range')?` (automatic, around the ${meta.windows?.line_kev?.toFixed(3)} keV line)`:''}{automatic.has('preview_point')?`, spectrum at scan point ${current.metadata.request?.preview_point} (automatic, past the ${meta.windows?.edge} edge)`:''}.</>}</p>
        {meta?.notes?.map((note,i)=><p key={i} className="ath-hint">{note}</p>)}
        {calibration}
      </div>}
      {stale&&<p role="status">Settings changed since the last fit. Fit a preview again.</p>}
      {(failure||problem)&&<p role="alert" className="ath-error">{failure||problem}</p>}
    </section>
  </div>{error&&<p role="alert" className="ath-error">{error}</p>}{notice&&<p role="status">{notice}</p>}</div>
}
