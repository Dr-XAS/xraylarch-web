"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

import styles from "./parameter-help.module.css"

/** Keeps help outside the scrolling parameter pane without changing the field layout. */
export function ParameterHelp({ label, help, children }: {
  label: string
  help: string
  children: (descriptionId: string) => ReactNode
}) {
  const descriptionId = useId()
  const trigger = useRef<HTMLDivElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  function cancelTimer() {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  function close() { cancelTimer(); setPending(false); setOpen(false) }
  function show(delay = 0) {
    cancelTimer()
    if (delay) {
      setPending(true)
      timer.current = setTimeout(() => { setPending(false); setOpen(true) }, delay)
    } else { setPending(false); setOpen(true) }
  }
  function leave() {
    cancelTimer()
    setPending(false)
    if (document.activeElement?.matches("input, select") && trigger.current?.contains(document.activeElement)) return
    // Allow the pointer to cross the gap so the definition remains hoverable.
    timer.current = setTimeout(() => setOpen(false), 150)
  }

  useEffect(() => () => cancelTimer(), [])
  useLayoutEffect(() => {
    if (!open) return
    const anchor = trigger.current?.querySelector("label")?.getBoundingClientRect()
    const bounds = tooltip.current?.getBoundingClientRect()
    if (!anchor || !bounds) return
    const margin = 8
    const preferredLeft = anchor.right + margin + bounds.width <= window.innerWidth - margin
      ? anchor.right + margin : anchor.left - bounds.width - margin
    setPosition({
      left: Math.max(margin, Math.min(preferredLeft, window.innerWidth - bounds.width - margin)),
      top: Math.max(margin, Math.min(anchor.top, window.innerHeight - bounds.height - margin)),
    })
  }, [open, help])
  useEffect(() => {
    if (!open && !pending) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close() }
    }
    const outside = (event: Event) => {
      if (event.target instanceof Node && (trigger.current?.contains(event.target) || tooltip.current?.contains(event.target))) return
      close()
    }
    document.addEventListener("keydown", escape)
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("focusin", outside)
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("keydown", escape)
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("focusin", outside)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [open, pending])

  return <div ref={trigger} className={styles.trigger}
    onMouseEnter={() => show(350)} onMouseLeave={leave}
    onFocus={event => { if (event.target.matches("input, select")) show(); else close() }}
    onBlur={close} onContextMenuCapture={close}
    onClickCapture={event => { if ((event.target as HTMLElement).closest("button")) close() }}>
    {children(descriptionId)}
    {!open && <span id={descriptionId} hidden>{help}</span>}
    {open && createPortal(<div ref={tooltip} id={descriptionId} role="tooltip" className={styles.tooltip}
      style={position} onMouseEnter={cancelTimer} onMouseLeave={leave}>
      <strong>{label}</strong><span>{help}</span>
    </div>, trigger.current?.closest("dialog[open]") ?? document.body)}
  </div>
}
