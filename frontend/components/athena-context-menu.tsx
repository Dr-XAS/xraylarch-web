"use client"

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"

import styles from "./athena-context-menu.module.css"

export type ContextMenuItem = {
  id: string
  label: string
  disabled?: boolean
  checked?: boolean
  danger?: boolean
  onSelect: () => void
  separatorBefore?: boolean
}

type AthenaContextMenuProps = {
  label: string
  items: ContextMenuItem[]
  anchor: { x: number; y: number }
  onClose: () => void
  returnFocus?: HTMLElement | null
}

export function AthenaContextMenu({ label, items, anchor, onClose, returnFocus }: AthenaContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const closed = useRef(false)
  const initializedFocus = useRef(false)
  const [activeId, setActiveId] = useState(() => items.find(item => !item.disabled)?.id)
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y })
  const enabled = items.filter(item => !item.disabled)

  function focusItem(item: ContextMenuItem | undefined) {
    if (!item) return
    setActiveId(item.id)
    const button = buttons.current.get(item.id)
    button?.focus({ preventScroll: true })
    button?.scrollIntoView?.({ block: "nearest" })
  }

  function close(restoreFocus: boolean) {
    if (closed.current) return
    closed.current = true
    onClose()
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
  }

  function select(item: ContextMenuItem) {
    if (item.disabled || closed.current) return
    // Restore focus before the callback: a dialog opened by the action owns its next focus.
    close(true)
    item.onSelect()
  }

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const place = () => {
      const margin = 8
      const bounds = menu.getBoundingClientRect()
      setPosition({
        left: Math.max(margin, Math.min(anchor.x, window.innerWidth - bounds.width - margin)),
        top: Math.max(margin, Math.min(anchor.y, window.innerHeight - bounds.height - margin)),
      })
    }
    place()
    window.addEventListener("resize", place)
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place)
    observer?.observe(menu)
    return () => {
      window.removeEventListener("resize", place)
      observer?.disconnect()
    }
  }, [anchor.x, anchor.y])

  useLayoutEffect(() => {
    const current = items.find(item => item.id === activeId && !item.disabled)
    if (initializedFocus.current && current) return
    initializedFocus.current = true
    const first = items.find(item => !item.disabled)
    if (first) focusItem(first)
    else menuRef.current?.focus({ preventScroll: true })
  }, [items, activeId])

  useLayoutEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      close(false)
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      close(true)
    }
    document.addEventListener("pointerdown", outside, true)
    window.addEventListener("scroll", scroll, true)
    return () => {
      document.removeEventListener("pointerdown", outside, true)
      window.removeEventListener("scroll", scroll, true)
    }
  })

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = enabled.findIndex(item => item.id === activeId)
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === "Tab") {
      // Keep native Tab movement, starting from the control that opened the menu.
      close(true)
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === "Home") focusItem(enabled[0])
      else if (event.key === "End") focusItem(enabled.at(-1))
      else if (enabled.length) focusItem(enabled[(index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length])
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      event.stopPropagation()
      const selected = enabled.find(item => item.id === activeId)
      if (selected) select(selected)
    }
  }

  if (typeof document === "undefined") return null
  const portalTarget = returnFocus?.closest("dialog[open]") ?? document.body
  return createPortal(
    <div ref={menuRef} role="menu" aria-label={label} aria-orientation="vertical" tabIndex={-1}
      className={styles.menu} style={position} onKeyDown={onKeyDown} onContextMenu={event => event.preventDefault()}>
      {items.map((item, index) => <div key={item.id} role="none">
        {item.separatorBefore && index > 0 && <div role="separator" className={styles.separator} />}
        <button ref={button => { if (button) buttons.current.set(item.id, button); else buttons.current.delete(item.id) }}
          type="button" role={typeof item.checked === "boolean" ? "menuitemcheckbox" : "menuitem"}
          aria-checked={item.checked} aria-disabled={item.disabled || undefined} disabled={item.disabled}
          tabIndex={activeId === item.id && !item.disabled ? 0 : -1}
          className={`${styles.item}${item.danger ? ` ${styles.danger}` : ""}`}
          onFocus={() => setActiveId(item.id)} onClick={() => select(item)}>
          <span className={styles.check} aria-hidden="true">{item.checked ? "✓" : ""}</span>
          <span>{item.label}</span>
        </button>
      </div>)}
    </div>, portalTarget,
  )
}
