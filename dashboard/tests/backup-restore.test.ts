import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySnapshotName, snapshotName } from "../borrowed/backups";
import type { BackupConfig } from "../src/backup/config";
import { openDatabase, readAudit, readSnapshots } from "../src/backup/database";
import { takeLock } from "../src/backup/lock";
import { INCOMING, INTERRUPTED_REASON, PREVIOUS } from "../src/backup/recovery";
import { PORTAL_REFUSAL, encodeRequest } from "../src/backup/request";
import { STOPPED_SUFFIX, afterRestore, restore, type Command } from "../src/backup/restore";
import { runBackups } from "../src/backup/run";
import { ACCOUNTS, BALANCE, audit, cloneTree, createAccounts, dumped, NO_RESTIC, project, repositoryTemplate, restic, stored, tree } from "./backup-fixtures";

setDefaultTimeout(120_000);

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 4, 13, 0, 0);
const silent = () => undefined;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * systemd as the restore sees it: units that stop and start, and a service
 * that dies at start when its data folder holds a file named `broken`, the
 * way a service refuses a database it cannot read.
 */
function fakeSystemd(dataDir: string, units: string[]) {
  const state = new Map(units.map((unit) => [unit, "active"]));
  let restarts = 0;
  const calls: string[] = [];
  const systemctl = async (args: string[]): Promise<Command> => {
    calls.push(args.join(" "));
    const [verb, ...rest] = args;
    const unit = rest[0] ?? "";
    switch (verb) {
      case "show":
        if (args.includes("LoadState") && args.includes("--value")) return { code: 0, output: state.has(unit) ? "loaded\n" : "not-found\n" };
        if (!state.has(unit)) return { code: 0, output: "LoadState=not-found\n" };
        if (state.get(unit) === "looping") {
          restarts++;
          return { code: 0, output: `LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nNRestarts=${restarts}\nActiveEnterTimestamp=\n` };
        }
        return {
          code: 0,
          output: `LoadState=loaded\nActiveState=${state.get(unit) === "active" ? "active" : "inactive"}\nSubState=${state.get(unit) === "active" ? "running" : "dead"}\nNRestarts=0\nActiveEnterTimestamp=Sun 2026-10-04 13:00:00.000000 UTC\n`,
        };
      case "stop":
        for (const name of rest) if (state.has(name)) state.set(name, "inactive");
        return { code: 0, output: "" };
      case "start":
        for (const name of units) state.set(name, existsSync(join(dataDir, "broken")) ? (name === units[0] ? "looping" : "inactive") : "active");
        return { code: 0, output: "" };
      case "is-active":
        return { code: 0, output: `${state.get(unit) === "looping" ? "activating" : (state.get(unit) ?? "inactive")}\n` };
      case "reset-failed":
        return { code: 0, output: "" };
    }
    return { code: 1, output: "" };
  };
  return { systemctl, calls, state };
}

/** A fake clock that the restore's waits move forward, so that eight seconds of watching take none. */
function clock(start: number) {
  let current = start;
  return { now: () => current, wait: async (ms: number) => void (current += ms) };
}

/** The bucket's settings, its repository a copy of the template, whose key is the passphrase. */
function bucket(): Record<string, string> {
  const holder = mkdtempSync(join(tmpdir(), "backup-bucket-"));
  roots.push(holder);
  const repository = join(holder, "repository");
  cpSync(repositoryTemplate().repository, repository, { recursive: true });
  return {
    BACKUP_S3_ENDPOINT: "https://bucket.test-zone.invalid",
    BACKUP_S3_BUCKET: "backups",
    BACKUP_S3_ACCESS_KEY_ID: "AKIDRESTORE",
    BACKUP_S3_SECRET_ACCESS_KEY: "secret",
    BACKUP_ENCRYPTION_PASSPHRASE: readFileSync(repositoryTemplate().key, "utf8"),
    BACKUP_OFFSITE_REPOSITORY: repository,
  };
}

