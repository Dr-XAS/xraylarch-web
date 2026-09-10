"use client"

import { useEffect, useRef, useState } from 'react'
import { apiBase } from '@/lib/athena'
import { loadPluginRegistry, savePluginRegistry, importPluginRegistry, type PluginRegistry } from '@/lib/athena-preferences'
import { AthenaPluginConfiguration } from './athena-plugin-configuration'

function checked(value: PluginRegistry): PluginRegistry {
  if (!value || !Number.isInteger(value.version) || value.version < 0 || !value.enabled || Array.isArray(value.enabled)
      || Object.values(value.enabled).some(flag => typeof flag !== 'boolean') || !Array.isArray(value.plugins)
      || value.plugins.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.description !== 'string'
        || typeof p.documentation !== 'string' || typeof p.documentation_url !== 'string'
        || (p.configurable !== undefined && typeof p.configurable !== 'boolean'))) {
    throw new Error('Could not read the plugin registry. Reload plugin settings and try again.')
  }
  return value
}

export function AthenaPluginRegistry({ onPendingChange }: { onPendingChange?: (pending: boolean) => void }) {
  const [state, setState] = useState<PluginRegistry | null>(null)
  const [pending, setPending] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const current = useRef<PluginRegistry | null>(null), running = useRef(false), generation = useRef(0)
  const upload = useRef<HTMLInputElement>(null)
  const [configuring, setConfiguring] = useState<string | null>(null), [configurationPending, setConfigurationPending] = useState(false)
  const configurationRunning = useRef(false)
  const locked = pending || configurationPending

  async function perform(work: () => Promise<PluginRegistry>, message: string, signal?: AbortSignal) {
    if (running.current || configurationRunning.current) return
    const token = ++generation.current
    running.current = true; setPending(true); onPendingChange?.(true); setError(''); setNotice('')
    try {
      const result = checked(await work())
      if (token !== generation.current || signal?.aborted) return
      current.current = result; setState(result); setNotice(message)
    } catch (e) {
      if (token === generation.current && !signal?.aborted) setError(e instanceof Error ? e.message : 'Could not update plugin settings.')
    } finally {
      if (token === generation.current) { running.current = false; setPending(false); onPendingChange?.(false) }
    }
  }
  useEffect(() => {
    const abort = new AbortController()
    void perform(() => loadPluginRegistry(abort.signal), '', abort.signal)
    return () => { generation.current++; running.current = false; abort.abort(); onPendingChange?.(false) }
    // Registry choices are loaded when this view opens; pending updates serialize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggle(id: string, enabled: boolean) {
    const previous = current.current
    if (!previous) return
    const request = { version: previous.version, enabled: { ...previous.enabled, [id]: enabled } }
    void perform(async () => {
      const saved = checked(await savePluginRegistry(request))
      if (saved.version !== request.version + 1 || JSON.stringify(Object.entries(saved.enabled).sort()) !== JSON.stringify(Object.entries(request.enabled).sort())) {
        throw new Error('The change could not be confirmed. Reload plugin settings before trying again.')
      }
      return saved
    }, 'Plugin setting saved for subsequent file inspections.')
  }
  const unavailable = state ? Object.entries(state.enabled).filter(([id]) => !state.plugins.some(p => p.id === id)) : []
  return <section aria-label="File-plugin settings" className="ath-plugin-registry">
    <p>Enable the file formats you use. Switches are saved immediately for future sessions on this local server. Plugins are checked in the order shown.</p>
    {pending && <p role="status">Loading or saving plugin settings…</p>}
    {error && <p role="alert" className="ath-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <fieldset disabled={locked || !state} style={{ border: 0, padding: 0, margin: 0 }}>
      {state?.plugins.map((plugin, index) => <section key={plugin.id} className="ath-plugin-entry">
        <label className="ath-check"><input type="checkbox" aria-label={`Enable ${plugin.name}`} checked={state.enabled[plugin.id] ?? false}
          onChange={e => toggle(plugin.id, e.target.checked)} /><strong>{plugin.name}</strong> · {plugin.description}</label>
        <p className="ath-hint">{index + 1}. System plugin · version {plugin.version}</p>
        <details><summary>{plugin.name} documentation</summary><p>{plugin.documentation}</p>
          <a href={plugin.documentation_url} target="_blank" rel="noreferrer">Original {plugin.name} documentation</a></details>
        {plugin.configurable && <button type="button" aria-expanded={configuring === plugin.name}
          onClick={() => setConfiguring(value => value === plugin.name ? null : plugin.name)}>Configure {plugin.name}</button>}
        {plugin.configurable && configuring === plugin.name && <AthenaPluginConfiguration key={plugin.name} reader={plugin.name}
          onPendingChange={value => { configurationRunning.current = value; setConfigurationPending(value); onPendingChange?.(value || running.current) }} />}
      </section>)}
    </fieldset>
    {unavailable.length > 0 && <details><summary>Settings for {unavailable.length} unavailable plugins</summary>
      <p>These readers are unavailable in this application. Their saved settings are retained when exporting the registry.</p>
      <ul>{unavailable.map(([id, enabled]) => <li key={id}>{id.replace('Demeter::Plugins::', '')} · saved as {enabled ? 'enabled' : 'disabled'}</li>)}</ul>
    </details>}
    <p className="ath-hint">Settings apply when a file is inspected. After enabling a reader, return to the import panel and retry the selected file.</p>
    <div className="ath-modal-actions">
      <button type="button" disabled={locked} onClick={() => { void perform(() => loadPluginRegistry(), 'Plugin settings reloaded.') }}>Reload plugin settings</button>
      <button type="button" disabled={locked || !state} onClick={() => upload.current?.click()}>Import Athena registry…</button>
      {state && !locked && <a className="ath-button" href={`${apiBase}/preferences/plugins/export`} download>Export Athena registry</a>}
    </div>
    <input ref={upload} type="file" aria-label="Import Athena plugin registry file" hidden disabled={locked || !state} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''
      if (file && current.current) {
        const version = current.current.version
        void perform(async () => {
          const saved = checked(await importPluginRegistry(version, file))
          if (saved.version !== version + 1) throw new Error('The imported registry could not be confirmed. Reload plugin settings.')
          return saved
        }, 'Athena registry imported. Review the saved switches below.')
      }
    }} />
    <p><a href="https://bruceravel.github.io/demeter/documents/Athena/other/plugin.html" target="_blank" rel="noreferrer">Athena guide: file type plugins</a></p>
  </section>
}
