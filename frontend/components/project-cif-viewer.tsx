"use client"

import { useMemo } from "react"
import type { ArtemisStructureAttachment } from "@/lib/artemis-structures"
import { CifViewer } from "./cif-viewer"
import { ViewerPanel } from "./viewer-panel"

export function ProjectCifViewer({ attachments = [], selectedId, onSelect }: {
  attachments?: ArtemisStructureAttachment[]
  selectedId?: string
  onSelect: (attachmentId: string) => void
}) {
  const selected = attachments.find(attachment => attachment.id === selectedId) ?? attachments[0]
  // Attachments are immutable, content-addressed snapshots. Ordinary project
  // refreshes must not rebuild the same geometry and reset the user's camera.
  const structure = useMemo(() => selected?.structure, [selected?.id, selected?.sha256])
  if (!selected || !structure) return <ViewerPanel title="CIF structure viewer" className="ath-project-cif-viewer">
    <p className="ath-cif-empty">Attach a CIF in the EXAFS fitting tab to view its structure here.</p>
  </ViewerPanel>

  return <div className="ath-project-cif-viewer">
    <CifViewer key={`${selected.id}:${selected.sha256}`} structure={structure} collapsible structureControls={
      <label className="ath-cif-selection">Project CIF
        <select aria-label="Viewed CIF structure" value={selected.id} onChange={event => onSelect(event.target.value)}>
          {attachments.map(attachment => <option key={attachment.id} value={attachment.id}>
            {attachment.structure.mineral || attachment.structure.formula} · AMCSD {String(attachment.amcsd_id).padStart(7, "0")}
          </option>)}
        </select>
      </label>
    } />
  </div>
}
