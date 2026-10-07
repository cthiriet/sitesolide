import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateKey, signAssertion, type PrivateKey } from "../borrowed/assertion";
import { snapshotName } from "../borrowed/backups";
import { createAccessSystem } from "../src/access/system";
import { createBackupReader } from "../src/backup/reader";
import { REAUTH_MAX_AGE_S } from "../src/members/protocol";
import { createMembersSystem, type MembersSystem } from "../src/members/system";
import { reread } from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";
import { createSteward, type StewardHandler } from "../src/secrets/steward";
import { createSystem, type Command, type System } from "../src/secrets/system";
import { registryOf, writeRegistry, type People } from "./registry-fixtures";

/**
 * Every decision the steward takes for a person's work on their projects, as
 * root would take it: on a throwaway tree, with the real files, the real key
 * pair, the real access registry, the real journal and a real backup reader.
 * `systemctl` alone is simulated.
 *
 * A person unlocks with a forced sign-in for their own email, and their token
 * neither evicts nor is evicted by the owner's or another person's. A
 * Developer writes and never reads a value back; an Admin reads, changes the
 * general access and restores, on their project alone; the machine's own
 * projects and files are nobody's but the owner's. The journal names the
 * person the steward verified. Their people with access are the access
 * tests' business.
 */

const PASSWORD = "Owner-Password-For-The-Tests-1";
const ZONE = "test-zone.invalid";
const ALICE = "alice@acme.test";
const BOB = "bob@acme.test";
const SECRET_VALUE = "value-only-a-project-admin-reads-1";

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Bench = {
  root: string;
  clock: { t: number };
  dashboard: StewardHandler;
  calls: string[][];
  barrier: { promise: Promise<void> | null };
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  journal: () => LogEntry[];
  privateKey: () => PrivateKey;
  file: (name: string) => string;
  /** The access registry laid as the owner would have left it. */
  seed: (people: People) => void;
};

const SNAPSHOT_AGE_MS = 3_600_000;

