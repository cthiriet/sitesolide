import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjection } from "../borrowed/access";
import { migrate, readMembersFile, slugOfHost, WITHOUT_PORTAL, type InviteRow, type SharingRow } from "../src/access/migrate";
import { readRegistry, type Registry } from "../src/access/registry";
import { createAccessStore, MIGRATING, MIGRATION_RETRY_MS, type AccessEvent } from "../src/access/steward";
import { createAccessSystem, EXPECTED_TABLES, MAX_SHARING_ROWS, normalizedSql, readCopy } from "../src/access/system";

/**
 * The registry made once from the stores before it, `members.json` and the
 * portal's database: nothing lost, nothing widened, conflicts toward the
 * higher role, made once, the old stores left as they were.
 */

const NOW = 1_800_000_000_000;
const ZONE = "test-zone.invalid";
const HASH = (n: number) => n.toString(16).padStart(64, "0");

const member = (email: string, roles: Record<string, "viewer" | "developer" | "admin">, create = false) => ({ email, roles, create, invitedBy: "owner", createdAt: NOW - 10, updatedAt: NOW - 5 });
const sharing = (slug: string, mode: string, people: string[], domains: string[]): SharingRow => ({ host: `${slug}.${ZONE}`, mode, people: JSON.stringify(people), domains: JSON.stringify(domains), updated_at: NOW - 3 });
const invite = (id: string, slug: string, label: string, n: number, expire: number | null = null): InviteRow => ({ id, hote: `${slug}.${ZONE}`, libelle: label, empreinte: HASH(n), cree_a: NOW - 100 + n, expire_a: expire });

function entries(registry: Registry, slug: string): [string, string, boolean][] {
  return (registry.projects[slug] ?? []).map((entry) => [entry.who, entry.role, entry.password !== undefined]);
}

describe("members.json", () => {
  test("every role carried over, the create right, who invited them and when", () => {
    const { registry, report } = migrate([member("ann@acme.test", { blog: "admin", shop: "viewer" }, true), member("bob@acme.test", { blog: "developer" })], null, ZONE, NOW);
    expect(entries(registry, "blog")).toEqual([
      ["ann@acme.test", "admin", false],
      ["bob@acme.test", "developer", false],
    ]);
    expect(entries(registry, "shop")).toEqual([["ann@acme.test", "viewer", false]]);
    expect(registry.creators).toEqual([{ email: "ann@acme.test", by: "owner", at: NOW - 10 }]);
    expect(registry.projects.blog![0]).toMatchObject({ by: "owner", createdAt: NOW - 10 });
    expect(report).toMatchObject({ roles: 3, creators: 1, setAside: 0 });
    expect(registry.migration).toEqual({ at: NOW, from: ["members.json"], setAside: [] });
  });

  test("a role on the platform's own projects is set aside, not given", () => {
    const { registry } = migrate([member("ann@acme.test", { dashboard: "admin", blog: "viewer" })], null, ZONE, NOW);
    expect(registry.projects.dashboard).toBeUndefined();
    expect(registry.migration!.setAside).toEqual([{ source: "members", slug: "dashboard", who: "ann@acme.test", reason: expect.stringContaining("platform") }]);
  });

  test("a file from before the create right, and a file that does not read", () => {
    expect(readMembersFile(JSON.stringify({ members: [{ email: "ann@acme.test", roles: { blog: "admin" }, invitedBy: "owner", createdAt: 1, updatedAt: 1 }] }))).toEqual([
      { email: "ann@acme.test", roles: { blog: "admin" }, create: false, invitedBy: "owner", createdAt: 1, updatedAt: 1 },
    ]);
    expect(readMembersFile(null)).toEqual([]);
    expect(readMembersFile("{")).toMatchObject({ unreadable: expect.any(String) });
    expect(readMembersFile(JSON.stringify({ members: [{ email: "ann@acme.test", roles: { blog: "owner" } }] }))).toMatchObject({ unreadable: expect.any(String) });
  });
});

