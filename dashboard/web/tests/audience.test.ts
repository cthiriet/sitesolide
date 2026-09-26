import { describe, expect, test } from "bun:test"
import {
  RANKINGS,
  figures,
  emptyCurve,
  shortDay,
  rankingLabel,
  formatNumber,
  rowShare,
  axisCeiling,
  formatSeconds,
} from "@/lib/audience"
import type { Measure } from "@/lib/types"

const measure: Measure = {
  views: 851,
  visits: 405,
  bounceRate: 30,
  timePerPage: 84,
  pagesPerVisit: 2.1,
  days: [{ day: "2026-09-21", views: 47, visits: 21 }],
  rankings: {},
}

describe("rankingLabel", () => {
  test("names the device families in English", () => {
    // The database writes them in French, like every identifier in this
    // repository; the dashboard, for its rowShare, speaks English.
    expect(rankingLabel("appareil", "bureau")).toBe("Desktop")
    expect(rankingLabel("appareil", "tablette")).toBe("Tablet")
    expect(rankingLabel("appareil", "mobile")).toBe("Mobile")
  })

  test("names the languages, and returns an unknown code as it is", () => {
    expect(rankingLabel("langue", "fr")).toBe("French")
    expect(rankingLabel("langue", "xx")).toBe("xx")
    expect(rankingLabel("langue", "!!")).toBe("!!")
  })

  test("leaves the other values untouched", () => {
    // A path, a source, a host: they come from a web page and are read as
    // they are.
    expect(rankingLabel("chemin", "/pricing")).toBe("/pricing")
    expect(rankingLabel("source", "Google")).toBe("Google")
  })
})

describe("the formats", () => {
  test("separates the thousands", () => {
    expect(formatNumber(12345)).toBe("12,345")
  })

  test("writes durations in minutes beyond sixty seconds", () => {
    expect(formatSeconds(45)).toBe("45s")
    expect(formatSeconds(126)).toBe("2m 6s")
    expect(formatSeconds(120)).toBe("2m")
  })

  test("marks with a hyphen what was not measured", () => {
    // Zero seconds does not mean an instant read: it means that nothing came
    // back.
    expect(formatSeconds(0)).toBe("-")
  })

  test("shortens a day without its year", () => {
    expect(shortDay("2026-09-21")).toBe("Sep 21")
    expect(shortDay("not a date")).toBe("not a date")
  })
})

describe("figures", () => {
  test("led by the visits, then the views", () => {
    const rendered = figures(measure)
    expect(rendered.map((figure) => figure.heading)).toEqual([
      "Visits",
      "Views",
      "Pages per visit",
      "Time on page",
    ])
    expect(rendered[0]?.value).toBe("405")
    expect(rendered[3]?.value).toBe("1m 24s")
  })
})

describe("ceiling", () => {
  test("rounds to a step that reads well", () => {
    expect(axisCeiling(37)).toBe(50)
    expect(axisCeiling(120)).toBe(200)
  })

  test("holds up for a site with no visit at all", () => {
    // Without this case, dividing by the ceiling would return NaN coordinates
    // and the curve would be empty, on the page of a site just deployed.
    expect(axisCeiling(0)).toBe(1)
  })
})

describe("emptyCurve", () => {
  test("recognises a period with not a single view", () => {
    expect(emptyCurve([{ day: "2026-09-21", views: 0, visits: 0 }])).toBe(true)
    expect(emptyCurve(measure.days)).toBe(false)
  })
})

describe("rowShare", () => {
  test("compares every row to the first one", () => {
    expect(rowShare({ value: "/", total: 50 }, 100)).toBe(50)
    expect(rowShare({ value: "/", total: 100 }, 100)).toBe(100)
  })

  test("leaves a visible plot for the smallest ones", () => {
    // A zero pixel bar cannot be told apart from a row with no bar.
    expect(rowShare({ value: "/", total: 1 }, 10_000)).toBe(2)
  })

  test("returns zero when there is nothing to compare", () => {
    expect(rowShare({ value: "/", total: 0 }, 0)).toBe(0)
  })
})

describe("RANKINGS", () => {
  test("covers what the snapshot leaves, with no duplicate", () => {
    const keys = RANKINGS.map((block) => block.key)
    expect(new Set(keys).size).toBe(keys.length)
    // The same keys as `RANKINGS` in analytics/src/db.ts: a key that
    // diverged would show a panel that is always empty.
    expect(keys).toEqual([
      "chemin",
      "entree",
      "source",
      "campagne",
      "appareil",
      "navigateur",
      "systeme",
      "langue",
      "host",
    ])
  })
})
