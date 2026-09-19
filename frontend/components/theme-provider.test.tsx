import "@testing-library/jest-dom/vitest"

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { themeInitScript, themeStorageKey } from "@/lib/theme"
import { ThemeProvider, useTheme } from "./theme-provider"
import { ThemeToggle } from "./theme-toggle"

function CurrentTheme() {
  const { theme } = useTheme()
  return <output aria-label="Current theme">{theme}</output>
}

function showTheme() {
  return render(<ThemeProvider><ThemeToggle /><CurrentTheme /></ThemeProvider>)
}

function expectTheme(theme: "light" | "dark") {
  expect(document.documentElement).toHaveAttribute("data-theme", theme)
  expect(document.documentElement.style.colorScheme).toBe(theme)
  expect(screen.getByLabelText("Current theme")).toHaveTextContent(theme)
  expect(screen.getByRole("button", { name: `Switch to ${theme === "dark" ? "light" : "dark"} mode` })).toBeVisible()
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ""
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ""
})

describe("ThemeProvider", () => {
  it("switches between light and dark and saves each selection", () => {
    showTheme()
    expectTheme("light")

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }))
    expectTheme("dark")
    expect(localStorage.getItem(themeStorageKey)).toBe("dark")

    fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }))
    expectTheme("light")
    expect(localStorage.getItem(themeStorageKey)).toBe("light")
  })

  it("restores the saved choice when the workspace is mounted again", () => {
    const first = showTheme()
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }))
    first.unmount()
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ""

    showTheme()
    expectTheme("dark")
  })

  it.each(["system", "blue", "Dark", "", "null"])("rejects unsupported saved theme %j", saved => {
    localStorage.setItem(themeStorageKey, saved)
    document.documentElement.dataset.theme = "dark"
    showTheme()
    expectTheme("light")
  })

  it("keeps the page theme and allows toggling when browser storage is unavailable", () => {
    document.documentElement.dataset.theme = "dark"
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError")
    })

    showTheme()
    expectTheme("dark")
    fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }))
    expectTheme("light")
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }))
    expectTheme("dark")
  })

  it("syncs valid changes and clearing from another tab while ignoring unrelated storage", () => {
    showTheme()
    fireEvent(window, new StorageEvent("storage", { key: "other-key", newValue: "dark", storageArea: localStorage }))
    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: "dark", storageArea: sessionStorage }))
    expectTheme("light")

    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: "dark", storageArea: localStorage }))
    expectTheme("dark")
    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: "light", storageArea: localStorage }))
    expectTheme("light")
    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: "dark", storageArea: localStorage }))
    fireEvent(window, new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }))
    expectTheme("light")
  })

  it.each(["system", "blue", null])("falls back to light for unsupported cross-tab theme %j", saved => {
    localStorage.setItem(themeStorageKey, "dark")
    showTheme()
    expectTheme("dark")

    fireEvent(window, new StorageEvent("storage", { key: themeStorageKey, newValue: saved, storageArea: localStorage }))
    expectTheme("light")
  })
})

describe("theme initialization before page paint", () => {
  it.each(["dark", "light"])("applies saved %s before React mounts", saved => {
    localStorage.setItem(themeStorageKey, saved)
    new Function(themeInitScript)()
    expect(document.documentElement).toHaveAttribute("data-theme", saved)
    expect(document.documentElement.style.colorScheme).toBe(saved)
  })

  it.each(["system", "blue", null])("defaults to light for unsupported preference %j", saved => {
    if (saved !== null) localStorage.setItem(themeStorageKey, saved)
    new Function(themeInitScript)()
    expect(document.documentElement).toHaveAttribute("data-theme", "light")
    expect(document.documentElement.style.colorScheme).toBe("light")
  })

  it("defaults to light when browser storage access is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError")
    })
    expect(() => new Function(themeInitScript)()).not.toThrow()
    expect(document.documentElement).toHaveAttribute("data-theme", "light")
    expect(document.documentElement.style.colorScheme).toBe("light")
  })
})
