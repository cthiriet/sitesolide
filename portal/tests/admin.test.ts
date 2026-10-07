import { describe, expect, test } from "bun:test";
import { createAdmin, createSharingAdmin } from "../src/admin";
import type { Guest } from "../src/guests";
import { guestHash } from "../src/gate";
import { readSettings, type Settings } from "../src/oidc";
import { memoryAudit, memorySharing, memoryStore } from "./memory";

const NOW = 1_800_000_000_000;
const PASSWORD = "Xith-G4r4-nRJs-uDMV";

function admin() {
  const store = memoryStore();
  let rang = 0;
  const routes = createAdmin(store, () => NOW, {
    drawPassword: () => PASSWORD,
    drawId: () => `AAAAAAAAAAAAAAA${rang++}`,
  });
  return { store, routes };
}

function creation(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3026/admin/guests", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = { host: "forum.test-zone.invalid", label: "Alice", durationS: 7 * 24 * 3600 };

describe("creating an access", () => {
  test("returns the password only once, and the database keeps only its hash", async () => {
    const { store, routes } = admin();
    const response = await routes.create(creation(VALID));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const { guest, password } = (await response.json()) as { guest: Guest; password: string };
    expect(password).toBe(PASSWORD);
    expect(guest).toEqual({
      id: "AAAAAAAAAAAAAAA0",
      host: "forum.test-zone.invalid",
      label: "Alice",
      createdAt: NOW,
      expiresAt: NOW + 7 * 24 * 3600 * 1000,
      seenAt: null,
    });
    expect(store.rows.get(guest.id)?.hash).toBe(guestHash(PASSWORD));
  });

  test("no deadline, when it is asked for in so many words", async () => {
    const { routes } = admin();
    const response = await routes.create(creation({ ...VALID, durationS: null }));
    expect(((await response.json()) as { guest: { expiresAt: unknown } }).guest.expiresAt).toBeNull();
  });

  test("the host is brought back to lowercase, the label cleaned", async () => {
    const { routes } = admin();
    const response = await routes.create(creation({ ...VALID, host: "Forum.Test-Zone.INVALID", label: "  Alice " }));
    expect(await response.json()).toMatchObject({ guest: { host: "forum.test-zone.invalid", label: "Alice" } });
  });

  test("anything not exactly as expected is refused, and nothing is created", async () => {
    const { store, routes } = admin();
    for (const body of [
      "not json",
      null,
      { ...VALID, host: undefined },
      { ...VALID, host: "" },
      { ...VALID, host: "a b.test" },
      { ...VALID, host: "a.test:443" },
      { ...VALID, label: "" },
      { ...VALID, label: "a\nb" },
      { ...VALID, label: "a".repeat(81) },
      { ...VALID, durationS: undefined },
      { ...VALID, durationS: 3600 },
      { ...VALID, durationS: "604800" },
    ]) {
      const response = await routes.create(creation(body));
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    expect(store.rows.size).toBe(0);
  });
});

describe("listing and revoking", () => {
  test("the list says neither the passwords nor their hashes", async () => {
    const { routes } = admin();
    await routes.create(creation(VALID));
    const response = routes.list(new Request("http://127.0.0.1:3026/admin/guests"));
    const text = await response.text();
    expect(JSON.parse(text).guests).toHaveLength(1);
    expect(text).not.toInclude(PASSWORD);
    expect(text).not.toInclude(guestHash(PASSWORD));
  });

  test("revoking deletes the access, and says so only once", async () => {
    const { store, routes } = admin();
    await routes.create(creation(VALID));
    const request = () => new Request("http://127.0.0.1:3026/admin/invites/AAAAAAAAAAAAAAA0", { method: "DELETE" });
    expect((await routes.remove(request(), "AAAAAAAAAAAAAAA0")).status).toBe(204);
    expect(store.rows.size).toBe(0);
    expect((await routes.remove(request(), "AAAAAAAAAAAAAAA0")).status).toBe(404);
  });

  test("a malformed identifier is unknown", async () => {
    const { routes } = admin();
    const request = new Request("http://127.0.0.1:3026/admin/invites/x", { method: "DELETE" });
    expect((await routes.remove(request, "../../x")).status).toBe(404);
  });
});

describe("a request that came through Caddy reaches nothing", () => {
  for (const header of ["X-Forwarded-For", "X-Portal-Hote"]) {
    test(`refused if it carries ${header}`, async () => {
      const { store, routes } = admin();
      const carried = { [header]: "203.0.113.7" };
      expect((await routes.create(creation(VALID, carried))).status).toBe(403);
      expect(routes.list(new Request("http://127.0.0.1:3026/admin/guests", { headers: carried })).status).toBe(403);
      const removal = new Request("http://127.0.0.1:3026/admin/invites/AAAAAAAAAAAAAAA0", {
        method: "DELETE",
        headers: carried,
      });
      expect((await routes.remove(removal, "AAAAAAAAAAAAAAA0")).status).toBe(403);
      expect(store.rows.size).toBe(0);
    });
  }
});

const HOST = "forum.test-zone.invalid";

const SETTINGS = readSettings(
  {
    OIDC_ISSUER: "https://idp.test-zone.invalid",
    OIDC_CLIENT_ID: "client-id-the-dashboard-never-sees",
    OIDC_CLIENT_SECRET: "secret-the-dashboard-never-sees",
    OIDC_ALLOWED_DOMAINS: "acme.test",
    OIDC_ADMIN_EMAILS: "owner@acme.test",
    OIDC_PROVIDER_NAME: "Acme",
  },
  "https://portal.test-zone.invalid",
).settings!;

/** `uid`: the account behind every connection, root unless a test says otherwise. */
function sharingAdmin(settings: Settings | null = SETTINGS, uid: number | null = 0) {
  const sharing = memorySharing();
  const audit = memoryAudit();
  return { sharing, audit, routes: createSharingAdmin({ sharing, audit, settings, callerUid: () => uid }, () => NOW) };
}

function replacement(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:3026/admin/sharing/${HOST}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("the sharing policies", () => {
  test("the list says how people sign in, never the client's secret nor its identifier", async () => {
    const { routes } = sharingAdmin();
    const response = routes.list(new Request("http://127.0.0.1:3026/admin/sharing"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      sso: {
        configured: true,
        providerName: "Acme",
        portalUrl: "https://portal.test-zone.invalid",
        admins: ["owner@acme.test"],
        allowedDomains: ["acme.test"],
      },
      sites: [],
    });
    expect(JSON.stringify(body)).not.toInclude("never-sees");
  });

  test("without a provider, the list says so", async () => {
    const { routes } = sharingAdmin(null);
    const body = (await routes.list(new Request("http://127.0.0.1:3026/admin/sharing")).json()) as { sso: unknown };
    expect(body.sso).toEqual({ configured: false, providerName: null, portalUrl: null, admins: [], allowedDomains: [] });
  });

  test("a policy replaces the previous one, and the audit says what changed", async () => {
    const { sharing, audit, routes } = sharingAdmin();
    sharing.set(HOST, { mode: "people", people: ["alice@acme.test", "bob@acme.test"], domains: [] }, 1);

    const response = await routes.replace(replacement({ mode: "domain", people: ["Bob@acme.test", "carol@acme.test"], domains: ["acme.test"] }), HOST);
    expect(response.status).toBe(200);
    const policy = { mode: "domain", people: ["bob@acme.test", "carol@acme.test"], domains: ["acme.test"] };
    expect(await response.json()).toEqual({ host: HOST, policy, updatedAt: NOW });
    expect(sharing.get(HOST)).toEqual(policy as never);

    expect(audit.events).toEqual([
      {
        id: 1,
        at: new Date(NOW).toISOString(),
        actor: "owner",
        action: "sharing.update",
        target: HOST,
        detail: {
          mode: "domain",
          previousMode: "people",
          peopleAdded: ["carol@acme.test"],
          peopleRemoved: ["alice@acme.test"],
          domainsAdded: ["acme.test"],
          domainsRemoved: [],
        },
      },
    ]);
  });

  test("the host is judged, in lowercase", async () => {
    const { sharing, routes } = sharingAdmin();
    expect((await routes.replace(replacement({ mode: "admins" }), "Forum.Test-Zone.Invalid")).status).toBe(200);
    expect(sharing.rows.has(HOST)).toBe(true);
    expect((await routes.replace(replacement({ mode: "admins" }), "a b")).status).toBe(400);
  });

  test("a bad policy changes nothing and records nothing", async () => {
    const { sharing, audit, routes } = sharingAdmin();
    for (const body of ["{", { mode: "public" }, { mode: "people", people: ["nobody"] }, { mode: "domain", domains: ["com"] }]) {
      expect((await routes.replace(replacement(body), HOST)).status).toBe(400);
    }
    expect(sharing.rows.size).toBe(0);
    expect(audit.events).toEqual([]);
  });

  test("the actor is the owner unless root names an email or a token", async () => {
    const { audit, routes } = sharingAdmin();
    await routes.replace(replacement({ mode: "admins", actor: "token:abc_1" }), HOST);
    await routes.replace(replacement({ mode: "admins", actor: "Alice@acme.test" }), HOST);
    expect((await routes.replace(replacement({ mode: "admins", actor: "root; drop" }), HOST)).status).toBe(400);
    expect(audit.events.map((event) => event.actor)).toEqual(["token:abc_1", "alice@acme.test"]);
  });

  test("any account but root naming an email or a token is refused, and nothing changes", async () => {
    // The dashboard's uid, and a connection whose owner could not be read.
    for (const uid of [997, null]) {
      const { audit, sharing, routes } = sharingAdmin(SETTINGS, uid);
      for (const actor of ["alice@acme.test", "token:abc_1"]) {
        const refused = await routes.replace(replacement({ mode: "domain", domains: ["acme.test"], actor }), HOST);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: "actor-not-root" });
      }
      expect(sharing.rows.size).toBe(0);
      expect(audit.events).toHaveLength(0);
      // The dashboard's own call, as the owner, goes through.
      expect((await routes.replace(replacement({ mode: "admins" }), HOST)).status).toBe(200);
      expect((await routes.replace(replacement({ mode: "admins", actor: "owner" }), HOST)).status).toBe(200);
      expect(audit.events.map((event) => event.actor)).toEqual(["owner", "owner"]);
    }
  });

  test("the audit reads by pages", async () => {
    const { audit, routes } = sharingAdmin();
    for (let i = 0; i < 5; i++) audit.record({ actor: "owner", action: "portal.signin" }, NOW + i);
    const page = (await routes.audit(new Request("http://127.0.0.1:3026/admin/audit?limit=2")).json()) as { events: { id: number }[] };
    expect(page.events.map((event) => event.id)).toEqual([5, 4]);
    const next = (await routes.audit(new Request("http://127.0.0.1:3026/admin/audit?limit=2&before=4")).json()) as { events: { id: number }[] };
    expect(next.events.map((event) => event.id)).toEqual([3, 2]);
    for (const query of ["limit=0", "limit=x", "before=-1", "limit=1.5"]) {
      expect(routes.audit(new Request(`http://127.0.0.1:3026/admin/audit?${query}`)).status).toBe(400);
    }
  });

  for (const header of ["X-Forwarded-For", "X-Portal-Hote"]) {
    test(`refused if it carries ${header}, like the guest routes`, async () => {
      const { sharing, routes } = sharingAdmin();
      const carried = { [header]: "203.0.113.7" };
      expect(routes.list(new Request("http://127.0.0.1:3026/admin/sharing", { headers: carried })).status).toBe(403);
      expect((await routes.replace(replacement({ mode: "domain", domains: ["acme.test"] }, carried), HOST)).status).toBe(403);
      expect(routes.audit(new Request("http://127.0.0.1:3026/admin/audit", { headers: carried })).status).toBe(403);
      expect(sharing.rows.size).toBe(0);
    });
  }
});

describe("the audit of guest accesses", () => {
  /** `uid`: the account behind every connection, root unless a test says otherwise. */
  function audited(uid: number | null = 0) {
    const store = memoryStore();
    const audit = memoryAudit();
    const routes = createAdmin(
      store,
      () => NOW,
      { drawPassword: () => PASSWORD, drawId: () => "AAAAAAAAAAAAAAA0" },
      audit,
      () => uid,
    );
    return { routes, audit, store };
  }

  test("giving an access records who it is for and until when, never the password", async () => {
    const { routes, audit } = audited();
    expect((await routes.create(creation(VALID))).status).toBe(201);
    expect(audit.events).toHaveLength(1);
    const [event] = audit.events;
    expect(event).toMatchObject({ actor: "owner", action: "guest.create", target: "forum.test-zone.invalid" });
    expect(event!.detail).toEqual({
      guest: "AAAAAAAAAAAAAAA0",
      label: "Alice",
      expiresAt: NOW + 7 * 24 * 3600 * 1000,
    });
    expect(JSON.stringify(audit.events)).not.toContain(PASSWORD);
    expect(JSON.stringify(audit.events)).not.toContain(guestHash(PASSWORD));
  });

  test("records the actor its caller names: a Project admin's email, as the steward sends it", async () => {
    const { routes, audit } = audited();
    expect((await routes.create(creation({ ...VALID, actor: "bob@acme.test" }))).status).toBe(201);
    const del = new Request("http://127.0.0.1:3026/admin/invites/AAAAAAAAAAAAAAA0", { method: "DELETE", body: JSON.stringify({ actor: "bob@acme.test" }) });
    expect((await routes.remove(del, "AAAAAAAAAAAAAAA0")).status).toBe(204);
    expect(audit.events.map((event) => [event.actor, event.action])).toEqual([
      ["bob@acme.test", "guest.create"],
      ["bob@acme.test", "guest.revoke"],
    ]);
  });

  test("only root names a Project admin as the actor: the dashboard naming one is refused, nothing given nor revoked", async () => {
    const { routes, audit, store } = audited(997);
    const given = await routes.create(creation({ ...VALID, actor: "bob@acme.test" }));
    expect(given.status).toBe(403);
    expect(await given.json()).toEqual({ error: "actor-not-root" });
    expect(store.rows.size).toBe(0);
    // As the owner, the dashboard's own word, it goes through.
    expect((await routes.create(creation(VALID))).status).toBe(201);
    const del = new Request("http://127.0.0.1:3026/admin/invites/AAAAAAAAAAAAAAA0", { method: "DELETE", body: JSON.stringify({ actor: "bob@acme.test" }) });
    expect((await routes.remove(del, "AAAAAAAAAAAAAAA0")).status).toBe(403);
    expect(store.rows.size).toBe(1);
    // An access that does not exist answers the same refusal: the actor is judged first.
    const unknown = new Request("http://127.0.0.1:3026/admin/invites/AAAAAAAAAAAAAAA9", { method: "DELETE", body: JSON.stringify({ actor: "bob@acme.test" }) });
    expect((await routes.remove(unknown, "AAAAAAAAAAAAAAA9")).status).toBe(403);
    expect(audit.events.map((event) => [event.actor, event.action])).toEqual([["owner", "guest.create"]]);
  });

  test("an actor the audit cannot record refuses the change, and records nothing", async () => {
    const { routes, audit } = audited();
    expect((await routes.create(creation({ ...VALID, actor: "Bob <bob@acme.test>" }))).status).toBe(400);
    await routes.create(creation(VALID));
    const del = new Request("http://127.0.0.1:3026/admin/invites/AAAAAAAAAAAAAAA0", { method: "DELETE", body: JSON.stringify({ actor: 42 }) });
    expect((await routes.remove(del, "AAAAAAAAAAAAAAA0")).status).toBe(400);
    expect(audit.events.map((event) => event.action)).toEqual(["guest.create"]);
  });

  test("revoking it records the host it opened, and an unknown access records nothing", async () => {
    const { routes, audit } = audited();
    await routes.create(creation(VALID));
    const del = (id: string) => new Request(`http://127.0.0.1:3026/admin/invites/${id}`, { method: "DELETE" });
    expect((await routes.remove(del("AAAAAAAAAAAAAAA0"), "AAAAAAAAAAAAAAA0")).status).toBe(204);
    expect(audit.events.map((e) => e.action)).toEqual(["guest.create", "guest.revoke"]);
    expect(audit.events[1]).toMatchObject({ actor: "owner", target: "forum.test-zone.invalid" });
    expect((await routes.remove(del("AAAAAAAAAAAAAAA9"), "AAAAAAAAAAAAAAA9")).status).toBe(404);
    expect(audit.events).toHaveLength(2);
  });
});
