"use client"

import { useId, useState } from "react"

import type { InspectionResponse } from "@/lib/contracts"

interface UploadInspectorProps {
  inspection: InspectionResponse | null
  disabled: boolean
  onUpload: (file: File) => Promise<void>
  onConfirmMapping: (energyColumn: string, signalColumn: string) => Promise<void>
}

export function UploadInspector({ inspection, disabled, onUpload, onConfirmMapping }: UploadInspectorProps) {
  const [energyColumn, setEnergyColumn] = useState("")
  const [signalColumn, setSignalColumn] = useState("")
  const [busy, setBusy] = useState(false)
  const uploadHelpId = useId()
  const canConfirm = Boolean(inspection && energyColumn && signalColumn && energyColumn !== signalColumn && !busy)

  async function upload(file: File | undefined) {
    if (!file) return
    setEnergyColumn("")
    setSignalColumn("")
    setBusy(true)
    try {
      await onUpload(file)
    } finally {
      setBusy(false)
    }
  }

  async function confirmMapping() {
    if (!canConfirm) return
    setBusy(true)
    try {
      await onConfirmMapping(energyColumn, signalColumn)
    } finally {
      setBusy(false)
    }
  }

  const numericColumns = inspection?.columns.filter((column) => column.numeric) ?? []
  return (
    <section className="inspector-card" data-testid="upload-inspector" aria-labelledby="import-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Import</p>
          <h2 id="import-heading">Spectrum source</h2>
        </div>
      </div>
      <label className="file-label" htmlFor="spectrum-upload">Upload spectrum</label>
      <input
        id="spectrum-upload"
        aria-describedby={uploadHelpId}
        type="file"
        disabled={disabled || busy}
        onChange={(event) => void upload(event.currentTarget.files?.[0])}
      />
      <p className="field-help" id={uploadHelpId}>Any file type is accepted. Text, CSV, and XDI data can be inspected; the original file remains unchanged.</p>

      {inspection && (
        <div className="mapping-panel" data-testid="column-mapping" aria-live="polite">
          <h3>Confirm source columns</h3>
          <p className="field-help">Select both roles explicitly. Suggestions below are not applied automatically.</p>
          {inspection.issues.map((issue) => <p className="warning" key={issue.code}>{issue.message}</p>)}
          <div className="column-list" aria-label="Available numeric columns">
            {numericColumns.map((column) => (
              <span key={column.column_id} className="column-chip">
                {column.name} · column {column.index + 1}{column.unit ? ` (${column.unit})` : ""}{column.role_hint ? ` · suggested ${column.role_hint}` : ""}
              </span>
            ))}
          </div>
          <div className="mapping-controls">
            <label>
              Energy column
              <select value={energyColumn} onChange={(event) => setEnergyColumn(event.target.value)}>
                <option value="">Choose energy</option>
                {numericColumns.map((column) => <option key={column.column_id} value={column.column_id}>{column.name} · column {column.index + 1}{column.unit ? ` (${column.unit})` : ""}</option>)}
              </select>
            </label>
            <label>
              Signal column
              <select value={signalColumn} onChange={(event) => setSignalColumn(event.target.value)}>
                <option value="">Choose signal</option>
                {numericColumns.map((column) => <option key={column.column_id} value={column.column_id}>{column.name} · column {column.index + 1}</option>)}
              </select>
            </label>
          </div>
          <button type="button" onClick={() => void confirmMapping()} disabled={!canConfirm}>Confirm mapping</button>
        </div>
      )}
    </section>
  )
}
