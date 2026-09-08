import "@testing-library/jest-dom/vitest"
import { useLayoutEffect, useState, type ComponentProps } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { athenaApi, type AthenaProject, type DifferenceForm, type DifferenceOptions, type DifferencePreview } from "@/lib/athena"
import { ApiRequestError } from "@/lib/backend-client"
import { AthenaDifferenceDialog } from "./athena-difference"
import type { AthenaDifferencePlot } from "./athena-difference-plot"
import { differenceInputs, differenceOptions, differencePreview, differenceProject, differenceSaved } from "./athena-difference.fixtures"

vi.mock("@/lib/athena", async original => ({ ...await original<typeof import("@/lib/athena")>(), athenaApi: vi.fn() }))
type PlotProps = ComponentProps<typeof AthenaDifferencePlot>
const plotted = vi.hoisted(() => vi.fn<(props: PlotProps) => void>())
vi.mock("./athena-difference-plot", () => ({ AthenaDifferencePlot: (props: PlotProps) => {
  // Record only committed props, never an abandoned concurrent render.
  useLayoutEffect(() => { plotted(props) })
  return <div data-testid="difference-plot"><button onClick={() => props.onPick(8984.5)}>Click plotted energy 8984.5</button></div>
} }))
const api = vi.mocked(athenaApi)
const descriptors = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
}
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", "") } })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open") } })
})
afterAll(() => {
  for (const name of ["showModal", "close"] as const) {
    const descriptor = descriptors[name]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})
beforeEach(() => { api.mockReset(); api.mockRejectedValue(new Error("Unexpected request")); plotted.mockClear() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup(project = differenceProject()) {
  let latest = project
  const onSaved = vi.fn(), onBusyChange = vi.fn(), close = vi.fn()
  const getProject = vi.fn(() => latest)
  function Host({ project }: { project: AthenaProject }) {
    const [activeId, selectData] = useState(project.groups[0]?.id ?? "")
    return <AthenaDifferenceDialog project={project} activeId={activeId} getProject={getProject} selectData={selectData} onSaved={onSaved} onBusyChange={onBusyChange} close={close} />
  }
  const rendered = render(<Host project={project} />)
  return { ...rendered, onSaved, onBusyChange, close, project,
    changeProject(next: AthenaProject, renderChange = true) { latest = next; if (renderChange) rendered.rerender(<Host project={next} />) } }
}
function select(name: string, value: string) { fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } }) }
function number(name: RegExp, value: string | number) { fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value: String(value) } }) }
function button(name: string) { return screen.getByRole("button", { name }) }
function plot() { return plotted.mock.calls.at(-1)![0] }
async function preview(response = differencePreview()) {
  api.mockResolvedValueOnce(response)
  fireEvent.click(button("Preview difference"))
  await waitFor(() => expect(button("Save difference groups")).toBeEnabled())
  return response
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

describe("Athena Difference dialog", () => {
  it("starts with native defaults, requires an explicit standard, and previews without project mutation", async () => {
    const project = freeze(differenceProject())
    const { onSaved, onBusyChange, close } = setup(project)
    expect(api).not.toHaveBeenCalled()
    expect(button("Preview difference")).toBeDisabled()
    expect(button("Save difference groups")).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "Difference form" })).toHaveValue("norm")
    expect(screen.getByRole("spinbutton", { name: "STANDARD multiplier" })).toHaveValue(1)
    expect(screen.getByRole("textbox", { name: "Name template" })).toHaveValue("diff %d - %s")
    expect(screen.getByRole("textbox", { name: "Name template" })).toHaveAttribute("maxlength", "200")
    expect(screen.getByRole("checkbox", { name: "Integrate difference" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Plot DATA and STANDARD" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Invert difference spectrum" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Allow difference group to be renormalized" })).not.toBeChecked()
    select("STANDARD", "standard")
    const response = await preview()
    expect(api.mock.calls).toEqual([[`/projects/${project.id}/difference/preview`, { version: 7, action: "difference", group_ids: ["data"], options: differenceOptions }]])
    expect(plot().preview).toEqual(response)
    expect(onSaved).not.toHaveBeenCalled()
    expect(onBusyChange).not.toHaveBeenCalled()
    fireEvent.click(button("Cancel"))
    expect(close).toHaveBeenCalledOnce()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it.each(["xmu", "norm", "der", "nder", "sec", "nsec"] as DifferenceForm[])("previews and saves %s with explicit options and the returned names", async form => {
    const { project, onSaved, close, onBusyChange } = setup()
    select("STANDARD", "standard")
    select("Difference form", form)
    expect(screen.getByRole("checkbox", { name: "Allow difference group to be renormalized" })).toHaveProperty("checked", form === "xmu")
    number(/^STANDARD multiplier$/, 1.75)
    number(/^Integration minimum/, -12)
    number(/^Integration maximum/, 24)
    fireEvent.click(screen.getByRole("checkbox", { name: "Invert difference spectrum" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Plot DATA and STANDARD" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Name template" }), { target: { value: "%d / %s %f %m %n %x %a %%" } })
    const options = { ...differenceOptions, form, multiplier: 1.75, xmin: -12, xmax: 24, invert: true, plot_inputs: false, renormalize: form === "xmu", name_template: "%d / %s %f %m %n %x %a %%" }
    const response = differencePreview(project, ["data"], options)
    response.results[0].label = `STANDARD foil / DATA foil ${form} 1.75 -12 24 -0.25000 %`
    await preview(response)
    expect(screen.getByRole("table")).toHaveTextContent(response.results[0].label)
    const saved = differenceSaved(project, response)
    api.mockResolvedValueOnce(saved)
    fireEvent.click(button("Save difference groups"))
    await waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved))
    expect(api.mock.calls[1]).toEqual([`/projects/${project.id}/command`, { version: response.version, action: "difference", group_ids: ["data"], options: response.options }])
    expect(onBusyChange.mock.calls).toEqual([["Saving difference groups"], [""]])
    expect(close).toHaveBeenCalledOnce()
  })

  it("uses all marked targets in list order, excludes the standard, allows frozen sources and plots area labels", async () => {
    const project = differenceProject()
    project.groups = [project.groups[2], project.groups[1], project.groups[0]]
    project.groups[2].frozen = true
    project.groups[1].frozen = true
    freeze(project)
    const { onSaved } = setup(project)
    select("STANDARD", "standard"); select("DATA targets", "marked")
    const response = await preview(differencePreview(project, ["other", "data"]))
    expect(api.mock.calls[0][1]).toEqual({ version: 7, action: "difference", group_ids: ["other", "data"], options: differenceOptions })
    expect(within(screen.getByRole("list", { name: "Difference targets" })).getAllByRole("listitem").map(item => item.textContent)).toEqual(["Other scan", "DATA foil · frozen (read only)"])
    expect(button("Pick integration minimum")).toBeDisabled()
    fireEvent.click(button("Area sequence"))
    expect(plot().view).toBe("area")
    expect(plot().labels).toEqual({ other: "Other scan", standard: "STANDARD foil", data: "DATA foil" })
    expect(api).toHaveBeenCalledTimes(1)
    api.mockResolvedValueOnce(differenceSaved(project, response))
    fireEvent.click(button("Save difference groups"))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.mock.calls[1][1]).toEqual(api.mock.calls[0][1])
  })

  it("does not request empty, self-standard, unmarked or χ inputs", () => {
    const project = differenceProject()
    project.groups[2].data_type = "chi"
    project.groups.forEach(group => { group.marked = false })
    setup(project)
    select("STANDARD", "data")
    expect(button("Preview difference")).toBeDisabled()
    select("STANDARD", "standard"); select("DATA targets", "marked")
    expect(button("Preview difference")).toBeDisabled()
    select("DATA targets", "current"); select("Current DATA", "other")
    expect(button("Preview difference")).toBeDisabled()
    expect(within(screen.getByRole("combobox", { name: "STANDARD" })).queryByRole("option", { name: "Other scan" })).not.toBeInTheDocument()
    fireEvent.click(button("Preview difference"))
    expect(api).not.toHaveBeenCalled()
  })

  it("validates numeric fields and naming, and clears area view when integration is disabled", async () => {
    setup(); select("STANDARD", "standard")
    for (const value of ["", "Infinity"]) {
      number(/^STANDARD multiplier$/, value); fireEvent.click(button("Preview difference"))
      expect(screen.getByRole("alert")).toHaveTextContent("finite standard multiplier")
    }
    number(/^STANDARD multiplier$/, -2)
    number(/^Integration minimum/, 40); fireEvent.click(button("Preview difference"))
    expect(screen.getByRole("alert")).toHaveTextContent("minimum below the maximum")
    number(/^Integration minimum/, -20)
    fireEvent.change(screen.getByRole("textbox", { name: "Name template" }), { target: { value: "x".repeat(201) } })
    fireEvent.click(button("Preview difference"))
    expect(screen.getByRole("alert")).toHaveTextContent("1–200")
    expect(api).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("textbox", { name: "Name template" }), { target: { value: "diff %d - %s" } })
    await preview(differencePreview(undefined, undefined, { multiplier: -2 }))
    fireEvent.click(button("Area sequence"))
    fireEvent.click(screen.getByRole("checkbox", { name: "Integrate difference" }))
    expect(button("E preview")).toHaveAttribute("aria-pressed", "true")
    expect(button("Area sequence")).toBeDisabled()
    expect(screen.getByRole("spinbutton", { name: /^Integration minimum/ })).toBeDisabled()
    expect(button("Pick integration minimum")).toBeDisabled()
    await preview(differencePreview(undefined, undefined, { multiplier: -2, integrate: false }))
    expect(screen.getByRole("table")).toHaveTextContent("Not integrated")
  })

  it("recovers from preview failure without exposing a previous successful result", async () => {
    setup(); select("STANDARD", "standard")
    await preview()
    number(/^STANDARD multiplier$/, 2)
    expect(screen.queryByTestId("difference-plot")).not.toBeInTheDocument()
    api.mockRejectedValueOnce(new Error("Cannot integrate DATA foil over this range"))
    fireEvent.click(button("Preview difference"))
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot integrate DATA foil")
    expect(button("Save difference groups")).toBeDisabled()
    await preview(differencePreview(undefined, undefined, { multiplier: 2 }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(api.mock.calls[2]).toEqual(api.mock.calls[1])
  })

  it.each(["success", "failure"] as const)("ignores stale preview %s after options change and another preview finishes", async outcome => {
    setup(); select("STANDARD", "standard")
    const old = deferred<DifferencePreview>()
    api.mockReturnValueOnce(old.promise); fireEvent.click(button("Preview difference"))
    number(/^STANDARD multiplier$/, 2)
    const fresh = await preview(differencePreview(undefined, undefined, { multiplier: 2 }))
    await act(async () => { if (outcome === "success") old.resolve(differencePreview()); else old.reject(new Error("Obsolete error")) })
    expect(plot().preview).toEqual(fresh)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(button("Save difference groups")).toBeEnabled()
  })

  it.each(["target", "standard", "version", "marks"] as const)("hides a preview and blocks save after a %s change", async change => {
    const { project, changeProject } = setup()
    select("STANDARD", "standard")
    if (change === "marks") select("DATA targets", "marked")
    await preview(differencePreview(project, change === "marks" ? ["data", "other"] : ["data"]))
    if (change === "target") select("Current DATA", "other")
    if (change === "standard") select("STANDARD", "other")
    if (change === "version") changeProject({ ...project, version: 8 })
    if (change === "marks") changeProject({ ...project, groups: project.groups.map(group => ({ ...group, marked: group.id === "other" })) })
    expect(screen.queryByTestId("difference-plot")).not.toBeInTheDocument()
    expect(button("Save difference groups")).toBeDisabled()
    fireEvent.click(button("Save difference groups"))
    expect(api).toHaveBeenCalledTimes(1)
  })

  it.each(Object.keys(differenceOptions) as (keyof DifferenceOptions)[])("rejects mismatched resolved %s rather than saving a mislabeled preview", async key => {
    setup(); select("STANDARD", "standard")
    const response = differencePreview()
    const original = response.options[key]
    Object.assign(response.options, { [key]: typeof original === "boolean" ? !original : typeof original === "number" ? original + 1 : "wrong" })
    api.mockResolvedValueOnce(response); fireEvent.click(button("Preview difference"))
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match")
    expect(button("Save difference groups")).toBeDisabled()
    expect(screen.queryByTestId("difference-plot")).not.toBeInTheDocument()
  })

  it("rejects mismatched target results and an obsolete response version", async () => {
    setup(); select("STANDARD", "standard")
    for (const response of [differencePreview(undefined, ["other"]), { ...differencePreview(), version: 6 }]) {
      api.mockResolvedValueOnce(response); fireEvent.click(button("Preview difference"))
      await screen.findByRole("alert")
      expect(button("Save difference groups")).toBeDisabled()
    }
  })

  it("locks save/dismissal, preserves a good preview on a reversible failure, and retries the exact snapshot", async () => {
    const { project, close, onSaved } = setup()
    select("STANDARD", "standard")
    const response = await preview()
    const pending = deferred<AthenaProject>()
    api.mockReturnValueOnce(pending.promise); fireEvent.click(button("Save difference groups"))
    expect(screen.getByRole("combobox", { name: "Current DATA" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "STANDARD" })).toBeDisabled()
    expect(button("Cancel")).toBeDisabled()
    expect(button("k preview")).toBeDisabled()
    fireEvent.click(button("Close dialog"))
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }))
    expect(close).not.toHaveBeenCalled()
    await act(async () => pending.reject(new Error("Temporary save failure")))
    expect(screen.getByRole("alert")).toHaveTextContent("Temporary save failure")
    expect(onSaved).not.toHaveBeenCalled()
    expect(button("Save difference groups")).toBeEnabled()
    api.mockResolvedValueOnce(differenceSaved(project, response)); fireEvent.click(button("Save difference groups"))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.mock.calls[2]).toEqual(api.mock.calls[1])
  })

  it("invalidates the preview on a stale-version save conflict and requires a fresh project preview", async () => {
    const { project, onSaved, changeProject } = setup()
    select("STANDARD", "standard"); await preview()
    api.mockRejectedValueOnce(new ApiRequestError({ code: "stale_version", message: "Project revision changed", fields: [], recovery: "Reload" }, 409))
    fireEvent.click(button("Save difference groups"))
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload the project")
    expect(button("Save difference groups")).toBeDisabled()
    expect(onSaved).not.toHaveBeenCalled()
    const next = { ...project, version: 8 }
    changeProject(next)
    await preview(differencePreview(next))
    expect(api.mock.calls.at(-1)?.[1]).toEqual({ version: 8, action: "difference", group_ids: ["data"], options: differenceOptions })
  })

  it("consults the live project getter before saving and never overwrites a project changed during save", async () => {
    const { project, changeProject, onSaved } = setup()
    select("STANDARD", "standard"); await preview()
    changeProject({ ...project, version: 8 }, false)
    fireEvent.click(button("Save difference groups"))
    expect(screen.getByRole("alert")).toHaveTextContent("project changed after this preview")
    expect(api).toHaveBeenCalledTimes(1)
    const next = { ...project, version: 8 }
    changeProject(next); const response = await preview(differencePreview(next))
    const pending = deferred<AthenaProject>()
    api.mockReturnValueOnce(pending.promise); fireEvent.click(button("Save difference groups"))
    changeProject({ ...next, id: "another-project" }, false)
    await act(async () => pending.resolve(differenceSaved(next, response)))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("workspace changed while saving")
    expect(button("Save difference groups")).toBeDisabled()
  })

  it("picks absolute energy relative to the returned E₀ without recalculation and rejects old/nonfinite callbacks", async () => {
    setup(); select("STANDARD", "standard"); await preview()
    fireEvent.click(button("Pick integration minimum"))
    const oldPick = plot().onPick
    expect(plot().picking).toBe(true)
    act(() => oldPick(Infinity))
    expect(screen.getByRole("spinbutton", { name: /^Integration minimum/ })).toHaveValue(-20)
    fireEvent.click(button("Click plotted energy 8984.5"))
    expect(screen.getByRole("spinbutton", { name: /^Integration minimum/ })).toHaveValue(5.5)
    expect(button("Save difference groups")).toBeDisabled()
    expect(api).toHaveBeenCalledTimes(1)
    await preview(differencePreview(undefined, undefined, { xmin: 5.5 }))
    fireEvent.click(button("Pick integration minimum"))
    act(() => oldPick(8900))
    expect(screen.getByRole("spinbutton", { name: /^Integration minimum/ })).toHaveValue(5.5)
    const newPick = plot().onPick
    fireEvent.click(button("Area sequence"))
    act(() => newPick(8900))
    expect(screen.getByRole("spinbutton", { name: /^Integration minimum/ })).toHaveValue(5.5)
    expect(button("Pick integration minimum")).toBeDisabled()
    fireEvent.click(button("E preview")); fireEvent.click(button("Pick integration maximum"))
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }))
    expect(screen.queryByRole("button", { name: "Cancel pick" })).not.toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeVisible()
    number(/^Integration maximum/, 35)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it("clears picking across DATA changes and restricts it to current E previews with effective E₀", async () => {
    setup(); select("STANDARD", "standard"); await preview()
    fireEvent.click(button("Pick integration maximum")); const stale = plot().onPick
    select("Current DATA", "other")
    act(() => stale(9100))
    expect(screen.getByRole("spinbutton", { name: /^Integration maximum/ })).toHaveValue(30)
    const response = differencePreview(undefined, ["other"]); response.results[0].e0 = null
    await preview(response)
    expect(button("Pick integration maximum")).toBeDisabled()
  })

  it("requests ephemeral k processing, renders extrapolation/k errors and saves the energy difference", async () => {
    const { project, onSaved } = setup()
    select("STANDARD", "standard"); fireEvent.click(button("k preview"))
    const response = differencePreview(project, ["data"], { plot_space: "k" })
    Object.assign(response.results[0], { k: [], weighted_chi: [], kweight: null, k_error: "Insufficient EXAFS range", extrapolated_points: 2, warnings: ["2 points linearly extrapolated outside DATA coverage"] })
    await preview(response)
    expect(plot().view).toBe("k")
    expect(button("Pick integration minimum")).toBeDisabled()
    expect(screen.getByText(/2 points linearly extrapolated/)).toBeVisible()
    expect(screen.getByText(/Insufficient EXAFS range/)).toHaveTextContent("energy difference can still be saved")
    expect(screen.getByRole("table")).toHaveTextContent("-0.2500000")
    api.mockResolvedValueOnce(differenceSaved(project, response)); fireEvent.click(button("Save difference groups"))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(api.mock.calls[1][1]).toEqual(api.mock.calls[0][1])
  })

  it("accepts input k curves and recoverable input errors, retains energy data and applies the overlay checkbox to both spaces", async () => {
    const { project, onSaved } = setup()
    select("STANDARD", "standard"); fireEvent.click(button("k preview"))
    const response = differencePreview(project, ["data"], { plot_space: "k" })
    response.results[0].input_k = differenceInputs()
    Object.assign(response.results[0].input_k[1], { k: [], weighted_chi: [], kweight: null, error: "STANDARD has no processed EXAFS" })
    await preview(response)
    expect(screen.getByRole("checkbox", { name: "Plot DATA and STANDARD" })).toBeChecked()
    expect(plot().preview.results[0].input_k).toEqual(response.results[0].input_k)
    expect(screen.getByText(/STANDARD has no processed EXAFS/)).toHaveTextContent("energy difference can still be saved")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(button("Download energy CSV")).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Download preview CSV" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Plot DATA and STANDARD" }))
    expect(button("Save difference groups")).toBeDisabled()
    const hidden = { ...response, options: { ...response.options, plot_inputs: false } }
    await preview(hidden)
    expect(api.mock.calls[1][1]).toEqual({ version: 7, action: "difference", group_ids: ["data"], options: hidden.options })
    expect(plot().preview.options.plot_inputs).toBe(false)
    const saved = differenceSaved(project, hidden)
    api.mockResolvedValueOnce(saved); fireEvent.click(button("Save difference groups"))
    await waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved))
  })

  it("accepts empty E input curves and reports a shared failed k STANDARD once across marked results", async () => {
    setup(); select("STANDARD", "standard")
    const energy = differencePreview(); energy.results[0].input_k = []
    await preview(energy)
    fireEvent.click(button("k preview")); select("DATA targets", "marked")
    const response = differencePreview(undefined, ["data", "other"], { plot_space: "k" })
    for (const result of response.results) {
      result.input_k = differenceInputs(result.group_id)
      Object.assign(result.input_k[1], { k: [], weighted_chi: [], kweight: null, error: "No STANDARD k grid" })
    }
    await preview(response)
    expect(screen.getAllByText(/No STANDARD k grid/)).toHaveLength(1)
    expect(button("Save difference groups")).toBeEnabled()
  })

  it.each(["role", "data-id", "standard-id", "duplicate-role", "array-length", "nonfinite", "weight", "label", "error", "E-space-mixing"] as const)("rejects invalid input k %s without exposing or saving mixed preview data", async kind => {
    setup(); select("STANDARD", "standard")
    if (kind !== "E-space-mixing") fireEvent.click(button("k preview"))
    const response = differencePreview(undefined, undefined, { plot_space: kind === "E-space-mixing" ? "E" : "k" })
    const inputs = differenceInputs()
    response.results[0].input_k = inputs
    if (kind === "role") Object.assign(inputs[0], { role: "DIFFERENCE" })
    if (kind === "data-id") inputs[0].group_id = "other"
    if (kind === "standard-id") inputs[1].group_id = "other"
    if (kind === "duplicate-role") inputs[1] = { ...inputs[0] }
    if (kind === "array-length") inputs[1].weighted_chi = [1]
    if (kind === "nonfinite") inputs[0].k[0] = Infinity
    if (kind === "weight") Object.assign(inputs[0], { kweight: "2" })
    if (kind === "label") Object.assign(inputs[0], { label: 12 })
    if (kind === "error") Object.assign(inputs[0], { error: false })
    api.mockResolvedValueOnce(response); fireEvent.click(button("Preview difference"))
    expect(await screen.findByRole("alert")).toHaveTextContent("incomplete or mismatched spectra")
    expect(screen.queryByTestId("difference-plot")).not.toBeInTheDocument()
    expect(button("Save difference groups")).toBeDisabled()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it.each(["backend", "unrelated", "none"] as const)("shows one integration nonconvergence notice with %s warnings", async warningKind => {
    setup(); select("STANDARD", "standard")
    const response = differencePreview()
    response.results[0].integration!.converged = false
    response.results[0].integration!.iterations = 6
    const backendWarning = "Difference integration did not converge within six Romberg refinements at absolute tolerance 1e-5; the last finite estimate is returned. Inspect the curve and integration interval."
    response.results[0].warnings = warningKind === "backend" ? [backendWarning] : warningKind === "unrelated" ? ["2 points linearly extrapolated outside DATA coverage"] : []
    await preview(response)
    const notices = screen.getAllByText(/did not converge/i)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toHaveTextContent(warningKind === "backend" ? backendWarning : "integration did not converge after 6 iterations")
    if (warningKind === "unrelated") expect(screen.getByText(/2 points linearly extrapolated/)).toBeVisible()
    expect(button("Save difference groups")).toBeEnabled()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it("downloads preview reports with server arrays, areas, options and safe CSV quoting", async () => {
    const blobs: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return "blob:preview" })
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    setup(); select("STANDARD", "standard")
    const response = differencePreview(); response.results[0].label = 'diff "foil", one\nminus standard'
    await preview(response)
    fireEvent.click(button("Download preview JSON")); fireEvent.click(button("Download energy CSV"))
    const read = (blob: Blob) => new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob) })
    expect(JSON.parse(await read(blobs[0]))).toEqual({ project_id: "difference-project", group_ids: ["data"], ...response })
    expect(await read(blobs[1])).toContain('"diff ""foil"", one\nminus standard"')
    expect(await read(blobs[1])).toContain("8950,0.2,0.5,0.3,-0.25,8979")
    expect(click.mock.instances.map(link => (link as HTMLAnchorElement).download)).toEqual(["athena-difference-preview.json", "athena-difference-preview.csv"])
    expect(api).toHaveBeenCalledTimes(1)
  })
})
