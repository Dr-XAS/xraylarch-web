'use client'

import { useEffect, useState } from 'react'
import { dataTypeLabel, type AthenaGroup, type AthenaProject } from '@/lib/athena'
import { useAthenaApi } from '@/lib/athena-context'
import { groupYaml, type ContextReportKind } from './athena-native-context'

type RemoteReport = { version?: number; kind?: string; filename?: string; text?: string; results?: Record<string, unknown>[]; skipped?: { group_id: string; label: string; reason: string }[] }
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Number(value.toPrecision(8)).toString() : 'Unavailable'
const reportLabels: Record<string, string> = { epsilon_k: 'Noise estimate εk', epsilon_r: 'Noise estimate εR', nidp: 'Independent points', edge_step: 'Edge step', mean: 'Mean sampled edge step', standard_deviation: 'Estimated uncertainty', samples: 'Samples', retained_samples: 'Retained samples' }

export function AthenaContextReport({ kind, project, groups }: { kind: ContextReportKind; project: AthenaProject; groups: AthenaGroup[] }) {
  const athenaApi = useAthenaApi()
  const [remote, setRemote] = useState<RemoteReport | null>(null), [error, setError] = useState('')
  const needsRequest = ['source', 'measurement_uncertainty', 'edge_step_uncertainty'].includes(kind)
  useEffect(() => {
    if (!needsRequest || !groups.length) return
    const abort = new AbortController()
    const path = kind === 'source' ? `/projects/${project.id}/groups/${groups[0].id}/source-text` : `/projects/${project.id}/context-report`
    const request = kind === 'source' ? undefined : { version: project.version, group_ids: groups.map(g => g.id), kind }
    void athenaApi<RemoteReport>(path, request, undefined, abort.signal).then(result => {
      if (abort.signal.aborted) return
      if (kind !== 'source' && (result.version !== project.version || result.kind !== kind || !Array.isArray(result.results))) throw new Error('The report does not match this project revision. Close it and try again.')
      setRemote(result)
    }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'Could not read this report.') })
    return () => abort.abort()
  }, [kind, project.id, project.version, groups, needsRequest])
  const values = groups.map(g => kind === 'shifts' ? g.parameters.energy_shift : g.parameters.step ?? g.result?.effective.edge_step)
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const mean = finite.reduce((sum, v) => sum + v, 0) / finite.length
  const deviation = Math.sqrt(finite.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (finite.length - 1))
  return <section className="ath-context-report" aria-label="Group report">
    {error && <p role="alert" className="ath-error">{error}</p>}
    {needsRequest && !remote && !error && <p role="status">Preparing report…</p>}
    {!groups.length && <p>No groups in this selection.</p>}
    {kind === 'about' && groups.map(g => <article key={g.id}><h3>{g.label}</h3><dl>
      <dt>Data type</dt><dd>{dataTypeLabel(g)}</dd><dt>Points</dt><dd>{g.energy.length.toLocaleString()}</dd>
      <dt>Source</dt><dd>{String(g.source.filename ?? 'Generated spectrum')}</dd>
      <dt>E₀</dt><dd>{number(g.parameters.e0 ?? g.result?.effective.e0)} eV</dd>
      <dt>Edge step</dt><dd>{number(g.parameters.step ?? g.result?.effective.edge_step)}</dd>
      <dt>State</dt><dd>{g.frozen ? 'Frozen' : 'Editable'}{g.marked ? ' · marked' : ''}</dd>
      <dt>Processing</dt><dd>{g.processing_error ?? (g.result ? 'Processed' : 'No result')}</dd>
    </dl>{g.notes && <p>{g.notes}</p>}</article>)}
    {kind === 'yaml' && <><p>Saved parameters, source metadata, and complete data arrays.</p><pre aria-label="Group YAML">{groupYaml(groups.length === 1 ? groups[0] : groups)}</pre></>}
    {kind === 'source' && remote && <><h3>{remote.filename}</h3><pre aria-label="Original data file">{remote.text}</pre></>}
    {(kind === 'shifts' || kind === 'steps') && <><table><thead><tr><th>Group</th><th>{kind === 'shifts' ? 'Energy shift (eV)' : 'Edge step'}</th>{kind === 'shifts' && <th>Recorded uncertainty (eV)</th>}</tr></thead><tbody>{groups.map((g, index) => {
      const alignment = g.source.alignment as { energy_shift?: number; shift_stderr?: number } | undefined
      return <tr key={g.id}><th scope="row">{g.label}</th><td>{number(values[index])}</td>{kind === 'shifts' && <td>{number(alignment?.energy_shift === g.parameters.energy_shift ? alignment?.shift_stderr : null)}</td>}</tr>
    })}</tbody></table>{finite.length > 1 && <p>Average: {number(mean)} · Standard deviation: {number(deviation)}</p>}</>}
    {remote?.results?.map((row, index) => <article key={String(row.group_id ?? index)}><h3>{String(row.label ?? groups[index]?.label ?? 'Spectrum')}</h3><dl>{Object.entries(reportLabels).filter(([key]) => key in row).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{number(row[key])}</dd></div>)}</dl>
      {Array.isArray(row.warnings) && row.warnings.map((warning, i) => <p className="ath-warning" key={i}>{String(warning)}</p>)}
      {typeof row.report === 'string' && <details><summary>Calculation report</summary><pre>{row.report}</pre></details>}
    </article>)}
    {!!remote?.skipped?.length && <><h3>Unavailable estimates</h3><ul>{remote.skipped.map(row => <li key={row.group_id}>{row.label}: {row.reason}</li>)}</ul></>}
  </section>
}
