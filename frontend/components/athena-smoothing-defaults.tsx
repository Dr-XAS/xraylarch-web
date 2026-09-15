'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { applySmoothingPreferences, loadSmoothingPreferences, type SGPreferences, type SGValues } from '@/lib/athena-smoothing-preferences'

function checked(value: SGPreferences): SGPreferences {
  const valid = (v: SGValues) => v && Number.isInteger(v.window) && v.window >= 0 && v.window <= 39
    && Number.isInteger(v.order) && v.order >= 9 && v.order <= 39
  if (!value || !Number.isInteger(value.version) || value.version < 0 || typeof value.session_id !== 'string' || !value.session_id
    || ![value.values, value.saved, value.defaults].every(valid) || typeof value.unsaved !== 'boolean') {
    throw new Error('Could not read smoothing preferences. Reload preferences to try again.')
  }
  return value
}
const equal = (a: SGValues, b: SGValues) => a.window === b.window && a.order === b.order

export function useSmoothingPreferences(draft: {window: string; order: string}, adopt: (v: SGValues) => void, loadIntoDraft: boolean) {
  const [state, setState] = useState<SGPreferences | null>(null)
  const [pending, setPending] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const current = useRef(state), latest = useRef(draft), adoptRef = useRef(adopt), generation = useRef(0), running = useRef(false)
  const edits = useRef(0)
  useLayoutEffect(() => { edits.current++ }, [draft.window, draft.order])
  latest.current = draft; adoptRef.current = adopt
  const valid = draft.window.trim() && draft.order.trim() && Number.isInteger(Number(draft.window)) && Number(draft.window) >= 0 && Number(draft.window) <= 39
    && Number.isInteger(Number(draft.order)) && Number(draft.order) >= 9 && Number(draft.order) <= 39
  async function load(adoptValues: boolean, signal?: AbortSignal) {
    const token = ++generation.current, before = {...latest.current}, beforeEdits = edits.current
    running.current = true; setPending(true); setError(''); setNotice('')
    try {
      const value = checked(await loadSmoothingPreferences(signal))
      if (token !== generation.current || signal?.aborted) return
      current.current = value; setState(value)
      if (adoptValues && beforeEdits === edits.current && latest.current.window === before.window && latest.current.order === before.order) {
        adoptRef.current(value.values); setNotice('Current smoothing preferences loaded.')
      } else setNotice('Preferences loaded; your current filter choices are kept.')
    } catch (reason) {
      if (token === generation.current && !signal?.aborted) setError(reason instanceof Error ? reason.message : 'Could not load smoothing preferences.')
    } finally { if (token === generation.current) { running.current = false; setPending(false) } }
  }
  useEffect(() => {
    const controller = new AbortController(); void load(loadIntoDraft, controller.signal)
    return () => { controller.abort(); generation.current++; running.current = false }
    // Loading a reopened panel preserves explicit unsaved filter choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function apply(save: boolean) {
    const previous = current.current
    if (running.current || !previous || !valid) return
    const before = {...latest.current}, beforeEdits = edits.current, values = {window: Number(before.window), order: Number(before.order)}
    const request = {version: previous.version, session_id: previous.session_id, values, save}, token = ++generation.current
    running.current = true; setPending(true); setError(''); setNotice('')
    try {
      const value = checked(await applySmoothingPreferences(request))
      if (token !== generation.current) return
      if (value.session_id !== request.session_id || value.version !== request.version + 1 || !equal(value.values, values)
        || (save && (value.unsaved || !equal(value.saved, values)))) throw new Error('Applied preferences could not be confirmed. Reload preferences before retrying.')
      current.current = value; setState(value)
      if (beforeEdits === edits.current && latest.current.window === before.window && latest.current.order === before.order) adoptRef.current(value.values)
      setNotice(save ? 'Smoothing preferences applied and saved for future starts.' : 'Smoothing preferences applied for this server session.')
    } catch (reason) {
      if (token === generation.current) { current.current = null; setState(null); setError(reason instanceof Error ? reason.message : 'Could not apply smoothing preferences.') }
    } finally { if (token === generation.current) { running.current = false; setPending(false) } }
  }
  return {state, pending, error, notice, valid: !!valid, apply,
    load: () => { if (!running.current) void load(true) },
    use: (which: 'values' | 'saved' | 'defaults') => {
      if (!running.current && current.current) {
        adoptRef.current(current.current[which]); setNotice('Values copied into the filter controls. Apply to change session preferences.')
      }
    }}
}

export function SmoothingDefaults({preferences: p, disabled}: {preferences: ReturnType<typeof useSmoothingPreferences>; disabled: boolean}) {
  return <section aria-label="Savitzky–Golay preferences">
    <p className="ath-hint">Apply uses this window and order for this server session. Apply and Save also keeps them after the server restarts. Existing spectra keep their accepted settings.</p>
    {p.state && <p className="ath-hint">Current: {p.state.values.window} / {p.state.values.order} · Saved: {p.state.saved.window} / {p.state.saved.order} · Default: {p.state.defaults.window} / {p.state.defaults.order} (window / order).</p>}
    {p.state?.unsaved && <p role="status">Session preferences have not been saved for the next start.</p>}
    <div className="ath-modal-actions">
      <button disabled={disabled || p.pending || !p.state || !p.valid} onClick={() => { void p.apply(false) }}>Apply</button>
      <button disabled={disabled || p.pending || !p.state || !p.valid} onClick={() => { void p.apply(true) }}>Apply and Save</button>
      <button disabled={disabled || p.pending || !p.state} onClick={() => p.use('values')}>Use current values</button>
      <button disabled={disabled || p.pending || !p.state} onClick={() => p.use('saved')}>Use saved values</button>
      <button disabled={disabled || p.pending || !p.state} onClick={() => p.use('defaults')}>Use Athena defaults</button>
      <button disabled={disabled || p.pending} onClick={p.load}>Reload preferences</button>
    </div>
    {p.pending && <p role="status">Loading or applying smoothing preferences…</p>}
    {p.error && <p className="ath-error" role="alert">{p.error}</p>}
    {p.notice && <p role="status">{p.notice}</p>}
  </section>
}
