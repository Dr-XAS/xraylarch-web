import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

/** Shared disclosure heading for processing and fitting; native details retain form state. */
export function ParameterSectionHeading({ icon: Icon, children, detail }: {
  icon: LucideIcon
  children: ReactNode
  detail?: string
}) {
  return <summary className="ath-parameter-section-heading">
    <Icon size={20} strokeWidth={2} aria-hidden="true" />
    <span className="ath-parameter-section-title">{children}{detail && <small>{detail}</small>}</span>
  </summary>
}
