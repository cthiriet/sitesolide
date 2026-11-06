import { describe, expect, test } from "bun:test"
import { lifecycleTexts } from "../src/lib/lifecycle"
import { headerState, siteState } from "../src/lib/site-card"
import { rowState } from "../src/lib/site-list"

describe("a project turned off, on the page", () => {
  const off = { slug: "blog", type: "static" as const, service: null, disabled: true }

  test("says Turned off, in the attention tone, in the list and the header", () => {
    expect(rowState(off, [])).toMatchObject({ severity: null, tone: "attention", label: "Turned off" })
    expect(headerState(off, [])).toEqual({ tone: "attention", label: "Turned off" })
    expect(siteState(off, []).label).toBe("Turned off")
  })

  test("its confirmations say what each action keeps and deletes", () => {
    expect(lifecycleTexts("blog", "disable").consequence).toContain("Nothing is deleted")
    expect(lifecycleTexts("blog", "remove").consequence).toContain("for good")
    expect(lifecycleTexts("blog", "enable").action).toBe("Turn on")
  })
})
