"use client"

import { useEffect, useRef, useState } from "react"
import { backendUrl } from "@/lib/app-url"
import { clearIntegrationReturnSelection, clearIntegrationSession, integrationOperations, loadIntegrationSession, parseSafeInternalReturn, saveIntegrationSession } from "@/lib/integration-session"
import type { AthenaSession } from "@/lib/athena-transport"
import { AthenaWorkbench } from "./athena-workbench"

type IntegratedSession = Extract<AthenaSession, { mode: "integration" }>
type ObjectValue = Record<string, unknown>
let launchGeneration = 0

function record(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null
}
function exactKeys(value: ObjectValue, required: string[], optional: string[] = []) {
  const keys = Object.keys(value)
  return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key))
}
function string(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
}
function integer(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 }

function sessionFrom(value: unknown, returnTo?: string): IntegratedSession {
  const item = record(value)
  if (!item || !exactKeys(item, ["project_id", "capability", "project", "seed_group", "allowed_operations", "return_reference"]) ||
      !string(item.project_id, 200) || !string(item.capability, 1024)) throw new Error("Invalid integration session")
  const operations = item.allowed_operations
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > integrationOperations.size ||
      !operations.every(operation => string(operation, 100) && integrationOperations.has(operation)) || new Set(operations).size !== operations.length) throw new Error("Invalid integration session")

  const project = record(item.project)
  if (!project || !exactKeys(project, ["contract_version", "project_id", "name", "persistent", "project_version", "group_count", "file_count", "stored_bytes", "expires_at"]) ||
      project.contract_version !== 2 || project.project_id !== item.project_id || !string(project.name, 200) || typeof project.persistent !== "boolean" ||
      !integer(project.project_version) || !integer(project.group_count) || !integer(project.file_count) || !integer(project.stored_bytes) ||
      !(project.expires_at === null || (string(project.expires_at, 64) && Number.isFinite(Date.parse(project.expires_at)) && Date.parse(project.expires_at) > Date.now())) ||
      (project.persistent ? project.expires_at !== null : project.expires_at === null)) throw new Error("Invalid integration session")

  const returnReference = record(item.return_reference)
  if (!returnReference || !exactKeys(returnReference, ["project_id", "persistent"]) || returnReference.project_id !== item.project_id || typeof returnReference.persistent !== "boolean") throw new Error("Invalid integration session")
  if (returnReference.persistent !== project.persistent) throw new Error("Invalid integration session")

  let sourceGroupId: string | undefined
  if (item.seed_group !== null) {
    const seed = record(item.seed_group)
    if (!seed || !exactKeys(seed, ["group_id", "label", "source"]) || !string(seed.group_id, 200) || !string(seed.label, 500) || !(seed.source === null || record(seed.source))) throw new Error("Invalid integration session")
    sourceGroupId = seed.group_id
  }

  // The consume contract does not expose the capability expiry. Bound tab storage to
  // at most five minutes, and to an earlier authoritative guest-project expiry.
  const localBound = Date.now() + 300_000
  const projectExpiry = typeof project.expires_at === "string" ? Date.parse(project.expires_at) : localBound
  return {
    mode: "integration", projectId: item.project_id, capability: item.capability,
    allowedOperations: operations as string[], expiresAt: new Date(Math.min(localBound, projectExpiry)).toISOString(),
    ...(sourceGroupId ? { sourceGroupId } : {}), ...(returnTo ? { returnTo } : {}),
  }
}

export function IntegrationLaunch() {
  const [session, setSession] = useState<IntegratedSession | null>(null)
  const [failed, setFailed] = useState(false)
  const ownership = useRef<{ generation: number; mounted: boolean } | null>(null)

  useEffect(() => {
    let owner = ownership.current
    if (owner) owner.mounted = true
    const releaseOwnership = () => {
      if (!owner || ownership.current !== owner) return
      const releasedOwner = owner
      releasedOwner.mounted = false
      queueMicrotask(() => {
        if (ownership.current === releasedOwner && !releasedOwner.mounted) {
          ownership.current = null
          if (launchGeneration === releasedOwner.generation) launchGeneration += 1
        }
      })
    }
    const query = new URLSearchParams(location.search)
    clearIntegrationReturnSelection()
    const launch = query.get("launch")
    const rawReturn = query.get("return")
    const returnTo = rawReturn === null ? undefined : parseSafeInternalReturn(rawReturn)
    const validQuery = [...query.keys()].every(key => key === "launch" || key === "return") && query.getAll("launch").length <= 1 && query.getAll("return").length <= 1 && (rawReturn === null || returnTo !== undefined)
    history.replaceState(history.state, "", location.pathname + location.hash)
    if (!validQuery) { clearIntegrationSession(); setFailed(true); return releaseOwnership }
    if (!launch) {
      const saved = loadIntegrationSession()
      if (saved) setSession(saved)
      else setFailed(true)
      return releaseOwnership
    }
    if (launch.length > 1024) { clearIntegrationSession(); setFailed(true); return releaseOwnership }
    clearIntegrationSession()
    const handle = launch
    const generation = ++launchGeneration
    owner = { generation, mounted: true }
    ownership.current = owner
    void fetch(backendUrl("/api/integration/v2/browser/consume"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }),
    }).then(async response => {
      if (!response.ok) throw new Error("Launch rejected")
      const text = await response.text()
      if (text.length > 65_536) throw new Error("Invalid integration session")
      const next = sessionFrom(JSON.parse(text), returnTo)
      if (ownership.current?.generation !== generation || launchGeneration !== generation) return
      saveIntegrationSession(next)
      setSession(next)
    }).catch(() => {
      if (ownership.current?.generation !== generation || launchGeneration !== generation) return
      clearIntegrationSession(); setFailed(true)
    })
    return releaseOwnership
  }, [])

  useEffect(() => {
    if (!session) return
    const deadline = Date.parse(session.expiresAt)
    let timer: number
    const expireOrReschedule = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { clearIntegrationSession(); clearIntegrationReturnSelection(); setSession(null); setFailed(true); return }
      timer = window.setTimeout(expireOrReschedule, Math.min(remaining, 2_147_483_647))
    }
    expireOrReschedule()
    return () => window.clearTimeout(timer)
  }, [session])

  if (session) return <AthenaWorkbench session={session} onAuthorizationFailure={() => { clearIntegrationSession(); clearIntegrationReturnSelection(); setSession(null); setFailed(true) }} />
  if (failed) return <main><h1>Launch again from Dr.XAS</h1><p>This Athena session is missing, expired, or already used.</p></main>
  return <main><p>Opening Athena…</p></main>
}
