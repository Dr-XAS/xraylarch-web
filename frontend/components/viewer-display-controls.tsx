"use client"

import type { ReactNode } from "react"
import styles from "./viewer-display-controls.module.css"

/** Shared presentation controls; each viewer owns its values and plot behavior. */
export function ViewerDisplayControls({ label, children, className = "" }: {
  label: string
  children: ReactNode
  className?: string
}) {
  return <div className={`${styles.controls} ${className}`.trim()} role="group" aria-label={label} data-viewer-display-controls>
    {children}
  </div>
}

export function ViewerControlGroup({ children, label, className = "", align = "start" }: {
  children: ReactNode
  label?: string
  className?: string
  align?: "start" | "end"
}) {
  return <div className={`${styles.group} ${align === "end" ? styles.end : ""} ${className}`.trim()}
    role={label ? "group" : undefined} aria-label={label}>{children}</div>
}

export function ViewerToggle({ label, checked, onChange, disabled, title }: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  title?: string
}) {
  return <label className={styles.toggle} title={title}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />{label}
  </label>
}

export function ViewerControlField({ label, children, className = "", title }: {
  label: ReactNode
  children: ReactNode
  className?: string
  title?: string
}) {
  return <label className={`${styles.field} ${className}`.trim()} title={title}><span>{label}</span>{children}</label>
}
