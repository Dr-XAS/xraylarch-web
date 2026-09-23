import { describe, expect, it } from "vitest"
import { parseFeffCluster } from "./feff-cluster"

const input = `TITLE Cobalt oxide
EDGE K
POTENTIALS
* ipot Z tag
0 27 Co
1 8 O
ATOMS
* x y z ipot tag distance site_info
1.0 2.0 3.0 0 Co 0.00000 * absorber
2.9 2.0 3.0 1 O 1.90000 * site A
1.0 0.1 3.0 1 O 1.90000 * site B
* END
`

describe("parseFeffCluster", () => {
  it("retains only actual input atoms and places the absorber at the origin", () => {
    const result = parseFeffCluster(input)
    expect(result?.source).toBe("feff.inp")
    expect(result?.atoms).toHaveLength(3)
    expect(result?.atoms[0]).toEqual({ atom: "Co", ipot: 0, x: 0, y: 0, z: 0 })
    expect(result?.atoms[1]).toEqual({ atom: "O", ipot: 1, x: 1.9, y: 0, z: 0 })
    expect(result?.atoms[2]).toEqual({ atom: "O", ipot: 1, x: 0, y: -1.9, z: 0 })
  })

  it("accepts case-insensitive cards, tabs, CRLF, Fortran exponents, comments, and arbitrary site tags", () => {
    const text = `title Iron\npotentials\n0 26 absorber_label\n1 26 neighbor_label\nRPATH 4\natoms\n1d0\t0.0\t.0\t1 Fe_2 ! comment\n0e0 0 -0 0 Fe_1 # absorber\nend\n999 bad ignored`
    expect(parseFeffCluster(text.replaceAll("\n", "\r\n"))?.atoms).toEqual([
      { atom: "Fe", ipot: 0, x: 0, y: 0, z: 0 },
      { atom: "Fe", ipot: 1, x: 1, y: 0, z: 0 },
    ])
  })

  it.each([
    ["missing sections", "TITLE Copper\nRPATH 4"],
    ["missing potentials", input.replace(/POTENTIALS[\s\S]+?ATOMS/, "ATOMS")],
    ["missing absorber", input.replace("1.0 2.0 3.0 0", "1.0 2.0 3.0 1")],
    ["multiple absorbers", input.replace("2.9 2.0 3.0 1", "2.9 2.0 3.0 0")],
    ["incomplete atom", input.replace("2.9 2.0 3.0 1 O 1.90000", "2.9 2.0")],
    ["unknown potential", input.replace("2.9 2.0 3.0 1", "2.9 2.0 3.0 9")],
    ["fractional potential", input.replace("2.9 2.0 3.0 1", "2.9 2.0 3.0 1.5")],
    ["duplicate potential", input.replace("1 8 O", "1 8 O\n1 27 Co")],
    ["invalid atomic number", input.replace("1 8 O", "1 0 O")],
    ["duplicate section", input + "ATOMS\n0 0 0 0"],
    ["coordinate scaling", "RMULTIPLIER 0.529\n" + input],
    ["incomplete potential", input.replace("1 8 O", "1")],
  ])("omits context for %s instead of inventing or partially rendering atoms", (_label, text) => {
    expect(parseFeffCluster(text)).toBeUndefined()
  })

  it.each(["NaN", "Infinity", "-Infinity", "1e309", "0xff", "2.9oops"])("rejects coordinate %s", coordinate => {
    expect(parseFeffCluster(input.replace("2.9 2.0 3.0", `${coordinate} 2.0 3.0`))).toBeUndefined()
  })

  it("rejects nonfinite normalization and bounded-input overflow without truncating a cluster", () => {
    expect(parseFeffCluster(input.replace("1.0 2.0 3.0 0", "-1e308 2.0 3.0 0").replace("2.9 2.0 3.0 1", "1e308 2.0 3.0 1"))).toBeUndefined()
    expect(parseFeffCluster(input + "1 0 0 1\n".repeat(4000))).toBeUndefined()
    expect(parseFeffCluster(input + " ".repeat(2_000_000))).toBeUndefined()
  })
})
