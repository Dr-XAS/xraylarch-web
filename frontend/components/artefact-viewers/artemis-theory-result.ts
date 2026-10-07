"use client"

import { useEffect, useRef, useState } from "react"
import { artemisApi } from "@/lib/artemis"
import type { AthenaGroup } from "@/lib/athena"
import { validArtemisPreview, type ArtemisPreview } from "@/lib/artemis-path-preview"
import type { SimulationResult } from "@/lib/artemis-simulation"

export interface ArtemisTheoryResult extends ArtemisPreview {
  project_id: string
  group_id: string
  group_label: string
  version: number
  simulation: Pick<SimulationResult["simulation"], "request" | "path_ids" | "available_paths" | "total_paths" | "assumptions">
}

/** Reconstruct the original saved simulation; never run a fit or require a live FEFF job. */
export function useArtemisTheoryResult({ projectId, version, group, kWeight }: {
  projectId?: string; version?: number; group?: AthenaGroup; kWeight: number | null
}) {
  const [attempt, setAttempt] = useState(0)
  const [response, setResponse] = useState<{ key: string; result?: ArtemisTheoryResult; error?: string } | null>(null)
  const groupId = group?.id
  const key = JSON.stringify([projectId, version, groupId, kWeight, attempt])
  const latest = useRef(key)
  latest.current = key
  const current = response?.key === key ? response : null
  const contextError = groupId && (!projectId || version === undefined) ? "Open the saved project to view this theory spectrum's path contributions." : null
  const runnable = !!groupId && !!projectId && version !== undefined

  useEffect(() => {
    if (!runnable) return
    const abort = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const result = await artemisApi<ArtemisTheoryResult>(`/projects/${projectId}/groups/${groupId}/simulation-view`, {
          version, kweight: kWeight,
        }, abort.signal)
        const info = result?.simulation
        if (!result || result.project_id !== projectId || result.group_id !== groupId || result.version !== version ||
          !info?.request?.transform || !Array.isArray(info.path_ids) || !info.path_ids.length ||
          result.k?.weight !== (kWeight ?? info.request.transform.kweight[0]) ||
          !validArtemisPreview(result, { paths: info.path_ids.map(id => ({ id, enabled: true })) }) ||
          !result.paths.every(path => path.metadata && [path.metadata.reff, path.metadata.degen, path.metadata.nleg,
            path.values?.s02, path.values?.sigma2, path.values?.e0, path.values?.deltar].every(value => typeof value === "number" && Number.isFinite(value))) ||
          !Array.isArray(result.warnings) || !result.warnings.every(item => typeof item === "string") ||
          !Array.isArray(info.assumptions) || !info.assumptions.every(item => typeof item === "string")) {
          throw new Error("The theory curves do not match this spectrum and k-weight. Try again.")
        }
        if (!abort.signal.aborted && latest.current === key) setResponse({ key, result })
      } catch (error) {
        if (!abort.signal.aborted && latest.current === key) setResponse({ key,
          error: error instanceof Error ? error.message : "Could not restore the theory path contributions." })
      }
    }, 150)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [runnable, projectId, version, groupId, kWeight, key])

  return { result: current?.result ?? null, loading: runnable && !current,
    error: contextError ?? current?.error ?? null, retry: () => setAttempt(value => value + 1) }
}
