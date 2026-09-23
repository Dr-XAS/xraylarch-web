import { describe, expect, it } from "vitest"
import { orderViewers, viewerIds } from "./athena-viewer-order"

describe("viewer ordering", () => {
  it("uses the requested order for a loaded project without processing times", () => {
    expect(orderViewers(viewerIds, "default", {})).toEqual(["single", "multiple", "wavelet", "cif", "feff", "fit"])
    expect(orderViewers(viewerIds, "process", {})).toEqual(["single", "multiple", "wavelet", "cif", "feff", "fit"])
  })

  it("orders recorded processing events chronologically, then keeps the stable fallback", () => {
    expect(orderViewers(viewerIds, "process", { cif: 100, fit: 300, feff: 200 })).toEqual(["single", "multiple", "cif", "feff", "fit", "wavelet"])
    expect(orderViewers(viewerIds, "process", { wavelet: 200, cif: 200 })).toEqual(["single", "multiple", "wavelet", "cif", "feff", "fit"])
    expect(orderViewers(["single", "wavelet"], "process", { cif: 100 })).toEqual(["single", "wavelet"])
    expect(orderViewers(viewerIds, "default", { fit: 100, cif: 300 })).toEqual(["single", "multiple", "wavelet", "cif", "feff", "fit"])
  })

  it("keeps both spectrum viewers first regardless of their processing times or availability order", () => {
    expect(orderViewers(["multiple", "wavelet", "single"], "process", { multiple: 100, single: 300, wavelet: 50 })).toEqual(["single", "multiple", "wavelet"])
    expect(orderViewers(["wavelet", "multiple"], "process", { wavelet: 50 })).toEqual(["multiple", "wavelet"])
  })
})
