import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotName } from "../borrowed/backups";
import type { BackupSteward } from "../src/backup/client";
import { openDatabase, recordAudit, replaceOffsite, writeSetting } from "../src/backup/database";
import type { BackupsResponse, RestoreResponse } from "../src/backup/protocol";
import { createBackupReader } from "../src/backup/reader";
import { INTERRUPTED_REASON, PREVIOUS } from "../src/backup/recovery";
import { DASHBOARD_REASON, NOT_INSTALLED_REASON, RUNNING_REASON } from "../src/backup/routes";
import { encodeRequest } from "../src/backup/request";
import { writeStatus } from "../src/backup/status";
import { ROOT_FILES } from "../src/secrets/scope";
import { createSecretsRoutes, SESSION_ACTOR } from "../src/secrets/routes";
import { createSteward } from "../src/secrets/steward";
import { createSystem, type Command } from "../src/secrets/system";
import { createTokens } from "../src/secrets/tokens";
import type { Steward } from "../src/secrets/client";

/**
 * The steward's backup routes on a throwaway machine: real files, the real
 * reader, the steward's own token and lock, a simulated systemctl. Then the
 * dashboard's relay in front of a simulated steward.
 */
const ROOT = mkdtempSync(join(tmpdir(), "backup-steward-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const PASSWORD = "the dashboard password, long enough";
const T = Date.now();
const SNAPSHOT = snapshotName("cms", T - 3_600_000, "scheduled");
const OFFSITE_ONLY = snapshotName("cms", T - 50 * 3_600_000, "scheduled");

const paths = {
  sites: join(ROOT, "sites"),
  secrets: join(ROOT, "secrets"),
  units: join(ROOT, "units"),
  state: join(ROOT, "steward-state"),
  backups: join(ROOT, "backups"),
  backupState: join(ROOT, "backup-state"),
  backupRun: join(ROOT, "backup-run"),
};
for (const folder of Object.values(paths)) mkdirSync(folder, { recursive: true });
function site(slug: string, manifest: Record<string, unknown> | null, data = true) {
  mkdirSync(join(paths.sites, slug), { recursive: true });
  if (manifest !== null) writeFileSync(join(paths.sites, slug, "sitesolide.json"), JSON.stringify({ slug, ...manifest }));
  if (data) mkdirSync(join(paths.sites, slug, "data"), { recursive: true });
}
site("cms", { start: "bun run server.ts", port: 3040 });
site("notes", { publicDir: "public" }, false);
site("dashboard", { start: "bun run server.ts", port: 3022 });
site("scratch", { start: "bun run server.ts", port: 3050, backup: false });
writeFileSync(join(paths.secrets, "dashboard.env"), "PASSWORD_HASH=not-checked-here\n", { mode: 0o600 });
writeFileSync(join(paths.units, "sitesolide-restore@.service"), "[Service]\n");
mkdirSync(join(paths.backups, "cms"));
writeFileSync(join(paths.backups, "cms", SNAPSHOT), "an archive");
writeFileSync(join(paths.backups, "cms", "notes.txt"), "not a snapshot");

const db = openDatabase(join(paths.backupState, "backup.db"));
writeSetting(db, "retention", { hourly: 24, daily: 7, weekly: 4, preRestore: 3 });
writeSetting(db, "offsite", { target: "backups at fsn1.example.invalid", error: null });
replaceOffsite(db, [
  { folder: "cms", name: SNAPSHOT, bytes: 120 },
  { folder: "cms", name: OFFSITE_ONLY, bytes: 99 },
]);
recordAudit(db, { actor: "system", action: "backup.run", target: null, detail: { ok: true } });
recordAudit(db, { actor: "owner", action: "backup.restore", target: "cms", detail: { result: "ok" } });
db.close();
writeStatus(paths.backupState, {
  startedAt: new Date(T - 600_000).toISOString(),
  finishedAt: new Date(T - 590_000).toISOString(),
  ok: true,
  projects: { cms: { ok: true, snapshot: SNAPSHOT, error: null } },
});

const systemctlCalls: string[][] = [];
const unitState = { restore: "inactive", startCode: 0 };
const system = {
  ...createSystem({
    sitesDir: paths.sites,
    secretsFolder: paths.secrets,
    unitsFolder: paths.units,
    stateFolder: paths.state,
    hashFile: join(paths.secrets, "dashboard.env"),
    accountsFile: join(ROOT, "passwd"),
    caddyFolder: join(ROOT, "caddy"),
    gatekeeperFolder: join(ROOT, "gatekeeper"),
    systemctl: "/path/that/does/not/exist",
  }),
  async systemctl(args: string[]): Promise<Command> {
    systemctlCalls.push(args);
    if (args[0] === "show" && args[1]?.startsWith("sitesolide-restore@")) return { code: 0, output: `${unitState.restore}\n` };
    if (args[0] === "start") return { code: unitState.startCode, output: "" };
    return { code: 0, output: "LoadState=not-found\n" };
  },
};
writeFileSync(join(ROOT, "passwd"), "root:x:0:0::/root:/bin/sh\n");

const reader = createBackupReader({ sitesDir: paths.sites, backupFolder: paths.backups, stateFolder: paths.backupState, runFolder: paths.backupRun, unitsFolder: paths.units });
const handler = createSteward(system, { secretsFolder: paths.secrets, checkAccounts: false, check: async (submitted) => submitted === PASSWORD, backups: reader });
const bare = createSteward(system, { secretsFolder: paths.secrets, checkAccounts: false, check: async (submitted) => submitted === PASSWORD });

function call(method: string, path: string, body?: unknown, steward = handler): Promise<Response> {
  return steward(
    new Request(`http://steward${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

async function backups(slug: string, steward = handler) {
  const response = await call("GET", `/backups?slug=${slug}`, undefined, steward);
  expect(response.status).toBe(200);
  return ((await response.json()) as BackupsResponse).backups;
}

let token = "";
async function unlock(): Promise<string> {
  if (token !== "") return token;
  const response = await call("POST", "/unlock", { password: PASSWORD });
  token = ((await response.json()) as { token: string }).token;
  return token;
}

const restoreBody = async (overrides: Record<string, unknown> = {}) => ({ token: await unlock(), slug: "cms", snapshot: SNAPSHOT, confirmation: "cms", actor: "owner", ...overrides });

describe("what the steward says of a site's backups", () => {
  test("its snapshots, here and in the bucket, its last run, the policy and where the copies go", async () => {
    const view = await backups("cms");
    expect(view).toMatchObject({
      slug: "cms",
      installed: true,
      excluded: null,
      lastRun: { ok: true, snapshot: SNAPSHOT, error: null },
      retention: { hourly: 24, daily: 7, weekly: 4, preRestore: 3 },
      offsite: { target: "backups at fsn1.example.invalid", error: null },
      restore: null,
      restorable: true,
      reason: null,
    });
    expect(view.snapshots).toEqual([
      { name: SNAPSHOT, takenAt: T - (T % 1000) - 3_600_000, kind: "scheduled", bytes: 10, local: true, offsite: true },
      { name: OFFSITE_ONLY, takenAt: T - (T % 1000) - 50 * 3_600_000, kind: "scheduled", bytes: 99, local: false, offsite: true },
    ]);
  });

  test("a site left out says why, and the dashboard is not restored from itself", async () => {
    expect(await backups("notes")).toMatchObject({ excluded: "a static site has no data folder", restorable: false, reason: "no data folder to restore into" });
    expect(await backups("scratch")).toMatchObject({ excluded: "opted out by its sitesolide.json" });
    expect(await backups("dashboard")).toMatchObject({ restorable: false, reason: DASHBOARD_REASON });
  });

  test("a steward without the component's folders says backups are not set up", async () => {
    expect(await backups("cms", bare)).toMatchObject({ installed: false, restorable: false, reason: NOT_INSTALLED_REASON, snapshots: [] });
    const unlocked = (await (await call("POST", "/unlock", { password: PASSWORD }, bare)).json()) as { token: string };
    const response = await call("POST", "/backups/restore", { ...(await restoreBody()), token: unlocked.token }, bare);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: NOT_INSTALLED_REASON });
  });

  test("a site that is not one is refused", async () => {
    expect((await call("GET", "/backups?slug=../etc")).status).toBe(403);
    expect((await call("GET", "/backups")).status).toBe(400);
  });

  test("the audit, of the site, or of the whole machine", async () => {
    const response = await call("GET", "/backups/audit?slug=cms");
    const { entries } = (await response.json()) as { entries: { action: string }[] };
    expect(entries.map((entry) => entry.action)).toEqual(["backup.restore", "backup.run"]);
    expect((await call("GET", "/backups/audit?slug=a/b")).status).toBe(400);
  });
});

describe("a restore asked of the steward", () => {
  test("is refused without an unlocked token", async () => {
    const response = await call("POST", "/backups/restore", { token: "x".repeat(43), slug: "cms", snapshot: SNAPSHOT, confirmation: "cms", actor: "owner" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "locked" });
  });

  test("demands the slug retyped, a snapshot of this site that exists, and a requester the audit can name", async () => {
    const refused = async (overrides: Record<string, unknown>) => {
      const response = await call("POST", "/backups/restore", await restoreBody(overrides));
      return { status: response.status, body: (await response.json()) as { message: string } };
    };
    expect(await refused({ confirmation: "cm" })).toMatchObject({ status: 400, body: { message: "type cms to confirm the restore" } });
    expect(await refused({ snapshot: snapshotName("shop", T, "scheduled") })).toMatchObject({ status: 400, body: { message: "not a snapshot of cms" } });
    expect(await refused({ snapshot: snapshotName("cms", T - 7_200_000, "scheduled") })).toMatchObject({ status: 404 });
    expect(await refused({ actor: "root\nX" })).toMatchObject({ status: 400 });
    expect(await refused({ slug: "dashboard", confirmation: "dashboard", snapshot: snapshotName("dashboard", T, "scheduled") })).toMatchObject({ status: 403 });
    expect((await call("POST", "/backups/restore", { ...(await restoreBody()), extra: 1 })).status).toBe(400);
    expect(systemctlCalls.filter((args) => args[0] === "start")).toEqual([]);
  });

  test("writes the request for the one-shot, root's alone, and starts it without waiting", async () => {
    const response = await call("POST", "/backups/restore", await restoreBody());
    expect(response.status).toBe(202);
    expect(((await response.json()) as RestoreResponse).restore).toMatchObject({ state: "running", snapshot: SNAPSHOT, actor: "owner" });
    expect(systemctlCalls.filter((args) => args[0] === "start")).toEqual([["start", "--no-block", "sitesolide-restore@cms.service"]]);
    const path = join(paths.backupState, "requests", "cms.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ snapshot: SNAPSHOT, actor: "owner", nonce: expect.stringMatching(/^[0-9a-f]{16}$/) });

    // While it has not been consumed, the page sees a restore starting, and a second one is refused.
    expect((await backups("cms")).restore).toMatchObject({ state: "running", message: "Starting the restore." });
    expect((await backups("cms")).reason).toBe(RUNNING_REASON);
    const again = await call("POST", "/backups/restore", await restoreBody());
    expect(again.status).toBe(409);
  });

  test("follows the result the one-shot writes, phase by phase", async () => {
    rmSync(join(paths.backupState, "requests", "cms.json"));
    mkdirSync(join(paths.backupRun, "restore"), { recursive: true });
    const result = (state: string, message: string) =>
      writeFileSync(
        join(paths.backupRun, "restore", "cms.json"),
        JSON.stringify({ nonce: "0123456789abcdef", state, message, snapshot: SNAPSHOT, preRestore: null, actor: "owner", startedAt: T, at: T + 1 }),
        { mode: 0o600 },
      );
    unitState.restore = "activating";
    result("running", "Extracting the snapshot.");
    expect((await backups("cms")).restore).toMatchObject({ state: "running", message: "Extracting the snapshot." });
    unitState.restore = "inactive";
    result("ok", "Restored cms.");
    expect((await backups("cms")).restore).toMatchObject({ state: "ok", message: "Restored cms." });
    expect((await backups("cms")).restorable).toBe(true);
    // A result still saying running once the unit is gone: cut short.
    result("running", "Extracting the snapshot.");
    expect((await backups("cms")).restore).toMatchObject({ state: "failure", message: expect.stringContaining("stopped before finishing") });
    // A result others could rewrite says nothing.
    writeFileSync(join(paths.backupRun, "restore", "cms.json"), "{}", { mode: 0o666 });
    Bun.spawnSync(["chmod", "666", join(paths.backupRun, "restore", "cms.json")]);
    expect((await backups("cms")).restore).toMatchObject({ state: "unknown", message: "the restore's result is writable by other accounts" });
    rmSync(join(paths.backupRun, "restore", "cms.json"));
  });

  test("an interrupted restore whose outcome nobody knows blocks the next one, with the reason", async () => {
    mkdirSync(join(paths.sites, "cms", PREVIOUS));
    try {
      expect(await backups("cms")).toMatchObject({ restorable: false, reason: INTERRUPTED_REASON });
      const response = await call("POST", "/backups/restore", await restoreBody());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "unmanaged", message: INTERRUPTED_REASON });
    } finally {
      rmSync(join(paths.sites, "cms", PREVIOUS), { recursive: true });
    }
  });

  test("a unit that does not start takes its request back", async () => {
    unitState.startCode = 5;
    try {
      const response = await call("POST", "/backups/restore", await restoreBody());
      expect(response.status).toBe(500);
      expect(existsSync(join(paths.backupState, "requests", "cms.json"))).toBe(false);
    } finally {
      unitState.startCode = 0;
    }
  });

  test("a stale request does not count as a restore starting", async () => {
    writeFileSync(join(paths.backupState, "requests", "cms.json"), encodeRequest({ nonce: "0123456789abcdef", snapshot: SNAPSHOT, actor: "owner", requestedAt: T - 3_600_000 }));
    expect((await backups("cms")).restore).toBeNull();
    rmSync(join(paths.backupState, "requests", "cms.json"));
  });
});

describe("the bucket's settings in the secrets scope", () => {
  test("dashboard-backup.env is root's, like the dashboard's hash: the dashboard's account never reads it", () => {
    expect(ROOT_FILES).toEqual(["dashboard.env", "dashboard-backup.env"]);
  });
});

describe("the dashboard's relay", () => {
  const ORIGIN = "https://dashboard.test-zone.invalid";
  const received: { method: string; requested: unknown }[] = [];
  const answers = { backups: () => Response.json({ backups: { slug: "cms" } }), restore: () => Response.json({ restore: { state: "running" } }, { status: 202 }) };
  const fakeBackups: BackupSteward = {
    readBackups: async (slug) => (received.push({ method: "readBackups", requested: slug }), answers.backups()),
    restoreBackup: async (requested) => (received.push({ method: "restoreBackup", requested }), answers.restore()),
    readBackupAudit: async (slug) => (received.push({ method: "readBackupAudit", requested: slug }), Response.json({ entries: [] })),
  };
  const tokens = createTokens();
  const routes = createSecretsRoutes({
    session: async (req) => (req.headers.get("cookie") === "session=ok" ? { hash: "session-hash", createdAt: T, seenAt: T } : null),
    publicUrl: ORIGIN,
    steward: {} as Steward,
    tokens,
    backups: fakeBackups,
  });
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie: "session=ok", origin: ORIGIN }) =>
    new Request(`${ORIGIN}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  test("reads with the session alone, and only with it", async () => {
    expect((await routes.backups(request("GET", "/api/backups?slug=cms"))).status).toBe(200);
    expect(received.at(-1)).toEqual({ method: "readBackups", requested: "cms" });
    expect((await routes.backups(request("GET", "/api/backups?slug=cms", undefined, {}))).status).toBe(401);
    expect((await routes.backups(request("GET", "/api/backups"))).status).toBe(400);
    expect((await routes.backupAudit(request("GET", "/api/backups/audit"))).status).toBe(200);
  });

  test("a restore needs the origin, an unlock, and goes out with the session's requester, not the page's", async () => {
    expect((await routes.restoreBackup(request("POST", "/api/backups/restore", { slug: "cms", snapshot: SNAPSHOT, confirmation: "cms" }, { cookie: "session=ok" }))).status).toBe(403);
    expect((await routes.restoreBackup(request("POST", "/api/backups/restore", { slug: "cms", snapshot: SNAPSHOT, confirmation: "cms" }))).status).toBe(423);
    tokens.set("session-hash", { token: "t".repeat(43), expiresAt: Date.now() + 600_000 });
    const response = await routes.restoreBackup(request("POST", "/api/backups/restore", { slug: "cms", snapshot: SNAPSHOT, confirmation: "cms", actor: "someone@else.invalid", token: "forged" }));
    expect(response.status).toBe(202);
    expect(received.at(-1)).toEqual({
      method: "restoreBackup",
      requested: { slug: "cms", snapshot: SNAPSHOT, confirmation: "cms", actor: SESSION_ACTOR, token: "t".repeat(43) },
    });
    // The token never comes back to the page.
    expect(await response.text()).not.toContain("t".repeat(43));
  });

  test("a dashboard ahead of its steward says what to update, without crashing", async () => {
    answers.backups = () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
    const response = await routes.backups(request("GET", "/api/backups?slug=cms"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not-found", message: "no such route" });
  });
});
