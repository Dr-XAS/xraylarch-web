'use client'

import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import styles from './athena-difference.module.css'
import controls from './athena-smoothing.module.css'

const Plot=dynamic(()=>import('react-plotly.js').then(m=>m.default),{ssr:false})
type Settings={weightby:'importance'|'step'|'noise';exclude_short_data:boolean;short_data_margin:number;plot:'stddev'|'variance'|'marked';push_metadata:boolean;merge_references:boolean}
type Options=Settings&{method:'demeter-larch';array:'mu'|'norm'|'chi';weights:Record<string,number>;reference_weights:Record<string,number>;label?:string}
type Curve={name:string;x:number[];y:number[]}
type Result={x:number[];y:number[];stddev:number[];members:{group_id:string;label:string;points:number;weight:number;coefficient:number;extrapolated_points:number}[];
  excluded:{group_id:string;label:string;reason:string;points:number}[];warnings:string[];details:{count:number};components:{group_id:string;label:string;y:number[]}[]}
export type MergePreview={project_id:string;version:number;group_ids:string[];options:Options;requested_options:Options;notes:string[];
  outputs:{role:'sample'|'reference';label:string;data_type:'mu'|'chi';parameters:AthenaProject['groups'][number]['parameters'];result:Result;curves:Curve[];plots:Record<Settings['plot'],Curve[]>;processing_error:string|null}[]}
export type MergeDraft={array:Options['array'];weightby:Settings['weightby'];exclude_short_data:boolean;short_data_margin:string;plot:Settings['plot'];push_metadata:boolean;merge_references:boolean;weights:Record<string,string>;reference_weights:Record<string,string>;label:string}
const factory:Settings={weightby:'importance',exclude_short_data:true,short_data_margin:10,plot:'stddev',push_metadata:true,merge_references:true}
const finite=(a:unknown):a is number[]=>Array.isArray(a)&&a.every(x=>typeof x==='number'&&Number.isFinite(x))
function validate(v:MergePreview,p:AthenaProject,ids:string[],options:Options){
  const invalid=()=>{throw new Error('The merge preview does not match this project and these settings. Replot the merge.')}
  if(v.project_id!==p.id||v.version!==p.version||JSON.stringify(v.group_ids)!==JSON.stringify(ids)||JSON.stringify(v.requested_options)!==JSON.stringify(options)
    ||!Array.isArray(v.outputs)||v.outputs.length<1||v.outputs.length>2||v.outputs[0].role!=='sample')invalid()
  for(const o of v.outputs){
    const r=o.result
    if(!r||!finite(r.x)||r.x.length<8||!finite(r.y)||!finite(r.stddev)||r.x.length!==r.y.length||r.x.length!==r.stddev.length||r.stddev.some(x=>x<0)
      ||r.x.some((x,i)=>i>0&&x<=r.x[i-1])||!Array.isArray(r.members)||r.members.length<2||r.members.length!==r.details.count
      ||new Set(r.members.map(m=>m.group_id)).size!==r.members.length||Math.abs(r.members.reduce((s,m)=>s+m.coefficient,0)-1)>1e-10)invalid()
    for(const m of r.members)if(!p.groups.some(g=>g.id===m.group_id)||!Number.isFinite(m.weight)||m.weight<0||!Number.isFinite(m.coefficient)||m.coefficient<0)invalid()
    for(const view of ['stddev','variance','marked'] as const){
      const curves=o.plots?.[view];if(!Array.isArray(curves)||!curves.length)invalid()
      for(const c of curves)if(!finite(c.x)||!finite(c.y)||c.x.length!==r.x.length||c.y.length!==r.x.length||c.x.some((x,i)=>x!==r.x[i]))invalid()
    }
    const contributors=new Set(r.members.map(m=>m.group_id))
    if(o.role==='sample'){
      if(r.members.some(m=>!ids.includes(m.group_id))||ids.some(id=>!contributors.has(id)&&!r.excluded.some(e=>e.group_id===id)))invalid()
    }else{
      const refs=new Set(v.outputs[0].result.members.map(m=>p.groups.find(g=>g.id===m.group_id)?.reference_id))
      if(options.array==='chi'||!options.merge_references||refs.has(null)||refs.has(undefined)||r.members.some(m=>!refs.has(m.group_id)))invalid()
    }
  }
}

