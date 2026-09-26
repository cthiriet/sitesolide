import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { db, recordView, type ViewToWrite } from "../src/db";
import { HOSTS_FILE, forget } from "../src/hosts";
import { compose, write, DAYS, type Snapshot } from "../src/snapshot";

/**
 * The snapshot is the only thing this service returns to a human, by way of the
 * collector and the dashboard. What is tested here: that it carries the
 * expected counts, that it shows a site that has not yet received anybody, and
 * above all that no visitor fingerprint comes out of it.
 */
const NOW = Date.parse("2026-09-20T10:00:00Z");
const DAY = "2026-09-20";

function view(modifications: Partial<ViewToWrite> = {}): ViewToWrite {
  return {
    viewedAt: NOW,
    site: "vineyard",
    host: "vineyard.test",
    day: DAY,
    path: "/",
    visitor: "fingerprint-very-recognisable",
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

function declarer(table: Record<string, string>): void {
  writeFileSync(HOSTS_FILE, `${JSON.stringify({ hosts: table })}\n`);
  forget();
}

beforeEach(() => {
  db.run("DELETE FROM vues");
  declarer({ "vineyard.test": "vineyard", "vineyard.test-zone.invalid": "vineyard" });
});

afterEach(() => {
  rmSync(HOSTS_FILE, { force: true });
  forget();
});

describe("compose", () => {
  test("carries the window and its clock", () => {
    const snapshot = compose(NOW);
    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.days).toBe(DAYS);
    expect(snapshot.to).toBe(DAY);
    expect(snapshot.timeZone).toBe("Europe/Paris");
  });

  test("shows a declared site that has not yet received anybody", () => {
    // It is the question of the first days: is the tag properly placed? A site
    // absent from the dashboard would answer neither yes nor no.
    const site = compose(NOW).sites.vineyard;
    expect(site?.totals).toEqual({
      views: 0,
      visits: 0,
      bounces: 0,
      timedViews: 0,
      seconds: 0,
    });
    expect(site?.days).toHaveLength(DAYS);
  });

  test("adds up the hosts of one same site", () => {
    recordView(view({ host: "vineyard.test" }));
    recordView(view({ host: "vineyard.test-zone.invalid", visitor: "other" }));

    expect(compose(NOW).sites.vineyard?.totals.views).toBe(2);
  });

  test("returns the whole curve, empty days included", () => {
    // The database carries a row only for the days that received somebody: a
    // curve that skipped them would bring two points a week apart together and
    // would give it a slope it does not have.
    recordView(view());
    const days = compose(NOW).sites.vineyard?.days ?? [];
    expect(days).toHaveLength(DAYS);
    expect(days[DAYS - 1]).toEqual({ day: DAY, views: 1, visits: 1 });
    expect(days[0]).toEqual({ day: "2026-08-22", views: 0, visits: 0 });
  });

  test("carries every ranking the database can return", () => {
    recordView(view());
    const rankings = compose(NOW).sites.vineyard?.rankings ?? {};
    for (const key of ["chemin", "entree", "source", "campagne", "langue", "appareil", "navigateur", "systeme", "hote"]) {
      expect(rankings[key]).toBeDefined();
    }
    expect(rankings.source).toEqual([{ value: "Google", total: 1 }]);
  });

  test("ignores a site none of whose hosts is served", () => {
    // Page views can stay in the database after a site has left the machine:
    // they no longer go up to the dashboard, which no longer knows that site.
    recordView(view({ site: "gone", host: "gone.test" }));
    expect(compose(NOW).sites.gone).toBeUndefined();
  });

  test("lets no visitor fingerprint out", () => {
    // It is the service's promise, and this is where it could break without a
    // sound: this file leaves the database, passes under root, and ends up in a
    // page. It must carry counts only.
    recordView(view());
    const plainText = JSON.stringify(compose(NOW));
    expect(plainText).not.toContain("fingerprint-very-recognisable");
    expect(plainText).not.toContain("visitor");
    expect(plainText).not.toContain("token");
  });
});

describe("write", () => {
  const path = join(DATA_DIR, "sample-snapshot.json");

  afterEach(() => rmSync(path, { force: true }));

  test("drops a JSON document that can be read back", async () => {
    recordView(view());
    await write(path, NOW);

    const readBack = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    expect(readBack.sites.vineyard?.totals.views).toBe(1);
  });

  test("leaves no temporary file behind it", async () => {
    // The drop goes through a rename, which is atomic: the collector sees the
    // old file or the new one, never half a file.
    await write(path, NOW);
    expect(() => readFileSync(`${path}.tmp`, "utf8")).toThrow();
  });

  test("replaces the previous drop", async () => {
    await write(path, NOW);
    recordView(view());
    await write(path, NOW);

    const readBack = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    expect(readBack.sites.vineyard?.totals.views).toBe(1);
  });
});