describe("the portal's sharing", () => {
  test("people and domains the mode let in become Can open", () => {
    const { registry, report } = migrate([], { sharing: [sharing("blog", "people", ["see@acme.test"], []), sharing("shop", "domain", ["one@acme.test"], ["acme.test"])], invites: [] }, ZONE, NOW);
    expect(entries(registry, "blog")).toEqual([["see@acme.test", "visitor", false]]);
    expect(entries(registry, "shop")).toEqual([
      ["@acme.test", "visitor", false],
      ["one@acme.test", "visitor", false],
    ]);
    expect(report).toMatchObject({ people: 2, domains: 1 });
  });

  test("lists kept for later by a mode that let them out are set aside, never opened", () => {
    const { registry } = migrate([], { sharing: [sharing("blog", "admins", ["kept@acme.test"], ["acme.test"]), sharing("shop", "people", ["in@acme.test"], ["acme.test"])], invites: [] }, ZONE, NOW);
    expect(registry.projects.blog).toBeUndefined();
    expect(entries(registry, "shop")).toEqual([["in@acme.test", "visitor", false]]);
    expect(registry.migration!.setAside.map((one) => [one.slug, one.who])).toEqual([
      ["blog", "kept@acme.test"],
      ["blog", "@acme.test"],
      ["shop", "@acme.test"],
    ]);
  });

  test("a conflict goes to the higher role: a person both shared with and given a role keeps the role", () => {
    const { registry } = migrate([member("ann@acme.test", { blog: "developer" })], { sharing: [sharing("blog", "people", ["ann@acme.test"], [])], invites: [] }, ZONE, NOW);
    expect(entries(registry, "blog")).toEqual([["ann@acme.test", "developer", false]]);
  });

  test("a host this zone gives no project is set aside", () => {
    const { registry } = migrate([], { sharing: [{ ...sharing("blog", "people", ["x@acme.test"], []), host: "blog.elsewhere.test" }], invites: [] }, ZONE, NOW);
    expect(registry.projects).toEqual({});
    expect(registry.migration!.setAside).toHaveLength(1);
  });
});

describe("the portal's password access", () => {
  test("carried with its identifier, hash and expiry, so that passwords and cookies keep working", () => {
    const { registry, report } = migrate([], { sharing: [], invites: [invite("AAAAAAAAAAAAAAA1", "blog", "Guest@Example.org", 1, NOW + 5000), invite("AAAAAAAAAAAAAAA2", "blog", "Client Bob", 2)] }, ZONE, NOW);
    expect(registry.projects.blog).toEqual([
      { who: "Client Bob", role: "visitor", by: "migration", createdAt: NOW - 98, updatedAt: NOW - 98, password: { id: "AAAAAAAAAAAAAAA2", hash: HASH(2), expiresAt: null } },
      { who: "guest@example.org", role: "visitor", by: "migration", createdAt: NOW - 99, updatedAt: NOW - 99, password: { id: "AAAAAAAAAAAAAAA1", hash: HASH(1), expiresAt: NOW + 5000 } },
    ]);
    expect(report.passwords).toBe(2);
  });

  test("an expired one is carried with its expiry, and still opens nothing", () => {
    const { registry } = migrate([], { sharing: [], invites: [invite("AAAAAAAAAAAAAAA1", "blog", "late@example.org", 1, NOW - 1)] }, ZONE, NOW);
    expect(registry.projects.blog![0]!.password!.expiresAt).toBe(NOW - 1);
  });

  test("two given under one name stay two", () => {
    const { registry } = migrate([], { sharing: [], invites: [invite("AAAAAAAAAAAAAAA1", "blog", "Client", 1), invite("AAAAAAAAAAAAAAA2", "blog", "Client", 2)] }, ZONE, NOW);
    expect(entries(registry, "blog").map(([who]) => who)).toEqual(["Client", "Client (2)"]);
  });

  test("joins someone the sharing let in, and gives way to a higher role", () => {
    const { registry } = migrate(
      [member("dev@acme.test", { blog: "developer" })],
      { sharing: [sharing("blog", "people", ["see@acme.test"], [])], invites: [invite("AAAAAAAAAAAAAAA1", "blog", "see@acme.test", 1), invite("AAAAAAAAAAAAAAA2", "blog", "dev@acme.test", 2)] },
      ZONE,
      NOW,
    );
    expect(entries(registry, "blog")).toEqual([
      ["dev@acme.test", "developer", false],
      ["see@acme.test", "visitor", true],
    ]);
    expect(registry.migration!.setAside).toEqual([{ source: "password", slug: "blog", who: "dev@acme.test", reason: expect.stringContaining("developer") }]);
  });

  test("one for another zone's host, or one the portal would not read, is set aside", () => {
    const { registry } = migrate([], { sharing: [], invites: [{ ...invite("AAAAAAAAAAAAAAA1", "blog", "x@example.org", 1), hote: "blog.elsewhere.test" }, { ...invite("short", "blog", "y@example.org", 2) }] }, ZONE, NOW);
    expect(registry.projects).toEqual({});
    expect(registry.migration!.setAside).toHaveLength(2);
  });

  test("a host names its slug under the zone, and nothing else", () => {
    expect(slugOfHost(`blog.${ZONE}`, ZONE)).toBe("blog");
    expect(slugOfHost("blog.elsewhere.test", ZONE)).toBeNull();
    expect(slugOfHost(ZONE, ZONE)).toBeNull();
    expect(slugOfHost(`a.b.${ZONE}`, ZONE)).toBeNull();
  });
});

