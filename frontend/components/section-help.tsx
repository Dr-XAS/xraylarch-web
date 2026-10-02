"use client"

import { Info } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import styles from "./section-help.module.css"

/** Inline help that stays readable outside scrolling panels and inside modal dialogs. */
export function SectionHelp({ label, children, id }: { label: string; children: ReactNode; id?: string }) {
  const generatedId = useId()
  const descriptionId = id ?? generatedId
  const trigger = useRef<HTMLSpanElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerWasOpen = useRef(false)
  const [host, setHost] = useState<Element | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  function cancelTimer() {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  function close() { cancelTimer(); setOpen(false) }
  function show() { cancelTimer(); setOpen(true) }
  function leave() {
    cancelTimer()
    if (document.activeElement === trigger.current || tooltip.current?.contains(document.activeElement)) return
    timer.current = setTimeout(() => setOpen(false), 180)
  }
  function helpLinks() {
    return Array.from(tooltip.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])
  }

  useEffect(() => {
    setHost(trigger.current?.closest("dialog") ?? document.body)
    return cancelTimer
  }, [])
  useLayoutEffect(() => {
    if (!open || !host) return
    const anchor = trigger.current?.getBoundingClientRect()
    const bounds = tooltip.current?.getBoundingClientRect()
    if (!anchor || !bounds) return
    const margin = 8
    const below = anchor.bottom + margin
    setPosition({
      left: Math.max(margin, Math.min(anchor.left, window.innerWidth - bounds.width - margin)),
      top: Math.max(margin, Math.min(below + bounds.height <= window.innerHeight - margin
        ? below : anchor.top - bounds.height - margin, window.innerHeight - bounds.height - margin)),
    })
  }, [open, host, children])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (event.target instanceof Node && (trigger.current?.contains(event.target) || tooltip.current?.contains(event.target))) return
      close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation()
        if (tooltip.current?.contains(document.activeElement)) trigger.current?.focus()
        close()
      }
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && tooltip.current?.contains(event.target)) return
      close()
    }
    document.addEventListener("keydown", escape, true)
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("focusin", outside)
    window.addEventListener("scroll", scroll, true)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("keydown", escape, true)
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("focusin", outside)
      window.removeEventListener("scroll", scroll, true)
      window.removeEventListener("resize", close)
    }
  }, [open])

  return <>
    {/* A native button inside a label would become its associated control. */}
    <span ref={trigger} role="button" tabIndex={0} className={styles.trigger} aria-label={`About ${label}`} aria-describedby={descriptionId}
      onMouseEnter={show} onMouseLeave={leave} onFocus={show}
      onBlur={event => { if (!tooltip.current?.contains(event.relatedTarget)) close() }}
      onPointerDown={event => { pointerWasOpen.current = open; event.stopPropagation() }}
      onKeyDown={event => {
        if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); show() }
        if (event.key === "Tab" && !event.shiftKey && open && helpLinks().length) {
          event.preventDefault(); helpLinks()[0].focus()
        }
      }}
      onClick={event => {
        // A help icon in a label or disclosure must never activate that control.
        event.preventDefault(); event.stopPropagation(); cancelTimer()
        setOpen(event.detail === 0 || !pointerWasOpen.current)
      }}>
      <Info size={14} strokeWidth={1.8} aria-hidden="true" />
    </span>
    {host && createPortal(<div ref={tooltip} id={descriptionId} role="tooltip" hidden={!open}
      className={styles.tooltip} style={position} onMouseEnter={show} onMouseLeave={leave}
      onKeyDown={event => {
        if (event.key !== "Tab") return
        const links = helpLinks()
        if (event.shiftKey && event.target === links[0]) { event.preventDefault(); trigger.current?.focus() }
        else if (!event.shiftKey && event.target === links.at(-1)) {
          // Continue the normal tab order after the icon, not at the portal host.
          trigger.current?.focus(); close()
        }
      }}
      onClick={event => event.stopPropagation()}>
      {open && <strong className={styles.title}>{label}</strong>}
      <div>{children}</div>
    </div>, host)}
  </>
}