export function AthenaMerge({project,initialDraft,rememberDraft,initialArray,disabled=false,setBusy,saved,close}:{project:AthenaProject;initialDraft?:MergeDraft;rememberDraft:(d:MergeDraft)=>void;initialArray?:Options['array'];disabled?:boolean;setBusy:(s:string)=>void;saved:(p:AthenaProject,id:string)=>void;close:()=>void}){
  const marked=project.groups.filter(g=>g.marked),ids=marked.map(g=>g.id)
  const refs=project.groups.filter(g=>marked.some(m=>m.reference_id===g.id))
  const [draft,setDraft]=useState<MergeDraft>(()=>({...factory,array:'mu',short_data_margin:'10',weights:{},reference_weights:{},label:'',...initialDraft,...(initialArray?{array:initialArray}:{})}))
  const [prefs,setPrefs]=useState<{version:number;values:Settings}|null>(null),[ready,setReady]=useState(false),[prefNotice,setPrefNotice]=useState('')
  const [preview,setPreview]=useState<{key:string;value:MergePreview}|null>(null),[completed,setCompleted]=useState<MergePreview|null>(null),[role,setRole]=useState('sample')
  const [error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0)
  const alive=useRef(true),generation=useRef(0),saving=useRef(false),manual=useRef(false)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[])
  useEffect(()=>{if(ready)rememberDraft(draft)},[ready,draft,rememberDraft])
  async function loadDefaults(force=false){
    setPrefNotice('');setError('')
    try{
      const value=await athenaApi<{version:number;values:Settings}>('/preferences/merge')
      if(!alive.current)return
      if(!Number.isInteger(value.version)||!value.values||!['importance','step','noise'].includes(value.values.weightby)||!['stddev','variance','marked'].includes(value.values.plot)||!Number.isInteger(value.values.short_data_margin))throw new Error('Invalid saved merge preferences.')
      setPrefs(value)
      if(force||(!manual.current&&!initialDraft))setDraft(d=>({...d,...value.values,short_data_margin:String(value.values.short_data_margin)}))
      setReady(true)
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not load merge preferences.')}
  }
  useEffect(()=>{void loadDefaults()},[]) // eslint-disable-line react-hooks/exhaustive-deps
  const value=(id:string,isRef=false)=>{const g=project.groups.find(g=>g.id===id),native=g?.source.native as {args?:{importance?:unknown}}|undefined;return (isRef?draft.reference_weights:draft.weights)[id]??String(g?.source.importance??native?.args?.importance??1)}
  const weights=Object.fromEntries(ids.map(id=>[id,Number(value(id))])),referenceWeights=Object.fromEntries(refs.map(g=>[g.id,Number(value(g.id,true))]))
  const valid=ids.length>=2&&draft.short_data_margin.trim()!==''&&Number.isInteger(Number(draft.short_data_margin))&&Number(draft.short_data_margin)>=0&&Number(draft.short_data_margin)<=250000
    &&(draft.weightby!=='importance'||[...ids.map(id=>value(id)),...refs.map(g=>value(g.id,true))].every(v=>v.trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0))
  const options:Options={method:'demeter-larch',array:draft.array,weightby:draft.weightby,exclude_short_data:draft.exclude_short_data,short_data_margin:Number(draft.short_data_margin),
    plot:draft.plot,push_metadata:draft.push_metadata,merge_references:draft.merge_references,weights,reference_weights:referenceWeights,...(draft.label.trim()?{label:draft.label.trim()}:{})}
  const key=JSON.stringify([project.id,project.version,ids,options]),committed=useRef(key)
  const current=completed??(preview?.key===key&&valid?preview.value:null)
  const output=current?.outputs.find(o=>o.role===role)??current?.outputs[0]
  useLayoutEffect(()=>{committed.current=key;generation.current++;setPreview(null);setError('');setLoading(false)},[key])
  useEffect(()=>{
    if(!valid||disabled||!ready||completed)return
    const abort=new AbortController(),token=++generation.current
    const timer=setTimeout(async()=>{
      setLoading(true);setError('')
      try{
        const result=await athenaApi<MergePreview>(`/projects/${project.id}/merge/preview`,{version:project.version,action:'merge',group_ids:ids,options},'POST',abort.signal)
        if(token!==generation.current||committed.current!==key)return
        validate(result,project,ids,options);setPreview({key,value:result})
      }catch(e){if(!abort.signal.aborted&&token===generation.current)setError(e instanceof Error?e.message:'Merge preview failed.')}
      finally{if(token===generation.current)setLoading(false)}
    },350)
    return()=>{clearTimeout(timer);abort.abort();generation.current++}
  // key includes every requested value and the project revision.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,valid,ready,disabled,retry,completed])
  function edit(values:Partial<MergeDraft>){manual.current=true;setDraft(d=>({...d,...values}))}
  async function saveDefaults(){
    if(!prefs||!valid||disabled||saving.current)return
    setPrefNotice('');saving.current=true;setBusy('Saving merge preferences')
    try{
      const values:Settings={weightby:options.weightby,exclude_short_data:options.exclude_short_data,short_data_margin:options.short_data_margin,plot:options.plot,push_metadata:options.push_metadata,merge_references:options.merge_references}
      const result=await athenaApi<{version:number;values:Settings}>('/preferences/merge',{version:prefs.version,values},'PUT')
      if(!alive.current)return
      if(result.version!==prefs.version+1||Object.entries(values).some(([k,v])=>result.values[k as keyof Settings]!==v))throw new Error('Saved preferences differ from the reviewed values.')
      setPrefs(result);setPrefNotice('Merge defaults saved for future sessions.')
    }catch(e){if(alive.current)setPrefNotice(e instanceof Error?e.message:'Could not save merge defaults.')}
    finally{saving.current=false;setBusy('')}
  }
  async function apply(){
    if(!current||completed||disabled||saving.current||committed.current!==key)return
    saving.current=true;setBusy('Merging spectra');setError('')
    try{
      const next=await athenaApi<AthenaProject>(`/projects/${project.id}/command`,{version:current.version,action:'merge',group_ids:current.group_ids,options:current.options})
      if(!alive.current)return
      const added=next.groups?.slice(project.groups.length)
      if(committed.current!==key||next.id!==project.id||next.version!==project.version+1||!added||added.length!==current.outputs.length
        ||project.groups.some((g,i)=>JSON.stringify(g)!==JSON.stringify(next.groups[i]))
        ||added.some((g,i)=>JSON.stringify(g.energy)!==JSON.stringify(current.outputs[i].result.x)||JSON.stringify(g.mu)!==JSON.stringify(current.outputs[i].result.y)
          ||JSON.stringify((g.source.raw_arrays as {stddev?:number[]})?.stddev)!==JSON.stringify(current.outputs[i].result.stddev)))throw new Error('The saved merge differs from the preview. Reload the workspace.')
      if(added.length===2&&(added[0].reference_id!==added[1].id||added[1].reference_id!==added[0].id))throw new Error('The merged reference link is missing. Reload the workspace.')
      setCompleted(current);saved(next,added[0].id)
    }catch(e){if(alive.current){setPreview(null);setError(e instanceof Error?e.message:'Merge failed.')}}
    finally{saving.current=false;setBusy('')}
  }
  const curves=output?.plots[draft.plot]??[]
  return <div className={`ath-modal-body ${controls.body}`}><p>{completed?'The merged spectra are saved. Compare their spread or contributing scans below.':'Merge the marked spectra into a new group. Review the contributing scans, weights and standard deviation before saving.'}</p>
    <div className={styles.layout}><fieldset className={styles.controls} disabled={disabled}>
      <fieldset disabled={disabled||!!completed} className={styles.controls}>
        <label className="ath-field"><span>Merge as</span><select aria-label="Merge as" value={draft.array} onChange={e=>edit({array:e.target.value as Options['array']})}><option value="mu">μ(E)</option><option value="norm">Normalized μ(E)</option><option value="chi">χ(k)</option></select></label>
        <label className="ath-field"><span>Weight by</span><select aria-label="Merge weighting" value={draft.weightby} onChange={e=>edit({weightby:e.target.value as Settings['weightby']})}><option value="importance">Importance</option><option value="step">Edge step</option><option value="noise">Noise · native εk</option></select></label>
        <details open={draft.weightby==='importance'}><summary>{marked.length} marked source groups</summary>{marked.map(g=><label className="ath-field" key={g.id}><span>Importance: {g.label}</span><input aria-label={`Importance: ${g.label}`} type="number" step="any" min="0" disabled={draft.weightby!=='importance'} value={value(g.id)} onChange={e=>edit({weights:{...draft.weights,[g.id]:e.target.value}})}/></label>)}</details>
        <label className="ath-check"><input type="checkbox" checked={draft.exclude_short_data} onChange={e=>edit({exclude_short_data:e.target.checked})}/>Exclude short scans</label>
        <label className="ath-field"><span>Short-scan margin · points</span><input aria-label="Short-scan margin · points" type="number" min="0" step="1" value={draft.short_data_margin} onChange={e=>edit({short_data_margin:e.target.value})}/></label>
        <p className="ath-hint">A scan is excluded if it has more than this many fewer points than the first marked scan.</p>
        <label className="ath-check"><input type="checkbox" checked={draft.merge_references} onChange={e=>edit({merge_references:e.target.checked})}/>Merge linked reference channels</label>
        {!!refs.length&&draft.merge_references&&draft.array!=='chi'&&<details><summary>Reference importance</summary>{refs.map(g=><label className="ath-field" key={g.id}><span>Reference importance: {g.label}</span><input aria-label={`Reference importance: ${g.label}`} type="number" min="0" step="any" disabled={draft.weightby!=='importance'} value={value(g.id,true)} onChange={e=>edit({reference_weights:{...draft.reference_weights,[g.id]:e.target.value}})}/></label>)}</details>}
        <label className="ath-check"><input type="checkbox" checked={draft.push_metadata} onChange={e=>edit({push_metadata:e.target.checked})}/>Carry acquisition metadata</label>
        <label className="ath-field"><span>Merged group label</span><input aria-label="Merged group label" placeholder="Automatic: merge, merge 2…" value={draft.label} onChange={e=>edit({label:e.target.value})}/></label>
      </fieldset>
      <label className="ath-field"><span>Merge plot</span><select aria-label="Merge plot" value={draft.plot} onChange={e=>edit({plot:e.target.value as Settings['plot']})}><option value="stddev">Merge ± standard deviation</option><option value="variance">Variance · scaled standard deviation</option><option value="marked">Merge and contributing scans</option></select></label>
      <div className={styles.views}><button disabled={disabled||!prefs||!valid} onClick={()=>void saveDefaults()}>Save merge defaults</button><button disabled={disabled} onClick={()=>void loadDefaults(true)}>Reload saved defaults</button></div>
      {prefNotice&&<p role="status">{prefNotice}</p>}
      <a href="https://bruceravel.github.io/demeter/documents/Athena/process/merge.html" target="_blank" rel="noreferrer">Document section: merging</a>
    </fieldset><section className={styles.results} aria-label="Merge preview">
      {current&&current.outputs.length>1&&<label className="ath-field"><span>Preview output</span><select aria-label="Merge output" value={output?.role} onChange={e=>setRole(e.target.value)}><option value="sample">Merged sample</option><option value="reference">Merged reference</option></select></label>}
      <div className={styles.plot} aria-label="Merge plot figure">{output?<Plot data={curves.map((c,i)=>({...c,type:'scatter',mode:'lines',line:{width:i?1:2}}))} layout={{autosize:true,margin:{l:65,r:15,t:65,b:55},font:{size:11},legend:{orientation:'h',y:1.05,yanchor:'bottom'},xaxis:{title:{text:current?.options.array==='chi'?'k (Å⁻¹)':'Energy (eV)'}},yaxis:{title:{text:current?.options.array==='chi'?'χ(k)':current?.options.array==='norm'?'Normalized μ(E)':'μ(E)'}},uirevision:`${project.id}:${output.role}:${current?.options.array}:${draft.plot}`}} config={{responsive:true,displaylogo:false}} style={{width:'100%',height:'100%'}} useResizeHandler/>:<p>{loading?'Calculating the merge…':'Mark at least two compatible spectra to preview their merge.'}</p>}</div>
      <p role="status">{completed?'Merge saved. The source spectra are unchanged.':loading?'Calculating the merge…':!valid?'Mark at least two spectra and enter valid nonnegative weights and a point margin.':current?`Preview ready at project revision ${current.version}.`:'Loading merge preview…'}</p>
      {output&&<><p>{output.result.details.count} contributing scans · {output.result.x.length} merged points. The standard deviation describes differences between scans; it is not a propagated measurement error.</p><table className={styles.table}><thead><tr><th>Scan</th><th>Weight</th><th>Fraction</th></tr></thead><tbody>{output.result.members.map(m=><tr key={m.group_id}><td>{m.label}</td><td>{m.weight.toPrecision(6)}</td><td>{m.coefficient.toPrecision(6)}</td></tr>)}</tbody></table>
        {output.result.excluded.map(e=><p className="ath-warning" key={e.group_id}>Excluded {e.label}: {e.reason}</p>)}{output.result.warnings.map((w,i)=><p className="ath-warning" key={i}>{w}</p>)}{output.processing_error&&<p className="ath-warning">Processing needs attention: {output.processing_error}</p>}</>}
      {current?.notes.map((n,i)=><p className="ath-hint" key={i}>{n}</p>)}{error&&<div className="ath-error" role="alert">{error}</div>}
    </section></div>
    <div className={`ath-modal-actions ${controls.actions}`}><button disabled={disabled} onClick={close}>{completed?'Close merge result':'Cancel merge'}</button>{!completed&&<><button disabled={disabled||!valid||loading||!ready} onClick={()=>{setPreview(null);setRetry(n=>n+1)}}>Replot merge</button><button className="ath-primary" disabled={disabled||!current||loading} onClick={()=>void apply()}>Save merged groups</button></>}</div>
  </div>
}
