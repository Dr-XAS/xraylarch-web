"use client"

import { useEffect, useRef, useState } from 'react'
import { applyPluginConfiguration, loadPluginConfiguration, type PluginConfiguration } from '@/lib/athena-preferences'

function checked(value: PluginConfiguration, reader: string) {
  if (!value || value.reader !== reader || !Number.isInteger(value.version) || value.version < 0 || !value.session_id
    || !Array.isArray(value.fields) || !value.fields.length || new Set(value.fields.map(f => f?.name)).size !== value.fields.length
    || !value.values || !value.saved || !value.defaults
    || value.fields.some(f => !f || !f.name || !f.title || !['number', 'integer', 'string', 'boolean'].includes(f.type)
      || [value.values[f.name], value.saved[f.name], value.defaults[f.name]].some(v => f.type === 'boolean' ? typeof v !== 'boolean'
        : f.type === 'string' ? typeof v !== 'string' : typeof v !== 'number' || !Number.isFinite(v)))) {
    throw new Error('Could not read reader configuration. Reload configuration and try again.')
  }
  return value
}

const asDraft = (values: PluginConfiguration['values']) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]))

export function AthenaPluginConfiguration({ reader, onPendingChange }: {
  reader: string; onPendingChange?: (pending: boolean) => void
}) {
  const [state, setState] = useState<PluginConfiguration | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const current = useRef<PluginConfiguration | null>(null), running = useRef(false), generation = useRef(0)
  const notify = useRef(onPendingChange); notify.current = onPendingChange

  async function perform(work: () => Promise<PluginConfiguration>, message: string, signal?: AbortSignal) {
    if (running.current) return
    const token = ++generation.current
    running.current = true; setPending(true); setError(''); setNotice(''); notify.current?.(true)
    try {
      const result = checked(await work(), reader)
      if (token !== generation.current || signal?.aborted) return
      current.current = result; setState(result); setDraft(asDraft(result.values)); setNotice(message)
    } catch (e) {
      if (token === generation.current && !signal?.aborted) setError(e instanceof Error ? e.message : 'Could not apply configuration.')
    } finally {
      if (token === generation.current) { running.current = false; setPending(false); notify.current?.(false) }
    }
  }
  useEffect(() => {
    const abort = new AbortController()
    void perform(() => loadPluginConfiguration(reader, abort.signal), '', abort.signal)
    return () => { generation.current++; running.current = false; abort.abort(); notify.current?.(false) }
    // A new reader mounts a separate editor; response generations guard stale loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader])

  let problem = ''
  const values: PluginConfiguration['values'] = {}
  for (const field of state?.fields ?? []) {
    const text = draft[field.name] ?? ''
    const value = field.type === 'boolean' ? text === 'true' : field.type === 'string' ? text : Number(text)
    if ((field.type !== 'boolean' && (field.type === 'string' ? text.trim().length < (field.minLength ?? 1) : !text.trim()))
      || (typeof value === 'number' && (!Number.isFinite(value)
      || (field.type === 'integer' && !Number.isInteger(value)) || (field.minimum !== undefined && value < field.minimum)
      || (field.maximum !== undefined && value > field.maximum) || (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum)))
      || (typeof value === 'string' && ((field.enum && !field.enum.includes(value)) || (field.maxLength && value.length > field.maxLength)))) {
      problem ||= `Check ${field.title.toLowerCase()}.`
    }
    values[field.name] = value
  }
  function apply(save: boolean) {
    const previous = current.current
    if (!previous || problem) return
    const request = { version: previous.version, session_id: previous.session_id, values, save }
    void perform(async () => {
      const saved = checked(await applyPluginConfiguration(reader, request), reader)
      if (saved.session_id !== request.session_id || saved.version !== request.version + 1
        || Object.entries(request.values).some(([key, value]) => saved.values[key] !== value)
        || (save && saved.unsaved)) throw new Error('The applied values could not be confirmed. Reload configuration before retrying.')
      return saved
    }, save ? 'Applied and saved reader settings for future starts. Inspect the file again to use them.'
      : 'Applied for this server session. Inspect the file again to use these values.')
  }
  return <section aria-label={`${reader} configuration`} className="ath-plugin-configuration">
    <h4>{reader} configuration</h4>
    <p className="ath-hint">Apply affects subsequent file inspections in this server session. Apply and Save also saves all currently applied reader settings for future starts.</p>
    {state?.unsaved && <p role="status">Current values include changes that have not been saved for the next start.</p>}
    {pending && <p role="status">Loading or applying configuration…</p>}
    {error && <p role="alert" className="ath-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <fieldset disabled={pending || !state} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="ath-fields">{state?.fields.map(field => <div key={field.name}>
        <label className={field.type === 'boolean' ? 'ath-check' : 'ath-field'}><span>{field.title}</span>{field.type === 'boolean'
          ? <input type="checkbox" checked={draft[field.name] === 'true'} onChange={e => { setDraft(v => ({ ...v, [field.name]: String(e.target.checked) })); setNotice('') }} />
          : field.enum
          ? <select value={draft[field.name] ?? ''} onChange={e => { setDraft(v => ({ ...v, [field.name]: e.target.value })); setNotice('') }}>{field.enum.map(v => <option key={v}>{v}</option>)}</select>
          : <input type={field.type === 'string' ? 'text' : 'number'} min={field.minimum} max={field.maximum}
              step={field.type === 'integer' ? 1 : 'any'} maxLength={field.maxLength} value={draft[field.name] ?? ''}
              onChange={e => { setDraft(v => ({ ...v, [field.name]: e.target.value })); setNotice('') }} />}</label>
        <p className="ath-hint">Current: {String(state.values[field.name])} · Saved: {String(state.saved[field.name])} · Default: {String(state.defaults[field.name])}</p>
        {field.description && <p className="ath-hint">{field.description}</p>}
      </div>)}</div>
      {problem && <p role="alert" className="ath-error">{problem}</p>}
      <div className="ath-modal-actions">
        <button type="button" disabled={!!problem} onClick={() => apply(false)}>Apply</button>
        <button type="button" disabled={!!problem} onClick={() => apply(true)}>Apply and Save</button>
        <button type="button" onClick={() => { if (state) setDraft(asDraft(state.values)); setNotice('Current values copied into the form.') }}>Use current values</button>
        <button type="button" onClick={() => { if (state) setDraft(asDraft(state.saved)); setNotice('Saved values copied into the form. Apply to use them.') }}>Use saved values</button>
        <button type="button" onClick={() => { if (state) setDraft(asDraft(state.defaults)); setNotice('Athena defaults copied into the form. Apply to use them.') }}>Use Athena defaults</button>
      </div>
    </fieldset>
    <button type="button" disabled={pending} onClick={() => { void perform(() => loadPluginConfiguration(reader), 'Configuration reloaded.') }}>Reload configuration</button>
  </section>
}
