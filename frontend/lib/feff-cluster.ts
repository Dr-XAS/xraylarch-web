export interface FeffClusterAtom {
  atom: string
  x: number
  y: number
  z: number
  ipot: number
}

export interface FeffViewerCluster {
  source: "feff.inp"
  /** Absorber first, with all Cartesian coordinates in Å relative to it. */
  atoms: FeffClusterAtom[]
}

const ELEMENTS = ("X H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn " +
  "Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu " +
  "Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" ")
const MAX_ATOMS = 4000
const MAX_INPUT_LENGTH = 2_000_000
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[ed][+-]?\d+)?$/i
const SECTION_END_CARDS = new Set([
  "END", "TITLE", "EDGE", "HOLE", "CONTROL", "PRINT", "EXAFS", "XANES", "RPATH", "RMAX", "NLEG", "S02",
  "SCF", "FMS", "EXCHANGE", "POLARIZATION", "ELLIPTICITY", "CRITERIA", "DEBYE", "SIG2", "CORRECTIONS",
])

function number(token: string | undefined) {
  if (!token || !NUMBER.test(token)) return NaN
  return Number(token.replace(/[dD]/, "e"))
}

/**
 * Read actual ATOMS from completed FEFF provenance, never expand a path's degeneracy.
 * Invalid or unsupported input omits optional context without preventing path import.
 * POTENTIALS atomic numbers identify elements; atom tags may be arbitrary site labels.
 */
export function parseFeffCluster(input: string): FeffViewerCluster | undefined {
  if (typeof input !== "string" || input.length > MAX_INPUT_LENGTH) return undefined
  const potentials = new Map<number, string>()
  const coordinates: Omit<FeffClusterAtom, "atom">[] = []
  let section: "potentials" | "atoms" | null = null
  let sawPotentials = false, sawAtoms = false

  for (const original of input.split(/\r?\n/)) {
    const line = original.split(/[*!#]/, 1)[0].trim()
    if (!line) continue
    const fields = line.split(/\s+/)
    const card = fields[0].toUpperCase()
    if (card === "POTENTIALS" || card === "ATOMS") {
      if ((card === "POTENTIALS" && sawPotentials) || (card === "ATOMS" && sawAtoms)) return undefined
      section = card === "POTENTIALS" ? "potentials" : "atoms"
      if (section === "potentials") sawPotentials = true
      else sawAtoms = true
      continue
    }
    // FEFF can rescale coordinates. Unsupported scaling must not appear as Å.
    if (card === "RMULTIPLIER" && number(fields[1]) !== 1) return undefined
    if (SECTION_END_CARDS.has(card) || card === "RMULTIPLIER") {
      section = null
      if (card === "END") break
      continue
    }
    if (section === "potentials") {
      const ipot = number(fields[0]), atomicNumber = number(fields[1])
      if (!Number.isInteger(ipot) || ipot < 0 || ipot > MAX_ATOMS || potentials.has(ipot) ||
          !Number.isInteger(atomicNumber) || atomicNumber < 1 || atomicNumber >= ELEMENTS.length) return undefined
      potentials.set(ipot, ELEMENTS[atomicNumber])
    } else if (section === "atoms") {
      const x = number(fields[0]), y = number(fields[1]), z = number(fields[2]), ipot = number(fields[3])
      if (![x, y, z].every(Number.isFinite) || !Number.isInteger(ipot) || ipot < 0 || ipot > MAX_ATOMS ||
          coordinates.length >= MAX_ATOMS) return undefined
      coordinates.push({ x, y, z, ipot })
    }
  }

  const absorbers = coordinates.filter(atom => atom.ipot === 0)
  if (!sawPotentials || !sawAtoms || coordinates.length < 2 || absorbers.length !== 1 ||
      coordinates.some(atom => !potentials.has(atom.ipot))) return undefined
  const absorber = absorbers[0]
  const atoms = [absorber, ...coordinates.filter(atom => atom !== absorber)].map(atom => ({
    atom: potentials.get(atom.ipot)!, ipot: atom.ipot,
    x: atom.x - absorber.x, y: atom.y - absorber.y, z: atom.z - absorber.z,
  }))
  if (atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) return undefined
  return { source: "feff.inp", atoms }
}
