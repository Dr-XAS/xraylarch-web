import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { athenaApi, type EdgeCatalog, type EdgePolicy } from "@/lib/athena"
import { EdgePolicyControls, EdgePolicyDialog } from "./athena-edge-policy"

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

function setup() {
  const apply = vi.fn(), close = vi.fn()
  const rendered = render(<EdgePolicyDialog policy={null} apply={apply} close={close} />)
  const dialog = screen.getByRole("dialog", { name: "Enforce element and edge" })
  return { ...rendered, apply, close, dialog, view: within(dialog) }
}
function typeElement(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Element symbol" }), { target: { value } })
}
async function lookupCu() {
  api.mockResolvedValueOnce(cu)
  typeElement("cu")
  fireEvent.click(screen.getByRole("button", { name: "Look up edges" }))
  await screen.findByRole("option", { name: "K · 8979 eV" })
  fireEvent.change(screen.getByRole("combobox", { name: "Enforced edge" }), { target: { value: "K" } })
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function ImportControls({ initial = null, busy = false, apply, close }: {
  initial?: EdgePolicy | null; busy?: boolean; apply: (policy: EdgePolicy | null) => void; close?: () => void
}) {
  const [policy, setPolicy] = useState(initial)
  return <dialog open aria-label="Import spectra" onCancel={close}>
    <EdgePolicyControls policy={policy} busy={busy} apply={next => { setPolicy(next); apply(next) }} />
  </dialog>
}

describe("Athena import policy controls", () => {
  it("keeps the import dialog open on cancel and activates only after applying the editor", async () => {
    const apply = vi.fn(), close = vi.fn()
    render(<ImportControls apply={apply} close={close} />)
    const details = screen.getByText("Advanced import settings").closest("details")!
    expect(details).not.toHaveAttribute("open")
    fireEvent.click(screen.getByText("Advanced import settings"))
    const checkbox = screen.getByRole("checkbox", { name: "Enforce element and edge" })
    fireEvent.click(checkbox)
    let editor = screen.getByRole("dialog", { name: "Enforce element and edge" })
    expect(checkbox).not.toBeChecked()
    fireEvent(editor, new Event("cancel", { cancelable: true, bubbles: true }))
    expect(close).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "Import spectra" })).toBeInTheDocument()
    expect(screen.queryByRole("dialog", { name: "Enforce element and edge" })).not.toBeInTheDocument()
    fireEvent.click(checkbox)
    editor = screen.getByRole("dialog", { name: "Enforce element and edge" })
    await lookupCu()
    fireEvent.click(within(editor).getByRole("button", { name: "Apply enforcement" }))
    expect(apply).toHaveBeenCalledExactlyOnceWith({ element: "Cu", edge: "K", fraction: 0.5 })
    expect(checkbox).toBeChecked()
    expect(screen.getByText("Cu K · fraction 0.5")).toBeInTheDocument()
    expect(screen.queryByRole("dialog", { name: "Enforce element and edge" })).not.toBeInTheDocument()
  })

  it("allows an active policy to be disabled during import while blocking enabling and editing", () => {
    const apply = vi.fn()
    render(<ImportControls initial={{ element: "Cu", edge: "K", fraction: 0.5 }} busy apply={apply} />)
    expect(screen.getByText("Advanced import settings").closest("details")).toHaveAttribute("open")
    const checkbox = screen.getByRole("checkbox", { name: "Enforce element and edge" })
    expect(checkbox).toBeEnabled()
    expect(screen.getByRole("button", { name: "Edit element and edge…" })).toBeDisabled()
    fireEvent.click(checkbox)
    expect(apply).toHaveBeenCalledExactlyOnceWith(null)
    expect(checkbox).not.toBeChecked()
    expect(checkbox).toBeDisabled()
  })

  it("opens the current policy for editing without changing it on cancel", () => {
    const apply = vi.fn()
    render(<ImportControls initial={{ element: "Fe", edge: "K", fraction: 0.7 }} apply={apply} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit element and edge…" }))
    const editor = within(screen.getByRole("dialog", { name: "Enforce element and edge" }))
    expect(editor.getByRole("textbox", { name: "Element symbol" })).toHaveValue("Fe")
    expect(editor.getByRole("spinbutton", { name: "Edge-step fraction" })).toHaveValue(0.7)
    fireEvent.click(editor.getByRole("button", { name: "Cancel" }))
    expect(apply).not.toHaveBeenCalled()
    expect(screen.getByRole("checkbox", { name: "Enforce element and edge" })).toBeChecked()
    expect(screen.getByText("Fe K · fraction 0.7")).toBeInTheDocument()
  })
})

