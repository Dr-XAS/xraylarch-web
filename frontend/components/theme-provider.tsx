"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { resolveTheme, systemDarkQuery, themePreference, themeStorageKey, type Theme, type ThemePreference } from "@/lib/theme"

const ThemeContext = createContext<{ theme: Theme; preference: ThemePreference; setPreference: (next: ThemePreference) => void }>({
  theme: "light",
  preference: "system",
  setPreference: () => {},
})

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system")
  const [theme, setTheme] = useState<Theme>("light")

  function show(next: ThemePreference) {
    const resolved = resolveTheme(next)
    applyTheme(resolved)
    setPreferenceState(next)
    setTheme(resolved)
  }

  useEffect(() => {
    let initial: ThemePreference = document.documentElement.dataset.theme === "dark" ? "dark" : "system"
    try {
      initial = themePreference(localStorage.getItem(themeStorageKey))
    } catch { /* Keep the page theme when browser storage is unavailable. */ }
    show(initial)
  }, [])

  // Follow the operating system while the reader has chosen "system".
  useEffect(() => {
    if (preference !== "system") return
    let media: MediaQueryList
    try { media = window.matchMedia(systemDarkQuery) } catch { return }
    const follow = () => show("system")
    media.addEventListener("change", follow)
    return () => media.removeEventListener("change", follow)
  }, [preference])

  useEffect(() => {
    function syncTheme(event: StorageEvent) {
      if (event.key !== themeStorageKey && event.key !== null) return
      try { if (event.storageArea !== localStorage) return } catch { return }
      show(themePreference(event.newValue))
    }
    window.addEventListener("storage", syncTheme)
    return () => window.removeEventListener("storage", syncTheme)
  }, [])

  function setPreference(next: ThemePreference) {
    show(next)
    try {
      // No saved choice already means "system", so that choice clears it.
      if (next === "system") localStorage.removeItem(themeStorageKey)
      else localStorage.setItem(themeStorageKey, next)
    } catch { /* The choice still applies for this visit. */ }
  }

  return <ThemeContext.Provider value={{ theme, preference, setPreference }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