// --- the store: once, from the files, the old ones left as they were -------------------

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tree() {
  const root = mkdtempSync(join(tmpdir(), "access-migrate-"));
  folders.push(root);
  const state = join(root, "state");
  const key = join(root, "portal-key");
  const data = join(root, "portal-data");
  for (const folder of [state, key, data]) mkdirSync(folder, { recursive: true });
  return { root, state, key, data };
}

function portalDatabase(path: string, sharingRows: SharingRow[], invites: InviteRow[]): void {
  // The portal's own two tables, as its schema writes them.
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE invites (id TEXT PRIMARY KEY, hote TEXT NOT NULL, libelle TEXT NOT NULL, empreinte TEXT NOT NULL UNIQUE, cree_a INTEGER NOT NULL, expire_a INTEGER, vu_a INTEGER)");
  db.run("CREATE TABLE sharing (host TEXT PRIMARY KEY, mode TEXT NOT NULL, people TEXT NOT NULL, domains TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  for (const row of invites) db.query("INSERT INTO invites (id, hote, libelle, empreinte, cree_a, expire_a) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, row.hote, row.libelle, row.empreinte, row.cree_a, row.expire_a);
  for (const row of sharingRows) db.query("INSERT INTO sharing (host, mode, people, domains, updated_at) VALUES (?, ?, ?, ?, ?)").run(row.host, row.mode, row.people, row.domains, row.updated_at);
  // Left open, as the running portal leaves it: its last writes may still be in the -wal.
  folders.push(path);
}

function store(paths: ReturnType<typeof tree>, events: AccessEvent[] = [], sleep: (ms: number) => Promise<void> = async () => {}) {
  return createAccessStore({
    system: createAccessSystem({ stateFolder: paths.state, portalKeyFolder: paths.key, groupsFile: "/etc/group", portalGroup: "", portalDataFolder: paths.data }, false),
    zone: ZONE,
    hostOf: (slug) => `${slug}.${ZONE}`,
    journal: async (event) => void events.push(event),
    sleep,
  });
}

