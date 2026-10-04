import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import { createApiRoutes } from "../src/control/api";
import type { ControlSteward } from "../src/control/client";
import { createLimiter } from "../src/control/limiter";
import type { Identity, ProjectSharing } from "../src/control/protocol";
import { domainRefusals, readTokenPolicy } from "../src/control/sharing";
import { createSpool } from "../src/control/spool";
import { createControlStore } from "../src/control/store";
import { createTracker } from "../src/control/tracker";
import { localSharing } from "../src/sharing";
import type { Raw } from "../src/state";

/**
 * Sharing through the control API: the dashboard's real routes on a real
 * port, the portal's admin API faked by a real HTTP server the dashboard
 * reaches with the Sharing section's own client, and the steward reduced to
 * the identity it returns for each bearer, which is what the dashboard
 * decides on. The steward's own judgement of a token is tested in
 * control-steward.test.ts.
 */

const ZONE = "test-zone.invalid";
const NOW = Date.now();
const WITH_DOOR = "forward_auth @portal_guard 127.0.0.1:3026 {\n\turi /verifier\n}";

const scope = (slugs: string[]) => ({ slugs, create: true, outbound: false, domain: false, public: false });
const tokenOf = (letter: string) => `sst_${letter.repeat(43)}`;

/** kanban is Ada's own, Grace is granted it and the others, notes belongs to Linus. */
const IDENTITIES: Record<string, Identity> = {
  [tokenOf("a")]: { id: "aaaaaaaaaaaa", label: "Ada", email: "ada@acme.test", expiresAt: null, scope: scope([]), owned: ["kanban"] },
  [tokenOf("g")]: { id: "bbbbbbbbbbbb", label: "Grace", email: "grace@acme.test", expiresAt: null, scope: scope(["kanban", "roster", "showcase", "ghost"]), owned: [] },
  [tokenOf("l")]: { id: "cccccccccccc", label: "Linus", email: "linus@acme.test", expiresAt: null, scope: scope([]), owned: ["notes"] },
};
const ADA = tokenOf("a");
const GRACE = tokenOf("g");

function folder(slug: string, manifest: unknown) {
  return { slug, manifest: JSON.stringify(manifest), unit: null, bytes: 1024, deployed: NOW };
}

/** kanban and notes carry the portal; roster asks for it without its block carrying it; showcase is open; ghost is not deployed. */
const RAW: Raw = {
  generated: NOW,
  zone: ZONE,
  folders: [
    folder("kanban", { slug: "kanban", port: 3045, start: "bun run server.ts", portal: true }),
    folder("notes", { slug: "notes", port: 3046, start: "bun run server.ts", portal: true }),
    folder("roster", { slug: "roster", port: 3047, start: "bun run server.ts", portal: true }),
    folder("showcase", { slug: "showcase", publicDir: "public" }),
  ],
  codes: "{}",
  domains: null,
  ports: [],
  blocks: { kanban: WITH_DOOR, notes: WITH_DOOR, roster: "reverse_proxy 127.0.0.1:3047" },
  machine: null,
  previous: null,
};

// --- the fake portal -------------------------------------------------------------

type Policy = { mode: string; people: string[]; domains: string[] };
const portalState = {
  answer: "current" as "current" | "old",
  allowedDomains: ["acme.test", "acme-labs.test"],
  configured: true,
  policies: new Map<string, { policy: Policy; updatedAt: number }>(),
  received: [] as { method: string; path: string; body: unknown }[],
};

let root: string;
let portal: ReturnType<typeof Bun.serve>;
let dashboard: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "control-sharing-"));
  writeFileSync(join(root, "state.json"), JSON.stringify(RAW));

  portal = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "PUT" ? ((await req.json()) as Record<string, unknown>) : null;
      portalState.received.push({ method: req.method, path: url.pathname, body });
      if (portalState.answer === "old") return new Response("404: unknown route", { status: 404 });
      if (req.method === "GET" && url.pathname === "/admin/sharing") {
        return Response.json({
          sso: { configured: portalState.configured, providerName: "Google", portalUrl: `https://portal.${ZONE}`, admins: ["ceo@acme.test"], allowedDomains: portalState.allowedDomains },
          sites: [...portalState.policies].map(([host, saved]) => ({ host, ...saved })),
        });
      }
      const host = /^\/admin\/sharing\/([^/]+)$/.exec(url.pathname)?.[1];
      if (req.method === "PUT" && host !== undefined && body !== null) {
        if (!["admins", "people", "domain"].includes(body.mode as string)) return Response.json({ error: "invalid-mode" }, { status: 400 });
        const policy = { mode: body.mode as string, people: (body.people as string[]) ?? [], domains: (body.domains as string[]) ?? [] };
        portalState.policies.set(decodeURIComponent(host), { policy, updatedAt: NOW });
        return Response.json({ host: decodeURIComponent(host), policy, updatedAt: NOW });
      }
      return new Response("404: unknown route", { status: 404 });
    },
  });

  const steward = {
    authenticate: async (bearer: string) =>
      IDENTITIES[bearer] === undefined
        ? Response.json({ error: "unauthenticated", message: "unknown token: ask the owner of the machine for one" }, { status: 401 })
        : Response.json({ identity: IDENTITIES[bearer] }),
  } as unknown as ControlSteward;
  const store = createControlStore(openDatabase(join(root, "dashboard.db")));
  const spool = createSpool(join(root, "spool"));
  const api = createApiRoutes({
    steward,
    store,
    spool,
    limiter: createLimiter(),
    tracker: createTracker({ store, steward, spool }),
    stateFile: join(root, "state.json"),
    publicUrl: `https://dashboard.${ZONE}`,
    zone: ZONE,
    portal: localSharing(`http://127.0.0.1:${portal.port}`),
  });
  dashboard = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/api/v1/projects/:slug/sharing": {
        GET: (req) => api.projectSharing(req, req.params.slug),
        PUT: (req) => api.replaceProjectSharing(req, req.params.slug),
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  base = `http://127.0.0.1:${dashboard.port}`;
});

