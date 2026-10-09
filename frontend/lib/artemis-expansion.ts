import type { ArtemisModelDraft, ArtemisParameter } from "./artemis"
import { planArtemisParameterSync } from "./artemis-parameters"

export interface ExpansionOptions {
  value: string
}

/** Fit fractional expansion against the path's fixed FEFF effective half-path length. */
export function planExpansionInsertion(draft: ArtemisModelDraft, pathId: string, options: ExpansionOptions) {
  const path = draft.paths.find(item => item.id === pathId)
  if (!path?.enabled) throw new Error("Include this path before inserting a ΔR model.")
  if (!Number.isFinite(path.metadata?.reff) || path.metadata.reff <= 0) {
    throw new Error("Isotropic expansion requires a positive finite FEFF R_eff.")
  }
  const value = Number(options.value)
  if (!options.value.trim() || !Number.isFinite(value) || value <= -1) {
    throw new Error("Fractional expansion α must be a finite number greater than −1 so the path length stays positive.")
  }

  const used = new Set(draft.parameters.map(item => item.name.trim()))
  // Reserve unsynchronized names, including excluded paths, to avoid coupling paths by accident.
  const expressions = [...draft.parameters.map(item => item.expression),
    ...draft.paths.flatMap(item => [item.s02, item.e0, item.deltar, item.sigma2])]
  for (const expression of expressions) for (const name of expression.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []) used.add(name)
  let suffix = 1
  while (used.has(`alpha_${suffix}`)) suffix++
  const alphaName = `alpha_${suffix}`
  const added: ArtemisParameter[] = [{ name: alphaName, value, kind: "guess",
    // The closest representable number above −1 admits every valid starting value.
    min: -1 + Number.EPSILON / 2, max: null, expression: "" }]
  const expression = `${alphaName} * reff`
  const paths = draft.paths.map(item => item.id === pathId ? { ...item, deltar: expression } : item)
  const sync = planArtemisParameterSync([...draft.parameters, ...added], paths)
  return { paths, added: [...added, ...sync.added], removed: sync.removed, expression, alphaName }
}
