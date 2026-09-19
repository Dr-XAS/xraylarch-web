"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { isTheme, themeStorageKey, type Theme } from "@/lib/theme"

const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void }>({
  theme: "light",
  toggleTheme: () => {},
})

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light")

  useEffect(() => {
    let initial: Theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light"
    try {
      const saved = localStorage.getItem(themeStorageKey)
      initial = isTheme(saved) ? saved : "light"
    } catch { /* Keep the initial theme when browser storage is unavailable. */ }
    applyTheme(initial)
    setTheme(initial)

    function syncTheme(event: StorageEvent) {
      if (event.key !== themeStorageKey && event.key !== null) return
      try { if (event.storageArea !== localStorage) return } catch { return }
      const next = isTheme(event.newValue) ? event.newValue : "light"
      applyTheme(next)
      setTheme(next)
    }
    window.addEventListener("storage", syncTheme)
    return () => window.removeEventListener("storage", syncTheme)
  }, [])

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark"
    applyTheme(next)
    setTheme(next)
    try { localStorage.setItem(themeStorageKey, next) } catch { /* The toggle still works for this visit. */ }
  }

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
