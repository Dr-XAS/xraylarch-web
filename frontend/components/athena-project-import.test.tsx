import "@testing-library/jest-dom/vitest"
import { StrictMode, type ComponentProps } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { athenaApi, type AthenaProject } from "@/lib/athena"
import { AthenaProjectImport } from "./athena-project-import"

vi.mock("@/lib/athena", async original => ({ ...await original<typeof import("@/lib/athena")>(), athenaApi: vi.fn() }))
const plot = vi.hoisted(() => vi.fn((_props: {data: {x: number[]; y: number[]}[]; layout: Record<string, unknown>}) => null))
vi.mock("next/dynamic", () => ({ default: () => plot }))
const api = vi.mocked(athenaApi)

function preview(name = "first", ids = ["a", "b", "c"]) {
  return {upload_id: `upload-${name}`, filename: `${name}.prj`, name: `${name} project`,
    journal: "Before annealing\nAfter annealing", warnings: [],
    groups: ids.map((id, index) => ({id, label: ["Sample", "Reference foil", "Oxide"][index] ?? id,
      data_type: "mu", points: 1201, x: [8970, 8980, 8990], y: [index, index + .5, index + 1],
      notes: `Notes for ${id}`, reference_id: index === 0 ? ids[1] : null}))}
}
function setup(extra: Partial<ComponentProps<typeof AthenaProjectImport>> = {}) {
  let current: AthenaProject = {id: "workspace", version: 0, name: "Existing project", groups: [],
    journal: "Keep", updated: "2026-09-07", history: [], undo: [], redo: []}
  const imported = vi.fn((next: AthenaProject) => { current = next })
  const complete = vi.fn(), busy = vi.fn()
  const result = (version: number) => ({...current, version})
  render(<StrictMode><AthenaProjectImport getProject={() => current} onImported={imported} onComplete={complete} onBusyChange={busy} {...extra} /></StrictMode>)
  return {imported, complete, busy, result}
}
function choose(names = ["first"]) {
  fireEvent.change(screen.getByLabelText("Open project file"), {
    target: {files: names.map(name => new File(["project"], `${name}.prj`))},
  })
}
async function ready(name = "first") { await screen.findByRole("heading", {name: `${name} project`}) }
function checkbox(label: string) { return screen.getByRole("checkbox", {name: new RegExp(`^Import ${label},`)}) }
function imports() { return api.mock.calls.filter(([path]) => path.endsWith("/restore-upload")) }

beforeEach(() => { api.mockReset(); api.mockRejectedValue(new Error("Unexpected API call")); plot.mockClear() })
afterEach(cleanup)

