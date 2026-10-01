import { backendUrl } from "./app-url"
import { decodeApiError } from "./backend-client"

export type AthenaSession =
  | { mode: "legacy" }
  | {
      mode: "integration"
      projectId: string
      capability: string
      returnTo?: string
      sourceGroupId?: string
      allowedOperations: string[]
      expiresAt: string
    }

export interface AthenaTransport {
  api<T>(path: string, init?: RequestInit): Promise<T>
  fetch(path: string, init?: RequestInit): Promise<Response>
  download(path: string, filename?: string, options?: { filenameOverride?: boolean }): Promise<void>
  href(path: string): string
}

type Fetcher = typeof fetch
type AthenaTransportOptions = { onAuthorizationFailure?: () => void }

function decodedPath(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null
  let decoded = path
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
  } catch { return null }
  const pathname = decoded.split(/[?#]/, 1)[0]
  if (decoded.startsWith("//") || decoded.includes("\\") || pathname.split("/").some(segment => segment === "." || segment === "..")) return null
  return decoded
}

function projectId(path: string): string | null {
  const decoded = decodedPath(path)
  const match = decoded && /^\/api\/athena\/projects\/([^/?#]+)(?:[/?#]|$)/.exec(decoded)
  return match?.[1] ?? null
}

function safePath(session: AthenaSession, path: string) {
  const decoded = decodedPath(path)
  if (!decoded || !decoded.startsWith("/api/athena/")) throw new Error("Invalid Athena path")
  if (session.mode === "integration" && projectId(path) !== session.projectId) throw new Error("Athena project does not match this integration session")
  return path
}

function request(session: AthenaSession, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  if (session.mode === "integration") headers.set("X-XrayLarch-Project-Capability", session.capability)
  return { ...init, headers }
}

async function checked(response: Response) {
  if (response.ok) return response
  const data = await response.json().catch(() => undefined)
  throw decodeApiError(response.status, data)
}

function safeFilename(value: string, fallback = "download") {
  return value.replace(/[\\/\0-\x1f\x7f]/g, "").trim() || fallback
}

function attachmentFilename(value: string | null, fallback: string) {
  if (!value) return fallback
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1]
  const plain = /filename="?([^";]+)"?/i.exec(value)?.[1]
  const candidate = encoded ? (() => { try { return decodeURIComponent(encoded) } catch { return "" } })() : plain ?? ""
  return safeFilename(candidate, fallback)
}

export function createAthenaTransport(session: AthenaSession, fetcher: Fetcher = fetch, options: AthenaTransportOptions = {}): AthenaTransport {
  const href = (path: string) => backendUrl(safePath(session, path))
  let probing: Promise<boolean> | null = null
  // The backend answers 404 both for a revoked or expired capability and for
  // an operation this session may not use. A live session can always read its
  // own project, so one re-read tells the two apart without guessing.
  const probeProject = async () => {
    if (session.mode !== "integration") return false
    try {
      const probe = await fetcher(href(`/api/athena/projects/${encodeURIComponent(session.projectId)}`), request(session))
      return probe.status === 401 || probe.status === 404
    } catch {
      return false
    }
  }
  const authorityRevoked = (status: number) => {
    if (session.mode !== "integration" || (status !== 401 && status !== 404)) return Promise.resolve(false)
    if (status === 401) return Promise.resolve(true)
    // Failures that arrive together share one probe.
    if (!probing) {
      const current = probeProject()
      probing = current
      void current.finally(() => { if (probing === current) probing = null })
    }
    return probing
  }
  const fetchBound = async (path: string, init: RequestInit = {}) => {
    const response = await fetcher(href(path), request(session, init))
    if (await authorityRevoked(response.status)) {
      options.onAuthorizationFailure?.()
    }
    return response
  }
  return {
    href,
    fetch: fetchBound,
    async api<T>(path: string, init: RequestInit = {}) {
      const response = await checked(await fetchBound(path, init))
      return await response.json() as T
    },
    async download(path, filename = "download", downloadOptions = {}) {
      const response = await checked(await fetchBound(path))
      const url = URL.createObjectURL(await response.blob())
      try {
        const anchor = document.createElement("a")
        anchor.href = url
        const fallback = safeFilename(filename)
        anchor.download = downloadOptions.filenameOverride ? fallback : attachmentFilename(response.headers.get("content-disposition"), fallback)
        anchor.style.display = "none"
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      } finally {
        URL.revokeObjectURL(url)
      }
    },
  }
}
