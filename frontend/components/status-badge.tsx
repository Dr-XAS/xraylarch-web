import type { WorkbenchStatus } from "@/lib/workbench-state"

const labels: Record<WorkbenchStatus, string> = {
  idle: "Review",
  ready: "Ready",
  blocked: "Blocked",
  previewing: "Review",
  "preview-ready": "Preview available",
  error: "Not current",
}

export function StatusBadge({ status }: { status: WorkbenchStatus }) {
  return <span className={`status-badge status-${status}`}>{labels[status]}</span>
}
