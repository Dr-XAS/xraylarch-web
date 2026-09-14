import "@testing-library/jest-dom/vitest"

import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import { useRef, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AthenaContextMenu, type ContextMenuItem } from "./athena-context-menu"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(overrides: Partial<ContextMenuItem>[] = []) {
  const items: ContextMenuItem[] = [
    { id: "rename", label: "Rename", onSelect: vi.fn() },
    { id: "copy", label: "Copy", disabled: true, onSelect: vi.fn() },
    { id: "mark", label: "Marked", checked: true, onSelect: vi.fn(), separatorBefore: true },
    { id: "remove", label: "Remove", danger: true, onSelect: vi.fn() },
  ].map((item, index) => ({ ...item, ...overrides[index] }))
  return items
}

function Harness({ items = fixture(), onClose = vi.fn(), anchor = { x: 100, y: 100 } }: {
  items?: ContextMenuItem[]
  onClose?: () => void
  anchor?: { x: number; y: number }
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={trigger} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(true)}>Group actions</button>
    <button>Next control</button>
    {open && <AthenaContextMenu label="Copper actions" items={items} anchor={anchor}
      returnFocus={trigger.current} onClose={() => { onClose(); setOpen(false) }} />}
  </>
}

function openMenu(props: Parameters<typeof Harness>[0] = {}) {
  const rendered = render(<Harness {...props} />)
  const trigger = screen.getByRole("button", { name: "Group actions" })
  trigger.focus()
  fireEvent.click(trigger)
  return { ...rendered, trigger, menu: screen.getByRole("menu", { name: "Copper actions" }) }
}

describe("AthenaContextMenu", () => {
  it("renders a labelled portal with checkable actions and one enabled item in the tab order", () => {
    const { container, menu } = openMenu()
    expect(container).not.toContainElement(menu)
    expect(document.body).toContainElement(menu)
    expect(menu).toHaveAttribute("aria-orientation", "vertical")
    expect(screen.getByRole("menuitemcheckbox", { name: "Marked" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("separator")).toBeInTheDocument()
    const rename = screen.getByRole("menuitem", { name: "Rename" })
    expect(rename).toHaveFocus()
    expect(rename).toHaveAttribute("tabindex", "0")
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveAttribute("tabindex", "-1")
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeDisabled()
  })

  it("portals into the trigger's open dialog to remain in its accessible top layer", () => {
    render(<dialog open aria-label="Metadata"><Harness /></dialog>)
    fireEvent.click(screen.getByRole("button", { name: "Group actions" }))
    const menu = screen.getByRole("menu", { name: "Copper actions" })
    expect(menu.parentElement).toBe(screen.getByRole("dialog", { name: "Metadata" }))
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus()
  })

  it("moves focus with arrows, Home and End while skipping disabled actions and wrapping", () => {
    const { menu } = openMenu()
    const rename = screen.getByRole("menuitem", { name: "Rename" })
    const marked = screen.getByRole("menuitemcheckbox", { name: "Marked" })
    const remove = screen.getByRole("menuitem", { name: "Remove" })
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    expect(marked).toHaveFocus()
    expect(rename).toHaveAttribute("tabindex", "-1")
    fireEvent.keyDown(menu, { key: "End" })
    expect(remove).toHaveFocus()
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    expect(rename).toHaveFocus()
    fireEvent.keyDown(menu, { key: "ArrowUp" })
    expect(remove).toHaveFocus()
    fireEvent.keyDown(menu, { key: "Home" })
    expect(rename).toHaveFocus()
  })

  it.each(["Enter", " "])("activates only the focused action on %j and closes before invoking it", key => {
    const order: string[] = []
    const items = fixture([{ onSelect: vi.fn(() => order.push("action")) }])
    const { menu, trigger } = openMenu({ items, onClose: () => order.push("close") })
    fireEvent.keyDown(menu, { key })
    expect(order).toEqual(["close", "action"])
    expect(items[0].onSelect).toHaveBeenCalledOnce()
    expect(items[1].onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("ignores disabled clicks and activates the clicked enabled action", () => {
    const items = fixture()
    openMenu({ items })
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }))
    expect(items[1].onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole("menu")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Marked" }))
    expect(items[2].onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("keeps focus assigned by an action, such as the dialog it opens", async () => {
    const items = fixture([{ onSelect: () => screen.getByRole("button", { name: "Next control" }).focus() }])
    const { menu } = openMenu({ items })
    fireEvent.keyDown(menu, { key: "Enter" })
    await Promise.resolve()
    expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus()
  })

  it("dismisses Escape and restores focus without executing an action", () => {
    const items = fixture()
    const { menu, trigger } = openMenu({ items })
    fireEvent.keyDown(menu, { key: "Escape" })
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    for (const item of items) expect(item.onSelect).not.toHaveBeenCalled()
  })

  it.each([false, true])("closes on Tab with shift=%s and leaves native Tab navigation unprevented", shiftKey => {
    const { menu, trigger } = openMenu()
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })
    fireEvent(menu, event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("closes for outside pointer interaction without moving focus away from that target", () => {
    openMenu()
    const outside = screen.getByRole("button", { name: "Next control" })
    outside.focus()
    fireEvent.pointerDown(outside)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(outside).toHaveFocus()
  })

  it("allows scrolling inside a tall menu but closes on page scrolling", () => {
    const { menu, trigger } = openMenu()
    fireEvent.scroll(menu)
    expect(menu).toBeInTheDocument()
    fireEvent.scroll(document)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("clamps the menu at viewport edges and repositions after a resize", () => {
    vi.stubGlobal("innerWidth", 1024)
    vi.stubGlobal("innerHeight", 768)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 240, height: 180 } as DOMRect)
    const { menu } = openMenu({ anchor: { x: 1010, y: 760 } })
    expect(menu).toHaveStyle({ left: "776px", top: "580px" })
    vi.stubGlobal("innerWidth", 400)
    vi.stubGlobal("innerHeight", 300)
    fireEvent(window, new Event("resize"))
    expect(menu).toHaveStyle({ left: "152px", top: "112px" })
  })

  it("keeps the start of an oversized menu reachable and supports an all-disabled menu", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 2000, height: 2000 } as DOMRect)
    const items = fixture().map(item => ({ ...item, disabled: true }))
    const { menu, trigger } = openMenu({ anchor: { x: -10, y: -20 }, items })
    expect(menu).toHaveStyle({ left: "8px", top: "8px" })
    expect(menu).toHaveFocus()
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    fireEvent.keyDown(menu, { key: "Enter" })
    expect(menu).toBeInTheDocument()
    for (const item of items) expect(item.onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(menu, { key: "Escape" })
    expect(trigger).toHaveFocus()
  })

  it("moves focus to an enabled action if the focused action becomes disabled", () => {
    const items = fixture()
    const { rerender } = openMenu({ items })
    rerender(<Harness items={items.map(item => item.id === "rename" ? { ...item, disabled: true } : item)} />)
    expect(screen.getByRole("menuitemcheckbox", { name: "Marked" })).toHaveFocus()
  })
})
