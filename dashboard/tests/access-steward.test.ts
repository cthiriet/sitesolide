import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emailRole, readProjection, type Projection } from "../borrowed/access";
import type { MemberPrincipal } from "../src/people/steward";
import type { Resolved } from "../src/people/identity";
import { createAccessRoutes, createAccessStore, LOG_FULL, passwordHash, PASSWORD_LOCKED, type AccessEvent } from "../src/access/steward";
import { createAccessRoutes as createDashboardAccessRoutes, ACCESS_LOCKED } from "../src/access/routes";
import type { AccessSteward } from "../src/access/client";
import { createTokens } from "../src/secrets/tokens";
import { createAccessSystem } from "../src/access/system";
import { encodeRegistry, EMPTY_REGISTRY, putEntry, readRegistry, setCreate, type Registry } from "../src/access/registry";
import type { LeavingToken, SignInSettings } from "../src/access/protocol";

/**
 * The steward's access routes on a throwaway tree: the owner over SSH and in
 * the dashboard, an Admin through their session, a token through the control
 * routes. Every change lands in the registry and in the portal's projection
 * before the answer leaves, so the portal refuses someone removed or lowered
 * at their next request.
 */

const ZONE = "test-zone.invalid";
const HOST = `blog.${ZONE}`;
const UNLOCK = "owner-unlock-token-0123456789";
const SSO: SignInSettings = { configured: true, allowedDomains: ["acme.test"], admins: ["boss@elsewhere.test"], providerName: "Acme" };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Session = { session: string; email: string; unlock: string | null };

function seed(entries: [string, string, "visitor" | "viewer" | "developer" | "admin"][], creators: string[] = []): Registry {
  let registry: Registry = { ...EMPTY_REGISTRY, migration: { at: 1, from: [], setAside: [] } };
  for (const [slug, who, role] of entries) {
    const put = putEntry(registry, slug, who, role, "owner", 1);
    if ("refusal" in put) throw new Error(put.refusal);
    registry = put.registry;
  }
  for (const email of creators) {
    const set = setCreate(registry, email, true, "owner", 1);
    if ("refusal" in set) throw new Error(set.refusal);
    registry = set.registry;
  }
  return registry;
}

