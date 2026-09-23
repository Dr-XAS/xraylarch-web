import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { themeInitScript, themeStorageKey } from "@/lib/theme"
import { ThemeProvider, useTheme } from "./theme-provider"
import { ThemeSelector } from "./theme-selector"

function CurrentTheme() {
  const { theme } = useTheme()
  return <output aria-label="Current theme">{theme}</output>
}

function showTheme() {
  return render(<ThemeProvider><ThemeSelector /><CurrentTheme /></ThemeProvider>)
}

const choiceNames = { system: "System theme", light: "Light theme", dark: "Dark theme" } as const

function choose(preference: keyof typeof choiceNames) {
  fireEvent.click(screen.getByRole("radio", { name: choiceNames[preference] }))
}

function expectTheme(theme: "light" | "dark", preference: keyof typeof choiceNames) {
  expect(document.documentElement).toHaveAttribute("data-theme", theme)
  expect(document.documentElement.style.colorScheme).toBe(theme)
  expect(screen.getByLabelText("Current theme")).toHaveTextContent(theme)
  for (const [value, name] of Object.entries(choiceNames)) {
    expect(screen.getByRole("radio", { name })).toHaveAttribute("aria-checked", String(value === preference))
  }
}

// jsdom has no matchMedia; this stands in for the operating system setting.
function systemScheme(initial: "light" | "dark") {
  const listeners = new Set<() => void>()
  const media = {
    matches: initial === "dark",
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  window.matchMedia = vi.fn(() => media as unknown as MediaQueryList)
  return {
    listeners,
    set(scheme: "light" | "dark") {
      media.matches = scheme === "dark"
      act(() => listeners.forEach(listener => listener()))
    },
  }
}

function reset() {
  localStorage.clear()
  sessionStorage.clear()
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ""
  delete (window as { matchMedia?: unknown }).matchMedia
}

beforeEach(reset)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  reset()
})

describe("ThemeProvider", () => {
  it("follows the system by default and saves explicit light and dark choices", () => {
    systemScheme("dark")
    showTheme()
    expectTheme("dark", "system")
    expect(localStorage.getItem(themeStorageKey)).toBeNull()

    choose("light")
    expectTheme("light", "light")
    expect(localStorage.getItem(themeStorageKey)).toBe("light")

    choose("dark")
    expectTheme("dark", "dark")
    expect(localStorage.getItem(themeStorageKey)).toBe("dark")

    choose("system")
    expectTheme("dark", "system")
    expect(localStorage.getItem(themeStorageKey)).toBeNull()
  })

  it("tracks the system setting only while System is chosen", () => {
    const system = systemScheme("light")
    showTheme()
    expectTheme("light", "system")

    system.set("dark")
    expectTheme("dark", "system")
    system.set("light")
    expectTheme("light", "system")

    choose("dark")
    expect(system.listeners.size).toBe(0)
    system.set("light")
    expectTheme("dark", "dark")
  })

  it("falls back to light when the browser cannot report a system setting", () => {
    showTheme()
    expectTheme("light", "system")
  })

  it("restores the saved choice when the workspace is mounted again", () => {
    systemScheme("light")
    const first = showTheme()
    choose("dark")
    first.unmount()
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ""

    showTheme()
    expectTheme("dark", "dark")
  })

  it.each(["system", "blue", "Dark", "", "null"])("treats unsupported saved theme %j as System", saved => {
    systemScheme("dark")
    localStorage.setItem(themeStorageKey, saved)
    document.documentElement.dataset.theme = "light"
    showTheme()
    expectTheme("dark", "system")
  })

  it("keeps the page theme and allows choosing when browser storage is unavailable", () => {
    systemScheme("light")
    document.documentElement.dataset.theme = "dark"
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError")
    })

    showTheme()
    expectTheme("dark", "dark")
    choose("light")
    expectTheme("light", "light")
    choose("system")
    expectTheme("light", "system")
  })

  it("syncs valid changes and clearing from another tab while ignoring unrelated storage", () => {
    systemScheme("light")
    showTheme()
    fireEvent(window, new StorageEvent("storage", { key: "other-key", newValue: "dark", storageArea: localStorage }))
    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: "dark", storageArea: sessionStorage }))
    expectTheme("light", "system")

    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: "dark", storageArea: localStorage }))
    expectTheme("dark", "dark")
    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: "light", storageArea: localStorage }))
    expectTheme("light", "light")
    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: "dark", storageArea: localStorage }))
    fireEvent(window, new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }))
    expectTheme("light", "system")
  })

  it.each(["system", "blue", null])("follows the system for unsupported cross-tab theme %j", saved => {
    systemScheme("light")
    localStorage.setItem(themeStorageKey, "dark")
    showTheme()
    expectTheme("dark", "dark")

    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: saved, storageArea: localStorage }))
    expectTheme("light", "system")
  })
})

describe("theme initialization before page paint", () => {
  it.each(["dark", "light"])("applies saved %s before React mounts", saved => {
    systemScheme(saved === "dark" ? "light" : "dark")
    localStorage.setItem(themeStorageKey, saved)
    new Function(themeInitScript)()
    expect(document.documentElement).toHaveAttribute("data-theme", saved)
    expect(document.documentElement.style.colorScheme).toBe(saved)
  })

  it.each(["dark", "light"] as const)("follows a %s system setting when nothing supported is saved", scheme => {
    systemScheme(scheme)
    for (const saved of ["system", "blue", null]) {
      localStorage.clear()
      if (saved !== null) localStorage.setItem(themeStorageKey, saved)
      new Function(themeInitScript)()
      expect(document.documentElement).toHaveAttribute("data-theme", scheme)
      expect(document.documentElement.style.colorScheme).toBe(scheme)
    }
  })

  it("defaults to light when neither storage nor the system setting is available", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError")
    })
    expect(() => new Function(themeInitScript)()).not.toThrow()
    expect(document.documentElement).toHaveAttribute("data-theme", "light")
    expect(document.documentElement.style.colorScheme).toBe("light")
  })
})
