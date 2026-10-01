import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { artemisApi } from "./artemis"
import { useRadialShells } from "./use-radial-shells"
import { radialFixture, radialStructure } from "@/tests/fixtures/radial-shells"
vi.mock("./artemis", () => ({ artemisApi: vi.fn() }))
const api = vi.mocked(artemisApi)
afterEach(() => { cleanup(); vi.resetAllMocks() })

it("shares explicit settings across panels, aborts old requests and rejects stale analysis", async () => {
  let late!: (value: typeof radialFixture) => void
  api.mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
  api.mockResolvedValue(radialFixture)
  const one = renderHook(() => useRadialShells(radialStructure, 1))
  const signal = api.mock.calls[0][2]
  const two = renderHook(() => useRadialShells(radialStructure, 1))
  await waitFor(() => expect(two.result.current.data).not.toBeNull())
  api.mockResolvedValue({ ...radialFixture, radius: 7 })
  act(() => one.result.current.setSettings({ radius: 7, tolerance: 0.05 }))
  await waitFor(() => expect(one.result.current.data?.radius).toBe(7))
  expect(two.result.current.settings.radius).toBe(7)
  expect(signal?.aborted).toBe(true)
  await act(async () => late(radialFixture))
  expect(one.result.current.data?.radius).toBe(7)
  api.mockResolvedValue(radialFixture)
  act(() => one.result.current.setSettings({ radius: 8, tolerance: 0.05 }))
  await waitFor(() => expect(one.result.current.error).toContain("different CIF, site or range"))
  expect(one.result.current.data).toBeNull()
})
it("waits for an explicit supported site and clears results when the CIF changes", async () => {
  const structure = { ...radialStructure, cif: "data_hook_second" }
  api.mockResolvedValue({ ...radialFixture, cif: structure.cif })
  const hook = renderHook(({ cif, site }) => useRadialShells({ ...structure, cif }, site), { initialProps: { cif: structure.cif, site: undefined as number | undefined } })
  expect(api).not.toHaveBeenCalled()
  hook.rerender({ cif: structure.cif, site: 1 })
  await waitFor(() => expect(hook.result.current.data?.site_index).toBe(1))
  api.mockImplementation(() => new Promise(() => {}))
  hook.rerender({ cif: "data_new", site: 1 })
  expect(hook.result.current.data).toBeNull()
  expect(hook.result.current.loading).toBe(true)
})
