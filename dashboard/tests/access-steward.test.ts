import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjection, type Projection } from "../borrowed/access";
import { createAccessRoutes, createAccessStore, LOG_FULL, passwordHash, PASSWORD_LOCKED, type AccessEvent } from "../src/access/steward";
import { createAccessRoutes as createDashboardAccessRoutes, ACCESS_LOCKED } from "../src/access/routes";
import type { AccessSteward } from "../src/access/client";
import { createTokens } from "../src/secrets/tokens";
import { createAccessSystem } from "../src/access/system";
import { encodeRegistry, EMPTY_REGISTRY, putEntry, readRegistry, type Entry, type Registry } from "../src/access/registry";

/**
 * The steward's access routes on a throwaway tree: the owner over SSH and in
 * the dashboard. Every change lands in the registry and in the portal's
 * projection before the answer leaves, so the portal refuses someone removed
 * at their next request.
 */

const ZONE = "test-zone.invalid";
const HOST = `blog.${ZONE}`;
const UNLOCK = "owner-unlock-token-0123456789";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

let seeded = 0;
/** A password access as the registry keeps it, its identifier new each time. */
const record = () => ({ id: `seed${String(++seeded).padStart(12, "0")}`, hash: passwordHash(`seeded-${seeded}`), expiresAt: null });

function seed(entries: [string, string][]): Registry {
  let registry: Registry = EMPTY_REGISTRY;
  for (const [slug, who] of entries) {
    const put = putEntry(registry, slug, who, "owner", 1, record);
    if ("refusal" in put) throw new Error(put.refusal);
    registry = put.registry;
  }
  return registry;
}

