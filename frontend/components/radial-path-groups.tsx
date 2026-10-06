import type { ReactNode } from "react"
import type { ArtemisPathMetadata } from "@/lib/artemis"
import type { ArtemisStructure } from "@/lib/artemis-structures"
import { groupRadialPaths, shellColor, type RadialShell, type RadialShells } from "@/lib/radial-shells"
import { ShellSwatch } from "./feff-path-shell-label"
import styles from "./radial-path-groups.module.css"

export function RadialPathGroups<T extends { id: string; metadata: ArtemisPathMetadata }>({ paths, structure, analysis, selectedIds, blockedIds = [], disabled,
  action = "Select", onSelection, onUseOnly, renderPath }: {
  paths: T[]; structure: ArtemisStructure | null; analysis: RadialShells | null; selectedIds: string[]; blockedIds?: string[]; disabled?: boolean
  action?: "Select" | "Include"; onSelection: (ids: string[], selected: boolean) => void; onUseOnly?: (ids: string[]) => void
  renderPath: (path: T, shell?: RadialShell) => ReactNode
}) {
  const groups = groupRadialPaths(paths, structure, analysis)
  // Keep every editable path a keyed sibling even when analysis is loading or
  // shell boundaries change. Reparenting rows would discard focus and undo.
  return <div>{groups.flatMap(group => {
    const eligible = group.paths.filter(path => !blockedIds.includes(path.id)).map(path => path.id)
    const all = eligible.length > 0 && eligible.every(id => selectedIds.includes(id))
    const name = group.shell ? `shell ${group.shell.index}` : group.label.toLowerCase()
    const background = group.shell ? { backgroundColor: `${shellColor(group.shell.index)}1a` } : undefined
    return [<section key={`group-${group.key}`} className={styles.group} style={background} aria-label={`${group.label} paths`}>
      <div className={styles.header}>
        <strong>{group.shell && <ShellSwatch index={group.shell.index} />}{group.label}</strong>
        <span>{group.paths.length} path{group.paths.length === 1 ? "" : "s"}{group.shell ? ` · ${group.shell.coordination_number} structural neighbors` : ""}</span>
        <button type="button" disabled={disabled || !eligible.length} onClick={() => onSelection(eligible, !all)}>{all ? action === "Include" ? "Exclude" : "Deselect" : action} {name} paths</button>
        {onUseOnly && group.shell && <button type="button" disabled={disabled || !eligible.length} onClick={() => onUseOnly(eligible)}>Use only {name} candidates</button>}
      </div>
    </section>, ...group.paths.map((path, index) => <div key={`path-${path.id}`} className={`${styles.path} ${index === group.paths.length - 1 ? styles.lastPath : ""}`} style={background}>{renderPath(path, group.shell)}</div>)]
  })}</div>
}
