import type { ArtemisFitResult, ArtemisPath, ArtemisPathMetadata } from "./artemis"

type FittedPath = ArtemisFitResult["paths"][number]
type FittedParameter = ArtemisFitResult["parameters"][number]
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const sameValue = (left: number, right: number) => Math.abs(left - right) <= 1e-8 * Math.max(1, Math.abs(left), Math.abs(right))

export function savedPathExpressions(result: ArtemisFitResult, path: FittedPath) {
  return result.request?.paths.find(item => item.enabled && item.id === path.id && item.filename === path.filename)
}

/** Only a direct reference has a saved standard error for the evaluated path value. */
export function directPathParameter(result: ArtemisFitResult, path: FittedPath, field: "deltar" | "sigma2") {
  const expression = savedPathExpressions(result, path)?.[field] ?? (field === "sigma2" ? path.sigma2_expression : undefined)
  const parameter = result.parameters.find(item => item.name === expression?.trim())
  const value = path.values?.[field]
  return parameter && finite(value) && finite(parameter.value) && sameValue(value, parameter.value) ? parameter : undefined
}

export interface FitCoordination {
  value: number | null
  source: "parameter" | "feff" | "unavailable" | "multiple"
  parameter?: FittedParameter
}

/** FEFF already includes N. Multiplying its degeneracy by s02 gives N·S₀², not CN. */
export function fitPathCoordination(result: ArtemisFitResult, path: FittedPath): FitCoordination {
  if (path.metadata.nleg !== 2) return { value: null, source: "multiple" }
  const degen = path.metadata.degen
  if (!finite(degen) || degen <= 0) return { value: null, source: "unavailable" }
  const expression = savedPathExpressions(result, path)?.s02.trim()
  const native = expression?.match(/^(s02_\d+)\s*\*\s*(cn_\d+)\s*\/\s*degen$/)
  if (native) {
    const amplitude = result.parameters.find(item => item.name === native[1])
    const parameter = result.parameters.find(item => item.name === native[2])
    if (amplitude?.kind === "set" && finite(amplitude.value) && amplitude.value > 0 &&
        parameter && finite(parameter.value) && parameter.value >= 0 && finite(path.values?.s02) &&
        sameValue(path.values.s02, amplitude.value * parameter.value / degen)) {
      return { value: parameter.value, source: "parameter", parameter }
    }
    return { value: null, source: "unavailable" }
  }
  return { value: degen, source: "feff" }
}

/** Enrich only the preview, using the archived fit model, never the current edited model. */
export function fitPreviewMetadata(path: FittedPath, savedPaths: readonly ArtemisPath[]): ArtemisPathMetadata {
  const saved = savedPaths.find(item => item.id === path.id && item.filename === path.filename)
  return saved?.metadata.viewerCluster
    ? { ...path.metadata, viewerCluster: saved.metadata.viewerCluster }
    : path.metadata
}
