import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { RadialPathGroups } from "./radial-path-groups"
import { radialFixture, radialStructure, radialMetadata } from "@/tests/fixtures/radial-shells"
afterEach(cleanup)
const paths = [1, 2].map(index => ({ id: String(index), metadata: radialMetadata(index) }))
it("offers group inclusion separately from use-only, excludes already added paths and never includes MS in shells", () => {
  const onSelection = vi.fn(), onUseOnly = vi.fn()
  render(<RadialPathGroups paths={[...paths, { id: "ms", metadata: { ...radialMetadata(), nleg: 3 } }]} structure={radialStructure} analysis={radialFixture}
    selectedIds={["1"]} blockedIds={["2"]} action="Include" onSelection={onSelection} onUseOnly={onUseOnly} renderPath={path => path.id} />)
  fireEvent.click(screen.getByRole("button", { name: "Exclude shell 1 paths" }))
  expect(onSelection).toHaveBeenCalledExactlyOnceWith(["1"], false)
  expect(screen.getByRole("button", { name: "Include shell 2 paths" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Use only shell 1 candidates" }))
  expect(onUseOnly).toHaveBeenCalledExactlyOnceWith(["1"])
  expect(screen.getByRole("button", { name: "Include multiple scattering paths" })).toBeEnabled()
  expect(screen.queryByRole("button", { name: "Use only multiple scattering candidates" })).toBeNull()
})

it("retains the same focused editable DOM node when requests regroup paths", () => {
  const props = { paths, structure: radialStructure, selectedIds: ["1"], onSelection: vi.fn(), renderPath: (path: typeof paths[number]) => <input aria-label={`Label ${path.id}`} defaultValue="original" /> }
  const view = render(<RadialPathGroups {...props} analysis={radialFixture} />)
  const input = screen.getByRole("textbox", { name: "Label 1" })
  input.focus()
  fireEvent.change(input, { target: { value: "edited" } })
  view.rerender(<RadialPathGroups {...props} analysis={null} />)
  expect(screen.getByRole("textbox", { name: "Label 1" })).toBe(input)
  expect(input).toHaveFocus()
  view.rerender(<RadialPathGroups {...props} analysis={radialFixture} />)
  expect(screen.getByRole("textbox", { name: "Label 1" })).toBe(input)
  expect(input).toHaveValue("edited")
  expect(input).toHaveFocus()
})
