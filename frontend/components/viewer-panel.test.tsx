import "@testing-library/jest-dom/vitest"

import { useEffect, useState } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ViewerPanel } from "./viewer-panel"

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("ViewerPanel", () => {
  it("collapses viewers independently while preserving mounted display controls", () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1)
    const mounted = vi.fn()
    const unmounted = vi.fn()

    function DisplayControls() {
      const [radius, setRadius] = useState("3.5")
      useEffect(() => { mounted(); return unmounted }, [])
      return <input aria-label="Display radius" value={radius} onChange={event => setRadius(event.target.value)} />
    }

    render(<>
      <ViewerPanel title="CIF structure viewer" actions={<button type="button">Reset view</button>}>
        <DisplayControls />
      </ViewerPanel>
      <ViewerPanel title="Wavelet viewer"><p>Wavelet plot</p></ViewerPanel>
    </>)
    const radius = screen.getByRole("textbox", { name: "Display radius" })
    const reset = screen.getByRole("button", { name: "Reset view" })
    fireEvent.change(radius, { target: { value: "5" } })
    fireEvent.click(screen.getByRole("button", { name: "Collapse CIF structure viewer" }))

    expect(screen.getByRole("button", { name: "Expand CIF structure viewer" })).toHaveAttribute("aria-expanded", "false")
    expect(radius).toBeInTheDocument()
    expect(radius).not.toBeVisible()
    expect(reset).not.toBeVisible()
    expect(screen.queryByRole("button", { name: "Reset view" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Collapse Wavelet viewer" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Wavelet plot")).toBeVisible()
    expect(unmounted).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Expand CIF structure viewer" }))
    expect(screen.getByRole("textbox", { name: "Display radius" })).toBe(radius)
    expect(radius).toHaveValue("5")
    expect(radius).toBeVisible()
    expect(reset).toBeVisible()
    expect(mounted).toHaveBeenCalledOnce()
    expect(unmounted).not.toHaveBeenCalled()
  })

  it("notifies responsive plots after the reopened content becomes visible", () => {
    let repaint: FrameRequestCallback | undefined
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { repaint = callback; return 1 })
    const resize = vi.fn(() => expect(screen.getByText("Spectrum plot")).toBeVisible())
    window.addEventListener("resize", resize)
    try {
      render(<ViewerPanel title="Spectrum viewer"><p>Spectrum plot</p></ViewerPanel>)
      fireEvent.click(screen.getByRole("button", { name: "Collapse Spectrum viewer" }))
      expect(repaint).toBeUndefined()
      expect(resize).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole("button", { name: "Expand Spectrum viewer" }))
      expect(resize).not.toHaveBeenCalled()
      expect(repaint).toBeDefined()
      act(() => repaint!(0))
      expect(resize).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener("resize", resize)
    }
  })
})
