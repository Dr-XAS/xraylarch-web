"use client"

import { Moon, Sun } from "lucide-react"
import { useTheme } from "./theme-provider"
import styles from "./theme-toggle.module.css"

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode"

  return <button type="button" className={styles.toggle} onClick={toggleTheme} aria-label={label} title={label}>
    <Sun className={styles.sun} size={18} aria-hidden="true" />
    <Moon className={styles.moon} size={18} aria-hidden="true" />
  </button>
}