describe("the migration on the machine's files", () => {
  test("made at the first start from members.json and a live portal database, its projection written, the old stores untouched", async () => {
    const paths = tree();
    const membersText = JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] });
    writeFileSync(join(paths.state, "members.json"), membersText);
    const dbPath = join(paths.data, "portal.db");
    portalDatabase(dbPath, [sharing("blog", "domain", ["see@acme.test"], ["acme.test"])], [invite("AAAAAAAAAAAAAAA1", "blog", "guest@example.org", 1, NOW + 9_000_000_000)]);
    const dbBefore = readFileSync(dbPath);
    const events: AccessEvent[] = [];
    const access = store(paths, events);
    await access.ensure();

    const registry = readRegistry(readFileSync(join(paths.state, "access.json"), "utf8"));
    if ("unreadable" in registry) throw new Error(registry.unreadable);
    expect(entries(registry, "blog")).toEqual([
      ["@acme.test", "visitor", false],
      ["ann@acme.test", "admin", false],
      ["guest@example.org", "visitor", true],
      ["see@acme.test", "visitor", false],
    ]);
    expect(registry.migration!.from).toEqual(["members.json", "portal.db"]);
    expect(statSync(join(paths.state, "access.json")).mode & 0o777).toBe(0o600);
    const projection = readProjection(readFileSync(join(paths.key, "access.json"), "utf8"));
    expect(projection).toMatchObject({ sites: { [`blog.${ZONE}`]: { people: { "ann@acme.test": "admin", "see@acme.test": "visitor", "guest@example.org": "visitor" }, domains: ["acme.test"] } } });
    expect(statSync(join(paths.key, "access.json")).mode & 0o777).toBe(0o640);
    expect(events).toEqual([{ operation: "access.migrate", result: "ok", actor: "system", member: null, detail: expect.stringContaining("1 password access") }]);
    // Read-only: neither old store moved, and no copy of the database is left behind.
    expect(readFileSync(join(paths.state, "members.json"), "utf8")).toBe(membersText);
    expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
    expect(existsSync(join(paths.state, "members.json"))).toBe(true);
    expect(statSync(paths.state).isDirectory() && !readFileSync(join(paths.state, "access.json"), "utf8").includes("portal-copy")).toBe(true);
  });

  test("made once: a second start, or a change of the old stores afterwards, carries nothing over again", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] }));
    await store(paths).ensure();
    const first = readFileSync(join(paths.state, "access.json"), "utf8");
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [member("eve@acme.test", { blog: "admin" })] }));
    const events: AccessEvent[] = [];
    await store(paths, events).ensure();
    expect(readFileSync(join(paths.state, "access.json"), "utf8")).toBe(first);
    expect(events).toEqual([]);
  });

  test("nothing before it: begun empty, nothing journaled", async () => {
    const paths = tree();
    const events: AccessEvent[] = [];
    const access = store(paths, events);
    expect(await access.ensure()).toBe(true);
    expect(await access.read()).toMatchObject({ projects: {}, creators: [], migration: { from: [] } });
    expect(events).toEqual([]);
  });

  test("never in a request's way: a read before the registry is made answers migrating, and starts it in the background", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] }));
    writeFileSync(join(paths.data, "portal.db"), "not a database yet");
    // The background attempts wait on the test between two tries.
    let release: () => void = () => {};
    const access = store(paths, [], () => new Promise<void>((resolve) => (release = resolve)));
    const first = await access.read();
    expect(first).toBeInstanceOf(Response);
    expect((first as Response).status).toBe(503);
    expect(await (first as Response).json()).toMatchObject({ error: "migrating", message: MIGRATING });
    // A change too, refused before anything is judged.
    const refused = await access.change(async (registry) => ({ registry, value: "changed" }));
    expect(refused).toBeInstanceOf(Response);
    expect(((await (refused as Response).json()) as { error: string }).error).toBe("migrating");
    // The portal's database readable again, the next attempt makes the registry.
    rmSync(join(paths.data, "portal.db"));
    portalDatabase(join(paths.data, "portal.db"), [], []);
    while (!existsSync(join(paths.state, "access.json"))) {
      release();
      await Bun.sleep(5);
    }
    await access.start();
    expect(await access.read()).toMatchObject({ projects: { blog: [{ who: "ann@acme.test" }] } });
  });

  test("a portal database that does not read leaves no registry, refuses everyone, and is tried again later and later", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] }));
    writeFileSync(join(paths.data, "portal.db"), "not a database");
    const waits: number[] = [];
    let repaired = false;
    const access = store(paths, [], async (ms) => {
      waits.push(ms);
      // Repaired after the third wait: the next attempt makes it.
      if (waits.length === 3 && !repaired) {
        repaired = true;
        rmSync(join(paths.data, "portal.db"));
        portalDatabase(join(paths.data, "portal.db"), [], []);
      }
    });
    expect(await access.ensure()).toBe(false);
    expect(existsSync(join(paths.state, "access.json"))).toBe(false);
    const refused = await access.read();
    expect(((await (refused as Response).json()) as { error: string }).error).toBe("migrating");
    await access.start();
    expect(waits).toEqual([MIGRATION_RETRY_MS, MIGRATION_RETRY_MS * 2, MIGRATION_RETRY_MS * 4]);
    expect(await access.read()).toMatchObject({ projects: { blog: [{ who: "ann@acme.test" }] } });
  });

  test("a members.json that does not read is never guessed at", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), "{");
    expect(await store(paths).ensure()).toBe(false);
    expect(existsSync(join(paths.state, "access.json"))).toBe(false);
  });

  test("the portal's database behind a link is not followed", async () => {
    const paths = tree();
    const elsewhere = join(paths.root, "elsewhere.db");
    portalDatabase(elsewhere, [sharing("blog", "people", ["spy@acme.test"], [])], []);
    symlinkSync(elsewhere, join(paths.data, "portal.db"));
    expect(await store(paths).ensure()).toBe(false);
    expect(existsSync(join(paths.state, "access.json"))).toBe(false);
  });

  test("the owner's way out: carried over without the portal's database, the record says so; once made, refused", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] }));
    writeFileSync(join(paths.data, "portal.db"), "not a database");
    const events: AccessEvent[] = [];
    const access = store(paths, events);
    expect(await access.ensure()).toBe(false);
    const done = await access.migrateWithoutPortal();
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ people: 1, projects: 1, migration: { from: ["members.json"], setAside: [WITHOUT_PORTAL] } });
    const registry = readRegistry(readFileSync(join(paths.state, "access.json"), "utf8"));
    if ("unreadable" in registry) throw new Error(registry.unreadable);
    expect(registry.migration?.setAside).toContainEqual(WITHOUT_PORTAL);
    expect(events).toEqual([{ operation: "access.migrate", result: "ok", actor: "owner", member: null, detail: expect.stringContaining("without the portal's database") }]);
    const again = await access.migrateWithoutPortal();
    expect(again.status).toBe(409);
  });

  test("its answers name errors, never a path", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] }));
    const elsewhere = join(paths.root, "elsewhere.db");
    portalDatabase(elsewhere, [], []);
    symlinkSync(elsewhere, join(paths.data, "portal.db"));
    const reading = await createAccessSystem({ stateFolder: paths.state, portalKeyFolder: paths.key, groupsFile: "/etc/group", portalGroup: "", portalDataFolder: paths.data }, false).readPortalDatabase();
    expect(reading.kind).toBe("unreadable");
    expect(JSON.stringify(reading)).not.toContain(paths.root);
    expect(JSON.stringify(reading)).not.toContain("/");
  });

  test("rolling back is safe: the registry and its projection stay beside the old stores, which an older steward and portal read as they were", async () => {
    const paths = tree();
    const membersText = JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] });
    writeFileSync(join(paths.state, "members.json"), membersText);
    const access = store(paths);
    await access.ensure();
    // A change made after the migration goes to the registry alone.
    await access.change(async (registry) => ({ registry: { ...registry, projects: {} }, value: null }));
    expect(readFileSync(join(paths.state, "members.json"), "utf8")).toBe(membersText);
    chmodSync(join(paths.state, "members.json"), 0o600);
    expect(readMembersFile(readFileSync(join(paths.state, "members.json"), "utf8"))).toEqual([expect.objectContaining({ email: "ann@acme.test", roles: { blog: "admin" } })]);
  });
});

