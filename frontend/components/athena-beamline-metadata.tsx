"use client"

import { useEffect, useRef, useState } from 'react'
import { athenaApi } from '@/lib/athena'
import styles from './athena-beamline-metadata.module.css'

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}

export function AthenaBeamlineMetadata({ value }: { value: unknown }) {
  if (value == null) return null
  if (!record(value) || typeof value.reader !== 'string' || !record(value.attributes)
    || !Object.values(value.attributes).every(fields => record(fields) && Object.values(fields).every(v => typeof v === 'string'))
    || !strings(value.comments) || !strings(value.warnings)) {
    return <p className="ath-warning">The saved beamline metadata cannot be displayed. Its original contents remain in Source metadata.</p>
  }
  const attributes = value.attributes as Record<string, Record<string, string>>
  const location = [attributes.facility?.name, attributes.beamline?.name].filter(Boolean).join(' · ')
  const xdi = value.reader === 'XDI'
  return <section aria-label={xdi ? 'XDI metadata' : 'Beamline metadata'} className={styles.metadata}>
    <strong>{location || value.reader} · acquisition metadata</strong>
    {xdi && typeof value.xdi_version === 'string' && <p>XDI {value.xdi_version}{typeof value.extra_version === 'string' && value.extra_version ? ` · ${value.extra_version}` : ''}</p>}
    {attributes.scan?.start_time && <p>Acquired: {attributes.scan.start_time}</p>}
    {value.warnings.map((warning, i) => <p key={i} className="ath-warning">{warning}</p>)}
    <details><summary>{xdi ? 'View XDI metadata' : 'View beamline metadata'}</summary>
      <div className={styles.scroll}><table><caption>{value.reader} header fields</caption><tbody>
        {Object.entries(attributes).flatMap(([family, fields]) => Object.entries(fields).map(([tag, text]) =>
          <tr key={`${family}.${tag}`}><th scope="row">{family}.{tag}</th><td>{text}</td></tr>))}
      </tbody></table>
      {value.comments.length > 0 && <><h4>Acquisition comments</h4>{value.comments.map((comment, i) => <p key={i}>{comment}</p>)}</>}
      {record(value.mono_inference) && typeof value.mono_inference.description === 'string' && <p className="ath-hint">{value.mono_inference.description}</p>}
      <p className="ath-hint">{value.input_basis === 'native project' ? 'Restored from the native XDI project object.' : `Recognized from the ${value.input_basis === 'converted' ? 'converted' : 'original'} file header.`} These acquisition fields are kept with the source data.</p>
      {typeof value.source_sha256 === 'string' && <p className={styles.digest}>Source SHA-256: {value.source_sha256}</p>}
      </div>
    </details>
  </section>
}

type Preference = { version: number; enabled: boolean }
function preference(value: unknown): Preference {
  if (!record(value) || !Number.isInteger(value.version) || (value.version as number) < 0 || typeof value.enabled !== 'boolean') {
    throw new Error('Could not read beamline identification settings. Reload settings and try again.')
  }
  return value as Preference
}

export function AthenaBeamlinePreferences({ close }: { close: () => void }) {
  const [saved, setSaved] = useState<Preference | null>(null), [enabled, setEnabled] = useState(true)
  const [pending, setPending] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const running = useRef(false), generation = useRef(0)
  async function perform(work: () => Promise<unknown>, message = '', signal?: AbortSignal) {
    if (running.current) return
    running.current = true; const token = ++generation.current
    setPending(true); setError(''); setNotice('')
    try {
      const result = preference(await work())
      if (signal?.aborted || token !== generation.current) return
      setSaved(result); setEnabled(result.enabled); setNotice(message)
    } catch (e) {
      if (!signal?.aborted && token === generation.current) setError(e instanceof Error ? e.message : 'Could not save settings.')
    } finally {
      if (token === generation.current) { running.current = false; setPending(false) }
    }
  }
  useEffect(() => {
    const abort = new AbortController()
    void perform(() => athenaApi('/preferences/beamline', undefined, 'GET', abort.signal), '', abort.signal)
    return () => { generation.current++; running.current = false; abort.abort() }
  }, [])
  return <section aria-label="Beamline identification settings">
    <p>Identify BL8, MRCAT MX, X11A EDC and XDAC headers and keep their beamline, detector and acquisition information with imported groups.</p>
    <p className="ath-hint">Enabled by default, as in Athena. Saved changes apply when inspecting a file again; existing groups keep their metadata.</p>
    {pending && <p role="status">Loading or saving settings…</p>}
    {error && <p role="alert" className="ath-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <label className="ath-check"><input type="checkbox" disabled={pending || !saved} checked={enabled}
      onChange={e => { setEnabled(e.target.checked); setNotice('') }} />Identify beamline metadata on import</label>
    <div className="ath-modal-actions">
      <button type="button" disabled={pending} onClick={() => { void perform(() => athenaApi('/preferences/beamline'), 'Settings reloaded.') }}>Reload settings</button>
      <button type="button" disabled={pending || !saved} onClick={() => { if (saved) void perform(async () => {
        const result = preference(await athenaApi('/preferences/beamline', { version: saved.version, enabled }, 'PUT'))
        if (result.version !== saved.version + 1 || result.enabled !== enabled) throw new Error('The saved switch could not be confirmed. Reload settings before retrying.')
        return result
      }, 'Settings saved. Inspect the file again to use this choice.') }}>Save settings</button>
      <button type="button" disabled={pending} onClick={close}>Close settings</button>
    </div>
  </section>
}
