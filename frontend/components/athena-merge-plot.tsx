'use client'

import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { athenaApi, hasSavedMerge, savedMergeSpace, type AthenaProject } from '@/lib/athena'
import styles from './athena-difference.module.css'
import controls from './athena-smoothing.module.css'

const Plot=dynamic(()=>import('react-plotly.js').then(m=>m.default),{ssr:false})
type Options={version:number;view:'stddev'|'variance';flatten:boolean|null;energy_display:'mu'|'norm'|'flat';kweight:number|null}
export type SavedMergePlot={project_id:string;version:number;options:Options;result:{group_id:string;label:string;merge_space:'mu'|'norm'|'chi';origin:string;
  display:string;kweight:number|null;multiplier:number;offset:number;spread_scale:number|null;points:number;
  curves:{name:string;x:number[];y:number[]}[];notes:string[];x_label:string;y_label:string}}

export function AthenaMergePlot({project,groupId,selectGroup,close}:{project:AthenaProject;groupId:string;selectGroup:(id:string)=>void;close:()=>void}){
  const group=project.groups.find(g=>g.id===groupId),merged=project.groups.filter(hasSavedMerge)
  const mergeSpace=group?savedMergeSpace(group):null
  const [view,setView]=useState<Options['view']>('stddev'),[flatten,setFlatten]=useState<boolean|null>(null)
  const [energyDisplay,setEnergyDisplay]=useState<Options['energy_display']>('mu'),[weight,setWeight]=useState('')
  const [data,setData]=useState<{key:string;value:SavedMergePlot}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0)
  const generation=useRef(0),currentKey=useRef('')
  const options:Options={version:project.version,view,flatten,energy_display:energyDisplay,kweight:weight.trim()===''?null:Number(weight)}
  const valid=!!group&&hasSavedMerge(group)&&(options.kweight===null||(Number.isFinite(options.kweight)&&options.kweight>=0&&options.kweight<=4))
  const key=JSON.stringify([project.id,groupId,options]),current=data?.key===key&&valid?data.value:null
  useLayoutEffect(()=>{currentKey.current=key;generation.current++;setData(null);setError('');setLoading(false)},[key])
  useEffect(()=>{
    if(!valid||!group)return
    const abort=new AbortController(),token=++generation.current
    const timer=setTimeout(async()=>{
      setLoading(true)
      try{
        const value=await athenaApi<SavedMergePlot>(`/projects/${project.id}/groups/${group.id}/merge/plot`,options,'POST',abort.signal)
        if(token!==generation.current||currentKey.current!==key)return
        const r=value.result,x=group.energy.map(x=>x+(group.data_type==='chi'?0:group.parameters.energy_shift))
        if(value.project_id!==project.id||value.version!==project.version||Object.entries(options).some(([k,v])=>value.options?.[k as keyof Options]!==v)
          ||r?.group_id!==group.id||r.points!==x.length||!['mu','norm','chi'].includes(r.merge_space)||!Array.isArray(r.curves)||r.curves.length!==(view==='stddev'?3:2)
          ||r.curves.some(c=>!Array.isArray(c.x)||!Array.isArray(c.y)||c.x.length!==x.length||c.y.length!==x.length||c.x.some((v,i)=>v!==x[i])||c.y.some(v=>typeof v!=='number'||!Number.isFinite(v))))throw new Error('The saved-merge plot does not match this group and these settings. Replot to retry.')
        setData({key,value});setError('')
      }catch(e){if(!abort.signal.aborted&&token===generation.current)setError(e instanceof Error?e.message:'Could not load the saved merge.')}
      finally{if(token===generation.current)setLoading(false)}
    },200)
    return()=>{clearTimeout(timer);abort.abort();generation.current++}
  // key captures the project revision, selected group and every display option.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,valid,retry])
  const r=current?.result
  return <div className={`ath-modal-body ${controls.body}`}>
    <p>Inspect the standard deviation stored with a merged spectrum. Display choices leave the saved spectrum, processing parameters and scatter unchanged.</p>
    <div className={styles.layout}><fieldset className={styles.controls}>
      <label className="ath-field"><span>Merged spectrum</span><select aria-label="Saved merged spectrum" value={groupId} onChange={e=>{setFlatten(null);setWeight('');selectGroup(e.target.value)}}>{merged.map(g=><option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
      <label className="ath-field"><span>Spread display</span><select aria-label="Saved merge display" value={view} onChange={e=>setView(e.target.value as Options['view'])}><option value="stddev">Merge ± standard deviation</option><option value="variance">Merge + scaled standard deviation</option></select></label>
      {mergeSpace==='norm'&&<label className="ath-check"><input type="checkbox" checked={flatten??group?.parameters.flatten??true} onChange={e=>setFlatten(e.target.checked)}/>Flatten normalized merge</label>}
      {mergeSpace==='mu'&&view==='variance'&&<label className="ath-field"><span>Energy display</span><select aria-label="Saved merge energy display" value={energyDisplay} onChange={e=>setEnergyDisplay(e.target.value as Options['energy_display'])}><option value="mu">μ(E) · raw</option><option value="norm">μ(E) · normalized</option><option value="flat">μ(E) · flattened</option></select></label>}
      {group?.data_type==='chi'&&<label className="ath-field"><span>Plot k weight</span><input aria-label="Saved merge k weight" type="number" min="0" max="4" step="any" placeholder={`Group: ${group.parameters.kweight}`} value={weight} onChange={e=>setWeight(e.target.value)}/></label>}
      <p className="ath-hint">Group plot scale: {group?.multiplier} · offset: {group?.offset}. Edit these in Group information.</p>
      <button disabled={!valid||loading} onClick={()=>{setData(null);setError('');setRetry(v=>v+1)}}>Replot saved merge</button>
      <p><a href="https://bruceravel.github.io/demeter/documents/Athena/plot/etc.html#special-plots-for-merged-groups" target="_blank" rel="noreferrer">Document section: merge plots</a></p>
    </fieldset><section className={styles.results} aria-label="Saved merge spread">
      <div className={styles.plot} aria-label="Saved merge plot figure">{r?<Plot data={r.curves.map((c,i)=>({...c,type:'scatter',mode:'lines',line:{width:i?1:2}}))} layout={{autosize:true,margin:{l:65,r:15,t:85,b:55},font:{size:11},legend:{orientation:'h',y:1.05,yanchor:'bottom'},xaxis:{title:{text:r.x_label}},yaxis:{title:{text:r.y_label}},uirevision:`${project.id}:${groupId}:${view}:${r.display}:${r.kweight}`}} config={{responsive:true,displaylogo:false}} style={{width:'100%',height:'100%'}} useResizeHandler/>:<p>{loading?'Loading the saved merge…':'Choose a merged spectrum with a saved standard-deviation array.'}</p>}</div>
      <p role="status">{r?`${r.points} saved points · project revision ${current.version}.`:!valid?'Choose a merged spectrum and a finite k weight from zero to four.':loading?'Loading the saved merge…':'Waiting for the saved merge.'}</p>
      {r?.notes.map((note,i)=><p className="ath-hint" key={i}>{note}</p>)}{error&&<p role="alert" className="ath-error">{error}</p>}
    </section></div><div className={`ath-modal-actions ${controls.actions}`}><button onClick={close}>Close merge plot</button></div>
  </div>
}
