/**
 * Submit a bug report, feature request or feedback to the local bug library.
 *
 * The backend writes one folder per report under its data root; nothing
 * leaves the deployment unless the operator wires up Slack. The transport is
 * plain `fetch` through the Next proxy because the Athena session transport
 * only admits `/api/athena/` paths.
 */

import { backendUrl } from "@/lib/app-url"
import { ApiRequestError, decodeApiError } from "@/lib/backend-client"
import { collectClientMetadata, serializeClientMetadataWithinLimit } from "@/lib/client-diagnostics"

export const REPORT_TYPES = ["bug", "feature_request", "feedback"] as const
export type ReportType = (typeof REPORT_TYPES)[number]

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  bug: "Bug",
  feature_request: "Feature request",
  feedback: "Feedback",
}

export const MAX_DESCRIPTION_BYTES = 64 * 1024
export const MAX_SCREENSHOTS = 5
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const EMAIL_STORAGE_KEY = "xraylarch-web.report-email"
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ReportGroupState = {
  id: string
  label: string
  data_type: string
  marked: boolean
  frozen: boolean
  reference_id: string | null
  processing_error: string | null
  derived: boolean
}

/** What the workbench knows at the moment of the report. No arrays of data. */
export type ReportProjectState = {
  schema_version: 1
  mode: string
  project: { id: string; name: string; version: number; groups: ReportGroupState[] } | null
  active_group_id: string | null
  modal: string | null
  busy: string
  message: string
  error: string
}

export type BugReportSubmission = {
  type: ReportType
  description: string
  userEmail: string
  screenshots: File[]
  attachments: File[]
  projectId: string | null
  attachProject: boolean
  projectState: ReportProjectState | null
}

export type BugReportResponse = {
  status: "success"
  report_id: string
  type: ReportType
  stored_locally: boolean
  project_export_attached: boolean
  message: string
}

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim())
}

export function rememberedEmail(): string {
  try {
    return window.localStorage.getItem(EMAIL_STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

export function rememberEmail(value: string): void {
  try {
    window.localStorage.setItem(EMAIL_STORAGE_KEY, value.trim())
  } catch {
    // Storage may be blocked; the address is still on the report.
  }
}

/** Client-side mirror of the backend limits so the dialog can explain before uploading. */
export function validateSubmission(submission: BugReportSubmission): Partial<Record<"description" | "user_email" | "screenshots" | "attachments", string>> {
  const errors: Partial<Record<"description" | "user_email" | "screenshots" | "attachments", string>> = {}
  const description = submission.description.trim()
  if (!description) errors.description = "Describe what happened or what you would like."
  else if (new TextEncoder().encode(description).byteLength > MAX_DESCRIPTION_BYTES) errors.description = "The description is longer than 64 KiB. Attach long logs as a file instead."
  if (!isValidEmail(submission.userEmail)) errors.user_email = "Enter an email address so we can follow up."
  if (submission.screenshots.length > MAX_SCREENSHOTS) errors.screenshots = `Attach at most ${MAX_SCREENSHOTS} screenshots.`
  else if (submission.screenshots.some(file => file.size > MAX_SCREENSHOT_BYTES)) errors.screenshots = "Each screenshot must be 5 MiB or smaller."
  if (submission.attachments.length > MAX_ATTACHMENTS) errors.attachments = `Attach at most ${MAX_ATTACHMENTS} files.`
  else if (submission.attachments.some(file => file.size > MAX_ATTACHMENT_BYTES)) errors.attachments = "Each attached file must be 25 MiB or smaller."
  return errors
}

export function buildReportFormData(submission: BugReportSubmission, clientMetadata: string | null): FormData {
  const form = new FormData()
  form.set("type", submission.type)
  form.set("description", submission.description.trim())
  form.set("user_email", submission.userEmail.trim())
  if (submission.projectId) form.set("project_id", submission.projectId)
  form.set("attach_project", submission.attachProject && submission.projectId ? "true" : "false")
  if (submission.projectState) form.set("project_state", JSON.stringify(submission.projectState))
  if (clientMetadata) form.set("client_metadata", clientMetadata)
  for (const file of submission.screenshots) form.append("screenshots", file, file.name)
  for (const file of submission.attachments) form.append("attachments", file, file.name)
  return form
}

export async function submitBugReport(submission: BugReportSubmission, fetcher: typeof fetch = fetch): Promise<BugReportResponse> {
  let clientMetadata: string | null = null
  try {
    clientMetadata = serializeClientMetadataWithinLimit(await collectClientMetadata())
  } catch {
    clientMetadata = null
  }
  const response = await fetcher(backendUrl("/api/bug-reports"), {
    method: "POST",
    body: buildReportFormData(submission, clientMetadata),
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) throw decodeApiError(response.status, body)
  if (!body || typeof body !== "object" || typeof (body as { report_id?: unknown }).report_id !== "string") {
    throw new ApiRequestError({ code: "bug_report_malformed", message: "The report was not acknowledged.", fields: [], recovery: "Try again." }, response.status)
  }
  rememberEmail(submission.userEmail)
  return body as BugReportResponse
}
