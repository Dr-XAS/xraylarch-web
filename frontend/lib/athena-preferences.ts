import { athenaApi } from './athena'

export function loadRebinDefaults(signal?: AbortSignal): Promise<unknown> {
  return athenaApi('/preferences/rebin', undefined, 'GET', signal)
}
export function saveRebinDefaults(value: unknown): Promise<unknown> {
  return athenaApi('/preferences/rebin', value as Record<string, unknown>, 'PUT')
}

export interface PluginEntry {
  id: string; name: string; version: string; description: string; origin: 'system'
  documentation: string; documentation_url: string
  configurable?: boolean
}

export interface PluginConfigurationField {
  name: string; title: string; type: 'integer' | 'number' | 'string' | 'boolean'; description?: string
  minimum?: number; maximum?: number; exclusiveMinimum?: number; minLength?: number; maxLength?: number; enum?: string[]
}
export interface PluginConfiguration {
  reader: string; version: number; session_id: string; unsaved: boolean
  values: Record<string, number | string | boolean>; saved: Record<string, number | string | boolean>; defaults: Record<string, number | string | boolean>
  fields: PluginConfigurationField[]
}
export function loadPluginConfiguration(reader: string, signal?: AbortSignal): Promise<PluginConfiguration> {
  return athenaApi(`/preferences/plugins/${encodeURIComponent(reader)}/configuration`, undefined, 'GET', signal)
}
export function applyPluginConfiguration(reader: string,
  value: Pick<PluginConfiguration, 'version' | 'session_id' | 'values'> & { save: boolean }): Promise<PluginConfiguration> {
  return athenaApi(`/preferences/plugins/${encodeURIComponent(reader)}/configuration`, value, 'PUT')
}
export interface PluginRegistry {
  version: number; enabled: Record<string, boolean>; plugins: PluginEntry[]
}
export function loadPluginRegistry(signal?: AbortSignal): Promise<PluginRegistry> {
  return athenaApi('/preferences/plugins', undefined, 'GET', signal)
}
export function savePluginRegistry(value: Pick<PluginRegistry, 'version' | 'enabled'>): Promise<PluginRegistry> {
  return athenaApi('/preferences/plugins', value, 'PUT')
}
export function importPluginRegistry(version: number, file: File): Promise<PluginRegistry> {
  const form = new FormData(); form.append('file', file)
  return athenaApi(`/preferences/plugins/import?version=${version}`, form)
}
