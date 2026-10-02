import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { ApiRequestError } from "@/lib/backend-client"
import { buildReportFormData, validateSubmission, type BugReportSubmission } from "@/lib/bug-report"
import { ReportBugDialog } from "./report-bug-dialog"

const originalShowModal = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", "") } })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open") } })
})

afterAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: originalShowModal })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: originalClose })
})

afterEach(() => {
  window.localStorage.clear()
})

const projectState = {
  schema_version: 1 as const, mode: "legacy", active_group_id: "foil", modal: null, busy: "", message: "Ready", error: "",
  project: { id: "cu", name: "Copper", version: 4, groups: [{ id: "foil", label: "Cu foil", data_type: "mu", marked: true, frozen: false, reference_id: null, processing_error: null, derived: false }] },
}

function renderDialog(overrides: Partial<Parameters<typeof ReportBugDialog>[0]> = {}) {
  const submit = vi.fn().mockResolvedValue({ status: "success", report_id: "bug_20261002_101500_abcdef12", type: "bug", stored_locally: true, project_export_attached: true, message: "Bug bug_20261002_101500_abcdef12 saved." })
  const onClose = vi.fn()
  const onSubmitted = vi.fn()
  render(<ReportBugDialog projectId="cu" projectState={projectState} onClose={onClose} onSubmitted={onSubmitted} submit={submit} {...overrides} />)
  return { submit, onClose, onSubmitted }
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe("ReportBugDialog", () => {
  it("validates before sending and reports field problems", () => {
    const { submit } = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Send report" }))
    expect(screen.getByText("Describe what happened or what you would like.").getAttribute("role")).toBe("alert")
    expect(screen.getByText("Enter an email address so we can follow up.").getAttribute("role")).toBe("alert")
    expect(submit).not.toHaveBeenCalled()
  })

  it("submits the chosen type, files and project attachment, then closes with the saved message", async () => {
    const { submit, onClose, onSubmitted } = renderDialog()
    fireEvent.click(screen.getByRole("radio", { name: "Feature request" }))
    fill(/Description/, "Add a k-weight preset.")
    fill(/Your email/, "ana@example.org")
    const picker = screen.getByLabelText("Choose screenshots or files")
    fireEvent.change(picker, { target: { files: [new File(["png"], "plot.png", { type: "image/png" }), new File(["x,y"], "data.csv", { type: "text/csv" })] } })
    const list = screen.getByRole("list", { name: "Attached files" })
    expect(list.textContent).toContain("plot.png")
    expect(list.textContent).toContain("data.csv")
    fireEvent.click(screen.getByRole("button", { name: "Send report" }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const submission = submit.mock.calls[0][0] as BugReportSubmission
    expect(submission.type).toBe("feature_request")
    expect(submission.description).toBe("Add a k-weight preset.")
    expect(submission.userEmail).toBe("ana@example.org")
    expect(submission.screenshots.map(file => file.name)).toEqual(["plot.png"])
    expect(submission.attachments.map(file => file.name)).toEqual(["data.csv"])
    expect(submission.attachProject).toBe(true)
    expect(submission.projectId).toBe("cu")
    expect(submission.projectState?.project?.groups[0].label).toBe("Cu foil")
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith("Bug bug_20261002_101500_abcdef12 saved."))
    expect(onClose).toHaveBeenCalled()
  })

  it("attaches pasted images as screenshots and lets the reporter remove them", async () => {
    renderDialog()
    const image = new File(["png"], "image.png", { type: "image/png" })
    fireEvent.paste(screen.getByLabelText(/Description/), { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => image }], getData: () => "" } })
    const list = await screen.findByRole("list", { name: "Attached files" })
    expect(list.textContent).toMatch(/pasted-.*\.png/)
    fireEvent.click(screen.getByRole("button", { name: /Remove pasted-/ }))
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull()
  })

  it("hides the project checkbox without a project and remembers the email", async () => {
    window.localStorage.setItem("xraylarch-web.report-email", "remembered@example.org")
    renderDialog({ projectId: null, projectState: null })
    expect(screen.queryByLabelText("Attach a copy of the current project")).toBeNull()
    await waitFor(() => expect((screen.getByLabelText(/Your email/) as HTMLInputElement).value).toBe("remembered@example.org"))
  })

  it("maps backend field errors onto the form and keeps the dialog open", async () => {
    const submit = vi.fn().mockRejectedValue(new ApiRequestError({ code: "bug_report_invalid", message: "Enter a valid email address.", fields: ["user_email"], recovery: "Review the report and retry." }, 400))
    const { onClose } = renderDialog({ submit })
    fill(/Description/, "Broken")
    fill(/Your email/, "ana@example.org")
    fireEvent.click(screen.getByRole("button", { name: "Send report" }))
    expect((await screen.findByText("Enter a valid email address.")).getAttribute("role")).toBe("alert")
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByRole("button", { name: "Send report" }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe("bug report form data", () => {
  it("mirrors the backend limits", () => {
    const base: BugReportSubmission = { type: "bug", description: "x", userEmail: "ana@example.org", screenshots: [], attachments: [], projectId: null, attachProject: false, projectState: null }
    expect(validateSubmission(base)).toEqual({})
    expect(validateSubmission({ ...base, userEmail: "nope" })).toHaveProperty("user_email")
    expect(validateSubmission({ ...base, screenshots: Array.from({ length: 6 }, (_, i) => new File(["p"], `${i}.png`, { type: "image/png" })) })).toHaveProperty("screenshots")
  })

  it("serialises every field the backend reads", () => {
    const form = buildReportFormData({
      type: "feedback", description: "  Nice  ", userEmail: " ana@example.org ", projectId: "cu", attachProject: true, projectState,
      screenshots: [new File(["p"], "shot.png", { type: "image/png" })], attachments: [new File(["d"], "log.txt", { type: "text/plain" })],
    }, '{"schema_version":1}')
    expect(form.get("type")).toBe("feedback")
    expect(form.get("description")).toBe("Nice")
    expect(form.get("user_email")).toBe("ana@example.org")
    expect(form.get("project_id")).toBe("cu")
    expect(form.get("attach_project")).toBe("true")
    expect(JSON.parse(String(form.get("project_state"))).project.id).toBe("cu")
    expect(form.get("client_metadata")).toBe('{"schema_version":1}')
    expect((form.getAll("screenshots") as File[]).map(file => file.name)).toEqual(["shot.png"])
    expect((form.getAll("attachments") as File[]).map(file => file.name)).toEqual(["log.txt"])
  })
})
