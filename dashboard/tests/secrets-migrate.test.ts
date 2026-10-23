import { describe, expect, test } from "bun:test";
import { checkKey } from "../borrowed/variables";
import { planMigration, retireDecision, type MigrationSource, type RetireInput } from "../src/secrets/migrate";

/**
 * Moving a project from its legacy files to its store, decided without a VM:
 * the merge, where two files that disagree refuse everything and nobody
 * sees a value, and the deletion of a legacy file, each of its five rules
 * failing alone. The steward applies them (tests/secrets-steward.test.ts).
 */

const SECRET_A = "value-of-a-legacy-file-91c2";
const SECRET_B = "another-value-of-it-5d07";

const managed = (file: string, values: Record<string, string>): MigrationSource => ({ file, state: "managed", assignments: Object.entries(values) });
const keyRefusal = (name: string) => checkKey(name, ["NODE_ENV", "DEFAULT_SENDER"]);

describe("the merge (spec §6.8)", () => {
  test("names the store lacks are merged, the same value is already there, another value is the store's and stays", () => {
    const plan = planMigration({
      sources: [managed("nis2-ses.env", { AWS_ACCESS_KEY_ID: SECRET_A, AWS_REGION: "eu-west-3" }), managed("nis2-stripe.env", { STRIPE_SECRET_KEY: SECRET_B })],
      store: new Map([
        ["AWS_REGION", "eu-west-3"],
        ["STRIPE_SECRET_KEY", "the-store-s-own"],
      ]),
      keyRefusal,
    });
    expect(plan).toEqual({
      kind: "plan",
      sources: ["nis2-ses.env", "nis2-stripe.env"],
      skipped: [],
      merged: ["AWS_ACCESS_KEY_ID"],
      already: ["AWS_REGION"],
      overridden: ["STRIPE_SECRET_KEY"],
      conflicts: [],
      writes: [["AWS_ACCESS_KEY_ID", SECRET_A]],
    });
  });

  test("two files with one name and different values: a conflict naming the name and the files, never a value; nothing to write", () => {
    const plan = planMigration({
      sources: [managed("nis2-ses.env", { AWS_SECRET_ACCESS_KEY: SECRET_A, A: "1" }), managed("nis2-stats.env", { AWS_SECRET_ACCESS_KEY: SECRET_B, B: "2" })],
      store: new Map(),
      keyRefusal,
    });
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    expect(plan.conflicts).toEqual([{ name: "AWS_SECRET_ACCESS_KEY", files: ["nis2-ses.env", "nis2-stats.env"] }]);
    expect(plan.writes).toEqual([]);
    // What else would merge is said, for the dry run.
    expect(plan.merged).toEqual(["A", "B"]);
    const { writes: _writes, ...answered } = plan;
    expect(JSON.stringify(answered)).not.toContain(SECRET_A);
    expect(JSON.stringify(answered)).not.toContain(SECRET_B);
  });

  test("equal values in two files merge once", () => {
    const plan = planMigration({ sources: [managed("a.env", { REGION: "eu" }), managed("b.env", { REGION: "eu" })], store: new Map(), keyRefusal });
    expect(plan).toMatchObject({ kind: "plan", merged: ["REGION"], conflicts: [], writes: [["REGION", "eu"]] });
  });

  test("idempotent: once merged, a second plan writes nothing", () => {
    const sources = [managed("a.env", { A: SECRET_A, B: SECRET_B })];
    const first = planMigration({ sources, store: new Map(), keyRefusal });
    if (first.kind !== "plan") throw new Error("refused");
    const second = planMigration({ sources, store: new Map(first.writes), keyRefusal });
    expect(second).toMatchObject({ kind: "plan", merged: [], already: ["A", "B"], writes: [] });
  });

  test("an absent source is skipped and said; one that is not managed refuses everything, with its reason", () => {
    const plan = planMigration({ sources: [{ file: "gone.env", state: "absent" }, managed("a.env", { A: "1" })], store: new Map(), keyRefusal });
    expect(plan).toMatchObject({ kind: "plan", skipped: [{ file: "gone.env", reason: "absent" }], sources: ["a.env"] });
    const refused = planMigration({
      sources: [managed("a.env", { A: "1" }), { file: "b.env", state: "unmanaged", reason: "mode 644, expected 600: sudo chmod 600 /etc/sitesolide/b.env" }],
      store: new Map(),
      keyRefusal,
    });
    expect(refused).toEqual({
      kind: "refused",
      refusal: { error: "unmanaged", message: "b.env is not managed here: mode 644, expected 600: sudo chmod 600 /etc/sitesolide/b.env; fix it, then migrate again" },
    });
  });

  test("PASSWORD_HASH, or a name the store refuses, refuses everything, naming the file and the names", () => {
    for (const [values, names] of [
      [{ A: "1", PASSWORD_HASH: "$argon2id$x" }, "PASSWORD_HASH"],
      [{ NODE_OPTIONS: "--x", DEFAULT_SENDER: "a@b.test", A: "1" }, "NODE_OPTIONS, DEFAULT_SENDER"],
    ] as const) {
      const plan = planMigration({ sources: [managed("a.env", { ...values })], store: new Map(), keyRefusal });
      expect(plan).toEqual({ kind: "refused", refusal: { error: "invalid", message: `a.env holds ${names}, which a store does not take: remove them from a.env first, then migrate again` } });
    }
  });
});

