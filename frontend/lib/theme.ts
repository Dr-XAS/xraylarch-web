export type Theme = "light" | "dark"

export const themeStorageKey = "xraylarch-web.theme"

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark"
}

// Run before the page paints so a saved dark workspace never flashes light.
export const themeInitScript = `(() => {
  let theme = "light";
  try {
    const saved = localStorage.getItem(${JSON.stringify(themeStorageKey)});
    if (saved === "light" || saved === "dark") theme = saved;
  } catch {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();`
