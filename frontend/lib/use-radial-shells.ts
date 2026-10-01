"use client"

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { artemisApi } from "./artemis"
import type { ArtemisStructure } from "./artemis-structures"
import { RADIAL_SHELL_DEFAULTS, type RadialShells } from "./radial-shells"

type Settings = { radius: number; tolerance: number }
// Shared by the docked viewer, FEFF dialog and model during this browser session.
// Exact CIF/site keys keep independent structures and centers independent.
const settingsBySite = new Map<string, Settings>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export interface RadialShellState {
  contextKey: string
  data: RadialShells | null; loading: boolean; error: string; retry: () => void
  settings: Settings; setSettings: (settings: Settings) => void
}

export function useRadialShells(structure: ArtemisStructure | null, siteIndex: number | undefined, enabled = true): RadialShellState {
  const cif = structure?.cif
  const absorber = structure?.sites.find(site => site.index === siteIndex)?.element
  const supported = structure?.supported
  const key = JSON.stringify([cif, siteIndex])
  const snapshot = useCallback(() => settingsBySite.get(key) ?? RADIAL_SHELL_DEFAULTS, [key])
  const settings = useSyncExternalStore(subscribe, snapshot, () => RADIAL_SHELL_DEFAULTS)
  const setSettings = useCallback((next: Settings) => {
    if (!Number.isFinite(next.radius) || next.radius < 0.5 || next.radius > 12 ||
        !Number.isFinite(next.tolerance) || next.tolerance < 0.001 || next.tolerance > 0.5) return
    settingsBySite.set(key, next)
    // Bound retained CIF snapshots. Mounted consumers re-read after eviction.
    if (settingsBySite.size > 32) settingsBySite.delete(settingsBySite.keys().next().value!)
    listeners.forEach(listener => listener())
  }, [key])
  const [attempt, setAttempt] = useState(0)
  const requestKey = JSON.stringify([key, settings.radius, settings.tolerance])
  const [result, setResult] = useState<{ key: string; data?: RadialShells; error?: string } | null>(null)
  useEffect(() => {
    if (!enabled || !cif || !absorber || !supported || siteIndex === undefined) return
    const abort = new AbortController()
    setResult(null)
    artemisApi<RadialShells>("/structures/radial-shells", { cif, absorber, site_index: siteIndex, ...settings }, abort.signal)
      .then(data => {
        if (abort.signal.aborted) return
        if (data.cif !== cif || data.site_index !== siteIndex || data.absorber !== absorber || data.method !== "complete_linkage" ||
            data.radius !== settings.radius || data.tolerance !== settings.tolerance || !Array.isArray(data.shells) || !Array.isArray(data.neighbors)) {
          throw new Error("Radial shell analysis returned a different CIF, site or range. Retry the analysis.")
        }
        setResult({ key: requestKey, data })
      }).catch(error => { if (!abort.signal.aborted) setResult({ key: requestKey, error: error instanceof Error ? error.message : "Radial shell analysis failed." }) })
    return () => abort.abort()
  }, [cif, absorber, siteIndex, supported, enabled, requestKey, settings, attempt])
  const active = !!(enabled && cif && absorber && supported && siteIndex !== undefined)
  const current = active && result?.key === requestKey ? result : null
  return { contextKey: key, data: current?.data ?? null, loading: active && !current, error: current?.error ?? "", settings, setSettings,
    retry: () => { setResult(null); setAttempt(value => value + 1) } }
}