/** The routes over a temp tree. */
function bench(registry: Registry, options: { zone?: string; full?: () => boolean; changesPerHour?: number; ownerChangesPerHour?: number; clock?: { value: number } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "access-steward-"));
  folders.push(root);
  const state = join(root, "state");
  const key = join(root, "portal-key");
  mkdirSync(state, { recursive: true });
  mkdirSync(key, { recursive: true });
  writeFileSync(join(state, "access.json"), encodeRegistry(registry), { mode: 0o600 });
  const events: AccessEvent[] = [];
  const zone = options.zone ?? ZONE;
  const system = createAccessSystem({ stateFolder: state, sitesDir: join(root, "sites"), portalKeyFolder: key, groupsFile: "/etc/group", portalGroup: "" });
  const store = createAccessStore({
    system: options.clock === undefined ? system : { ...system, now: () => options.clock!.value },
    zone,
    hostOf: (slug) => `${slug}.${zone}`,
    logFull: async () => options.full?.() ?? false,
  });
  let drawn = 0;
  const routes = createAccessRoutes({
    store,
    zone,
    hostOf: (slug) => `${slug}.${zone}`,
    ...(options.changesPerHour === undefined ? {} : { changesPerHour: options.changesPerHour }),
    ...(options.ownerChangesPerHour === undefined ? {} : { ownerChangesPerHour: options.ownerChangesPerHour }),
    projectExists: (slug) => ["blog", "shop"].includes(slug),
    general: async (slug) => (["blog", "shop"].includes(slug) ? { access: "restricted", modifiable: true, reason: null } : null),
    portalReading: async () => ({ reading: "steward", writtenAt: 1 }),
    isUnlocked: async (token) => token === UNLOCK,
    readBody: async (req, fields) => {
      const body = (await req.json()) as Record<string, unknown>;
      return Object.keys(body).every((field) => fields.includes(field)) ? body : Response.json({ error: "invalid", message: "unexpected field" }, { status: 400 });
    },
    journal: async (event) => void events.push(event),
    drawPassword: () => `Pass-word-${++drawn}-xxxx`,
    drawId: () => `id${String(drawn).padStart(14, "0")}`,
  });
  const call = (table: "owner" | "dashboard", method: string, path: string, body?: object) => {
    const handler = routes[table][path.split("?")[0]!]?.[method];
    if (handler === undefined) throw new Error(`no route ${method} ${path}`);
    return handler(new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  };
  const projection = (): Projection => {
    const read = readProjection(readFileSync(join(key, "access.json"), "utf8"));
    if ("unreadable" in read) throw new Error(read.unreadable);
    return read;
  };
  const saved = () => JSON.parse(readFileSync(join(state, "access.json"), "utf8")) as Registry;
  return { routes, call, projection, saved, events, key, state, store };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const whoOn = (projection: Projection, host: string) => (projection.sites[host]?.passwords ?? []).map((grant) => grant.who);

describe("the owner, over SSH", () => {
  test("lists a project's general access and guests, never a hash", async () => {
    const { call } = bench(seed([["blog", "ann@acme.test"]]));
    const response = await call("owner", "GET", "/access?slug=blog");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      slug: "blog",
      host: HOST,
      url: `https://${HOST}/`,
      general: { access: "restricted" },
      entries: [{ who: "ann@acme.test", by: "owner", expiresAt: null, expired: false }],
      portal: { reading: "steward" },
    });
    expect(JSON.stringify(body)).not.toContain(passwordHash("seeded-1"));
    expect((await call("owner", "GET", "/access?slug=dashboard")).status).toBe(403);
    expect((await call("owner", "GET", "/access?slug=gone")).status).toBe(404);
  });

  test("password access with no token at all: drawn, shown once, kept as a hash, the projection written before the answer", async () => {
    const { call, projection, saved, events } = bench(seed([]));
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: "Guest@Example.org", expiresInS: 86400 });
    const body = await json(response);
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ change: "add", entry: { who: "guest@example.org", by: "owner", expired: false }, password: "Pass-word-1-xxxx" });
    expect(projection().sites[HOST]!.passwords[0]).toMatchObject({ who: "guest@example.org", hash: passwordHash("Pass-word-1-xxxx") });
    expect(JSON.stringify(saved())).not.toContain("Pass-word-1-xxxx");
    expect(events).toEqual([{ operation: "access.add", result: "ok", actor: "owner", member: "guest@example.org", slug: "blog", detail: expect.stringContaining("guest@example.org: password access until") }]);
    // Given again, it keeps its password: no new one is drawn.
    const again = await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org" }));
    expect(again).toMatchObject({ change: "none" });
    expect(again.password).toBeUndefined();
  });

  test("a command of before naming Can open is still read; any other role, a domain, a duration not offered are refused", async () => {
    const { call } = bench(seed([]));
    expect((await call("owner", "PUT", "/access/entry", { slug: "blog", who: "a@acme.test", role: "visitor" })).status).toBe(201);
    expect(await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "b@acme.test", role: "developer" }))).toMatchObject({ error: "invalid" });
    expect(await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "@acme.test" }))).toMatchObject({ error: "invalid" });
    expect(await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "c@acme.test", expiresInS: 60 }))).toMatchObject({ error: "invalid" });
  });

  test("removing holds from the next request: the portal reads it at once", async () => {
    const { call, projection, events } = bench(seed([["blog", "dev@acme.test"], ["blog", "see@acme.test"]]));
    await call("owner", "GET", "/access?slug=blog");
    const removed = await call("owner", "DELETE", "/access/entry", { slug: "blog", who: "see@acme.test" });
    expect(await json(removed)).toMatchObject({ change: "remove", entry: { who: "see@acme.test" } });
    expect(whoOn(projection(), HOST)).toEqual(["dev@acme.test"]);
    expect(events.at(-1)).toMatchObject({ operation: "access.remove", actor: "owner", member: "see@acme.test" });
    expect((await call("owner", "DELETE", "/access/entry", { slug: "blog", who: "see@acme.test" })).status).toBe(404);
  });

  test("no route of company sign-in is left", () => {
    const { routes } = bench(seed([]));
    expect(Object.keys(routes.owner).sort()).toEqual(["/access", "/access/entry"]);
    expect(Object.keys(routes.dashboard).sort()).toEqual(["/access", "/access/entry"]);
  });
});

describe("the owner, in the dashboard", () => {
  test("password access needs the unlock; nothing is drawn or written without it", async () => {
    const { call, saved, key, events } = bench(seed([]));
    for (const token of [undefined, "wrong"]) {
      const refused = await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", ...(token === undefined ? {} : { token }) });
      expect(refused.status).toBe(401);
      expect(await json(refused)).toEqual({ error: "locked", message: PASSWORD_LOCKED });
    }
    expect(saved().projects.blog ?? []).toEqual([]);
    // Neither registry nor projection written: the portal was told nothing.
    expect(existsSync(join(key, "access.json"))).toBe(false);
    expect(events).toEqual([]);
    const given = await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", token: UNLOCK });
    expect(given.status).toBe(201);
    expect(await json(given)).toMatchObject({ entry: { who: "guest@example.org" }, password: "Pass-word-1-xxxx" });
  });

  test("removing, and a guest asked for again, never wait for the unlock", async () => {
    const { call } = bench(seed([["blog", "guest@example.org"], ["blog", "out@example.org"]]));
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org" })).status).toBe(200);
    expect((await call("dashboard", "DELETE", "/access/entry", { slug: "blog", who: "out@example.org" })).status).toBe(200);
  });

  test("a role is not read from the dashboard at all", async () => {
    const { call } = bench(seed([]));
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", role: "visitor", token: UNLOCK })).status).toBe(400);
  });
});

