"use client"

import { format } from "@/lib/artemis-fit-utils"
import type { ArtemisTheoryResult } from "./artemis-theory-result"
import { SectionHelp } from "../section-help"
import styles from "./artemis-fit-report.module.css"

export function ArtemisTheorySummary({ result }: { result: ArtemisTheoryResult }) {
  const { request, available_paths, total_paths, assumptions } = result.simulation
  const transform = request.transform
  const disorder: [string, string][] = request.disorder_model === "debye"
    ? [["Disorder model", "Correlated Debye"], ["Temperature (K)", format(request.temperature ?? 298)],
      ["Debye temperature ΘD (K)", format(request.debye_temperature ?? undefined)], ["Static σ² (Å²)", format(request.static_sigma2 ?? 0)]]
    : [["Disorder model", "Fixed σ²"], ["σ² (Å²)", format(request.sigma2)]]
  return <section className={styles.report} aria-label="Theory calculation details">
    <header className={styles.header}><div className={styles.heading}><h4>Theory calculation</h4></div><span className={styles.status}>No fit performed</span></header>
    <p className={styles.note}>Saved simulation · {result.paths.length} of {available_paths} available paths ({total_paths} generated). Uses the original simulation parameters and Fourier settings.</p>
    <dl className={styles.settings}>
      {([
        ["S₀²", format(request.s02)], ...disorder,
        ["ΔE₀ (eV)", format(request.e0)], ["ΔR (Å)", format(request.deltar)],
        ["Fourier k range", `${format(transform.kmin)}–${format(transform.kmax)} Å⁻¹`],
        ["Fourier window", `${transform.window} · dk ${format(transform.dk)} Å⁻¹`],
      ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <section className={styles.section} aria-label="Theory paths">
      <div className={styles.sectionHeading}><h5>Path contributions<SectionHelp label="Theory path lengths">R = Rₑff + the supplied ΔR. For multiple scattering, R is half the total path length. These are simulation inputs, not fitted distances or uncertainties.</SectionHelp></h5></div>
      <div className={styles.tableScroll} role="region" aria-label="Theory path values" tabIndex={0}><table>
        <thead><tr><th scope="col">Path</th><th scope="col">Rₑff (Å)</th><th scope="col">R (Å)</th><th scope="col">Degeneracy</th><th scope="col">σ² (Å²)</th></tr></thead>
        <tbody>{result.paths.map((path, index) => <tr key={path.id}>
          <th scope="row"><span className={styles.pathName}><span className={styles.pathIndex}>{index + 1}</span>{path.label || path.filename}</span><span className={styles.expression}>{path.metadata.nleg === 2 ? "Single scattering" : "Multiple scattering"}</span></th>
          <td>{format(path.metadata.reff, 6)}</td><td>{format(path.metadata.reff + path.values.deltar, 6)}</td><td>{format(path.metadata.degen)}</td><td>{format(path.values.sigma2)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    {assumptions.length > 0 && <details className={styles.section}><summary>Simulation assumptions</summary><ul className={styles.backendNotes}>{assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
  </section>
}
