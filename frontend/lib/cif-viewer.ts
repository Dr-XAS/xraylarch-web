import type { ArtemisStructure } from "./artemis-structures"

export type CifVector = [number, number, number]
export type CifLattice = [CifVector, CifVector, CifVector]
export interface CifViewerAtom {
  element: string
  label: string
  siteIndex: number
  occupancy: number
  x: number
  y: number
  z: number
  distance: number
  isAbsorber: boolean
}
export interface CifGeometry {
  atoms: CifViewerAtom[]
  cellEdges: [CifVector, CifVector][]
  lattice: CifLattice | null
  center: CifVector
  radius: number
  warnings: string[]
  truncated: boolean
}
export interface CifGeometryOptions {
  siteIndex?: number
  absorber?: string
  radius?: number
  mode?: "cluster" | "cell"
  maxAtoms?: number
}

export const CIF_VIEWER_MIN_RADIUS = 1
export const CIF_VIEWER_MAX_RADIUS = 10
export const CIF_VIEWER_DEFAULT_RADIUS = 3.5
const MAX_CELL_ATOMS = 4000
const MAX_CANDIDATES = 250_000
const MAX_CIF_LENGTH = 2_000_000
const MAX_SYMMETRY_OPERATIONS = 384
const TOLERANCE = 1e-6
type StructureSite = ArtemisStructure["sites"][number]
type SymmetryCoordinate = [number, number, number, number]
type SymmetryOperation = [SymmetryCoordinate, SymmetryCoordinate, SymmetryCoordinate]
const IDENTITY: SymmetryOperation = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]
const SYMMETRY_TAGS = new Set([
  "_space_group_symop_operation_xyz", "_space_group_symop.operation_xyz",
  "_symmetry_equiv_pos_as_xyz", "_symmetry_equiv.pos_as_xyz",
])

