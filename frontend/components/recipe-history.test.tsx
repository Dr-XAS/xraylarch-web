import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { BackendClient } from "@/lib/backend-client"
import type { EffectiveRecipe, RevisionSummary } from "@/lib/contracts"
import { DEFAULT_RECIPE } from "@/lib/contracts"
import { RecipeHistory } from "@/components/recipe-history"

const effective = {
  e0: 8980,
  e0_automatic: true,
  edge_step: 0.858,
  edge_step_automatic: true,
  pre1: -230,
  pre1_automatic: true,
  pre2: -115,
  pre2_automatic: true,
  norm1: 25,
  norm1_automatic: true,
  norm2: 370,
  norm2_automatic: true,
  nnorm: 2,
  nnorm_automatic: true,
  rbkg: 1,
  kweight: 2,
  autobk_kmin: 0,
  autobk_kmax: 9.85,
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
} as EffectiveRecipe

describe("RecipeHistory", () => {
  it("shows resolved automatic values without conflating Autobk and XFTF ranges", () => {
    const revisions: RevisionSummary[] = [{
      revision_id: 2,
      kind: "applied",
      parent_revision_id: null,
      source_revision_id: 1,
      restored_from_revision_id: null,
      recipe: DEFAULT_RECIPE,
      effective,
    }]
    const client = {
      dataDownloadUrl: vi.fn().mockReturnValue("/data.csv"),
      recipeDownloadUrl: vi.fn().mockReturnValue("/recipe.json"),
    } as unknown as BackendClient

    render(
      <RecipeHistory
        workspaceId="workspace-1"
        revisions={revisions}
        activeRevisionId={2}
        client={client}
        onRestore={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByText(/E0 8980\.00 eV \(automatic\).*normalization degree 2 \(automatic\)/i)).toBeVisible()
    expect(screen.getByText(/Pre-edge start -230 eV \(automatic\).*pre-edge end -115 eV \(automatic\)/i)).toBeVisible()
    expect(screen.getByText(/Post-edge start 25 eV \(automatic\).*post-edge end 370 eV \(automatic\)/i)).toBeVisible()
    expect(screen.getByText(/Autobk k 0–9\.85 Å⁻¹ \(automatic max\).*hanning \(automatic\)/i)).toBeVisible()
    expect(screen.getByText(/XFTF k 0–20 Å⁻¹ \(automatic max\).*tapers 1\/1 Å⁻¹.*kaiser/i)).toBeVisible()
    expect(screen.getByText(/FFT 2048 points.*k step 0\.05 Å⁻¹.*R output 10 Å/i)).toBeVisible()
  })
})
