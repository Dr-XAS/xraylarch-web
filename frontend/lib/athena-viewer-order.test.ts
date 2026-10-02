import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { moveViewer, normalizeViewerOrder, orderViewers, readViewerOrderPreference, viewerIds, viewerOrderStorageKey, writeViewerOrderPreference } from "./athena-viewer-order"

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

  it("uses custom positions for available viewers without forcing spectra first", () => {
    const custom = ["fit", "wavelet", "multiple", "single", "cif", "feff"] as const
    expect(orderViewers(viewerIds, "custom", { cif: 100 }, custom)).toEqual(custom)
    expect(orderViewers(["single", "multiple", "wavelet"], "custom", {}, custom)).toEqual(["wavelet", "multiple", "single"])
    expect(orderViewers(viewerIds, "default", {}, custom)).toEqual(viewerIds)
    expect(orderViewers(viewerIds, "custom", {})).toEqual(viewerIds)
  })
})

describe("manual viewer ordering", () => {
  it("repairs partial or malformed saved orders while keeping the first valid position", () => {
    expect(normalizeViewerOrder(["fit", "unknown", "single", "fit", null, 3, "wavelet"])).toEqual([
      "fit", "single", "wavelet", "multiple", "cif", "feff",
    ])
    for (const value of [null, undefined, "fit", { order: ["fit"] }, []]) {
      expect(normalizeViewerOrder(value)).toEqual(viewerIds)
    }
  })

  it("moves to the target position in either direction without changing its input", () => {
    const order = ["single", "multiple", "wavelet"] as const
    expect(moveViewer(order, "single", "wavelet")).toEqual(["multiple", "wavelet", "single"])
    expect(moveViewer(order, "wavelet", "single")).toEqual(["wavelet", "single", "multiple"])
    expect(moveViewer(order, "single", "multiple")).toEqual(["multiple", "single", "wavelet"])
    expect(order).toEqual(["single", "multiple", "wavelet"])
  })

  it("leaves the order intact for a missing source or target and for a drop on itself", () => {
    const order = ["single", "wavelet"] as const
    expect(moveViewer(order, "fit", "single")).toEqual(order)
    expect(moveViewer(order, "single", "fit")).toEqual(order)
    expect(moveViewer(order, "wavelet", "wavelet")).toEqual(order)
  })
})

describe("viewer order preference", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it("restores custom order and appends viewers missing from an older preference", () => {
    localStorage.setItem(viewerOrderStorageKey, JSON.stringify({ sort: "custom", order: ["fit", "single", "fit", "removed"] }))
    expect(readViewerOrderPreference()).toEqual({ sort: "custom", order: ["fit", "single", "multiple", "wavelet", "cif", "feff"] })
    writeViewerOrderPreference("custom", ["wavelet", "single", "multiple"])
    expect(readViewerOrderPreference()).toEqual({ sort: "custom", order: ["wavelet", "single", "multiple", "cif", "feff", "fit"] })
  })

  it("falls back safely for malformed stored data and unrecognized sort modes", () => {
    expect(readViewerOrderPreference()).toEqual({ sort: "default", order: [...viewerIds] })
    for (const value of ["{", "null", "5", '"custom"', "[]", '{"sort":"process","order":null}']) {
      localStorage.setItem(viewerOrderStorageKey, value)
      expect(readViewerOrderPreference()).toEqual({ sort: "default", order: [...viewerIds] })
    }
  })

  it("does not restore the process mode in a new session and retains the custom positions", () => {
    writeViewerOrderPreference("process", ["fit", "single", "multiple", "wavelet", "cif", "feff"])
    expect(readViewerOrderPreference()).toEqual({ sort: "default", order: ["fit", "single", "multiple", "wavelet", "cif", "feff"] })
  })

  it("continues to work when browser storage access is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError") })
    expect(readViewerOrderPreference()).toEqual({ sort: "default", order: [...viewerIds] })
    expect(() => writeViewerOrderPreference("custom", ["fit"])).not.toThrow()
  })
})
