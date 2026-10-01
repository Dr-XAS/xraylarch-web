"use client"

import { useEffect, useState } from "react"
import { artemisApi } from "./artemis"
import type { ArtemisStructure } from "./artemis-structures"
import type { FirstShell } from "./first-shell"

export interface FirstShellState { shell: FirstShell | null; loading: boolean; error: string; retry: () => void }

export function useFirstShell(structure: ArtemisStructure | null, siteIndex: number | undefined, enabled = true): FirstShellState {
  const cif = structure?.cif
  const absorber = structure?.sites.find(site => site.index === siteIndex)?.element
  const supported = structure?.supported
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ cif: string; siteIndex: number; shell?: FirstShell; error?: string } | null>(null)
  useEffect(() => {
    if (!enabled || !cif || !absorber || !supported || siteIndex === undefined) return
    const abort = new AbortController()
    setResult(null)
    artemisApi<FirstShell>("/structures/first-shell", { cif, absorber, site_index: siteIndex }, abort.signal)
      .then(shell => {
        if (abort.signal.aborted) return
        if (shell.cif !== cif || shell.method !== "CrystalNN" || shell.site_index !== siteIndex || shell.absorber !== absorber ||
            !Array.isArray(shell.neighbors) || shell.coordination_number !== shell.neighbors.length) throw new Error("CrystalNN returned a different CIF or absorber site. Retry the analysis.")
        setResult({ cif, siteIndex, shell })
      }).catch(error => { if (!abort.signal.aborted) setResult({ cif, siteIndex, error: error instanceof Error ? error.message : "CrystalNN analysis failed." }) })
    return () => abort.abort()
  }, [cif, absorber, siteIndex, supported, enabled, attempt])
  const current = enabled && supported && absorber && result?.cif === cif && result?.siteIndex === siteIndex ? result : null
  return { shell: current?.shell ?? null, error: current?.error ?? "",
    loading: !!(enabled && cif && absorber && supported && siteIndex !== undefined && !current),
    retry: () => { setResult(null); setAttempt(value => value + 1) } }
}
