import { afterEach, describe, expect, it, vi } from "vitest"
import type { AthenaProject } from "./athena"
import type { ArtemisModelDraft } from "./artemis"
import { ArtemisModelAutosave } from "./artemis-model-autosave"

function model(value: string): ArtemisModelDraft {
  return { revision: 0, paths: [], parameters: [{ id: "amp", name: "amp", kind: "guess", value, min: "", max: "", expression: "" }],
    transform: { fitspace: "r", window: "hanning", kmin: "3", kmax: "12", dk: "1", rmin: "1", rmax: "3", dr: "0", kweight: [2] } }
}
function project(version: number, models: Record<string, ArtemisModelDraft | undefined> = { a: model("1") }): AthenaProject {
  return { id: "p", version, groups: Object.entries(models).map(([id, draft]) => ({ id, ...(draft && { artemis: { schema_version: 1, model: draft, history: [] } }) })) } as AthenaProject
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function setup() {
  const save = vi.fn(async (_projectId: string, groupId: string, version: number, draft: ArtemisModelDraft) => project(version + 1, { [groupId]: draft }))
  const recover = vi.fn(async () => null as AthenaProject | null)
  const accept = vi.fn()
  const queue = new ArtemisModelAutosave({ save, recover, accept, changed: vi.fn() })
  queue.observe("p", 1, project(1).groups)
  return { queue, save, recover, accept }
}
afterEach(() => vi.useRealTimers())

describe("Artemis model autosave queue", () => {
  it("debounces edits and retains unfinished input without fitting", async () => {
    vi.useFakeTimers()
    const { queue, save } = setup()
    queue.update("p", "a", model("2"), model("1"), true)
    await vi.advanceTimersByTimeAsync(400)
    queue.update("p", "a", model("-"), model("1"), true)
    await vi.advanceTimersByTimeAsync(649)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledExactlyOnceWith("p", "a", 1, model("-"))
    expect(queue.state("p").status).toBe("saved")
    queue.dispose()
  })

  it("flushes all queued groups while paused, using each acknowledged project version", async () => {
    const { queue, save } = setup()
    queue.setPaused(true)
    queue.update("p", "a", model("2"), model("1"), true)
    queue.update("p", "b", model("3"), undefined, true)
    await queue.flush("p")
    expect(save.mock.calls.map(([, id, version]) => [id, version])).toEqual([["a", 1], ["b", 2]])
    expect(queue.dirtyGroups("p").every(entry => !entry.dirty)).toBe(true)
    queue.dispose()
  })

  it("serializes a newer edit behind the in-flight snapshot", async () => {
    const { queue, save } = setup()
    const first = deferred<AthenaProject>()
    save.mockReturnValueOnce(first.promise)
    queue.update("p", "a", model("2"), model("1"), true)
    const flushed = queue.flush("p")
    queue.update("p", "a", model("3"), model("1"), true)
    expect(save).toHaveBeenCalledTimes(1)
    first.resolve(project(2, { a: model("2") }))
    await flushed
    expect(save).toHaveBeenLastCalledWith("p", "a", 2, model("3"))
    expect(queue.state("p").status).toBe("saved")
    queue.dispose()
  })

  it("keeps failures pending until explicit retry", async () => {
    vi.useFakeTimers()
    const { queue, save } = setup()
    save.mockRejectedValueOnce(new Error("Offline"))
    queue.update("p", "a", model("-"), model("1"), true)
    await expect(queue.flush("p")).rejects.toThrow("Offline")
    await vi.advanceTimersByTimeAsync(5000)
    queue.update("p", "a", model("0.5"), model("1"), true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(1)
    await queue.flush("p", true)
    expect(save).toHaveBeenLastCalledWith("p", "a", 1, model("0.5"))
    queue.dispose()
  })

  it("recovers a stale revision, retains the draft, and retries only when requested", async () => {
    const { queue, save, recover } = setup()
    save.mockRejectedValueOnce(new Error("Conflict"))
    recover.mockResolvedValueOnce(project(4, { a: model("2") }))
    queue.update("p", "a", model("-"), model("1"), true)
    await expect(queue.flush("p")).rejects.toThrow("changed elsewhere")
    expect(save).toHaveBeenCalledTimes(1)
    await queue.flush("p", true)
    expect(save).toHaveBeenLastCalledWith("p", "a", 4, model("-"))
    queue.dispose()
  })

  it("does not regress an observed revision when an older save response arrives", async () => {
    const { queue, save, accept } = setup()
    const first = deferred<AthenaProject>()
    save.mockReturnValueOnce(first.promise)
    queue.update("p", "a", model("2"), model("1"), true)
    const flushed = queue.flush("p")
    queue.observe("p", 4, project(4, { a: model("3") }).groups)
    first.resolve(project(2, { a: model("2") }))
    await expect(flushed).rejects.toThrow("changed while")
    expect(queue.version("p", 0)).toBe(4)
    expect(accept).not.toHaveBeenCalled()
    await queue.flush("p", true)
    expect(save).toHaveBeenLastCalledWith("p", "a", 4, model("2"))
    queue.dispose()
  })
})
