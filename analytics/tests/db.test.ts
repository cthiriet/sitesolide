import { beforeEach, describe, expect, test } from "bun:test";
import {
  attachDuration,
  rank,
  db,
  recordView,
  state,
  daysOf,
  purge,
  purgeSalts,
  saltOfDay,
  totalsOf,
  type ViewToWrite,
} from "../src/db";
import { DATA_DIR } from "../src/config";

// tests/setup.ts must have diverted DATA_DIR before any import.
if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const DAY = "2026-09-20";
const YESTERDAY = "2026-09-19";

function view(modifications: Partial<ViewToWrite> = {}): ViewToWrite {
  return {
    viewedAt: Date.parse(`${DAY}T10:00:00Z`),
    site: "vineyard",
    host: "vineyard.test",
    day: DAY,
    path: "/",
    visitor: "fingerprint-a",
    token: `token-${Math.random().toString(36).slice(2)}`,
    source: "Google",
    campaign: null,
    language: "fr",
    device: "mobile",
    browser: "Safari",
    system: "iOS",
    ...modifications,
  };
}

beforeEach(() => {
  db.run("DELETE FROM vues");
  db.run("DELETE FROM sels");
});

describe("the salts", () => {
  test("draws a salt once, and returns it as is afterwards", () => {
    // Two page views from the same millisecond would each draw a salt: keeping
    // two would cut the day into two sets of fingerprints, and would double the
    // visit count.
    expect(saltOfDay(DAY, () => "first")).toBe("first");
    expect(saltOfDay(DAY, () => "second")).toBe("first");
  });

  test("gives a different salt to each day", () => {
    expect(saltOfDay(DAY, () => "salt-today")).not.toBe(saltOfDay(YESTERDAY, () => "salt-yesterday"));
  });

  test("destroys the salts older than the given date", () => {
    // It is the operation that makes the measurement anonymous: while a salt
    // exists, whoever holds the database can recompute an IP address's
    // fingerprint.
    saltOfDay(YESTERDAY, () => "salt-yesterday");
    saltOfDay(DAY, () => "salt-today");

    expect(purgeSalts(DAY)).toBe(1);
    expect(saltOfDay(DAY, () => "other")).toBe("salt-today");
    expect(saltOfDay(YESTERDAY, () => "fresh")).toBe("fresh");
  });
});

describe("writing a page view", () => {
  test("marks a visitor's first page view as an entry", () => {
    expect(recordView(view()).isEntry).toBe(true);
    expect(recordView(view({ path: "/pricing" })).isEntry).toBe(false);
  });

  test("opens one more visit the next day", () => {
    // A visit is one visitor for one day: the salt having changed, the same
    // person carries a different fingerprint anyway.
    expect(recordView(view()).isEntry).toBe(true);
    expect(recordView(view({ day: YESTERDAY })).isEntry).toBe(true);
  });

  test("counts two visitors as two visits", () => {
    recordView(view());
    recordView(view({ visitor: "fingerprint-b" }));
    expect(totalsOf("vineyard", DAY, DAY).visits).toBe(2);
  });
});

describe("the time spent", () => {
  test("attaches itself to the page view carrying the token", () => {
    const row = view({ token: "token-known" });
    recordView(row);

    expect(attachDuration("token-known", 42, 0)).toBe(true);
    expect(totalsOf("vineyard", DAY, DAY).seconds).toBe(42);
  });

  test("keeps the longest of the durations received", () => {
    // A tab hidden then resumed sends several: it is the last one that says the
    // time spent, and it is always the longest.
    recordView(view({ token: "token-known" }));
    attachDuration("token-known", 60, 0);
    attachDuration("token-known", 20, 0);
    expect(totalsOf("vineyard", DAY, DAY).seconds).toBe(60);
  });

  test("ignores an unknown token", () => {
    expect(attachDuration("never-seen", 42, 0)).toBe(false);
  });

  test("refuses to modify a page view older than the bound", () => {
    // Without it, a token replayed months later would modify an old page view.
    const row = view({ token: "token-old", viewedAt: 1000 });
    recordView(row);
    expect(attachDuration("token-old", 42, 5000)).toBe(false);
  });
});

describe("the totals", () => {
  beforeEach(() => {
    recordView(view());
    recordView(view({ path: "/pricing", token: "timer" }));
    recordView(view({ visitor: "fingerprint-b", source: "direct" }));
    attachDuration("timer", 30, 0);
  });

  test("counts the page views, the visits and the bounces", () => {
    const totals = totalsOf("vineyard", DAY, DAY);
    expect(totals.views).toBe(3);
    expect(totals.visits).toBe(2);
    // Visitor b saw a single page: that one is the bounce.
    expect(totals.bounces).toBe(1);
  });

  test("averages the time only over the timed page views", () => {
    // A browser killed outright sends no departure signal: counting those page
    // views as zero would drag the average down for no reason.
    const totals = totalsOf("vineyard", DAY, DAY);
    expect(totals.timedViews).toBe(1);
    expect(totals.seconds).toBe(30);
  });

  test("does not count what is outside the window", () => {
    recordView(view({ day: "2026-08-01", viewedAt: Date.parse("2026-08-01T10:00:00Z") }));
    expect(totalsOf("vineyard", DAY, DAY).views).toBe(3);
    expect(totalsOf("vineyard", "2026-08-01", DAY).views).toBe(4);
  });

  test("does not mix two sites", () => {
    recordView(view({ site: "other", host: "other.test" }));
    expect(totalsOf("vineyard", DAY, DAY).views).toBe(3);
    expect(totalsOf("other", DAY, DAY).views).toBe(1);
  });

  test("returns zeros for a site with no page view", () => {
    const totals = totalsOf("unknown", DAY, DAY);
    expect(totals).toEqual({
      views: 0,
      visits: 0,
      bounces: 0,
      timedViews: 0,
      seconds: 0,
    });
  });
});

