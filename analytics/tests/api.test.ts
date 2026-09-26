import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { contextOf, measure, cleanUp } from "../src/api";
import { TIME_ZONE, MAX_DURATION_S, VIEWS_PER_MINUTE } from "../src/config";
import { db, state, saltOfDay } from "../src/db";
import { forgetAll } from "../src/rate";
import { HOSTS_FILE, forget } from "../src/hosts";
import { computeFingerprint } from "../src/fingerprint";
import { dayOf } from "../src/day";

const NOW = Date.parse("2026-09-20T10:00:00Z");
const DAY = dayOf(NOW, TIME_ZONE);

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const context = (modifications: Partial<Parameters<typeof measure>[1]> = {}) => ({
  now: NOW,
  ip: "203.0.113.9",
  agent: USER_AGENT,
  ...modifications,
});

const view = (modifications: Record<string, unknown> = {}) =>
  JSON.stringify({
    h: "vineyard.test",
    p: "/pricing",
    r: "https://www.google.com/",
    s: null,
    c: null,
    w: 390,
    j: "sample-token",
    ...modifications,
  });

/** The rows written, as they are in the database. */
function rows() {
  return db
    .query<Record<string, unknown>, []>("SELECT * FROM vues ORDER BY id")
    .all();
}

/** The allow list is a file dropped by the collector, not a table. */
function declarer(table: Record<string, string>): void {
  writeFileSync(HOSTS_FILE, `${JSON.stringify({ hosts: table })}\n`);
  forget();
}

beforeEach(() => {
  db.run("DELETE FROM vues");
  db.run("DELETE FROM sels");
  forgetAll();
  declarer({ "vineyard.test": "vineyard" });
});

afterEach(() => {
  rmSync(HOSTS_FILE, { force: true });
  forget();
});

describe("measure: what comes in", () => {
  test("writes a page view and returns 204 with no body", () => {
    const response = measure(view(), context());
    expect(response.status).toBe(204);

    const [row] = rows();
    // The keys are the columns of `vues`, which keep their original names.
    expect(row).toMatchObject({
      site: "vineyard",
      hote: "vineyard.test",
      chemin: "/pricing",
      jour: DAY,
      source: "Google",
      appareil: "mobile",
      navigateur: "Safari",
      systeme: "iOS",
      entree: 1,
      duree_s: 0,
    });
  });

  test("writes neither the address nor the agent, only a fingerprint", () => {
    // It is the promise made to the visitors of measured sites, and it is
    // checked row by row: no column must carry what served the calculation.
    measure(view(), context());
    const [row] = rows();
    const values = Object.values(row ?? {}).map(String);

    expect(values.some((v) => v.includes("203.0.113.9"))).toBe(false);
    expect(values.some((v) => v.includes("iPhone"))).toBe(false);
    expect(row?.visiteur).toBe(
      computeFingerprint(saltOfDay(DAY, () => "never"), "vineyard.test", "203.0.113.9", USER_AGENT),
    );
  });

  test("attaches the time spent to the page view carrying the token", () => {
    measure(view(), context());
    measure(JSON.stringify({ j: "sample-token", d: 42 }), context());
    expect(rows()[0]?.duree_s).toBe(42);
  });

  test("truncates an outsized duration rather than discarding the view", () => {
    // A tab left open all night would on its own shift the average of the whole
    // site.
    measure(view(), context());
    measure(JSON.stringify({ j: "sample-token", d: 86_400 }), context());
    expect(rows()[0]?.duree_s).toBe(MAX_DURATION_S);
  });
});

describe("measure: what is refused", () => {
  /** Every refusal answers like a success: nobody reads that response. */
  const refuse = (body: string, ctx = context()) => {
    expect(measure(body, ctx).status).toBe(204);
    expect(rows()).toHaveLength(0);
  };

  test("a host absent from the allow list writes nothing", () => {
    // Without that list, any page on the web could copy the script and fill
    // this database.
    refuse(view({ h: "pirate.example" }));
  });

  test("a bot that runs the script is not counted", () => {
    refuse(view(), context({ agent: "Mozilla/5.0 (compatible; Googlebot/2.1)" }));
  });

  test("a body that is not JSON writes nothing", () => {
    refuse("not json");
    refuse("");
    refuse("[1,2,3]");
  });

  test("a malformed field writes nothing", () => {
    refuse(view({ p: "no-slash" }));
    refuse(view({ j: "" }));
    refuse(view({ h: "not a host" }));
  });

  test("beyond the ceiling, the same visitor stops being counted", () => {
    for (let i = 0; i < VIEWS_PER_MINUTE; i++) {
      measure(view({ j: `token-${i}` }), context());
    }
    expect(rows()).toHaveLength(VIEWS_PER_MINUTE);

    measure(view({ j: "too-many" }), context());
    expect(rows()).toHaveLength(VIEWS_PER_MINUTE);
  });

  test("the ceiling does not get in another visitor's way", () => {
    for (let i = 0; i < VIEWS_PER_MINUTE + 5; i++) {
      measure(view({ j: `token-${i}` }), context());
    }
    measure(view({ j: "other-visitor" }), context({ ip: "198.51.100.4" }));
    expect(rows()).toHaveLength(VIEWS_PER_MINUTE + 1);
  });
});

describe("contextOf", () => {
  test("takes the address Caddy placed, not the one the visitor sends", () => {
    const req = new Request("http://localhost/e", {
      headers: { "x-forwarded-for": "192.0.2.1, 203.0.113.9", "user-agent": USER_AGENT },
    });
    expect(contextOf(req, "127.0.0.1", NOW).ip).toBe("203.0.113.9");
  });

  test("falls back on the peer's address when the header is missing", () => {
    const req = new Request("http://localhost/e");
    const ctx = contextOf(req, "127.0.0.1", NOW);
    expect(ctx.ip).toBe("127.0.0.1");
    expect(ctx.agent).toBe("");
  });
});

describe("cleanUp", () => {
  test("destroys the salts beyond the days kept", async () => {
    // Erasing the salts is not maintenance: it is what makes the measurement
    // anonymous.
    saltOfDay("2026-09-15", () => "very-old");
    saltOfDay(DAY, () => "fresh");

    const purge = await cleanUp(NOW);
    expect(purge.salts).toBe(1);
    expect(state().salts).toBe(1);
  });
});
