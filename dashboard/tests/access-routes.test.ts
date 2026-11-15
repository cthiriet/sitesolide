import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessRoutes, ACCESS_LOCKED } from "../src/access/routes";
import type { AccessSteward } from "../src/access/client";
import { createTokens } from "../src/secrets/tokens";

/**
 * The dashboard's access routes: they decide nothing, check the origin of a
 * change and the owner's session, add the session's unlock when they hold
 * one, and relay to the steward.
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
  portal: { reading: "steward", writtenAt: 1 },
};

/** A snapshot whose blog opens with a code, as the collector would drop it. */
function snapshotWithCode(): string {
  const folder = mkdtempSync(join(tmpdir(), "access-routes-"));
  const file = join(folder, "state.json");
  writeFileSync(
    file,
    JSON.stringify({
      generated: NOW,
      zone: "test-zone.invalid",
      folders: [{ slug: "blog", manifest: JSON.stringify({ slug: "blog", publicDir: "public", lock: true }), unit: null, bytes: 1, deployed: NOW }],
      codes: '{"blog":"K7M2PQ"}',
      domains: null,
      ports: [],
      blocks: {},
      machine: null,
      previous: null,
    }),
  );
  return file;
}

function setup(who: "owner" | "none", answers: { status?: number; body?: Record<string, unknown> } = {}, more: { stateFile?: string } = {}) {
  const calls: Call[] = [];
  const answer = (method: string, path: string, body: Record<string, unknown> | null) => {
    calls.push({ method, path, body });
    return Promise.resolve(Response.json(answers.body ?? ACCESS, { status: answers.status ?? 200 }));
  };
  const steward: AccessSteward = {
    list: (slug) => answer("GET", `/access?slug=${slug}`, null),
    put: (body) => answer("PUT", "/access/entry", body as Record<string, unknown>),
    remove: (body) => answer("DELETE", "/access/entry", body as Record<string, unknown>),
    general: (body) => answer("POST", "/general", body as Record<string, unknown>),
  };
  const tokens = createTokens(() => NOW);
  const session = { hash: "h1", createdAt: NOW, seenAt: NOW, identity: "owner" };
  const routes = createAccessRoutes(
    {
      publicUrl: PUBLIC_URL,
      stateFile: more.stateFile ?? "/nonexistent/state.json",
      steward,
      session: async () => (who === "owner" ? session : null),
      tokens,
    },
    () => NOW,
  );
  const request = (method: string, path: string, body?: object, origin: string | null = PUBLIC_URL) =>
    new Request(`${PUBLIC_URL}${path}`, { method, headers: origin === null ? {} : { origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { routes, calls, tokens, request };
}

describe("reading a project's access", () => {
  test("goes to the steward, with what the page needs added", async () => {
    const { routes, calls, request } = setup("owner");
    const response = await routes.list(request("GET", "/api/access?slug=blog"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...ACCESS, until: null, code: null });
    expect(calls).toEqual([{ method: "GET", path: "/access?slug=blog", body: null }]);
  });

  test("the preview code, from the snapshot, when the site opens with one", async () => {
    const coded = { body: { ...ACCESS, general: { access: "code", modifiable: true, reason: null } } };
    const { routes, request } = setup("owner", coded, { stateFile: snapshotWithCode() });
    const body = (await (await routes.list(request("GET", "/api/access?slug=blog"))).json()) as { code: unknown };
    expect(body.code).toEqual({ code: "K7M2PQ", url: "https://blog.test-zone.invalid/?key=K7M2PQ" });
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

  test("the owner's unlock goes with the change when the dashboard holds it; nothing else the page sends", async () => {
    const { routes, calls, tokens, request } = setup("owner", { status: 201, body: { entry: {}, change: "add" } });
    await routes.put(request("PUT", "/api/access/entry", { slug: "blog", who: "a@acme.test" }));
    tokens.set("h1", { token: "unlock-1234567890ab", expiresAt: NOW + 1000 });
    await routes.put(request("PUT", "/api/access/entry", { slug: "blog", who: "b@acme.test", role: "viewer", expiresInS: null }));
    expect(calls).toEqual([
      { method: "PUT", path: "/access/entry", body: { slug: "blog", who: "a@acme.test" } },
      { method: "PUT", path: "/access/entry", body: { token: "unlock-1234567890ab", slug: "blog", who: "b@acme.test", expiresInS: null } },
    ]);
  });

  test("the steward's `locked` becomes the page's 423, the stale unlock forgotten", async () => {
    const { routes, tokens, request } = setup("owner", { status: 401, body: { error: "locked", message: "locked" } });
    tokens.set("h1", { token: "unlock-1234567890ab", expiresAt: NOW + 1000 });
    const response = await routes.put(request("PUT", "/api/access/entry", { slug: "blog", who: "b@acme.test" }));
    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ error: "locked", message: ACCESS_LOCKED });
    expect(tokens.read("h1")).toBeNull();
  });

  test("general access: public and the code with the unlock and the slug retyped, a new code with the unlock, restricted with neither", async () => {
    const { routes, calls, tokens, request } = setup("owner");
    // Public, the code or a new one without the unlock: the page's 423, the steward not even asked.
    for (const body of [
      { slug: "blog", access: "public", confirmation: "blog" },
      { slug: "blog", access: "code", confirmation: "blog" },
      { slug: "blog", access: "code", renew: true },
    ]) {
      expect((await routes.general(request("PUT", "/api/access/general", body))).status).toBe(423);
    }
    expect(calls).toEqual([]);
    // Restricted without the unlock: less exposure is never refused for want of one.
    expect((await routes.general(request("PUT", "/api/access/general", { slug: "blog", access: "restricted" }))).status).toBe(200);
    expect(calls).toEqual([{ method: "POST", path: "/general", body: { slug: "blog", access: "restricted", confirmation: "" } }]);
    tokens.set("h1", { token: "unlock-1234567890ab", expiresAt: NOW + 1000 });
    expect((await routes.general(request("PUT", "/api/access/general", { slug: "blog", access: "public", confirmation: "blog" }))).status).toBe(200);
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/general", body: { token: "unlock-1234567890ab", slug: "blog", access: "public", confirmation: "blog" } });
    expect((await routes.general(request("PUT", "/api/access/general", { slug: "blog", access: "code", confirmation: "blog" }))).status).toBe(200);
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/general", body: { token: "unlock-1234567890ab", slug: "blog", access: "code", confirmation: "blog" } });
    expect((await routes.general(request("PUT", "/api/access/general", { slug: "blog", access: "code", renew: true }))).status).toBe(200);
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/general", body: { token: "unlock-1234567890ab", slug: "blog", access: "code", renew: true, confirmation: "" } });
    // Malformed: refused before the steward.
    const before = calls.length;
    for (const body of [{ slug: "blog", access: "open" }, { slug: "blog", access: "public", renew: true }, { slug: "blog", access: "code", renew: "yes" }, { access: "code" }]) {
      expect((await routes.general(request("PUT", "/api/access/general", body))).status).toBe(400);
    }
    expect(calls).toHaveLength(before);
  });

  test("the steward's answer, the code inside, goes back to the page as it stands", async () => {
    const answer = { portal: { requested: false, installed: false, modifiable: true, reason: null }, general: { access: "code", modifiable: true, reason: null }, detail: "code set", code: { code: "K7M2PQ", url: "https://blog.test-zone.invalid/?key=K7M2PQ" } };
    const { routes, tokens, request } = setup("owner", { body: answer });
    tokens.set("h1", { token: "unlock-1234567890ab", expiresAt: NOW + 1000 });
    const response = await routes.general(request("PUT", "/api/access/general", { slug: "blog", access: "code", confirmation: "blog" }));
    expect(await response.json()).toEqual(answer);
  });
});
