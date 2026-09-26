import { describe, expect, test } from "bun:test"
import { countBySeverity, worstSeverities, sortDiscrepancies, verdict } from "../src/lib/verdict"
import { discrepancy } from "./factory"

describe("verdict", () => {
  test("with no discrepancy, all is well", () => {
    expect(verdict([], false)).toEqual({ tone: "ok", label: "All clear" })
  })

  test("warnings on their own are counted, singular as well as plural", () => {
    expect(verdict([discrepancy("warning")], false)).toEqual({ tone: "warning", label: "1 warning" })
    expect(verdict([discrepancy("warning"), discrepancy("warning"), discrepancy("warning")], false)).toEqual({
      tone: "warning",
      label: "3 warnings",
    })
  })

  test("an error wins, and the warnings follow", () => {
    expect(verdict([discrepancy("error"), discrepancy("error")], false)).toEqual({ tone: "error", label: "2 errors" })
    expect(verdict([discrepancy("warning"), discrepancy("error"), discrepancy("error")], false)).toEqual({
      tone: "error",
      label: "2 errors · 1 warning",
    })
  })

  /** An old photograph must never announce itself as "All clear". */
  test("a stale snapshot wins over everything", () => {
    expect(verdict([], true)).toEqual({ tone: "stale", label: "Stale data" })
    expect(verdict([discrepancy("error")], true).tone).toBe("stale")
  })

  test("countBySeverity separates the two severities", () => {
    expect(countBySeverity([discrepancy("error"), discrepancy("warning"), discrepancy("warning")])).toEqual({
      errors: 1,
      warnings: 2,
    })
  })
})

describe("severity by site", () => {
  test("a site's worst severity wins, in both orders", () => {
    expect(worstSeverities([discrepancy("warning", "a"), discrepancy("error", "a")]).get("a")).toBe("error")
    expect(worstSeverities([discrepancy("error", "a"), discrepancy("warning", "a")]).get("a")).toBe("error")
    expect(worstSeverities([discrepancy("warning", "b")]).get("b")).toBe("warning")
  })

  test("a site with no discrepancy has no severity, and the machine is not a site", () => {
    const table = worstSeverities([discrepancy("error", null)])
    expect(table.get("a")).toBeUndefined()
    expect(table.size).toBe(0)
  })
})

describe("order of the discrepancies", () => {
  test("errors first, the server's order kept at equal severity", () => {
    const tries = sortDiscrepancies([
      discrepancy("warning", "a"),
      discrepancy("error", "b"),
      discrepancy("warning", "c"),
      discrepancy("error", "d"),
    ])
    expect(tries.map((e) => e.slug)).toEqual(["b", "d", "a", "c"])
  })

  test("the original list is not modified", () => {
    const origin = [discrepancy("warning", "a"), discrepancy("error", "b")]
    sortDiscrepancies(origin)
    expect(origin.map((e) => e.slug)).toEqual(["a", "b"])
  })
})