function dot(a: CifVector, b: CifVector) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function cross(a: CifVector, b: CifVector): CifVector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function norm(v: CifVector) { return Math.hypot(...v) }
function subtract(a: CifVector, b: CifVector): CifVector { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function cartesian(frac: CifVector, lattice: CifLattice): CifVector {
  return [0, 1, 2].map(axis => frac.reduce((sum, value, i) => sum + value * lattice[i][axis], 0)) as CifVector
}
function wrapped(value: number) {
  const result = ((value % 1) + 1) % 1
  return result < TOLERANCE || result > 1 - TOLERANCE ? 0 : result
}

/** Conventional fractional-to-Cartesian basis, including oblique cells. */
function latticeVectors(cell: ArtemisStructure["cell"]): CifLattice | null {
  const { a, b, c, alpha, beta, gamma } = cell
  if (![a, b, c, alpha, beta, gamma].every(value => typeof value === "number" && Number.isFinite(value))) return null
  if (a! <= 0 || b! <= 0 || c! <= 0 || [alpha!, beta!, gamma!].some(value => value <= 0 || value >= 180)) return null
  const [ca, cb, cg] = [alpha!, beta!, gamma!].map(value => Math.cos(value * Math.PI / 180))
  const sg = Math.sin(gamma! * Math.PI / 180)
  const cy = (ca - cb * cg) / sg
  const cz2 = 1 - cb * cb - cy * cy
  // Do not turn an impossible/degenerate cell into a misleading flat structure.
  if (Math.abs(sg) < 1e-8 || cz2 <= 1e-12) return null
  const result: CifLattice = [[a!, 0, 0], [b! * cg, b! * sg, 0], [c! * cb, c! * cy, c! * Math.sqrt(cz2)]]
  return result.every(vector => vector.every(Number.isFinite)) && Math.abs(dot(result[0], cross(result[1], result[2]))) > 1e-9 ? result : null
}

/** A bounded CIF tokenizer: quoted/semicolon text must not be interpreted as tags. */
function cifTokens(text: string): { value: string; quoted: boolean }[] {
  const tokens: { value: string; quoted: boolean }[] = []
  let multiline = false
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(";")) {
      if (!multiline) tokens.push({ value: "", quoted: true })
      multiline = !multiline
      continue
    }
    if (multiline) continue
    let offset = 0
    while (offset < line.length) {
      if (/\s/.test(line[offset])) { offset++; continue }
      if (line[offset] === "#") break
      const quote = line[offset] === "'" || line[offset] === '"' ? line[offset++] : null
      const start = offset
      if (quote) {
        while (offset < line.length && !(line[offset] === quote && (offset + 1 === line.length || /\s|#/.test(line[offset + 1])))) offset++
        if (offset === line.length) throw new Error("The CIF contains an unterminated quoted value.")
        tokens.push({ value: line.slice(start, offset), quoted: true })
        offset++
      } else {
        while (offset < line.length && !/\s/.test(line[offset])) offset++
        tokens.push({ value: line.slice(start, offset), quoted: false })
      }
      if (tokens.length > 250_000) throw new Error("This CIF is too large for the structure preview.")
    }
  }
  if (multiline) throw new Error("The CIF contains an unterminated text field.")
  return tokens
}

function parseCoordinate(value: string): SymmetryCoordinate {
  const expression = value.toLowerCase().replace(/\s/g, "")
  const terms = expression.match(/[+-]?[^+-]+/g)
  if (!terms || terms.join("") !== expression) throw new Error("Unsupported CIF symmetry operation.")
  const result: SymmetryCoordinate = [0, 0, 0, 0]
  for (const term of terms) {
    const variable = term.match(/^([+-]?)(x|y|z)$/)
    if (variable) {
      result["xyz".indexOf(variable[2])] += variable[1] === "-" ? -1 : 1
      continue
    }
    const constant = term.match(/^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:\/(\d+(?:\.\d*)?|\.\d+))?$/)
    if (!constant) throw new Error("Unsupported CIF symmetry operation.")
    const denominator = constant[3] === undefined ? 1 : Number(constant[3])
    const number = Number(constant[2]) / denominator * (constant[1] === "-" ? -1 : 1)
    if (!Number.isFinite(number) || Math.abs(number) > 100) throw new Error("Invalid CIF symmetry translation.")
    result[3] += number
  }
  if (result.slice(0, 3).some(value => Math.abs(value) > 1)) throw new Error("Unsupported CIF symmetry operation.")
  return result
}

function symmetryOperations(text: string): SymmetryOperation[] {
  if (text.length > MAX_CIF_LENGTH) throw new Error("This CIF is too large for the structure preview.")
  const tokens = cifTokens(text)
  const values: string[] = []
  const control = (token: { value: string; quoted: boolean }) => !token.quoted && /^(?:_|loop_$|stop_$|data_|save_)/i.test(token.value)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.quoted) continue
    if (token.value.toLowerCase() === "loop_") {
      const headers: string[] = []
      while (tokens[i + 1] && !tokens[i + 1].quoted && tokens[i + 1].value.startsWith("_")) headers.push(tokens[++i].value.toLowerCase())
      const symmetryColumn = headers.findIndex(header => SYMMETRY_TAGS.has(header))
      let column = 0
      while (tokens[i + 1] && !control(tokens[i + 1])) {
        const value = tokens[++i].value
        if (symmetryColumn >= 0 && column % headers.length === symmetryColumn) values.push(value)
        column++
        if (values.length > MAX_SYMMETRY_OPERATIONS) throw new Error("Too many symmetry operations for the structure preview.")
      }
      if (symmetryColumn >= 0 && column % headers.length !== 0) throw new Error("The CIF symmetry loop is incomplete.")
    } else if (SYMMETRY_TAGS.has(token.value.toLowerCase()) && tokens[i + 1] && !control(tokens[i + 1])) {
      values.push(tokens[++i].value)
    }
  }
  return values.length ? values.map(value => {
    const pieces = value.split(",")
    if (pieces.length !== 3) throw new Error("Unsupported CIF symmetry operation.")
    const operation = pieces.map(parseCoordinate) as SymmetryOperation
    const rotation = operation.map(row => row.slice(0, 3)) as CifLattice
    if (Math.abs(Math.abs(dot(rotation[0], cross(rotation[1], rotation[2]))) - 1) > TOLERANCE) throw new Error("Invalid CIF symmetry rotation.")
    return operation
  }) : [IDENTITY]
}

function unitCellSites(structure: ArtemisStructure): { site: StructureSite; frac: CifVector }[] {
  if (structure.sites.length > MAX_CELL_ATOMS) throw new Error("Too many sites for the structure preview.")
  const operations = symmetryOperations(structure.cif)
  const atoms: { site: StructureSite; frac: CifVector }[] = []
  for (const site of structure.sites) {
    if (![site.x, site.y, site.z, site.occupancy, site.multiplicity].every(Number.isFinite) || site.occupancy <= 0 || site.multiplicity < 1) throw new Error("The CIF contains invalid site coordinates or occupancies.")
    const positions = new Map<string, CifVector>()
    for (const operation of operations) {
      const frac = operation.map(row => wrapped(row[0] * site.x + row[1] * site.y + row[2] * site.z + row[3])) as CifVector
      positions.set(frac.map(value => Math.round(value / TOLERANCE)).join(","), frac)
    }
    // Backend sites are symmetry-unique representatives, never all cell atoms.
    // Refuse incomplete expansion rather than drawing a scientifically wrong crystal.
    if (positions.size !== site.multiplicity) throw new Error("The CIF symmetry operations do not reproduce the complete unit cell. A structure preview is unavailable for this CIF.")
    for (const frac of positions.values()) atoms.push({ site, frac })
    if (atoms.length > MAX_CELL_ATOMS) throw new Error("Too many unit-cell atoms for the structure preview.")
  }
  return atoms
}

