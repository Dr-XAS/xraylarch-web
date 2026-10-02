import type { ArtemisModelDraft, ArtemisParameter } from "./artemis"
import { planArtemisParameterSync } from "./artemis-parameters"

export type DisorderModel = "guess" | "set" | "einstein" | "debye"
export interface DisorderOptions {
  model: DisorderModel
  value: string
  temperature: string
  theta: string
  staticOffset: boolean
  staticValue: string
  refineTheta: boolean
}

function number(text: string, label: string, positive = false) {
  const value = Number(text)
  if (!text.trim() || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${label} must be a finite ${positive ? "positive" : "nonnegative"} number.`)
  }
  return value
}

/** Build one atomic edit; fresh names never overwrite existing GDS values. */
export function planDisorderInsertion(draft: ArtemisModelDraft, pathId: string, options: DisorderOptions) {
  const path = draft.paths.find(item => item.id === pathId)
  if (!path?.enabled) throw new Error("Include this path before inserting a σ² model.")
  const thermal = options.model === "einstein" || options.model === "debye"
  const added: ArtemisParameter[] = []
  const used = new Set(draft.parameters.map(item => item.name.trim()))
  // Reserve even unsynchronized references to avoid silently coupling paths.
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
  let expression: string
  if (thermal) {
    const temperature = add("temperature", number(options.temperature, "Sample temperature (K)"), "set")
    const theta = add(options.model === "einstein" ? "theta_e" : "theta_d",
      number(options.theta, "Characteristic temperature (K)", true), options.refineTheta ? "guess" : "set",
      options.refineTheta ? 1.e-5 : null)
    expression = `${options.model === "einstein" ? "sigma2_eins" : "sigma2_debye"}(${temperature}, ${theta})`
    if (options.staticOffset) expression = `${add("sig2_static", number(options.staticValue, "Static σ² (Å²)"), "set")} + ${expression}`
  } else {
    expression = add("sig2", number(options.value, "σ² (Å²)"), options.model === "guess" ? "guess" : "set",
      options.model === "guess" ? 0 : null)
  }
  const paths = draft.paths.map(item => item.id === pathId ? { ...item, sigma2: expression } : item)
  const sync = planArtemisParameterSync([...draft.parameters, ...added], paths)
  return { paths, added: [...added, ...sync.added], removed: sync.removed, expression }
}
