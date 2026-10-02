import { shellColor, shellRange, type RadialShell } from "@/lib/radial-shells"
import styles from "./feff-path-shell-label.module.css"

/** The same shell colors are used by the CIF table, path groups and path labels. */
export function ShellSwatch({ index }: { index?: number }) {
  return <span className={styles.swatch} aria-hidden="true" style={index === undefined ? undefined : { background: shellColor(index) }} />
}

export function FeffPathShellLabel({ shell, nleg, hasContext, hasAnalysis, loading = false, error = "" }: {
  shell?: RadialShell; nleg: number; hasContext: boolean; hasAnalysis: boolean; loading?: boolean; error?: string
}) {
  // Multiple scattering has no single radial shell. A missing analysis must
  // never look like a completed geometry comparison that failed to match.
  const [label, title] = nleg > 2
    ? ["Multiple scattering", "Multiple-scattering paths do not belong to a single radial shell."]
    : !hasContext
      ? ["Shell unassigned", "Open an attached CIF and choose its absorber site to identify this path’s shell."]
      : loading
        ? ["Shell pending", "Calculating radial shells for the selected CIF and absorber site."]
        : error || !hasAnalysis
          ? ["Shell unavailable", error || "Radial shell analysis is unavailable for the selected CIF and absorber site."]
          : shell
            ? [`Shell ${shell.index}`, `Radial shell ${shell.index} · ${shellRange(shell)} · matched by element and atomic position.`]
            : ["Unmatched", "No matching single-scattering geometry in the selected CIF’s radial shells. Check the CIF, absorber site and shell search radius."]
  const index = nleg === 2 && hasContext && hasAnalysis && !loading && !error ? shell?.index : undefined
  return <span className={styles.label} title={title}><ShellSwatch index={index} />{label}</span>
}
