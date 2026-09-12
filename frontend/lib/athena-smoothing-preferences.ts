import { athenaApi } from './athena'

export type SGValues = {window: number; order: number}
export type SGPreferences = {version: number; session_id: string; values: SGValues; saved: SGValues; defaults: SGValues; unsaved: boolean}
export function loadSmoothingPreferences(signal?: AbortSignal) {
  return athenaApi<SGPreferences>('/preferences/smoothing', undefined, 'GET', signal)
}
export function applySmoothingPreferences(request: Pick<SGPreferences, 'version' | 'session_id' | 'values'> & {save: boolean}) {
  return athenaApi<SGPreferences>('/preferences/smoothing', request, 'PUT')
}
