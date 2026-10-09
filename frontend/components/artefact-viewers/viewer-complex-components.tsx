"use client"

import { SectionHelp } from "../section-help"
import type { ComplexComponent } from "./athena-plot"
import styles from "./viewer-complex-components.module.css"

const options = [
  ["mag", "Magnitude"], ["re", "Real"], ["im", "Imaginary"], ["pha", "Phase"],
] as const

export function ViewerComplexComponents({ value, onChange, compareK = false }: {
  value: ComplexComponent[]
  onChange: (value: ComplexComponent[]) => void
  compareK?: boolean
}) {
  return <div className={styles.control}>
    <div className={styles.choices} role="group" aria-label="Complex components">
      {options.map(([component, label]) => <label className={styles.option} key={component} data-selected={value.includes(component)}>
        <input type="checkbox" checked={value.includes(component)} onChange={event => {
          const selected = new Set(value)
          if (event.target.checked) selected.add(component)
          else selected.delete(component)
          onChange(options.map(([key]) => key).filter(key => selected.has(key)))
        }} />
        <span>{component === "re" && compareK ? "Real + χ(k)" : label}</span>
      </label>)}
    </div>
    <SectionHelp label="Complex components">Select one or more components to overlay. Curves from the same spectrum share a color; different line styles distinguish the components. Phase uses a separate axis in radians when shown with amplitude. In q space, Real also overlays χ(k) for comparison with the back transform.</SectionHelp>
  </div>
}
