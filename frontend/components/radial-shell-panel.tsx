"use client"

import { SectionHelp } from "./section-help"
import { useEffect, useState } from "react"
import { shellRange } from "@/lib/radial-shells"
import type { RadialShellState } from "@/lib/use-radial-shells"
import { ShellSwatch } from "./feff-path-shell-label"
import styles from "./radial-shell-panel.module.css"

export function RadialShellPanel({ state, selected, onToggle, disabled = false }: {
  state: RadialShellState; selected?: number[]; onToggle?: (index: number) => void; disabled?: boolean
}) {
  const [radius, setRadius] = useState(String(state.settings.radius))
  const [tolerance, setTolerance] = useState(String(state.settings.tolerance))
  const [error, setError] = useState("")
  useEffect(() => { setRadius(String(state.settings.radius)); setTolerance(String(state.settings.tolerance)); setError("") }, [state.settings, state.contextKey])
  return <section className={styles.panel} aria-label="Radial shells">
    <strong>Radial shells{state.data ? ` · ${state.data.absorber} site ${state.data.site_index}` : ""}<SectionHelp label="Radial shells">Distances are measured from the selected absorber in the periodic CIF. Shell width limits the distance spread within a group. These are structural ranges, not phase-shifted Fourier-transform fit bounds. Pair groups preserve symmetry around this absorber. A FEFF path may represent several pair groups; its degeneracy is kept unchanged.</SectionHelp></strong>
    <div className={styles.controls}>
      <label>Search radius (Å)<input type="number" aria-label="Shell search radius" min={0.5} max={12} step={0.5} value={radius} disabled={disabled} onChange={event => setRadius(event.target.value)} /></label>
      <label>Shell width (Å)<input type="number" aria-label="Shell distance tolerance" min={0.001} max={0.5} step={0.01} value={tolerance} disabled={disabled} onChange={event => setTolerance(event.target.value)} /></label>
      <button type="button" disabled={disabled} onClick={() => {
        const r = Number(radius), t = Number(tolerance)
        if (!radius.trim() || !tolerance.trim() || !Number.isFinite(r) || r < 0.5 || r > 12 || !Number.isFinite(t) || t < 0.001 || t > 0.5) {
          setError("Use a radius of 0.5–12 Å and a shell width of 0.001–0.5 Å."); return
        }
        setError(""); state.setSettings({ radius: r, tolerance: t })
      }}>Apply shell settings</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {state.loading && <p role="status">Calculating periodic radial shells…</p>}
    {state.error && <p role="alert">{state.error} <button type="button" onClick={state.retry}>Retry radial shells</button></p>}
    {state.data && <>
      <div className={styles.scroll} tabIndex={0} role="region" aria-label="Shell distance ranges">
        <table aria-label="Radial shell distances"><thead><tr><th>Shell</th><th>Distance range (Å)</th><th>Neighbors</th><th>Elements / pair groups</th></tr></thead>
          <tbody>{state.data.shells.map(shell => <tr key={shell.index}>
            <th scope="row"><ShellSwatch index={shell.index} />{onToggle ? <label><input type="checkbox" aria-label={`Show shell ${shell.index}`} checked={selected?.includes(shell.index) ?? false} onChange={() => onToggle(shell.index)} />Shell {shell.index}</label> : `Shell ${shell.index}`}</th>
            <td>{shellRange(shell).replace(" Å", "")}</td><td>{shell.coordination_number}</td>
            <td><details><summary>{Object.entries(shell.elements).map(([element, count]) => `${element} × ${count}`).join(" · ")}</summary>
              {shell.groups.map(group => <div key={group.id}>{group.element} · pair {group.id} · N {group.coordination_number} · {shellRange(group)}</div>)}
            </details></td>
          </tr>)}</tbody>
        </table>
      </div>
      {state.data.warnings.map(warning => <p key={warning} role="status">{warning.startsWith("The outer shell is close to the search cutoff") ? <>Outer shell may be incomplete<SectionHelp label="Outer shell warning">{warning}</SectionHelp></> : warning}</p>)}
    </>}
  </section>
}
