import type { ArtemisParameter, ArtemisPath } from "./artemis"

type Definition = Pick<ArtemisParameter, "name" | "kind" | "expression">
type PathExpressions = Pick<ArtemisPath, "enabled" | "s02" | "e0" | "deltar" | "sigma2">
type PathField = "s02" | "e0" | "deltar" | "sigma2"
const fields: PathField[] = ["s02", "e0", "deltar", "sigma2"]
// Match the numerical grammar in backend/xraylarch_web/artemis.py. This only
// discovers references; expression evaluation remains in the Larch backend.
const functions = new Set(["sqrt", "exp", "log", "sin", "cos", "tan", "abs"])
const constants = new Set(["pi", "e"])
const pathNames = new Set(["reff", "degen", "nleg"])
const reserved = new Set([
  "rmass", "rnorman", "gam_ch", "rs_int", "vint", "vmu", "vfermi", "nan", "inf", "skip",
  "items", "keys", "values", "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from",
  "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield",
])
const numberToken = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

function references(expression: string, allowPathNames: boolean): string[] {
  const fail = (): never => { throw new Error(`Cannot sync expression “${expression}”. Use parameter names, numbers, arithmetic, or sqrt/exp/log/sin/cos/tan/abs.`) }
  if (!expression.trim() || expression.length > 256) fail()
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|\*\*|\S/g) ?? []
  const names = new Set<string>()
  let index = 0
  function atom(): void {
    const token = tokens[index++]
    if (!token) fail()
    if (token === "(") {
      sum()
      if (tokens[index++] !== ")") fail()
    } else if (numberToken.test(token)) {
      if (!Number.isFinite(Number(token)) || Math.abs(Number(token)) > 1e12) fail()
    } else if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(token)) {
      if (tokens[index] === "(") {
        if (!functions.has(token)) fail()
        index++
        sum()
        if (tokens[index++] !== ")") fail()
      } else if (constants.has(token) || (allowPathNames && pathNames.has(token))) {
        // Built-in constants and FEFF metadata are not fit parameters.
      } else {
        if (functions.has(token) || pathNames.has(token) || reserved.has(token)) fail()
        names.add(token)
      }
    } else fail()
  }
  function factor(): void {
    if (tokens[index] === "+" || tokens[index] === "-") { index++; factor(); return }
    atom()
    if (tokens[index] === "**") {
      index++
      let parentheses = 0
      while (tokens[index] === "(") { index++; parentheses++ }
      if (tokens[index] === "+" || tokens[index] === "-") index++
      const exponent = tokens[index++]
      if (!exponent || !/^\d+$/.test(exponent) || Number(exponent) > 8) fail()
      while (parentheses-- > 0) if (tokens[index++] !== ")") fail()
    }
  }
  function product(): void {
    factor()
    while (tokens[index] === "*" || tokens[index] === "/") { index++; factor() }
  }
  function sum(): void {
    product()
    while (tokens[index] === "+" || tokens[index] === "-") { index++; product() }
  }
  sum()
  if (index !== tokens.length) fail()
  return [...names]
}

function startingParameter(name: string, field?: PathField): ArtemisParameter {
  const defaults = {
    s02: { value: 1, min: 0, max: 2 },
    e0: { value: 0, min: -20, max: 20 },
    deltar: { value: 0, min: -0.2, max: 0.2 },
    sigma2: { value: 0.003, min: 0, max: 0.1 },
  }
  return { name, kind: "guess", expression: "", ...(field ? defaults[field] : { value: 1, min: null, max: null }) }
}

/** Plan a complete sync before changing the editable draft, so errors are atomic. */
export function planArtemisParameterSync(parameters: Definition[], paths: PathExpressions[]): { added: ArtemisParameter[]; removed: string[] } {
  const included = paths.filter(path => path.enabled)
  if (!included.length) throw new Error("Include at least one FEFF path before syncing parameters.")
  const definitions = new Map<string, Definition>()
  for (const parameter of parameters) {
    const name = parameter.name.trim()
    if (definitions.has(name)) throw new Error(`Parameter name “${name}” is used more than once. Rename it before syncing.`)
    definitions.set(name, parameter)
  }
  const required = new Set<string>()
  const visiting = new Set<string>()
  const added = new Map<string, ArtemisParameter>()
  function visit(name: string, field?: PathField) {
    if (visiting.has(name)) throw new Error(`Def parameter “${name}” has a circular dependency. Correct it before syncing.`)
    if (required.has(name)) {
      // A direct path reference provides physical defaults even when the name
      // was first discovered in a composite expression or Def dependency.
      if (field && added.has(name)) added.set(name, startingParameter(name, field))
      return
    }
    required.add(name)
    const existing = definitions.get(name)
    if (!existing) added.set(name, startingParameter(name, field))
    else if (existing.kind === "def") {
      visiting.add(name)
      for (const dependency of references(existing.expression, false)) visit(dependency)
      visiting.delete(name)
    }
  }
  for (const path of included) {
    for (const field of fields) {
      for (const name of references(path[field], true)) visit(name, path[field].trim() === name ? field : undefined)
    }
  }
  if (required.size > 32) throw new Error(`This model needs ${required.size} parameters; the limit is 32. Simplify the path expressions before syncing.`)
  return { added: [...added.values()], removed: parameters.map(parameter => parameter.name.trim()).filter(name => !required.has(name)) }
}
