"use client"

import { useId, type ReactNode } from "react"
import { SectionHelp } from "./section-help"

/** The field keeps an accessible description even when instruction icons are hidden. */
export function ParameterHelp({ label, help, children }: {
  label: string
  help: string
  children: (descriptionId: string, helpIcon: ReactNode) => ReactNode
}) {
  const descriptionId = useId()
  return children(descriptionId, <SectionHelp label={label} id={descriptionId}>{help}</SectionHelp>)
}