describe("both halves: the dashboard's routes over the steward's", () => {
  const NOW = Date.now();
  const PUBLIC_URL = `https://dashboard.${ZONE}`;

  function dashboard() {
    const steward = bench(seed([["blog", "ann@acme.test"]]));
    const relay: AccessSteward = {
      list: (slug) => steward.call("dashboard", "GET", `/access?slug=${slug}`),
      put: (body) => steward.call("dashboard", "PUT", "/access/entry", body),
      remove: (body) => steward.call("dashboard", "DELETE", "/access/entry", body),
      general: async () => Response.json({}),
    };
    const tokens = createTokens(() => NOW);
    const session = { hash: "h1", createdAt: NOW, seenAt: NOW, identity: "owner" };
    const routes = createDashboardAccessRoutes({ publicUrl: PUBLIC_URL, stateFile: "/nonexistent/state.json", steward: relay, session: async () => session, tokens }, () => NOW);
    const put = (body: object) => routes.put(new Request(`${PUBLIC_URL}/api/access/entry`, { method: "PUT", headers: { origin: PUBLIC_URL }, body: JSON.stringify(body) }));
    return { put, tokens, saved: steward.saved };
  }

  test("the owner's session without a live unlock gets the page's 423, and the password once unlocked", async () => {
    const { put, tokens, saved } = dashboard();
    const locked = await put({ slug: "blog", who: "guest@example.org" });
    expect(locked.status).toBe(423);
    expect(await locked.json()).toEqual({ error: "locked", message: ACCESS_LOCKED });
    expect(saved().projects.blog!.map((entry) => entry.who)).toEqual(["ann@acme.test"]);
    tokens.set("h1", { token: UNLOCK, expiresAt: NOW + 60_000 });
    const given = await put({ slug: "blog", who: "guest@example.org" });
    expect(given.status).toBe(201);
    expect(await given.json()).toMatchObject({ entry: { who: "guest@example.org" }, password: "Pass-word-1-xxxx" });
  });
});

