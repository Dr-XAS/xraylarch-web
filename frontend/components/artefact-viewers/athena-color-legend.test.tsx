import "@testing-library/jest-dom/vitest"

import { useCallback, useState } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AthenaColorLegend } from "./athena-color-legend"
import type { PlotColorSettings } from "@/lib/athena-plot-colors"

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

  it("shows range arrows beneath the spectrum ramp and leaves Classic categorical colors unchanged", () => {
    render(<AthenaColorLegend value={{ palette: "classic", reversed: false }} onChange={vi.fn()} />)
    const minimum = screen.getByRole("slider", { name: "Color vmin" })
    const maximum = screen.getByRole("slider", { name: "Color vmax" })
    expect(minimum).toHaveAttribute("aria-valuenow", "0")
    expect(maximum).toHaveAttribute("aria-valuenow", "100")
    expect(minimum).toBeDisabled()
    expect(maximum).toBeDisabled()
    expect(minimum).toHaveAttribute("aria-description", "Choose a continuous palette to adjust the color range.")
    expect(minimum.closest(".ath-color-ramp-shell")).toContainElement(screen.getByRole("combobox", { name: "Color legend" }))
  })

  it("adjusts and persists continuous palette bounds with keyboard and pointer while preserving the selected palette", () => {
    const onChange = vi.fn()
    function ControlledLegend() {
      const [value, setValue] = useState<PlotColorSettings>({ palette: "viridis", reversed: false, vmin: 0.1, vmax: 0.9 })
      const handleChange = useCallback((next: PlotColorSettings) => { setValue(next); onChange(next) }, [])
      return <AthenaColorLegend value={value} onChange={handleChange} />
    }
    const { container } = render(<ControlledLegend />)
    const minimum = screen.getByRole("slider", { name: "Color vmin" })
    const maximum = screen.getByRole("slider", { name: "Color vmax" })
    expect(minimum).toHaveAttribute("aria-valuenow", "10")
    expect(maximum).toHaveAttribute("aria-valuenow", "90")
    expect(minimum).toHaveAttribute("title", expect.stringContaining("10%"))
    expect(container.querySelector(".ath-color-ramp-dim")?.getAttribute("style")).toContain("10%")

    fireEvent.keyDown(minimum, { key: "ArrowRight" })
    expect(minimum).toHaveAttribute("aria-valuenow", "11")
    fireEvent.keyDown(maximum, { key: "PageDown" })
    expect(maximum).toHaveAttribute("aria-valuenow", "80")

    const track = container.querySelector<HTMLElement>(".ath-color-range")!
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 100, width: 200 } as DOMRect)
    fireEvent(minimum, new MouseEvent("pointerdown", { bubbles: true, clientX: 150 }))
    fireEvent(minimum, new MouseEvent("pointermove", { bubbles: true, clientX: 170 }))
    fireEvent(minimum, new MouseEvent("pointerup", { bubbles: true, clientX: 170 }))
    expect(minimum).toHaveAttribute("aria-valuenow", "35")
    expect(onChange).toHaveBeenLastCalledWith({ palette: "viridis", reversed: false, vmin: 0.35, vmax: 0.8 })
    expect(JSON.parse(localStorage.getItem("athena.plot-colors")!)).toEqual({ palette: "viridis", reversed: false, vmin: 0.35, vmax: 0.8 })

    fireEvent.click(screen.getByRole("checkbox", { name: "Reverse" }))
    expect(onChange).toHaveBeenLastCalledWith({ palette: "viridis", reversed: true, vmin: 0.35, vmax: 0.8 })
    fireEvent.keyDown(minimum, { key: "End" })
    expect(minimum).toHaveAttribute("aria-valuenow", "78")
    fireEvent.keyDown(maximum, { key: "Home" })
    expect(maximum).toHaveAttribute("aria-valuenow", "80")
    fireEvent.keyDown(minimum, { key: "Home" })
    fireEvent.keyDown(maximum, { key: "End" })
    expect(minimum).toHaveAttribute("aria-valuenow", "0")
    expect(maximum).toHaveAttribute("aria-valuenow", "100")
  })

  it("restores validated saved bounds and defaults legacy storage to the full palette", () => {
    localStorage.setItem("athena.plot-colors", JSON.stringify({ palette: "rainbow", reversed: true, vmin: 0.2, vmax: 0.75 }))
    const onChange = vi.fn()
    render(<AthenaColorLegend value={{ palette: "rainbow", reversed: false }} onChange={onChange} />)
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ palette: "rainbow", reversed: true, vmin: 0.2, vmax: 0.75 })

    cleanup()
    localStorage.setItem("athena.plot-colors", JSON.stringify({ palette: "rainbow", reversed: false }))
    const legacyChange = vi.fn()
    render(<AthenaColorLegend value={{ palette: "rainbow", reversed: false }} onChange={legacyChange} />)
    expect(legacyChange).toHaveBeenCalledExactlyOnceWith({ palette: "rainbow", reversed: false })
    expect(screen.getByRole("slider", { name: "Color vmin" })).toHaveAttribute("aria-valuenow", "0")
    expect(screen.getByRole("slider", { name: "Color vmax" })).toHaveAttribute("aria-valuenow", "100")
  })
})