describe("Athena edge policy catalog", () => {
  it("requires a catalog edge choice, canonicalizes the symbol, and only activates on Apply", async () => {
    const { apply, close, view } = setup()
    expect(api).not.toHaveBeenCalled()
    expect(view.getByRole("button", { name: "Apply enforcement" })).toBeDisabled()
    await lookupCu()
    expect(api.mock.calls).toEqual([["/edges?element=Cu"]])
    expect(view.getByRole("textbox", { name: "Element symbol" })).toHaveValue("Cu")
    expect(view.getByRole("option", { name: "L3 · 932.7 eV" })).toBeInTheDocument()
    expect(apply).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole("button", { name: "Apply enforcement" }))
    expect(apply).toHaveBeenCalledExactlyOnceWith({ element: "Cu", edge: "K", fraction: 0.5 })
    expect(close).toHaveBeenCalledOnce()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("rejects invalid fractions, accepts 1 and permits only returned edge choices", async () => {
    const { apply, view } = setup()
    await lookupCu()
    for (const value of ["", "0", "-0.1", "1.1", "Infinity"]) {
      fireEvent.change(view.getByRole("spinbutton", { name: "Edge-step fraction" }), { target: { value } })
      fireEvent.click(view.getByRole("button", { name: "Apply enforcement" }))
      expect(view.getByRole("alert")).toHaveTextContent("greater than 0 and at most 1")
      expect(apply).not.toHaveBeenCalled()
    }
    fireEvent.change(view.getByRole("spinbutton", { name: "Edge-step fraction" }), { target: { value: "1" } })
    fireEvent.change(view.getByRole("combobox", { name: "Enforced edge" }), { target: { value: "M5" } })
    fireEvent.click(view.getByRole("button", { name: "Apply enforcement" }))
    expect(apply).not.toHaveBeenCalled()
    fireEvent.change(view.getByRole("combobox", { name: "Enforced edge" }), { target: { value: "L3" } })
    fireEvent.click(view.getByRole("button", { name: "Apply enforcement" }))
    expect(apply).toHaveBeenCalledExactlyOnceWith({ element: "Cu", edge: "L3", fraction: 1 })
  })

  it.each(["unknown", "empty", "mismatch", "invalid-energy"] as const)("shows a recoverable %s catalog failure without enabling enforcement", async failure => {
    const { apply, view } = setup()
    typeElement(failure === "unknown" ? "Xx" : "Cu")
    if (failure === "unknown") api.mockRejectedValueOnce(new Error("Unknown absorbing element Xx"))
    else api.mockResolvedValueOnce(failure === "empty" ? { element: "Cu", edges: [] } : failure === "mismatch" ? fe : { element: "Cu", edges: [{ edge: "K", energy: -1 }] })
    fireEvent.click(view.getByRole("button", { name: "Look up edges" }))
    expect(await view.findByRole("alert")).toHaveTextContent(failure === "unknown" ? /Unknown absorbing/ : /no valid choices/)
    expect(view.getByRole("button", { name: "Apply enforcement" })).toBeDisabled()
    expect(apply).not.toHaveBeenCalled()
    if (failure === "unknown") typeElement("Cu")
    api.mockResolvedValueOnce(cu)
    fireEvent.click(view.getByRole("button", { name: "Look up edges" }))
    await view.findByRole("option", { name: "K · 8979 eV" })
    fireEvent.change(view.getByRole("combobox", { name: "Enforced edge" }), { target: { value: "K" } })
    fireEvent.click(view.getByRole("button", { name: "Apply enforcement" }))
    expect(apply).toHaveBeenCalledExactlyOnceWith({ element: "Cu", edge: "K", fraction: 0.5 })
    expect(api.mock.calls).toEqual([[failure === "unknown" ? "/edges?element=Xx" : "/edges?element=Cu"], ["/edges?element=Cu"]])
  })

  it.each(["success", "failure"] as const)("locks dismissal during lookup and ignores a stale %s after the query changes", async outcome => {
    const { apply, close, view, dialog } = setup()
    const old = deferred<EdgeCatalog>()
    api.mockReturnValueOnce(old.promise)
    typeElement("Cu")
    fireEvent.click(view.getByRole("button", { name: "Look up edges" }))
    expect(view.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(view.getByRole("button", { name: "Apply enforcement" })).toBeDisabled()
    fireEvent.click(view.getByRole("button", { name: "Close dialog" }))
    fireEvent(dialog, new Event("cancel", { cancelable: true }))
    expect(close).not.toHaveBeenCalled()
    typeElement("Fe")
    api.mockResolvedValueOnce(fe)
    fireEvent.click(view.getByRole("button", { name: "Look up edges" }))
    await view.findByRole("option", { name: "K · 7112 eV" })
    fireEvent.change(view.getByRole("combobox", { name: "Enforced edge" }), { target: { value: "K" } })
    await act(async () => { if (outcome === "success") old.resolve(cu); else old.reject(new Error("Obsolete Cu lookup failure")) })
    expect(view.queryByRole("option", { name: "K · 8979 eV" })).not.toBeInTheDocument()
    expect(view.queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.click(view.getByRole("button", { name: "Apply enforcement" }))
    expect(apply).toHaveBeenCalledExactlyOnceWith({ element: "Fe", edge: "K", fraction: 0.5 })
  })

  it("cancels catalog choices without changing policy", async () => {
    const { apply, close, view } = setup()
    await lookupCu()
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(close).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()
    expect(api.mock.calls).toEqual([["/edges?element=Cu"]])
  })

  it("does not reuse a completed catalog after editing the element", async () => {
    const { view, apply } = setup()
    await lookupCu()
    typeElement("Fe")
    expect(view.getByRole("combobox", { name: "Enforced edge" })).toBeDisabled()
    fireEvent.click(view.getByRole("button", { name: "Apply enforcement" }))
    expect(apply).not.toHaveBeenCalled()
    expect(api).toHaveBeenCalledTimes(1)
  })
})
