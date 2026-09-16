import type { AthenaSession } from "./athena-transport"

export const integrationSessionStorageKey = "xraylarch.integration.session.v2"
export const integrationReturnSelectionStorageKey = "xraylarch.integration.return-selection.v1"
type IntegratedSession = Extract<AthenaSession, { mode: "integration" }>

export const integrationOperations = new Set([
  "read_project", "upload", "import", "preview", "read_upload", "command", "report", "plot", "read_group", "analyze", "restore", "export", "project", "example", "reorder", "metadata", "parameters", "set_e0", "undo", "redo", "duplicate", "merge", "sum", "difference", "rebin", "multi_electron", "convolve", "deglitch", "truncate", "delete", "change_datatype", "xdi_comments", "selection", "background_standard", "copy_series", "copy_parameters", "reset_parameters", "context_parameters", "align", "smooth", "tie_reference", "untie_reference",
])

function validString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
}

export function parseSafeInternalReturn(value: unknown): string | undefined {
  if (!validString(value, 2048) || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined
  let decoded = value
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
  } catch { return undefined }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) return undefined
  const pathname = decoded.split(/[?#]/, 1)[0]
  if (pathname.split("/").some(segment => segment === "." || segment === "..")) return undefined
  try {
    const parsed = new URL(value, "https://internal.invalid")
    if (parsed.origin !== "https://internal.invalid" || `${parsed.pathname}${parsed.search}${parsed.hash}` !== value) return undefined
  } catch { return undefined }
  return value
}

function validOperations(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= integrationOperations.size &&
    value.every(operation => validString(operation, 100) && integrationOperations.has(operation)) && new Set(value).size === value.length
}

function parse(value: unknown): IntegratedSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const keys = new Set(["mode", "projectId", "capability", "returnTo", "sourceGroupId", "allowedOperations", "expiresAt"])
  if (Object.keys(item).some(key => !keys.has(key))) return null
  if (item.mode !== "integration" || !validString(item.projectId, 200) || !validString(item.capability, 1024) || !validOperations(item.allowedOperations)) return null
  if (item.returnTo !== undefined && parseSafeInternalReturn(item.returnTo) === undefined) return null
  if (item.sourceGroupId !== undefined && !validString(item.sourceGroupId, 200)) return null
  if (!validString(item.expiresAt, 64) || !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= Date.now()) return null
  return item as IntegratedSession
}

export function saveIntegrationSession(session: IntegratedSession) {
  const validated = parse(session)
  if (!validated) throw new Error("Invalid integration session")
  sessionStorage.setItem(integrationSessionStorageKey, JSON.stringify(validated))
}

export function loadIntegrationSession(): IntegratedSession | null {
  const raw = sessionStorage.getItem(integrationSessionStorageKey)
  if (!raw) return null
  try {
    const session = parse(JSON.parse(raw))
    if (session) return session
  } catch {}
  clearIntegrationSession()
  return null
}

export function saveReturnSelection(session: IntegratedSession, projectVersion: number, groups: { id: string; version: number }[]) {
  if (!validString(session.projectId, 200) || !validString(session.expiresAt, 64) || Date.parse(session.expiresAt) <= Date.now() ||
      !Number.isInteger(projectVersion) || projectVersion < 0 || groups.length < 1 || groups.length > 100 ||
      groups.some(group => !validString(group.id, 200) || !Number.isInteger(group.version) || group.version < 0) || new Set(groups.map(group => `${group.id}\0${group.version}`)).size !== groups.length) {
    throw new Error("Invalid integration return selection")
  }
  sessionStorage.setItem(integrationReturnSelectionStorageKey, JSON.stringify({ projectId: session.projectId, projectVersion, sessionExpiresAt: session.expiresAt, groups }))
}

export function clearIntegrationReturnSelection() {
  sessionStorage.removeItem(integrationReturnSelectionStorageKey)
}

export function clearIntegrationSession() {
  sessionStorage.removeItem(integrationSessionStorageKey)
}