/** The routes over a temp tree; the people's sessions are a table of the test's. */
function bench(
  registry: Registry,
  options: { signIn?: SignInSettings; sessions?: Session[]; zone?: string; full?: () => boolean; changesPerHour?: number; ownerChangesPerHour?: number; clock?: { value: number }; tokens?: Record<string, LeavingToken[]> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "access-steward-"));
  folders.push(root);
  const state = join(root, "state");
  const key = join(root, "portal-key");
  mkdirSync(state, { recursive: true });
  mkdirSync(key, { recursive: true });
  writeFileSync(join(state, "access.json"), encodeRegistry(registry), { mode: 0o600 });
  const events: AccessEvent[] = [];
  const left: { email: string; actor: string }[] = [];
  const tokens = options.tokens ?? {};
  const sessions = options.sessions ?? [];
  const zone = options.zone ?? ZONE;
  const system = createAccessSystem({ stateFolder: state, portalKeyFolder: key, groupsFile: "/etc/group", portalGroup: "", portalDataFolder: join(root, "no-portal") }, false);
  const store = createAccessStore({
    system: options.clock === undefined ? system : { ...system, now: () => options.clock!.value },
    zone,
    hostOf: (slug) => `${slug}.${zone}`,
    journal: async (event) => void events.push(event),
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
    signIn: async () => options.signIn ?? SSO,
    general: async (slug) => (["blog", "shop"].includes(slug) ? { access: "restricted", modifiable: true, reason: null } : null),
    portalReading: async () => ({ reading: "steward", writtenAt: 1 }),
    isUnlocked: async (token) => token === UNLOCK,
    readBody: async (req, fields) => {
      const body = (await req.json()) as Record<string, unknown>;
      return Object.keys(body).every((field) => fields.includes(field)) ? body : Response.json({ error: "invalid", message: "unexpected field" }, { status: 400 });
    },
    journal: async (event) => void events.push(event),
    journalRefusal: async (event) => void events.push(event),
    authorize: async (session, unlock) => {
      const found = sessions.find((one) => one.session === session);
      if (found === undefined) return Response.json({ error: "signed-out", message: "closed" }, { status: 401 });
      if (unlock !== null && unlock !== found.unlock) return Response.json({ error: "locked", message: "locked" }, { status: 401 });
      const principal: MemberPrincipal = { email: found.email, roles: {}, create: false, session: found.session };
      return principal;
    },
    leave: async (email, actor) => {
      left.push({ email, actor });
      return tokens[email] ?? [];
    },
    tokensOf: async (email) => tokens[email] ?? [],
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
  return { routes, call, projection, saved, events, left, key, state, store };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("the owner, over SSH", () => {
  test("lists a project's general access and people with access, never a hash", async () => {
    const { call } = bench(seed([["blog", "ann@acme.test", "admin"]]));
    const response = await call("owner", "GET", "/access?slug=blog");
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      slug: "blog",
      host: HOST,
      url: `https://${HOST}/`,
      general: { access: "restricted" },
      entries: [{ who: "ann@acme.test", kind: "person", role: "admin" }],
      signIn: SSO,
      portal: { reading: "steward" },
    });
    expect((await call("owner", "GET", "/access?slug=dashboard")).status).toBe(403);
    expect((await call("owner", "GET", "/access?slug=gone")).status).toBe(404);
  });

  test("gives any role without an unlock, the projection written before the answer", async () => {
    const { call, projection, events, saved } = bench(seed([]));
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: "Dev@Acme.test", role: "developer" });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ slug: "blog", entry: { who: "dev@acme.test", role: "developer", by: "owner" }, change: "add" });
    expect(projection().sites[HOST]!.people).toEqual({ "dev@acme.test": "developer" });
    expect(saved().projects.blog).toEqual([expect.objectContaining({ who: "dev@acme.test", role: "developer" })]);
    expect(events).toEqual([{ operation: "access.add", result: "ok", actor: "owner", member: "dev@acme.test", slug: "blog", detail: "dev@acme.test: Developer" }]);
  });

  test("password access for someone outside the company's domains: drawn, shown once, kept as a hash", async () => {
    const { call, projection, saved } = bench(seed([]));
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", role: "visitor", expiresInS: 86400 });
    const body = await json(response);
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ change: "add", entry: { who: "guest@example.org", kind: "password", role: "visitor", password: { expired: false } }, password: "Pass-word-1-xxxx" });
    const grant = projection().sites[HOST]!.passwords[0]!;
    expect(grant).toMatchObject({ who: "guest@example.org", hash: passwordHash("Pass-word-1-xxxx") });
    expect(JSON.stringify(saved())).not.toContain("Pass-word-1-xxxx");
    // Given again, it keeps its password: no new one is drawn.
    const again = await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", role: "visitor" }));
    expect(again).toMatchObject({ change: "none" });
    expect(again.password).toBeUndefined();
  });

  test("the rules hold for the owner too: a domain is Can open, outside the company only Can open", async () => {
    const { call } = bench(seed([]));
    expect(await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "@acme.test", role: "viewer" }))).toMatchObject({ error: "invalid" });
    expect(await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", role: "developer" }))).toMatchObject({ error: "invalid" });
    expect(await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "a@acme.test", role: "owner" }))).toMatchObject({ error: "invalid" });
    expect(await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "a@acme.test", role: "visitor", expiresInS: 60 }))).toMatchObject({ error: "invalid" });
  });

  test("removing and lowering hold from the next request: the portal reads them at once", async () => {
    const { call, projection } = bench(seed([["blog", "dev@acme.test", "developer"], ["blog", "see@acme.test", "visitor"]]));
    await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test", role: "visitor" });
    expect(emailRole(projection().sites[HOST], "dev@acme.test", [])).toBe("visitor");
    const removed = await call("owner", "DELETE", "/access/entry", { slug: "blog", who: "see@acme.test" });
    expect(await json(removed)).toMatchObject({ change: "remove", entry: { who: "see@acme.test" } });
    expect(emailRole(projection().sites[HOST], "see@acme.test", [])).toBeNull();
    expect((await call("owner", "DELETE", "/access/entry", { slug: "blog", who: "see@acme.test" })).status).toBe(404);
  });

  test("someone whose last role above Can open goes no longer signs in: their sessions and tokens follow", async () => {
    const { call, left } = bench(seed([["blog", "dev@acme.test", "developer"], ["shop", "two@acme.test", "viewer"], ["blog", "two@acme.test", "admin"]]));
    await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test", role: "visitor" });
    await call("owner", "DELETE", "/access/entry", { slug: "blog", who: "two@acme.test" });
    expect(left).toEqual([{ email: "dev@acme.test", actor: "owner" }]);
  });

  test("People: everyone, the create right given and taken back, someone taken off everywhere", async () => {
    const { call, events, left } = bench(seed([["blog", "dev@acme.test", "developer"], ["shop", "dev@acme.test", "viewer"]]));
    expect(await json(await call("owner", "GET", "/people"))).toMatchObject({
      people: [
        { who: "boss@elsewhere.test", admin: true },
        { who: "dev@acme.test", roles: { blog: "developer", shop: "viewer" }, create: false },
      ],
      signIn: SSO,
    });
    expect(await json(await call("owner", "PUT", "/people/person", { email: "maker@acme.test", create: true }))).toMatchObject({ person: { who: "maker@acme.test", create: true }, change: "create" });
    expect(await json(await call("owner", "PUT", "/people/person", { email: "out@example.org", create: true }))).toMatchObject({ error: "invalid" });
    expect(await json(await call("owner", "PUT", "/people/person", { email: "maker@acme.test", create: false }))).toMatchObject({ change: "create", person: { create: false } });
    expect(left).toEqual([{ email: "maker@acme.test", actor: "owner" }]);
    expect(await json(await call("owner", "DELETE", "/people/person", { email: "dev@acme.test" }))).toMatchObject({ change: "remove" });
    expect(left).toContainEqual({ email: "dev@acme.test", actor: "owner" });
    expect(events.map((event) => event.operation)).toEqual(["people.create", "people.create", "access.remove"]);
  });
});

