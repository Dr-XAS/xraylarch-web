import { expect, it } from "vitest"
import { labelParts } from "./athena-labels"

it("keeps the scan number of series names in the unshortened tail, so 29 scans do not read the same", () => {
  expect(labelParts("sample_Cu_EXAFS_series.0017")).toEqual({ head: "sample_Cu_EXAFS_series", tail: ".0017" })
  expect(labelParts("sample_Cu_EXAFS_series.0017 · reference")).toEqual({ head: "sample_Cu_EXAFS_series", tail: ".0017 · reference" })
  expect(labelParts("Foil scan")).toEqual({ head: "Foil scan", tail: "" })
  expect(labelParts("0017")).toEqual({ head: "0017", tail: "" })
  // A digit inside a word is not a scan number: "synthetic.h5" stays whole.
  expect(labelParts("synthetic.h5 · Mn fluorescence μ(E)")).toEqual({ head: "synthetic.h5 · Mn fluorescence μ(E)", tail: "" })
})

it("keeps what distinguishes groups made from one long-named file, not just its name", () => {
  // The fitted and window-sum XRF groups both shortened to the same file-name prefix.
  const file = "scan_2026-01-01_8elem_0a1b2c.hdf"
  expect(labelParts(`${file} · Mn fluorescence · window sum`)).toEqual({ head: file, tail: " · Mn fluorescence · window sum" })
  expect(labelParts(`${file} · Mn fluorescence`)).toEqual({ head: file, tail: " · Mn fluorescence" })
})
