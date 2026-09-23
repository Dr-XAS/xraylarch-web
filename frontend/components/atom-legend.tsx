import { cifElementColor } from "@/lib/cif-viewer-style"
import styles from "./atom-legend.module.css"

export function AtomLegend({ elements, hiddenElements = [], onToggle, className = "", ariaLabel = "Atom legend" }: {
  elements: readonly string[]
  hiddenElements?: readonly string[]
  onToggle?: (element: string) => void
  className?: string
  ariaLabel?: string
}) {
  if (!elements.length) return null

  return <div className={`${styles.legend} ${className}`.trim()} role="group" aria-label={ariaLabel}>
    {elements.map((element, index) => {
      const swatch = <span className={styles.swatch} style={{ backgroundColor: cifElementColor(index) }} aria-hidden="true" />
      return onToggle
        ? <button type="button" className={styles.item} key={element} aria-label={`Show ${element} atoms`}
            aria-pressed={!hiddenElements.includes(element)} onClick={() => onToggle(element)}>{swatch}{element}</button>
        : <span className={styles.item} key={element}>{swatch}{element}</span>
    })}
  </div>
}