describe("the owner, in the dashboard", () => {
  test("a role above Can open, or the create right, needs the unlock; Can open and removing do not", async () => {
    const { call } = bench(seed([["blog", "dev@acme.test", "developer"]]));
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "new@acme.test", role: "viewer" })).status).toBe(401);
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "new@acme.test", role: "viewer", token: "wrong" })).status).toBe(401);
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "new@acme.test", role: "viewer", token: UNLOCK })).status).toBe(201);
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "see@acme.test", role: "visitor" })).status).toBe(201);
    expect((await call("dashboard", "DELETE", "/access/entry", { slug: "blog", who: "dev@acme.test" })).status).toBe(200);
    expect((await call("dashboard", "PUT", "/people/person", { email: "maker@acme.test", create: true })).status).toBe(401);
    expect((await call("dashboard", "PUT", "/people/person", { email: "maker@acme.test", create: true, token: UNLOCK })).status).toBe(200);
  });

  test("password access needs the unlock, since it lets someone from outside the company in; nothing is drawn or written without it", async () => {
    const { call, saved, key, events } = bench(seed([]));
    for (const token of [undefined, "wrong"]) {
      const refused = await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", role: "visitor", ...(token === undefined ? {} : { token }) });
      expect(refused.status).toBe(401);
      expect(await json(refused)).toEqual({ error: "locked", message: PASSWORD_LOCKED });
    }
    expect(saved().projects.blog ?? []).toEqual([]);
    // Neither registry nor projection written: the portal was told nothing.
    expect(existsSync(join(key, "access.json"))).toBe(false);
    expect(events).toEqual([]);
    const given = await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", role: "visitor", token: UNLOCK });
    expect(given.status).toBe(201);
    expect(await json(given)).toMatchObject({ entry: { who: "guest@example.org", kind: "password" }, password: "Pass-word-1-xxxx" });
  });

  test("without company sign-in, everyone gets password access, and so everyone waits for the unlock", async () => {
    const { call } = bench(seed([]), { signIn: { configured: false, allowedDomains: [], admins: [], providerName: null } });
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "alice@acme.test", role: "visitor" })).status).toBe(401);
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "alice@acme.test", role: "visitor", token: UNLOCK })).status).toBe(201);
  });

  test("locked, Can open for a company account or a domain, lowering and removing still go through", async () => {
    const { call } = bench(seed([["blog", "dev@acme.test", "developer"], ["blog", "guest@example.org", "visitor"]]));
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "see@acme.test", role: "visitor" })).status).toBe(201);
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "@acme.test", role: "visitor" })).status).toBe(201);
    expect((await call("dashboard", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test", role: "visitor" })).status).toBe(200);
    expect((await call("dashboard", "DELETE", "/access/entry", { slug: "blog", who: "dev@acme.test" })).status).toBe(200);
    expect((await call("dashboard", "DELETE", "/access/entry", { slug: "blog", who: "guest@example.org" })).status).toBe(200);
  });

  test("over the owner's socket, root gives password access with no token at all", async () => {
    const { call } = bench(seed([]));
    const given = await call("owner", "PUT", "/access/entry", { slug: "blog", who: "guest@example.org", role: "visitor" });
    expect(given.status).toBe(201);
    expect(await json(given)).toMatchObject({ entry: { kind: "password" }, password: "Pass-word-1-xxxx" });
  });
});

