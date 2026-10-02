import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { shellColor, shellRange } from "@/lib/radial-shells"
import { radialFixture } from "@/tests/fixtures/radial-shells"
import { FeffPathShellLabel, ShellSwatch } from "./feff-path-shell-label"

afterEach(cleanup)

it("shows the matched shell number, radial range and shared shell color", () => {
  const shell = radialFixture.shells[1]
  render(<FeffPathShellLabel shell={shell} nleg={2} hasContext hasAnalysis />)
  const label = screen.getByText("Shell 2")
  expect(label).toBeVisible()
  expect(label.closest("[title]")).toHaveAttribute("title", expect.stringContaining(shellRange(shell)))
  expect(label.querySelector('[aria-hidden="true"]')).toHaveStyle({ background: shellColor(shell.index) })
})

it.each([
  { name: "missing CIF context", hasContext: false, hasAnalysis: false, label: "Shell unassigned" },
  { name: "analysis loading", hasContext: true, hasAnalysis: false, loading: true, label: "Shell pending" },
  { name: "analysis error", hasContext: true, hasAnalysis: false, error: "Could not analyze CIF", label: "Shell unavailable" },
  { name: "invalid or absent analysis", hasContext: true, hasAnalysis: false, label: "Shell unavailable" },
  { name: "valid analysis with no geometry match", hasContext: true, hasAnalysis: true, label: "Unmatched" },
])("distinguishes $name from a shell assignment", ({ label, name: _name, ...props }) => {
  render(<FeffPathShellLabel nleg={2} {...props} />)
  expect(screen.getByText(label)).toBeVisible()
  expect(screen.queryByText(/^Shell \d+$/)).not.toBeInTheDocument()
})

it.each([
  { hasContext: false, hasAnalysis: false },
  { hasContext: true, hasAnalysis: false, loading: true },
  { hasContext: true, hasAnalysis: true },
])("keeps multiple scattering distinct from radial shell matching %#", props => {
  render(<FeffPathShellLabel nleg={3} {...props} />)
  expect(screen.getByText("Multiple scattering")).toBeVisible()
  expect(screen.queryByText(/^Shell /)).not.toBeInTheDocument()
})

it.each([
  { loading: true, label: "Shell pending" },
  { error: "Analysis needs retry", label: "Shell unavailable" },
])("does not show a stale shell assignment while $label", ({ label, ...props }) => {
  render(<FeffPathShellLabel shell={radialFixture.shells[0]} nleg={2} hasContext hasAnalysis {...props} />)
  expect(screen.getByText(label)).toBeVisible()
  expect(screen.queryByText("Shell 1")).not.toBeInTheDocument()
})

it("shares shell colors with the existing shell swatch and hides decoration from assistive technology", () => {
  const { container } = render(<ShellSwatch index={1} />)
  expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true")
  expect(container.firstElementChild).toHaveStyle({ background: shellColor(1) })
})