describe("the files", () => {
  test("the registry stays root's alone, the projection readable by the portal's group", async () => {
    const { call, state, key } = bench(seed([]));
    await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test" });
    expect(statSync(join(state, "access.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(key, "access.json")).mode & 0o777).toBe(0o640);
  });

  test("a registry that does not read refuses everything, and nothing is written over it", async () => {
    const { call, state } = bench(seed([]));
    writeFileSync(join(state, "access.json"), "{ broken");
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test" });
    expect(response.status).toBe(500);
    expect(readFileSync(join(state, "access.json"), "utf8")).toBe("{ broken");
  });
});

/** A valid address of exactly this length: a 64-character local part, labels of 63 at most, then `.example`. */
function addressOf(length: number): string {
  let domain = "example";
  const room = length - 65;
  while (domain.length < room) {
    const label = Math.min(63, room - domain.length - 1);
    domain = `${"b".repeat(Math.max(1, label))}.${domain}`;
  }
  return `${"a".repeat(64)}@${domain}`;
}

describe("nothing is written that would not read back", () => {
  test("an address of 121 to 254 characters reads back in the registry and in the projection", async () => {
    const { call, saved, projection } = bench(seed([]));
    for (const length of [121, 160, 200, 254]) {
      const who = addressOf(length);
      expect(who.length).toBe(length);
      const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who });
      expect({ length, status: response.status }).toEqual({ length, status: 201 });
      expect(readRegistry(JSON.stringify(saved()))).not.toHaveProperty("unreadable");
      expect(whoOn(projection(), HOST)).toContain(who);
    }
    // And the steward still reads its own registry: the next request is answered.
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
  });

  test("an address past 254 characters is refused, nothing written", async () => {
    const { call, saved } = bench(seed([]));
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: `${"a".repeat(64)}@${"b".repeat(200)}.example` });
    expect(response.status).toBe(400);
    expect(saved().projects).toEqual({});
  });

  test("a dotted slug is refused where the registry would refuse to read it, the machine carrying it or not", async () => {
    const { call, saved } = bench(seed([]));
    for (const slug of ["blog.old", "test-zone.invalid", "a..b"]) {
      expect((await call("owner", "PUT", "/access/entry", { slug, who: "dev@acme.test" })).status).toBe(400);
    }
    expect(saved().projects).toEqual({});
  });

  test("a change that would take the registry past the 8 MB it is read with is refused, nothing written", async () => {
    // A registry just under its bound, written by hand: entries of the longest kind on many projects.
    let registry: Registry = EMPTY_REGISTRY;
    const projects: Registry["projects"] = {};
    const password = { id: "AAAAAAAAAAAAAAAA", hash: "a".repeat(64), expiresAt: null };
    for (let p = 0; p < 40; p++) {
      projects[`p${p}`] = Array.from({ length: 600 }, (_, i): Entry => ({ who: `${String(i).padStart(4, "0")}${"q".repeat(56)}@${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(60)}.example`, by: "owner", createdAt: 1, updatedAt: 1, password }));
    }
    const limit = 8 * 1024 * 1024;
    let names = Object.keys(projects);
    for (;;) {
      registry = { ...registry, projects: Object.fromEntries(names.map((name) => [name, projects[name]!])) };
      if (Buffer.byteLength(encodeRegistry(registry)) <= limit) break;
      names = names.slice(0, -1);
    }
    // Topped up entry by entry until one more of the same would not fit.
    const spare = [...(projects[`p${names.length}`] ?? [])];
    while (spare.length > 0) {
      const next = { ...registry, projects: { ...registry.projects, extra: [...(registry.projects.extra ?? []), spare[0]!] } };
      if (Buffer.byteLength(encodeRegistry(next)) > limit) break;
      registry = next;
      spare.shift();
    }
    const { call, saved } = bench(registry);
    const before = JSON.stringify(saved());
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: addressOf(254) });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: "invalid", message: expect.stringContaining("could not read back") });
    expect(JSON.stringify(saved())).toBe(before);
    // And the steward still reads its registry.
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
    // Topping up entry by entry encodes 8 MB each time: a few seconds here,
    // past the default 5 on the release runner.
  }, 30_000);

  test("a change whose projection the portal could not read is refused before anything is written", async () => {
    // A zone so long that a site's address outgrows a host name.
    const zone = `${"z".repeat(60)}.${"y".repeat(60)}.${"x".repeat(60)}.${"w".repeat(60)}.invalid`;
    const { call, saved, key } = bench(seed([]), { zone });
    const before = JSON.stringify(saved());
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test" });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: "invalid", message: expect.stringContaining("could not read back") });
    expect(JSON.stringify(saved())).toBe(before);
    expect(existsSync(join(key, "access.json"))).toBe(false);
  });
});

describe("the projection repairs itself", () => {
  test("deleted, or edited by hand, it is written again from the registry at the next read", async () => {
    const { call, key, store } = bench(seed([["blog", "dev@acme.test"]]));
    expect(await store.ensure()).toBe(true);
    const file = join(key, "access.json");
    rmSync(file);
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
    await store.change(async (registry) => ({ registry, value: null }));
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, "{}");
    await call("owner", "GET", "/access?slug=blog");
    await store.change(async (registry) => ({ registry, value: null }));
    expect(readProjection(readFileSync(file, "utf8"))).toMatchObject({ sites: { [HOST]: { passwords: [{ who: "dev@acme.test" }] } } });
  });

  test("a registry repaired by hand after it did not read is projected again, not left behind", async () => {
    const { call, key, state, store } = bench(seed([]));
    writeFileSync(join(state, "access.json"), "{ broken");
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(500);
    writeFileSync(join(state, "access.json"), encodeRegistry(seed([["blog", "new@acme.test"]])));
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
    await store.change(async (registry) => ({ registry, value: null }));
    expect(readProjection(readFileSync(join(key, "access.json"), "utf8"))).toMatchObject({ sites: { [HOST]: { passwords: [{ who: "new@acme.test" }] } } });
  });
});

