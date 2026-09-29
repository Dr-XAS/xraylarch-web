"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown } from "lucide-react"

export type RampOption<T extends string> = { value: T; label: string; background: string }
export type RampRange = {
  vmin: number; vmax: number; minGap: number
  onChange: (vmin: number, vmax: number) => void
  disabled?: boolean; disabledReason?: string
}

function AthenaRampRange({ vmin, vmax, minGap, onChange, disabled = false, disabledReason }: RampRange) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<"vmin" | "vmax" | null>(null)
  const values = useRef({ vmin, vmax })
  values.current = { vmin, vmax }

  function setBound(bound: "vmin" | "vmax", value: number) {
    const current = values.current
    const quantized = Math.round(value * 100) / 100
    const next = bound === "vmin"
      ? { vmin: Math.max(0, Math.min(current.vmax - minGap, quantized)), vmax: current.vmax }
      : { vmin: current.vmin, vmax: Math.min(1, Math.max(current.vmin + minGap, quantized)) }
    if (next.vmin === current.vmin && next.vmax === current.vmax) return
    values.current = next
    onChange(next.vmin, next.vmax)
  }

  function fractionAt(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect?.width || !Number.isFinite(clientX)) return null
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>, bound: "vmin" | "vmax") {
    if (disabled) return
    dragging.current = bound
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.currentTarget.focus()
    const fraction = fractionAt(event.clientX)
    if (fraction !== null) setBound(bound, fraction)
  }

  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>, bound: "vmin" | "vmax") {
    if (disabled || dragging.current !== bound) return
    const fraction = fractionAt(event.clientX)
    if (fraction !== null) setBound(bound, fraction)
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>, bound: "vmin" | "vmax") {
    if (disabled) return
    const current = values.current[bound]
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1
      : event.key === "PageUp" ? current + 0.1 : event.key === "PageDown" ? current - 0.1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? current + 0.01
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? current - 0.01 : null
    if (next === null) return
    event.preventDefault()
    setBound(bound, next)
  }

  const reason = disabledReason ?? "Choose a continuous palette to adjust the color range."
  return <div ref={trackRef} className="ath-color-range" aria-label="Color palette range" title={disabled ? reason : undefined}>
    {(["vmin", "vmax"] as const).map(bound => {
      const percent = Math.round((bound === "vmin" ? vmin : vmax) * 100)
      const name = `Color ${bound}`
      const tooltip = disabled ? reason : `${bound} ${percent}% · drag or use arrow keys`
      return <button key={bound} type="button" role="slider" className="ath-color-range-handle"
        data-bound={bound} data-tooltip={tooltip} title={tooltip}
        style={{ left: `${(bound === "vmin" ? vmin : vmax) * 100}%` }}
        aria-label={name} aria-valuemin={bound === "vmin" ? 0 : Math.round((vmin + minGap) * 100)}
        aria-valuemax={bound === "vmin" ? Math.round((vmax - minGap) * 100) : 100}
        aria-valuenow={percent} aria-valuetext={`${percent}% of palette`} aria-description={disabled ? reason : undefined}
        disabled={disabled} onPointerDown={event => pointerDown(event, bound)}
        onPointerMove={event => pointerMove(event, bound)}
        onPointerUp={() => { dragging.current = null }} onPointerCancel={() => { dragging.current = null }}
        onLostPointerCapture={() => { dragging.current = null }} onKeyDown={event => keyDown(event, bound)}>
        <span className="ath-color-range-arrow" aria-hidden="true" />
      </button>
    })}
  </div>
}

export function AthenaRampPicker<T extends string>({ label, options, value, onChange, disabled = false, range }: {
  label: string; options: readonly RampOption<T>[]; value: T; onChange: (value: T) => void; disabled?: boolean; range?: RampRange
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
    <div className={`ath-color-ramp-shell${range ? " ath-color-ramp-shell-with-range" : ""}`}>
    <button ref={triggerRef} type="button" className="ath-color-ramp-picker" role="combobox"
      aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-activedescendant={open ? `${menuId}-${active}` : undefined} title={selected.label}
      disabled={disabled} onClick={() => { setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(current => !current) }} onKeyDown={keyDown}>
      <span className="ath-color-ramp" style={{ background: selected.background }} aria-hidden="true">
        {range && <><span className="ath-color-ramp-dim" style={{ left: 0, width: `${range.vmin * 100}%` }} />
          <span className="ath-color-ramp-dim" style={{ right: 0, width: `${(1 - range.vmax) * 100}%` }} /></>}
      </span>
      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
    {range && <AthenaRampRange {...range} disabled={disabled || range.disabled} />}
    </div>
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
