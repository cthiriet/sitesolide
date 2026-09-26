import { describe, expect, test } from "bun:test"
import {
  NO_TRANSITION_CLASS,
  THEME_KEY,
  applyTheme,
  themeButton,
  storedChoice,
  readChoice,
  storeChoice,
  themeFromRoot,
  effectiveTheme,
  nextTheme,
  type Theme,
} from "../src/lib/theme"

/** An in-memory storage, like `localStorage`. */
function storage(values: Record<string, string> = {}) {
  const table = new Map(Object.entries(values))
  return {
    table,
    getItem: (key: string) => table.get(key) ?? null,
    setItem: (key: string, value: string) => void table.set(key, value),
  }
}

/** What a browser that blocks storage returns: an exception on mere access. */
function blocked(): never {
  throw new Error("SecurityError: The operation is insecure.")
}

/** The document root, reduced to what the theme touches. */
function root() {
  const classes = new Set<string>()
  return {
    classList: {
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force: boolean) => {
        if (force) classes.add(name)
        else classes.delete(name)
        return force
      },
    },
    style: { colorScheme: "" },
  }
}

const INVALID = ["", "Dark", "LIGHT", " dark", "dark ", "system", "auto", "true", '"dark"', "1"]

describe("remembered choice", () => {
  test("light and dark are a choice", () => {
    expect(storedChoice("light")).toBe("light")
    expect(storedChoice("dark")).toBe("dark")
  })

  test("a missing value is not a choice", () => {
    expect(storedChoice(null)).toBeNull()
    expect(storedChoice(undefined)).toBeNull()
  })

  test("an invalid value is not a choice, case and spaces included", () => {
    for (const value of [...INVALID, 1, true, {}, ["dark"]]) expect(storedChoice(value)).toBeNull()
  })
})

describe("effective theme", () => {
  test("with no choice, the system decides", () => {
    expect(effectiveTheme(null, true)).toBe("dark")
    expect(effectiveTheme(null, false)).toBe("light")
  })

  test("a choice wins over the system, in all four combinations", () => {
    expect(effectiveTheme("light", true)).toBe("light")
    expect(effectiveTheme("light", false)).toBe("light")
    expect(effectiveTheme("dark", true)).toBe("dark")
    expect(effectiveTheme("dark", false)).toBe("dark")
  })
})

describe("toggle", () => {
  test("each theme switches to the other, and two toggles bring you back to the start", () => {
    expect(nextTheme("dark")).toBe("light")
    expect(nextTheme("light")).toBe("dark")
    for (const theme of ["light", "dark"] as Theme[]) expect(nextTheme(nextTheme(theme))).toBe(theme)
  })

  test("the button offers the opposite theme: sun in dark, moon in light", () => {
    expect(themeButton("dark")).toEqual({ icon: "sun", label: "Switch to light mode" })
    expect(themeButton("light")).toEqual({ icon: "moon", label: "Switch to dark mode" })
  })

  test("the button's label names the theme it switches to", () => {
    for (const theme of ["light", "dark"] as Theme[]) {
      expect(themeButton(theme).label).toBe(`Switch to ${nextTheme(theme)} mode`)
    }
  })
})

describe("storage", () => {
  test("the choice is read under the theme key", () => {
    expect(THEME_KEY).toBe("theme")
    expect(readChoice(() => storage({ theme: "dark" }))).toBe("dark")
    expect(readChoice(() => storage({ theme: "light" }))).toBe("light")
  })

  test("a missing key or another key do not make a choice", () => {
    expect(readChoice(() => storage())).toBeNull()
    expect(readChoice(() => storage({ colour: "dark" }))).toBeNull()
  })

  test("an invalid remembered value counts as no choice, and the page follows the system", () => {
    for (const value of INVALID) {
      expect(readChoice(() => storage({ theme: value }))).toBeNull()
      expect(effectiveTheme(readChoice(() => storage({ theme: value })), true)).toBe("dark")
    }
  })

  test("a storage that throws, on access or on read, counts as no choice", () => {
    expect(readChoice(blocked)).toBeNull()
    expect(readChoice(() => ({ getItem: blocked }))).toBeNull()
  })

  test("the choice is remembered under the same key, and read back as it is", () => {
    const memory = storage()
    expect(storeChoice(() => memory, "dark")).toBe(true)
    expect(memory.table.get("theme")).toBe("dark")
    expect(readChoice(() => memory)).toBe("dark")
    expect(storeChoice(() => memory, "light")).toBe(true)
    expect(readChoice(() => memory)).toBe("light")
  })

  test("a storage that refuses returns false without throwing", () => {
    expect(storeChoice(blocked, "dark")).toBe(false)
    expect(storeChoice(() => ({ setItem: blocked }), "light")).toBe(false)
  })
})