/** Bytes stored straight with restic as a snapshot of `folder` at `takenAt`: what a forged or mislabelled snapshot looks like. */
function storeAs(config: BackupConfig, folder: string, takenAt: number, file: string): void {
  const time = new Date(takenAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const made = restic(config, ["backup", "-q", "--host", "sitesolide", "--tag", "scheduled", "--time", time, "--stdin-filename", `${folder}.tar`, "--stdin-from-command", "--", "cat", file]);
  if (made.code !== 0) throw new Error(made.stderr);
}

/** Forgets a snapshot from the server's repository, as retention would. */
function forget(config: BackupConfig, folder: string, name: string): void {
  const found = stored(config).find((snapshot) => snapshot.folder === folder && snapshot.name === name)!;
  expect(restic(config, ["forget", "-q", found.id]).code).toBe(0);
}

type Prepared = Awaited<ReturnType<typeof prepareFresh>>;

/** The machine every test without a bucket starts from, made once and copied: a run is its costliest part. */
let seeded: Promise<Prepared> | null = null;

/**
 * A machine with `cms`, two services, a database and an upload, snapshotted at
 * T - 2h, then changed: a copy of one made once per file, or, with settings of
 * its own (a bucket's), one made for the test.
 */
async function prepared(extra: Record<string, string> = {}): Promise<Prepared> {
  if (Object.keys(extra).length > 0) return prepareFresh(extra);
  seeded ??= prepareFresh({});
  const base = await seeded;
  const made = cloneTree(base);
  roots.push(made.root);
  return { ...made, data: join(made.sites, "cms", "data"), snapshot: base.snapshot };
}

async function prepareFresh(extra: Record<string, string>) {
  const made = tree(extra);
  roots.push(made.root);
  const data = project(made.sites, "cms", { services: { web: { start: "bun web.ts", port: 3040 }, worker: { start: "bun worker.ts", port: 3041, internal: true } }, publicDir: "public" });
  createAccounts(join(data, "app.db"), 100);
  writeFileSync(join(data, "upload.txt"), "the version of two hours ago");
  const run = await runBackups({ config: made.config, now: () => T - 2 * HOUR, log: silent });
  expect(run.projects.cms?.ok).toBe(true);
  const snapshot = snapshotName("cms", T - 2 * HOUR, "scheduled");

  // Since then, the data changed: a row deleted, the upload rewritten.
  const db = new Database(join(data, "app.db"));
  db.run("DELETE FROM accounts WHERE id <= 10");
  db.close();
  writeFileSync(join(data, "upload.txt"), "the version of now");
  return { ...made, data, snapshot };
}

function request(stateFolder: string, folder: string, snapshot: string, requestedAt: number, actor = "owner") {
  mkdirSync(join(stateFolder, "requests"), { recursive: true });
  writeFileSync(join(stateFolder, "requests", `${folder}.json`), encodeRequest({ nonce: "0123456789abcdef", snapshot, actor, requestedAt }), { mode: 0o600 });
}

const UNITS = ["cms", "cms.worker.service"];

describe.concurrent.skipIf(NO_RESTIC)("a restore", () => {
  test("puts the snapshot in place, keeps the data it replaced, and records who asked", async () => {
    const { root, config, data, snapshot } = await prepared();
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T, "alice@test-zone.invalid");

    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.message).toContain("Restored cms from the snapshot of 2026-10-04 11:00 UTC");
    expect(result).toMatchObject({ state: "ok", snapshot, preRestore: snapshotName("cms", T, "pre-restore"), actor: "alice@test-zone.invalid", nonce: "0123456789abcdef" });

    // The data of two hours ago, sound.
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of two hours ago");
    expect(audit(join(data, "app.db"))).toEqual({ total: ACCOUNTS * BALANCE, rows: ACCOUNTS, integrity: "ok" });
    // Stopped, then started and watched: in that order, every unit.
    expect(systemd.calls.indexOf("stop cms cms.worker.service")).toBeGreaterThan(-1);
    expect(systemd.calls.indexOf("start cms")).toBeGreaterThan(systemd.calls.indexOf("stop cms cms.worker.service"));
    expect(systemd.calls).toContain("is-active cms.worker.service");
    // Nothing left beside the data, the request consumed, the lock released.
    expect(readdirSync(join(root, "sites", "cms")).sort()).toEqual(["data", "sitesolide.json"]);
    // The before-restore snapshot is in the repository, and in the index the page reads.
    expect(stored(config).map((snapshot) => snapshot.name)).toContain(snapshotName("cms", T, "pre-restore"));
    expect(existsSync(join(config.stateFolder, "requests", "cms.json"))).toBe(false);
    expect(existsSync(join(config.runFolder, "lock"))).toBe(false);
    // The result the steward reads, root's and readable.
    expect(JSON.parse(readFileSync(join(config.runFolder, "restore", "cms.json"), "utf8"))).toMatchObject({ state: "ok" });
    const db = openDatabase(join(config.stateFolder, "backup.db"));
    expect(readSnapshots(db, "local", "cms").map((row) => row.name)).toContain(snapshotName("cms", T, "pre-restore"));
    expect(readAudit(db, "cms", 1)[0]).toMatchObject({
      actor: "alice@test-zone.invalid",
      action: "backup.restore",
      target: "cms",
      detail: { result: "ok", snapshot, preRestore: snapshotName("cms", T, "pre-restore") },
    });
    db.close();
  });

  test("can itself be undone: its before-restore snapshot holds the data it replaced", async () => {
    const { config, data, snapshot } = await prepared();
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T);
    const first = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(first.state).toBe("ok");

    time.wait(60_000);
    request(config.stateFolder, "cms", first.preRestore!, time.now());
    const undo = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(undo.state).toBe("ok");
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of now");
    expect(audit(join(data, "app.db")).rows).toBe(ACCOUNTS - 10);
  });

  test("a service that does not come back on the restored data gets its previous data back", async () => {
    const { root, config, data, snapshot } = await prepared();
    // The snapshot to restore carries the marker that makes the service die.
    writeFileSync(join(data, "broken"), "");
    await runBackups({ config, now: () => T - HOUR, log: silent });
    unlinkSync(join(data, "broken"));
    const brokenSnapshot = snapshotName("cms", T - HOUR, "scheduled");
    expect(brokenSnapshot).not.toBe(snapshot);

    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", brokenSnapshot, T);
    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.state).toBe("failure");
    expect(result.message).toContain("cms did not start on the restored data (cms looping");
    expect(result.message).toContain("The previous data is back and cms is running again.");
    // The data from before the restore, exactly: not the snapshot's, not a mix.
    expect(existsSync(join(data, "broken"))).toBe(false);
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of now");
    expect(audit(join(data, "app.db")).rows).toBe(ACCOUNTS - 10);
    expect(systemd.state.get("cms")).toBe("active");
    expect(readdirSync(join(root, "sites", "cms")).sort()).toEqual(["data", "sitesolide.json"]);
  });

  test("a snapshot that does not extract changes nothing, and stops nothing", async () => {
    const { config, data, root } = await prepared();
    const forged = snapshotName("cms", T - 30 * 60_000, "scheduled");
    writeFileSync(join(root, "garbage"), "not a tar at all");
    storeAs(config, "cms", T - 30 * 60_000, join(root, "garbage"));
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", forged, T);
    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.state).toBe("rejects");
    expect(result.message).toContain("the snapshot could not be extracted, nothing was changed");
    expect(systemd.calls.filter((call) => call.startsWith("stop"))).toEqual([]);
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of now");
    expect(existsSync(join(config.sitesDir, "cms", INCOMING))).toBe(false);
  });

  test("fetches from the bucket's repository a snapshot the server no longer has, through a download child", async () => {
    const settings = bucket();
    const { config, data, snapshot } = await prepared(settings);
    expect(stored(config, settings.BACKUP_OFFSITE_REPOSITORY).map((s) => s.name)).toContain(snapshot);
    forget(config, "cms", snapshot);
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T);
    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.state).toBe("ok");
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of two hours ago");
    // What the Activity page reads of the audit names the snapshot, never a credential.
    const db = openDatabase(join(config.stateFolder, "backup.db"), { reader: true });
    const handed = JSON.stringify(readAudit(db, null, 50));
    db.close();
    expect(handed).toContain("backup.restore");
    for (const value of ["AKIDRESTORE", settings.BACKUP_ENCRYPTION_PASSPHRASE!]) expect(handed).not.toContain(value);
  });

  test("an archive of the format before restic, named by an older steward, is restored from its imported copy", async () => {
    const { config, data } = await prepared();
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", legacySnapshotName("cms", T - 2 * HOUR, "scheduled"), T);
    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.state).toBe("ok");
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of two hours ago");
  });

  test("a project with no unit, its data swapped all the same", async () => {
    const { config, data, snapshot } = await prepared();
    const systemd = fakeSystemd(data, []);
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T);
    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.state).toBe("ok");
    expect(systemd.calls.filter((call) => !call.startsWith("show"))).toEqual([]);
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of two hours ago");
  });
});