async function mount(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "members-actions-"));
  toClean.push(root);
  const folder = (name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    return join(root, name);
  };
  const sites = folder("sites");
  const secrets = folder("secrets");
  const units = folder("units");
  const state = folder("state");
  const portalKey = folder("portal-key");
  const caddy = folder("caddy");
  const gatekeeper = folder("gatekeeper");
  const backups = folder("backups");
  const backupState = folder("backup-state");
  const backupRun = folder("backup-run");

  const app = (slug: string, port: number, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(sites, slug, "data"), { recursive: true });
    writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, start: "/usr/local/bin/bun run server.ts", port, publicDir: "public", ...extra }));
    writeFileSync(join(units, `${slug}.service`), `[Service]\nExecStart=/usr/local/bin/bun run server.ts\nEnvironmentFile=-${secrets}/${slug}.env\n`);
  };
  app("alpha", 3061, { secrets: ["alpha.env", "alpha-signing.pub"] });
  app("beta", 3062, { secrets: ["beta.env", "beta-signing.pub"], portal: true });
  app("shop", 3063, { secrets: ["shop.env"] });
  app("dashboard", 3022, { secrets: ["dashboard.env"] });
  app("portal", 3026, { secrets: ["portal.env"] });

  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "portal.env"), "OIDC_ISSUER=https://login.test-zone.invalid\nOIDC_CLIENT_ID=client\nOIDC_CLIENT_SECRET=secret\nOIDC_ALLOWED_DOMAINS=acme.test\n", { mode: 0o600 });
  writeFileSync(join(secrets, "alpha.env"), `API_KEY=${SECRET_VALUE}\nPASSWORD_HASH=$argon2id$not-a-real-hash\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "alpha-signing.pub"), "ssh-ed25519 AAAA alpha\n", { mode: 0o444 });
  writeFileSync(join(secrets, "beta.env"), `API_KEY=${SECRET_VALUE}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "beta-signing.pub"), "ssh-ed25519 AAAA beta\n", { mode: 0o444 });
  writeFileSync(join(secrets, "shop.env"), `API_KEY=${SECRET_VALUE}\n`, { mode: 0o600 });
  // beta's block carries the portal: its general access is restricted, and may be turned public.
  writeFileSync(join(caddy, "beta.caddy"), "beta.{$SITESOLIDE_ZONE} {\n\tforward_auth @portal_guard 127.0.0.1:3026 {\n\t\turi /verifier\n\t}\n}\n");

  // A snapshot of beta, and the restore's template: a restore can start.
  writeFileSync(join(units, "sitesolide-restore@.service"), "[Service]\n");
  mkdirSync(join(backups, "beta"));
  const clock = { t: Date.now() };
  writeFileSync(join(backups, "beta", snapshotName("beta", clock.t - SNAPSHOT_AGE_MS, "scheduled")), "an archive");

  const calls: string[][] = [];
  const barrier: Bench["barrier"] = { promise: null };
  const real = createSystem({
    sitesDir: sites,
    secretsFolder: secrets,
    unitsFolder: units,
    stateFolder: state,
    hashFile: join(secrets, "dashboard.env"),
    accountsFile: join(root, "passwd"),
    caddyFolder: caddy,
    gatekeeperFolder: gatekeeper,
    systemctl: "/path/that/does/not/exist",
  });
  const system: System = {
    ...real,
    now: () => clock.t,
    wait: async (ms) => {
      clock.t += ms;
    },
    systemctl: async (arguments_): Promise<Command> => {
      calls.push(arguments_);
      if (arguments_[0] === "restart" && barrier.promise !== null) await barrier.promise;
      // The gatekeeper writes its result, as the real one does once Caddy answered.
      const unit = arguments_[0] === "start" ? arguments_[1] ?? "" : "";
      const door = unit.match(/^sitesolide-gatekeeper-(on|off)@(.+)\.service$/);
      if (door !== null) {
        writeFileSync(
          join(gatekeeper, `${door[2]}.json`),
          JSON.stringify({ a: clock.t + 1, result: "ok", message: `portal ${door[1]} for ${door[2]}`, requested: door[1] === "on", installed: door[1] === "on" }),
          { mode: 0o600 },
        );
      }
      if (arguments_[0] === "show") return { code: 0, output: "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=\n" };
      return { code: 0, output: "" };
    },
  };
  const members: MembersSystem = {
    ...createMembersSystem({ stateFolder: state, sitesDir: sites, secretsFolder: secrets, portalKeyFolder: portalKey, groupsFile: join(root, "group"), portalGroup: "" }),
    now: () => clock.t,
  };

  const access = {
    ...createAccessSystem({ stateFolder: state, portalKeyFolder: portalKey, groupsFile: join(root, "group"), portalGroup: "", portalDataFolder: join(root, "portal-data") }, false),
    now: () => clock.t,
  };

  const dashboard = createSteward(system, {
    secretsFolder: secrets,
    checkAccounts: false,
    members: { system: members, access, zone: ZONE },
    backups: createBackupReader({ sitesDir: sites, backupFolder: backups, stateFolder: backupState, runFolder: backupRun, unitsFolder: units }),
  });
  await dashboard.ensureMemberKeys();

  const call = (method: string, path: string, body?: unknown) =>
    dashboard(new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  return {
    root,
    clock,
    dashboard,
    calls,
    barrier,
    call,
    journal: () => (existsSync(join(state, "journal.jsonl")) ? reread(readFileSync(join(state, "journal.jsonl"), "utf8")) : []),
    privateKey: () => readPrivateKey(readFileSync(join(portalKey, "assertion.key"), "utf8"))!,
    file: (name) => readFileSync(join(secrets, name), "utf8"),
    seed: (people) => writeRegistry(state, registryOf(people)),
  };
}

