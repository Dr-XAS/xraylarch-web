import type { InspectionResponse } from "@/lib/contracts"

import { StatusBadge } from "@/components/status-badge"
import type { WorkbenchStatus } from "@/lib/workbench-state"

interface SpectrumTrayProps {
  inspection: InspectionResponse | null
  activeRevisionId: number | null
  status: WorkbenchStatus
}

export function SpectrumTray({ inspection, activeRevisionId, status }: SpectrumTrayProps) {
  return (
    <section className="spectrum-tray" aria-label="Active spectrum">
      <div>
        <p className="eyebrow">Active spectrum</p>
        <h2 title={inspection?.display_name ?? undefined}>{inspection?.display_name ?? "No spectrum uploaded"}</h2>
        <p className="muted">
          {inspection ? `${inspection.row_count.toLocaleString()} data points` : "Upload a text, CSV, or XDI spectrum to begin."}
          {activeRevisionId !== null ? ` · Revision ${activeRevisionId}` : ""}
        </p>
      </div>
      <div className="tray-status">
        <StatusBadge status={status} />
        {inspection?.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
      </div>
    </section>
  )
}
