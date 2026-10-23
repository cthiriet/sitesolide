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
      orderAgreed: true,
    });
    expect(plan).toEqual({
      kind: "plan",
      sources: ["nis2-ses.env", "nis2-stripe.env"],
      skipped: [],
      merged: ["AWS_ACCESS_KEY_ID"],
      already: ["AWS_REGION"],
      overridden: ["STRIPE_SECRET_KEY"],
      shadowed: [],
      conflicts: [],
      writes: [["AWS_ACCESS_KEY_ID", SECRET_A]],
    });
  });

  test("two files with one name and different values: the value in effect, the last file's, is merged, the other said by name and file, never a value (I-3)", () => {
    const sources = [managed("nis2-ses.env", { AWS_SECRET_ACCESS_KEY: SECRET_A, A: "1" }), managed("nis2-stats.env", { AWS_SECRET_ACCESS_KEY: SECRET_B, B: "2" })];
    const plan = planMigration({ sources, store: new Map(), keyRefusal, orderAgreed: true });
    expect(plan).toEqual({
      kind: "plan",
      sources: ["nis2-ses.env", "nis2-stats.env"],
      skipped: [],
      merged: ["AWS_SECRET_ACCESS_KEY", "A", "B"],
      already: [],
      overridden: [],
      shadowed: [{ name: "AWS_SECRET_ACCESS_KEY", kept: "nis2-stats.env", others: ["nis2-ses.env"] }],
      conflicts: [],
      writes: [
        ["AWS_SECRET_ACCESS_KEY", SECRET_B],
        ["A", "1"],
        ["B", "2"],
      ],
    });
    if (plan.kind !== "plan") return;
    const { writes: _writes, ...answered } = plan;
    expect(JSON.stringify(answered)).not.toContain(SECRET_A);
    expect(JSON.stringify(answered)).not.toContain(SECRET_B);
    // Against a store that already took the value in effect: already, nothing to write.
    const again = planMigration({ sources, store: new Map([["AWS_SECRET_ACCESS_KEY", SECRET_B], ["A", "1"], ["B", "2"]]), keyRefusal, orderAgreed: true });
    expect(again).toMatchObject({ kind: "plan", already: ["AWS_SECRET_ACCESS_KEY", "A", "B"], writes: [] });
  });

  test("the units disagreeing on the order: no value is in effect for every service, and a duplicate refuses everything", () => {
    const sources = [managed("a.env", { KEY: SECRET_A, SAME: "1" }), managed("b.env", { KEY: SECRET_B, SAME: "1" })];
    const plan = planMigration({ sources, store: new Map(), keyRefusal, orderAgreed: false });
    expect(plan).toMatchObject({ kind: "plan", conflicts: [{ name: "KEY", files: ["a.env", "b.env"] }], shadowed: [], merged: ["SAME"], writes: [] });
    // With no duplicate that differs, the order does not matter.
    expect(planMigration({ sources: [managed("a.env", { A: "1" }), managed("b.env", { B: "2" })], store: new Map(), keyRefusal, orderAgreed: false })).toMatchObject({
      conflicts: [],
      writes: [
        ["A", "1"],
        ["B", "2"],
      ],
    });
  });

  test("equal values in two files merge once", () => {
    const plan = planMigration({ sources: [managed("a.env", { REGION: "eu" }), managed("b.env", { REGION: "eu" })], store: new Map(), keyRefusal, orderAgreed: true });
    expect(plan).toMatchObject({ kind: "plan", merged: ["REGION"], conflicts: [], writes: [["REGION", "eu"]] });
  });

  test("idempotent: once merged, a second plan writes nothing", () => {
    const sources = [managed("a.env", { A: SECRET_A, B: SECRET_B })];
    const first = planMigration({ sources, store: new Map(), keyRefusal, orderAgreed: true });
    if (first.kind !== "plan") throw new Error("refused");
    const second = planMigration({ sources, store: new Map(first.writes), keyRefusal, orderAgreed: true });
    expect(second).toMatchObject({ kind: "plan", merged: [], already: ["A", "B"], writes: [] });
  });

  test("an absent source is skipped and said; one that is not managed refuses everything, with its reason", () => {
    const plan = planMigration({ sources: [{ file: "gone.env", state: "absent" }, managed("a.env", { A: "1" })], store: new Map(), keyRefusal, orderAgreed: true });
    expect(plan).toMatchObject({ kind: "plan", skipped: [{ file: "gone.env", reason: "absent" }], sources: ["a.env"] });
    const refused = planMigration({
      sources: [managed("a.env", { A: "1" }), { file: "b.env", state: "unmanaged", reason: "mode 644, expected 600: sudo chmod 600 /etc/sitesolide/b.env" }],
      store: new Map(),
      keyRefusal,
      orderAgreed: true,
    });
    expect(refused).toEqual({
      kind: "refused",
      refusal: { error: "unmanaged", message: "b.env is not managed here: mode 644, expected 600: sudo chmod 600 /etc/sitesolide/b.env; fix it, then migrate again" },
    });
  });

  test("a name a store does not take refuses everything, naming the file and the names, with a remedy that keeps what the service runs with", () => {
    const reserved = (name: string) => checkKey(name);
    const setElsewhere = new Set(["NODE_ENV", "DEFAULT_SENDER", "PORT"]);
    const refused = (values: Record<string, string>) => planMigration({ sources: [managed("a.env", values)], store: new Map(), keyRefusal: reserved, setElsewhere, orderAgreed: true });
    // A name no store holds: its value is in effect, and removing it changes that.
    expect(refused({ A: "1", PASSWORD_HASH: "$argon2id$x" })).toEqual({
      kind: "refused",
      refusal: {
        error: "invalid",
        message:
          "a.env holds PASSWORD_HASH, which a store never holds: the file's value is the one the service runs with, and removing it from a.env changes that. Move it to the manifest's env if it belongs there, deploy, then remove it from a.env and migrate again",
      },
    });
    // A name the env or the unit sets too: the file's value wins over it; dropping it from the file would switch the service to the env's.
    expect(refused({ DEFAULT_SENDER: SECRET_A, A: "1" })).toEqual({
      kind: "refused",
      refusal: {
        error: "invalid",
        message:
          "a.env holds DEFAULT_SENDER, which the project's env or its unit sets too: the file's value, read after, is the one the service runs with, and a store takes no name its unit sets. Drop it from the manifest's env (or the unit) and deploy, then migrate again: the store keeps its value from a.env. Removing it from a.env instead would switch the service to the env's value",
      },
    });
    // Both at once, plural, a reserved name the env sets counted as set elsewhere; never a value.
    const both = refused({ NODE_ENV: "staging", DEFAULT_SENDER: SECRET_A, NODE_OPTIONS: "--x", PATH: "/x" });
    expect(both.kind === "refused" && both.refusal.message).toBe(
      "a.env holds NODE_ENV, DEFAULT_SENDER, which the project's env or its unit sets too: the file's values, read after, are the ones the service runs with, and a store takes no name its unit sets. Drop them from the manifest's env (or the unit) and deploy, then migrate again: the store keeps their values from a.env. Removing them from a.env instead would switch the service to the env's value. a.env holds NODE_OPTIONS, PATH, which a store never holds: the file's values are the ones the service runs with, and removing them from a.env changes that. Move them to the manifest's env if they belong there, deploy, then remove them from a.env and migrate again",
    );
    expect(JSON.stringify(both)).not.toContain(SECRET_A);
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
    read: true,
    force: false,
    unitsReadStore: true,
    allScheduled: false,
    main: { active: true, startedUs: (T + 1000) * 1000 },
    envModifiedMs: T,
    slug: "nis2",
  };

  test("passing all five rules, it goes", () => {
    expect(retireDecision(passing)).toEqual({ retire: true, forced: false });
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
      [{ store: new Map([["A", "another"]]) }, "not covered: the value of A differs from the store's, which is the one in effect; retire it with force to let the store's value stand alone"],
      [{ store: new Map(), force: true }, "not covered: A is not in the store; sitesolide secrets migrate first"],
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
    expect(retireDecision({ ...passing, state: { kind: "managed", assignments: [] }, store: null, main: { active: false, startedUs: null }, envModifiedMs: null })).toEqual({ retire: true, forced: false });
    expect(retireDecision({ ...passing, allScheduled: true, main: { active: false, startedUs: null } })).toEqual({ retire: true, forced: false });
    // The units must still read the store.
    expect(retireDecision({ ...passing, state: { kind: "managed", assignments: [] }, unitsReadStore: false })).toMatchObject({ retire: false });
  });
});

