"use client"

import { SectionHelp } from "../section-help"
import { useState } from "react"
import { calculateClusterCoordination } from "@/lib/cluster-coordination"
import type { CifGeometry } from "@/lib/cif-viewer"
import styles from "./cluster-coordination.module.css"

function calculate(geometry: CifGeometry, bondRange: string, tolerance: string, unavailableReason: string) {
  try {
    if (unavailableReason) throw new Error(unavailableReason)
    if (!bondRange.trim() || !tolerance.trim()) throw new Error("Enter a distance cutoff and shell tolerance.")
    return { geometry, bondRange, tolerance, result: calculateClusterCoordination(geometry.atoms, { bondRange: Number(bondRange), tolerance: Number(tolerance) }), error: "" }
  } catch (error) {
    return { geometry, bondRange, tolerance, result: null, error: error instanceof Error ? error.message : "Unable to calculate coordination numbers." }
  }
}

/** Results belong to one finite geometry and one explicit calculation. */
export function ClusterCoordination({ geometry, unavailableReason }: { geometry: CifGeometry; unavailableReason: string }) {
  const [bondRange, setBondRange] = useState("5")
  const [tolerance, setTolerance] = useState("0.01")
  const [calculation, setCalculation] = useState(() => calculate(geometry, "5", "0.01", unavailableReason))
  const current = calculation.geometry === geometry && calculation.bondRange === bondRange && calculation.tolerance === tolerance
  const result = current && !unavailableReason ? calculation.result : null
  const center = geometry.atoms.find(atom => atom.isAbsorber)
  const shellCount = result?.pairs.reduce((count, pair) => count + pair.shells.length, 0) ?? 0

  return <section className={styles.panel} aria-label="Coordination number calculation">
    <form className={styles.controls} onSubmit={event => {
      event.preventDefault()
      setCalculation(calculate(geometry, bondRange, tolerance, unavailableReason))
    }}>
      <label><span>Distance cutoff (Å)<SectionHelp label="Coordination distance cutoff">Count neighbors strictly inside this distance, in Å. Only atoms in the current finite display cluster are available; enlarge the cluster if it cuts off neighbors you need.</SectionHelp></span><input aria-label="CN distance cutoff" type="number" min="0.001" step="any" required value={bondRange} onChange={event => setBondRange(event.target.value)} /></label>
      <label><span>Shell tolerance (Å)<SectionHelp label="Coordination shell tolerance">Group consecutive neighbor distances into one shell when their gap is no greater than this tolerance, in Å. A larger tolerance can combine nearby shells. Calculate again after changing it.</SectionHelp></span><input aria-label="CN shell tolerance" type="number" min="0" step="any" required value={tolerance} onChange={event => setTolerance(event.target.value)} /></label>
      <button type="submit" disabled={!!unavailableReason}>Calculate</button><SectionHelp label="Cluster coordination calculation">Uses all {geometry.atoms.length} cluster atom{geometry.atoms.length === 1 ? "" : "s"}, including hidden elements. Neighbors outside this finite cluster are excluded.</SectionHelp>
    </form>
    {unavailableReason ? <p className={styles.warning} role="status">{unavailableReason}</p>
      : !current ? <p className={styles.help} role="status">Cluster or settings changed. Calculate to update coordination numbers.</p>
      : calculation.error ? <p className={styles.warning} role="alert">{calculation.error}</p> : null}
    {result && <>
      <p className={styles.help} role="status">{result.atomCount} atom{result.atomCount === 1 ? "" : "s"} · {shellCount} coordination shell{shellCount === 1 ? "" : "s"} · distances &lt; {result.bondRange} Å</p>
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Coordination results">
        <table>
          <caption className={styles.caption}>Cluster coordination numbers<SectionHelp label="Cluster coordination numbers">Average CN includes every atom of the first element, including atoms with zero neighbors. Center CN refers to {center ? `${center.element} · site ${center.siteIndex}` : "the selected center"}. Each shell groups consecutive distances whose gaps are ≤ {result.tolerance} Å. Distribution counts use the same shell membership.</SectionHelp></caption>
          <thead><tr><th scope="col">Pair</th><th scope="col">Shell</th><th scope="col">Mean R (Å)</th><th scope="col">Average CN</th><th scope="col">Center CN</th><th scope="col">Distribution</th></tr></thead>
          <tbody>{result.pairs.flatMap(pair => pair.shells.length ? pair.shells.map(shell => <tr key={`${pair.centerElement}-${pair.neighborElement}-${shell.index}`}>
            <th scope="row">{pair.centerElement} → {pair.neighborElement}</th>
            <td>{shell.index}</td>
            <td title={`${shell.minDistance.toFixed(6)}–${shell.maxDistance.toFixed(6)} Å`}>{shell.distance.toFixed(3)}</td>
            <td>{shell.averageCN.toFixed(3)}</td>
            <td>{shell.centerCN ?? "—"}</td>
            <td><details><summary aria-label={`${pair.centerElement} to ${pair.neighborElement} shell ${shell.index} CN distribution`}>View</summary>
              <div className={styles.distribution}>{shell.distribution.map(item => <span key={item.cn}>CN {item.cn}: {item.count} atom{item.count === 1 ? "" : "s"}</span>)}</div>
            </details></td>
          </tr>) : <tr key={`${pair.centerElement}-${pair.neighborElement}`}><th scope="row">{pair.centerElement} → {pair.neighborElement}</th><td colSpan={5}>No neighbors within cutoff (CN 0)</td></tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>
}
