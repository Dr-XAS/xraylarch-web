import type { ArtemisFitRequest, ArtemisFitResult } from "./artemis"

export const format = (value: number | null | undefined, digits = 5) => value === null || value === undefined || !Number.isFinite(value) ? "—" : Number(value.toPrecision(digits)).toString()

export function download(filename: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function exportBundle(request: ArtemisFitRequest, result: ArtemisFitResult | null, source?: { project_id?: string; group_id?: string; group_label?: string }) {
  const { request: _request, ...fitResult } = result ?? {}
  return JSON.stringify({ schema: "artemis-web/v1", source, request, result: result ? fitResult : null }, null, 2)
}
