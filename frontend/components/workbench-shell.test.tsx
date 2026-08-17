import "@testing-library/jest-dom/vitest"
import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiRequestError, BackendClient } from "@/lib/backend-client"
import type {
  InspectionResponse,
  ProcessingResult,
  RecipeDraft,
  WorkspaceSnapshot,
} from "@/lib/contracts"
import { WorkbenchShell } from "@/components/workbench-shell"

vi.mock("react-plotly.js", () => ({ default: () => null }))

const recipe: RecipeDraft = {
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
  plots: [{
    id: "raw_mu",
    label: "Raw μ(E)",
    x_label: "Energy",
    y_label: "μ(E)",
    x_unit: "eV",
    y_unit: "",
    x: [8970, 8980],
    y: [0.1, 1.1],
  }],
}

const inspection: InspectionResponse = {
  upload_id: "upload-1",
  display_name: "Cu foil.xmu",
  row_count: 2,
  columns: [
    { name: "energy", index: 0, numeric: true, unit: "eV", role_hint: "energy", preview: [8970, 8980] },
    { name: "mu", index: 1, numeric: true, unit: null, role_hint: "signal", preview: [0.1, 1.1] },
  ],
  warnings: [],
  issues: [],
}

const secondInspection: InspectionResponse = {
  ...inspection,
  upload_id: "upload-2",
  display_name: "Cu foil repeat.xmu",
}

const emptySnapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: null,
  revisions: [],
  active_result: null,
}

const mappedSnapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: null,
  active_result: null,
  revisions: [{ revision_id: 1, kind: "mapping" }],
}

const secondMappedSnapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: null,
  active_result: null,
  revisions: [{ revision_id: 1, kind: "mapping" }, { revision_id: 2, kind: "mapping" }],
}

const appliedSnapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: 2,
  active_result: result,
  revisions: [{ revision_id: 1, kind: "mapping" }, {
    revision_id: 2,
    kind: "applied",
    parent_revision_id: null,
    source_revision_id: 1,
    restored_from_revision_id: null,
    recipe,
    effective: result.effective,
  }],
}

function fakeClient(overrides: Partial<BackendClient> = {}): BackendClient {
  return {
    createWorkspace: vi.fn().mockResolvedValue(emptySnapshot),
    inspectUpload: vi.fn().mockResolvedValue(inspection),
    confirmMapping: vi.fn().mockResolvedValue(mappedSnapshot),
    getWorkspace: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    restore: vi.fn(),
    dataDownloadUrl: vi.fn(),
    recipeDownloadUrl: vi.fn(),
    ...overrides,
  } as unknown as BackendClient
}

describe("WorkbenchShell", () => {
  beforeEach(() => localStorage.clear())

  it("requires an explicit energy and signal mapping before processing", async () => {
    const client = fakeClient()
    render(<WorkbenchShell client={client} />)

    fireEvent.change(await screen.findByLabelText(/upload spectrum/i), {
      target: { files: [new File(["8970 0.1\n8980 1.1"], "Cu foil.xmu", { type: "text/plain" })] },
    })

    expect(await screen.findByTestId("column-mapping")).toBeVisible()
    expect(screen.getByTestId("preview-button")).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/energy column/i), { target: { value: "energy" } })
    fireEvent.change(screen.getByLabelText(/signal column/i), { target: { value: "mu" } })
    fireEvent.click(screen.getByRole("button", { name: /confirm mapping/i }))

    await waitFor(() => expect(screen.getByTestId("preview-button")).toBeEnabled())
  })

  it("invalidates the prior mapping when a second upload is inspected", async () => {
    const client = fakeClient({
      inspectUpload: vi.fn().mockResolvedValueOnce(inspection).mockResolvedValueOnce(secondInspection),
      confirmMapping: vi.fn().mockResolvedValueOnce(mappedSnapshot).mockResolvedValueOnce(secondMappedSnapshot),
    })
    render(<WorkbenchShell client={client} />)
    const upload = await screen.findByLabelText(/upload spectrum/i)

    fireEvent.change(upload, { target: { files: [new File(["8970 0.1"], "first.xmu", { type: "text/plain" })] } })
    await screen.findByTestId("column-mapping")
    fireEvent.change(screen.getByLabelText(/energy column/i), { target: { value: "energy" } })
    fireEvent.change(screen.getByLabelText(/signal column/i), { target: { value: "mu" } })
    fireEvent.click(screen.getByRole("button", { name: /confirm mapping/i }))
    await waitFor(() => expect(screen.getByTestId("preview-button")).toBeEnabled())

    fireEvent.change(upload, { target: { files: [new File(["8980 1.2"], "second.xmu", { type: "text/plain" })] } })

    await waitFor(() => expect(screen.getByTestId("preview-button")).toBeDisabled())
    fireEvent.change(screen.getByLabelText(/energy column/i), { target: { value: "energy" } })
    fireEvent.change(screen.getByLabelText(/signal column/i), { target: { value: "mu" } })
    fireEvent.click(screen.getByRole("button", { name: /confirm mapping/i }))
    await waitFor(() => expect(screen.getByTestId("preview-button")).toBeEnabled())
  })

  it("rejects a preview response when its recipe changes in flight", async () => {
    let resolvePreview: ((value: ProcessingResult) => void) | undefined
    const pendingPreview = new Promise<ProcessingResult>((resolve) => { resolvePreview = resolve })
    const client = fakeClient({
      createWorkspace: vi.fn().mockResolvedValue(appliedSnapshot),
      preview: vi.fn().mockReturnValue(pendingPreview),
    })
    render(<WorkbenchShell client={client} />)

    fireEvent.click(await screen.findByTestId("preview-button"))
    await waitFor(() => expect(client.preview).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText(/rbkg/i), { target: { value: "1.5" } })
    await act(async () => {
      resolvePreview?.(result)
      await pendingPreview
    })

    expect(screen.getByTestId("apply-button")).toBeDisabled()
    expect(screen.getByText("Ready")).toBeVisible()
  })

  it("keeps the last applied plot visible after an invalid preview", async () => {
    const invalidPreview = new ApiRequestError({
      code: "invalid_recipe",
      message: "Energy range is invalid.",
      fields: ["norm1", "norm2"],
      recovery: "Set an ordered energy range and preview again.",
    }, 422)
    const client = fakeClient({
      createWorkspace: vi.fn().mockResolvedValue(appliedSnapshot),
      preview: vi.fn().mockRejectedValue(invalidPreview),
    })
    render(<WorkbenchShell client={client} />)

    fireEvent.click(await screen.findByTestId("preview-button"))

    expect(await screen.findByText(/energy range is invalid/i)).toBeVisible()
    expect(screen.getByTestId("plot-canvas")).toBeVisible()
    expect(screen.getByText(/not current/i)).toBeVisible()
    await waitFor(() => expect(screen.getByTestId("apply-button")).toBeDisabled())
  })
})
