"use client"

import { useEffect, useRef, useState } from "react"
import { athenaApi, type EdgeCatalog, type EdgePolicy } from "@/lib/athena"

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

export function EdgePolicyDialog({ policy, apply, close }: {
  policy: EdgePolicy | null; apply: (policy: EdgePolicy) => void; close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const [element, setElement] = useState(policy?.element ?? "")
  const [edge, setEdge] = useState("")
  const [fraction, setFraction] = useState(String(policy?.fraction ?? 0.5))
  const [catalog, setCatalog] = useState<EdgeCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    dialog.current?.showModal()
    return () => { generation.current++; dialog.current?.close() }
  }, [])
  function dismiss() { if (!pending.current) close() }
  function changeElement(value: string) {
    // Editing the query abandons its lookup. A late success or error must not
    // replace the new query's choices, even if requests finish out of order.
    generation.current++; pending.current = false
    setLoading(false); setCatalog(null); setEdge(""); setError(""); setElement(value)
  }
  async function lookup() {
    if (pending.current) return
    const query = element.trim()
    if (!/^[a-z]{1,2}$/i.test(query)) { setError("Enter an element symbol, for example Cu."); return }
    const canonical = query[0].toUpperCase() + query.slice(1).toLowerCase()
    const token = ++generation.current
    pending.current = true; setLoading(true); setError(""); setCatalog(null); setEdge("")
    try {
      const result = await athenaApi<EdgeCatalog>(`/edges?element=${encodeURIComponent(canonical)}`)
      if (token !== generation.current) return
      if (!result || result.element !== canonical || !Array.isArray(result.edges) || !result.edges.length
        || result.edges.some(item => !item || typeof item.edge !== "string" || !edgePattern.test(item.edge) || !Number.isFinite(item.energy) || item.energy <= 0)
        || new Set(result.edges.map(item => item.edge)).size !== result.edges.length) throw new Error("The edge catalog returned no valid choices for this element. Look up the element again.")
      setElement(result.element); setCatalog(result)
      setEdge(result.edges.some(item => item.edge === policy?.edge) ? policy!.edge : "")
    } catch (reason) {
      if (token === generation.current) setError(reason instanceof Error ? reason.message : "Could not look up absorption edges. Try again.")
    } finally {
      if (token === generation.current) { pending.current = false; setLoading(false) }
    }
  }
  function submit() {
    if (pending.current || !catalog || catalog.element !== element || !catalog.edges.some(item => item.edge === edge)) return
    const value = Number(fraction)
    if (!fraction.trim() || !Number.isFinite(value) || value <= 0 || value > 1) { setError("Enter a finite fraction greater than 0 and at most 1."); return }
    apply({ element: catalog.element, edge, fraction: value })
    close()
  }
  return <dialog ref={dialog} className="ath-modal" aria-label="Enforce element and edge" onCancel={event => { event.preventDefault(); dismiss() }}>
    <header><h2>Enforce element and edge</h2><button type="button" aria-label="Close dialog" onClick={dismiss}>×</button></header>
    <form className="ath-modal-body" noValidate onSubmit={event => { event.preventDefault(); submit() }}>
      <p>Choose the absorber, edge, and edge-step fraction for subsequent raw-file imports, including reference channels. χ(k) imports ignore this policy.</p>
      <p className="ath-hint">Applies to new batches in this browser tab. Existing groups and restored projects are unchanged. It is separate from project saves and Undo, and survives refresh in this tab.</p>
      <label className="ath-field"><span>Element symbol</span><input value={element} maxLength={2} placeholder="Cu" onChange={event => changeElement(event.target.value)} /></label>
      <button type="button" disabled={loading || !element.trim()} onClick={() => { void lookup() }}>{loading ? "Looking up edges…" : "Look up edges"}</button>
      <p className="ath-hint">Look up the element, then choose an edge from its table. Editing the symbol discards any pending lookup.</p>
      <div className="ath-fields"><label className="ath-field"><span>Enforced edge</span><select aria-label="Enforced edge" value={edge} disabled={loading || !catalog} onChange={event => { setEdge(event.target.value); setError("") }}><option value="">Choose an edge</option>{catalog?.edges.map(item => <option key={item.edge} value={item.edge}>{item.edge} · {item.energy} eV</option>)}</select></label>
        <label className="ath-field"><span>Edge-step fraction</span><input type="number" step="any" min="0" max="1" value={fraction} disabled={loading} onChange={event => { setFraction(event.target.value); setError("") }} /></label></div>
      <p className="ath-hint">Use 0 &lt; fraction ≤ 1; 0.5 is half the edge step, and 1 is the full step.</p>
      {error && <div className="ath-error" role="alert">{error}</div>}
      <div className="ath-modal-actions"><button type="button" disabled={loading} onClick={dismiss}>Cancel</button><button className="ath-primary" disabled={loading || !catalog || !edge} type="submit">Apply enforcement</button></div>
    </form>
  </dialog>
}
