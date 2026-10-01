import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { RadialShellPanel } from "./radial-shell-panel"
import { radialFixture } from "@/tests/fixtures/radial-shells"
afterEach(cleanup)

it("resets unapplied settings and errors across centers even when default settings are shared", () => {
  const state = { contextKey: "one", data: radialFixture, settings: { radius: 6, tolerance: 0.05 }, setSettings: vi.fn(), retry: vi.fn(), loading: false, error: "" }
  const view = render(<RadialShellPanel state={state} />)
  fireEvent.change(screen.getByRole("spinbutton", { name: "Shell search radius" }), { target: { value: "20" } })
  fireEvent.click(screen.getByRole("button", { name: "Apply shell settings" }))
  expect(screen.getByRole("alert")).toBeVisible()
  view.rerender(<RadialShellPanel state={{ ...state, contextKey: "two", data: null }} />)
  expect(screen.getByRole("spinbutton", { name: "Shell search radius" })).toHaveValue(6)
  expect(screen.queryByRole("alert")).toBeNull()
  expect(state.setSettings).not.toHaveBeenCalled()
})
