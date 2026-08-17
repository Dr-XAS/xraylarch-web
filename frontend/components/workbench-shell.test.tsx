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
    { column_id: "column_0001", name: "energy", index: 0, numeric: true, unit: "eV", role_hint: "energy", preview: [8970, 8980] },
    { column_id: "column_0002", name: "mu", index: 1, numeric: true, unit: null, role_hint: "signal", preview: [0.1, 1.1] },
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
  active_source: null,
  draft_source: null,
}

const sourceMetadata = {
  ...inspection,
  source_revision_id: 1,
  energy_column_id: "column_0001",
  signal_column_id: "column_0002",
}

const mappedSnapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: null,
  active_result: null,
  active_source: null,
  draft_source: sourceMetadata,
  revisions: [{ revision_id: 1, kind: "mapping" }],
}

const secondMappedSnapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: null,
  active_result: null,
  active_source: null,
  draft_source: {
    ...sourceMetadata,
    ...secondInspection,
    source_revision_id: 2,
  },
  revisions: [{ revision_id: 1, kind: "mapping" }, { revision_id: 2, kind: "mapping" }],
}

const appliedSnapshot: WorkspaceSnapshot = {
  workspace_id: "workspace-1",
  active_revision_id: 2,
  active_result: result,
  active_source: sourceMetadata,
  draft_source: sourceMetadata,
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

    fireEvent.change(screen.getByLabelText(/energy column/i), { target: { value: "column_0001" } })
    fireEvent.change(screen.getByLabelText(/signal column/i), { target: { value: "column_0002" } })
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
    fireEvent.change(screen.getByLabelText(/energy column/i), { target: { value: "column_0001" } })
    fireEvent.change(screen.getByLabelText(/signal column/i), { target: { value: "column_0002" } })
    fireEvent.click(screen.getByRole("button", { name: /confirm mapping/i }))
    await waitFor(() => expect(screen.getByTestId("preview-button")).toBeEnabled())

    fireEvent.change(upload, { target: { files: [new File(["8980 1.2"], "second.xmu", { type: "text/plain" })] } })

    await waitFor(() => expect(screen.getByTestId("preview-button")).toBeDisabled())
    fireEvent.change(screen.getByLabelText(/energy column/i), { target: { value: "column_0001" } })
    fireEvent.change(screen.getByLabelText(/signal column/i), { target: { value: "column_0002" } })
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

  it("maps the second duplicate column by its unique column ID", async () => {
    const duplicateInspection: InspectionResponse = {
      ...inspection,
      columns: [
        inspection.columns[0],
        inspection.columns[1],
        { ...inspection.columns[1], column_id: "column_0003", index: 2 },
      ],
    }
    const confirmMapping = vi.fn().mockResolvedValue(mappedSnapshot)
    const client = fakeClient({
      inspectUpload: vi.fn().mockResolvedValue(duplicateInspection),
      confirmMapping,
    })
    render(<WorkbenchShell client={client} />)

    fireEvent.change(await screen.findByLabelText(/upload spectrum/i), {
      target: { files: [new File(["8970,0.1,0.2"], "duplicates.csv", { type: "text/csv" })] },
    })
    await screen.findByTestId("column-mapping")
    fireEvent.change(screen.getByLabelText(/energy column/i), { target: { value: "column_0001" } })
    fireEvent.change(screen.getByLabelText(/signal column/i), { target: { value: "column_0003" } })
    fireEvent.click(screen.getByRole("button", { name: /confirm mapping/i }))

    await waitFor(() => expect(confirmMapping).toHaveBeenCalledWith("workspace-1", {
      upload_id: "upload-1",
      energy_column: "column_0001",
      signal_column: "column_0003",
    }))
  })

  it("previews the restored active source after refresh hydration", async () => {
    const activeSource = {
      ...sourceMetadata,
      display_name: "source-a.xmu",
      source_revision_id: 1,
    }
    const latestSource = {
      ...sourceMetadata,
      upload_id: "upload-b",
      display_name: "source-b.xmu",
      source_revision_id: 3,
    }
    const restoredSnapshot = {
      ...appliedSnapshot,
      active_source: activeSource,
      draft_source: latestSource,
    }
    const preview = vi.fn().mockResolvedValue(result)
    const client = fakeClient({
      getWorkspace: vi.fn().mockResolvedValue(restoredSnapshot),
      preview,
    })
    localStorage.setItem("xraylarch-web.workspace-id", "workspace-1")
    render(<WorkbenchShell client={client} />)

    expect(await screen.findByText("source-a.xmu")).toBeVisible()
    fireEvent.click(screen.getByTestId("preview-button"))

    await waitFor(() => expect(preview).toHaveBeenCalledWith("workspace-1", {
      source_revision_id: 1,
      recipe,
    }))
  })

  it("cancels an in-flight preview without hiding the applied result", async () => {
    const preview = vi.fn().mockReturnValue(new Promise<ProcessingResult>(() => undefined))
    const client = fakeClient({
      createWorkspace: vi.fn().mockResolvedValue(appliedSnapshot),
      preview,
    })
    render(<WorkbenchShell client={client} />)

    fireEvent.click(await screen.findByTestId("preview-button"))
    fireEvent.click(await screen.findByRole("button", { name: /cancel preview/i }))

    expect(screen.getByTestId("plot-canvas")).toBeVisible()
    expect(screen.getByTestId("apply-button")).toBeDisabled()
    expect(screen.getByText("Ready")).toBeVisible()
  })
})
