/**
 * The page's theme, light or dark. Pure: the storage and the document root
 * arrive as parameters.
 *
 * As long as nothing is remembered, the page follows the system, including its
 * changes while the page stays open. A click on the button remembers the chosen
 * theme under the key `theme`, `light` or `dark`, which then wins over the
 * system, reloads included. Clearing that key, with
 * `localStorage.removeItem("theme")` in the console, brings back the system
 * theme: the button deliberately has no third state for that.
 *
 * The inline script in layouts/main.astro, which sets the theme before the
 * first render, cannot import this module. It repeats its key, its validation
 * and its resolution, and tests/theme.test.ts runs it against these functions.
 */

export const THEME_KEY = "theme"

export type Theme = "light" | "dark"

/** A remembered value, validated: anything that is not exactly `light` or `dark` counts as no choice. */
export function storedChoice(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null
}

/** The remembered choice wins; without it, the system decides. */
export function effectiveTheme(choice: Theme | null, systemDark: boolean): Theme {
  return choice ?? (systemDark ? "dark" : "light")
}

export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark"
}

/** The button announces what it will do, not the current state: a sun in dark mode, to go light. */
export function themeButton(theme: Theme): { icon: "sun" | "moon"; label: string } {
  return theme === "dark"
    ? { icon: "sun", label: "Switch to light mode" }
    : { icon: "moon", label: "Switch to dark mode" }
}

/** The theme the document root carries: its `dark` class is the only source. */
export function themeFromRoot(classes: Pick<DOMTokenList, "contains">): Theme {
  return classes.contains("dark") ? "dark" : "light"
}

/**
 * The remembered choice. `localStorage` can throw on mere access, storage
 * blocked or private browsing depending on the browser: it therefore arrives
 * through a function called inside the `try`, and any exception counts as no
 * choice, the page then following the system.
 */
export function readChoice(storage: () => Pick<Storage, "getItem">): Theme | null {
  try {
    return storedChoice(storage().getItem(THEME_KEY))
  } catch {
    return null
  }
}

/** Remembers the choice. Returns false if storage refuses: the theme changes anyway, for this page only. */
export function storeChoice(storage: () => Pick<Storage, "setItem">, theme: Theme): boolean {
  try {
    storage().setItem(THEME_KEY, theme)
    return true
  } catch {
    return false
  }
}

/**
 * What the root carries for a theme: the `dark` class, which the colours of
 * styles/global.css depend on, and `color-scheme`, which native controls,
 * scrollbars and dropdown menus follow.
 */
export function applyTheme(
  root: { classList: Pick<DOMTokenList, "toggle">; style: { colorScheme: string } },
  theme: Theme,
): void {
  root.classList.toggle("dark", theme === "dark")
  root.style.colorScheme = theme
}

/**
 * Set on the root for the duration of the switch. Without it the buttons and
 * the pills, which have a transition, would fade their colours while the rest
 * of the page changes at once, and the page would shimmer. Spelled out in
 * full, otherwise Tailwind would not generate it.
 */
export const NO_TRANSITION_CLASS = "**:transition-none!"