/** What the portal hands the dashboard for this person; `reauth` for a forced sign-in. */
function assertion(bench: Bench, email: string, options: { reauth?: boolean; authAgeS?: number } = {}): Promise<string> {
  const nowS = Math.floor(bench.clock.t / 1000);
  return signAssertion(bench.privateKey(), { email, name: null, authTime: nowS - (options.authAgeS ?? 30), reauth: options.reauth ?? false }, nowS);
}

async function sessionOf(bench: Bench, email: string): Promise<string> {
  const response = await bench.call("POST", "/members/signin", { assertion: await assertion(bench, email, { authAgeS: 3600 }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { session: string }).session;
}

async function unlockAs(bench: Bench, session: string, email: string): Promise<string> {
  const response = await bench.call("POST", "/members/unlock", { session, assertion: await assertion(bench, email, { reauth: true }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function ownerUnlock(bench: Bench): Promise<string> {
  const response = await bench.call("POST", "/unlock", { password: PASSWORD });
  return ((await response.json()) as { token: string }).token;
}

/** Alice: Developer on alpha, Admin on beta, Viewer on shop. Bob: Developer on alpha. */
const TEAM: People = { [ALICE]: { alpha: "developer", beta: "admin", shop: "viewer" }, [BOB]: { alpha: "developer" } };

async function team(bench: Bench): Promise<{ alice: string; bob: string }> {
  bench.seed(TEAM);
  return { alice: await sessionOf(bench, ALICE), bob: await sessionOf(bench, BOB) };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("a member's own unlock", () => {
  test("opens only on a forced sign-in, for the session's own email, fresh, once", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const unlock = async (token: string) => bench.call("POST", "/members/unlock", { session: alice, assertion: token });

    const plain = await unlock(await assertion(bench, ALICE));
    expect(plain.status).toBe(401);
    expect(await body(plain)).toMatchObject({ error: "invalid-assertion", message: expect.stringContaining("not asked to sign you in again") });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "unlock", result: "rejects", actor: ALICE, detail: "not-forced" });

    expect(await body(await unlock(await assertion(bench, BOB, { reauth: true })))).toMatchObject({ message: expect.stringContaining(`signing in as ${ALICE}`) });
    expect(bench.journal().at(-1)).toMatchObject({ actor: ALICE, detail: "another-account" });

    const stale = await unlock(await assertion(bench, ALICE, { reauth: true, authAgeS: REAUTH_MAX_AGE_S + 1 }));
    expect(stale.status).toBe(401);
    expect(bench.journal().at(-1)).toMatchObject({ actor: ALICE, detail: "stale-authentication" });

    const token = await assertion(bench, ALICE, { reauth: true });
    const opened = await unlock(token);
    expect(opened.status).toBe(200);
    const granted = await body(opened);
    expect(granted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(granted.expiresAt).toBe(bench.clock.t + 10 * 60 * 1000);
    expect(bench.journal().at(-1)).toMatchObject({ operation: "unlock", result: "ok", actor: ALICE, member: ALICE });
    // The same assertion again: spent.
    expect(await body(await unlock(token))).toMatchObject({ message: expect.stringContaining("already used") });
  });

  test("a Viewer everywhere has nothing to unlock", async () => {
    const bench = await mount();
    bench.seed({ [ALICE]: { shop: "viewer", beta: "visitor" } });
    const session = await sessionOf(bench, ALICE);
    const response = await bench.call("POST", "/members/unlock", { session, assertion: await assertion(bench, ALICE, { reauth: true }) });
    expect(response.status).toBe(403);
  });

  test("neither the owner's unlock nor another person's evicts it, nor the other way round", async () => {
    const bench = await mount();
    const { alice, bob } = await team(bench);
    const owner = await ownerUnlock(bench);
    const aliceToken = await unlockAs(bench, alice, ALICE);
    const bobToken = await unlockAs(bench, bob, BOB);
    const ownerAgain = await ownerUnlock(bench);
    expect(ownerAgain).not.toBe(owner);

    const set = (session: string, token: string, value: string) =>
      bench.call("PUT", "/members/secrets/variable", { session, token, slug: "alpha", file: "alpha.env", variable: "FLAG", value });
    expect((await set(alice, aliceToken, "a")).status).toBe(200);
    expect((await set(bob, bobToken, "b")).status).toBe(200);
    // The owner's new unlock replaced the owner's old one, and only that one.
    expect((await bench.call("POST", "/value", { token: owner, slug: "alpha", file: "alpha.env", variable: "API_KEY" })).status).toBe(401);
    expect((await bench.call("POST", "/value", { token: ownerAgain, slug: "alpha", file: "alpha.env", variable: "API_KEY" })).status).toBe(200);
    // A person's token opens no route of the owner's.
    expect((await bench.call("POST", "/value", { token: aliceToken, slug: "alpha", file: "alpha.env", variable: "API_KEY" })).status).toBe(401);
    // Nor another person's session.
    expect((await set(bob, aliceToken, "c")).status).toBe(401);
  });

  test("one per session: a new unlock replaces that session's alone, another session keeps its own", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const phone = await sessionOf(bench, ALICE);
    const first = await unlockAs(bench, alice, ALICE);
    const onPhone = await unlockAs(bench, phone, ALICE);
    const second = await unlockAs(bench, alice, ALICE);
    const set = (session: string, token: string) =>
      bench.call("PUT", "/members/secrets/variable", { session, token, slug: "alpha", file: "alpha.env", variable: "FLAG", value: "x" });
    expect((await set(alice, first)).status).toBe(401);
    expect((await set(alice, second)).status).toBe(200);
    expect((await set(phone, onPhone)).status).toBe(200);
  });

  test("ten minutes, fixed; locked on demand, at sign-out, and when the person is taken off", async () => {
    const bench = await mount();
    const { alice, bob } = await team(bench);
    const set = (session: string, token: string) =>
      bench.call("PUT", "/members/secrets/variable", { session, token, slug: "alpha", file: "alpha.env", variable: "FLAG", value: "x" });

    let token = await unlockAs(bench, alice, ALICE);
    bench.clock.t += 10 * 60 * 1000;
    expect(await body(await set(alice, token))).toMatchObject({ error: "locked" });

    token = await unlockAs(bench, alice, ALICE);
    expect((await bench.call("POST", "/members/lock", { session: alice, token })).status).toBe(204);
    expect(bench.journal().at(-1)).toMatchObject({ operation: "lock", actor: ALICE });
    expect((await set(alice, token)).status).toBe(401);

    token = await unlockAs(bench, alice, ALICE);
    await bench.call("POST", "/members/signout", { session: alice });
    expect((await set(alice, token)).status).toBe(401);

    const bobToken = await unlockAs(bench, bob, BOB);
    bench.seed({ [ALICE]: TEAM[ALICE]! });
    expect(await body(await set(bob, bobToken))).toMatchObject({ error: "signed-out" });
    // Lowered to Viewer, their unlock opens no write either.
    const again = await sessionOf(bench, ALICE);
    token = await unlockAs(bench, again, ALICE);
    bench.seed({ [ALICE]: { alpha: "viewer", beta: "admin" } });
    expect(await body(await set(again, token))).toMatchObject({ error: "out-of-scope", message: `${ALICE} is a Viewer on alpha: changing its secrets takes a Developer or an Admin` });
  });

  test("its refusals count per person, under a cap for the whole machine; the owner's counter is untouched", async () => {
    const bench = await mount();
    const { alice, bob } = await team(bench);
    for (let i = 0; i < 4; i++) {
      await bench.call("POST", "/members/unlock", { session: alice, assertion: await assertion(bench, ALICE) });
    }
    const slowed = await bench.call("POST", "/members/unlock", { session: alice, assertion: await assertion(bench, ALICE, { reauth: true }) });
    expect(slowed.status).toBe(429);
    // Bob and the owner are not slowed by Alice's refusals.
    await unlockAs(bench, bob, BOB);
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(200);
  });
});

describe("secrets, by role", () => {
  test("a Developer lists names and metadata, never a value, a size nor a previous version; another project, nothing", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const listed = await body(await bench.call("POST", "/members/secrets/projects", { session: alice }));
    const projects = listed.projects as { slug: string; files: { name: string; readable: boolean; bytes: number | null; previous: boolean; variables: string[] }[] }[];
    expect(projects.map((project) => project.slug)).toEqual(["alpha", "beta"]);
    const alpha = projects.find((project) => project.slug === "alpha")!;
    expect(alpha.files.map((file) => [file.name, file.readable, file.bytes, file.previous])).toEqual([
      ["alpha.env", false, null, false],
      ["alpha-signing.pub", false, null, false],
    ]);
    expect(alpha.files[0]!.variables).toEqual(["API_KEY", "PASSWORD_HASH"]);
    const beta = projects.find((project) => project.slug === "beta")!;
    expect(beta.files.find((file) => file.name === "beta-signing.pub")).toMatchObject({ readable: true, bytes: 22 });
    expect(JSON.stringify(listed)).not.toContain(SECRET_VALUE);
    expect(listed.until).toBeNull();
  });

  test("a Developer sets, replaces and removes, and nothing comes back but names", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const token = await unlockAs(bench, alice, ALICE);
    const set = await bench.call("PUT", "/members/secrets/variable", { session: alice, token, slug: "alpha", file: "alpha.env", variable: "NEW_KEY", value: "set-by-a-developer-0001" });
    expect(set.status).toBe(200);
    const view = await body(set);
    expect(view.file).toMatchObject({ name: "alpha.env", readable: false, previous: false, bytes: null });
    expect(JSON.stringify(view)).not.toContain("set-by-a-developer-0001");
    expect(bench.file("alpha.env")).toContain("NEW_KEY=set-by-a-developer-0001");
    expect(bench.journal().at(-1)).toMatchObject({ operation: "set", result: "ok", actor: ALICE, slug: "alpha", variable: "NEW_KEY" });

    expect((await bench.call("PUT", "/members/secrets/content", { session: alice, token, slug: "alpha", file: "alpha-signing.pub", content: "ssh-ed25519 BBBB new\n" })).status).toBe(200);
    expect(bench.file("alpha-signing.pub")).toBe("ssh-ed25519 BBBB new\n");

    const removed = await bench.call("DELETE", "/members/secrets/variable", { session: alice, token, slug: "alpha", file: "alpha.env", variable: "NEW_KEY" });
    expect(removed.status).toBe(200);
    expect(bench.file("alpha.env")).not.toContain("NEW_KEY");
    expect(bench.journal().at(-1)).toMatchObject({ operation: "remove", actor: ALICE, variable: "NEW_KEY" });
  });

  test("a Developer never reads a value back: refused by role before any file is read, and journaled", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const token = await unlockAs(bench, alice, ALICE);
    const value = await bench.call("POST", "/members/secrets/value", { session: alice, token, slug: "alpha", file: "alpha.env", variable: "API_KEY" });
    expect(value.status).toBe(403);
    const refusal = await body(value);
    expect(refusal).toEqual({ error: "out-of-scope", message: `${ALICE} is a Developer on alpha: reading a value back takes an Admin: a Developer sets, replaces and removes values, and never reads one` });
    expect(JSON.stringify(refusal)).not.toContain(SECRET_VALUE);
    expect(bench.journal().at(-1)).toMatchObject({ operation: "read", result: "rejects", actor: ALICE, slug: "alpha", detail: "role developer" });
    expect((await bench.call("POST", "/members/secrets/content", { session: alice, token, slug: "alpha", file: "alpha-signing.pub" })).status).toBe(403);
    expect((await bench.call("POST", "/members/secrets/restore", { session: alice, token, slug: "alpha", file: "alpha.env" })).status).toBe(403);
  });

  test("an Admin reads their project's values, and the journal names them", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const token = await unlockAs(bench, alice, ALICE);
    const value = await bench.call("POST", "/members/secrets/value", { session: alice, token, slug: "beta", file: "beta.env", variable: "API_KEY" });
    expect(value.status).toBe(200);
    expect(await body(value)).toEqual({ value: SECRET_VALUE });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "read", result: "ok", actor: ALICE, slug: "beta", variable: "API_KEY" });
    const content = await bench.call("POST", "/members/secrets/content", { session: alice, token, slug: "beta", file: "beta-signing.pub" });
    expect(await body(content)).toEqual({ content: "ssh-ed25519 AAAA beta\n" });
  });

  test("every unlocked write needs the person's own unlock, the session alone is not enough", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const missing = await bench.call("PUT", "/members/secrets/variable", { session: alice, slug: "alpha", file: "alpha.env", variable: "A", value: "b" });
    expect(await body(missing)).toMatchObject({ error: "locked" });
    const wrong = await bench.call("PUT", "/members/secrets/variable", { session: alice, token: "x".repeat(43), slug: "alpha", file: "alpha.env", variable: "A", value: "b" });
    expect(await body(wrong)).toMatchObject({ error: "locked" });
  });

  test("another project, a project they view or only open, the platform's projects and files: refused", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const token = await unlockAs(bench, alice, ALICE);
    const set = (slug: string, file: string) => bench.call("PUT", "/members/secrets/variable", { session: alice, token, slug, file, variable: "X", value: "y" });
    expect(await body(await set("shop", "shop.env"))).toMatchObject({ error: "out-of-scope", message: `${ALICE} is a Viewer on shop: changing its secrets takes a Developer or an Admin` });
    expect(await body(await set("dashboard", "dashboard.env"))).toMatchObject({ error: "out-of-scope", message: expect.stringContaining("belongs to the platform") });
    expect(await body(await set("portal", "portal.env"))).toMatchObject({ error: "out-of-scope", message: expect.stringContaining("belongs to the platform") });
    // A file of another project named on a project of theirs is out of its scope.
    expect(await body(await set("alpha", "shop.env"))).toMatchObject({ error: "out-of-scope" });
    expect(bench.file("shop.env")).toBe(`API_KEY=${SECRET_VALUE}\n`);
    // Can open is no role here: it opens the site, and nothing of it in the dashboard.
    bench.seed({ ...TEAM, [ALICE]: { ...TEAM[ALICE]!, shop: "visitor" } });
    expect(await body(await set("shop", "shop.env"))).toMatchObject({ error: "out-of-scope", message: `${ALICE} holds no role on shop` });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: ALICE, slug: "shop", detail: "no role" });
  });

  test("a registry edited by hand to name a platform project still opens none of its files", async () => {
    const bench = await mount();
    bench.seed({ ...TEAM, [ALICE]: { ...TEAM[ALICE]!, dashboard: "admin" } });
    const alice = await sessionOf(bench, ALICE);
    const token = await unlockAs(bench, alice, ALICE);
    const read = await bench.call("POST", "/members/secrets/value", { session: alice, token, slug: "dashboard", file: "dashboard.env", variable: "PASSWORD_HASH" });
    expect(await body(read)).toMatchObject({ error: "out-of-scope", message: expect.stringContaining("platform") });
    const listed = await body(await bench.call("POST", "/members/secrets/projects", { session: alice }));
    expect((listed.projects as { slug: string }[]).map((project) => project.slug)).not.toContain("dashboard");
  });

  test("a password hash is never a person's to set or remove", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const token = await unlockAs(bench, alice, ALICE);
    const set = await bench.call("PUT", "/members/secrets/variable", { session: alice, token, slug: "alpha", file: "alpha.env", variable: "PASSWORD_HASH", value: "$argon2id$x" });
    expect(await body(set)).toMatchObject({ error: "out-of-scope", message: expect.stringContaining("Change password") });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: ALICE });
  });

  test("taken off while the write waited behind a restart: nothing is written", async () => {
    const bench = await mount();
    const { alice } = await team(bench);
    const token = await unlockAs(bench, alice, ALICE);
    let release!: () => void;
    bench.barrier.promise = new Promise((resolve) => (release = resolve));
    const restart = bench.call("POST", "/members/restart", { session: alice, slug: "alpha" });
    await Bun.sleep(20);
    const write = bench.call("PUT", "/members/secrets/variable", { session: alice, token, slug: "alpha", file: "alpha.env", variable: "LATE", value: "never-written" });
    await Bun.sleep(20);
    bench.seed({ [BOB]: TEAM[BOB]! });
    release();
    await restart;
    expect((await write).status).toBe(401);
    expect(bench.file("alpha.env")).not.toContain("LATE");
  });
});