describe("an Admin, through their session", () => {
  const sessions: Session[] = [
    { session: "s-admin", email: "ann@acme.test", unlock: "u-admin" },
    { session: "s-dev", email: "dev@acme.test", unlock: "u-dev" },
  ];
  const registry = () => seed([["blog", "ann@acme.test", "admin"], ["blog", "dev@acme.test", "developer"], ["shop", "ann@acme.test", "viewer"]]);

  test("reads its project's people from Viewer up, and the admin emails, who open it too; Can open, or no role there, is refused", async () => {
    const { call } = bench(seed([["blog", "ann@acme.test", "admin"], ["blog", "dev@acme.test", "developer"], ["shop", "ann@acme.test", "viewer"], ["shop", "dev@acme.test", "visitor"]]), { sessions });
    const asAdmin = await call("dashboard", "POST", "/access/person/list", { session: "s-admin", slug: "blog" });
    expect(asAdmin.status).toBe(200);
    expect(await json(asAdmin)).toMatchObject({ signIn: { admins: ["boss@elsewhere.test"] } });
    expect((await call("dashboard", "POST", "/access/person/list", { session: "s-dev", slug: "blog" })).status).toBe(200);
    expect((await call("dashboard", "POST", "/access/person/list", { session: "s-admin", slug: "shop" })).status).toBe(200);
    expect((await call("dashboard", "POST", "/access/person/list", { session: "s-dev", slug: "shop" })).status).toBe(403);
    // Reading is not changing: a Viewer reads, and gives nothing.
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", token: "u-admin", slug: "shop", who: "new@acme.test", role: "visitor" })).status).toBe(403);
    expect((await call("dashboard", "POST", "/access/person/list", { session: "gone", slug: "blog" })).status).toBe(401);
  });

  test("gives at most their own role on their project, under their unlock above Can open", async () => {
    const { call, events } = bench(registry(), { sessions });
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "new@acme.test", role: "developer" })).status).toBe(401);
    const given = await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", token: "u-admin", slug: "blog", who: "new@acme.test", role: "admin" });
    expect(given.status).toBe(201);
    expect(await json(given)).toMatchObject({ entry: { by: "ann@acme.test", role: "admin" } });
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "see@acme.test", role: "visitor" })).status).toBe(201);
    // Never on a project where they are not Admin, whatever their unlock.
    const elsewhere = await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", token: "u-admin", slug: "shop", who: "new@acme.test", role: "viewer" });
    expect(elsewhere.status).toBe(403);
    expect(events.at(-1)).toMatchObject({ operation: "access.add", result: "rejects", actor: "ann@acme.test", slug: "shop" });
  });

  test("password access asks for their own unlock too; someone else's unlock opens nothing", async () => {
    const { call, saved } = bench(registry(), { sessions });
    const outsider = { slug: "blog", who: "guest@example.org", role: "visitor" };
    const refused = await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", ...outsider });
    expect(refused.status).toBe(401);
    expect(await json(refused)).toEqual({ error: "locked", message: PASSWORD_LOCKED });
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", token: "u-dev", ...outsider })).status).toBe(401);
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", token: UNLOCK, ...outsider })).status).toBe(401);
    expect(saved().projects.blog!.some((entry) => entry.who === "guest@example.org")).toBe(false);
    const given = await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", token: "u-admin", ...outsider });
    expect(given.status).toBe(201);
    expect(await json(given)).toMatchObject({ entry: { who: "guest@example.org", kind: "password", by: "ann@acme.test" }, password: "Pass-word-1-xxxx" });
  });

  test("a Developer gives nothing; an admin gives a domain only among the company's", async () => {
    const { call } = bench(registry(), { sessions });
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-dev", token: "u-dev", slug: "blog", who: "new@acme.test", role: "visitor" })).status).toBe(403);
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "@other.test", role: "visitor" })).status).toBe(400);
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "@acme.test", role: "visitor" })).status).toBe(201);
  });

  test("removes and lowers without an unlock, an Admin included, and their role is read again at their turn", async () => {
    const { call } = bench(registry(), { sessions });
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "dev@acme.test", role: "viewer" })).status).toBe(200);
    expect((await call("dashboard", "DELETE", "/access/person/entry", { session: "s-admin", slug: "blog", who: "dev@acme.test" })).status).toBe(200);
    // Ann lowers herself: from then on she manages nothing there.
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "ann@acme.test", role: "viewer" })).status).toBe(200);
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "back@acme.test", role: "visitor" })).status).toBe(403);
  });
});

