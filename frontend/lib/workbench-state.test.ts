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
    edge_step: 1,
    rbkg: 1,
    kmin: 0,
    kmax: 12,
    kweight: 2,
    autobk_dk: 1,
    autobk_window: "kaiser",
    ft_dk: 1,
    ft_dk2: null,
    ft_window: "kaiser",
    nfft: 2048,
    kstep: 0.05,
    rmax_out: 10,
  },
  plots: [],
}

const snapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: 2,
  active_result: result,
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
      result,
    })

    expect(stale.preview).toBeNull()
    expect(stale.status).toBe("previewing")
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
