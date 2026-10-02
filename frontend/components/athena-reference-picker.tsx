"use client"

import { SectionHelp } from "./section-help"
import { useId, useState } from "react"
import type { AthenaGroup } from "@/lib/athena"
import styles from "./athena-reference-picker.module.css"

type Props = {
  groups: AthenaGroup[]
  initialSampleIds: string[]
  busy: boolean
  error: string
  onApply: (sampleIds: string[], referenceId: string | null) => void
  onClose: () => void
}

export function AthenaReferencePicker({ groups, initialSampleIds, busy, error, onApply, onClose }: Props) {
  const hintId = useId()
  const energyGroups = groups.filter(group => group.data_type !== "chi")
  const [selectedIds, setSelectedIds] = useState(() => new Set(initialSampleIds))
  const [referenceId, setReferenceId] = useState<string | null>(() => {
    const samples = energyGroups.filter(group => initialSampleIds.includes(group.id))
    const common = samples[0]?.reference_id
    return common && samples.every(group => group.reference_id === common)
      && energyGroups.some(group => group.id === common) ? common : null
  })
  const sampleIds = energyGroups.filter(group => selectedIds.has(group.id) && group.id !== referenceId).map(group => group.id)
  const canApply = !busy && referenceId !== null && sampleIds.length > 0
    && (referenceId === "" || energyGroups.some(group => group.id === referenceId))

  function selectReference(value: string) {
    setReferenceId(value)
    setSelectedIds(current => {
      const next = new Set(current)
      next.delete(value)
      return next
    })
  }

  function toggleSample(id: string, selected: boolean) {
    setSelectedIds(current => {
      const next = new Set(current)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return <form className={`ath-modal-body ${styles.body}`} onSubmit={event => {
    event.preventDefault()
    if (canApply) onApply(sampleIds, referenceId || null)
  }}>
    <label className="ath-field"><span>Reference foil <SectionHelp id={hintId} label="Linked references">Multiple spectra can share one reference foil. Assigning a reference adopts its energy shift; linked data then shift together. Removing a reference keeps each selected spectrum’s current energy shift.</SectionHelp></span>
      <select value={referenceId ?? "__choose__"} disabled={busy} aria-describedby={hintId}
        onChange={event => selectReference(event.target.value)}>
        <option value="__choose__" disabled>Choose a reference</option>
        <option value="">None — remove reference links</option>
        {energyGroups.map(group => <option value={group.id} key={group.id}>{group.label}</option>)}
      </select>
    </label>
    <fieldset className={styles.samples} disabled={busy}>
      <legend>Data to link <span className={styles.count}>{sampleIds.length} selected</span></legend>
      <div className={styles.list}>
        {energyGroups.map(group => {
          const isReference = group.id === referenceId
          const currentReference = groups.find(candidate => candidate.id === group.reference_id)
          return <label className={styles.row} key={group.id} data-reference={isReference || undefined}>
            <input type="checkbox" aria-label={`Link ${group.label}`} disabled={isReference}
              checked={!isReference && selectedIds.has(group.id)} onChange={event => toggleSample(group.id, event.target.checked)} />
            <span className={styles.rowText}><span>{group.label}</span>
              <small>{isReference ? "Selected reference · excluded from data to link"
                : currentReference ? `Reference: ${currentReference.label}`
                  : group.reference_id ? "Reference unavailable" : "No linked reference"}</small>
            </span>
          </label>
        })}
        {!energyGroups.length && <p className="ath-hint">Import an energy spectrum to assign a reference.</p>}
      </div>
    </fieldset>
    {groups.some(group => group.data_type === "chi") && <p className="ath-hint">χ(k) data cannot use an energy reference.</p>}
    {error && <div className="ath-error" role="alert">{error}</div>}
    <div className={`ath-modal-actions ${styles.actions}`}>
      <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      <button className="ath-primary" type="submit" disabled={!canApply}>{busy ? "Applying…" : referenceId === "" ? "Remove reference" : "Assign reference"}</button>
    </div>
  </form>
}
