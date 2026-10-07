import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjection } from "../borrowed/access";
import { migrate, readMembersFile, slugOfHost, type InviteRow, type SharingRow } from "../src/access/migrate";
import { readRegistry, type Registry } from "../src/access/registry";
import { createAccessStore, type AccessEvent } from "../src/access/steward";
import { createAccessSystem } from "../src/access/system";

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

function store(paths: ReturnType<typeof tree>, events: AccessEvent[] = []) {
  return createAccessStore({
    system: createAccessSystem({ stateFolder: paths.state, portalKeyFolder: paths.key, groupsFile: "/etc/group", portalGroup: "", portalDataFolder: paths.data }, false),
    zone: ZONE,
    hostOf: (slug) => `${slug}.${ZONE}`,
    journal: async (event) => void events.push(event),
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
    const read = await access.read();
    expect(read).toMatchObject({ projects: {}, creators: [], migration: { from: [] } });
    expect(events).toEqual([]);
  });

  test("a portal database that does not read leaves no registry, refuses everyone, and is tried again", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [member("ann@acme.test", { blog: "admin" })] }));
    writeFileSync(join(paths.data, "portal.db"), "not a database");
    const access = store(paths);
    const refused = await access.read();
    expect(refused).toBeInstanceOf(Response);
    expect(((await (refused as Response).json()) as { message: string }).message).toContain("could not be carried over yet");
    expect(existsSync(join(paths.state, "access.json"))).toBe(false);
    // Repaired: the next read makes it.
    rmSync(join(paths.data, "portal.db"));
    portalDatabase(join(paths.data, "portal.db"), [], []);
    expect(await access.read()).toMatchObject({ projects: { blog: [{ who: "ann@acme.test" }] } });
  });

  test("a members.json that does not read is never guessed at", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), "{");
    expect(await store(paths).read()).toBeInstanceOf(Response);
    expect(existsSync(join(paths.state, "access.json"))).toBe(false);
  });

  test("the portal's database behind a link is not followed", async () => {
    const paths = tree();
    const elsewhere = join(paths.root, "elsewhere.db");
    portalDatabase(elsewhere, [sharing("blog", "people", ["spy@acme.test"], [])], []);
    symlinkSync(elsewhere, join(paths.data, "portal.db"));
    expect(await store(paths).read()).toBeInstanceOf(Response);
    expect(existsSync(join(paths.state, "access.json"))).toBe(false);
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
