"use client"

import { useId, useRef, type ReactNode } from "react"

export type ParameterTab = "processing" | "fitting"

export function AthenaParameterTabs({ tab, select, processing, fitting }: {
  tab: ParameterTab
  select: (tab: ParameterTab) => void
  processing: ReactNode
  /** Pass null to drop the fitting tab entirely: a linked integration project cannot be fitted. */
  fitting: ReactNode | null
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
        onClick={() => select(value)} onKeyDown={event => {
          const next = event.key === "Home" ? 0 : event.key === "End" ? 1
            : ["ArrowLeft", "ArrowRight"].includes(event.key) ? 1 - index : null
          if (next === null) return
          event.preventDefault()
          select(tabs[next])
          buttons.current[next]?.focus()
        }}>
        {value === "processing" ? "Processing" : "EXAFS fitting"}
      </button>)}
    </div>
    {tabs.map(value => <div key={value} className="ath-parameter-tab-panel"
      id={`${id}-${value}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}-tab`}
      hidden={tab !== value} tabIndex={0}>
      {value === "processing" ? processing : fitting}
    </div>)}
  </>
}