describe("both halves: the dashboard's routes over the steward's", () => {
  const NOW = Date.now();
  const PUBLIC_URL = `https://dashboard.${ZONE}`;

  /** The dashboard's access routes, relaying to these steward routes, for the owner's session or Ann's. */
  function dashboard(who: "owner" | "ann") {
    const sessions: Session[] = [{ session: "s-admin", email: "ann@acme.test", unlock: "u-admin-0123456789" }];
    const steward = bench(seed([["blog", "ann@acme.test", "admin"]]), { sessions });
    const relay: AccessSteward = {
      list: (slug) => steward.call("dashboard", "GET", `/access?slug=${slug}`),
      put: (body) => steward.call("dashboard", "PUT", "/access/entry", body),
      remove: (body) => steward.call("dashboard", "DELETE", "/access/entry", body),
      people: () => steward.call("dashboard", "GET", "/people"),
      putPerson: (body) => steward.call("dashboard", "PUT", "/people/person", body),
      removePerson: (email) => steward.call("dashboard", "DELETE", "/people/person", { email }),
      portal: async () => Response.json({}),
      general: async () => Response.json({}),
    };
    const tokens = createTokens(() => NOW);
    const unlocks = createTokens(() => NOW);
    const session = { hash: "h1", createdAt: NOW, seenAt: NOW, identity: who === "owner" ? "owner" : "ann@acme.test" };
    const resolve = Object.assign(
      async (): Promise<Resolved> =>
        who === "owner"
          ? { session, token: "owner-session", identity: { kind: "owner" } }
          : { session, token: "s-admin", identity: { kind: "person", email: "ann@acme.test", name: null, roles: { blog: "admin" }, create: false, expiresAt: NOW + 60_000 } },
      { forget: () => {} },
    );
    const routes = createDashboardAccessRoutes(
      {
        publicUrl: PUBLIC_URL,
        zone: ZONE,
        stateFile: "/nonexistent/state.json",
        steward: relay,
        members: { act: (method, path, body) => steward.call("dashboard", method, path, body as object) },
        resolve,
        ownerSession: async () => (who === "owner" ? session : null),
        tokens,
        unlocks,
        providerName: async () => "Acme",
      },
      () => NOW,
    );
    const put = (body: object) => routes.put(new Request(`${PUBLIC_URL}/api/access/entry`, { method: "PUT", headers: { origin: PUBLIC_URL }, body: JSON.stringify(body) }));
    return { put, tokens, unlocks, saved: steward.saved };
  }

  const outsider = { slug: "blog", who: "guest@example.org", role: "visitor" };

  test("the owner's session without a live unlock gets the page's 423 for password access, and the password once unlocked", async () => {
    const { put, tokens, saved } = dashboard("owner");
    const locked = await put(outsider);
    expect(locked.status).toBe(423);
    expect(await locked.json()).toEqual({ error: "locked", message: ACCESS_LOCKED });
    expect(saved().projects.blog!.map((entry) => entry.who)).toEqual(["ann@acme.test"]);
    tokens.set("h1", { token: UNLOCK, expiresAt: NOW + 60_000 });
    const given = await put(outsider);
    expect(given.status).toBe(201);
    expect(await given.json()).toMatchObject({ entry: { who: "guest@example.org", kind: "password" }, password: "Pass-word-1-xxxx" });
    // Can open for a company account never waited.
    tokens.forget("h1");
    expect((await put({ slug: "blog", who: "see@acme.test", role: "visitor" })).status).toBe(201);
  });

  test("an Admin without their unlock gets the 423, and gives password access under it", async () => {
    const { put, unlocks } = dashboard("ann");
    expect((await put(outsider)).status).toBe(423);
    unlocks.set("h1", { token: "u-admin-0123456789", expiresAt: NOW + 60_000 });
    const given = await put(outsider);
    expect(given.status).toBe(201);
    expect(await given.json()).toMatchObject({ entry: { kind: "password", by: "ann@acme.test" } });
  });
});

describe("a token, through the control routes", () => {
  test("gives Can open alone, a domain only among the company's, never a password; removes Can open entries", async () => {
    const { routes, events } = bench(seed([["blog", "ann@acme.test", "admin"], ["blog", "top@acme.test", "admin"]]));
    const token = { kind: "token" as const, id: "tok1", email: null, role: null };
    expect((await routes.forToken.grant("blog", "see@acme.test", "visitor", token)).status).toBe(201);
    expect(events.at(-1)).toMatchObject({ operation: "access.add", actor: "token:tok1" });
    expect((await routes.forToken.grant("blog", "see@acme.test", "viewer", token)).status).toBe(403);
    expect((await routes.forToken.grant("blog", "@acme.test", "visitor", token)).status).toBe(201);
    expect((await routes.forToken.grant("blog", "@other.test", "visitor", token)).status).toBe(400);
    expect((await routes.forToken.grant("blog", "guest@example.org", "visitor", token)).status).toBe(403);
    expect((await routes.forToken.remove("blog", "see@acme.test", token)).status).toBe(200);
    expect((await routes.forToken.remove("blog", "top@acme.test", token)).status).toBe(403);
  });

  test("a person's token is narrowed to their role now: an Admin's gives, a Developer's does not", async () => {
    const { routes } = bench(seed([["blog", "ann@acme.test", "admin"], ["blog", "dev@acme.test", "developer"]]));
    expect((await routes.forToken.grant("blog", "see@acme.test", "visitor", { kind: "token", id: "a", email: "ann@acme.test", role: null })).status).toBe(201);
    expect((await routes.forToken.grant("blog", "two@acme.test", "visitor", { kind: "token", id: "d", email: "dev@acme.test", role: null })).status).toBe(403);
  });
});