describe("the rankings", () => {
  beforeEach(() => {
    // Visitor a: two pages, came from Google. Visitor b: one page, direct.
    recordView(view({ path: "/" }));
    recordView(view({ path: "/pricing" }));
    recordView(view({ visitor: "fingerprint-b", path: "/pricing", source: "direct" }));
  });

  test("counts the pages in page views", () => {
    expect(rank("chemin", "vineyard", DAY, DAY, 10)).toEqual([
      { value: "/pricing", total: 2 },
      { value: "/", total: 1 },
    ]);
  });

  test("counts the referrers in visits, on entries only", () => {
    // The source of a visit is that of its first step: counting every page view
    // would give Google twice for a single visit.
    expect(rank("source", "vineyard", DAY, DAY, 10)).toEqual([
      { value: "Google", total: 1 },
      { value: "direct", total: 1 },
    ]);
  });

  test("counts the landing pages on entries, not on every page view", () => {
    expect(rank("entree", "vineyard", DAY, DAY, 10)).toEqual([
      { value: "/", total: 1 },
      { value: "/pricing", total: 1 },
    ]);
  });

  test("counts the devices in distinct visitors, not in page views", () => {
    // Otherwise a visitor who reads three pages would weigh three times more
    // than another in the breakdown of hardware.
    expect(rank("appareil", "vineyard", DAY, DAY, 10)).toEqual([
      { value: "mobile", total: 2 },
    ]);
  });

  test("leaves an absent campaign aside", () => {
    expect(rank("campagne", "vineyard", DAY, DAY, 10)).toEqual([]);
  });

  test("counts the languages in distinct visitors", () => {
    recordView(view({ visitor: "fingerprint-c", language: "en" }));
    expect(rank("langue", "vineyard", DAY, DAY, 10)).toEqual([
      { value: "fr", total: 2 },
      { value: "en", total: 1 },
    ]);
  });

  test("leaves an absent language aside rather than counting an empty row", () => {
    // The browser always sends one, but the body comes from a page: it can be
    // missing, and the dashboard must not show a row with no name.
    db.run("DELETE FROM vues");
    recordView(view({ language: null }));
    expect(rank("langue", "vineyard", DAY, DAY, 10)).toEqual([]);
  });

  test("respects the requested limit", () => {
    expect(rank("chemin", "vineyard", DAY, DAY, 1)).toHaveLength(1);
  });
});

describe("the curve", () => {
  test("returns one row per day that carries a page view", () => {
    recordView(view());
    recordView(view({ day: YESTERDAY, visitor: "fingerprint-yesterday" }));

    expect(daysOf("vineyard", YESTERDAY, DAY)).toEqual([
      { day: YESTERDAY, views: 1, visits: 1 },
      { day: DAY, views: 1, visits: 1 },
    ]);
  });

});

describe("the purge", () => {
  test("erases what goes beyond the retention", async () => {
    const now = Date.parse("2026-09-20T10:00:00Z");
    recordView(view({ viewedAt: now - 40 * 86_400_000, day: "2026-08-11" }));
    recordView(view({ viewedAt: now, visitor: "fingerprint-b" }));

    const result = await purge(now, 30 * 86_400_000, 1_000_000, "2026-09-18");
    expect(result.byAge).toBe(1);
    expect(state().views).toBe(1);
  });

  test("erases what goes beyond the ceiling, even if recent", async () => {
    // Four hundred days bound nothing if a site is pounded: all those page
    // views are recent.
    const now = Date.parse("2026-09-20T10:00:00Z");
    for (let i = 0; i < 5; i++) {
      recordView(view({ viewedAt: now, visitor: `fingerprint-${i}` }));
    }

    const result = await purge(now, 400 * 86_400_000, 2, "2026-09-18");
    expect(result.byCount).toBe(3);
    expect(state().views).toBe(2);
  });

  test("erases the expired salts on every pass", async () => {
    saltOfDay("2026-09-17", () => "old");
    saltOfDay(DAY, () => "fresh");

    const result = await purge(Date.parse(`${DAY}T10:00:00Z`), 400 * 86_400_000, 1_000_000, "2026-09-18");
    expect(result.salts).toBe(1);
    expect(state().salts).toBe(1);
  });

  test("cuts the deletion into batches", async () => {
    const now = Date.parse("2026-09-20T10:00:00Z");
    for (let i = 0; i < 7; i++) {
      recordView(view({ viewedAt: now - 500 * 86_400_000, day: "2025-05-09", visitor: `v-${i}` }));
    }

    // A batch of two forces several rounds: it is that cutting up which bounds
    // the duration of the write lock and the size of the WAL journal.
    const result = await purge(now, 400 * 86_400_000, 1_000_000, "2026-09-18", 2);
    expect(result.byAge).toBe(7);
    expect(state().views).toBe(0);
  });
});
