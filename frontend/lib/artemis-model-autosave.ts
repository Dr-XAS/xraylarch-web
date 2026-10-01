import type { AthenaGroup, AthenaProject } from "./athena"
import { artemisModelKey, type ArtemisModelDraft } from "./artemis"

export type ArtemisSaveStatus = "saved" | "pending" | "saving" | "failed"
type Entry = { projectId: string; groupId: string; draft: ArtemisModelDraft; base: string; persisted: boolean; dirty: boolean; error?: string }
type Options = {
  save: (projectId: string, groupId: string, version: number, model: ArtemisModelDraft) => Promise<AthenaProject>
  recover: (projectId: string, error: unknown) => Promise<AthenaProject | null>
  accept: (project: AthenaProject) => void
  changed: () => void
  delay?: number
}
const message = (error: unknown) => error instanceof Error ? error.message : "The model could not be saved. Retry saving."

/** Owns the save queue above the keyed spectrum editor, so switching spectra cannot discard work. */
export class ArtemisModelAutosave {
  private entries = new Map<string, Entry>()
  private versions = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private saving: Entry | undefined
  private paused = false
  private disposed = false
  constructor(private options: Options) {}

  observe(projectId: string, version: number, groups: AthenaGroup[], complete = true) {
    const previous = this.versions.get(projectId)
    if (previous !== undefined && version <= previous) return
    this.versions.set(projectId, version)
    for (const [key, entry] of this.entries) {
      if (entry.projectId !== projectId) continue
      const group = groups.find(item => item.id === entry.groupId)
      if (!group) { if (complete) this.entries.delete(key); continue }
      const model = group.artemis?.model
      if (!model && !entry.persisted) continue
      const saved = model ? artemisModelKey(model) : ""
      if (saved === entry.base) continue
      if (entry.dirty) {
        if (saved === artemisModelKey(entry.draft)) { entry.base = saved; entry.persisted = true; entry.dirty = false; entry.error = undefined }
        else entry.error = "This model changed elsewhere. Your edits are retained. Review them and retry saving."
      } else if (model) {
        entry.draft = model; entry.base = saved; entry.persisted = true
      } else {
        // The editor will register its empty model after Undo removes the saved model.
        this.entries.delete(key)
      }
    }
    this.options.changed()
  }

  update(projectId: string, groupId: string, draft: ArtemisModelDraft, base: ArtemisModelDraft | undefined, dirty: boolean) {
    const key = `${projectId}:${groupId}`
    const existing = this.entries.get(key)
    const draftKey = artemisModelKey(draft)
    if (existing && artemisModelKey(existing.draft) === draftKey) return
    const entry = existing ?? { projectId, groupId, draft, base: base ? artemisModelKey(base) : dirty ? "" : draftKey, persisted: !!base, dirty }
    entry.draft = draft
    if (!dirty && this.saving !== entry) { entry.base = draftKey; entry.persisted = !!base }
    entry.dirty = draftKey !== entry.base
    if (!entry.dirty) entry.error = undefined
    this.entries.set(key, entry)
    this.options.changed()
    this.schedule()
  }

  state(projectId?: string) {
    const entries = [...this.entries.values()].filter(entry => entry.projectId === projectId)
    const error = entries.find(entry => entry.dirty && entry.error)?.error
    const status: ArtemisSaveStatus = error ? "failed" : this.saving?.projectId === projectId ? "saving" : entries.some(entry => entry.dirty) ? "pending" : "saved"
    return { status, error }
  }
  dirtyGroups(projectId: string) {
    return [...this.entries.values()].filter(entry => entry.projectId === projectId).map(entry => ({ id: entry.groupId, dirty: entry.dirty }))
  }
  hasChanges(projectId: string, groupId: string) {
    const entry = this.entries.get(`${projectId}:${groupId}`)
    return !!entry && (entry.dirty || this.saving === entry)
  }
  version(projectId: string, fallback: number) { return this.versions.get(projectId) ?? fallback }
  setPaused(paused: boolean) { this.paused = paused; if (!paused) this.schedule() }

  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    if (this.disposed || this.paused || ![...this.entries.values()].some(entry => entry.dirty && !entry.error)) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain().catch(() => {}) }, this.options.delay ?? 650)
  }
  private async drain(projectId?: string): Promise<void> {
    if (this.running) { await this.running; return this.drain(projectId) }
    const work = async () => {
      while (!this.disposed) {
        const entry = [...this.entries.values()].find(item => item.dirty && !item.error && (!projectId || item.projectId === projectId))
        if (!entry || (!projectId && this.paused)) break
        const version = this.versions.get(entry.projectId)
        if (version === undefined) break
        const submitted = entry.draft
        this.saving = entry; this.options.changed()
        try {
          const project = await this.options.save(entry.projectId, entry.groupId, version, submitted)
          const saved = project.groups.find(group => group.id === entry.groupId)?.artemis?.model
          if (project.id !== entry.projectId || project.version < version || !saved) throw new Error("The saved model response is invalid. Retry saving.")
          if (project.version < (this.versions.get(project.id) ?? version)) {
            if (entry.dirty) entry.error = "This project changed while the model was saving. Your edits are retained. Review them and retry saving."
            continue
          }
          this.versions.set(project.id, project.version)
          entry.base = artemisModelKey(saved)
          entry.persisted = true
          entry.dirty = artemisModelKey(entry.draft) !== entry.base
          entry.error = undefined
          this.options.accept(project)
        } catch (error) {
          entry.error = message(error)
          try {
            const project = await this.options.recover(entry.projectId, error)
            if (project) {
              this.observe(project.id, project.version, project.groups)
              this.options.accept(project)
              entry.error = "This project changed elsewhere. Your model edits are retained. Review them and retry saving."
            }
          } catch { /* Keep the original failure and the local draft available for Retry. */ }
        } finally { this.saving = undefined; this.options.changed() }
      }
    }
    this.running = work()
    try { await this.running } finally { this.running = undefined }
  }

  async flush(projectId: string, retry = false) {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (retry) for (const entry of this.entries.values()) if (entry.projectId === projectId) entry.error = undefined
    await this.drain(projectId)
    const pending = [...this.entries.values()].find(entry => entry.projectId === projectId && entry.dirty)
    if (pending) throw new Error(pending.error ?? "Wait for the model to finish saving before continuing.")
  }
  async settle() { if (this.running) await this.running }
  activate() { this.disposed = false; this.schedule() }
  dispose() { this.disposed = true; if (this.timer) clearTimeout(this.timer) }
}
