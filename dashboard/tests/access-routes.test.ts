import { describe, expect, test } from "bun:test";
import { createAccessRoutes, grantable, ACCESS_LOCKED, ACCESS_NOT_AVAILABLE } from "../src/access/routes";
import type { AccessSteward } from "../src/access/client";
import { createTokens } from "../src/secrets/tokens";
import type { Resolved } from "../src/people/identity";

/**
 * The dashboard's access routes: they decide nothing, check the origin of a
 * change and the session, add the session's unlock when they hold one, and
 * relay to the steward, the owner's way or a person's.
 */

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const NOW = 1_800_000_000_000;

type Call = { method: string; path: string; body: Record<string, unknown> | null };

const ACCESS = {
  slug: "blog",
  host: "blog.test-zone.invalid",
  url: "https://blog.test-zone.invalid/",
  general: { access: "restricted", modifiable: true, reason: null },
  entries: [],
  signIn: { configured: true, allowedDomains: ["acme.test"], admins: [], providerName: "Acme" },
  portal: { reading: "steward", writtenAt: 1 },
};

function setup(who: "owner" | "person" | "none", answers: { status?: number; body?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const answer = (method: string, path: string, body: Record<string, unknown> | null) => {
    calls.push({ method, path, body });
    return Promise.resolve(Response.json(answers.body ?? ACCESS, { status: answers.status ?? 200 }));
  };
  const steward: AccessSteward = {
    list: (slug) => answer("GET", `/access?slug=${slug}`, null),
    put: (body) => answer("PUT", "/access/entry", body as Record<string, unknown>),
    remove: (body) => answer("DELETE", "/access/entry", body as Record<string, unknown>),
    people: () => answer("GET", "/people", null),
    putPerson: (body) => answer("PUT", "/people/person", body as Record<string, unknown>),
    removePerson: (email) => answer("DELETE", "/people/person", { email }),
  };
  const tokens = createTokens(() => NOW);
  const unlocks = createTokens(() => NOW);
  const forgotten: string[] = [];
  const session = { hash: "h1", createdAt: NOW, seenAt: NOW, identity: who === "person" ? "ann@acme.test" : "owner" };
  const resolve = Object.assign(
    async (): Promise<Resolved> =>
      who === "none"
        ? null
        : who === "owner"
          ? { session, token: "owner-session", identity: { kind: "owner" } }
          : { session, token: "person-session", identity: { kind: "member", email: "ann@acme.test", name: null, roles: { blog: "admin" }, create: false, expiresAt: NOW + 1000 } },
    { forget: (hash: string) => void forgotten.push(hash) },
  );
  const toggled: Record<string, unknown>[] = [];
  const routes = createAccessRoutes(
    {
      publicUrl: PUBLIC_URL,
      zone: "test-zone.invalid",
      stateFile: "/nonexistent/state.json",
      steward,
      members: { act: (method, path, body) => answer(method, path, body as Record<string, unknown>) },
      resolve,
      ownerSession: async () => (who === "owner" ? session : null),
      tokens,
      unlocks,
      providerName: async () => "Acme",
      togglePortal: async (req) => {
        toggled.push((await req.json()) as Record<string, unknown>);
        return Response.json({ portal: { requested: true } });
      },
    },
    () => NOW,
  );
  const request = (method: string, path: string, body?: object, origin: string | null = PUBLIC_URL) =>
    new Request(`${PUBLIC_URL}${path}`, { method, headers: origin === null ? {} : { origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { routes, calls, tokens, unlocks, forgotten, toggled, request };
}

describe("reading a project's access", () => {
  test("the owner's goes to the steward's owner route, with what the page needs added", async () => {
    const { routes, calls, request } = setup("owner");
    const response = await routes.list(request("GET", "/api/access?slug=blog"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ slug: "blog", you: { kind: "owner" }, grantable: ["visitor", "viewer", "developer", "admin"], until: null, code: null, dashboardUrl: PUBLIC_URL, providerName: "Acme" });
    expect(calls).toEqual([{ method: "GET", path: "/access?slug=blog", body: null }]);
  });

  test("a person's goes through their session, which the steward judges", async () => {
    const { routes, calls, request } = setup("person");
    const body = await (await routes.list(request("GET", "/api/access?slug=blog"))).json();
    expect(body).toMatchObject({ you: { kind: "person", email: "ann@acme.test", role: "admin" }, grantable: ["visitor", "viewer", "developer", "admin"] });
    expect(calls).toEqual([{ method: "POST", path: "/access/person/list", body: { session: "person-session", slug: "blog" } }]);
  });

  test("no session, no answer; one project at a time", async () => {
    expect((await setup("none").routes.list(new Request(`${PUBLIC_URL}/api/access?slug=blog`))).status).toBe(401);
    const { routes, request } = setup("owner");
    expect((await routes.list(request("GET", "/api/access"))).status).toBe(400);
  });
});

describe("changing it", () => {
  test("a change from another origin is refused before anything", async () => {
    const { routes, calls, request } = setup("owner");
    expect((await routes.put(request("PUT", "/api/access/entry", { slug: "blog", who: "a@acme.test" }, "https://evil.test"))).status).toBe(403);
    expect((await routes.remove(request("DELETE", "/api/access/entry", { slug: "blog", who: "a@acme.test" }, null))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("the owner's unlock goes with the change when the dashboard holds it, Can open by default", async () => {
    const { routes, calls, tokens, request } = setup("owner", { status: 201, body: { entry: {}, change: "add" } });
    await routes.put(request("PUT", "/api/access/entry", { slug: "blog", who: "a@acme.test" }));
    tokens.set("h1", { token: "unlock-1234567890ab", expiresAt: NOW + 1000 });
    await routes.put(request("PUT", "/api/access/entry", { slug: "blog", who: "b@acme.test", role: "viewer", expiresInS: null }));
    expect(calls).toEqual([
      { method: "PUT", path: "/access/entry", body: { slug: "blog", who: "a@acme.test", role: "visitor" } },
      { method: "PUT", path: "/access/entry", body: { token: "unlock-1234567890ab", slug: "blog", who: "b@acme.test", role: "viewer", expiresInS: null } },
    ]);
  });

  test("the steward's `locked` becomes the page's 423, the stale unlock forgotten", async () => {
    const { routes, tokens, request } = setup("owner", { status: 401, body: { error: "locked", message: "locked" } });
    tokens.set("h1", { token: "unlock-1234567890ab", expiresAt: NOW + 1000 });
    const response = await routes.put(request("PUT", "/api/access/entry", { slug: "blog", who: "b@acme.test", role: "viewer" }));
    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ error: "locked", message: ACCESS_LOCKED });
    expect(tokens.read("h1")).toBeNull();
  });

  test("a person's change carries their session and their own unlock; a session the steward closed closes here", async () => {
    const { routes, calls, unlocks, request } = setup("person", { status: 401, body: { error: "signed-out", message: "closed" } });
    unlocks.set("h1", { token: "person-unlock-123456", expiresAt: NOW + 1000 });
    const response = await routes.put(request("PUT", "/api/access/entry", { slug: "blog", who: "b@acme.test", role: "developer" }));
    expect(response.status).toBe(401);
    expect(calls[0]).toEqual({ method: "PUT", path: "/access/person/entry", body: { session: "person-session", token: "person-unlock-123456", slug: "blog", who: "b@acme.test", role: "developer" } });
  });

  test("general access: public or restricted through the portal's route, the code never here", async () => {
    const { routes, toggled, request } = setup("owner");
    expect((await routes.general(request("PUT", "/api/access/general", { slug: "blog", access: "public", confirmation: "blog" }))).status).toBe(200);
    expect(toggled).toEqual([{ slug: "blog", active: false, confirmation: "blog" }]);
    expect((await routes.general(request("PUT", "/api/access/general", { slug: "blog", access: "code" }))).status).toBe(400);
    expect((await routes.general(request("PUT", "/api/access/general", { slug: "blog", access: "open" }))).status).toBe(400);
  });
});

describe("People", () => {
  test("the owner's alone; a steward from before the registry is said", async () => {
    expect((await setup("person").routes.people(new Request(`${PUBLIC_URL}/api/people`))).status).toBe(401);
    const { routes, request } = setup("owner", { status: 404, body: { error: "not-found", message: "no such route" } });
    expect(await (await routes.people(request("GET", "/api/people"))).json()).toMatchObject({ available: false, reason: ACCESS_NOT_AVAILABLE, people: [] });
  });

  test("the create right carries the owner's unlock when held", async () => {
    const { routes, calls, tokens, request } = setup("owner", { body: { person: {}, change: "create" } });
    tokens.set("h1", { token: "unlock-1234567890ab", expiresAt: NOW + 1000 });
    await routes.putPerson(request("PUT", "/api/people/person", { email: "m@acme.test", create: true }));
    await routes.removePerson(request("DELETE", "/api/people/person", { email: "m@acme.test" }));
    expect(calls).toEqual([
      { method: "PUT", path: "/people/person", body: { token: "unlock-1234567890ab", email: "m@acme.test", create: true } },
      { method: "DELETE", path: "/people/person", body: { email: "m@acme.test" } },
    ]);
  });
});

describe("what the page may offer", () => {
  test("everything for the owner, at most Admin for an Admin, nothing below", () => {
    expect(grantable({ kind: "owner" })).toEqual(["visitor", "viewer", "developer", "admin"]);
    expect(grantable({ kind: "person", email: "a@acme.test", role: "admin" })).toEqual(["visitor", "viewer", "developer", "admin"]);
    expect(grantable({ kind: "person", email: "a@acme.test", role: "developer" })).toEqual([]);
    expect(grantable({ kind: "person", email: "a@acme.test", role: null })).toEqual([]);
  });
});
