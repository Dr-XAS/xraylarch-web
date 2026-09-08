"use client"

import { useEffect, useRef, useState } from "react"
import { athenaApi, type EdgeCatalog, type EdgePair } from "@/lib/athena"

// Shared read-only catalog interaction; neither group identity nor tab policy
// is changed by looking up an element or choosing an edge.
export function useEdgeCatalog(initial?: EdgePair | null) {
  const generation = useRef(0)
  const pending = useRef(false)
  const [element, setElement] = useState(initial?.element ?? "")
  const [edge, setEdge] = useState("")
  const [catalog, setCatalog] = useState<EdgeCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => () => { generation.current++ }, [])
  function changeElement(value: string) {
    // A late success or error must not replace the new query's choices.
    generation.current++; pending.current = false
    setLoading(false); setCatalog(null); setEdge(""); setError(""); setElement(value)
  }
  function changeEdge(value: string) { setEdge(value); setError("") }
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
        || result.edges.some(item => !item || typeof item.edge !== "string" || !/^[A-Z][0-9]?$/.test(item.edge) || !Number.isFinite(item.energy) || item.energy <= 0)
        || new Set(result.edges.map(item => item.edge)).size !== result.edges.length) throw new Error("The edge catalog returned no valid choices for this element. Look up the element again.")
      setElement(result.element); setCatalog(result)
      setEdge(result.edges.some(item => item.edge === initial?.edge) ? initial!.edge : "")
    } catch (reason) {
      if (token === generation.current) setError(reason instanceof Error ? reason.message : "Could not look up absorption edges. Try again.")
    } finally {
      if (token === generation.current) { pending.current = false; setLoading(false) }
    }
  }
  const selection: EdgePair | null = catalog?.element === element && catalog.edges.some(item => item.edge === edge) ? { element, edge } : null
  return { element, edge, catalog, loading, error, pending, selection, changeElement, changeEdge, lookup, setError }
}
