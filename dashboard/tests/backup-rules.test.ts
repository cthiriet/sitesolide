import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotName } from "../borrowed/backups";
import { generateUnit } from "../borrowed/unit";
import { PRAGMAS, openDatabase, openForReading, recordAudit, readAudit } from "../src/backup/database";
import { HOLDER_NAME, LOCK_NAME, takeLock } from "../src/backup/lock";
import { recoveryPlan, INTERRUPTED_REASON } from "../src/backup/recovery";
import { isActor, judgeResult, readRequest, readRestoreLaunch, restoreUnit, encodeRequest } from "../src/backup/request";
import { childCommand, confinement, readReport, unitName, type Job } from "../src/backup/runner";

const FOLDER = mkdtempSync(join(tmpdir(), "backup-rules-"));
afterAll(() => rmSync(FOLDER, { recursive: true, force: true }));
const T = Date.UTC(2026, 9, 4, 13, 0, 0);

describe("the restore's unit and request", () => {
  test("one template, the folder alone as the instance", () => {
    expect(restoreUnit("cms")).toBe("sitesolide-restore@cms.service");
    expect(restoreUnit("test-zone.invalid")).toBe("sitesolide-restore@test-zone.invalid.service");
    expect(restoreUnit("../etc")).toBeNull();
    expect(readRestoreLaunch(["sitesolide-restore@cms.service"])).toEqual({ ok: true, folder: "cms" });
    for (const argv of [[], ["sitesolide-restore@cms.service", "x"], ["sitesolide-restore@.service"], ["sitesolide-gatekeeper-on@cms.service"], ["sitesolide-restore@a/b.service"], ["sitesolide-restore@-x.service"]]) {
      expect(readRestoreLaunch(argv).ok).toBe(false);
    }
  });

  test("a request is fresh, names this site's snapshot, and a known kind of requester", () => {
    const snapshot = snapshotName("cms", T - 3_600_000, "scheduled");
    const good = { nonce: "0123456789abcdef", snapshot, actor: "owner", requestedAt: T };
    expect(readRequest("cms", encodeRequest(good), T + 1000)).toEqual({ request: good });
    expect(readRequest("cms", encodeRequest(good), T + 6 * 60_000)).toEqual({ refusal: "the restore request is too old, start it again from the dashboard" });
    expect(readRequest("cms", encodeRequest(good), T - 5 * 60_000)).toEqual({ refusal: "the restore request is dated in the future" });
    expect(readRequest("shop", encodeRequest(good), T)).toEqual({ refusal: "the restore request names no snapshot of this site" });
    expect(readRequest("cms", encodeRequest({ ...good, actor: "root; rm -rf /" }), T)).toEqual({ refusal: "the restore request names no valid requester" });
    expect(readRequest("cms", encodeRequest({ ...good, nonce: "x" }), T)).toEqual({ refusal: "the restore request is unreadable" });
    expect(readRequest("cms", "{", T)).toEqual({ refusal: "the restore request is unreadable" });
  });

  test("the requester is an email, the owner or a token, as every audit says it", () => {
    for (const actor of ["owner", "alice@test-zone.invalid", "token:abc_DEF-1"]) expect(isActor(actor)).toBe(true);
    for (const actor of ["", "system", "alice", "token:", "a b@c.d", "x".repeat(400), 3, null]) expect(isActor(actor)).toBe(false);
  });

  test("the result counts only when it is root's, closed to others, and readable", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ nonce: "n", state: "ok", message: "done\nreally", snapshot: "s", preRestore: null, actor: "owner", startedAt: 1, at: 2 }),
    );
    const info = { uid: 0, mode: 0o644, regular: true };
    expect(judgeResult({ info, bytes }, 0)).toMatchObject({ state: "ok", message: "done really" });
    expect(judgeResult(null, 0)).toBeNull();
    expect(judgeResult({ info: { ...info, uid: 1000 }, bytes }, 0)).toEqual({ unreadable: "the restore's result is not owned by root" });
    expect(judgeResult({ info: { ...info, mode: 0o666 }, bytes }, null)).toEqual({ unreadable: "the restore's result is writable by other accounts" });
    expect(judgeResult({ info, bytes: new TextEncoder().encode("{}") }, 0)).toEqual({ unreadable: "the restore's result is unreadable" });
    expect(judgeResult({ info: { ...info, regular: false }, bytes: null }, 0)).toHaveProperty("unreadable");
  });
});