describe("Athena project preview and selection", () => {
  it("consumes a batch forwarded from Import data exactly once in StrictMode", async () => {
    const initialFiles = [new File(["project"], "first.PRJ")]
    api.mockResolvedValueOnce(preview())
    setup({ initialFiles }); await ready()
    expect(api).toHaveBeenCalledTimes(1)
    expect((api.mock.calls[0][1] as FormData).get("file")).toBe(initialFiles[0])
  })

  it("hands a mixed batch back to raw import after releasing its busy state", async () => {
    const remaining = [new File(["data"], "scan.xmu"), new File(["project"], "last.prj")]
    const handoff = vi.fn()
    api.mockResolvedValueOnce(preview())
    const state = setup({ initialFiles: [new File(["project"], "first.prj"), ...remaining], onRemainingFiles: handoff })
    await ready()
    handoff.mockImplementation(() => { expect(state.busy).toHaveBeenLastCalledWith("") })
    api.mockResolvedValueOnce(state.result(1))
    fireEvent.click(screen.getByRole("button", { name: "Import all groups" }))
    await waitFor(() => expect(handoff).toHaveBeenCalledWith(remaining))
    expect(state.imported).toHaveBeenCalledOnce()
    expect(state.complete).not.toHaveBeenCalled()
    expect(api).toHaveBeenCalledTimes(2)
  })

  it("rejects a mismatched preview signal instead of labelling raw values as normalized", async () => {
    setup(); api.mockResolvedValueOnce(preview()); choose(); await ready()
    api.mockResolvedValueOnce({mode: "mu", data_type: "mu", label: "Sample", x: [8970, 8980, 8990], y: [1, 2, 3], warnings: []})
    fireEvent.change(screen.getByRole("combobox", {name: "Preview signal"}), {target: {value: "norm"}})
    expect(await screen.findByText("The requested preview signal was not returned. Try again.")).toBeVisible()
    expect(imports()).toHaveLength(0)
    api.mockResolvedValueOnce({mode: "norm", data_type: "mu", label: "Sample", x: [8970, 8980, 8990], y: [0, .5, 1], warnings: []})
    fireEvent.click(screen.getByRole("button", {name: "Retry plot preview"}))
    await waitFor(() => expect(plot.mock.calls.at(-1)?.[0].data[0].y).toEqual([0, .5, 1]))
    expect(screen.queryByText(/requested preview signal was not returned/)).not.toBeInTheDocument()
  })

  it("previews raw data, journal and notes without importing or selecting the viewed row", async () => {
    const state = setup(), data = preview()
    api.mockResolvedValueOnce(data)
    choose(); await ready()
    expect(screen.getByText(/Before annealing/)).toBeVisible()
    expect(screen.getByText("Notes for a")).toBeVisible()
    await waitFor(() => expect(plot.mock.calls.at(-1)?.[0].data[0].y).toEqual(data.groups[0].y))
    fireEvent.click(screen.getByRole("button", {name: "Preview Reference foil, group 2"}))
    expect(screen.getByText("Notes for b")).toBeVisible()
    expect(screen.getAllByRole("checkbox").every(input => (input as HTMLInputElement).checked)).toBe(true)
    expect(state.imported).not.toHaveBeenCalled(); expect(imports()).toEqual([])
    expect(api.mock.calls[0][0]).toBe("/projects/workspace/preview-project")
  })

  it("submits the selected IDs in source order and leaves preview choices out of the import recipe", async () => {
    const state = setup(); api.mockResolvedValueOnce(preview()); choose(); await ready()
    fireEvent.click(checkbox("Reference foil"))
    api.mockResolvedValueOnce(state.result(1))
    fireEvent.click(screen.getByRole("button", {name: "Import 2 selected groups"}))
    await waitFor(() => expect(state.complete).toHaveBeenCalledOnce())
    expect(imports()[0][1]).toEqual({version: 0, upload_id: "upload-first", group_ids: ["a", "c"]})
  })

  it("implements all, none and invert with explicit empty-selection-imports-all wording", async () => {
    const state = setup(); api.mockResolvedValueOnce(preview()); choose(); await ready()
    fireEvent.click(screen.getByRole("button", {name: "Select none"}))
    expect(screen.getByText(/No groups selected: Import all will import the entire project/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", {name: "Invert"}))
    expect(screen.getAllByRole("checkbox").every(input => (input as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(screen.getByRole("button", {name: "Select none"}))
    api.mockResolvedValueOnce(state.result(1))
    fireEvent.click(screen.getByRole("button", {name: "Import all groups"}))
    await waitFor(() => expect(state.imported).toHaveBeenCalledOnce())
    expect(imports()[0][1]).toEqual({version: 0, upload_id: "upload-first", group_ids: []})
  })

  it("selects by periodic position and handles invalid intervals without changing selection", async () => {
    setup(); api.mockResolvedValueOnce(preview()); choose(); await ready()
    fireEvent.click(screen.getByRole("button", {name: "Select by position"}))
    expect(checkbox("Sample")).toBeChecked(); expect(checkbox("Reference foil")).not.toBeChecked(); expect(checkbox("Oxide")).toBeChecked()
    fireEvent.change(screen.getByRole("spinbutton", {name: "Selection interval"}), {target: {value: "0"}})
    fireEvent.click(screen.getByRole("button", {name: "Select by position"}))
    expect(screen.getByRole("alert")).toHaveTextContent("positive whole numbers")
    expect(checkbox("Sample")).toBeChecked(); expect(checkbox("Reference foil")).not.toBeChecked()
    expect(imports()).toHaveLength(0)
  })

  it("matches labels and preserves selection after invalid regular expressions", async () => {
    setup(); api.mockResolvedValueOnce(preview()); choose(); await ready()
    fireEvent.change(screen.getByRole("textbox", {name: /Matching labels/}), {target: {value: "foil|Oxide"}})
    fireEvent.click(screen.getByRole("button", {name: "Select matching"}))
    expect(checkbox("Sample")).not.toBeChecked(); expect(checkbox("Reference foil")).toBeChecked(); expect(checkbox("Oxide")).toBeChecked()
    fireEvent.change(screen.getByRole("textbox", {name: /Matching labels/}), {target: {value: "["}})
    fireEvent.click(screen.getByRole("button", {name: "Select matching"}))
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid regular expression")
    expect(checkbox("Sample")).not.toBeChecked(); expect(checkbox("Reference foil")).toBeChecked()
  })

  it("supports shift-click ranges while keeping group identity separate from duplicate labels", async () => {
    setup(); const data = preview(); data.groups[2].label = "Sample"
    api.mockResolvedValueOnce(data); choose(); await ready()
    fireEvent.click(screen.getByRole("button", {name: "Select none"}))
    fireEvent.click(screen.getByRole("checkbox", {name: "Import Sample, group 1"}))
    fireEvent.click(screen.getByRole("checkbox", {name: "Import Sample, group 3"}), {shiftKey: true})
    expect(screen.getAllByRole("checkbox").every(input => (input as HTMLInputElement).checked)).toBe(true)
  })

  it("fetches a real computed preview and does not change the imported selection", async () => {
    setup(); const data = preview(); api.mockResolvedValueOnce(data); choose(); await ready()
    api.mockResolvedValueOnce({x: [8972, 8982], y: [.1, .9], label: "Sample", mode: "norm", data_type: "mu", warnings: []})
    fireEvent.change(screen.getByRole("combobox", {name: "Preview signal"}), {target: {value: "norm"}})
    await waitFor(() => expect(plot.mock.calls.at(-1)?.[0].data[0].y).toEqual([.1, .9]))
    expect(api.mock.calls[1][0]).toBe("/projects/workspace/preview-project/upload-first/groups/a?mode=norm")
    expect(imports()).toHaveLength(0)
    expect(screen.getAllByRole("checkbox").every(input => (input as HTMLInputElement).checked)).toBe(true)
  })

  it("ignores a delayed computed preview after switching to another group", async () => {
    setup(); const data = preview(); api.mockResolvedValueOnce(data); choose(); await ready()
    let resolve!: (value: unknown) => void
    api.mockReturnValueOnce(new Promise(value => { resolve = value }))
    fireEvent.change(screen.getByRole("combobox", {name: "Preview signal"}), {target: {value: "norm"}})
    fireEvent.click(screen.getByRole("button", {name: "Preview Reference foil, group 2"}))
    await act(async () => resolve({x: [1, 2], y: [20, 40], mode: "norm", label: "Late", data_type: "mu", warnings: []}))
    expect(plot.mock.calls.at(-1)?.[0].data[0].y).toEqual(data.groups[1].y)
    expect(screen.getByRole("combobox", {name: "Preview signal"})).toHaveValue("mu")
  })

  it("retains raw-data import and allows retry after a computed-preview failure", async () => {
    setup(); api.mockResolvedValueOnce(preview()); choose(); await ready()
    api.mockRejectedValueOnce(new Error("Preview calculation unavailable"))
    fireEvent.change(screen.getByRole("combobox", {name: "Preview signal"}), {target: {value: "norm"}})
    expect(await screen.findByText("Preview calculation unavailable")).toBeVisible()
    expect(screen.getByRole("button", {name: "Import all groups"})).toBeEnabled()
    api.mockResolvedValueOnce({x: [1, 2], y: [0, 1], label: "Sample", mode: "norm", data_type: "mu", warnings: []})
    fireEvent.click(screen.getByRole("button", {name: "Retry plot preview"}))
    await waitFor(() => expect(screen.queryByText("Preview calculation unavailable")).not.toBeInTheDocument())
    expect(api.mock.calls.at(-1)?.[0]).toMatch(/groups\/a\?mode=norm$/)
  })
})

describe("Athena project batches and recovery", () => {
  it("imports remaining whole projects automatically with fresh destination versions", async () => {
    const state = setup()
    api.mockResolvedValueOnce(preview()).mockResolvedValueOnce(state.result(1))
      .mockResolvedValueOnce(preview("second", ["s"])).mockResolvedValueOnce(state.result(2))
      .mockResolvedValueOnce(preview("third", ["t"])).mockResolvedValueOnce(state.result(3))
    choose(["first", "second", "third"]); await ready()
    fireEvent.click(screen.getByRole("button", {name: "Import all groups"}))
    await waitFor(() => expect(state.complete).toHaveBeenCalledOnce())
    expect(imports().map(call => call[1])).toEqual([
      {version: 0, upload_id: "upload-first", group_ids: ["a", "b", "c"]},
      {version: 1, upload_id: "upload-second", group_ids: []},
      {version: 2, upload_id: "upload-third", group_ids: []},
    ])
    expect(state.imported).toHaveBeenCalledTimes(3)
  })

  it("pauses at the next project after a subset, then resumes automatic import after a whole selection", async () => {
    const state = setup()
    api.mockResolvedValueOnce(preview()).mockResolvedValueOnce(state.result(1)).mockResolvedValueOnce(preview("second", ["s"]))
    choose(["first", "second", "third"]); await ready()
    fireEvent.click(checkbox("Reference foil"))
    fireEvent.click(screen.getByRole("button", {name: "Import 2 selected groups"}))
    await ready("second")
    await waitFor(() => expect(screen.getByRole("button", {name: "Import all groups"})).toBeEnabled())
    expect(imports()).toHaveLength(1); expect(state.complete).not.toHaveBeenCalled()
    api.mockResolvedValueOnce(state.result(2)).mockResolvedValueOnce(preview("third", ["t"])).mockResolvedValueOnce(state.result(3))
    fireEvent.click(screen.getByRole("button", {name: "Import all groups"}))
    await waitFor(() => expect(state.complete).toHaveBeenCalledOnce())
    expect(imports()).toHaveLength(3)
  })

  it("retries only a failed restore, retaining its upload and selection", async () => {
    const state = setup()
    api.mockResolvedValueOnce(preview()).mockResolvedValueOnce(state.result(1))
      .mockResolvedValueOnce(preview("second", ["s"])).mockRejectedValueOnce(new Error("Try this import again"))
    choose(["first", "second", "third"]); await ready()
    fireEvent.click(screen.getByRole("button", {name: "Import all groups"}))
    expect(await screen.findByRole("alert")).toHaveTextContent("Try this import again")
    expect(state.imported).toHaveBeenCalledOnce()
    expect(screen.getByRole("heading", {name: "second project"})).toBeVisible()
    api.mockResolvedValueOnce(state.result(2)).mockResolvedValueOnce(preview("third", ["t"])).mockResolvedValueOnce(state.result(3))
    fireEvent.click(screen.getByRole("button", {name: "Import all groups"}))
    await waitFor(() => expect(state.complete).toHaveBeenCalledOnce())
    expect(imports().map(call => (call[1] as {upload_id: string}).upload_id)).toEqual(["upload-first", "upload-second", "upload-second", "upload-third"])
    expect(imports().map(call => (call[1] as {version: number}).version)).toEqual([0, 1, 1, 2])
  })

  it("clears the accepted upload before a next-file inspection failure and retries that file", async () => {
    const state = setup()
    api.mockResolvedValueOnce(preview()).mockResolvedValueOnce(state.result(1)).mockRejectedValueOnce(new Error("Cannot read second project"))
    choose(["first", "second"]); await ready()
    fireEvent.click(screen.getByRole("button", {name: "Import all groups"}))
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot read second project")
    expect(screen.queryByRole("button", {name: "Import all groups"})).not.toBeInTheDocument()
    api.mockResolvedValueOnce(preview("second", ["s"]))
    fireEvent.click(screen.getByRole("button", {name: "Retry preview"}))
    await ready("second")
    expect(imports()).toHaveLength(1)
    const form = api.mock.calls.at(-1)?.[1] as FormData
    expect((form.get("file") as File).name).toBe("second.prj")
    expect(state.imported).toHaveBeenCalledOnce()
  })

  it("keeps failed first previews recoverable and clears parent busy state", async () => {
    const state = setup(); api.mockRejectedValueOnce(new Error("Invalid project")); choose()
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid project")
    expect(state.busy).toHaveBeenLastCalledWith("")
    api.mockResolvedValueOnce(preview())
    fireEvent.click(screen.getByRole("button", {name: "Retry preview"})); await ready()
    expect(imports()).toHaveLength(0)
  })
})

describe('Detector project preview', () => {
  it('previews counts with a detector axis label and no normalization or derivative options', async () => {
    const data = preview('detector', ['counts']); data.groups[0].data_type = 'detector'
    api.mockResolvedValueOnce(data); setup(); choose(['detector']); await ready('detector')
    const select = screen.getByRole('combobox', { name: 'Preview signal' }) as HTMLSelectElement
    expect([...select.options].map(option => option.text)).toEqual(['Detector signal'])
    await waitFor(() => expect(plot).toHaveBeenCalled())
    const props = plot.mock.calls.at(-1)![0]
    expect(props.data[0].y).toEqual(data.groups[0].y)
    expect(props.layout.yaxis).toEqual({ title: { text: 'Detector signal' }, automargin: true })
    expect(api).toHaveBeenCalledTimes(1)
  })
})