describe("the files", () => {
  test("the registry stays root's alone, the projection readable by the portal's group", async () => {
    const { call, state, key } = bench(seed([]));
    await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test", role: "developer" });
    expect(statSync(join(state, "access.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(key, "access.json")).mode & 0o777).toBe(0o640);
  });

  test("a registry that does not read refuses everything, and nothing is written over it", async () => {
    const { call, state } = bench(seed([]));
    writeFileSync(join(state, "access.json"), "{ broken");
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test", role: "developer" });
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
  test("an address of 121 to 254 characters, given password access, reads back in the registry and in the projection", async () => {
    const { call, saved, projection } = bench(seed([]));
    for (const length of [121, 160, 200, 254]) {
      const who = addressOf(length);
      expect(who.length).toBe(length);
      const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who, role: "visitor" });
      expect({ length, status: response.status }).toEqual({ length, status: 201 });
      expect(readRegistry(JSON.stringify(saved()))).not.toHaveProperty("unreadable");
      expect(projection().sites[HOST]!.passwords.some((grant) => grant.who === who)).toBe(true);
    }
    // And the steward still reads its own registry: the next request is answered.
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
  });

  test("an address past 254 characters is refused, nothing written", async () => {
    const { call, saved } = bench(seed([]));
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: `${"a".repeat(64)}@${"b".repeat(200)}.example`, role: "visitor" });
    expect(response.status).toBe(400);
    expect(saved().projects).toEqual({});
  });

  test("a dotted slug is refused where the registry would refuse to read it, the machine carrying it or not", async () => {
    const { call, saved } = bench(seed([]));
    for (const slug of ["blog.old", "test-zone.invalid", "a..b"]) {
      expect((await call("owner", "PUT", "/access/entry", { slug, who: "dev@acme.test", role: "developer" })).status).toBe(400);
    }
    expect(saved().projects).toEqual({});
  });

  test("a change that would take the registry past the 8 MB it is read with is refused, nothing written", async () => {
    // A registry just under its bound, written by hand: entries of the longest kind on many projects.
    let registry: Registry = { ...EMPTY_REGISTRY, migration: { at: 1, from: [], setAside: [] } };
    const projects: Registry["projects"] = {};
    for (let p = 0; p < 40; p++) {
      projects[`p${p}`] = Array.from({ length: 600 }, (_, i) => ({ who: `${String(i).padStart(4, "0")}${"q".repeat(56)}@${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(60)}.example`, role: "visitor" as const, by: "owner", createdAt: 1, updatedAt: 1 }));
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
      if (Buffer.byteLength(encodeRegistry(next)) > limit - 200) break;
      registry = next;
      spare.shift();
    }
    const { call, saved } = bench(registry);
    const before = JSON.stringify(saved());
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: addressOf(254), role: "visitor" });
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
    const response = await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test", role: "developer" });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: "invalid", message: expect.stringContaining("could not read back") });
    expect(JSON.stringify(saved())).toBe(before);
    expect(existsSync(join(key, "access.json"))).toBe(false);
  });
});

describe("the projection repairs itself", () => {
  test("deleted, or edited by hand, it is written again from the registry at the next read", async () => {
    const { call, key, store } = bench(seed([["blog", "dev@acme.test", "developer"]]));
    expect(await store.ensure()).toBe(true);
    const file = join(key, "access.json");
    rmSync(file);
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
    await store.change(async (registry) => ({ registry, value: null }));
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, "{}");
    await call("owner", "GET", "/access?slug=blog");
    await store.change(async (registry) => ({ registry, value: null }));
    expect(readProjection(readFileSync(file, "utf8"))).toMatchObject({ sites: { [HOST]: { people: { "dev@acme.test": "developer" } } } });
  });

  test("a registry repaired by hand after it did not read is projected again, not left behind", async () => {
    const { call, key, state, store } = bench(seed([]));
    writeFileSync(join(state, "access.json"), "{ broken");
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(500);
    writeFileSync(join(state, "access.json"), encodeRegistry(seed([["blog", "new@acme.test", "viewer"]])));
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
    await store.change(async (registry) => ({ registry, value: null }));
    expect(readProjection(readFileSync(join(key, "access.json"), "utf8"))).toMatchObject({ sites: { [HOST]: { people: { "new@acme.test": "viewer" } } } });
  });
});

