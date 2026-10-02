import type { InspectionResponse } from "@/lib/contracts"

import { SectionHelp } from "./section-help"
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
        <h2 title={inspection?.display_name ?? undefined}>{inspection?.display_name ?? "No spectrum uploaded"}{!inspection && <SectionHelp label="Active spectrum">Upload a spectrum file to begin.</SectionHelp>}</h2>
        {inspection && <p className="muted">
          {`${inspection.row_count.toLocaleString()} data points`}
          {activeRevisionId !== null ? ` · Revision ${activeRevisionId}` : ""}
        </p>}
      </div>
      <div className="tray-status">
        <StatusBadge status={status} />
        {inspection?.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
      </div>
    </section>
  )
}
