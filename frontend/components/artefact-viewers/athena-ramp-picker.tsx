"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown } from "lucide-react"

export type RampOption<T extends string> = { value: T; label: string; background: string }

export function AthenaRampPicker<T extends string>({ label, options, value, onChange, disabled = false }: {
  label: string; options: readonly RampOption<T>[]; value: T; onChange: (value: T) => void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const selected = options.find(option => option.value === value) ?? options[0]

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect()
      const menu = menuRef.current
      if (!trigger || !menu) return
      const width = Math.min(Math.max(trigger.width, 220), window.innerWidth - 16)
      const height = menu.getBoundingClientRect().height
      const below = window.innerHeight - trigger.bottom - 8
      const above = trigger.top - 8
      const top = below >= height || below >= above ? trigger.bottom + 5 : trigger.top - height - 5
      setPosition({ width, left: Math.max(8, Math.min(trigger.left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("focusin", closeOnFocus)
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("focusin", closeOnFocus) }
  }, [open])

  useEffect(() => {
    if (open) menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.scrollIntoView?.({ block: "nearest" })
  }, [active, open])

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  function choose(option: RampOption<T>) {
    onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
    if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); return }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      if (open) choose(options[active])
      else { setActive(selectedIndex); setOpen(true) }
      return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    if (!open) { setActive(selectedIndex); setOpen(true); return }
    setActive(current => event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length)
  }

  return <>
    <button ref={triggerRef} type="button" className="ath-color-ramp-picker" role="combobox"
      aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-activedescendant={open ? `${menuId}-${active}` : undefined} title={selected.label}
      disabled={disabled} onClick={() => { setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(current => !current) }} onKeyDown={keyDown}>
      <span className="ath-color-ramp" style={{ background: selected.background }} aria-hidden="true" />
      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menuRef} id={menuId} className="ath-cmap-menu" role="listbox" aria-label={label} style={position}>
      {options.map((option, index) => <button key={option.value} id={`${menuId}-${index}`} type="button" role="option"
        aria-label={option.label} aria-selected={option.value === value} tabIndex={-1} title={option.label}
        className="ath-cmap-option" data-active={index === active || undefined}
        onPointerEnter={() => setActive(index)} onClick={() => choose(option)}>
        <span className="ath-cmap-check" aria-hidden="true">{option.value === value && <Check size={15} strokeWidth={2.5} />}</span>
        <span className="ath-cmap-ramp" style={{ background: option.background }} aria-hidden="true" />
      </button>)}
    </div>, document.body)}
  </>
}
