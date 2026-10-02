import { SectionHelp } from "./section-help"
import type { FirstShellState } from "@/lib/use-first-shell"

export function FirstShellSummary({ state }: { state: FirstShellState }) {
  if (state.loading) return <p role="status">Identifying first shell with CrystalNN…</p>
  if (state.error) return <p role="alert">{state.error} <button type="button" onClick={state.retry}>Retry CrystalNN</button></p>
  const shell = state.shell
  if (!shell) return null
  const elements = [...new Set(shell.neighbors.map(atom => atom.element))]
  return <div aria-label="CrystalNN first shell">
    <p><strong>CrystalNN first shell · CN {shell.coordination_number}<SectionHelp label="CrystalNN first shell">Predicted bonded neighbors of {shell.absorber} site {shell.site_index}. CrystalNN weight: {(shell.coordination_weight * 100).toFixed(1)}%. This is a structural prediction, not a fitted coordination number or an FT fitting range.</SectionHelp></strong>{elements.map(element => {
      const neighbors = shell.neighbors.filter(atom => atom.element === element)
      const distances = neighbors.map(atom => atom.distance)
      const min = Math.min(...distances), max = Math.max(...distances)
      return <span key={element}> · {element} × {neighbors.length} · {min.toFixed(3)}{max - min > 0.001 ? `–${max.toFixed(3)}` : ""} Å</span>
    })}</p>
    {shell.alternatives.length > 1 && <details><summary>Coordination alternatives</summary><p>{shell.alternatives.map(item => `CN ${item.coordination_number} (${(item.weight * 100).toFixed(1)}%)`).join(" · ")}</p></details>}
    {shell.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
  </div>
}
