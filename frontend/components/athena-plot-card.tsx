"use client"

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"

export const athenaPlotHeightKey = "athena.plot.height.v1"
const minimumHeight = 280
const maximumHeight = 1600

function clampHeight(height: number) {
  return Math.min(maximumHeight, Math.max(minimumHeight, Math.round(height)))
}

function saveHeight(height: number | null) {
  try {
    if (height === null) localStorage.removeItem(athenaPlotHeightKey)
    else localStorage.setItem(athenaPlotHeightKey, String(height))
  } catch { /* The plot remains resizable when storage is unavailable. */ }
}

export function ResizablePlotCard({ children }: { children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number; preferred: number | null } | null>(null)
  const heightRef = useRef<number | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [measuredHeight, setMeasuredHeight] = useState(380)
  const [dragging, setDragging] = useState(false)

  function plotHeight() {
    return cardRef.current?.querySelector<HTMLElement>(".ath-plot, .ath-no-plot")?.getBoundingClientRect().height || 380
  }

  function resize(next: number | null, persist = false) {
    const fitted = next === null ? null : clampHeight(next)
    heightRef.current = fitted
    setHeight(fitted)
    if (persist) saveHeight(fitted)
  }

  function beginResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.isPrimary === false || dragRef.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY + window.scrollY, startHeight: plotHeight(), preferred: heightRef.current }
    setDragging(true)
  }

  function finishResize(pointerId: number, cancel = false) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== pointerId) return
    dragRef.current = null
    setDragging(false)
    if (cancel) resize(drag.preferred)
    else saveHeight(heightRef.current)
  }

  function reset() {
    dragRef.current = null
    setDragging(false)
    resize(null, true)
  }

  function keyboardResize(event: KeyboardEvent<HTMLDivElement>) {
    if (dragRef.current) return
    const step = event.shiftKey ? 48 : 16
    let next: number | null
    switch (event.key) {
      case "ArrowUp": next = plotHeight() - step; break
      case "ArrowDown": next = plotHeight() + step; break
      case "Home": next = minimumHeight; break
      case "End": next = maximumHeight; break
      case "Enter": case " ": event.preventDefault(); reset(); return
      default: return
    }
    event.preventDefault()
    resize(next, true)
  }

  useEffect(() => {
    try {
      const stored = localStorage.getItem(athenaPlotHeightKey)
      const preferred = Number(stored)
      if (stored?.trim() && Number.isFinite(preferred) && preferred > 0) resize(preferred)
    } catch { /* Keep the responsive default for an unavailable preference. */ }
    const measure = () => setMeasuredHeight(Math.round(plotHeight()))
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    if (cardRef.current) observer?.observe(cardRef.current)
    window.addEventListener("resize", measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])

  useEffect(() => {
    // react-plotly's resize handler listens to the window, not its container.
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
    return () => window.cancelAnimationFrame(frame)
  }, [height])

  useEffect(() => {
    if (!dragging) return
    const cursor = document.body.style.cursor
    const selection = document.body.style.userSelect
    document.body.style.cursor = "row-resize"
    document.body.style.userSelect = "none"
    function move(event: globalThis.PointerEvent) {
      const drag = dragRef.current
      if (drag?.pointerId === event.pointerId) resize(drag.startHeight + event.clientY + window.scrollY - drag.startY)
    }
    function finish(event: globalThis.PointerEvent) { finishResize(event.pointerId) }
    function cancel(event: globalThis.PointerEvent) { finishResize(event.pointerId, true) }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || !dragRef.current) return
      event.preventDefault()
      finishResize(dragRef.current.pointerId, true)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("keydown", escape)
    return () => {
      document.body.style.cursor = cursor
      document.body.style.userSelect = selection
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("keydown", escape)
    }
  }, [dragging])

  const style = height === null ? undefined : { "--ath-plot-height": `${height}px` } as CSSProperties
  return <div ref={cardRef} className="ath-plot-card" style={style} data-plot-resizing={dragging || undefined} data-plot-height={height ?? undefined}>
    {children}
    <div className="ath-plot-height-resizer" role="separator" tabIndex={0}
      aria-label="Resize spectrum plot height" aria-controls="athena-spectrum-viewer" aria-orientation="horizontal"
      aria-valuemin={minimumHeight} aria-valuemax={maximumHeight} aria-valuenow={height ?? measuredHeight}
      aria-valuetext={`${height ?? measuredHeight} pixels`}
      title="Drag up or down to resize the plot. Use Up/Down arrows for precise control; double-click or press Enter to reset."
      onPointerDown={beginResize} onLostPointerCapture={event => finishResize(event.pointerId)}
      onKeyDown={keyboardResize} onDoubleClick={reset}>
      <span aria-hidden="true" className="ath-plot-resize-grip" /><span aria-hidden="true">Drag to resize plot</span>
    </div>
  </div>
}
