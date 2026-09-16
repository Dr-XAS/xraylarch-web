import "@testing-library/jest-dom/vitest"

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AthenaProject, Parameters } from "@/lib/athena"
import { AthenaWorkbench } from "./athena-workbench"

vi.mock("next/dynamic", () => ({ default: () => () => null }))

const parameters: Parameters = {
  e0: 8979, step: null, pre1: -150, pre2: -30, norm1: 100, norm2: 300,
  nnorm: 2, flatten: true, rbkg: 1, bkg_kmin: 0, bkg_kmax: null,
  bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1, kmin: 3, kmax: 12,
  kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
  rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05,
}

function eligibleProject(): AthenaProject {
  return {
    id: "integrated-project", name: "Read only", version: 7, journal: "",
    updated: "2026-09-16T00:00:00Z", undo: [], redo: [], history: [],
    groups: [{
      id: "sample", label: "EXAFS sample", marked: true, frozen: false,
      data_type: "mu", energy: [8960, 8980, 9000], mu: [0.1, 0.8, 1.1],
      multiplier: 1, offset: 0, notes: "", reference_id: null,
      parameters: { ...parameters }, processing_error: null, source: {},
      result: {
        arrays: {
          energy: [8960, 8980, 9000], norm: [0, 0.7, 1],
          k: [0, 1, 2, 3], chi: [0, 2, -1, 1], r: [0, 1, 2],
          chir_mag: [2, 3, 2], chir_re: [1, 1, 1], chir_im: [1, 2, 1], chir_pha: [0, 1, 2],
        },
        effective: { e0: 8979, edge_step: 1, kweight: 2 }, warnings: [],
      },
    }],
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AthenaWorkbench integrated request gating", () => {
  it("issues only the initial project GET for a read-project-only EXAFS session", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/athena/projects/integrated-project")) {
        return new Response(JSON.stringify(eligibleProject()), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ error: { message: `Unexpected request: ${url}` } }), {
        status: 404, headers: { "content-type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetcher)

    render(<AthenaWorkbench session={{
      mode: "integration", projectId: "integrated-project", capability: "read-only-capability",
      allowedOperations: ["read_project"], expiresAt: "2099-01-01T00:00:00Z",
    }} />)

    await screen.findByRole("button", { name: /EXAFS sample/ })
    fireEvent.click(screen.getByRole("tab", { name: /Fourier/ }))
    const viewerWeight = screen.getByRole("combobox", { name: "Viewer k-weight" })
    expect(viewerWeight).toBeDisabled()
    fireEvent.change(viewerWeight, { target: { value: "3" } })
    await new Promise(resolve => window.setTimeout(resolve, 250))

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    expect(fetcher.mock.calls[0][0]).toBe("/api/backend/api/athena/projects/integrated-project")
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET" })
    expect((fetcher.mock.calls[0][1]?.headers as Headers).get("x-xraylarch-project-capability")).toBe("read-only-capability")
  })
})
