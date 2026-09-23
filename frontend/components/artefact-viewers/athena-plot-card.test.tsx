import "@testing-library/jest-dom/vitest"

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ResizablePlotCard, athenaPlotHeightKey } from "./athena-plot-card"

function pointer(type: string, clientY: number, pointerId = 7, isPrimary = true) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    button: { value: 0 },
    clientY: { value: clientY },
    isPrimary: { value: isPrimary },
    pointerId: { value: pointerId },
  })
  return event
}

function showCard() {
  const rendered = render(<ResizablePlotCard>
    <div className="ath-plot-top">Plot controls</div>
    <div className="ath-no-plot">Your spectra, in perspective.</div>
    <div className="ath-plot-bottom">Range controls</div>
  </ResizablePlotCard>)
  const card = rendered.container.querySelector<HTMLElement>(".ath-plot-card")!
  const grip = screen.getByRole("separator", { name: "Resize spectrum plot height" })
  return { ...rendered, card, grip }
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const card = this.closest<HTMLElement>(".ath-plot-card")
    const height = Number.parseFloat(card?.style.getPropertyValue("--ath-plot-height") ?? "") || 380
    return {
      x: 0, y: 100, left: 0, top: 100, width: 800, height,
      right: 800, bottom: 100 + height, toJSON: () => ({}),
    } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("ResizablePlotCard", () => {
  it("drags to enlarge the plot, saves on release, and restores the starting size on Escape", () => {
    const { card, grip } = showCard()
    expect(grip).toHaveAttribute("aria-orientation", "horizontal")
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("")

    fireEvent(grip, pointer("pointerdown", 480))
    expect(document.body.style.overflowAnchor).toBe("none")
    fireEvent(window, pointer("pointermove", 660))
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("560px")
    expect(localStorage.getItem(athenaPlotHeightKey)).toBeNull()
    fireEvent(window, pointer("pointerup", 660))
    expect(document.body.style.overflowAnchor).toBe("")
    expect(Number(localStorage.getItem(athenaPlotHeightKey))).toBe(560)

    fireEvent(grip, pointer("pointerdown", 660))
    fireEvent(window, pointer("pointermove", 760))
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("660px")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("560px")
    expect(Number(localStorage.getItem(athenaPlotHeightKey))).toBe(560)

    // A release queued after cancellation must not persist the cancelled height.
    fireEvent(window, pointer("pointerup", 760))
    expect(Number(localStorage.getItem(athenaPlotHeightKey))).toBe(560)
  })

  it("restores a saved height and supports bounded keyboard resizing and reset", () => {
    localStorage.setItem(athenaPlotHeightKey, "720")
    const { card, grip } = showCard()
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("720px")
    fireEvent.keyDown(grip, { key: "ArrowDown" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("736px")
    fireEvent.keyDown(grip, { key: "ArrowUp", shiftKey: true })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("688px")
    expect(Number(localStorage.getItem(athenaPlotHeightKey))).toBe(688)

    fireEvent.keyDown(grip, { key: "Home" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("280px")
    fireEvent.keyDown(grip, { key: "ArrowUp" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("280px")
    fireEvent.keyDown(grip, { key: "End" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("1600px")
    fireEvent.keyDown(grip, { key: "ArrowDown" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("1600px")

    fireEvent.keyDown(grip, { key: "Enter" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("")
    expect(localStorage.getItem(athenaPlotHeightKey)).toBeNull()
    fireEvent.keyDown(grip, { key: "ArrowDown" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("396px")
    fireEvent.doubleClick(grip)
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("")
    expect(localStorage.getItem(athenaPlotHeightKey)).toBeNull()
  })

  it("shrinks by the viewport pointer distance when the document scroll position is clamped", () => {
    localStorage.setItem(athenaPlotHeightKey, "540")
    vi.stubGlobal("scrollY", 1000)
    try {
      const { card, grip } = showCard()
      fireEvent(grip, pointer("pointerdown", 700))

      // Shrinking a plot at the document bottom can clamp the scroll position.
      // That browser movement must not add to the user's 80-pixel drag.
      vi.stubGlobal("scrollY", 740)
      fireEvent(window, pointer("pointermove", 620))
      expect(card.style.getPropertyValue("--ath-plot-height")).toBe("460px")
      expect(localStorage.getItem(athenaPlotHeightKey)).toBe("540")

      vi.stubGlobal("scrollY", 600)
      fireEvent(window, pointer("pointermove", 620))
      expect(card.style.getPropertyValue("--ath-plot-height")).toBe("460px")
      fireEvent(window, pointer("pointerup", 620))
      expect(localStorage.getItem(athenaPlotHeightKey)).toBe("460")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("ignores unrelated pointers and cancels an interrupted drag without saving", () => {
    const { card, grip } = showCard()
    fireEvent(grip, pointer("pointerdown", 480, 8, false))
    fireEvent(window, pointer("pointermove", 680, 8, false))
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("")

    fireEvent(grip, pointer("pointerdown", 480))
    fireEvent(window, pointer("pointermove", 680, 8))
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("")
    fireEvent(window, pointer("pointermove", 580))
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("480px")
    fireEvent(window, pointer("pointercancel", 580))
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("")
    expect(localStorage.getItem(athenaPlotHeightKey)).toBeNull()
  })

  it.each(["not-a-number", "NaN", "Infinity", "{broken", "null", ""])("ignores invalid saved height %j", stored => {
    localStorage.setItem(athenaPlotHeightKey, stored)
    const { card, grip } = showCard()
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("")
    fireEvent.keyDown(grip, { key: "ArrowDown" })
    expect(card.style.getPropertyValue("--ath-plot-height")).toBe("396px")
  })
})
