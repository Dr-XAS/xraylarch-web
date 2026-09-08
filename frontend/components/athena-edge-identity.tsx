"use client"

import { useEffect, useRef } from "react"
import type { AthenaGroup, EdgeIdentity, EdgePair } from "@/lib/athena"
import { useEdgeCatalog } from "./athena-edge-catalog"

function readIdentity(value: unknown): EdgeIdentity | null {
  if (!value || typeof value !== "object") return null
  const { element, edge, origin } = value as Record<string, unknown>
  if (typeof element !== "string" || !/^[A-Z][a-z]?$/.test(element) || typeof edge !== "string" || !/^[A-Z][0-9]?$/.test(edge)) return null
  return { element, edge, ...(typeof origin === "string" && ["native", "inferred", "enforced", "selected"].includes(origin) ? { origin: origin as EdgeIdentity["origin"] } : {}) }
}
export function currentEdgeIdentity(group: AthenaGroup): EdgeIdentity | null {
  return readIdentity(group.source.edge_identity) ?? readIdentity(group.result?.effective)
}
export function edgeIdentityDescription(group: AthenaGroup) {
  const identity = currentEdgeIdentity(group)
  return identity ? `${identity.element} ${identity.edge}${identity.origin ? ` · ${identity.origin}` : ""}` : "Unknown"
}

// The workbench keys this editor by project/group so a scan change discards its
// draft and invalidates in-flight catalog lookups.
export function EdgeIdentityDialog({ group, busy, error, clearError, save, close }: {
  group: AthenaGroup; busy: boolean; error: string; clearError: () => void
  save: (id: string, identity: EdgePair) => Promise<boolean>; close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const saving = useRef(false)
  const catalog = useEdgeCatalog(currentEdgeIdentity(group))
  const locked = busy || group.frozen
  useEffect(() => {
    dialog.current?.showModal()
    return () => { dialog.current?.close() }
  }, [])
  function dismiss() { if (!busy && !saving.current && !catalog.pending.current) close() }
  async function submit() {
    if (locked || saving.current || catalog.pending.current || !catalog.selection) return
    saving.current = true
    try { if (await save(group.id, catalog.selection)) close() }
    finally { saving.current = false }
  }
  return <dialog ref={dialog} className="ath-modal" aria-label="Edit absorber and edge" onCancel={event => { event.preventDefault(); dismiss() }}>
    <header><h2>Edit absorber and edge</h2><button type="button" aria-label="Close dialog" onClick={dismiss}>×</button></header>
    <form className="ath-modal-body" noValidate onSubmit={event => { event.preventDefault(); void submit() }}>
      <p>Current group: <strong>{group.label}</strong></p><p>Saved absorber / edge: <strong>{edgeIdentityDescription(group)}</strong></p>
      <p className="ath-hint">Save changes this group’s identity only. E₀, energy shift, processing parameters, spectra, reference ties, and parameter drafts are preserved. Import enforcement is separate.</p>
      <fieldset className="ath-e0-fields" disabled={locked}>
        <label className="ath-field"><span>Element symbol</span><input value={catalog.element} maxLength={2} placeholder="Cu" onChange={event => { clearError(); catalog.changeElement(event.target.value) }} /></label>
        <button type="button" disabled={catalog.loading || !catalog.element.trim()} onClick={() => { clearError(); void catalog.lookup() }}>{catalog.loading ? "Looking up edges…" : "Look up edges"}</button>
        <p className="ath-hint">Choose an edge from the element’s table. Its tabulated energy is for identification and does not set E₀ or need to fall inside the scan range. Editing the symbol discards a pending lookup.</p>
        <label className="ath-field"><span>Absorption edge</span><select aria-label="Absorption edge" value={catalog.edge} disabled={catalog.loading || !catalog.catalog} onChange={event => { clearError(); catalog.changeEdge(event.target.value) }}><option value="">Choose an edge</option>{catalog.catalog?.edges.map(item => <option key={item.edge} value={item.edge}>{item.edge} · {item.energy} eV</option>)}</select></label>
      </fieldset>
      {group.frozen && <p className="ath-hint">Unfreeze this group to edit its identity.</p>}
      {(catalog.error || error) && <div className="ath-error" role="alert">{catalog.error || error}</div>}
      <div className="ath-modal-actions"><button type="button" disabled={busy || catalog.loading} onClick={dismiss}>Cancel</button><button type="submit" className="ath-primary" disabled={locked || catalog.loading || !catalog.selection}>{busy ? "Saving identity…" : "Save identity"}</button></div>
    </form>
  </dialog>
}