describe.concurrent.skipIf(NO_RESTIC)("what a restore refuses", () => {
  async function refused(setup: (made: Awaited<ReturnType<typeof prepared>>) => void, folder = "cms") {
    const made = await prepared();
    setup(made);
    const systemd = fakeSystemd(made.data, UNITS);
    const time = clock(T);
    const result = await restore({ config: made.config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl, lockWaitMs: 0 }, folder);
    expect(systemd.calls.filter((call) => call.startsWith("stop"))).toEqual([]);
    expect(readFileSync(join(made.data, "upload.txt"), "utf8")).toBe("the version of now");
    return result;
  }

  test("no request: restores start from the dashboard only", async () => {
    const result = await refused(() => undefined);
    expect(result).toMatchObject({ state: "rejects", message: "no restore request for this site: restores are started from the dashboard" });
  });

  test("a request older than five minutes", async () => {
    const result = await refused(({ config, snapshot }) => request(config.stateFolder, "cms", snapshot, T - 6 * 60_000));
    expect(result.message).toBe("the restore request is too old, start it again from the dashboard");
  });

  test("a request for another site's snapshot", async () => {
    const result = await refused(({ config }) => request(config.stateFolder, "cms", snapshotName("shop", T, "scheduled"), T));
    expect(result.message).toBe("the restore request names no snapshot of this site");
  });

  test("a snapshot that exists nowhere", async () => {
    const result = await refused(({ config }) => request(config.stateFolder, "cms", snapshotName("cms", T - 50 * HOUR, "scheduled"), T));
    expect(result.message).toBe("this snapshot is no longer on the server, and no bucket is configured");
  });

  test("an archive of the format before restic not imported yet", async () => {
    const result = await refused(({ config }) => request(config.stateFolder, "cms", legacySnapshotName("cms", T - 50 * HOUR, "scheduled"), T));
    expect(result.message).toBe("this snapshot has not been imported into the repository yet: try again after the next backup run");
  });

  test("the dashboard itself, which would cut the page asking", async () => {
    const result = await refused(({ config, sites, snapshot }) => {
      mkdirSync(join(sites, "dashboard", "data"), { recursive: true });
      request(config.stateFolder, "dashboard", snapshot.replace("cms", "dashboard"), T);
    }, "dashboard");
    expect(result.message).toContain("the dashboard's own data is not restored from the dashboard");
  });

  test("the portal, whose old copy would let revoked guests back in", async () => {
    const result = await refused(({ config, sites, snapshot }) => {
      mkdirSync(join(sites, "portal", "data"), { recursive: true });
      request(config.stateFolder, "portal", snapshot.replace("cms", "portal"), T);
    }, "portal");
    expect(result).toMatchObject({ state: "rejects", message: PORTAL_REFUSAL });
  });

  test("a manifest naming another slug, whose services would be another project's", async () => {
    const result = await refused(({ config, sites, snapshot }) => {
      writeFileSync(
        join(sites, "cms", "sitesolide.json"),
        JSON.stringify({ slug: "shop", services: { web: { start: "bun web.ts", port: 3040 }, worker: { start: "bun worker.ts", port: 3041, internal: true } } }),
      );
      request(config.stateFolder, "cms", snapshot, T);
    });
    expect(result).toMatchObject({ state: "rejects", message: "cms: its sitesolide.json names another slug, so its services cannot be named safely" });
  });

  test("while a run holds the lock", async () => {
    let release: (() => void) | null = null;
    const result = await refused(({ config, snapshot }) => {
      const lock = takeLock(config.runFolder, "run");
      if (lock.ok) release = lock.release;
      request(config.stateFolder, "cms", snapshot, T);
    });
    expect(result.message).toBe("a backup run is still going on: try again in a few minutes");
    (release as (() => void) | null)?.();
  });

  test("after an interrupted restore whose outcome nobody knows", async () => {
    const result = await refused(({ config, sites, snapshot }) => {
      mkdirSync(join(sites, "cms", PREVIOUS));
      request(config.stateFolder, "cms", snapshot, T);
    });
    expect(result.message).toBe(INTERRUPTED_REASON);
  });
});

