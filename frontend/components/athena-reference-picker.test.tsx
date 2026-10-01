import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AthenaGroup } from "@/lib/athena"
import { AthenaReferencePicker } from "./athena-reference-picker"

afterEach(cleanup)

const group = (id: string, extra: Partial<AthenaGroup> = {}) => ({
  id, label: id, data_type: "mu", reference_id: null, source: {}, ...extra,
}) as AthenaGroup
const groups = [group("Scan 1"), group("Scan 2"), group("Cu foil"), group("Imported chi", { data_type: "chi" })]

function setup(data = groups, initialSampleIds = ["Scan 1", "Scan 2"]) {
  const onApply = vi.fn(), onClose = vi.fn()
  const props = { groups: data, initialSampleIds, busy: false, error: "", onApply, onClose }
  return { ...render(<AthenaReferencePicker {...props} />), props, onApply, onClose }
}

describe("Athena reference assignment", () => {
  it("links multiple explicitly selected spectra to one reference", () => {
    const { onApply } = setup()
    expect(screen.getByRole("button", { name: "Assign reference" })).toBeDisabled()
    expect(screen.queryByRole("option", { name: "Imported chi" })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole("combobox", { name: "Reference foil" }), { target: { value: "Cu foil" } })
    expect(screen.getByRole("checkbox", { name: "Link Cu foil" })).toBeDisabled()
    expect(screen.getByText("Selected reference · excluded from data to link")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Assign reference" }))
    expect(onApply).toHaveBeenCalledExactlyOnceWith(["Scan 1", "Scan 2"], "Cu foil")
  })

  it("allows a marked spectrum to become the reference without self-linking", () => {
    const { onApply } = setup(groups, ["Scan 1", "Scan 2", "Cu foil"])
    fireEvent.change(screen.getByRole("combobox", { name: "Reference foil" }), { target: { value: "Cu foil" } })
    expect(screen.getByRole("checkbox", { name: "Link Cu foil" })).not.toBeChecked()
    expect(screen.getByText("2 selected")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Link Scan 2" }))
    fireEvent.click(screen.getByRole("button", { name: "Assign reference" }))
    expect(onApply).toHaveBeenCalledExactlyOnceWith(["Scan 1"], "Cu foil")
  })

  it("shows existing shared links and removes only checked spectra", () => {
    const linked = groups.map(item => item.id.startsWith("Scan") ? { ...item, reference_id: "Cu foil" } : item)
    const { onApply } = setup(linked)
    expect(screen.getByRole("combobox", { name: "Reference foil" })).toHaveValue("Cu foil")
    expect(screen.getAllByText("Reference: Cu foil")).toHaveLength(2)
    fireEvent.change(screen.getByRole("combobox", { name: "Reference foil" }), { target: { value: "" } })
    fireEvent.click(screen.getByRole("checkbox", { name: "Link Scan 2" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove reference" }))
    expect(onApply).toHaveBeenCalledExactlyOnceWith(["Scan 1"], null)
  })

  it("requires a target and keeps a backend validation error visible for correction", () => {
    const { rerender, props, onApply } = setup(groups, ["Cu foil"])
    fireEvent.change(screen.getByRole("combobox", { name: "Reference foil" }), { target: { value: "Cu foil" } })
    expect(screen.getByRole("button", { name: "Assign reference" })).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox", { name: "Link Scan 1" }))
    rerender(<AthenaReferencePicker {...props} error="Reference links cannot form a cycle." />)
    expect(screen.getByRole("alert")).toHaveTextContent("Reference links cannot form a cycle.")
    expect(screen.getByRole("checkbox", { name: "Link Scan 1" })).toBeChecked()
    expect(onApply).not.toHaveBeenCalled()
  })

  it("locks edits and submission while the request is pending", () => {
    const { rerender, props, onApply, onClose } = setup()
    fireEvent.change(screen.getByRole("combobox", { name: "Reference foil" }), { target: { value: "Cu foil" } })
    rerender(<AthenaReferencePicker {...props} busy />)
    expect(screen.getByRole("combobox", { name: "Reference foil" })).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: "Link Scan 1" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    fireEvent.submit(screen.getByRole("button", { name: "Applying…" }).closest("form")!)
    expect(onApply).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
