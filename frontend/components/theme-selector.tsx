"use client"

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react"
import type { ThemePreference } from "@/lib/theme"
import { useTheme } from "./theme-provider"
import styles from "./theme-selector.module.css"

const choices: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

export function ThemeSelector() {
  const { preference, setPreference } = useTheme()

  return <div className={styles.selector} role="radiogroup" aria-label="Color theme">
    {choices.map(({ value, label, icon: Icon }) => <button key={value} type="button" role="radio"
      className={styles.choice} aria-checked={preference === value} aria-label={`${label} theme`}
      title={value === "system" ? "Follow the system theme" : `${label} theme`}
      onClick={() => setPreference(value)}>
      <Icon size={15} aria-hidden="true" />
    </button>)}
  </div>
}
