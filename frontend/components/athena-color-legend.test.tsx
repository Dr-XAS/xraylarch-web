import "@testing-library/jest-dom/vitest"

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AthenaColorLegend } from "./athena-color-legend"

beforeEach(() => localStorage.clear())

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("AthenaColorLegend", () => {
  it("uses the colorbar itself as the palette picker without a visible control name", () => {
    const onChange = vi.fn()
    const { container } = render(<AthenaColorLegend
      value={{ palette: "classic", reversed: false }} onChange={onChange}
    />)
    const group = screen.getByRole("group", { name: "Spectrum colors" })
    const palette = within(group).getByRole("combobox", { name: "Color legend" })
    const picker = palette.closest(".ath-color-ramp-picker")

    expect(within(group).queryByText("Color legend")).not.toBeInTheDocument()
    expect(group).toHaveTextContent("First")
    expect(group).toHaveTextContent("Last")
    expect(palette).toHaveAttribute("aria-expanded", "false")
    expect(picker).toContainElement(container.querySelector(".ath-color-ramp"))
    expect(picker?.querySelector("svg")).toHaveAttribute("aria-hidden", "true")

    fireEvent.click(palette)
    expect(screen.getByRole("listbox", { name: "Color legend" })).toBeInTheDocument()
    expect(screen.getAllByRole("option")).toHaveLength(12)
    expect(screen.getByRole("option", { name: "Viridis · purple–green–yellow" }).querySelector<HTMLElement>(".ath-cmap-ramp")?.style.background).toContain("#440154")
    expect(screen.getByRole("listbox")).not.toHaveTextContent("Viridis")
    fireEvent.click(screen.getByRole("option", { name: "Viridis · purple–green–yellow" }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ palette: "viridis", reversed: false })
    expect(localStorage.getItem("athena.plot-colors")).toBe(JSON.stringify({ palette: "viridis", reversed: false }))
  })

  it("restores and saves the single viewer palette without overwriting the multiple viewer", () => {
    const multiple = { palette: "viridis", reversed: true }
    const single = { palette: "plasma" as const, reversed: false }
    localStorage.setItem("athena.plot-colors", JSON.stringify(multiple))
    localStorage.setItem("athena.plot-colors.single", JSON.stringify(single))
    const onChange = vi.fn()
    render(<AthenaColorLegend value={single} onChange={onChange} storageKey="athena.plot-colors.single" />)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(single)
    fireEvent.click(screen.getByRole("checkbox", { name: "Reverse" }))
    expect(localStorage.getItem("athena.plot-colors.single")).toBe(JSON.stringify({ ...single, reversed: true }))
    expect(localStorage.getItem("athena.plot-colors")).toBe(JSON.stringify(multiple))
  })

  it("supports keyboard selection and dismisses the preview menu", () => {
    const onChange = vi.fn()
    render(<AthenaColorLegend value={{ palette: "classic", reversed: false }} onChange={onChange} />)
    const picker = screen.getByRole("combobox", { name: "Color legend" })
    fireEvent.keyDown(picker, { key: "Enter" })
    fireEvent.keyDown(picker, { key: "ArrowDown" })
    fireEvent.keyDown(picker, { key: "ArrowDown" })
    expect(picker).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Viridis · purple–green–yellow" }).id)
    fireEvent.keyDown(picker, { key: "Enter" })
    expect(onChange).toHaveBeenCalledWith({ palette: "viridis", reversed: false })
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    fireEvent.click(picker)
    fireEvent.keyDown(picker, { key: "Escape" })
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("keeps the colorbar picker unavailable with the rest of a disabled legend", () => {
    render(<AthenaColorLegend
      value={{ palette: "classic", reversed: false }} onChange={vi.fn()} disabled
    />)

    expect(screen.getByRole("group", { name: "Spectrum colors" })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("combobox", { name: "Color legend" })).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: "Reverse" })).toBeDisabled()
  })
})
