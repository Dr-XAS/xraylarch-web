import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { athenaApi, type AthenaGroup, type EdgeCatalog } from "@/lib/athena"
import { EdgeIdentityDialog, currentEdgeIdentity, edgeIdentityDescription } from "./athena-edge-identity"

vi.mock("@/lib/athena", async original => ({ ...await original<typeof import("@/lib/athena")>(), athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const cu = { element: "Cu", edges: [{ edge: "K", energy: 8979 }, { edge: "L3", energy: 932.7 }] }
const fe = { element: "Fe", edges: [{ edge: "K", energy: 7112 }] }
const descriptors = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
}
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", "") } })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open") } })
})
afterAll(() => {
  for (const name of ["showModal", "close"] as const) {
    const descriptor = descriptors[name]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})
beforeEach(() => { api.mockReset(); api.mockRejectedValue(new Error("Unexpected API request")) })
afterEach(cleanup)

function group(): AthenaGroup {
  return {
    id: "native-cu", label: "Native Cu foil", data_type: "mu", marked: false, frozen: false,
    energy: [8950, 8979, 9010], mu: [0, 0.5, 1], multiplier: 1, offset: 0, notes: "", reference_id: null,
    parameters: { e0: 8979, step: null, pre1: -150, pre2: -30, norm1: 100, norm2: 300, nnorm: 2, flatten: true,
      rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1, kmin: 3, kmax: 12,
      kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0, rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05 },
    source: { edge_identity: { element: "Cu", edge: "K", origin: "native" } }, processing_error: null,
    result: { arrays: { norm: [0, 0.5, 1] }, effective: { e0: 8979, element: "Cu", edge: "K" }, warnings: [] },
  }
}
function setup(initial = group()) {
  const props = { group: initial, busy: false, error: "", clearError: vi.fn(), save: vi.fn().mockResolvedValue(true), close: vi.fn() }
  const rendered = render(<EdgeIdentityDialog {...props} />)
  const dialog = screen.getByRole("dialog", { name: "Edit absorber and edge" })
  return { ...rendered, props, dialog, view: within(dialog) }
}
function typeElement(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Element symbol" }), { target: { value } })
}
async function lookupFe() {
  api.mockResolvedValueOnce(fe)
  typeElement("fe")
  fireEvent.click(screen.getByRole("button", { name: "Look up edges" }))
  await screen.findByRole("option", { name: "K · 7112 eV" })
  fireEvent.change(screen.getByRole("combobox", { name: "Absorption edge" }), { target: { value: "K" } })
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe("Athena current-group edge identity", () => {
  it("prefers native source identity, falls back to effective identity, and leaves missing identity Unknown", () => {
    const native = group()
    native.result!.effective = { element: "Fe", edge: "L3" }
    expect(currentEdgeIdentity(native)).toEqual({ element: "Cu", edge: "K", origin: "native" })
    expect(edgeIdentityDescription(native)).toBe("Cu K · native")
    native.source.edge_identity = { element: "Cu", edge: null }
    expect(currentEdgeIdentity(native)).toEqual({ element: "Fe", edge: "L3" })
    native.result = null
    expect(edgeIdentityDescription(native)).toBe("Unknown")
    expect(api).not.toHaveBeenCalled()
  })

  it("does no startup lookup and saves only the canonical pair without requiring scan coverage", async () => {
    const { props, view } = setup()
    expect(view.getByRole("textbox", { name: "Element symbol" })).toHaveValue("Cu")
    expect(view.queryByRole("spinbutton")).not.toBeInTheDocument()
    expect(view.getByRole("button", { name: "Save identity" })).toBeDisabled()
    expect(api).not.toHaveBeenCalled()
    await lookupFe() // Fe K lies outside this Cu scan; this is metadata, not E₀ selection.
    expect(api.mock.calls).toEqual([["/edges?element=Fe"]])
    expect(props.save).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Save identity" })) })
    expect(props.save).toHaveBeenCalledExactlyOnceWith("native-cu", { element: "Fe", edge: "K" })
    expect(props.close).toHaveBeenCalledOnce()
  })

  it("requires a valid returned edge and recovers from unknown elements without saving", async () => {
    const { props, view } = setup({ ...group(), source: {}, result: null })
    expect(view.getByText("Unknown")).toBeVisible()
    typeElement("Xx")
    api.mockRejectedValueOnce(new Error("Unknown absorbing element Xx"))
    fireEvent.click(view.getByRole("button", { name: "Look up edges" }))
    expect(await view.findByRole("alert")).toHaveTextContent("Unknown absorbing element Xx")
    expect(view.getByRole("button", { name: "Save identity" })).toBeDisabled()
    await lookupFe()
    expect(view.queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.change(view.getByRole("combobox", { name: "Absorption edge" }), { target: { value: "M5" } })
    fireEvent.submit(view.getByRole("button", { name: "Save identity" }).closest("form")!)
    expect(props.save).not.toHaveBeenCalled()
    fireEvent.change(view.getByRole("combobox", { name: "Absorption edge" }), { target: { value: "K" } })
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Save identity" })) })
    expect(props.save).toHaveBeenCalledExactlyOnceWith("native-cu", { element: "Fe", edge: "K" })
  })

  it.each(["success", "failure"] as const)("blocks dismissal during lookup and ignores stale %s after editing the symbol", async outcome => {
    const { props, view, dialog } = setup()
    const old = deferred<EdgeCatalog>()
    api.mockReturnValueOnce(old.promise)
    fireEvent.click(view.getByRole("button", { name: "Look up edges" }))
    expect(view.getByRole("button", { name: "Cancel" })).toBeDisabled()
    fireEvent.click(view.getByRole("button", { name: "Close dialog" }))
    fireEvent(dialog, new Event("cancel", { cancelable: true }))
    expect(props.close).not.toHaveBeenCalled()
    await lookupFe()
    await act(async () => { if (outcome === "success") old.resolve(cu); else old.reject(new Error("Obsolete Cu lookup")) })
    expect(view.queryByRole("option", { name: "K · 8979 eV" })).not.toBeInTheDocument()
    expect(view.queryByRole("alert")).not.toBeInTheDocument()
    expect(view.getByRole("combobox", { name: "Absorption edge" })).toHaveValue("K")
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(props.close).toHaveBeenCalledOnce()
    expect(props.save).not.toHaveBeenCalled()
  })

  it("does not save a catalog selection if the current group becomes frozen", async () => {
    const { props, view, rerender } = setup()
    await lookupFe()
    rerender(<EdgeIdentityDialog {...props} group={{ ...props.group, frozen: true }} />)
    expect(view.getByRole("button", { name: "Save identity" })).toBeDisabled()
    expect(view.getByRole("textbox", { name: "Element symbol" })).toBeDisabled()
    fireEvent.submit(view.getByRole("button", { name: "Save identity" }).closest("form")!)
    expect(props.save).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(props.close).toHaveBeenCalledOnce()
  })
})
