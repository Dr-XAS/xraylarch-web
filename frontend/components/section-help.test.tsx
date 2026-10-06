import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { InstructionVisibility, SectionHelp } from "./section-help"

afterEach(() => { cleanup(); vi.useRealTimers() })

it("keeps descriptions out of the layout and reveals them on hover, including pointer travel", () => {
  vi.useFakeTimers()
  render(<h3>Shells<SectionHelp label="Shells">Distances use the selected absorber.</SectionHelp></h3>)
  expect(screen.getByText("Distances use the selected absorber.")).not.toBeVisible()
  const trigger = screen.getByRole("button", { name: "About Shells" })
  fireEvent.mouseEnter(trigger)
  const tooltip = screen.getByRole("tooltip")
  expect(tooltip).toBeVisible()
  expect(tooltip.parentElement).toBe(document.body)
  fireEvent.mouseLeave(trigger)
  fireEvent.mouseEnter(tooltip)
  act(() => vi.advanceTimersByTime(200))
  expect(tooltip).toBeVisible()
  fireEvent.mouseLeave(tooltip)
  act(() => vi.advanceTimersByTime(200))
  expect(tooltip).not.toBeVisible()
})

it("supports keyboard focus and Escape without closing the parent dialog", () => {
  const parentKey = vi.fn()
  render(<dialog open onKeyDown={parentKey}><SectionHelp id="range-help" label="Range">Use a shared range.</SectionHelp></dialog>)
  const trigger = screen.getByRole("button", { name: "About Range" })
  act(() => trigger.focus())
  expect(trigger).toHaveAccessibleDescription("Range Use a shared range.")
  expect(screen.getByRole("tooltip").parentElement?.tagName).toBe("DIALOG")
  fireEvent.keyDown(trigger, { key: "Escape" })
  expect(screen.queryByRole("tooltip")).toBeNull()
  expect(parentKey).not.toHaveBeenCalled()
  expect(trigger).toHaveFocus()
})

it("does not toggle a parent disclosure or checkbox and never submits a form", () => {
  const submit = vi.fn()
  render(<form onSubmit={submit}><details open><summary>Settings<SectionHelp label="Settings">Details</SectionHelp></summary></details>
    <label><input type="checkbox" />Use offset<SectionHelp label="Offset">Display only</SectionHelp></label></form>)
  fireEvent.click(screen.getByRole("button", { name: "About Settings" }))
  expect(screen.getByRole("button", { name: "About Settings" }).closest("details")).toHaveAttribute("open")
  fireEvent.click(screen.getByRole("button", { name: "About Offset" }))
  expect(screen.getByRole("checkbox")).not.toBeChecked()
  expect(screen.getByLabelText("Use offset")).toBe(screen.getByRole("checkbox"))
  expect(screen.getByRole("checkbox")).toHaveAccessibleName("Use offset")
  expect(submit).not.toHaveBeenCalled()
})

it("supports touch activation and dismisses on outside input or panel scrolling", () => {
  render(<><SectionHelp label="Paths">Path details</SectionHelp><input aria-label="Value" /></>)
  const trigger = screen.getByRole("button", { name: "About Paths" })
  fireEvent.pointerDown(trigger, { pointerType: "touch" })
  fireEvent.click(trigger, { detail: 1 })
  expect(screen.getByRole("tooltip")).toBeVisible()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole("tooltip")).toBeNull()
  fireEvent.focus(trigger)
  fireEvent.scroll(screen.getByRole("tooltip"))
  expect(screen.getByRole("tooltip")).toBeVisible()
  fireEvent.scroll(window)
  expect(screen.queryByRole("tooltip")).toBeNull()
})

it("lets keyboard users enter and leave source links in help", () => {
  render(<SectionHelp label="Sources"><a href="https://example.org">Reference</a></SectionHelp>)
  const trigger = screen.getByRole("button", { name: "About Sources" })
  act(() => trigger.focus())
  fireEvent.keyDown(trigger, { key: "Tab" })
  expect(screen.getByRole("link", { name: "Reference" })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true })
  expect(trigger).toHaveFocus()
  expect(screen.getByRole("tooltip")).toBeVisible()
  fireEvent.keyDown(trigger, { key: "Tab" })
  fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  expect(trigger).toHaveFocus()
  expect(screen.queryByRole("tooltip")).toBeNull()
})

it("keeps keyboard help anchored when focus scrolls its field into view", () => {
  render(<SectionHelp label="Fit space">Choose k or R space.</SectionHelp>)
  const trigger = screen.getByRole("button", { name: "About Fit space" })
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 120, left: 30, right: 50, width: 20, height: 20, x: 30, y: 100, toJSON: () => ({}) })
  act(() => trigger.focus())
  fireEvent.scroll(window)
  expect(screen.getByRole("tooltip")).toBeVisible()
  expect(trigger).toHaveFocus()
  vi.mocked(trigger.getBoundingClientRect).mockReturnValue({ top: -30, bottom: -10, left: 30, right: 50, width: 20, height: 20, x: 30, y: -30, toJSON: () => ({}) })
  fireEvent.scroll(window)
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
})

it("hides instruction icons and closes open tooltips when instructions are switched off", () => {
  const content = <SectionHelp label="Normalization">Normalize the spectrum.</SectionHelp>
  const { rerender } = render(<InstructionVisibility value={false}>{content}</InstructionVisibility>)
  expect(screen.queryByRole("button", { name: "About Normalization" })).not.toBeInTheDocument()
  rerender(<InstructionVisibility value={true}>{content}</InstructionVisibility>)
  fireEvent.focus(screen.getByRole("button", { name: "About Normalization" }))
  expect(screen.getByRole("tooltip")).toBeVisible()
  rerender(<InstructionVisibility value={false}>{content}</InstructionVisibility>)
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "About Normalization" })).not.toBeInTheDocument()
})
