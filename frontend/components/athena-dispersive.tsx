"use client"

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import { apiBase, athenaApi, isDifferenceGroup, type AthenaProject } from '@/lib/athena'
import type { InspectionResponse } from '@/lib/contracts'
import styles from './athena-dispersive.module.css'

const Plot=dynamic(()=>import('react-plotly.js').then(m=>m.default),{ssr:false})
type Coefficients={offset:number;linear:number;quadratic:number}
type Columns={pixel_column:string;numerator:string[];denominator:string[];logarithm:boolean;invert:boolean;reverse_signal:boolean;sort:boolean}
type Defaults={version:number;coefficients:Coefficients|null}
type Trace={x:number[];y:number[];label:string}
type Result={version:number;upload_id:string;coefficients:Coefficients;pixel:Trace;calibrated?:Trace;normalized?:Trace;standard?:Trace;plot_range?:number[];warnings:string[];details?:{sum_squares?:number;initial_sum_squares?:number;evaluations?:number;scale?:number;warnings:string[]}}
const coefficientKeys=['offset','linear','quadratic'] as const
const emptyColumns:Columns={pixel_column:'',numerator:[],denominator:[],logarithm:false,invert:false,reverse_signal:false,sort:false}

function Figure({label,traces,xlabel,range}: {label:string;traces:Trace[];xlabel:string;range?:number[]}) {
  return <div className={styles.plot} aria-label={label}>{traces.length ? <Plot
    data={traces.map((t,i)=>({x:t.x,y:t.y,name:t.label,type:'scatter',mode:'lines',line:{color:i?'#b76d37':'#16736b',width:1.6}}))}
    layout={{autosize:true,margin:{l:60,r:15,t:20,b:90},xaxis:{title:{text:xlabel},range},yaxis:{title:{text:'Signal'}},
      font:{size:11},legend:{orientation:'h',y:-.3},uirevision:label}}
    config={{responsive:true,displaylogo:false,toImageButtonOptions:{format:'svg',filename:'athena-dispersive'}}}
    style={{width:'100%',height:'100%'}} useResizeHandler /> : <p>Choose a file and review its detector columns.</p>}</div>
}

