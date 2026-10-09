"use client"

import { SectionHelp } from "./section-help"
import { useEffect, useRef, useState } from "react"
import type { EdgePolicy } from "@/lib/athena"
import { useEdgeCatalog } from "./athena-edge-catalog"

export const edgePolicyStorageKey = "athena.edge-policy"
const symbolPattern = /^[A-Z][a-z]?$/
const edgePattern = /^[A-Z][0-9]?$/

function storedPolicy(value: unknown): EdgePolicy | null {
  if (!value || typeof value !== "object") return null
  const { element, edge, fraction } = value as Record<string, unknown>
  if (typeof element !== "string" || !symbolPattern.test(element) || typeof edge !== "string" || !edgePattern.test(edge)
    || typeof fraction !== "number" || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return null
  return Object.freeze({ element, edge, fraction })
}

// This preference belongs to the browser tab, never to a project or its provenance.
export function useEdgePolicy() {
  const [policy, setPolicy] = useState<EdgePolicy | null>(null)
  const [storageError, setStorageError] = useState("")
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(edgePolicyStorageKey)
      let restored: EdgePolicy | null = null
      try { restored = raw ? storedPolicy(JSON.parse(raw)) : null } catch { /* Recover malformed state as off. */ }
      setPolicy(restored)
      if (raw && !restored) sessionStorage.removeItem(edgePolicyStorageKey)
    } catch { setStorageError("Tab storage is unavailable. Enforcement changes may not survive refresh.") }
  }, [])
  function update(policy: EdgePolicy | null) {
    const next = policy ? Object.freeze({ ...policy }) : null
    setPolicy(next)
    try {
      if (next) sessionStorage.setItem(edgePolicyStorageKey, JSON.stringify(next))
      else sessionStorage.removeItem(edgePolicyStorageKey)
      setStorageError("")
    } catch { setStorageError("Tab storage is unavailable. Enforcement changes may not survive refresh.") }
  }
  return { policy, update, storageError }
}

export function edgePolicyDescription(policy: EdgePolicy | null) {
  return policy ? `${policy.element} ${policy.edge} · fraction ${policy.fraction}` : "Off"
}

export function EdgePolicyControls({ policy, apply, busy = false }: {
  policy: EdgePolicy | null; apply: (policy: EdgePolicy | null) => void; busy?: boolean
}) {
  const [editing, setEditing] = useState(false)
  return <>
    <details open={!!policy}>
      <summary>Advanced import settings</summary>
      <label className="ath-check"><input type="checkbox" checked={!!policy} disabled={busy && !policy} onChange={event => {
        if (event.target.checked) setEditing(true)
        else apply(null)
      }} />Enforce element and edge</label>
      <p>Next batch: <strong>{edgePolicyDescription(policy)}</strong><SectionHelp label="Import edge policy">Applies to future raw-file import batches in this tab. Existing groups and restored projects are unchanged; χ(k) imports ignore it.</SectionHelp></p>
      {policy && <button type="button" disabled={busy} onClick={() => setEditing(true)}>Edit element and edge…</button>}
    </details>
    {editing && <EdgePolicyDialog policy={policy} apply={apply} close={() => setEditing(false)} />}
  </>
}

export function EdgePolicyDialog({ policy, apply, close }: {
  policy: EdgePolicy | null; apply: (policy: EdgePolicy) => void; close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { element, edge, catalog, loading, error, pending, selection, changeElement, changeEdge, lookup, setError } = useEdgeCatalog(policy)
  const [fraction, setFraction] = useState(String(policy?.fraction ?? 0.5))
  useEffect(() => {
    dialog.current?.showModal()
    return () => { dialog.current?.close() }
  }, [])
  function dismiss() { if (!pending.current) close() }
  function submit() {
    if (pending.current || !selection) return
    const value = Number(fraction)
    if (!fraction.trim() || !Number.isFinite(value) || value <= 0 || value > 1) { setError("Enter a finite fraction greater than 0 and at most 1."); return }
    apply({ ...selection, fraction: value })
    close()
  }
  return <dialog ref={dialog} className="ath-modal" aria-label="Enforce element and edge" onCancel={event => { event.preventDefault(); event.stopPropagation(); dismiss() }}>
    <header><h2>Enforce element and edge <SectionHelp label="Import policy lifetime">Applies to new batches in this browser tab. Existing groups and restored projects are unchanged. It is separate from project saves and Undo, and survives refresh in this tab.<br /><br />Choose the absorber, edge, and edge-step fraction for subsequent raw-file imports, including reference channels. χ(k) imports ignore this policy.</SectionHelp></h2><button type="button" aria-label="Close dialog" onClick={dismiss}>×</button></header>
    <form className="ath-modal-body" noValidate onSubmit={event => { event.preventDefault(); submit() }}>

      <label className="ath-field"><span>Element symbol <SectionHelp label="Element lookup">Look up the element, then choose an edge from its table. Editing the symbol discards any pending lookup.</SectionHelp></span><input value={element} maxLength={2} placeholder="Cu" onChange={event => changeElement(event.target.value)} /></label>
      <button type="button" disabled={loading || !element.trim()} onClick={() => { void lookup() }}>{loading ? "Looking up edges…" : "Look up edges"}</button>
      <div className="ath-fields"><label className="ath-field"><span>Enforced edge <SectionHelp label="Enforced edge">Choose the element’s edge to seed E₀ and automatic processing defaults for future imports. Existing groups keep their current parameters.</SectionHelp></span><select aria-label="Enforced edge" value={edge} disabled={loading || !catalog} onChange={event => changeEdge(event.target.value)}><option value="">Choose an edge</option>{catalog?.edges.map(item => <option key={item.edge} value={item.edge}>{item.edge} · {item.energy} eV</option>)}</select></label>
        <label className="ath-field"><span>Edge-step fraction <SectionHelp label="Edge-step fraction">Use 0 &lt; fraction ≤ 1; 0.5 is half the edge step, and 1 is the full step.</SectionHelp></span><input type="number" step="any" min="0" max="1" value={fraction} disabled={loading} onChange={event => { setFraction(event.target.value); setError("") }} /></label></div>
      {error && <div className="ath-error" role="alert">{error}</div>}
      <div className="ath-modal-actions"><button type="button" disabled={loading} onClick={dismiss}>Cancel</button><button className="ath-primary" disabled={loading || !catalog || !edge} type="submit">Apply enforcement</button></div>
    </form>
  </dialog>
}
