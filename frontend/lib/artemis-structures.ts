import type { ArtemisInspectedPath } from "./artemis"

export interface ArtemisStructureSummary {
  id: number
  mineral: string
  formula: string
  space_group: string
  authors: string
  year: number | null
  journal: string
  title: string
}
export interface ArtemisStructureSearchResult {
  query: string
  source: string
  results: ArtemisStructureSummary[]
  count: number
  limited: boolean
}
export interface ArtemisStructure extends ArtemisStructureSummary {
  cif: string
  elements: string[]
  sites: { index: number; element: string; species: string; multiplicity: number; wyckoff: string; x: number; y: number; z: number; occupancy: number }[]
  ordered: boolean
  supported: boolean
  warnings: string[]
  cell: Partial<{ a: number; b: number; c: number; alpha: number; beta: number; gamma: number }>
}
export interface ArtemisFeffRequest {
  amcsd_id?: number | null
  project_id?: string | null
  attachment_id?: string | null
  version?: number | null
  absorber: string
  edge: "K" | "L1" | "L2" | "L3"
  site_index: number
  cluster_radius: number
  path_radius: number
  max_legs: number
  max_paths: number
}
export interface ArtemisStructureAttachment {
  id: string
  amcsd_id: number
  attached_at: string
  sha256: string
  structure: ArtemisStructure
}
export interface ArtemisProjectStructures {
  project_id: string
  version: number
  structures: ArtemisStructureAttachment[]
}
export interface ArtemisFeffJob {
  id: string
  status: "running" | "complete" | "failed"
  stage: string
  message: string
  elapsed_seconds: number
  log: string
  request: ArtemisFeffRequest
  provenance: { cif: string; feff_input: string; structure: ArtemisStructureSummary }
  paths: (ArtemisInspectedPath & { id: string })[]
  total_paths: number
  truncated: boolean
  warnings: string[]
}
export interface ArtemisGeneratedPath extends ArtemisInspectedPath { label: string }

export function sameFeffRequest(left: ArtemisFeffRequest, right: ArtemisFeffRequest) {
  return Object.keys(right).every(key => left?.[key as keyof ArtemisFeffRequest] === right[key as keyof ArtemisFeffRequest])
}

export function downloadArtemisText(filename: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const revoke = URL.revokeObjectURL.bind(URL)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => revoke(url), 1000)
}