afterAll(() => {
  dashboard.stop(true);
  portal.stop(true);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  portalState.answer = "current";
  portalState.allowedDomains = ["acme.test", "acme-labs.test"];
  portalState.configured = true;
  portalState.policies.clear();
  portalState.received.length = 0;
});

function read(slug: string, token = ADA): Promise<Response> {
  return fetch(`${base}/api/v1/projects/${slug}/sharing`, { headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": "198.51.100.7" } });
}

function change(slug: string, body: unknown, token = ADA): Promise<Response> {
  return fetch(`${base}/api/v1/projects/${slug}/sharing`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": "198.51.100.7", "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function refusal(response: Response): Promise<{ status: number; error: string; message: string; details?: string[] }> {
  const body = (await response.json()) as { error: string; message: string; details?: string[] };
  return { status: response.status, ...body };
}

const puts = () => portalState.received.filter((entry) => entry.method === "PUT");

describe("reading a project's sharing", () => {
  test("its own project: the policy, the address to send, how people sign in, never the admin emails", async () => {
    const response = await read("kanban");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { sharing } = (await response.json()) as { sharing: ProjectSharing };
    expect(sharing).toEqual({
      slug: "kanban",
      host: `kanban.${ZONE}`,
      url: `https://kanban.${ZONE}/`,
      policy: { mode: "admins", people: [], domains: [] },
      updatedAt: null,
      sso: { configured: true, providerName: "Google" },
      allowedDomains: ["acme.test", "acme-labs.test"],
    });
    expect(JSON.stringify(sharing)).not.toContain("ceo@acme.test");
  });

  test("a policy already set is the one read back", async () => {
    portalState.policies.set(`kanban.${ZONE}`, { policy: { mode: "people", people: ["alice@acme.test"], domains: [] }, updatedAt: NOW - 1000 });
    const { sharing } = (await (await read("kanban", GRACE)).json()) as { sharing: ProjectSharing };
    expect(sharing.policy).toEqual({ mode: "people", people: ["alice@acme.test"], domains: [] });
    expect(sharing.updatedAt).toBe(NOW - 1000);
  });

  test("another token's project reads as unknown, and the portal is not asked", async () => {
    expect(await refusal(await read("notes"))).toMatchObject({ status: 404, error: "not-found" });
    expect(await refusal(await read("notes", GRACE))).toMatchObject({ status: 404, error: "not-found" });
    expect(portalState.received).toEqual([]);
  });

  test("no token, or an unknown one: unauthenticated", async () => {
    expect((await fetch(`${base}/api/v1/projects/kanban/sharing`)).status).toBe(401);
    expect(await refusal(await read("kanban", tokenOf("z")))).toMatchObject({ status: 401, error: "unauthenticated" });
  });
});

describe("changing it, as its token", () => {
  test("its own project: the portal receives the three keys and the token as the actor, never owner", async () => {
    const response = await change("kanban", { mode: "people", people: ["Alice@Acme.test", "bob@elsewhere.test"], domains: [] });
    expect(response.status).toBe(200);
    const { sharing } = (await response.json()) as { sharing: ProjectSharing };
    expect(sharing.policy).toEqual({ mode: "people", people: ["alice@acme.test", "bob@elsewhere.test"], domains: [] });
    expect(sharing.updatedAt).toBe(NOW);
    expect(puts()).toEqual([
      {
        method: "PUT",
        path: `/admin/sharing/kanban.${ZONE}`,
        body: { mode: "people", people: ["alice@acme.test", "bob@elsewhere.test"], domains: [], actor: "token:aaaaaaaaaaaa" },
      },
    ]);
  });

  test("a project granted to the token: allowed, under that token's name", async () => {
    expect((await change("kanban", { mode: "people", people: ["carol@acme.test"] }, GRACE)).status).toBe(200);
    expect(puts().map((entry) => (entry.body as { actor: string }).actor)).toEqual(["token:bbbbbbbbbbbb"]);
  });

  test("another token's project reads as unknown, before the body is even judged", async () => {
    expect(await refusal(await change("notes", { mode: "people", people: ["eve@acme.test"] }))).toMatchObject({ status: 404, error: "not-found" });
    expect(await refusal(await change("notes", "{"))).toMatchObject({ status: 404, error: "not-found" });
    expect(portalState.received).toEqual([]);
  });

  test("an actor in the body is refused: the token cannot speak for the owner or for someone else", async () => {
    for (const actor of ["owner", "ceo@acme.test", "token:cccccccccccc"]) {
      const answer = await refusal(await change("kanban", { mode: "admins", actor }));
      expect(answer).toMatchObject({ status: 400, error: "invalid", message: "unexpected field: actor" });
    }
    expect(portalState.received).toEqual([]);
  });

  test("an address the portal would refuse is named, and nothing is sent", async () => {
    const answer = await refusal(await change("kanban", { mode: "people", people: ["alice@acme.test", "not an address", "kim@acme.test"] }));
    expect(answer).toMatchObject({ status: 400, error: "invalid" });
    expect(answer.details).toEqual(['people: "not an address" is not accepted']);
    expect((await refusal(await change("kanban", { mode: "everyone" }))).details).toEqual(["mode: admins, people or domain"]);
    expect((await refusal(await change("kanban", "["))).status).toBe(400);
    expect(portalState.received).toEqual([]);
  });

  test("public is refused, saying it is the owner's, from Access", async () => {
    const answer = await refusal(await change("kanban", { mode: "public" }));
    expect(answer).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(answer.message).toContain("Access section");
    expect(portalState.received).toEqual([]);
  });

  test("a site that is not behind the portal, not yet, or not deployed: no-portal", async () => {
    for (const slug of ["roster", "showcase", "ghost"]) {
      const answer = await refusal(await change(slug, { mode: "people", people: ["alice@acme.test"] }, GRACE));
      expect({ slug, status: answer.status, error: answer.error }).toEqual({ slug, status: 409, error: "no-portal" });
      expect((await refusal(await read(slug, GRACE))).error).toBe("no-portal");
    }
    expect(portalState.received).toEqual([]);
  });
});

describe("a whole domain", () => {
  test("one the portal admits at sign-in: allowed", async () => {
    const response = await change("kanban", { mode: "domain", domains: ["acme.test"] });
    expect(response.status).toBe(200);
    expect(puts()).toHaveLength(1);
  });

  test("one outside that list: refused, the list said, and the portal untouched", async () => {
    const answer = await refusal(await change("kanban", { mode: "domain", domains: ["acme.test", "gmail.test"] }));
    expect(answer).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(answer.message).toContain("acme.test, acme-labs.test");
    expect(answer.details).toEqual(["gmail.test: not among the domains the portal admits at sign-in"]);
    // Even kept in the list without being opened: the owner would later open it unknowingly.
    expect((await change("kanban", { mode: "people", people: ["alice@acme.test"], domains: ["gmail.test"] })).status).toBe(403);
    expect(puts()).toEqual([]);
  });

  test("with no allowed domains at all, a token opens a site to none", async () => {
    portalState.allowedDomains = [];
    const answer = await refusal(await change("kanban", { mode: "domain", domains: ["acme.test"] }));
    expect(answer).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(answer.message).toContain("OIDC_ALLOWED_DOMAINS is empty");
    // People are still shared with one by one.
    expect((await change("kanban", { mode: "people", people: ["alice@acme.test"] })).status).toBe(200);
  });

  test("a domain the owner opened stays open as the token adds people, and closing it is always allowed", async () => {
    portalState.policies.set(`kanban.${ZONE}`, { policy: { mode: "domain", people: [], domains: ["partner.test"] }, updatedAt: NOW });
    expect((await change("kanban", { mode: "domain", people: ["alice@acme.test"], domains: ["partner.test"] })).status).toBe(200);
    expect((await change("kanban", { mode: "admins", people: ["alice@acme.test"], domains: ["partner.test"] })).status).toBe(200);
    // Kept shut by the owner's earlier choice: the token may not be the one to reopen it.
    const reopened = await refusal(await change("kanban", { mode: "domain", people: [], domains: ["partner.test"] }));
    expect(reopened).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(reopened.details![0]).toContain("kept in the list from an earlier sharing");
    expect((await change("kanban", { mode: "admins", people: [], domains: [] })).status).toBe(200);
  });
});

describe("the portal's side", () => {
  test("a portal from before sharing: not-available, saying what the owner deploys", async () => {
    portalState.answer = "old";
    for (const response of [await read("kanban"), await change("kanban", { mode: "admins" })]) {
      const answer = await refusal(response);
      expect(answer).toMatchObject({ status: 503, error: "not-available" });
      expect(answer.message).toContain("cd portal && sitesolide deploy");
    }
  });

  test("an unreachable portal is said unreachable, as a failure on the machine", async () => {
    const routes = createApiRoutes({
      steward: { authenticate: async () => Response.json({ identity: IDENTITIES[ADA] }) } as unknown as ControlSteward,
      store: createControlStore(openDatabase(join(root, "unreachable.db"))),
      spool: createSpool(join(root, "spool-unreachable")),
      limiter: createLimiter(),
      tracker: { tick: async () => {}, fail: () => {}, settle: () => {} } as unknown as ReturnType<typeof createTracker>,
      stateFile: join(root, "state.json"),
      publicUrl: `https://dashboard.${ZONE}`,
      zone: ZONE,
      portal: localSharing("http://127.0.0.1:1"),
    });
    const response = await routes.projectSharing(new Request("http://dashboard/api/v1/projects/kanban/sharing", { headers: { Authorization: `Bearer ${ADA}` } }), "kanban");
    expect(await refusal(response)).toMatchObject({ status: 502, error: "failure" });
  });

  test("no portal client given: not-available, never a crash", async () => {
    const routes = createApiRoutes({
      steward: { authenticate: async () => Response.json({ identity: IDENTITIES[ADA] }) } as unknown as ControlSteward,
      store: createControlStore(openDatabase(join(root, "absent.db"))),
      spool: createSpool(join(root, "spool-absent")),
      limiter: createLimiter(),
      tracker: { tick: async () => {}, fail: () => {}, settle: () => {} } as unknown as ReturnType<typeof createTracker>,
      stateFile: join(root, "state.json"),
      publicUrl: `https://dashboard.${ZONE}`,
      zone: ZONE,
    });
    const response = await routes.projectSharing(new Request("http://dashboard/api/v1/projects/kanban/sharing", { headers: { Authorization: `Bearer ${ADA}` } }), "kanban");
    expect((await refusal(response)).error).toBe("not-available");
  });

  test("sign-in with a work account not set up: sharing still saves, as in the Sharing section, and says so", async () => {
    portalState.configured = false;
    portalState.allowedDomains = [];
    const response = await change("kanban", { mode: "people", people: ["alice@acme.test"] });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { sharing: ProjectSharing }).sharing.sso).toEqual({ configured: false, providerName: "Google" });
  });
});

describe("the rules, pure", () => {
  const policy = (mode: "admins" | "people" | "domain", domains: string[] = [], people: string[] = []) => ({ mode, people, domains });

  test("a domain added or newly opened must be allowed; one already open, or kept shut, is not the token's doing", () => {
    const allowed = ["acme.test"];
    expect(domainRefusals(policy("admins"), policy("domain", ["acme.test"]), allowed)).toEqual([]);
    expect(domainRefusals(policy("admins"), policy("domain", ["other.test"]), allowed)).toHaveLength(1);
    expect(domainRefusals(policy("admins"), policy("people", ["other.test"]), allowed)).toHaveLength(1);
    expect(domainRefusals(policy("domain", ["other.test"]), policy("domain", ["other.test"], ["a@acme.test"]), allowed)).toEqual([]);
    expect(domainRefusals(policy("people", ["other.test"]), policy("people", ["other.test"], ["a@acme.test"]), allowed)).toEqual([]);
    expect(domainRefusals(policy("people", ["other.test"]), policy("domain", ["other.test"]), allowed)).toHaveLength(1);
    expect(domainRefusals(policy("domain", ["other.test"]), policy("admins", ["other.test"]), allowed)).toEqual([]);
  });

  test("a token's body: the three keys, public refused apart, every bad entry named", () => {
    expect(readTokenPolicy({ mode: "people", people: [" Bob@Acme.test "] })).toEqual({ policy: { mode: "people", people: ["bob@acme.test"], domains: [] } });
    expect(readTokenPolicy({ mode: "public" })).toMatchObject({ refusal: { code: "out-of-scope" } });
    expect(readTokenPolicy({ mode: "admins", extra: 1 })).toMatchObject({ refusal: { code: "invalid", message: "unexpected field: extra" } });
    expect(readTokenPolicy({ mode: "domain", domains: ["com", "acme.test"] })).toMatchObject({ refusal: { details: ['domains: "com" is not accepted'] } });
    expect(readTokenPolicy({ mode: "people", people: "alice@acme.test" })).toMatchObject({ refusal: { details: ["people: a list"] } });
  });
});
