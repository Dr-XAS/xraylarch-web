import { describe, expect, it } from "vitest"
import type { ArtemisFitResult, ArtemisPath } from "./artemis"
import { directPathParameter, fitPathCoordination, fitPreviewMetadata } from "./artemis-fit-summary"

function model() {
  const path: ArtemisFitResult["paths"][number] = {
    id: "path", filename: "feff0001.dat", label: "Cu–Cu", sigma2_expression: "sig2",
    metadata: { reff: 2.5, degen: 12, nleg: 2, absorber: "Cu", edge: "K", kmin: 0, kmax: 20,
      geometry: [{ atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }, { atom: "Cu", x: 2.5, y: 0, z: 0, ipot: 1 }] },
    values: { s02: .3, e0: 0, deltar: .01, sigma2: .003 },
  }
  const parameter = { name: "cn_7", kind: "guess" as const, value: 4, initial: 3, stderr: .2, expression: "", min: 0, max: 12 }
  const result = {
    paths: [path], parameters: [parameter, { ...parameter, name: "s02_2", value: .9, kind: "set" as const },
      { ...parameter, name: "dr", value: .01 }, { ...parameter, name: "sig2", value: .003 }],
    request: { paths: [{ id: path.id, filename: path.filename, enabled: true, s02: " s02_2 * cn_7 / degen ", deltar: "dr", sigma2: "sig2" }] },
  } as ArtemisFitResult
  return { path, result, request: result.request!.paths[0] }
}

describe("saved fit summary values", () => {
  it("reports explicit CN independently of the FEFF degeneracy and amplitude suffix", () => {
    const { path, result } = model()
    expect(fitPathCoordination(result, path)).toEqual({ value: 4, source: "parameter", parameter: result.parameters[0] })
    expect(fitPathCoordination(result, path).value).not.toBe(path.values!.s02 * path.metadata.degen)
    result.parameters[0].kind = "set"
    result.parameters[0].value = 0
    path.values!.s02 = 0
    expect(fitPathCoordination(result, path)).toMatchObject({ value: 0, source: "parameter" })
  })

  it("does not infer CN from arbitrary amplitude expressions, disabled paths or another file", () => {
    for (const expression of ["amp", "cn_7", "2 * s02_2 * cn_7 / degen", "s02_2 * cn_7 / degen + 1"]) {
      const { path, result, request } = model()
      request.s02 = expression
      expect(fitPathCoordination(result, path)).toEqual({ value: 12, source: "feff" })
    }
    for (const update of [{ enabled: false }, { id: "different" }, { filename: "feff0002.dat" }]) {
      const { path, result, request } = model()
      Object.assign(request, update)
      expect(fitPathCoordination(result, path)).toEqual({ value: 12, source: "feff" })
    }
    const { path, result } = model()
    delete result.request
    expect(fitPathCoordination(result, path)).toEqual({ value: 12, source: "feff" })
  })

  it("keeps missing, inconsistent and non-identifiable CN results unavailable", () => {
    for (const scenario of ["missing", "amplitude-varied", "negative", "nonfinite", "inconsistent", "no-values"] as const) {
      const { path, result } = model()
      if (scenario === "missing") result.parameters.shift()
      if (scenario === "amplitude-varied") result.parameters[1].kind = "guess"
      if (scenario === "negative") result.parameters[0].value = -1
      if (scenario === "nonfinite") result.parameters[0].value = NaN
      if (scenario === "inconsistent") path.values!.s02 = .6
      if (scenario === "no-values") delete path.values
      expect(fitPathCoordination(result, path), scenario).toEqual({ value: null, source: "unavailable" })
    }
    const { path, result } = model()
    path.metadata.nleg = 3
    expect(fitPathCoordination(result, path)).toEqual({ value: null, source: "multiple" })
    path.metadata.nleg = 2
    path.metadata.degen = 0
    expect(fitPathCoordination(result, path)).toEqual({ value: null, source: "unavailable" })
  })

  it("associates uncertainties only with matching, direct saved parameter references", () => {
    const { path, result, request } = model()
    expect(directPathParameter(result, path, "deltar")?.name).toBe("dr")
    request.deltar = "dr * reff"
    expect(directPathParameter(result, path, "deltar")).toBeUndefined()
    delete result.request
    expect(directPathParameter(result, path, "sigma2")?.name).toBe("sig2")
    path.values!.sigma2 = .004
    expect(directPathParameter(result, path, "sigma2")).toBeUndefined()
  })

  it("adds only archived preview context, leaving saved fit values and downloads untouched", () => {
    const { path } = model()
    const original = structuredClone(path)
    const saved = { ...path, metadata: { ...path.metadata, reff: 99,
      viewerCluster: { source: "feff.inp", atoms: path.metadata.geometry } } } as ArtemisPath
    const enriched = fitPreviewMetadata(path, [saved])
    expect(enriched.reff).toBe(2.5)
    expect(enriched.viewerCluster).toBe(saved.metadata.viewerCluster)
    expect(path).toEqual(original)
    expect(fitPreviewMetadata(path, [{ ...saved, filename: "different.dat" }])).toBe(path.metadata)
  })
})