describe("an Admin's project", () => {
  test("turns its general access public and back through the gatekeeper, named in the journal; a Developer cannot", async () => {
    const bench = await mount();
    const { alice, bob } = await team(bench);
    const token = await unlockAs(bench, alice, ALICE);
    const off = await bench.call("POST", "/members/portal", { session: alice, token, slug: "beta", active: false, confirmation: "beta" });
    expect(off.status).toBe(200);
    expect(bench.calls).toContainEqual(["start", "sitesolide-gatekeeper-off@beta.service"]);
    expect(bench.journal().at(-1)).toMatchObject({ operation: "portal", result: "ok", actor: ALICE, slug: "beta", detail: "off, ok" });

    const bobToken = await unlockAs(bench, bob, BOB);
    const refused = await bench.call("POST", "/members/portal", { session: bob, token: bobToken, slug: "alpha", active: true, confirmation: "" });
    expect(await body(refused)).toMatchObject({ error: "out-of-scope", message: `${BOB} is a Developer on alpha: changing its general access takes an Admin` });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "portal", result: "rejects", actor: BOB, detail: "role developer" });
  });

  test("restores a snapshot of it, the requester the email the steward verified; a Developer cannot", async () => {
    const bench = await mount();
    const { alice, bob } = await team(bench);
    const token = await unlockAs(bench, alice, ALICE);
    const snapshot = snapshotName("beta", bench.clock.t - SNAPSHOT_AGE_MS, "scheduled");
    const started = await bench.call("POST", "/members/backups/restore", { session: alice, token, slug: "beta", snapshot, confirmation: "beta" });
    expect(started.status).toBe(202);
    expect(await body(started)).toMatchObject({ restore: { state: "running", actor: ALICE, snapshot } });
    const request = JSON.parse(readFileSync(join(bench.root, "backup-state", "requests", "beta.json"), "utf8"));
    expect(request.actor).toBe(ALICE);
    expect(bench.calls).toContainEqual(["start", "--no-block", "sitesolide-restore@beta.service"]);
    // The requester is never the request's to name.
    expect((await bench.call("POST", "/members/backups/restore", { session: alice, token, slug: "beta", snapshot, confirmation: "beta", actor: "owner" })).status).toBe(400);

    const bobToken = await unlockAs(bench, bob, BOB);
    const refused = await bench.call("POST", "/members/backups/restore", { session: bob, token: bobToken, slug: "alpha", snapshot, confirmation: "alpha" });
    expect(await body(refused)).toMatchObject({ error: "out-of-scope", message: expect.stringContaining("backups") });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "backup.restore", result: "rejects", actor: BOB });
  });
});
