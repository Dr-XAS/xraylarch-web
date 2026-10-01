import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { artemisApi } from "./artemis"
import { useFirstShell } from "./use-first-shell"
import type { ArtemisStructure } from "./artemis-structures"
import type { FirstShell } from "./first-shell"
vi.mock("./artemis", () => ({ artemisApi: vi.fn() }))
const api = vi.mocked(artemisApi)
const structure = { supported: true, cif: "data_test", sites: [{ index: 1, element: "Cu" }, { index: 2, element: "O" }] } as ArtemisStructure
const response = (site = 1) => ({ method: "CrystalNN", cif: "data_test", site_index: site, absorber: site === 1 ? "Cu" : "O", coordination_number: 0, neighbors: [] }) as unknown as FirstShell
afterEach(() => { cleanup(); vi.resetAllMocks() })
it("waits for a site and never applies a late response after site/snapshot changes", async () => {
  let late!: (value: FirstShell) => void
  api.mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
  const view = renderHook(({ site, cif }) => useFirstShell({ ...structure, cif }, site), { initialProps: { site: undefined as number | undefined, cif: "data_test" } })
  expect(api).not.toHaveBeenCalled()
  view.rerender({ site: 1, cif: "data_test" })
  const signal = api.mock.calls[0][2]
  api.mockResolvedValueOnce(response(2))
  view.rerender({ site: 2, cif: "data_test" })
  await waitFor(() => expect(view.result.current.shell?.site_index).toBe(2))
  expect(signal?.aborted).toBe(true)
  await act(async () => { late(response(1)) })
  expect(view.result.current.shell?.site_index).toBe(2)
  api.mockImplementationOnce(() => new Promise(() => {}))
  view.rerender({ site: 2, cif: "data_changed" })
  expect(view.result.current.shell).toBeNull()
  expect(view.result.current.loading).toBe(true)
})
it("shows failures, supports retry, and rejects mismatched absorber results", async () => {
  api.mockRejectedValueOnce(new Error("No Voronoi neighbors"))
  const view = renderHook(() => useFirstShell(structure, 1))
  await waitFor(() => expect(view.result.current.error).toContain("No Voronoi"))
  api.mockResolvedValueOnce(response(2))
  act(() => view.result.current.retry())
  await waitFor(() => expect(view.result.current.error).toContain("different CIF or absorber"))
  api.mockResolvedValueOnce(response())
  act(() => view.result.current.retry())
  await waitFor(() => expect(view.result.current.shell?.site_index).toBe(1))
})
it("rejects a different CIF with the same absorber and site", async () => {
  api.mockResolvedValueOnce({ ...response(), cif: "data_other" })
  const view = renderHook(() => useFirstShell(structure, 1))
  await waitFor(() => expect(view.result.current.error).toContain("different CIF"))
  expect(view.result.current.shell).toBeNull()
})