/** Build display geometry only; FEFF parameters and the attached CIF are untouched. */
export function buildCifGeometry(structure: ArtemisStructure, options: CifGeometryOptions = {}): CifGeometry {
  const radius = Math.min(CIF_VIEWER_MAX_RADIUS, Math.max(CIF_VIEWER_MIN_RADIUS, Number.isFinite(options.radius) ? options.radius! : CIF_VIEWER_DEFAULT_RADIUS))
  const maxAtoms = Math.min(MAX_CELL_ATOMS, Math.max(1, Number.isFinite(options.maxAtoms) ? Math.floor(options.maxAtoms!) : 1500))
  const geometry: CifGeometry = { atoms: [], cellEdges: [], lattice: latticeVectors(structure.cell), center: [0, 0, 0], radius, warnings: [], truncated: false }
  const lattice = geometry.lattice
  if (!lattice) { geometry.warnings.push("The CIF does not contain a valid, non-degenerate unit cell."); return geometry }
  try {
    const sites = unitCellSites(structure)
    const selected = structure.sites.find(site => (options.siteIndex === undefined || site.index === options.siteIndex) && (!options.absorber || site.element === options.absorber))
    if (!selected) throw new Error("The selected absorber site is not available in this CIF.")
    const centerFrac: CifVector = [wrapped(selected.x), wrapped(selected.y), wrapped(selected.z)]
    geometry.center = cartesian(centerFrac, lattice)
    for (let corner = 0; corner < 8; corner++) {
      const frac: CifVector = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1]
      for (let axis = 0; axis < 3; axis++) {
        if (frac[axis]) continue
        const endpoint: CifVector = [...frac]
        endpoint[axis] = 1
        geometry.cellEdges.push([subtract(cartesian(frac, lattice), geometry.center), subtract(cartesian(endpoint, lattice), geometry.center)])
      }
    }
    const makeAtom = (site: StructureSite, frac: CifVector): CifViewerAtom => {
      const [x, y, z] = cartesian(subtract(frac, centerFrac), lattice)
      const distance = Math.hypot(x, y, z)
      return { element: site.element, label: `${site.element}${site.index}`, siteIndex: site.index, occupancy: site.occupancy, x, y, z, distance, isAbsorber: site.index === selected.index && site.element === selected.element && distance < TOLERANCE }
    }
    if (options.mode === "cell") {
      geometry.atoms = sites.map(({ site, frac }) => makeAtom(site, frac))
    } else {
      // Reciprocal lengths bound fractional displacements for a sphere even in
      // monoclinic/triclinic cells, where dividing by a/b/c misses neighbors.
      const volume = Math.abs(dot(lattice[0], cross(lattice[1], lattice[2])))
      const extents = [cross(lattice[1], lattice[2]), cross(lattice[2], lattice[0]), cross(lattice[0], lattice[1])].map(vector => radius * norm(vector) / volume + TOLERANCE)
      const ranges = sites.map(({ frac }) => frac.map((value, axis) => [Math.ceil(centerFrac[axis] - value - extents[axis]), Math.floor(centerFrac[axis] - value + extents[axis])]))
      const candidates = ranges.reduce((sum, range) => sum + range.reduce((count, [min, max]) => count * Math.max(0, max - min + 1), 1), 0)
      if (!Number.isFinite(candidates) || candidates > MAX_CANDIDATES) throw new Error("Too many periodic images at this radius. Choose a smaller display radius.")
      for (let index = 0; index < sites.length; index++) {
        const { site, frac } = sites[index]
        const [rx, ry, rz] = ranges[index]
        for (let x = rx[0]; x <= rx[1]; x++) for (let y = ry[0]; y <= ry[1]; y++) for (let z = rz[0]; z <= rz[1]; z++) {
          const atom = makeAtom(site, [frac[0] + x, frac[1] + y, frac[2] + z])
          if (atom.distance <= radius + TOLERANCE) geometry.atoms.push(atom)
        }
      }
    }
    geometry.atoms.sort((left, right) => Number(right.isAbsorber) - Number(left.isAbsorber) || left.distance - right.distance)
    if (geometry.atoms.length > maxAtoms) {
      geometry.atoms = geometry.atoms.slice(0, maxAtoms)
      geometry.truncated = true
      geometry.warnings.push(`The preview is limited to the ${maxAtoms} atoms nearest the selected site.`)
    }
    if (structure.sites.some(site => Math.abs(site.occupancy - 1) > TOLERANCE)) geometry.warnings.push("Partially occupied sites are shown at their crystallographic positions; no random substitution is applied.")
  } catch (error) {
    geometry.atoms = []
    geometry.warnings.push(error instanceof Error ? error.message : "This CIF cannot be displayed.")
  }
  return geometry
}