describe("who would leave the dashboard, said before and after", () => {
  const laptop: LeavingToken = { id: "aaaaaaaaaaaa", label: "dev's laptop", madeBy: "them" };
  const ci: LeavingToken = { id: "bbbbbbbbbbbb", label: "ci", madeBy: "owner" };
  const people = () =>
    seed(
      [["blog", "dev@acme.test", "developer"], ["blog", "two@acme.test", "viewer"], ["shop", "two@acme.test", "admin"], ["blog", "see@acme.test", "viewer"], ["blog", "out@acme.test", "visitor"], ["blog", "ann@acme.test", "admin"], ["blog", "red@acme.test", "viewer"]],
      ["see@acme.test", "maker@acme.test"],
    );

  test("the list names whom removing or lowering to Can open takes out, and their tokens, to those who may change it alone", async () => {
    const sessions: Session[] = [{ session: "s-admin", email: "ann@acme.test", unlock: null }, { session: "s-red", email: "red@acme.test", unlock: null }];
    const { call } = bench(people(), { sessions, tokens: { "dev@acme.test": [laptop, ci] } });
    const owner = await json(await call("owner", "GET", "/access?slug=blog"));
    // two keeps shop, see the create right, out holds Can open alone.
    expect(owner.leaving).toEqual({ "dev@acme.test": [laptop, ci], "ann@acme.test": [], "red@acme.test": [] });
    const admin = await json(await call("dashboard", "POST", "/access/person/list", { session: "s-admin", slug: "blog" }));
    expect(admin.leaving).toEqual(owner.leaving);
    const viewer = await json(await call("dashboard", "POST", "/access/person/list", { session: "s-red", slug: "blog" }));
    expect(viewer.leaving).toEqual({});
  });

  test("the answer to a removal, or a lowering to Can open, says who left and which tokens went with them", async () => {
    const { call } = bench(people(), { tokens: { "dev@acme.test": [laptop, ci] } });
    const lowered = await json(await call("owner", "PUT", "/access/entry", { slug: "blog", who: "dev@acme.test", role: "visitor" }));
    expect(lowered.left).toEqual({ who: "dev@acme.test", tokens: [laptop, ci] });
    const removed = await json(await call("owner", "DELETE", "/access/entry", { slug: "blog", who: "two@acme.test" }));
    expect(removed.left).toBeUndefined();
    // see keeps Viewer on blog; maker had the right alone.
    expect((await json(await call("owner", "PUT", "/people/person", { email: "see@acme.test", create: false }))).left).toBeUndefined();
    const taken = await json(await call("owner", "PUT", "/people/person", { email: "maker@acme.test", create: false }));
    expect(taken.left).toEqual({ who: "maker@acme.test", tokens: [] });
  });
});

