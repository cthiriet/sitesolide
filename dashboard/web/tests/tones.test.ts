import { describe, expect, test } from "bun:test"
import { TONE_BANNER, TONE_PILL, TONE_DOT, TONE_TEXT, severityTone, verdictTone } from "../src/lib/tones"
import { NO_DATA, verdict } from "../src/lib/verdict"
import { discrepancy } from "./factory"

describe("tones", () => {
  test("a discrepancy severity has its tone", () => {
    expect(severityTone("error")).toBe("error")
    expect(severityTone("warning")).toBe("attention")
  })

  /** An old photograph can assert nothing: it is said in red, like the absence of data. */
  test("the verdict has its tone, and a stale snapshot is an error", () => {
    expect(verdictTone(verdict([], false))).toBe("ok")
    expect(verdictTone(verdict([discrepancy("warning")], false))).toBe("attention")
    expect(verdictTone(verdict([discrepancy("error")], false))).toBe("error")
    expect(verdictTone(verdict([], true))).toBe("error")
    expect(verdictTone(NO_DATA)).toBe("error")
  })

  /**
   * The colours are the tokens from global.css, never the Tailwind palette: the
   * seal's red only serves errors, and an `amber-500` written here would escape
   * the theme.
   */
  test("every class is spelled out in full, and only names tokens", async () => {
    const source = await Bun.file(new URL("../src/lib/tones.ts", import.meta.url)).text()
    const css = await Bun.file(new URL("../src/styles/global.css", import.meta.url)).text()
    for (const table of [TONE_DOT, TONE_TEXT, TONE_PILL, TONE_BANNER]) {
      for (const classes of Object.values(table)) {
        expect(source).toContain(`"${classes}"`)
        expect(classes).not.toMatch(/amber|emerald|red-|green-|yellow-/)
      }
    }
    for (const token of ["--ok:", "--ok-text:", "--attention:", "--attention-text:", "--destructive:"]) {
      expect(css.split(token).length - 1).toBe(2)
    }
  })
})