export function AthenaDispersive({project,activeId,onSaved,setBusy}: {
  project:AthenaProject;activeId:string;onSaved:(project:AthenaProject)=>void;setBusy:(label:string)=>void
}) {
  const candidates=project.groups.filter(g=>!['chi','detector'].includes(g.data_type)&&!isDifferenceGroup(g))
  const [standard,setStandard]=useState(candidates.find(g=>g.id===activeId)?.id??candidates[0]?.id??'')
  const [inspection,setInspection]=useState<InspectionResponse|null>(null)
  const [columns,setColumns]=useState<Columns>(emptyColumns)
  const [coefficients,setCoefficients]=useState({offset:'0',linear:'0.4',quadratic:'0'})
  const [hasCalibration,setHasCalibration]=useState(false)
  const [normalization,setNormalization]=useState({pre1:'',pre2:'',norm1:'',norm2:'1000',nnorm:'2'})
  const [nsmooth,setNsmooth]=useState('4')
  const [defaults,setDefaults]=useState<Defaults|null>(null)
  const [pending,setPending]=useState(false),lock=useRef(false)
  const [error,setError]=useState(''),[notice,setNotice]=useState('')
  const [raw,setRaw]=useState<{key:string;value?:Result;error?:string}|null>(null)
  const [preview,setPreview]=useState<{key:string;value?:Result;error?:string}|null>(null)
  const [fit,setFit]=useState<{key:string;details:Result['details']}|null>(null)
  const [retry,setRetry]=useState(0)
  const values=Object.fromEntries(coefficientKeys.map(k=>[k,Number(coefficients[k])])) as Coefficients
  const valid=coefficientKeys.every(k=>coefficients[k].trim()!==''&&Number.isFinite(values[k]))
    && Object.values(normalization).every(v=>v===''||Number.isFinite(Number(v)))
    && normalization.nnorm.trim()!==''&&Number.isInteger(Number(normalization.nnorm))&&Number(normalization.nnorm)>=0&&Number(normalization.nnorm)<=3
    && nsmooth.trim()!==''&&Number.isInteger(Number(nsmooth))&&Number(nsmooth)>=0&&Number(nsmooth)<=10
  const normalizationValues=Object.fromEntries(Object.entries(normalization).map(([k,v])=>[k,v===''?null:Number(v)]))
  const body={version:project.version,upload_id:inspection?.upload_id??'',standard_id:standard||null,columns,
    coefficients:values,normalization:normalizationValues,nsmooth:Number(nsmooth)}
  const key=JSON.stringify([project.id,body])
  const rawBody={...body,standard_id:null,coefficients:{offset:0,linear:.4,quadratic:0},normalization:{},nsmooth:4}
  const rawKey=JSON.stringify([project.id,rawBody])
  const current=preview?.key===key&&valid ? preview.value : undefined
  const pixel=raw?.key===rawKey ? raw.value : undefined
  const problem=(raw?.key===rawKey?raw.error:'')||(preview?.key===key?preview.error:'')||(!valid?'Enter finite coefficients and valid normalization values.':'')

  useEffect(()=>{let live=true;void athenaApi<Defaults>('/preferences/dispersive').then(v=>{if(live)setDefaults(v)}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[])
  useEffect(()=>{
    if(!inspection||pending)return
    let live=true;const controller=new AbortController()
    const timer=setTimeout(()=>{void athenaApi<Result>(`/projects/${project.id}/dispersive/columns`,rawBody,'POST',controller.signal)
      .then(value=>{if(live)setRaw({key:rawKey,value})}).catch(e=>{if(live)setRaw({key:rawKey,error:e.message})})},180)
    return()=>{live=false;controller.abort();clearTimeout(timer)}
    // rawKey contains the complete column-selection request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[rawKey,pending,retry])
  useEffect(()=>{
    if(!inspection||!valid||!hasCalibration||pending)return
    let live=true;const controller=new AbortController()
    const timer=setTimeout(()=>{void athenaApi<Result>(`/projects/${project.id}/dispersive/preview`,body,'POST',controller.signal)
      .then(value=>{if(live)setPreview({key,value})}).catch(e=>{if(live)setPreview({key,error:e.message})})},180)
    return()=>{live=false;controller.abort();clearTimeout(timer)}
    // key contains all calibration, standard, normalization and revision state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,hasCalibration,pending,retry])
  async function task(label:string,work:()=>Promise<void>) {
    if(lock.current)return
    lock.current=true;setPending(true);setBusy(label);setError('');setNotice('')
    try{await work()}catch(e){setError(e instanceof Error?e.message:'Dispersive calibration failed.')}
    finally{lock.current=false;setPending(false);setBusy('')}
  }
  function adopt(c:Coefficients){setCoefficients({offset:String(c.offset),linear:String(c.linear),quadratic:String(c.quadratic)});setHasCalibration(true)}
  async function inspect(file:File) {
    setInspection(null);setRaw(null);setPreview(null);setFit(null)
    await task('Reading pixel columns',async()=>{
      const data=new FormData();data.append('file',file)
      const i=await athenaApi<InspectionResponse>(`/projects/${project.id}/dispersive/inspect`,data)
      setInspection(i);setColumns({...emptyColumns,pixel_column:i.columns[0]?.column_id??'',numerator:i.columns[1]?[i.columns[1].column_id]:[]})
    })
  }
  async function calibrate(action:'guess'|'refine',reset=false) {
    await task(action==='guess'?'Estimating calibration':'Refining calibration',async()=>{
      const request=reset?{...body,coefficients:{offset:0,linear:.4,quadratic:0}}:body
      const result=await athenaApi<Result>(`/projects/${project.id}/dispersive/${action}`,request)
      if(result.version!==project.version||result.upload_id!==inspection?.upload_id)throw new Error('Calibration response no longer matches this input. Preview again.')
      adopt(result.coefficients)
      const nextKey=JSON.stringify([project.id,{...body,coefficients:result.coefficients}])
      setPreview({key:nextKey,value:result});setFit({key:nextKey,details:result.details})
      await persist(result.coefficients)
      setNotice('Calibration plotted and saved for future pixel/stripe imports.')
    })
  }
  async function load(){await task('Loading calibration',async()=>{
    const v=await athenaApi<Defaults>('/preferences/dispersive');setDefaults(v)
    if(!v.coefficients)throw new Error('No calibration has been saved. Estimate coefficients from standards or import athena.dxas.')
    adopt(v.coefficients);setNotice('Loaded saved calibration.')
  })}
  async function persist(c:Coefficients){
    if(!defaults)throw new Error('Load calibration settings before saving.')
    setDefaults(await athenaApi<Defaults>('/preferences/dispersive',{version:defaults.version,coefficients:c},'PUT'))
  }
  async function save(){await task('Saving calibration',async()=>{
    await persist(values)
    setNotice('Calibration saved for future pixel/stripe imports. Reinspect any already-open source to use these coefficients.')
  })}
  async function replot(){await task('Replotting calibration',async()=>{
    const value=await athenaApi<Result>(`/projects/${project.id}/dispersive/preview`,body)
    setPreview({key,value});setRetry(n=>n+1)
    await persist(values)
    setNotice('Calibration plotted and saved for future pixel/stripe imports.')
  })}
  async function importCalibration(file:File){await task('Importing athena.dxas',async()=>{
    if(!defaults)throw new Error('Load calibration settings before importing.')
    const data=new FormData();data.append('file',file)
    const value=await athenaApi<Defaults>(`/preferences/dispersive/import?version=${defaults.version}`,data)
    setDefaults(value);adopt(value.coefficients!);setNotice('Imported and saved athena.dxas calibration.')
  })}
  function select(id:string,field:'numerator'|'denominator',checked:boolean){setColumns(c=>({...c,[field]:checked?[...c[field],id]:c[field].filter(v=>v!==id)}))}
  const fitted=fit?.key===key?fit.details:undefined
  return <div className="ath-modal-body"><div className={styles.layout}>
    <fieldset disabled={pending} className={styles.controls}>
      <label className="ath-field"><span>Conventional calibration standard</span><select value={standard} onChange={e=>setStandard(e.target.value)}><option value="">Manual calibration without a standard</option>{candidates.map(g=><option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
      <p className="ath-hint">Choose a conventional scan of the same standard measured with the pixel detector. Saved processing settings are used.</p>
      <label className="ath-field"><span>Import pixel standard</span><input type="file" aria-label="Choose pixel standard file" onChange={e=>{const f=e.target.files?.[0];if(f)void inspect(f)}} /></label>
      {inspection&&<><h3>{inspection.display_name} · {inspection.row_count} pixels</h3>
        <label className="ath-field"><span>Pixel column</span><select value={columns.pixel_column} onChange={e=>setColumns(c=>({...c,pixel_column:e.target.value}))}>{inspection.columns.map(c=><option key={c.column_id} value={c.column_id}>{c.index+1}. {c.name}</option>)}</select></label>
        <div className={styles.table}><table><thead><tr><th>Numerator</th><th>Denominator</th><th>Column</th></tr></thead><tbody>{inspection.columns.map(c=><tr key={c.column_id}><td><input type="checkbox" aria-label={`Pixel numerator ${c.name}`} checked={columns.numerator.includes(c.column_id)} onChange={e=>select(c.column_id,'numerator',e.target.checked)} /></td><td><input type="checkbox" aria-label={`Pixel denominator ${c.name}`} checked={columns.denominator.includes(c.column_id)} onChange={e=>select(c.column_id,'denominator',e.target.checked)} /></td><td>{c.index+1}. {c.name}</td></tr>)}</tbody></table></div>
        <p className="ath-hint">Selected columns are summed; no selected column means constant 1. For SLRI I₀/Iₜ select both channels and Natural log. Already-computed μ(pixel) uses one numerator and no denominator or log.</p>
        {(['logarithm','invert','reverse_signal','sort'] as const).map((field,i)=><label className="ath-check" key={field}><input type="checkbox" checked={columns[field]} onChange={e=>setColumns(c=>({...c,[field]:e.target.checked}))} />{['Natural log of absolute ratio','Invert pixel signal','Reverse signal order (high energy at first pixel)','Sort rows by pixel'][i]}</label>)}
        <details><summary>Pixel normalization for initial guess</summary><div className="ath-fields">{Object.entries(normalization).map(([field,value])=><label className="ath-field" key={field}><span>{({pre1:'Pixel pre-edge start',pre2:'Pixel pre-edge end',norm1:'Pixel post-edge start',norm2:'Pixel post-edge end',nnorm:'Pixel polynomial degree'} as Record<string,string>)[field]}</span><input type="number" value={value} placeholder="Auto" onChange={e=>setNormalization(n=>({...n,[field]:e.target.value}))} /></label>)}</div></details>
      </>}
      <h3>E = offset + linear × pixel + quadratic × pixel²</h3>
      <div className="ath-fields">{coefficientKeys.map(field=><label className="ath-field" key={field}><span>{field[0].toUpperCase()+field.slice(1)} coefficient</span><input type="number" step="any" value={coefficients[field]} onChange={e=>{setCoefficients(c=>({...c,[field]:e.target.value}));setHasCalibration(true)}} /></label>)}</div>
      <label className="ath-field"><span>Derivative smoothing passes</span><input type="number" min={0} max={10} step={1} value={nsmooth} onChange={e=>setNsmooth(e.target.value)} /></label>
      <div className={styles.actions}>
        <button disabled={!inspection||!standard||!valid||!pixel||!defaults} onClick={()=>{void calibrate('guess')}}>Estimate initial coefficients</button>
        <button disabled={!inspection||!standard||!valid||!pixel||!defaults} onClick={()=>{void calibrate('guess',true)}}>Reset parameters</button>
        <button disabled={!current||!standard||!valid||!defaults} onClick={()=>{void calibrate('refine')}}>Refine calibration parameters</button>
        <button disabled={!inspection||!valid||!hasCalibration||!defaults} onClick={()=>{void replot()}}>Replot calibration data</button>
        <button className="ath-primary" disabled={!current||!valid} onClick={()=>{void task('Making calibrated data group',async()=>{const next=await athenaApi<AthenaProject>(`/projects/${project.id}/dispersive/make`,body);onSaved(next);setNotice('Created a calibrated data group. The original pixel source is retained.')})}}>Make calibrated data group</button>
      </div>
      <div className={styles.actions}><button onClick={()=>{void load()}}>Load saved calibration</button><button disabled={!hasCalibration||!valid||!defaults} onClick={()=>{void save()}}>Save calibration</button></div>
      <label className="ath-field"><span>Import athena.dxas calibration</span><input type="file" disabled={!defaults} aria-label="Import athena.dxas calibration" onChange={e=>{const f=e.target.files?.[0];if(f)void importCalibration(f)}} /></label>
      {defaults?.coefficients&&<a href={`${apiBase}/preferences/dispersive/file`} download>Export saved athena.dxas</a>}
      <p className="ath-hint">Estimate, Reset, Refine and Replot save the plotted calibration for the SLRIBL4 pixel/stripe reader, as in Athena. Live previews while editing do not save it. Make calibrated data group inserts a new μ(E) group after the selected standard; Undo removes the group and keeps the saved calibration.</p>
    </fieldset>
    <section className={styles.previews}>
      <h3>Selected pixel signal</h3><Figure label="Pixel column preview" traces={pixel?[pixel.pixel]:[]} xlabel="Pixel" />
      <h3>Calibration and conventional standard</h3><Figure label="Dispersive calibration preview" traces={current?[current.normalized??current.calibrated!,...(current.standard?[current.standard]:[])].filter(Boolean):[]} xlabel="Energy (eV)" range={current?.plot_range} />
      {!hasCalibration&&<p>Review the pixel curve, then estimate coefficients or load a saved calibration.</p>}
      {fitted?.sum_squares!==undefined&&<p role="status">Derivative fit sum of squares: {fitted.initial_sum_squares?.toPrecision(5)} → {fitted.sum_squares.toPrecision(5)} · {fitted.evaluations} evaluations · scale {fitted.scale?.toPrecision(5)}</p>}
      {[...(pixel?.warnings??[]),...(current?.warnings??[]),...(fitted?.warnings??[])].map((w,i)=><p key={i} className="ath-warning">{w}</p>)}
      {problem&&<p role="alert" className="ath-error">{problem}</p>}
      {inspection&&<details><summary>Pixel source file</summary><pre>{inspection.source_preview}</pre><a href={`${apiBase}/projects/${project.id}/uploads/${inspection.upload_id}/file`} download>Download original pixel file</a></details>}
    </section>
  </div>{error&&<p role="alert" className="ath-error">{error}</p>}{notice&&<p role="status">{notice}</p>}</div>
}
