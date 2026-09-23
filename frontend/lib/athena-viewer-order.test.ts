import { describe, expect, it } from "vitest"
import { orderViewers, viewerIds } from "./athena-viewer-order"

describe("viewer ordering", () => {
  it("uses the requested order for a loaded project without processing times", () => {
    expect(orderViewers(viewerIds, "default", {})).toEqual(["spectrum", "wavelet", "cif", "feff", "fit"])
    expect(orderViewers(viewerIds, "process", {})).toEqual(["spectrum", "wavelet", "cif", "feff", "fit"])
  })

  it("orders recorded processing events chronologically, then keeps the stable fallback", () => {
    expect(orderViewers(viewerIds, "process", { cif: 100, fit: 300, feff: 200 })).toEqual(["spectrum", "cif", "feff", "fit", "wavelet"])
    expect(orderViewers(viewerIds, "process", { wavelet: 200, cif: 200 })).toEqual(["spectrum", "wavelet", "cif", "feff", "fit"])
    expect(orderViewers(["spectrum", "wavelet"], "process", { cif: 100 })).toEqual(["spectrum", "wavelet"])
    expect(orderViewers(viewerIds, "default", { fit: 100, cif: 300 })).toEqual(["spectrum", "wavelet", "cif", "feff", "fit"])
  })
})
