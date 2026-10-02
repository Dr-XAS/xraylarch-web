"use client"

import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react"
import { GripVertical } from "lucide-react"
import { viewerLabels, type ViewerId } from "@/lib/athena-viewer-order"
import { viewerIcons } from "./athena-viewer-icons"

type Drag = { id: ViewerId; pointerId: number; x: number; y: number; moved: boolean; target: ViewerId | null }

export function AthenaViewerChooser({ order, shown, onToggle, onToggleAll, onMove }: {
  order: readonly ViewerId[]
  shown: ReadonlySet<ViewerId>
  onToggle: (id: ViewerId) => void
  onToggleAll: () => void
  onMove: (source: ViewerId, target: ViewerId) => void
}) {
  const helpId = useId()
  const container = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const pendingFocus = useRef<ViewerId | null>(null)
  const [preview, setPreview] = useState<{ source: ViewerId; target: ViewerId | null } | null>(null)
  const [announcement, setAnnouncement] = useState("")

  useLayoutEffect(() => {
    if (!pendingFocus.current) return
    container.current?.querySelector<HTMLButtonElement>(`[data-viewer-chip-id="${pendingFocus.current}"] .ath-viewer-reorder`)?.focus({ preventScroll: true })
    pendingFocus.current = null
  }, [order])

  function move(source: ViewerId, target: ViewerId) {
    if (source === target) return
    pendingFocus.current = source
    onMove(source, target)
    setAnnouncement(`${viewerLabels[source]} moved to position ${order.indexOf(target) + 1} of ${order.length}.`)
  }

  function targetAt(x: number, y: number): ViewerId | null {
    const root = container.current
    if (!root) return null
    const bounds = root.getBoundingClientRect()
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null
    const all = root.querySelector(".ath-viewer-all")?.getBoundingClientRect()
    if (all && x >= all.left && x <= all.right && y >= all.top && y <= all.bottom) return null
    let nearest: ViewerId | null = null, distance = Infinity
    root.querySelectorAll<HTMLElement>("[data-viewer-chip-id]").forEach(chip => {
      const rect = chip.getBoundingClientRect()
      const dx = Math.max(rect.left - x, 0, x - rect.right)
      const dy = Math.max(rect.top - y, 0, y - rect.bottom)
      if (dx * dx + dy * dy < distance) {
        distance = dx * dx + dy * dy
        nearest = chip.dataset.viewerChipId as ViewerId
      }
    })
    return nearest
  }

  function cancelDrag() {
    drag.current = null
    setPreview(null)
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: ViewerId) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, target: null }
  }

  function updateDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return
    current.moved = true
    current.target = targetAt(event.clientX, event.clientY)
    setPreview({ source: current.id, target: current.target })
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const target = current.moved ? targetAt(event.clientX, event.clientY) : null
    cancelDrag()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (target) move(current.id, target)
  }

  return <>
    <div ref={container} className="ath-viewer-chips" role="group" aria-label="Choose viewers">
      <button type="button" className="ath-viewer-chip ath-viewer-all" aria-pressed={order.every(id => shown.has(id))} onClick={onToggleAll}>All viewers</button>
      {order.map((id, index) => {
        const Icon = viewerIcons[id]
        return <div key={id} className="ath-viewer-chip ath-viewer-chip-sortable" data-viewer-theme={id} data-viewer-chip-id={id} data-shown={shown.has(id)} data-dragging={preview?.source === id ? true : undefined} data-drop-target={preview?.target === id && preview.source !== id}>
          <button type="button" className="ath-viewer-reorder" aria-label={`Reorder ${viewerLabels[id]}`} aria-describedby={helpId} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End" title={`Drag to reorder ${viewerLabels[id]}, or use arrow keys`}
            onPointerDown={event => startDrag(event, id)} onPointerMove={updateDrag} onPointerUp={finishDrag}
            onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag() }}
            onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag() }}
            onKeyDown={event => {
              if (event.key === "Escape" && drag.current) {
                event.preventDefault(); event.stopPropagation()
                const pointerId = drag.current.pointerId
                cancelDrag()
                if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId)
                return
              }
              if (drag.current || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
              const target = event.key === "Home" ? 0 : event.key === "End" ? order.length - 1
                : ["ArrowLeft", "ArrowUp"].includes(event.key) ? index - 1 : ["ArrowRight", "ArrowDown"].includes(event.key) ? index + 1 : null
              if (target === null) return
              event.preventDefault()
              if (order[target]) move(id, order[target])
            }}><GripVertical size={14} aria-hidden="true" /></button>
          <button type="button" className="ath-viewer-toggle" aria-pressed={shown.has(id)} onClick={() => onToggle(id)}>
            <span className="ath-viewer-chip-icon" aria-hidden="true"><Icon size={20} strokeWidth={2} /></span>{viewerLabels[id]}
          </button>
        </div>
      })}
    </div>
    <p id={helpId} className="ath-viewer-order-hint">Drag a handle to reorder viewers, or focus it and use arrow keys.</p>
    <span className="ath-sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
  </>
}
