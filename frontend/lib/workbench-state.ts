import type {
  InspectionResponse,
  ProcessingResult,
  RecipeDraft,
  WorkspaceSnapshot,
} from "@/lib/contracts"
import type { ApiRequestError } from "@/lib/backend-client"

export type SelectedView = "raw_mu" | "norm_mu" | "chi_k" | "chi_r"
export type WorkbenchStatus = "idle" | "ready" | "previewing" | "preview-ready" | "error"

export interface AppliedRevision {
  id: number
  recipe: RecipeDraft
  result: ProcessingResult
}

export interface PreviewState {
  requestId: number
  result: ProcessingResult
}

export interface WorkbenchState {
  workspaceId: string | null
  inspection: InspectionResponse | null
  applied: AppliedRevision | null
  draft: RecipeDraft
  preview: PreviewState | null
  history: WorkspaceSnapshot["revisions"]
  selectedView: SelectedView
  previewRequestId: number | null
  nextPreviewRequestId: number
  status: WorkbenchStatus
  error: ApiRequestError | null
}

export type WorkbenchAction =
  | { type: "workspace/created"; snapshot: WorkspaceSnapshot }
  | { type: "workspace/hydrated"; snapshot: WorkspaceSnapshot }
  | { type: "inspection/succeeded"; inspection: InspectionResponse }
  | { type: "mapping/succeeded"; snapshot: WorkspaceSnapshot }
  | { type: "draft/updated"; changes: Partial<RecipeDraft> }
  | { type: "preview/started"; recipe: RecipeDraft }
  | { type: "preview/succeeded"; requestId: number; result: ProcessingResult }
  | { type: "preview/failed"; requestId: number; error: ApiRequestError }
  | { type: "preview/cancelled" }
  | { type: "apply/succeeded"; snapshot: WorkspaceSnapshot }
  | { type: "restore/succeeded"; snapshot: WorkspaceSnapshot }
  | { type: "view/selected"; view: SelectedView }
  | { type: "error/received"; error: ApiRequestError }
  | { type: "error/cleared" }

export function createInitialState(recipe: RecipeDraft): WorkbenchState {
  return {
    workspaceId: null,
    inspection: null,
    applied: null,
    draft: { ...recipe },
    preview: null,
    history: [],
    selectedView: "raw_mu",
    previewRequestId: null,
    nextPreviewRequestId: 1,
    status: "idle",
    error: null,
  }
}

function activeRevision(snapshot: WorkspaceSnapshot): AppliedRevision | null {
  if (snapshot.active_revision_id === null || snapshot.active_result === null) {
    return null
  }
  const revision = snapshot.revisions.find(
    (candidate) => candidate.revision_id === snapshot.active_revision_id,
  )
  if (!revision?.recipe) {
    return null
  }
  return { id: revision.revision_id, recipe: { ...revision.recipe }, result: snapshot.active_result }
}

function hydrate(state: WorkbenchState, snapshot: WorkspaceSnapshot): WorkbenchState {
  const applied = activeRevision(snapshot)
  return {
    ...state,
    workspaceId: snapshot.workspace_id,
    applied,
    draft: applied ? { ...applied.recipe } : state.draft,
    preview: null,
    previewRequestId: null,
    history: snapshot.revisions,
    status: "ready",
    error: null,
  }
}

export function hasUnappliedChanges(state: WorkbenchState): boolean {
  if (!state.applied) {
    return true
  }
  return (Object.keys(state.draft) as Array<keyof RecipeDraft>).some(
    (field) => state.draft[field] !== state.applied?.recipe[field],
  )
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "workspace/created":
    case "workspace/hydrated":
    case "mapping/succeeded":
    case "apply/succeeded":
    case "restore/succeeded":
      return hydrate(state, action.snapshot)
    case "inspection/succeeded":
      return { ...state, inspection: action.inspection, status: "ready", error: null }
    case "draft/updated":
      return {
        ...state,
        draft: { ...state.draft, ...action.changes },
        preview: null,
        status: "ready",
        error: null,
      }
    case "preview/started": {
      const requestId = state.nextPreviewRequestId
      return {
        ...state,
        draft: { ...action.recipe },
        preview: null,
        previewRequestId: requestId,
        nextPreviewRequestId: requestId + 1,
        status: "previewing",
        error: null,
      }
    }
    case "preview/succeeded":
      if (action.requestId !== state.previewRequestId) {
        return state
      }
      return {
        ...state,
        preview: { requestId: action.requestId, result: action.result },
        previewRequestId: null,
        status: "preview-ready",
        error: null,
      }
    case "preview/failed":
      if (action.requestId !== state.previewRequestId) {
        return state
      }
      return {
        ...state,
        preview: null,
        previewRequestId: null,
        status: "error",
        error: action.error,
      }
    case "preview/cancelled":
      return {
        ...state,
        preview: null,
        previewRequestId: null,
        status: "ready",
        error: null,
      }
    case "view/selected":
      return { ...state, selectedView: action.view }
    case "error/received":
      return { ...state, status: "error", error: action.error }
    case "error/cleared":
      return { ...state, status: "ready", error: null }
  }
}
