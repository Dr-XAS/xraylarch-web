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
      expiresAt?: string
    }

export interface AthenaTransport {
  api<T>(path: string, init?: RequestInit): Promise<T>
  fetch(path: string, init?: RequestInit): Promise<Response>
  download(path: string, filename?: string): Promise<void>
  href(path: string): string
}

type Fetcher = typeof fetch

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

function attachmentFilename(value: string | null, fallback: string) {
  if (!value) return fallback
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1]
  const plain = /filename="?([^";]+)"?/i.exec(value)?.[1]
  let candidate = encoded ? (() => { try { return decodeURIComponent(encoded) } catch { return "" } })() : plain ?? ""
  candidate = candidate.replace(/[\\/\0-\x1f\x7f]/g, "").trim()
  return candidate || fallback
}

export function createAthenaTransport(session: AthenaSession, fetcher: Fetcher = fetch): AthenaTransport {
  const href = (path: string) => backendUrl(safePath(session, path))
  const fetchBound = (path: string, init: RequestInit = {}) => fetcher(href(path), request(session, init))
  return {
    href,
    fetch: fetchBound,
    async api<T>(path: string, init: RequestInit = {}) {
      const response = await checked(await fetchBound(path, init))
      return await response.json() as T
    },
    async download(path, filename = "download") {
      const response = await checked(await fetchBound(path))
      const url = URL.createObjectURL(await response.blob())
      try {
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = attachmentFilename(response.headers.get("content-disposition"), filename)
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