describe("retiring a file the store does not match, at the owner's explicit choice (I-5)", () => {
  const T = 1_800_000_000_000;
  const base: RetireInput = {
    file: "shop-old.env",
    attached: true,
    flat: true,
    variables: true,
    machine: false,
    state: { kind: "managed", assignments: [["API_KEY", SECRET_A], ["OLD_ONLY", "x"]] },
    read: false,
    force: true,
    store: new Map([["API_KEY", SECRET_B]]),
    unitsReadStore: true,
    allScheduled: false,
    main: { active: true, startedUs: (T + 1000) * 1000 },
    envModifiedMs: T,
    slug: "shop",
  };

  test("forced, a value that differs gives way to the store's, and a name no unit reads goes with its file", () => {
    expect(retireDecision(base)).toEqual({ retire: true, forced: true });
    // Without force, kept as before.
    expect(retireDecision({ ...base, force: false })).toMatchObject({ retire: false, reason: expect.stringContaining("retire it with force") });
  });

  test("forced, a file a unit reads still keeps a name the store lacks: that value would leave the service", () => {
    expect(retireDecision({ ...base, read: true })).toEqual({ retire: false, reason: "not covered: OLD_ONLY is not in the store; sitesolide secrets migrate first" });
    expect(retireDecision({ ...base, read: true, state: { kind: "managed", assignments: [["API_KEY", SECRET_A]] } })).toEqual({ retire: true, forced: true });
  });

  test("force waives coverage alone: every other rule still holds", () => {
    expect(retireDecision({ ...base, unitsReadStore: false })).toMatchObject({ retire: false });
    expect(retireDecision({ ...base, main: { active: true, startedUs: T * 1000 } })).toMatchObject({ retire: false });
    expect(retireDecision({ ...base, state: { kind: "unmanaged", reason: "owned by uid 1001, not site-shop" } })).toMatchObject({ retire: false });
    expect(retireDecision({ ...base, attached: false })).toMatchObject({ retire: false });
    // A file the store covers needs no force: not said forced.
    expect(retireDecision({ ...base, state: { kind: "managed", assignments: [["API_KEY", SECRET_B]] } })).toEqual({ retire: true, forced: false });
  });
});
