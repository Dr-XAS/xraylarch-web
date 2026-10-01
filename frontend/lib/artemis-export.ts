import { backendUrl } from "./app-url"
import { decodeApiError } from "./backend-client"

/** Native desktop session export; use the same mounted proxy as project downloads. */
export async function downloadLarixSession(projectId: string, groupId: string, version: number, label: string) {
  const response = await fetch(backendUrl(`/api/artemis/projects/${encodeURIComponent(projectId)}/groups/${encodeURIComponent(groupId)}/export?format=larix&version=${version}`))
  if (!response.ok) throw decodeApiError(response.status, await response.json().catch(() => undefined))
  const warnings: unknown = JSON.parse(response.headers.get("x-artemis-export-warnings") ?? "[]")
  const url = URL.createObjectURL(await response.blob())
  try {
    const link = document.createElement("a")
    link.href = url
    link.download = `${label.replace(/[\\/\u0000-\u001f\u007f]/g, "_") || "exafs-model"}.larix`
    link.style.display = "none"
    document.body.append(link)
    link.click()
    link.remove()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === "string") : []
}