describe("the access log's bounds", () => {
  test("a full log of rows younger than 180 days refuses whatever lets more people in, and says why", async () => {
    let full = false;
    const { call, saved } = bench(seed([["blog", "dev@acme.test"]]), { full: () => full });
    full = true;
    const response = await call("dashboard", "PUT", "/access/entry", { token: UNLOCK, slug: "blog", who: "new@acme.test" });
    expect(response.status).toBe(507);
    expect(await json(response)).toMatchObject({ error: "log-full", message: LOG_FULL });
    expect(saved().projects.blog).toHaveLength(1);
    // Reading is never refused, nor removing.
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
    // The owner over SSH is the way out: still heard.
    expect((await call("owner", "PUT", "/access/entry", { slug: "blog", who: "new@acme.test" })).status).toBe(201);
    expect((await call("dashboard", "DELETE", "/access/entry", { slug: "blog", who: "new@acme.test" })).status).toBe(200);
    full = false;
    expect((await call("dashboard", "PUT", "/access/entry", { token: UNLOCK, slug: "blog", who: "late@acme.test" })).status).toBe(201);
  });

  test("each channel's accepted changes are counted per hour; the owner over SSH has a generous allowance of their own", async () => {
    const clock = { value: 1_800_000_000_000 };
    const { call } = bench(seed([]), { changesPerHour: 3, ownerChangesPerHour: 5, clock });
    const give = (table: "owner" | "dashboard", n: number) => call(table, "PUT", "/access/entry", { ...(table === "dashboard" ? { token: UNLOCK } : {}), slug: "blog", who: `p${n}@acme.test` });
    for (let n = 0; n < 3; n++) expect((await give("dashboard", n)).status).toBe(201);
    const refused = await give("dashboard", 3);
    expect(refused.status).toBe(429);
    expect(await json(refused)).toMatchObject({ error: "too-many-changes" });
    // Nothing changed is not counted: asking for the same guest again still answers.
    expect((await give("dashboard", 0)).status).toBe(200);
    // Removing is never counted.
    expect((await call("dashboard", "DELETE", "/access/entry", { slug: "blog", who: "p1@acme.test" })).status).toBe(200);
    // The owner over SSH has their own count.
    for (let n = 10; n < 15; n++) expect((await give("owner", n)).status).toBe(201);
    expect((await give("owner", 15)).status).toBe(429);
    // An hour later, counted afresh.
    clock.value += 3_600_001;
    expect((await give("dashboard", 20)).status).toBe(201);
  });

  test("a change made elsewhere that lets more people in is bounded the same way", async () => {
    const { routes } = bench(seed([]), { full: () => true });
    expect((await routes.widen("dashboard"))?.status).toBe(507);
    expect(await routes.widen("ssh")).toBeNull();
  });
});

describe("a project removed or renamed on the machine", () => {
  test("removed, its guests are dropped and journaled", async () => {
    const { routes, saved, events, projection } = bench(seed([["blog", "dev@acme.test"], ["blog", "two@acme.test"], ["shop", "two@acme.test"]]));
    expect(await routes.forgetProject("blog", "owner")).toBe(2);
    expect(saved().projects).toEqual({ shop: [expect.objectContaining({ who: "two@acme.test" })] });
    expect(projection().sites[HOST]).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ operation: "project.remove", actor: "owner", slug: "blog", detail: expect.stringContaining("dev@acme.test, two@acme.test") });
    // Nothing left: nothing journaled again.
    const journaled = events.length;
    expect(await routes.forgetProject("blog", "owner")).toBe(0);
    expect(events).toHaveLength(journaled);
  });

  test("a project created again under that name starts from nobody", async () => {
    const { routes, call, saved } = bench(seed([["blog", "eve@acme.test"]]));
    await routes.forgetProject("blog", "owner");
    expect(await json(await call("owner", "GET", "/access?slug=blog"))).toMatchObject({ entries: [] });
    expect(saved().projects.blog).toBeUndefined();
  });

  test("renamed, its guests open it under the new name with the passwords they hold", async () => {
    const { routes, saved, projection } = bench(seed([["blog", "eve@acme.test"]]));
    const before = saved().projects.blog![0]!.password;
    expect(await routes.renameProject("blog", "shop", "owner")).toBe(1);
    expect(saved().projects).toEqual({ shop: [expect.objectContaining({ who: "eve@acme.test", password: before })] });
    expect(whoOn(projection(), `shop.${ZONE}`)).toEqual(["eve@acme.test"]);
  });
});