describe("what an interrupted restore left", () => {
  const none = { data: true, incoming: false, previous: false, failed: false };

  test("nothing: nothing to do", () => {
    expect(recoveryPlan(none)).toEqual({ kind: "clean", steps: [], note: null });
  });

  test("the states whose meaning is certain are repaired", () => {
    expect(recoveryPlan({ ...none, incoming: true }).kind).toBe("clean");
    expect(recoveryPlan({ data: false, incoming: true, previous: true, failed: false })).toMatchObject({
      kind: "clean",
      steps: [{ rename: [".restore-previous", "data"] }, { remove: ".restore-incoming" }],
    });
    expect(recoveryPlan({ data: false, incoming: false, previous: true, failed: true })).toMatchObject({
      kind: "clean",
      steps: [{ rename: [".restore-previous", "data"] }, { remove: ".restore-failed" }],
    });
    expect(recoveryPlan({ ...none, failed: true })).toMatchObject({ kind: "clean", steps: [{ remove: ".restore-failed" }] });
  });

  test("the new data in place beside the old one is a human's decision", () => {
    expect(recoveryPlan({ ...none, previous: true })).toEqual({ kind: "refuse", reason: INTERRUPTED_REASON });
    expect(recoveryPlan({ data: true, incoming: true, previous: true, failed: true }).kind).toBe("refuse");
    expect(recoveryPlan({ data: false, incoming: false, previous: true, failed: false }).kind).toBe("refuse");
  });
});

describe("the lock shared by a run and a restore", () => {
  test("one holder at a time, and only the holder releases it", () => {
    const run = join(FOLDER, "lock-1");
    mkdirSync(run);
    const first = takeLock(run, "run");
    expect(first.ok).toBe(true);
    const second = takeLock(run, "restore");
    expect(second).toEqual({ ok: false, holder: { who: "run", pid: process.pid, since: expect.any(Number) } });
    if (first.ok) first.release();
    expect(existsSync(join(run, LOCK_NAME))).toBe(false);
    expect(takeLock(run, "restore").ok).toBe(true);
  });

  test("a holder whose process is dead is taken over at once", () => {
    const run = join(FOLDER, "lock-2");
    mkdirSync(join(run, LOCK_NAME), { recursive: true });
    writeFileSync(join(run, LOCK_NAME, HOLDER_NAME), "run 999999 1\n");
    const taken = takeLock(run, "restore", (pid) => pid !== 999999);
    expect(taken.ok).toBe(true);
  });

  test("a holder that cannot be read is respected for a minute: it may be writing it", () => {
    const run = join(FOLDER, "lock-3");
    mkdirSync(join(run, LOCK_NAME), { recursive: true });
    expect(takeLock(run, "run").ok).toBe(false);
    expect(takeLock(run, "run", () => true, () => Date.now() + 120_000).ok).toBe(true);
  });
});

describe("the component's database", () => {
  test("carries the repository's settings, read back from the connection", () => {
    const db = openDatabase(join(FOLDER, "backup.db"));
    const read = (name: string) => Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    expect(read("busy_timeout")).toBe(10000);
    expect(read("journal_mode")).toBe("wal");
    expect(read("journal_size_limit")).toBe(67108864);
    expect(read("synchronous")).toBe(1);
    expect(read("foreign_keys")).toBe(1);
    expect(read("temp_store")).toBe(2);
    expect(read("cache_size")).toBe(-16000);
    expect(PRAGMAS[0]).toBe("busy_timeout = 10000");
    db.close();
  });

  test("the audit is the shared shape, and a reader neither creates nor writes", () => {
    expect(openForReading(join(FOLDER, "absent.db"))).toBeNull();
    expect(existsSync(join(FOLDER, "absent.db"))).toBe(false);
    const db = openDatabase(join(FOLDER, "audit.db"));
    const columns = (db.query("PRAGMA table_info(audit)").all() as { name: string; type: string; notnull: number }[]).map((c) => [c.name, c.type, c.notnull]);
    expect(columns).toEqual([
      ["id", "INTEGER", 0],
      ["at", "TEXT", 1],
      ["actor", "TEXT", 1],
      ["action", "TEXT", 1],
      ["target", "TEXT", 0],
      ["detail", "TEXT", 0],
    ]);
    recordAudit(db, { actor: "system", action: "backup.run", target: null, detail: { ok: true } }, T);
    recordAudit(db, { actor: "owner", action: "backup.restore", target: "cms", detail: { result: "ok" } }, T + 1);
    recordAudit(db, { actor: "owner", action: "backup.restore", target: "shop", detail: null }, T + 2);
    db.close();
    const reader = openForReading(join(FOLDER, "audit.db"))!;
    expect(readAudit(reader, "cms", 10).map((entry) => [entry.action, entry.target])).toEqual([
      ["backup.restore", "cms"],
      ["backup.run", null],
    ]);
    expect(readAudit(reader, null, 10)[0]).toEqual({ id: 3, at: "2026-10-04T13:00:00.002Z", actor: "owner", action: "backup.restore", target: "shop", detail: null });
    expect(() => reader.run("DELETE FROM audit")).toThrow();
    reader.close();
  });
});

