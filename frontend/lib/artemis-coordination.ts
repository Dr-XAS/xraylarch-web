import type { ArtemisModelDraft, ArtemisParameter } from "./artemis"
import { planArtemisParameterSync } from "./artemis-parameters"

export interface CoordinationOptions {
  value: string
  s02: string
  refine: boolean
  max: string
}

function number(text: string, label: string, positive = false) {
  const value = Number(text)
  if (!text.trim() || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${label} must be a finite ${positive ? "positive" : "nonnegative"} number.`)
  }
  return value
}

/** Replace one single-scattering amplitude expression without changing FEFF or shared GDS values. */
export function planCoordinationInsertion(draft: ArtemisModelDraft, pathId: string, options: CoordinationOptions) {
  const path = draft.paths.find(item => item.id === pathId)
  if (!path?.enabled) throw new Error("Include this path before defining its coordination number.")
  if (path.metadata?.nleg !== 2 || !Number.isFinite(path.metadata.degen) || path.metadata.degen <= 0) {
    throw new Error("Coordination number requires a two-leg single-scattering path with positive FEFF degeneracy.")
  }
  const value = number(options.value, "Coordination number")
  const s02 = number(options.s02, "Fixed S₀²", true)
  const max = options.refine && options.max.trim() ? number(options.max, "Maximum coordination number", true) : null
  if (max !== null && max < value) throw new Error("Maximum coordination number must be at least the starting value.")

  const added: ArtemisParameter[] = []
  const used = new Set(draft.parameters.map(item => item.name.trim()))
  // Unsynchronized references, including excluded paths, must not acquire these new values.
  const expressions = [...draft.parameters.map(item => item.expression),
    ...draft.paths.flatMap(item => [item.s02, item.e0, item.deltar, item.sigma2])]
  for (const expression of expressions) for (const name of expression.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []) used.add(name)
  const add = (prefix: string, value: number, kind: "set" | "guess", min: number | null = null, max: number | null = null) => {
    let suffix = 1
    while (used.has(`${prefix}_${suffix}`)) suffix++
    const name = `${prefix}_${suffix}`
    used.add(name)
    added.push({ name, value, kind, min, max, expression: "" })
    return name
  }
  const coordinationName = add("cn", value, options.refine ? "guess" : "set", options.refine ? 0 : null, max)
  const amplitudeName = add("s02", s02, "set")
  // Larch already multiplies the path by FEFF degeneracy, so divide it out exactly once.
  const expression = `${amplitudeName} * ${coordinationName} / degen`
  const paths = draft.paths.map(item => item.id === pathId ? { ...item, s02: expression } : item)
  const sync = planArtemisParameterSync([...draft.parameters, ...added], paths)
  return { paths, added: [...added, ...sync.added], removed: sync.removed, expression, coordinationName, amplitudeName }
}
