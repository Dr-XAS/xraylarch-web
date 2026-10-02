"use client"

import { useMemo } from "react"
import { structureLabel, type ArtemisStructureAttachment } from "@/lib/artemis-structures"
import { CifViewer } from "./cif-viewer"
import { ViewerPanel } from "./viewer-panel"

export function ProjectCifViewer({ attachments = [], selectedId, selectedSite, onSelect }: {
  attachments?: ArtemisStructureAttachment[]
  selectedId?: string
  selectedSite?: number
  onSelect: (attachmentId: string, siteIndex?: number) => void
}) {
  const selected = attachments.find(attachment => attachment.id === selectedId) ?? attachments[0]
  // Attachments are immutable, content-addressed snapshots. Ordinary project
  // refreshes must not rebuild the same geometry and reset the user's camera.
  const structure = useMemo(() => selected?.structure, [selected?.id, selected?.sha256])
  if (!selected || !structure) return <ViewerPanel title="CIF structure viewer" viewerId="cif" className="ath-project-cif-viewer" help="Attach a CIF in the EXAFS fitting tab to view its structure here.">
    <p className="ath-cif-empty">No CIF attached</p>
  </ViewerPanel>

  return <div className="ath-project-cif-viewer">
    <CifViewer key={`${selected.id}:${selected.sha256}`} structure={structure} selectedSite={selected.id === selectedId && structure.sites.some(site => site.index === selectedSite) ? selectedSite : undefined} onSiteChange={site => onSelect(selected.id, site)} collapsible structureControls={
      <label className="ath-cif-selection">Project CIF
        <select aria-label="Viewed CIF structure" value={selected.id} onChange={event => onSelect(event.target.value)}>
          {attachments.map(attachment => <option key={attachment.id} value={attachment.id}>
            {attachment.structure.mineral || attachment.structure.formula} · {structureLabel(attachment.structure)}
          </option>)}
        </select>
      </label>
    } />
  </div>
}