describe("a child, run as the project", () => {
  const job: Job = {
    mode: "copy",
    folder: "cms",
    account: "site-cms",
    uid: 1042,
    args: ["/srv/sites/cms/data", "/var/cache/sitesolide-backup/cms"],
    readWrite: ["/srv/sites/cms/data"],
    bind: ["/srv/sites/cms/data"],
    cacheDirectory: "sitesolide-backup/cms",
    stdin: null,
    stdout: "pipe",
  };
  const config = { isolation: "systemd" as const, systemdRun: "/usr/bin/systemd-run", bun: "/usr/local/bin/bun", script: "/usr/local/lib/sitesolide/backup.js", childTimeoutMs: 1_800_000 };

  test("goes through systemd-run, as the project's account, its pipes handed over", () => {
    const command = childCommand(job, config, "a1b2c3d4");
    expect(command.slice(0, 11)).toEqual([
      "/usr/bin/systemd-run",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
      "--unit=sitesolide-backup-copy-cms-a1b2c3d4.service",
      "--description=Backup copy of cms",
      "--uid=site-cms",
      "--gid=site-cms",
      "--nice=10",
    ]);
    expect(command).toContain("--setenv=BACKUP_EXPECTED_UID=1042");
    expect(command.slice(-5)).toEqual(["/usr/local/bin/bun", "/usr/local/lib/sitesolide/backup.js", "copy", "/srv/sites/cms/data", "/var/cache/sitesolide-backup/cms"]);
    expect(command[command.indexOf("--") - 1]).toBe("CacheDirectoryMode=0700");
    expect(unitName({ mode: "extract", folder: "test-zone.invalid" }, "00ff00ff")).toBe("sitesolide-backup-extract-test-zone.invalid-00ff00ff.service");
  });

  test("with no isolation, the same mode as a plain child, for the workstation", () => {
    expect(childCommand(job, { ...config, isolation: "none" })).toEqual(["/usr/local/bin/bun", "/usr/local/lib/sitesolide/backup.js", "copy", ...job.args]);
  });

  test("is confined at least like the project's own service, and cut from the network", () => {
    // Every directive of the generated unit that applies to a process with no
    // port and no secret, found again in the child's.
    const unit = generateUnit({ slug: "cms", start: "bun run server.ts", port: 3040 }, { slug: "cms", zone: "test-zone.invalid", contact: "" });
    const wanted = unit
      .split("\n")
      .filter((line) => /^(NoNewPrivileges|PrivateTmp|PrivateDevices|ProtectSystem|ProtectHome|ReadWritePaths|TemporaryFileSystem|BindPaths|ProtectKernelTunables|ProtectKernelModules|ProtectControlGroups|RestrictNamespaces|RestrictSUIDSGID|RestrictRealtime|LockPersonality|UMask|IPAddressDeny)=/.test(line))
      .map((line) => line.replace(/^(\w+)=true$/, "$1=yes"));
    const properties = confinement(job, 1_800_000);
    for (const line of wanted) expect(properties).toContain(line);
    expect(properties).toContain("IPAddressDeny=any");
    expect(properties).not.toContain("IPAddressAllow=localhost");
    expect(properties).toContain("InaccessiblePaths=-/etc/sitesolide");
    expect(properties).toContain("InaccessiblePaths=-/var/backups");
    expect(properties).toContain("RuntimeMaxSec=1800");
  });

  test("reports one JSON line, and the rest is kept as the tail of a failure", () => {
    expect(readReport('noise\n{"event":"summary","files":3}\n')).toEqual({ summary: { event: "summary", files: 3 }, error: null, path: null, tail: "noise" });
    expect(readReport('{"event":"error","message":"a folder of the data cannot be read (permission denied)","path":"private"}')).toEqual({
      summary: null,
      error: "a folder of the data cannot be read (permission denied)",
      path: "private",
      tail: "",
    });
    expect(readReport("Failed to start transient service unit: Unit already exists.").tail).toContain("Unit already exists");
  });
});
