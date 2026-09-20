import type { AthenaGroup, AthenaProject } from "./athena"

/** Only these commands guarantee that all scientific data remain unchanged. */
export function isSelectionCommand(action: string, options: Record<string, unknown>) {
  if (action === "selection") return true
  const keys = Object.keys(options)
  return action === "metadata" && keys.length > 0 &&
    keys.every(key => (key === "marked" || key === "frozen") && typeof options[key] === "boolean")
}

export interface AthenaSelectionUpdate {
  kind: "selection"
  id: string
  name: string
  base_version: number
  version: number
  updated: string
  groups: Pick<AthenaGroup, "id" | "marked" | "frozen">[]
  undo: AthenaProject["undo"]
  redo: AthenaProject["redo"]
  history: AthenaProject["history"]
  group_versions: NonNullable<AthenaProject["group_versions"]>
  last_operation: AthenaProject["last_operation"]
  analyses: NonNullable<AthenaProject["analyses"]>
}

/** Apply an acknowledged flag change without replacing any spectral arrays. */
export function mergeSelectionUpdate(project: AthenaProject, update: AthenaSelectionUpdate): AthenaProject {
  const invalid = () => { throw new Error("The selection response does not match this project. Reload the project before editing.") }
  if (update.kind !== "selection" || update.id !== project.id || update.base_version !== project.version ||
    update.version !== project.version + 1 || typeof update.updated !== "string" || typeof update.name !== "string" ||
    !Array.isArray(update.analyses) ||
    !Array.isArray(update.groups) || update.groups.length !== project.groups.length ||
    !Array.isArray(update.undo) || !update.undo.every(item => typeof item === "string") ||
    !Array.isArray(update.redo) || !update.redo.every(item => typeof item === "string") ||
    !Array.isArray(update.history) || !update.history.every(item => item && typeof item.time === "string" && typeof item.message === "string") ||
    !update.group_versions || typeof update.group_versions !== "object") return invalid()
  const groups = project.groups.map((group, index) => {
    const flags = update.groups[index]
    const revision = update.group_versions[group.id]
    if (!flags || flags.id !== group.id || typeof flags.marked !== "boolean" || typeof flags.frozen !== "boolean" ||
      !Number.isInteger(revision) || revision < 0 || revision > update.version) return invalid()
    return flags.marked === group.marked && flags.frozen === group.frozen
      ? group : { ...group, marked: flags.marked, frozen: flags.frozen }
  })
  return { ...project, name: update.name, analyses: update.analyses, version: update.version, updated: update.updated, groups,
    undo: update.undo, redo: update.redo, history: update.history,
    group_versions: update.group_versions, last_operation: update.last_operation }
}