describe("retiring a legacy file (spec §6.9)", () => {
  const T = 1_800_000_000_000;
  const passing: RetireInput = {
    file: "nis2-ses.env",
    attached: true,
    flat: true,
    variables: true,
    machine: false,
    state: { kind: "managed", assignments: [["A", SECRET_A]] },
    store: new Map([["A", SECRET_A]]),
    unitsReadStore: true,
    allScheduled: false,
    main: { active: true, startedUs: (T + 1000) * 1000 },
    envModifiedMs: T,
    slug: "nis2",
  };

  test("passing all five rules, it goes", () => {
    expect(retireDecision(passing)).toEqual({ retire: true });
  });

  test("each rule failing alone keeps it, with its reason", () => {
    const cases: [Partial<RetireInput>, string][] = [
      [{ attached: false }, "not a legacy file of this project"],
      [{ flat: false }, "not a flat environment file: only those are retired"],
      [{ variables: false }, "not a flat environment file: only those are retired"],
      [{ machine: true }, "the machine's own file: never retired"],
      [{ state: { kind: "absent" } }, "absent: nothing to retire"],
      [{ state: { kind: "unmanaged", reason: "symbolic link" } }, "not managed here: symbolic link"],
      [{ store: new Map() }, "not covered: A is not in the store; sitesolide secrets migrate first"],
      [{ store: null }, "not covered: A is not in the store; sitesolide secrets migrate first"],
      [{ store: new Map([["A", "another"]]) }, "not covered: the value of A differs from the store's"],
      [{ unitsReadStore: false }, "not every unit of the project reads the store yet: sitesolide refresh nis2"],
      [{ main: { active: false, startedUs: (T + 1000) * 1000 } }, "the service is not active: its restart has to load the store first"],
      [{ main: { active: true, startedUs: T * 1000 } }, "the service has not restarted since the store was last written: restart it, then retire"],
      [{ main: { active: true, startedUs: null } }, "the service has not restarted since the store was last written: restart it, then retire"],
      [{ envModifiedMs: null }, "the service has not restarted since the store was last written: restart it, then retire"],
    ];
    for (const [change, reason] of cases) expect([change, retireDecision({ ...passing, ...change })]).toEqual([change, { retire: false, reason }]);
  });

  test("the reason never quotes a value", () => {
    const decision = retireDecision({ ...passing, store: new Map([["A", SECRET_B]]) });
    expect(JSON.stringify(decision)).not.toContain(SECRET_A);
    expect(JSON.stringify(decision)).not.toContain(SECRET_B);
  });

  test("an empty file is covered and needs no restart; an all-scheduled project needs none either", () => {
    expect(retireDecision({ ...passing, state: { kind: "managed", assignments: [] }, store: null, main: { active: false, startedUs: null }, envModifiedMs: null })).toEqual({ retire: true });
    expect(retireDecision({ ...passing, allScheduled: true, main: { active: false, startedUs: null } })).toEqual({ retire: true });
    // The units must still read the store.
    expect(retireDecision({ ...passing, state: { kind: "managed", assignments: [] }, unitsReadStore: false })).toMatchObject({ retire: false });
  });
});
