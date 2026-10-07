import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emailRole, readProjection, type Projection } from "../borrowed/access";
import type { MemberPrincipal } from "../src/members/steward";
import { createAccessRoutes, createAccessStore, passwordHash, type AccessEvent } from "../src/access/steward";
import { createAccessSystem } from "../src/access/system";
import { encodeRegistry, EMPTY_REGISTRY, putEntry, setCreate, type Registry } from "../src/access/registry";
import type { SignInSettings } from "../src/access/protocol";

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
function bench(registry: Registry, options: { signIn?: SignInSettings; sessions?: Session[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "access-steward-"));
  folders.push(root);
  const state = join(root, "state");
  const key = join(root, "portal-key");
  mkdirSync(state, { recursive: true });
  mkdirSync(key, { recursive: true });
  writeFileSync(join(state, "access.json"), encodeRegistry(registry), { mode: 0o600 });
  const events: AccessEvent[] = [];
  const left: { email: string; actor: string }[] = [];
  const sessions = options.sessions ?? [];
  const store = createAccessStore({
    system: createAccessSystem({ stateFolder: state, portalKeyFolder: key, groupsFile: "/etc/group", portalGroup: "", portalDataFolder: join(root, "no-portal") }, false),
    zone: ZONE,
    hostOf: (slug) => `${slug}.${ZONE}`,
    journal: async (event) => void events.push(event),
  });
  let drawn = 0;
  const routes = createAccessRoutes({
    store,
    zone: ZONE,
    hostOf: (slug) => `${slug}.${ZONE}`,
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
    leave: async (email, actor) => void left.push({ email, actor }),
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
  return { routes, call, projection, saved, events, left, key, state };
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
});

describe("an Admin, through their session", () => {
  const sessions: Session[] = [
    { session: "s-admin", email: "ann@acme.test", unlock: "u-admin" },
    { session: "s-dev", email: "dev@acme.test", unlock: "u-dev" },
  ];
  const registry = () => seed([["blog", "ann@acme.test", "admin"], ["blog", "dev@acme.test", "developer"], ["shop", "ann@acme.test", "viewer"]]);

  test("lists their project's people; a Developer, or another project, is refused", async () => {
    const { call } = bench(registry(), { sessions });
    expect((await call("dashboard", "POST", "/access/person/list", { session: "s-admin", slug: "blog" })).status).toBe(200);
    expect((await call("dashboard", "POST", "/access/person/list", { session: "s-dev", slug: "blog" })).status).toBe(403);
    expect((await call("dashboard", "POST", "/access/person/list", { session: "s-admin", slug: "shop" })).status).toBe(403);
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

  test("a Developer gives nothing; an admin gives a domain only among the company's", async () => {
    const { call } = bench(registry(), { sessions });
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-dev", token: "u-dev", slug: "blog", who: "new@acme.test", role: "visitor" })).status).toBe(403);
    expect((await call("dashboard", "PUT", "/access/person/entry", { session: "s-admin", slug: "blog", who: "@other.test", role: "visitor" })).status).toBe(403);
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

describe("a token, through the control routes", () => {
  test("gives Can open alone, a domain only among the company's, never a password; removes Can open entries", async () => {
    const { routes, events } = bench(seed([["blog", "ann@acme.test", "admin"], ["blog", "top@acme.test", "admin"]]));
    const token = { kind: "token" as const, id: "tok1", email: null, role: null };
    expect((await routes.forToken.grant("blog", "see@acme.test", "visitor", token)).status).toBe(201);
    expect(events.at(-1)).toMatchObject({ operation: "access.add", actor: "token:tok1" });
    expect((await routes.forToken.grant("blog", "see@acme.test", "viewer", token)).status).toBe(403);
    expect((await routes.forToken.grant("blog", "@acme.test", "visitor", token)).status).toBe(201);
    expect((await routes.forToken.grant("blog", "@other.test", "visitor", token)).status).toBe(403);
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