describe("document root", () => {
  test("apply sets the class and color-scheme, and reading back returns the same theme", () => {
    const element = root()
    applyTheme(element, "dark")
    expect(element.classList.contains("dark")).toBe(true)
    expect(element.style.colorScheme).toBe("dark")
    expect(themeFromRoot(element.classList)).toBe("dark")

    applyTheme(element, "light")
    expect(element.classList.contains("dark")).toBe(false)
    expect(element.style.colorScheme).toBe("light")
    expect(themeFromRoot(element.classList)).toBe("light")
  })

  /** Tailwind only generates a class if it reads it whole in the source. */
  test("the class that cuts the transitions is spelled out in full", async () => {
    const source = await Bun.file(new URL("../src/lib/theme.ts", import.meta.url)).text()
    expect(NO_TRANSITION_CLASS).toBe("**:transition-none!")
    expect(source).toContain(`"${NO_TRANSITION_CLASS}"`)
  })
})

/**
 * The inline script in main.astro cannot import the module: it is therefore run
 * here against a fake window, and each of its decisions compared with the pure
 * functions'. A key or a value that diverged would show in these results.
 */
const MAIN = await Bun.file(new URL("../src/layouts/main.astro", import.meta.url)).text()
const SCRIPT = MAIN.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1] ?? ""

describe("inline script in main.astro", () => {
  function openPage({ stored, dark, blocked: storageBlocked = false }: {
    stored: string | null
    dark: boolean
    blocked?: boolean
  }) {
    const table = new Map<string, string>()
    if (stored !== null) table.set(THEME_KEY, stored)
    const media = { matches: dark, listeners: [] as (() => void)[] }
    const storageListeners: ((event: { key: string | null }) => void)[] = []
    const element = root()
    const browserWindow = {
      matchMedia(query: string) {
        if (query !== "(prefers-color-scheme: dark)") throw new Error(`unexpected query: ${query}`)
        return {
          get matches() {
            return media.matches
          },
          addEventListener: (type: string, listener: () => void) => {
            if (type === "change") media.listeners.push(listener)
          },
        }
      },
      get localStorage() {
        if (storageBlocked) blocked()
        return { getItem: (key: string) => table.get(key) ?? null }
      },
      addEventListener(type: string, listener: (event: { key: string | null }) => void) {
        if (type === "storage") storageListeners.push(listener)
      },
    }
    new Function("window", "document", SCRIPT)(browserWindow, { documentElement: element })

    return {
      theme: () => themeFromRoot(element.classList),
      colorScheme: () => element.style.colorScheme,
      system(value: boolean) {
        media.matches = value
        for (const listener of media.listeners) listener()
      },
      /** Another tab writes, clears a key or empties everything (`key` null), then notifies this one. */
      otherTab(key: string | null, value: string | null) {
        if (key === null) table.clear()
        else if (value === null) table.delete(key)
        else table.set(key, value)
        for (const listener of storageListeners) listener({ key: key })
      },
    }
  }

  test("the script is found in the template", () => {
    expect(SCRIPT).toContain("prefers-color-scheme: dark")
    expect(SCRIPT).toContain("try")
  })

  test("on load, it resolves like the pure functions, for every value and every system", () => {
    for (const stored of [null, "light", "dark", ...INVALID]) {
      for (const dark of [false, true]) {
        const page = openPage({ stored, dark })
        const expected = effectiveTheme(readChoice(() => storage(stored === null ? {} : { theme: stored })), dark)
        expect({ stored, dark, theme: page.theme() }).toEqual({ stored, dark, theme: expected })
        expect(page.colorScheme()).toBe(expected)
      }
    }
  })

  test("a blocked storage breaks nothing: the page follows the system", () => {
    expect(openPage({ stored: "light", dark: true, blocked: true }).theme()).toBe("dark")
    expect(openPage({ stored: "dark", dark: false, blocked: true }).theme()).toBe("light")
  })

  test("with no choice, it follows the system while the page is open", () => {
    const page = openPage({ stored: null, dark: false })
    page.system(true)
    expect(page.theme()).toBe("dark")
    expect(page.colorScheme()).toBe("dark")
    page.system(false)
    expect(page.theme()).toBe("light")
  })

  test("with a choice, a change of system does not overturn it", () => {
    const page = openPage({ stored: "light", dark: true })
    page.system(false)
    page.system(true)
    expect(page.theme()).toBe("light")
  })

  test("a choice made in another tab is picked up, and clearing it gives the system back", () => {
    const page = openPage({ stored: null, dark: true })
    page.otherTab(THEME_KEY, "light")
    expect(page.theme()).toBe("light")
    page.otherTab(THEME_KEY, null)
    expect(page.theme()).toBe("dark")
    page.otherTab(THEME_KEY, "light")
    page.otherTab(null, null)
    expect(page.theme()).toBe("dark")
  })

  test("another storage key does not touch the theme", () => {
    const page = openPage({ stored: "light", dark: true })
    page.otherTab("other", "dark")
    expect(page.theme()).toBe("light")
  })
})
