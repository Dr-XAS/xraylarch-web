import { describe, expect, it, vi } from "vitest"

import { ApiRequestError, BackendClient, decodeApiError } from "@/lib/backend-client"
import type { ProcessingResult, RecipeDraft, WorkspaceSnapshot } from "@/lib/contracts"
import {
  createInitialState,
  hasUnappliedChanges,
  workbenchReducer,
} from "@/lib/workbench-state"

const defaultRecipe: RecipeDraft = {
  e0: null,
  step: null,
  nnorm: null,
  pre1: null,
  pre2: null,
  norm1: null,
  norm2: null,
  rbkg: 1,
  kmin: 0,
  kmax: null,
  kweight: 2,
  autobk_dk: null,
  autobk_window: null,
  ft_dk: 1,
  ft_dk2: null,
  ft_window: "kaiser",
  nfft: 2048,
  kstep: 0.05,
  rmax_out: 10,
}

const result: ProcessingResult = {
  effective: {
    e0: 8979,
    e0_automatic: true,
    edge_step: 1,
    edge_step_automatic: true,
    pre1: -200,
    pre1_automatic: true,
    pre2: -30,
    pre2_automatic: true,
    norm1: 100,
    norm1_automatic: true,
    norm2: 300,
    norm2_automatic: true,
    nnorm: 2,
    nnorm_automatic: true,
    rbkg: 1,
    kweight: 2,
    autobk_kmin: 0,
    autobk_kmax: 12,
    autobk_kmax_automatic: true,
    autobk_dk: 0.1,
    autobk_dk_automatic: true,
    autobk_window: "hanning",
    autobk_window_automatic: true,
    xftf_kmin: 0,
    xftf_kmax: 20,
    xftf_kmax_automatic: true,
    xftf_dk: 1,
    xftf_dk2: 1,
    xftf_dk2_automatic: true,
    xftf_window: "kaiser",
    nfft: 2048,
    kstep: 0.05,
    rmax_out: 10,
  },
  plots: [],
}

const sourceA = {
  upload_id: "upload-a",
  source_revision_id: 1,
  energy_column_id: "column_0001",
  signal_column_id: "column_0002",
  display_name: "source-a.xmu",
  row_count: 1201,
  columns: [
    { column_id: "column_0001", name: "energy", index: 0, numeric: true, unit: "eV", role_hint: "energy", preview: [8750] },
    { column_id: "column_0002", name: "mu", index: 1, numeric: true, unit: null, role_hint: "mu", preview: [0.18] },
  ],
  warnings: [],
  issues: [],
}

const sourceB = {
  ...sourceA,
  upload_id: "upload-b",
  source_revision_id: 3,
  display_name: "source-b.xmu",
}

const snapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: 2,
  active_result: result,
  active_source: sourceA,
  draft_source: sourceA,
  revisions: [
    { revision_id: 1, kind: "mapping" },
    {
      revision_id: 2,
      kind: "applied",
      parent_revision_id: null,
      source_revision_id: 1,
      restored_from_revision_id: null,
      recipe: defaultRecipe,
      effective: result.effective,
    },
  ],
}