describe.concurrent.skipIf(NO_RESTIC)("what a restore repairs before starting", () => {
  test("an extraction left behind is removed, and the restore goes on", async () => {
    const { config, sites, data, snapshot } = await prepared();
    mkdirSync(join(sites, "cms", INCOMING));
    writeFileSync(join(sites, "cms", INCOMING, "half"), "x");
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T);
    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.state).toBe("ok");
    expect(existsSync(join(data, "half"))).toBe(false);
  });

  test("a site left without its data folder gets it back first", async () => {
    const { config, sites, data, snapshot } = await prepared();
    // Stopped between the two renames.
    mkdirSync(join(sites, "cms", INCOMING));
    Bun.spawnSync(["mv", data, join(sites, "cms", PREVIOUS)]);
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T);
    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.state).toBe("ok");
    expect(result.preRestore).not.toBeNull();
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of two hours ago");
  });
});

/** A restore that must be refused before anything is stopped, the data in service untouched. */
async function untouched(made: Awaited<ReturnType<typeof prepared>>, snapshot: string, extra: Partial<Parameters<typeof restore>[0]> = {}) {
  const systemd = fakeSystemd(made.data, UNITS);
  const time = clock(T);
  request(made.config.stateFolder, "cms", snapshot, T);
  const result = await restore({ config: made.config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl, ...extra }, "cms");
  expect(systemd.calls.filter((call) => call.startsWith("stop"))).toEqual([]);
  expect(readFileSync(join(made.data, "upload.txt"), "utf8")).toBe("the version of now");
  expect(existsSync(join(made.sites, "cms", INCOMING))).toBe(false);
  return result;
}

