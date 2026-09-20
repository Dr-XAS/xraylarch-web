"use client"

import { useEffect, useRef, useState } from "react"
import type { AthenaGroup, AthenaProject } from "@/lib/athena"
import { useAthenaApi } from "@/lib/athena-context"
import { columnPayload, columnProblem, defaultPreprocessing, defaultRebin, normalizeImportInversion, type ColumnMapping, type ImportRebinOptions } from "@/lib/athena-import"
import type { InspectionResponse } from "@/lib/contracts"
import { AthenaColumnSelection } from "./athena-column-selection"

interface ReimportInspection extends InspectionResponse {
  version: number
  reimport_group_id: string
  current_mapping: Omit<ColumnMapping, "rebin"> & { rebin?: Omit<ImportRebinOptions, "enabled"> | null }
}

export function AthenaReimportColumns({ project, group, onApplied, onBusyChange, close }: {
  project: AthenaProject
  group: AthenaGroup
  onApplied: (project: AthenaProject) => void
  onBusyChange: (busy: boolean) => void
  close: () => void
}) {
  const athenaApi = useAthenaApi()
  const [inspection, setInspection] = useState<ReimportInspection | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  const savingRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let current = true
    setLoading(true); setError(""); setInspection(null); setMapping(null)
    void athenaApi<ReimportInspection>(`/projects/${project.id}/groups/${group.id}/columns`, undefined, "GET", controller.signal)
      .then(value => {
        if (!current) return
        if (value.reimport_group_id !== group.id) throw new Error("The original columns do not belong to this group. Reload the columns and try again.")
        const saved = value.current_mapping
        setInspection(value)
        setMapping(normalizeImportInversion({ ...saved, denominator: saved.denominator ?? "", reference_numerator: "", reference_denominator: "",
          additional_fluorescence: null, individual_channels: false, preprocessing: { ...defaultPreprocessing },
          rebin: { ...defaultRebin, ...saved.rebin, enabled: !!saved.rebin } }))
      })
      .catch(e => { if (current) setError(e instanceof Error ? e.message : "Could not load the original columns.") })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false; controller.abort() }
    // Opening or explicitly reloading this group is the only reason to inspect its stored columns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, group.id, retry])

  async function apply(readerReviewed: boolean) {
    if (savingRef.current || !inspection || !mapping || columnProblem(mapping)) return
    savingRef.current = true; setSaving(true); setError(""); onBusyChange(true)
    try {
      const updated = await athenaApi<AthenaProject>(`/projects/${project.id}/groups/${group.id}/reimport`, {
        ...columnPayload(mapping), version: inspection.version, upload_id: inspection.upload_id, reader_reviewed: readerReviewed,
      })
      onApplied(updated)
    } catch (e) { setError(e instanceof Error ? e.message : "Could not apply column changes.") }
    finally { savingRef.current = false; setSaving(false); onBusyChange(false) }
  }

  return <>
    <p className="ath-hint">Rebuild <strong>{group.label}</strong> from its stored columns and reset its processing settings. The group name, position, and reference links are kept. Undo restores the previous spectrum.</p>
    {error && <p className="ath-error" role="alert">{error}</p>}
    {loading ? <><p role="status">Loading original columns…</p><button type="button" onClick={close}>Cancel</button></>
      : inspection && mapping ? <>
        {error && <button type="button" disabled={saving} onClick={() => setRetry(n => n + 1)}>Reload original columns</button>}
        <AthenaColumnSelection projectId={project.id} version={inspection.version} inspection={inspection}
          mapping={mapping} setMapping={update => setMapping(value => value ? typeof update === "function" ? update(value) : update : value)} busy={saving} remaining={1} reuseMapping={false}
          setReuseMapping={() => {}} chooseAnother={close} importCurrent={reviewed => { void apply(reviewed) }}
          replacement initialReaderReviewed />
      </> : <div className="ath-modal-actions">
        <button type="button" onClick={close}>Cancel</button>
        <button type="button" onClick={() => setRetry(n => n + 1)}>Retry loading columns</button>
      </div>}
  </>
}
