import "@testing-library/jest-dom/vitest"

import { useEffect, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AthenaGroup, AthenaProject } from "@/lib/athena"
import { artemisApi, type ArtemisModelDraft, type ArtemisPath } from "@/lib/artemis"
import type { RadialShellContext } from "@/lib/radial-shells"
import { useRadialShells } from "@/lib/use-radial-shells"
import { radialFixture, radialMetadata, radialStructure } from "@/tests/fixtures/radial-shells"
import { ArtemisFittingPanel, type ArtemisModelActions } from "./artemis-fitting"

vi.mock("@/lib/artemis", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/artemis")>(), artemisApi: vi.fn() }))
vi.mock("@/lib/use-radial-shells", () => ({ useRadialShells: vi.fn() }))
vi.mock("./artemis-fast-fit", () => ({ ArtemisFastFitComparison: () => null }))
vi.mock("./artemis-structures", () => ({
  ArtemisStructures: ({ onRadialContextChange, children }: {
    onRadialContextChange: (context: RadialShellContext | null) => void
    children: (sections: { structures: ReactNode; feff: ReactNode }) => ReactNode
  }) => {
    useEffect(() => { onRadialContextChange({ structure: radialStructure, attachmentId: "cif", siteIndex: 1 }) }, [onRadialContextChange])
    return children({ structures: null, feff: null })
  },
}))

const api = vi.mocked(artemisApi)
const sameShell = "Apply to the same-shell FEFF paths"
const selected = "Apply to all selected FEFF paths"
const fields = [
  ["s02", "S₀²", "0.85 * 4 / degen"],
  ["e0", "ΔE₀ (eV)", "del_e0 + 0.5"],
  ["deltar", "ΔR (Å)", "0.01 * reff"],
  ["sigma2", "σ² (Å²)", "sigma2_eins(298, 300)"],
] as const

function model(): ArtemisModelDraft {
  const paths: ArtemisPath[] = [1, 1, 2, 1, 1].map((shell, index) => ({
    id: `path-${index + 1}`, label: `Path ${index + 1}`, filename: `feff000${index + 1}.dat`, content: `synthetic path ${index + 1}`,
    enabled: [0, 2, 3].includes(index), s02: "amp", e0: "del_e0", deltar: "del_r", sigma2: "sig2", metadata: radialMetadata(shell),
  }))
  paths[3].metadata.nleg = 3
  paths[4].metadata.geometry = []
  return {
    revision: 0, paths,
    parameters: [["amp", "0.85"], ["del_e0", "0"], ["del_r", "0"], ["sig2", "0.003"]].map(([name, value]) => ({
      id: `parameter-${name}`, name, value, kind: "guess", expression: "", min: "", max: "",
    })),
    transform: { fitspace: "r", kmin: "3", kmax: "12", kweight: [2], dk: "1", window: "hanning", rmin: "1", rmax: "3", dr: "0" },
  }
}

function group(draft = model()): AthenaGroup {
  return {
    id: "copper", label: "Copper reference", marked: true, frozen: false, data_type: "chi", energy: [], mu: [], multiplier: 1,
    offset: 0, notes: "", reference_id: null, source: {}, processing_error: null,
    parameters: {
      e0: null, step: null, pre1: null, pre2: null, norm1: null, norm2: null, nnorm: null, flatten: true,
      rbkg: 1, bkg_kmin: 0, bkg_kmax: null, bkg_kweight: 2, clamp_lo: 0, clamp_hi: 1,
      kmin: 3, kmax: 12, kweight: 2, dk: 1, window: "hanning", rmin: 1, rmax: 3, dr: 0,
      rwindow: "hanning", energy_shift: 0, nfft: 2048, kstep: 0.05,
    },
    result: { effective: { kweight: 2 }, warnings: [], arrays: { k: [0, 3, 6, 9, 12], chi: [0, 1, -1, 0.5, 0] } },
    artemis: { schema_version: 1, model: draft, history: [], current_input_sha256: null },
  }
}

function setup(source = group(), extras: Partial<React.ComponentProps<typeof ArtemisFittingPanel>> = {}) {
  const view = render(<ArtemisFittingPanel projectId="project" version={1} group={source} {...extras} />)
  fireEvent.click(screen.getByRole("button", { name: "Expand all path details" }))
  return view
}

beforeEach(() => {
  api.mockReset()
  vi.mocked(useRadialShells).mockReturnValue({
    contextKey: "cif:1", data: radialFixture, loading: false, error: "", retry: vi.fn(),
    settings: { radius: 6, tolerance: 0.05 }, setSettings: vi.fn(),
  })
})
afterEach(cleanup)

describe("FEFF path parameter context menu", () => {
  it.each(fields)("copies only %s to same-shell paths, including an excluded peer", (field, label, expression) => {
    const original = model()
    setup(group(original))
    const input = screen.getByLabelText(`Path 1 ${label}`, { exact: true })
    fireEvent.change(input, { target: { value: expression } })
    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole("menuitem", { name: sameShell }))
    original.paths.forEach((path, index) => {
      for (const [key, fieldLabel] of fields) {
        expect(screen.getByLabelText(`Path ${index + 1} ${fieldLabel}`, { exact: true }))
          .toHaveValue(key === field && index < 2 ? expression : path[key])
      }
      expect(screen.getByLabelText(`Include path ${index + 1}`)).toHaveProperty("checked", path.enabled)
    })
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(input).toHaveFocus()
    expect(api).not.toHaveBeenCalled()
  })

  it.each(fields)("copies only %s to selected paths across shells and scattering types", (field, label, expression) => {
    const original = model()
    setup(group(original))
    const input = screen.getByLabelText(`Path 1 ${label}`, { exact: true })
    fireEvent.change(input, { target: { value: expression } })
    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole("menuitem", { name: selected }))
    original.paths.forEach((path, index) => {
      for (const [key, fieldLabel] of fields) {
        expect(screen.getByLabelText(`Path ${index + 1} ${fieldLabel}`, { exact: true }))
          .toHaveValue(key === field && path.enabled ? expression : path[key])
      }
      expect(screen.getByLabelText(`Include path ${index + 1}`)).toHaveProperty("checked", path.enabled)
    })
  })

  it.each([3, 4, 5])("cannot treat an unshared shell, multiple scattering or unmatched path %s as a shared shell", pathIndex => {
    setup()
    fireEvent.contextMenu(screen.getByLabelText(`Path ${pathIndex} ΔR (Å)`, { exact: true }))
    const action = screen.queryByRole("menuitem", { name: sameShell })
    if (action) expect(action).toBeDisabled()
    expect(screen.getByRole("menuitem", { name: selected })).toBeEnabled()
  })

  it("keeps selected-path copying available while shell analysis is unavailable", () => {
    vi.mocked(useRadialShells).mockReturnValue({
      contextKey: "cif:1", data: null, loading: true, error: "", retry: vi.fn(),
      settings: { radius: 6, tolerance: 0.05 }, setSettings: vi.fn(),
    })
    setup()
    fireEvent.contextMenu(screen.getByLabelText("Path 1 S₀²", { exact: true }))
    const action = screen.queryByRole("menuitem", { name: sameShell })
    if (action) expect(action).toBeDisabled()
    expect(screen.getByRole("menuitem", { name: selected })).toBeEnabled()
  })

  it.each([{ key: "ContextMenu" }, { key: "F10", shiftKey: true }])("opens from the keyboard and restores focus after Escape: %j", key => {
    setup()
    const input = screen.getByLabelText("Path 1 ΔR (Å)", { exact: true })
    input.focus()
    fireEvent.keyDown(input, key)
    expect(screen.getByRole("menuitem", { name: sameShell })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" })
    expect(screen.getByRole("menuitem", { name: selected })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(input).toHaveFocus()
    expect(screen.getByLabelText("Path 2 ΔR (Å)", { exact: true })).toHaveValue("del_r")
  })

  it("disables selected copying without another selected path and blocks opening during processing", () => {
    const draft = model()
    draft.paths.forEach((path, index) => { path.enabled = index === 0 })
    const source = group(draft)
    const view = setup(source)
    const input = screen.getByLabelText("Path 1 σ² (Å²)", { exact: true })
    fireEvent.contextMenu(input)
    expect(screen.getByRole("menuitem", { name: selected })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    view.rerender(<ArtemisFittingPanel projectId="project" version={1} group={source} pending />)
    fireEvent.contextMenu(input)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("saves a bulk expression edit through the model queue without changing parameters or FEFF metadata", async () => {
    const draft = model()
    const source = group(draft)
    let actions: ArtemisModelActions | null = null
    const acceptProject = vi.fn()
    api.mockImplementation(async (_url, body) => {
      const { model: saved, version } = body as { model: ArtemisModelDraft; version: number }
      return {
        id: "project", name: "Synthetic model", version: version + 1, groups: [group(saved)], journal: "", updated: "now",
        undo: [], redo: [], history: [],
      } satisfies AthenaProject
    })
    setup(source, { onActionsChange: value => { actions = value }, onProjectChange: acceptProject })
    const expression = "0.01 * reff"
    fireEvent.change(screen.getByLabelText("Path 1 ΔR (Å)", { exact: true }), { target: { value: expression } })
    fireEvent.contextMenu(screen.getByLabelText("Path 1 ΔR (Å)", { exact: true }))
    fireEvent.click(screen.getByRole("menuitem", { name: selected }))
    await act(async () => { await actions!.flush() })
    expect(api).toHaveBeenCalledOnce()
    expect(api.mock.calls[0][0]).toBe("/projects/project/groups/copper/model")
    const saved = (api.mock.calls[0][1] as { model: ArtemisModelDraft }).model
    expect(saved.parameters).toEqual(draft.parameters)
    expect(saved.transform).toEqual(draft.transform)
    expect(saved.paths).toEqual(draft.paths.map(path => path.enabled ? { ...path, deltar: expression } : path))
    expect(acceptProject).toHaveBeenCalledOnce()
  })
})
