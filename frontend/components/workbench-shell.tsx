"use client"

import { useEffect, useReducer } from "react"

import { BackendClient, ApiRequestError } from "@/lib/backend-client"
import { DEFAULT_RECIPE } from "@/lib/contracts"
import { createInitialState, workbenchReducer } from "@/lib/workbench-state"

import { PlotCanvas } from "@/components/plot-canvas"
import { ProcessingInspector } from "@/components/processing-inspector"
import { RecipeHistory } from "@/components/recipe-history"
import { SpectrumTray } from "@/components/spectrum-tray"
import { UploadInspector } from "@/components/upload-inspector"

const workspaceStorageKey = "xraylarch-web.workspace-id"
const defaultClient = new BackendClient()

function asApiError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) return error
  return new ApiRequestError({
    code: "ui_request_failed",
    message: "The request could not be completed.",
    fields: [],
    recovery: "Review the current values and retry.",
  }, 0)
}

export function WorkbenchShell({ client = defaultClient }: { client?: BackendClient }) {
  const [state, dispatch] = useReducer(workbenchReducer, DEFAULT_RECIPE, createInitialState)

  useEffect(() => {
    let current = true
    async function initialise() {
      try {
        const storedWorkspace = window.localStorage.getItem(workspaceStorageKey)
        const snapshot = storedWorkspace
          ? await client.getWorkspace(storedWorkspace)
          : await client.createWorkspace()
        if (!current) return
        window.localStorage.setItem(workspaceStorageKey, snapshot.workspace_id)
        dispatch({ type: storedWorkspace ? "workspace/hydrated" : "workspace/created", snapshot })
      } catch (error) {
        if (current) dispatch({ type: "error/received", error: asApiError(error) })
      }
    }
    void initialise()
    return () => { current = false }
  }, [client])

  const sourceRevisionId = state.sourceRevisionId
  const displayResult = state.preview?.result ?? state.applied?.result ?? null
  const canPreview = Boolean(state.workspaceId && sourceRevisionId)
  const canApply = Boolean(state.workspaceId && sourceRevisionId && state.preview && state.status === "preview-ready")

  async function upload(file: File) {
    if (!state.workspaceId) return
    try {
      dispatch({ type: "inspection/succeeded", inspection: await client.inspectUpload(state.workspaceId, file) })
    } catch (error) {
      dispatch({ type: "error/received", error: asApiError(error) })
    }
  }

  async function confirmMapping(energyColumn: string, signalColumn: string) {
    if (!state.workspaceId || !state.inspection) return
    try {
      dispatch({ type: "mapping/succeeded", snapshot: await client.confirmMapping(state.workspaceId, {
        upload_id: state.inspection.upload_id,
        energy_column: energyColumn,
        signal_column: signalColumn,
      }) })
    } catch (error) {
      dispatch({ type: "error/received", error: asApiError(error) })
    }
  }

  async function preview() {
    if (!state.workspaceId || !sourceRevisionId) return
    const requestId = state.nextPreviewRequestId
    const recipe = { ...state.draft }
    dispatch({ type: "preview/started", recipe })
    try {
      const result = await client.preview(state.workspaceId, { source_revision_id: sourceRevisionId, recipe })
      dispatch({ type: "preview/succeeded", requestId, recipe, result })
    } catch (error) {
      dispatch({ type: "preview/failed", requestId, error: asApiError(error) })
    }
  }

  async function apply() {
    if (!state.workspaceId || !sourceRevisionId || !state.preview) return
    try {
      dispatch({ type: "apply/succeeded", snapshot: await client.apply(state.workspaceId, {
        source_revision_id: sourceRevisionId,
        recipe: state.preview.recipe,
        expected_parent_revision: state.applied?.id ?? null,
      }) })
    } catch (error) {
      dispatch({ type: "error/received", error: asApiError(error) })
    }
  }

  function cancelPreview() {
    dispatch({ type: "preview/cancelled" })
  }

  async function restore(revisionId: number) {
    if (!state.workspaceId) return
    try {
      dispatch({ type: "restore/succeeded", snapshot: await client.restore(state.workspaceId, {
        revision_id: revisionId,
        expected_parent_revision: state.applied?.id ?? null,
      }) })
    } catch (error) {
      dispatch({ type: "error/received", error: asApiError(error) })
    }
  }

  return (
    <main className="workbench-shell" data-testid="workbench-ready">
      <header className="workbench-header">
        <div><p className="eyebrow">XAS processing workbench</p><h1>XrayLarch Web</h1></div>
        <p>Server-authoritative processing · explicit recipe revisions</p>
      </header>
      <SpectrumTray inspection={state.inspection} activeRevisionId={state.applied?.id ?? null} status={state.status} />
      <div className="workbench-grid">
        <aside className="left-inspector">
          <UploadInspector inspection={state.inspection} disabled={!state.workspaceId} onUpload={upload} onConfirmMapping={confirmMapping} />
          <ProcessingInspector
            recipe={state.draft}
            canPreview={canPreview}
            canApply={canApply}
            isPreviewing={state.status === "previewing"}
            statusText={state.preview ? "Preview is not yet applied." : "Applied results stay visible while you review changes."}
            error={state.error}
            onChange={(changes) => dispatch({ type: "draft/updated", changes })}
            onPreview={preview}
            onCancelPreview={cancelPreview}
            onApply={apply}
          />
        </aside>
        <div className="scientific-workspace">
          <PlotCanvas result={displayResult} selectedView={state.selectedView} onSelectView={(view) => dispatch({ type: "view/selected", view })} />
          <RecipeHistory workspaceId={state.workspaceId} revisions={state.history} activeRevisionId={state.applied?.id ?? null} client={client} onRestore={restore} />
        </div>
      </div>
    </main>
  )
}