describe("the access log's bounds", () => {
  test("a full log of rows younger than 180 days refuses whatever lets more people in, and says why", async () => {
    let full = false;
    const sessions: Session[] = [{ session: "s-admin", email: "ann@acme.test", unlock: "u-admin" }];
    const { call, saved } = bench(seed([["blog", "dev@acme.test", "developer"], ["blog", "ann@acme.test", "admin"]]), { full: () => full, sessions });
    full = true;
    for (const [table, method, path, body] of [
      ["dashboard", "PUT", "/access/entry", { token: UNLOCK, slug: "blog", who: "new@acme.test", role: "visitor" }],
      ["dashboard", "PUT", "/access/entry", { token: UNLOCK, slug: "blog", who: "dev@acme.test", role: "admin" }],
      ["dashboard", "PUT", "/people/person", { token: UNLOCK, email: "maker@acme.test", create: true }],
      ["dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "new@acme.test", role: "visitor" }],
    ] as const) {
      const response = await call(table, method, path, body);
      expect({ path, method, status: response.status }).toEqual({ path, method, status: 507 });
      expect(await json(response)).toMatchObject({ error: "log-full", message: LOG_FULL });
    }
    expect(saved().projects.blog).toHaveLength(2);
    // Reading is never refused.
    expect((await call("owner", "GET", "/access?slug=blog")).status).toBe(200);
    // The owner over SSH is the way out: still heard.
    expect((await call("owner", "PUT", "/access/entry", { slug: "blog", who: "new@acme.test", role: "visitor" })).status).toBe(201);
    full = false;
    expect((await call("dashboard", "PUT", "/access/entry", { token: UNLOCK, slug: "blog", who: "late@acme.test", role: "visitor" })).status).toBe(201);
  });

  test("what narrows is never refused, full log or used-up hour: lowering, removing, the create right taken back, a person taken off", async () => {
    const full = true;
    const sessions: Session[] = [{ session: "s-admin", email: "ann@acme.test", unlock: "u-admin" }];
    const { call, saved, left } = bench(
      seed([["blog", "dev@acme.test", "developer"], ["blog", "see@acme.test", "viewer"], ["blog", "ann@acme.test", "admin"], ["shop", "dev@acme.test", "viewer"], ["blog", "out@acme.test", "visitor"]], ["maker@acme.test"]),
      { full: () => full, sessions, changesPerHour: 0, ownerChangesPerHour: 0 },
    );
    expect((await call("dashboard", "PUT", "/access/entry", { token: UNLOCK, slug: "blog", who: "dev@acme.test", role: "visitor" })).status).toBe(200);
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "see@acme.test", role: "visitor" })).status).toBe(200);
    expect((await call("dashboard", "DELETE", "/access/person/entry", { session: "s-admin", slug: "blog", who: "out@acme.test" })).status).toBe(200);
    expect((await call("owner", "PUT", "/people/person", { email: "maker@acme.test", create: false })).status).toBe(200);
    expect((await call("dashboard", "DELETE", "/people/person", { email: "dev@acme.test" })).status).toBe(200);
    expect(saved().projects.blog?.map((entry) => [entry.who, entry.role])).toEqual([["ann@acme.test", "admin"], ["see@acme.test", "visitor"]]);
    expect(saved().creators).toEqual([]);
    expect(left.map((one) => one.email).sort()).toEqual(["dev@acme.test", "maker@acme.test", "see@acme.test"]);
    // Anything that widens is still refused.
    expect((await call("dashboard", "PUT", "/access/entry", { token: UNLOCK, slug: "blog", who: "see@acme.test", role: "viewer" })).status).toBe(507);
  });

  test("each actor's accepted changes are counted per hour; the owner over SSH has a generous allowance of their own", async () => {
    const clock = { value: 1_800_000_000_000 };
    const sessions: Session[] = [{ session: "s-admin", email: "ann@acme.test", unlock: "u-admin" }];
    const { call } = bench(seed([["blog", "ann@acme.test", "admin"]]), { sessions, changesPerHour: 3, ownerChangesPerHour: 5, clock });
    const give = (table: "owner" | "dashboard", n: number, extra: object = {}) =>
      call(table, "PUT", table === "owner" ? "/access/entry" : "/access/person/entry", { ...extra, slug: "blog", who: `p${n}@acme.test`, role: "visitor" });
    for (let n = 0; n < 3; n++) expect((await give("dashboard", n, { session: "s-admin" })).status).toBe(201);
    const refused = await give("dashboard", 3, { session: "s-admin" });
    expect(refused.status).toBe(429);
    expect(await json(refused)).toMatchObject({ error: "too-many-changes" });
    // Nothing changed is not counted: giving the same role again still answers.
    expect((await give("dashboard", 0, { session: "s-admin" })).status).toBe(200);
    // Another actor, the owner over SSH, has their own count.
    for (let n = 10; n < 15; n++) expect((await give("owner", n)).status).toBe(201);
    expect((await give("owner", 15)).status).toBe(429);
    // An hour later, counted afresh.
    clock.value += 3_600_001;
    expect((await give("dashboard", 20, { session: "s-admin" })).status).toBe(201);
  });
});

describe("a project removed from the machine", () => {
  test("its people with access are dropped and journaled; someone it was the last role of leaves", async () => {
    const { routes, saved, events, left, projection } = bench(seed([["blog", "dev@acme.test", "developer"], ["blog", "@acme.test", "visitor"], ["shop", "two@acme.test", "admin"], ["blog", "two@acme.test", "viewer"]]));
    expect(await routes.forgetProject("blog", "owner")).toBe(3);
    expect(saved().projects).toEqual({ shop: [expect.objectContaining({ who: "two@acme.test" })] });
    expect(projection().sites[HOST]).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ operation: "project.remove", actor: "owner", slug: "blog", detail: expect.stringContaining("dev@acme.test (Developer)") });
    expect(left).toEqual([{ email: "dev@acme.test", actor: "owner" }]);
    // Nothing left: nothing journaled again.
    const journaled = events.length;
    expect(await routes.forgetProject("blog", "owner")).toBe(0);
    expect(events).toHaveLength(journaled);
  });

  test("a project created again under that name starts from nobody", async () => {
    const { routes, call, saved } = bench(seed([["blog", "eve@acme.test", "admin"]]));
    await routes.forgetProject("blog", "owner");
    // Deployed again, by the owner: nobody from before has access.
    expect(await json(await call("owner", "GET", "/access?slug=blog"))).toMatchObject({ entries: [] });
    expect(saved().projects.blog).toBeUndefined();
  });
});