describe("workbench state", () => {
  it("hydrates the active revision source instead of the latest mapping", () => {
    const hydrated = workbenchReducer(createInitialState(defaultRecipe), {
      type: "workspace/hydrated",
      snapshot: { ...snapshot, draft_source: sourceB },
    })

    expect(hydrated.sourceRevisionId).toBe(sourceA.source_revision_id)
    expect(hydrated.inspection?.display_name).toBe("source-a.xmu")
  })

  it("uses a newly confirmed mapping as the deliberate draft source", () => {
    const mapped = workbenchReducer(createInitialState(defaultRecipe), {
      type: "mapping/succeeded",
      snapshot: { ...snapshot, draft_source: sourceB },
    })

    expect(mapped.sourceRevisionId).toBe(sourceB.source_revision_id)
    expect(mapped.inspection?.display_name).toBe("source-b.xmu")
  })

  it("keeps the applied revision visible while a preview is pending", () => {
    const hydrated = workbenchReducer(createInitialState(defaultRecipe), {
      type: "mapping/succeeded",
      snapshot,
    })

    const previewing = workbenchReducer(hydrated, {
      type: "preview/started",
      recipe: { ...defaultRecipe, rbkg: 1.2 },
    })

    expect(previewing.applied?.id).toBe(2)
    expect(previewing.preview).toBeNull()
    expect(previewing.status).toBe("previewing")
  })

  it("ignores a preview response for an older draft token", () => {
    const state = workbenchReducer(createInitialState(defaultRecipe), {
      type: "preview/started",
      recipe: defaultRecipe,
    })
    const newer = workbenchReducer(state, {
      type: "preview/started",
      recipe: { ...defaultRecipe, kweight: 3 },
    })
    const stale = workbenchReducer(newer, {
      type: "preview/succeeded",
      requestId: state.previewRequestId!,
      recipe: defaultRecipe,
      result,
    })

    expect(stale.preview).toBeNull()
    expect(stale.status).toBe("previewing")
  })

  it("invalidates an in-flight preview when the recipe is edited", () => {
    const previewRecipe = { ...defaultRecipe, rbkg: 1.2 }
    const previewing = workbenchReducer(createInitialState(defaultRecipe), {
      type: "preview/started",
      recipe: previewRecipe,
    })
    const edited = workbenchReducer(previewing, {
      type: "draft/updated",
      changes: { rbkg: 1.5 },
    })
    const stale = workbenchReducer(edited, {
      type: "preview/succeeded",
      requestId: previewing.previewRequestId!,
      recipe: previewRecipe,
      result,
    })

    expect(stale.preview).toBeNull()
    expect(stale.previewRequestId).toBeNull()
    expect(stale.draft.rbkg).toBe(1.5)
  })

  it("retains the exact recipe that produced an accepted preview", () => {
    const previewRecipe = { ...defaultRecipe, rbkg: 1.2 }
    const previewing = workbenchReducer(createInitialState(defaultRecipe), {
      type: "preview/started",
      recipe: previewRecipe,
    })
    const accepted = workbenchReducer(previewing, {
      type: "preview/succeeded",
      requestId: previewing.previewRequestId!,
      recipe: previewRecipe,
      result,
    })

    expect(accepted.preview?.recipe).toEqual(previewRecipe)
  })

  it("clears only transient preview state when a preview is cancelled", () => {
    const previewing = workbenchReducer(
      workbenchReducer(createInitialState(defaultRecipe), {
        type: "mapping/succeeded",
        snapshot,
      }),
      { type: "preview/started", recipe: { ...defaultRecipe, rbkg: 1.2 } },
    )
    const cancelled = workbenchReducer(previewing, { type: "preview/cancelled" })

    expect(cancelled.applied?.id).toBe(2)
    expect(cancelled.draft.rbkg).toBe(1.2)
    expect(cancelled.preview).toBeNull()
    expect(cancelled.previewRequestId).toBeNull()
    expect(cancelled.status).toBe("ready")
    expect(hasUnappliedChanges(cancelled)).toBe(true)
  })

  it("marks inspection and mapping blockers as blocked", () => {
    const inspected = workbenchReducer(createInitialState(defaultRecipe), {
      type: "inspection/succeeded",
      inspection: {
        ...sourceA,
        issues: [{
          code: "energy_not_monotonic",
          message: "Energy values are not strictly increasing.",
          fields: ["column_0001"],
          recovery: "Repair the energy order before processing.",
        }],
      },
    })
    const mappingError = new ApiRequestError({
      code: "invalid_mapping",
      message: "Choose valid columns.",
      fields: ["energy_column"],
      recovery: "Choose another energy column.",
    }, 400)
    const blocked = workbenchReducer(inspected, {
      type: "error/received",
      error: mappingError,
    })

    expect(inspected.status).toBe("blocked")
    expect(blocked.status).toBe("blocked")
  })
})

describe("backend client", () => {
  it("preserves API error details from an error envelope", () => {
    const error = decodeApiError(409, {
      error: {
        code: "stale_revision",
        message: "The active revision changed.",
        fields: ["expected_parent_revision"],
        recovery: "Refresh and preview again.",
      },
    })

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({
      code: "stale_revision",
      message: "The active revision changed.",
      fields: ["expected_parent_revision"],
      recovery: "Refresh and preview again.",
      status: 409,
    })
  })

  it("uses the fixed same-origin backend path", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ workspace_id: "workspace-1", revisions: [] }), {
        headers: { "content-type": "application/json" },
      }),
    )
    const client = new BackendClient(fetcher)

    await client.createWorkspace()

    expect(fetcher).toHaveBeenCalledWith(
      "/api/backend/api/workspaces",
      expect.objectContaining({ method: "POST" }),
    )
  })
})
