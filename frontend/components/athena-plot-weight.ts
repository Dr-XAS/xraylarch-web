"use client"

import { useCallback, useEffect, useState } from "react"
import { type AthenaGroup, type AthenaResult } from "@/lib/athena"
import { useAthenaApi } from "@/lib/athena-context"
import type { PlotSpace } from "./athena-plot-range"

export interface PlotWeightResult extends AthenaResult {
  project_id: string
  version: number
  group_id: string
  kweight: number
}

interface Options {
  projectId?: string
  version?: number
  groups: AthenaGroup[]
  kWeight: number | null
  space: PlotSpace
  pending?: boolean
}

function finiteArray(values: unknown): values is number[] {
  return Array.isArray(values) && values.every(value => typeof value === "number" && Number.isFinite(value))
}

function usable(group: AthenaGroup) {
  const arrays = group.result?.arrays
  return !group.processing_error && finiteArray(arrays?.k) && arrays.k.length >= 2 &&
    finiteArray(arrays?.chi) && arrays.k.length === arrays.chi.length
}

function hasSavedTransform(group: AthenaGroup, space: "R" | "q") {
  const arrays = group.result?.arrays
  const axis = arrays?.[space === "R" ? "r" : "q"]
  const prefix = space === "R" ? "chir" : "chiq"
  return !!axis?.length && ["re", "im", "mag", "pha"].some(component => arrays?.[`${prefix}_${component}`]?.length === axis.length)
}

function validTransform(data: PlotWeightResult, space: "R" | "q", weight: number) {
  if (!data.arrays || !data.effective || data.effective.kweight !== weight ||
    !Object.values(data.arrays).every(finiteArray) || !Array.isArray(data.warnings) ||
    !data.warnings.every(warning => typeof warning === "string")) return false
  const axis = data.arrays[space === "R" ? "r" : "q"]
  const prefix = space === "R" ? "chir" : "chiq"
  return finiteArray(axis) && axis.length >= 2 &&
    axis.every((value, index) => value >= 0 && (index === 0 || value > axis[index - 1])) &&
    ["re", "im", "mag", "pha"].every(component => data.arrays[`${prefix}_${component}`]?.length === axis.length)
}

/** Display-only Fourier products; saved processing parameters and project groups stay untouched. */
export function useAthenaPlotWeight({ projectId, version, groups, kWeight, space, pending = false }: Options) {
  const athenaApi = useAthenaApi()
  const [attempt, setAttempt] = useState(0)
  const [response, setResponse] = useState<{
    key: string
    signal: AbortSignal
    transforms?: Map<string, PlotWeightResult>
    error?: string
  } | null>(null)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const selection = JSON.stringify(groups.map(group => [group.id, usable(group)]))
  const explicitTransform = kWeight !== null && (space === "R" || space === "q")
  const blockedGroup = explicitTransform ? groups.find(group => !usable(group) && hasSavedTransform(group, space)) : undefined
  const processingError = blockedGroup && !pending
    ? `Reprocess ${blockedGroup.label} before changing its plot k-weight.` : null
  const canTransform = explicitTransform && groups.some(usable)
  const contextError = canTransform && !pending && (!projectId || version === undefined)
    ? "Open a saved project revision to calculate this k-weight." : null
  const ready = canTransform && !blockedGroup && !pending && !!projectId && version !== undefined
  const key = JSON.stringify([projectId, version, kWeight, space, selection, pending, attempt])
  // Aborting also invalidates a completed response. Returning from pending or Auto
  // must never briefly reveal a transform retained from the preceding request.
  const current = ready && response?.key === key && !response.signal.aborted ? response : null

  useEffect(() => {
    if (!ready || !projectId || version === undefined || kWeight === null || (space !== "R" && space !== "q")) return
    const abort = new AbortController()
    const ids = (JSON.parse(selection) as [string, boolean][]).filter(([, eligible]) => eligible).map(([id]) => id)
    const timer = window.setTimeout(async () => {
      try {
        const entries = await Promise.all(ids.map(async id => {
          const data = await athenaApi<PlotWeightResult>(`/projects/${projectId}/groups/${id}/plot-transform`, {
            version, kweight: kWeight,
          }, "POST", abort.signal)
          if (!data || data.project_id !== projectId || data.version !== version || data.group_id !== id ||
            data.kweight !== kWeight || !validTransform(data, space, kWeight)) {
            throw new Error("The plot transform does not match the selected spectrum and k-weight. Try again.")
          }
          return [id, data] as const
        }))
        if (!abort.signal.aborted) setResponse({ key, signal: abort.signal, transforms: new Map(entries) })
      } catch (error) {
        if (!abort.signal.aborted) setResponse({ key, signal: abort.signal,
          error: error instanceof Error ? error.message : "Could not calculate the plot transform." })
      }
    }, 150)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [key, ready, projectId, version, kWeight, space, selection])

  const transformedGroups = current?.transforms ? groups.map(group => {
    const transform = current.transforms?.get(group.id)
    if (!transform || !group.result) return group
    return { ...group, result: {
      ...group.result,
      arrays: { ...group.result.arrays, ...transform.arrays },
      effective: { ...group.result.effective, ...transform.effective },
      warnings: [...new Set([...group.result.warnings, ...transform.warnings])],
    } }
  }) : groups

  return {
    groups: transformedGroups,
    loading: (canTransform || !!blockedGroup) && (pending || (ready && !current)),
    error: processingError ?? contextError ?? current?.error ?? null,
    retry,
  }
}