describe.concurrent.skipIf(NO_RESTIC)("a snapshot is bound to its project and its time", () => {
  test("a snapshot's tar stored again under another time is refused once extracted, before anything stops", async () => {
    const made = await prepared();
    const elsewhere = snapshotName("cms", T - 30 * 60_000, "scheduled");
    storeAs(made.config, "cms", T - 30 * 60_000, dumped(made.config, "cms", made.snapshot));
    const result = await untouched(made, elsewhere);
    expect(result).toMatchObject({ state: "rejects", message: "the snapshot could not be extracted, nothing was changed: the archive was taken at another time than its name says" });
  });

  test("another project's tar stored under this one's name is refused, before anything stops", async () => {
    const made = await prepared();
    const shop = project(made.sites, "shop");
    writeFileSync(join(shop, "orders.txt"), "shop's orders");
    expect((await runBackups({ config: made.config, now: () => T - 3 * HOUR, log: silent })).projects.shop?.ok).toBe(true);
    // Under a time of its own: the run of T - 3h also took one of cms.
    storeAs(made.config, "cms", T - 4 * HOUR, dumped(made.config, "shop", snapshotName("shop", T - 3 * HOUR, "scheduled")));
    const result = await untouched(made, snapshotName("cms", T - 4 * HOUR, "scheduled"));
    expect(result).toMatchObject({ state: "rejects", message: "the snapshot could not be extracted, nothing was changed: the archive is a snapshot of another site than the one being restored" });
  });
});

