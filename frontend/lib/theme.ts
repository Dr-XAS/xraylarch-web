/** The palette actually on the page. */
export type Theme = "light" | "dark"
/** What the reader chose; "system" follows the operating system setting. */
export type ThemePreference = "system" | Theme

export const themeStorageKey = "xraylarch-web.theme"
export const systemDarkQuery = "(prefers-color-scheme: dark)"

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark"
}

// Anything unrecognised, including no saved choice, follows the system.
export function themePreference(value: unknown): ThemePreference {
  return isTheme(value) ? value : "system"
}

export function systemTheme(): Theme {
  try { return window.matchMedia(systemDarkQuery).matches ? "dark" : "light" } catch { return "light" }
}

export function resolveTheme(preference: ThemePreference): Theme {
  return preference === "system" ? systemTheme() : preference
}

// Run before the page paints so a saved or system dark theme never flashes light.
export const themeInitScript = `(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem(${JSON.stringify(themeStorageKey)});
    if (saved === "light" || saved === "dark") preference = saved;
  } catch {}
  let theme = preference;
  if (theme === "system") {
    try { theme = window.matchMedia(${JSON.stringify(systemDarkQuery)}).matches ? "dark" : "light"; } catch { theme = "light"; }
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();`
