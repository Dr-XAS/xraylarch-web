"use client"

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react"

const dividerWidth = 9
const desktopBreakpoint = 950
const narrowDesktopBreakpoint = 1200
const minimumGroupsWidth = 180
const minimumProcessingWidth = 260
const wideMinimumSpectrumWidth = 430
const narrowMinimumSpectrumWidth = 380
const keyboardStep = 16

export const athenaWorkspaceSizesKey = "athena.workspace.sizes.v1"

type PaneSizes = { groups: number; processing: number }
type Divider = "groups-processing" | "processing-spectrum"
type PaneRects = PaneSizes & { spectrum: number }

type Props = {
  groups: ReactElement
  processing: ReactElement
  spectrum: ReactElement
}

type WorkspaceStyle = CSSProperties & {
  "--ath-groups-width"?: string
  "--ath-processing-width"?: string
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

function minimumSpectrumWidth(workspaceWidth: number) {
  return workspaceWidth <= narrowDesktopBreakpoint ? narrowMinimumSpectrumWidth : wideMinimumSpectrumWidth
}

function defaultPaneSizes(workspaceWidth: number): PaneSizes {
  if (workspaceWidth >= 1650) return { groups: 270, processing: 340 }
  if (workspaceWidth <= narrowDesktopBreakpoint) return { groups: 198, processing: 275 }
  return { groups: 237, processing: 307 }
}

function fitPaneSizes(sizes: PaneSizes, workspaceWidth: number): PaneSizes {
  if (workspaceWidth <= desktopBreakpoint) return sizes
  const usableWidth = workspaceWidth - dividerWidth * 2
  const spectrumMinimum = minimumSpectrumWidth(workspaceWidth)
  const groupsMaximum = Math.max(minimumGroupsWidth, usableWidth - minimumProcessingWidth - spectrumMinimum)
  const groups = clamp(Math.round(sizes.groups), minimumGroupsWidth, groupsMaximum)
  const processingMaximum = Math.max(minimumProcessingWidth, usableWidth - groups - spectrumMinimum)
  return {
    groups,
    processing: clamp(Math.round(sizes.processing), minimumProcessingWidth, processingMaximum),
  }
}

function sameSizes(left: PaneSizes, right: PaneSizes) {
  return left.groups === right.groups && left.processing === right.processing
}

function readStoredSizes() {
  try {
    const stored = JSON.parse(localStorage.getItem(athenaWorkspaceSizesKey) ?? "null") as Partial<PaneSizes> | null
    if (stored && Number.isFinite(stored.groups) && Number.isFinite(stored.processing)) {
      return { groups: Number(stored.groups), processing: Number(stored.processing) }
    }
  } catch {
    // A corrupt or unavailable preference should never prevent the workspace from opening.
  }
  return null
}

function writeStoredSizes(sizes: PaneSizes) {
  try { localStorage.setItem(athenaWorkspaceSizesKey, JSON.stringify(sizes)) } catch { /* Resizing still works without persistence. */ }
}

function WorkspaceDivider({
  divider,
  label,
  controls,
  now,
  minimum,
  maximum,
  onPointerDown,
  onPointerCaptureLost,
  onKeyboardResize,
  onReset,
}: {
  divider: Divider
  label: string
  controls: string
  now: number
  minimum: number
  maximum: number
  onPointerDown: (divider: Divider, event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCaptureLost: (pointerId: number) => void
  onKeyboardResize: (divider: Divider, movement: number | "minimum" | "maximum") => void
  onReset: () => void
}) {
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onReset()
      return
    }
    let movement: number | "minimum" | "maximum" | null = null
    if (event.key === "ArrowLeft") movement = -(event.shiftKey ? keyboardStep * 3 : keyboardStep)
    if (event.key === "ArrowRight") movement = event.shiftKey ? keyboardStep * 3 : keyboardStep
    if (event.key === "Home") movement = "minimum"
    if (event.key === "End") movement = "maximum"
    if (movement === null) return
    event.preventDefault()
    onKeyboardResize(divider, movement)
  }

  return <div
    className="ath-workspace-resizer"
    data-divider={divider}
    role="separator"
    tabIndex={0}
    aria-label={label}
    aria-controls={controls}
    aria-orientation="vertical"
    aria-valuemin={Math.round(minimum)}
    aria-valuemax={Math.max(Math.round(minimum), Math.round(maximum))}
    aria-valuenow={Math.round(now)}
    aria-valuetext={`${Math.round(now)} pixels`}
    title="Drag to resize. Use the arrow keys for precise control; press Enter or double-click to reset."
    onPointerDown={event => onPointerDown(divider, event)}
    onLostPointerCapture={event => onPointerCaptureLost(event.pointerId)}
    onKeyDown={handleKeyDown}
    onDoubleClick={onReset}
  />
}