describe.concurrent.skipIf(NO_RESTIC)("a restore never leaves a site stopped", () => {
  test("without the time to save and swap, nothing is stopped", async () => {
    const made = await prepared();
    const result = await untouched(made, made.snapshot, { unitTimeoutMs: 60_000 });
    expect(result).toMatchObject({ state: "rejects", message: expect.stringContaining("not enough time left in this restore") });
  });

  test("it marks the services stopped before stopping them, and clears the mark once they run again", async () => {
    const { config, data, snapshot } = await prepared();
    const systemd = fakeSystemd(data, UNITS);
    const mark = join(config.runFolder, "restore", `cms${STOPPED_SUFFIX}`);
    const seen: boolean[] = [];
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T);
    const result = await restore(
      {
        config,
        now: time.now,
        wait: time.wait,
        log: silent,
        systemctl: async (args) => {
          if (args[0] === "stop") seen.push(existsSync(mark));
          return systemd.systemctl(args);
        },
      },
      "cms",
    );
    expect(result.state).toBe("ok");
    expect(seen).toEqual([true]);
    expect(JSON.parse(readFileSync(mark.replace(STOPPED_SUFFIX, ".json"), "utf8")).state).toBe("ok");
    expect(existsSync(mark)).toBe(false);
  });

  test("cut short with the services stopped, the unit's cleanup repairs and starts them again", async () => {
    const { config, sites, data, snapshot } = await prepared();
    const systemd = fakeSystemd(data, UNITS);
    // The restore was killed while saving the current data: stopped, extracted, not swapped.
    await systemd.systemctl(["stop", ...UNITS]);
    mkdirSync(join(sites, "cms", INCOMING));
    mkdirSync(join(config.runFolder, "restore"), { recursive: true });
    writeFileSync(join(config.runFolder, "restore", `cms${STOPPED_SUFFIX}`), JSON.stringify({ units: UNITS }), { mode: 0o600 });
    writeFileSync(
      join(config.runFolder, "restore", "cms.json"),
      JSON.stringify({ nonce: "0123456789abcdef", state: "running", message: "Saving the current data first.", snapshot, preRestore: null, actor: "owner", startedAt: T, at: T }),
      { mode: 0o600 },
    );
    // A dead restore's lock, as it leaves it.
    mkdirSync(join(config.runFolder, "lock"));
    writeFileSync(join(config.runFolder, "lock", "holder"), "restore 999999 1\n");

    await afterRestore({ config, now: () => T + 60_000, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(systemd.state.get("cms")).toBe("active");
    expect(systemd.calls).toContain("start cms");
    expect(existsSync(join(sites, "cms", INCOMING))).toBe(false);
    expect(readFileSync(join(data, "upload.txt"), "utf8")).toBe("the version of now");
    expect(existsSync(join(config.runFolder, "restore", `cms${STOPPED_SUFFIX}`))).toBe(false);
    const result = JSON.parse(readFileSync(join(config.runFolder, "restore", "cms.json"), "utf8"));
    expect(result).toMatchObject({ state: "failure", nonce: "0123456789abcdef", actor: "owner", snapshot });
    expect(result.message).toContain("The restore was cut short");
    expect(result.message).toContain("cms had been stopped, and was started again by the restore's cleanup (active).");
    const db = openDatabase(join(config.stateFolder, "backup.db"));
    expect(readAudit(db, "cms", 1)[0]).toMatchObject({ action: "backup.restore", detail: { result: "failure", cutShort: true } });
    db.close();
  });

  test("a restore that finished leaves the cleanup nothing to do", async () => {
    const { config, data, snapshot } = await prepared();
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T);
    expect((await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms")).state).toBe("ok");
    const before = readFileSync(join(config.runFolder, "restore", "cms.json"), "utf8");
    const calls = systemd.calls.length;
    await afterRestore({ config, now: time.now, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(systemd.calls.length).toBe(calls);
    expect(readFileSync(join(config.runFolder, "restore", "cms.json"), "utf8")).toBe(before);
  });

  test("cut short before stopping anything, the page is told so, and nothing is started", async () => {
    const { config, data } = await prepared();
    const systemd = fakeSystemd(data, UNITS);
    mkdirSync(join(config.runFolder, "restore"), { recursive: true });
    writeFileSync(
      join(config.runFolder, "restore", "cms.json"),
      JSON.stringify({ nonce: null, state: "running", message: "Extracting the snapshot.", snapshot: null, preRestore: null, actor: "owner", startedAt: T, at: T }),
      { mode: 0o600 },
    );
    await afterRestore({ config, now: () => T, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(systemd.calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(config.runFolder, "restore", "cms.json"), "utf8"))).toMatchObject({
      state: "failure",
      message: "The restore was cut short before it changed anything: start it again from the dashboard.",
    });
  });
});

describe.concurrent.skipIf(NO_RESTIC)("a snapshot streamed into the extraction is bounded", () => {
  test("in time: a download past its time stops the restore before anything is stopped", async () => {
    const made = await prepared(bucket());
    forget(made.config, "cms", made.snapshot);
    const started = Date.now();
    const result = await untouched(made, made.snapshot, { downloadTimeoutMs: 1 });
    expect(result).toMatchObject({ state: "rejects", message: "the snapshot could not be fetched from the bucket in time" });
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test("in room: a disk at its reserve extracts nothing", async () => {
    const made = await prepared();
    const result = await untouched({ ...made, config: { ...made.config, reserveBytes: 10 ** 18 } }, made.snapshot);
    expect(result).toMatchObject({ state: "rejects", message: "not enough disk space to extract the snapshot and save the current data first" });
  });
});

describe.concurrent.skipIf(NO_RESTIC)("a current database that cannot be read consistently", () => {
  test("is saved as raw files, said so, and the restore goes on", async () => {
    const { config, data, snapshot } = await prepared();
    // The very reason for a restore: the database in service is damaged.
    const damaged = Bun.concatArrayBuffers([new TextEncoder().encode("SQLite format 3\u0000"), crypto.getRandomValues(new Uint8Array(8192))], Infinity, true);
    for (const side of ["-wal", "-shm"]) rmSync(join(data, `app.db${side}`), { force: true });
    writeFileSync(join(data, "app.db"), damaged);
    const systemd = fakeSystemd(data, UNITS);
    const time = clock(T);
    request(config.stateFolder, "cms", snapshot, T);
    const result = await restore({ config, now: time.now, wait: time.wait, log: silent, systemctl: systemd.systemctl }, "cms");
    expect(result.state).toBe("ok");
    expect(result.message).toContain("The data it replaced is saved as a before-restore snapshot, as raw files: one of its databases could not be read consistently.");
    expect(audit(join(data, "app.db"))).toEqual({ total: ACCOUNTS * BALANCE, rows: ACCOUNTS, integrity: "ok" });
    // The before-restore snapshot holds the damaged file as it was, and says how it was taken.
    const saved = dumped(config, "cms", result.preRestore!);
    expect(JSON.parse(Bun.spawnSync(["tar", "-xOf", saved, "sitesolide-backup.json"]).stdout.toString())).toMatchObject({ format: 2, folder: "cms", raw: true, databases: [] });
    expect(new Uint8Array(Bun.spawnSync(["tar", "-xOf", saved, "data/app.db"]).stdout)).toEqual(damaged);
    const db = openDatabase(join(config.stateFolder, "backup.db"));
    expect(readAudit(db, "cms", 1)[0]).toMatchObject({ detail: { result: "ok", preRestoreRaw: true } });
    db.close();
  });
});
