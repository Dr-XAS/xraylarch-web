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
    expect(within(palette).getByRole("option", { name: "Classic · categorical" })).toBeInTheDocument()
    expect(picker).toContainElement(container.querySelector(".ath-color-ramp"))
    expect(picker?.querySelector("svg")).toHaveAttribute("aria-hidden", "true")

    fireEvent.change(palette, { target: { value: "viridis" } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ palette: "viridis", reversed: false })
    expect(localStorage.getItem("athena.plot-colors")).toBe(JSON.stringify({ palette: "viridis", reversed: false }))
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
