import type {
  ApplyRequest,
  ErrorEnvelope,
  InspectionResponse,
  MappingRequest,
  PreviewRequest,
  ProcessingResult,
  RestoreRequest,
  WorkspaceSnapshot,
} from "@/lib/contracts"

type Fetcher = typeof fetch

const backendPath = "/api/backend"

export class ApiRequestError extends Error {
  readonly code: string
  readonly fields: string[]
  readonly recovery: string
  readonly status: number

  constructor(envelope: ErrorEnvelope, status: number) {
    super(envelope.message)
    this.name = "ApiRequestError"
    this.code = envelope.code
    this.fields = envelope.fields
    this.recovery = envelope.recovery
    this.status = status
  }
}

export function decodeApiError(status: number, body: unknown): ApiRequestError {
  const fallback: ErrorEnvelope = {
    code: "api_request_failed",
    message: "The backend request could not be completed.",
    fields: [],
    recovery: "Review the request and try again.",
  }
  const envelope = body && typeof body === "object" && "error" in body
    ? (body as { error?: unknown }).error
    : undefined

  if (!envelope || typeof envelope !== "object") {
    return new ApiRequestError(fallback, status)
  }

  const candidate = envelope as Partial<ErrorEnvelope>
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") {
    return new ApiRequestError(fallback, status)
  }

  return new ApiRequestError(
    {
      code: candidate.code,
      message: candidate.message,
      fields: Array.isArray(candidate.fields)
        ? candidate.fields.filter((field): field is string => typeof field === "string")
        : [],
      recovery: typeof candidate.recovery === "string" ? candidate.recovery : fallback.recovery,
    },
    status,
  )
}

export class BackendClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  createWorkspace(): Promise<WorkspaceSnapshot> {
    return this.request("/api/workspaces", { method: "POST" })
  }

  inspectUpload(workspaceId: string, file: File): Promise<InspectionResponse> {
    const form = new FormData()
    form.append("file", file)
    return this.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/uploads/inspect`, {
      method: "POST",
      body: form,
    })
  }

  confirmMapping(workspaceId: string, request: MappingRequest): Promise<WorkspaceSnapshot> {
    return this.jsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/mapping`, request)
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceSnapshot> {
    return this.request(`/api/workspaces/${encodeURIComponent(workspaceId)}`)
  }

  preview(workspaceId: string, request: PreviewRequest): Promise<ProcessingResult> {
    return this.jsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/preview`, request)
  }

  apply(workspaceId: string, request: ApplyRequest): Promise<WorkspaceSnapshot> {
    return this.jsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/apply`, request)
  }

  restore(workspaceId: string, request: RestoreRequest): Promise<WorkspaceSnapshot> {
    return this.jsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/restore`, request)
  }

  dataDownloadUrl(workspaceId: string, revisionId: number): string {
    return this.url(`/api/workspaces/${encodeURIComponent(workspaceId)}/revisions/${revisionId}/data.csv`)
  }

  recipeDownloadUrl(workspaceId: string, revisionId: number): string {
    return this.url(`/api/workspaces/${encodeURIComponent(workspaceId)}/revisions/${revisionId}/recipe.json`)
  }

  private jsonRequest<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  private url(path: string): string {
    return `${backendPath}${path}`
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(this.url(path), init)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw decodeApiError(response.status, body)
    }
    return body as T
  }
}
