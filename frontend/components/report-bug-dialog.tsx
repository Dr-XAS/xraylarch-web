"use client"

import { useEffect, useId, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react"
import { Bug, Lightbulb, MessageSquare, Paperclip, X } from "lucide-react"

import { ApiRequestError } from "@/lib/backend-client"
import { SectionHelp } from "./section-help"
import {
  MAX_ATTACHMENTS, MAX_SCREENSHOTS, REPORT_TYPES, REPORT_TYPE_LABELS,
  rememberedEmail, submitBugReport, validateSubmission,
  type BugReportSubmission, type ReportProjectState, type ReportType,
} from "@/lib/bug-report"

type FieldErrors = Partial<Record<"description" | "user_email" | "screenshots" | "attachments", string>>

const TYPE_ICONS: Record<ReportType, typeof Bug> = { bug: Bug, feature_request: Lightbulb, feedback: MessageSquare }
const TYPE_PROMPTS: Record<ReportType, string> = {
  bug: "What were you doing, what happened, and what did you expect instead?",
  feature_request: "What would you like to be able to do, and why?",
  feedback: "Tell us what works, what does not, or anything else.",
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function pastedImageName(file: File, index: number): string {
  if (file.name && file.name !== "image.png" && file.name !== "blob") return file.name
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png"
  return `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}-${index + 1}.${extension}`
}

export function ReportBugDialog({ projectId, projectState, onClose, onSubmitted, submit = submitBugReport }: {
  projectId: string | null
  projectState: ReportProjectState | null
  onClose: () => void
  onSubmitted: (message: string) => void
  submit?: typeof submitBugReport
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const [type, setType] = useState<ReportType>("bug")
  const [description, setDescription] = useState("")
  const [email, setEmail] = useState("")
  const [screenshots, setScreenshots] = useState<File[]>([])
  const [attachments, setAttachments] = useState<File[]>([])
  const [attachProject, setAttachProject] = useState(!!projectId)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState("")
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close() }, [])
  useEffect(() => { setEmail(rememberedEmail()) }, [])

  function addFiles(files: Iterable<File>, nameFor: (file: File, index: number) => string = file => file.name) {
    const incoming = Array.from(files)
    const images = incoming.filter(file => file.type.startsWith("image/"))
    const others = incoming.filter(file => !file.type.startsWith("image/"))
    const next: FieldErrors = {}
    setScreenshots(current => {
      const known = new Set(current.map(fileKey))
      const added = images
        .map((file, index) => nameFor(file, index) === file.name ? file : new File([file], nameFor(file, index), { type: file.type, lastModified: file.lastModified }))
        .filter(file => !known.has(fileKey(file)))
      const merged = [...current, ...added]
      if (merged.length > MAX_SCREENSHOTS) next.screenshots = `Attach at most ${MAX_SCREENSHOTS} screenshots.`
      return merged.slice(0, MAX_SCREENSHOTS)
    })
    setAttachments(current => {
      const known = new Set(current.map(fileKey))
      const merged = [...current, ...others.filter(file => !known.has(fileKey(file)))]
      if (merged.length > MAX_ATTACHMENTS) next.attachments = `Attach at most ${MAX_ATTACHMENTS} files.`
      return merged.slice(0, MAX_ATTACHMENTS)
    })
    setErrors(current => ({ ...current, screenshots: next.screenshots, attachments: next.attachments }))
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file)
    if (!files.length) return
    event.preventDefault()
    addFiles(files, pastedImageName)
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files?.length) addFiles(event.target.files)
    event.target.value = ""
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragging(false)
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files)
  }

  async function send() {
    if (sending) return
    const submission: BugReportSubmission = {
      type, description, userEmail: email, screenshots, attachments, projectId,
      attachProject: attachProject && !!projectId, projectState,
    }
    const problems = validateSubmission(submission)
    setErrors(problems)
    setSubmitError("")
    if (Object.keys(problems).length) return
    setSending(true)
    try {
      const result = await submit(submission)
      onSubmitted(result.message || `${REPORT_TYPE_LABELS[result.type] ?? "Report"} ${result.report_id} saved.`)
      onClose()
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const fielded: FieldErrors = {}
        for (const field of error.fields) {
          if (field === "description" || field === "user_email" || field === "screenshots" || field === "attachments") fielded[field] = error.message
        }
        setErrors(fielded)
        setSubmitError(Object.keys(fielded).length ? "" : `${error.message} ${error.recovery}`.trim())
      } else {
        setSubmitError("The report could not be sent. Check the connection and try again.")
      }
    } finally {
      setSending(false)
    }
  }

  const title = "Report a bug or send feedback"
  const files = [...screenshots.map(file => ({ file, kind: "screenshot" as const })), ...attachments.map(file => ({ file, kind: "attachment" as const }))]

  return (
    <dialog className="ath-modal ath-report" ref={ref} onCancel={event => { event.preventDefault(); if (!sending) onClose() }} aria-label={title}>
      <header><h2>{title}</h2><button type="button" onClick={onClose} disabled={sending} aria-label="Close dialog"><X size={18} /></button></header>
      <form className="ath-modal-body" onSubmit={event => { event.preventDefault(); void send() }} noValidate>
        <div className="ath-report-types" role="radiogroup" aria-label="Report type">
          {REPORT_TYPES.map(option => {
            const Icon = TYPE_ICONS[option]
            return <button key={option} type="button" role="radio" aria-checked={type === option} className={type === option ? "selected" : ""} onClick={() => setType(option)} disabled={sending}><Icon size={15} />{REPORT_TYPE_LABELS[option]}</button>
          })}
        </div>
        <label className="ath-field" htmlFor={`${id}-description`}>
          <span>Description<SectionHelp label="Report description">Describe the steps, what happened, and the result you expected. For a feature request, explain what you want to accomplish.</SectionHelp><small>Paste images here to attach them</small></span>
          <textarea id={`${id}-description`} rows={6} value={description} placeholder={TYPE_PROMPTS[type]} onChange={event => setDescription(event.target.value)} onPaste={onPaste} disabled={sending} aria-invalid={!!errors.description} aria-describedby={errors.description ? `${id}-description-error` : undefined} />
        </label>
        {errors.description && <p className="ath-report-error" id={`${id}-description-error`} role="alert">{errors.description}</p>}

        <div className={`ath-report-drop${dragging ? " dragging" : ""}`} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={sending}><Paperclip size={15} />Add screenshots or files</button>
          <span className="ath-hint">Drop files here. Images become screenshots (up to {MAX_SCREENSHOTS}, 5 MiB each); other files are attached as-is (up to {MAX_ATTACHMENTS}, 25 MiB each).</span>
          <input ref={fileInput} type="file" multiple className="ath-sr-only" aria-label="Choose screenshots or files" onChange={onPick} tabIndex={-1} />
        </div>
        {files.length > 0 && <ul className="ath-report-files" aria-label="Attached files">
          {files.map(({ file, kind }) => <li key={`${kind}:${fileKey(file)}`}><span>{kind === "screenshot" ? "🖼" : "📎"} {file.name} <small>{formatSize(file.size)}</small></span><button type="button" aria-label={`Remove ${file.name}`} disabled={sending} onClick={() => (kind === "screenshot" ? setScreenshots : setAttachments)(current => current.filter(item => fileKey(item) !== fileKey(file)))}><X size={13} /></button></li>)}
        </ul>}
        {errors.screenshots && <p className="ath-report-error" role="alert">{errors.screenshots}</p>}
        {errors.attachments && <p className="ath-report-error" role="alert">{errors.attachments}</p>}

        <label className="ath-field" htmlFor={`${id}-email`}>
          <span>Your email<SectionHelp label="Report email">Contact address saved with this report so the team can follow up. It is remembered in this browser for future reports.</SectionHelp><small>Required, so we can follow up</small></span>
          <input id={`${id}-email`} type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} disabled={sending} aria-invalid={!!errors.user_email} aria-describedby={errors.user_email ? `${id}-email-error` : undefined} />
        </label>
        {errors.user_email && <p className="ath-report-error" id={`${id}-email-error`} role="alert">{errors.user_email}</p>}

        {projectId && <label className="ath-check"><input type="checkbox" checked={attachProject} disabled={sending} onChange={event => setAttachProject(event.target.checked)} />Attach a copy of the current project<SectionHelp label="Attach project">Include the current project’s spectra and processing state so the issue can be reproduced. Turn this off to send the report without that project export.</SectionHelp></label>}
        <p className="ath-hint">The report also records this page, your browser and screen, the app build, a summary of the open project and its recent journal, and this site&apos;s browser storage. It is saved on this server only{projectId ? "" : "; no project is open to attach"}.</p>

        {submitError && <p className="ath-report-error" role="alert">{submitError}</p>}
        <div className="ath-modal-actions">
          <button type="button" onClick={onClose} disabled={sending}>Cancel</button>
          <button type="submit" className="ath-primary" disabled={sending}>{sending ? "Sending…" : "Send report"}</button>
        </div>
      </form>
    </dialog>
  )
}
