"use client"

import { useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { SlidersHorizontal } from "lucide-react"
import { FitCurvesIcon } from "./athena-viewer-icons"

export type ParameterTab = "processing" | "fitting"

export function AthenaParameterTabs({ tab, select, processing, fitting, onProcessingContextMenu }: {
  tab: ParameterTab
  select: (tab: ParameterTab) => void
  processing: ReactNode
  /** Pass null to drop the fitting tab entirely: a linked integration project cannot be fitted. */
  fitting: ReactNode | null
  onProcessingContextMenu?: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void
}) {
  const id = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const tabs = ["processing", "fitting"] as const
  if (fitting === null) return <>{processing}</>
  return <>
    <div className="ath-parameter-tabs" role="tablist" aria-label="Parameter workflow">
      {tabs.map((value, index) => <button key={value} type="button"
        ref={element => { buttons.current[index] = element }}
        id={`${id}-${value}-tab`} role="tab" aria-selected={tab === value}
        aria-controls={`${id}-${value}-panel`} tabIndex={tab === value ? 0 : -1}
        onContextMenu={value === "processing" ? onProcessingContextMenu : undefined}
        onClick={() => select(value)} onKeyDown={event => {
          if (value === "processing" && onProcessingContextMenu && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
            onProcessingContextMenu(event)
            return
          }
          const next = event.key === "Home" ? 0 : event.key === "End" ? 1
            : ["ArrowLeft", "ArrowRight"].includes(event.key) ? 1 - index : null
          if (next === null) return
          event.preventDefault()
          select(tabs[next])
          buttons.current[next]?.focus()
        }}>
        {value === "processing" ? <SlidersHorizontal size={20} aria-hidden="true" /> : <FitCurvesIcon size={20} aria-hidden="true" />}
        <span>{value === "processing" ? "Processing" : "EXAFS fitting"}</span>
      </button>)}
    </div>
    {tabs.map(value => <div key={value} className="ath-parameter-tab-panel"
      id={`${id}-${value}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}-tab`}
      hidden={tab !== value} tabIndex={0}>
      {value === "processing" ? processing : fitting}
    </div>)}
  </>
}