export function ResizableAthenaWorkspace({ groups, processing, spectrum }: Props) {
  const workspaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ divider: Divider; pointerId: number; startX: number; panes: PaneRects; preferred: PaneSizes | null } | null>(null)
  const sizesRef = useRef<PaneSizes | null>(null)
  const [sizes, setSizes] = useState<PaneSizes | null>(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const [activeDivider, setActiveDivider] = useState<Divider | null>(null)

  function measurePanes(): PaneRects | null {
    const workspace = workspaceRef.current
    const groupsPane = workspace?.querySelector<HTMLElement>(".ath-groups")
    const processingPane = workspace?.querySelector<HTMLElement>(".ath-parameters")
    const spectrumPane = workspace?.querySelector<HTMLElement>(".ath-center")
    if (!groupsPane || !processingPane || !spectrumPane) return null
    return {
      groups: groupsPane.getBoundingClientRect().width,
      processing: processingPane.getBoundingClientRect().width,
      spectrum: spectrumPane.getBoundingClientRect().width,
    }
  }

  function setFittedSizes(next: PaneSizes, persist = false) {
    const width = workspaceRef.current?.getBoundingClientRect().width ?? workspaceWidth
    const fitted = fitPaneSizes(next, width)
    sizesRef.current = fitted
    setSizes(current => current && sameSizes(current, fitted) ? current : fitted)
    if (persist) writeStoredSizes(fitted)
  }

  function resizeFromRects(divider: Divider, panes: PaneRects, movement: number | "minimum" | "maximum", persist = false) {
    if (divider === "groups-processing") {
      const pairWidth = panes.groups + panes.processing
      const groupsMaximum = pairWidth - minimumProcessingWidth
      const requested = movement === "minimum" ? minimumGroupsWidth : movement === "maximum" ? groupsMaximum : panes.groups + movement
      const nextGroups = clamp(requested, minimumGroupsWidth, groupsMaximum)
      setFittedSizes({ groups: nextGroups, processing: pairWidth - nextGroups }, persist)
      return
    }

    const pairWidth = panes.processing + panes.spectrum
    const processingMaximum = pairWidth - minimumSpectrumWidth(workspaceWidth)
    const requested = movement === "minimum" ? minimumProcessingWidth : movement === "maximum" ? processingMaximum : panes.processing + movement
    setFittedSizes({ groups: panes.groups, processing: clamp(requested, minimumProcessingWidth, processingMaximum) }, persist)
  }

  function beginResize(divider: Divider, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.isPrimary === false || dragRef.current) return
    const panes = measurePanes()
    if (!panes) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { divider, pointerId: event.pointerId, startX: event.clientX, panes, preferred: sizesRef.current }
    setActiveDivider(divider)
  }

  function finishResize(pointerId: number) {
    if (dragRef.current?.pointerId !== pointerId) return
    dragRef.current = null
    setActiveDivider(null)
    if (sizesRef.current) writeStoredSizes(sizesRef.current)
  }

  function cancelResize(pointerId: number) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== pointerId) return
    sizesRef.current = drag.preferred
    setSizes(drag.preferred)
    dragRef.current = null
    setActiveDivider(null)
  }

  function resizeWithKeyboard(divider: Divider, movement: number | "minimum" | "maximum") {
    const panes = measurePanes()
    if (panes) resizeFromRects(divider, panes, movement, true)
  }

  function resetSizes() {
    sizesRef.current = null
    setSizes(null)
    try { localStorage.removeItem(athenaWorkspaceSizesKey) } catch { /* Keep the CSS defaults when storage is unavailable. */ }
  }

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const storedSizes = readStoredSizes()
    if (storedSizes) {
      sizesRef.current = storedSizes
      setSizes(storedSizes)
    }
    const updateForWidth = () => {
      const width = workspace.getBoundingClientRect().width
      if (!Number.isFinite(width) || width <= 0) return
      setWorkspaceWidth(width)
    }
    updateForWidth()
    window.addEventListener("resize", updateForWidth)
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateForWidth)
    observer?.observe(workspace)
    return () => {
      window.removeEventListener("resize", updateForWidth)
      observer?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (typeof window.PointerEvent === "undefined") return
    const redraw = window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
    return () => window.cancelAnimationFrame(redraw)
  }, [sizes])

  useEffect(() => {
    function move(event: PointerEvent) {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      resizeFromRects(drag.divider, drag.panes, event.clientX - drag.startX)
    }
    function finish(event: PointerEvent) {
      finishResize(event.pointerId)
    }
    function cancelPointer(event: PointerEvent) {
      cancelResize(event.pointerId)
    }
    function cancel(event: KeyboardEvent) {
      const drag = dragRef.current
      if (!drag || event.key !== "Escape") return
      event.preventDefault()
      cancelResize(drag.pointerId)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", cancelPointer)
    window.addEventListener("keydown", cancel)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", cancelPointer)
      window.removeEventListener("keydown", cancel)
    }
  })

  useEffect(() => {
    if (!activeDivider) return
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
    }
  }, [activeDivider])

  const effectiveSizes = sizes ? fitPaneSizes(sizes, workspaceWidth) : defaultPaneSizes(workspaceWidth)
  const usableWidth = Math.max(0, workspaceWidth - dividerWidth * 2)
  const spectrumWidth = Math.max(minimumSpectrumWidth(workspaceWidth), usableWidth - effectiveSizes.groups - effectiveSizes.processing)
  const style: WorkspaceStyle | undefined = sizes ? {
    "--ath-groups-width": `${effectiveSizes.groups}px`,
    "--ath-processing-width": `${effectiveSizes.processing}px`,
  } : undefined

  return <div ref={workspaceRef} className="ath-workspace" data-testid="athena-workspace" data-resizing={activeDivider ?? undefined} style={style}>
    {groups}
    <WorkspaceDivider divider="groups-processing" label="Resize data groups and processing parameters" controls="athena-data-groups athena-processing-parameters"
      now={effectiveSizes.groups} minimum={minimumGroupsWidth} maximum={effectiveSizes.groups + effectiveSizes.processing - minimumProcessingWidth}
      onPointerDown={beginResize} onPointerCaptureLost={finishResize} onKeyboardResize={resizeWithKeyboard} onReset={resetSizes} />
    {processing}
    <WorkspaceDivider divider="processing-spectrum" label="Resize processing parameters and spectrum viewer" controls="athena-processing-parameters athena-spectrum-viewer"
      now={effectiveSizes.processing} minimum={minimumProcessingWidth} maximum={effectiveSizes.processing + spectrumWidth - minimumSpectrumWidth(workspaceWidth)}
      onPointerDown={beginResize} onPointerCaptureLost={finishResize} onKeyboardResize={resizeWithKeyboard} onReset={resetSizes} />
    {spectrum}
  </div>
}
