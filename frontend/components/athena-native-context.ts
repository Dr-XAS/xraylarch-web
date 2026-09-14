import type { AthenaGroup, Parameters } from '@/lib/athena'

export type NativeSection = 'all' | 'group' | 'background' | 'forward' | 'reverse' | 'plot'
export type NativeField = keyof Parameters | 'spline_energy' | 'background_standard_id' | 'element' | 'edge' | 'importance' | 'multiplier' | 'offset' | 'fix_step'
export type ContextTarget = { kind: 'group' } | { kind: 'field'; field: NativeField } | { kind: 'section'; section: NativeSection } | { kind: 'peak'; index: number }
export type ContextReportKind = 'about' | 'yaml' | 'source' | 'shifts' | 'steps' | 'measurement_uncertainty' | 'edge_step_uncertainty'

// Native Athena attaches range menus to the shared label for both endpoints.
export const nativeRanges: Partial<Record<NativeField, (keyof Parameters)[]>> = {
  pre1: ['pre1', 'pre2'], pre2: ['pre1', 'pre2'],
  norm1: ['norm1', 'norm2'], norm2: ['norm1', 'norm2'],
  bkg_kmin: ['bkg_kmin', 'bkg_kmax'], bkg_kmax: ['bkg_kmin', 'bkg_kmax'],
  spline_energy: ['bkg_kmin', 'bkg_kmax'],
  kmin: ['kmin', 'kmax'], kmax: ['kmin', 'kmax'],
  rmin: ['rmin', 'rmax'], rmax: ['rmin', 'rmax'],
}

export function contextValues(group: AthenaGroup, draft: Parameters): Parameters {
  const result = { ...draft }
  for (const key of ['e0', 'step', 'pre1', 'pre2', 'norm1', 'norm2', 'nnorm', 'bkg_kmax', 'kmax'] as const) {
    const value = group.result?.effective[key === 'step' ? 'edge_step' : key]
    if (result[key] === null && typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  return result
}

export function groupImportance(group: AthenaGroup): number {
  const value = group.source.importance ?? (group.source.native as { args?: { importance?: unknown } } | undefined)?.args?.importance
  const number = Number(value ?? 1)
  return Number.isFinite(number) && number >= 0 ? number : 1
}

export function groupPixelRatio(group: AthenaGroup): number | null {
  for (const key of ['xdi_metadata', 'beamline_metadata']) {
    const metadata = group.source[key] as { attributes?: { bla?: { pixel_ratio?: unknown } } } | undefined
    const value = metadata?.attributes?.bla?.pixel_ratio
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) continue
    const number = Number(value)
    if (Number.isFinite(number) && number >= 0) return number
  }
  return null
}

// Quoted keys/scalars and flow-style scalar arrays are valid YAML 1.2. Quoting
// keeps untrusted acquisition text as data, including strings such as "yes".
export function groupYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (!value.length || value.every(item => item === null || typeof item !== 'object')) return JSON.stringify(value)
    return value.map(item => `${pad}- ${groupYaml(item, indent + 2).trimStart()}`).join('\n')
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (!entries.length) return '{}'
    return entries.map(([key, item]) => {
      const nested = !!item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0
      const nestedArray = Array.isArray(item) && item.some(row => row && typeof row === 'object')
      return `${pad}${JSON.stringify(key)}:${nested || nestedArray ? '\n' : ' '}${groupYaml(item, indent + 2)}`
    }).join('\n')
  }
  return JSON.stringify(value ?? null)
}