describe("a portal database the portal's account could have written", () => {
  function hostile(name: string, statements: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "access-hostile-"));
    folders.push(root);
    const path = join(root, `${name}.db`);
    const db = new Database(path, { create: true, strict: true });
    for (const statement of statements) db.run(statement);
    db.close();
    return path;
  }
  const INVITES = "CREATE TABLE invites (id TEXT PRIMARY KEY, hote TEXT NOT NULL, libelle TEXT NOT NULL, empreinte TEXT NOT NULL UNIQUE, cree_a INTEGER NOT NULL, expire_a INTEGER, vu_a INTEGER)";
  const SHARING = "CREATE TABLE sharing (host TEXT PRIMARY KEY, mode TEXT NOT NULL, people TEXT NOT NULL, domains TEXT NOT NULL, updated_at INTEGER NOT NULL)";

  test("the expected definitions are the portal's own, as SQLite keeps them, whitespace aside", () => {
    const path = hostile("own", [INVITES, SHARING]);
    const db = new Database(path, { readonly: true });
    const kept = db.query<{ name: "sharing" | "invites"; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
    db.close();
    for (const one of kept) expect(normalizedSql(one.sql)).toBe(EXPECTED_TABLES[one.name]);
    expect(readCopy(path)).toEqual({ sharing: [], invites: [] });
  });

  test("a generated column that would fill memory, another definition, a trigger or an index of its own: refused before any row is read", () => {
    const generated = hostile("generated", [
      "CREATE TABLE sharing (host TEXT, mode TEXT, people TEXT GENERATED ALWAYS AS (zeroblob(80000000) || '') VIRTUAL, domains TEXT, updated_at INTEGER)",
      "INSERT INTO sharing (host, mode, domains, updated_at) VALUES ('a.test', 'people', '[]', 1)",
    ]);
    expect(readCopy(generated)).toEqual({ reason: "unexpected-schema" });
    expect(readCopy(hostile("extra-column", [SHARING.replace("updated_at INTEGER NOT NULL", "updated_at INTEGER NOT NULL, extra TEXT")]))).toEqual({ reason: "unexpected-schema" });
    expect(readCopy(hostile("trigger", [SHARING, "CREATE TABLE side (x)", "CREATE TRIGGER t AFTER INSERT ON sharing BEGIN INSERT INTO side VALUES (1); END"]))).toEqual({ reason: "unexpected-schema" });
    expect(readCopy(hostile("index", [INVITES, "CREATE INDEX invites_lib ON invites (libelle)"]))).toEqual({ reason: "unexpected-schema" });
    expect(readCopy(hostile("view", ["CREATE VIEW sharing AS SELECT 1 AS host"]))).toEqual({ reason: "unexpected-schema" });
  });

  test("a value bigger than any the portal wrote, or of the wrong type, is measured, never read: refused", () => {
    const big = hostile("big", [SHARING, `INSERT INTO sharing VALUES ('a.test', 'people', '[' || printf('%.*c', 300000, 'x') || ']', '[]', 1)`]);
    expect(readCopy(big)).toEqual({ reason: "oversized-rows" });
    const blob = hostile("blob", [SHARING, "INSERT INTO sharing VALUES ('a.test', 'people', x'00ff', '[]', 1)"]);
    expect(readCopy(blob)).toEqual({ reason: "oversized-rows" });
    const hash = hostile("hash", [INVITES, "INSERT INTO invites (id, hote, libelle, empreinte, cree_a) VALUES ('AAAAAAAAAAAAAAA1', 'a.test', 'x', 'short', 1)"]);
    expect(readCopy(hash)).toEqual({ reason: "oversized-rows" });
  });

  test("more rows than a portal ever kept: refused", () => {
    const rows: string[] = [];
    for (let i = 0; i <= MAX_SHARING_ROWS; i += 500) {
      const values = Array.from({ length: Math.min(500, MAX_SHARING_ROWS + 1 - i) }, (_, k) => `('h${i + k}.test', 'people', '[]', '[]', 1)`);
      if (values.length > 0) rows.push(`INSERT INTO sharing VALUES ${values.join(", ")}`);
    }
    expect(readCopy(hostile("many", [SHARING, ...rows]))).toEqual({ reason: "too-many-rows" });
  });

  test("a file that is no database is a reason by name, never a message", () => {
    const root = mkdtempSync(join(tmpdir(), "access-hostile-"));
    folders.push(root);
    const path = join(root, "junk.db");
    writeFileSync(path, "x".repeat(4096));
    const read = readCopy(path);
    expect("reason" in read).toBe(true);
    expect((read as { reason: string }).reason).toMatch(/^[A-Za-z_-]+$/);
  });

  test("the whole migration stops on such a database, and says it by name", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] }));
    const db = new Database(join(paths.data, "portal.db"), { create: true, strict: true });
    db.run("CREATE TABLE sharing (host TEXT, mode TEXT, people TEXT GENERATED ALWAYS AS (zeroblob(80000000) || '') VIRTUAL, domains TEXT, updated_at INTEGER)");
    db.close();
    const reading = await createAccessSystem({ stateFolder: paths.state, portalKeyFolder: paths.key, groupsFile: "/etc/group", portalGroup: "", portalDataFolder: paths.data }, false).readPortalDatabase();
    expect(reading).toEqual({ kind: "unreadable", reason: "unexpected-schema" });
    expect(await store(paths).ensure()).toBe(false);
    expect(existsSync(join(paths.state, "access.json"))).toBe(false);
  });
});
