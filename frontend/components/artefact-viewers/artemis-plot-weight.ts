"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { artemisApi, type ArtemisFitResult } from "@/lib/artemis"

export interface ArtemisPlotWeightResult {
  project_id: string
  group_id: string
  version: number
  kweight: number
  k: ArtemisFitResult["k"]
  r: ArtemisFitResult["r"]
  paths: Pick<ArtemisFitResult["paths"][number], "id" | "k" | "r">[]
  warnings: string[]
}

function finiteArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item))
}

function validPreview(data: ArtemisPlotWeightResult, source: ArtemisFitResult, weight: number) {
  const axis = (value: unknown) => finiteArray(value) && value.length > 1 &&
    value.every((item, index) => item >= 0 && (index === 0 || item > value[index - 1]))
  const series = (value: unknown, length: number) => finiteArray(value) && value.length === length
  if (!data.k || !data.r || data.k.weight !== weight || !axis(data.k.x) || !axis(data.r.x) ||
    ![data.k.data, data.k.model, data.k.residual].every(values => series(values, data.k.x.length)) ||
    ![data.r.data_mag, data.r.model_mag, data.r.residual_mag, data.r.data_re, data.r.model_re,
      data.r.residual_re, data.r.data_im, data.r.model_im, data.r.residual_im].every(values => series(values, data.r.x.length)) ||
    !Array.isArray(data.warnings) || !data.warnings.every(warning => typeof warning === "string") ||
    !Array.isArray(data.paths) || data.paths.length !== source.paths.length) return false
  return data.paths.every((path, index) => path.id === source.paths[index].id &&
    (!path.k || series(path.k.chi, data.k.x.length)) &&
    (!path.r || [path.r.mag, path.r.re, path.r.im].every(values => series(values, data.r.x.length))))
}

/** Retransform saved fit curves only; the fit and current spectrum stay untouched. */
export function useArtemisPlotWeight({ projectId, version, result, kWeight }: {
  projectId?: string
  version?: number
  result: ArtemisFitResult | null
  kWeight: number | null
}) {
  const [attempt, setAttempt] = useState(0)
  const [response, setResponse] = useState<{ key: string; data?: ArtemisPlotWeightResult; error?: string } | null>(null)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const explicit = !!result && kWeight !== null && kWeight !== result.k.weight
  const contextError = explicit && (!projectId || version === undefined)
    ? "Open the saved project to change this fit's plot k-weight." : null
  // Archive flags and reproducibility requests are UI context, not fit arrays.
  const source = result ? (({ archive: _archive, request: _request, ...saved }) => saved)(result) : null
  const sourceKey = JSON.stringify(source)
  const key = JSON.stringify([projectId, version, sourceKey, kWeight, attempt])
  const latest = useRef(key)
  latest.current = key
  const current = response?.key === key ? response : null

  useEffect(() => {
    if (!explicit || !projectId || version === undefined || kWeight === null) return
    const abort = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const saved = JSON.parse(sourceKey) as ArtemisFitResult
        const data = await artemisApi<ArtemisPlotWeightResult>(`/projects/${projectId}/groups/${saved.group_id}/plot-transform`, {
          version, kweight: kWeight, result: saved,
        }, abort.signal)
        if (!data || data.project_id !== projectId || data.group_id !== saved.group_id || data.version !== version ||
          data.kweight !== kWeight || !validPreview(data, saved, kWeight)) {
          throw new Error("The fit plot transform does not match this saved result and k-weight. Try again.")
        }
        if (!abort.signal.aborted && latest.current === key) setResponse({ key, data })
      } catch (error) {
        if (!abort.signal.aborted && latest.current === key) setResponse({ key,
          error: error instanceof Error ? error.message : "Could not calculate the fit plot transform." })
      }
    }, 150)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [explicit, projectId, version, sourceKey, kWeight, key])

  const data = explicit ? current?.data : null
  const plotted = useMemo(() => result && data ? { ...result, k: data.k, r: data.r,
    paths: result.paths.map((path, index) => ({ ...path, k: data.paths[index].k, r: data.paths[index].r })) } : result, [result, data])
  return {
    result: plotted,
    loading: explicit && !contextError && !current,
    error: contextError ?? (explicit ? current?.error : null) ?? null,
    warnings: data?.warnings ?? [],
    retry,
  }
}
