import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { PasswordGrant, Role } from "../src/access";
import { DATA_DIR } from "../src/config";
import { deriveKey, issueToken, guestHash, issueIdentityToken } from "../src/gate";
import { readSignOut } from "../src/handoff";
import { readSettings } from "../src/oidc";
import { actorOf, createRoutes, type Options } from "../src/routes";
import { accessFolder, grant, projection, site } from "./access-file";
import { memoryAudit, memoryGuests, memorySharing } from "./memory";

// The diversion of DATA_DIR is checked rather than assumed: without it, a test
// would write the portal's key where the service looks for it.
test("DATA_DIR is diverted towards .attempts", () => {
  expect(DATA_DIR).toBe(join(import.meta.dir, "..", ".attempts"));
});

const HOST = "kanban.test-zone.invalid";
const OTHER = "roster.test-zone.invalid";
const ORIGIN = `https://${HOST}`;
const PASSWORD = "Xith-G4r4-nRJs-uDMV-KhsD-mzuK";
const ACCESS_PASSWORD = "Ab3d-Ef4h-Jk5m-Np6q";
const KEY = deriveKey(new Uint8Array(32).fill(3), "$argon2id$sample")!;
const DURATION = 30 * 24 * 3600;
const START = 1_800_000_000_000;

/** A steward that gave access to nobody, what every case without people of its own reads. */
const NOBODY = accessFolder("routes-nobody");
NOBODY.write(projection({}));

let hash = "";
beforeAll(async () => {
  // Minimal settings: the test bears on the decision, not on argon2's cost.
  hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
});

function routes(options: Partial<Options> = {}, clock = () => START) {
  return createRoutes(
    {
      key: KEY,
      verifyPassword: (submitted) => Bun.password.verify(submitted, hash),
      online: true,
      cookieDurationS: DURATION,
      access: NOBODY.reader(),
      ...options,
    },
    clock,
  );
}

function verification(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:3026/verifier", { headers });
}

function signIn(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  const body = new URLSearchParams(fields);
  return new Request("http://127.0.0.1:3026/_portal/connexion", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Portal-Hote": HOST,
      Origin: ORIGIN,
      ...headers,
    },
    body,
  });
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

describe("/verifier", () => {
  test("without X-Portal-Hote, 401: nothing opens by default", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const response = routes().verify(verification({ Cookie: `__Host-portal=${token}` }));
    expect(response.status).toBe(401);
  });

  test("without a cookie, a 401 whose body is the login page", async () => {
    const response = routes().verify(
      verification({ "X-Portal-Hote": HOST, "X-Forwarded-Method": "GET", "X-Forwarded-Uri": "/list" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("x-portal")).toBe("connexion");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.text();
    expect(page).toInclude('name="retour" value="/list"');
    expect(page).toInclude("This site is private.");
  });

  test("a good cookie lets through", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const response = routes().verify(verification({ "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}` }));
    expect(response.status).toBe(200);
  });

  test("the cookie of another host does not get through", () => {
    const token = issueToken(KEY, OTHER, 1_800_000_000 + 60);
    const response = routes().verify(verification({ "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}` }));
    expect(response.status).toBe(401);
  });

  test("without a hash, even a well signed cookie does not get through", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const response = routes({ key: null }).verify(
      verification({ "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}` }),
    );
    expect(response.status).toBe(401);
  });

  test("a POST carrying a good cookie but coming from elsewhere is refused", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const base = { "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}`, "X-Forwarded-Method": "POST" };
    expect(routes().verify(verification({ ...base, Origin: "https://agency.test-zone.invalid" })).status).toBe(403);
    expect(routes().verify(verification(base)).status).toBe(403);
    expect(routes().verify(verification({ ...base, Origin: ORIGIN })).status).toBe(200);
  });

  test("a well signed password access token with no access behind it does not get through", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60, "AAAAAAAAAAAAAAAA");
    const response = routes().verify(verification({ "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}` }));
    expect(response.status).toBe(401);
  });
});

describe("/_portal/connexion", () => {
  test("the right password sets the cookie and sends back to the requested page", async () => {
    const r = routes();
    const response = await r.signIn(signIn({ motdepasse: PASSWORD, retour: "/list" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/list");

    // The cookie that was set does open the host, and it alone.
    const cookie = cookieOf(response);
    expect(cookie.startsWith("__Host-portal=")).toBe(true);
    expect(r.verify(verification({ "X-Portal-Hote": HOST, Cookie: cookie })).status).toBe(200);
    expect(r.verify(verification({ "X-Portal-Hote": OTHER, Cookie: cookie })).status).toBe(401);
  });

  test("a return that leads elsewhere brings back to the home page", async () => {
    const response = await routes().signIn(signIn({ motdepasse: PASSWORD, retour: "//evil.test" }));
    expect(response.headers.get("location")).toBe("/");
  });

  test("a wrong password renders the page, with a 401, without a cookie", async () => {
    const response = await routes().signIn(signIn({ motdepasse: "wrong", retour: "/list" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toInclude("Password refused");
  });

  test("a foreign origin is refused before the counter moves", async () => {
    const r = routes();
    for (let i = 0; i < 10; i++) {
      const response = await r.signIn(signIn({ motdepasse: "wrong" }, { Origin: "https://evil.test" }));
      expect(response.status).toBe(403);
    }
    // Ten origin refusals have not closed the gate to the real user.
    expect((await r.signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(303);
  });

  test("after three failures, the rate limiting refuses even the right password", async () => {
    let now = START;
    const r = routes({}, () => now);
    for (let i = 0; i < 4; i++) await r.signIn(signIn({ motdepasse: "wrong" }));

    const throttled = await r.signIn(signIn({ motdepasse: PASSWORD }));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("5");

    now += 5_000;
    expect((await r.signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(303);
  });

  test("the rate limiting of one site does not slow the others down", async () => {
    const r = routes();
    for (let i = 0; i < 4; i++) await r.signIn(signIn({ motdepasse: "wrong" }));
    expect((await r.signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(429);

    const elsewhere = signIn({ motdepasse: PASSWORD }, { "X-Portal-Hote": OTHER, Origin: `https://${OTHER}` });
    expect((await r.signIn(elsewhere)).status).toBe(303);
  });

  test("without a hash, the right password is refused like any other", async () => {
    const response = await routes({ key: null }).signIn(signIn({ motdepasse: PASSWORD }));
    expect(response.status).toBe(401);
  });

  test("a body without a password, or an oversized password, is refused", async () => {
    expect((await routes().signIn(signIn({ retour: "/" }))).status).toBe(400);
    expect((await routes().signIn(signIn({ motdepasse: "x".repeat(257) }))).status).toBe(400);
  });

  test("without X-Portal-Hote, nothing is checked", async () => {
    const request = signIn({ motdepasse: PASSWORD }, { "X-Portal-Hote": "" });
    expect((await routes().signIn(request)).status).toBe(400);
  });
});

describe("a password access", () => {
  const ACCESS_ID = "PaSsWoRdAcCeSs01";

  /** A steward that gave one password access, on HOST unless the test says otherwise. */
  function withGrant(rest: Partial<PasswordGrant> = {}, clock = () => START, host = HOST) {
    const access = accessFolder("routes-password");
    const given = grant({ id: ACCESS_ID, hash: guestHash(ACCESS_PASSWORD), ...rest });
    access.write(projection({ [host]: site(host.split(".")[0]!, { passwords: [given] }) }));
    return { access, given, r: routes({ access: access.reader() }, clock) };
  }

  function visit(r: ReturnType<typeof routes>, cookie: string, host = HOST) {
    return r.verify(verification({ "X-Portal-Hote": host, Cookie: cookie }));
  }

  test("its password opens its site as visitor, and it alone", async () => {
    const { r } = withGrant();
    const response = await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD, retour: "/list" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/list");

    const cookie = cookieOf(response);
    expect(cookie.split(".")).toHaveLength(3);
    const opened = visit(r, cookie);
    expect(opened.status).toBe(200);
    expect(Object.fromEntries(opened.headers)).toEqual({ "x-sitesolide-role": "visitor" });
    expect(visit(r, cookie, OTHER).status).toBe(401);
  });

  test("on another site, its password is worth nothing and counts as a failure", async () => {
    const { r } = withGrant({}, () => START, OTHER);
    const response = await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("removed by the steward, it closes at the next request, cookie in hand", async () => {
    const { access, r } = withGrant();
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD })));
    expect(visit(r, cookie).status).toBe(200);

    access.write(projection({ [HOST]: site("kanban") }));
    const refused = visit(r, cookie);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toInclude("This access is no longer valid.");
    expect((await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }))).status).toBe(401);
  });

  test("its cookie is read again by its identifier: a new password under a new identifier opens, the old cookie does not", async () => {
    const { access, given, r } = withGrant();
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD })));
    const NEW_PASSWORD = "Qr7s-Tu8v-Wx9y-Za2b";
    const drawnAgain = { ...given, id: "PaSsWoRdAcCeSs02", hash: guestHash(NEW_PASSWORD) };
    access.write(projection({ [HOST]: site("kanban", { passwords: [drawnAgain] }) }));
    expect(visit(r, cookie).status).toBe(401);
    expect((await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }))).status).toBe(401);
    const renewed = cookieOf(await r.signIn(signIn({ motdepasse: NEW_PASSWORD })));
    expect(visit(r, renewed).status).toBe(200);
  });

  test("at its expiry, the cookie falls with the access, and the password too", async () => {
    let now = START;
    const { r } = withGrant({ expiresAt: START + 3_600_000 }, () => now);
    const response = await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }));
    // The browser forgets it at the expiry, without waiting thirty days.
    expect(response.headers.get("set-cookie")).toInclude("Max-Age=3600;");

    const cookie = cookieOf(response);
    now = START + 3_599_000;
    expect(visit(r, cookie).status).toBe(200);
    now = START + 3_600_000;
    expect(visit(r, cookie).status).toBe(401);
    expect((await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }))).status).toBe(401);
  });

  test("without the owner's hash, a password access does not get in either", async () => {
    const { access } = withGrant();
    const response = await routes({ key: null, access: access.reader() }).signIn(signIn({ motdepasse: ACCESS_PASSWORD }));
    expect(response.status).toBe(401);
  });

  test("a projection the portal cannot believe closes it, never the owner", async () => {
    const { access, r } = withGrant();
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD })));
    const owner = cookieOf(await r.signIn(signIn({ motdepasse: PASSWORD })));
    access.write("{ not json");
    expect(visit(r, cookie).status).toBe(401);
    expect(visit(r, owner).status).toBe(200);
    expect((await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }))).status).toBe(401);
  });

  test("a POST coming from elsewhere is refused to a password access as to the owner", async () => {
    const { r } = withGrant();
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD })));
    const request = verification({
      "X-Portal-Hote": HOST,
      Cookie: cookie,
      "X-Forwarded-Method": "POST",
      Origin: "https://agency.test-zone.invalid",
    });
    expect(r.verify(request).status).toBe(403);
  });

  test("before the steward writes its projection, a guest of the portal's own table still gets in, as visitor", async () => {
    const guests = memoryGuests();
    guests.add({ id: "InViTeInViTe0001", host: HOST, label: "Alice", createdAt: START, expiresAt: null, seenAt: null }, guestHash(ACCESS_PASSWORD));
    const r = routes({ access: accessFolder("routes-legacy").reader({ guests, sharing: memorySharing() }) });
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD })));
    const opened = visit(r, cookie);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("x-sitesolide-role")).toBe("visitor");
  });
});

describe("/_portal/deconnexion", () => {
  test("erases the cookie and sends back to the home page", () => {
    const request = new Request("http://127.0.0.1:3026/_portal/deconnexion", {
      method: "POST",
      headers: { "X-Portal-Hote": HOST, Origin: ORIGIN },
    });
    const response = routes().signOut(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toInclude("Max-Age=0");
  });

  test("refuses a foreign origin", () => {
    const request = new Request("http://127.0.0.1:3026/_portal/deconnexion", {
      method: "POST",
      headers: { "X-Portal-Hote": HOST, Origin: "https://evil.test" },
    });
    expect(routes().signOut(request).status).toBe(403);
  });

  test("with a provider, goes on to the portal's host to end its session too, with a ticket for this host", () => {
    // A page rather than a 303: a site whose CSP says form-action 'self'
    // would see its sign-out form refused on a redirect to another host.
    const request = new Request("http://127.0.0.1:3026/_portal/deconnexion", {
      method: "POST",
      headers: { "X-Portal-Hote": HOST, Origin: ORIGIN },
    });
    const response = routes({ settings: SETTINGS }).signOut(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toInclude("Max-Age=0");
    expect(response.headers.get("x-portal")).toBe("connexion");
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.text().then((page) => {
      const next = new URL(page.match(/<meta http-equiv="refresh" content="0; url=([^"]+)">/)![1]!);
      expect(next.origin).toBe("https://portal.test-zone.invalid");
      expect(next.pathname).toBe("/oidc/signout");
      expect(readSignOut(KEY, next.searchParams.get("ticket"), START / 1000)).toBe(HOST);
    });
  });
});

test("/sante says whether a hash is in place, without saying anything more about it", async () => {
  expect(await routes().health().json()).toEqual({ ok: true, configure: true });
  expect(await routes({ key: null }).health().json()).toEqual({ ok: true, configure: false });
});

const SETTINGS = readSettings(
  {
    OIDC_ISSUER: "https://idp.test-zone.invalid",
    OIDC_CLIENT_ID: "client",
    OIDC_CLIENT_SECRET: "not-a-real-secret",
    OIDC_ADMIN_EMAILS: "owner@acme.test",
    OIDC_PROVIDER_NAME: "Acme",
  },
  "https://portal.test-zone.invalid",
).settings!;

describe("an identity on /verifier", () => {
  const NOW_S = START / 1000;

  function identityCookie(email: string, name: string | null = null, host = HOST): string {
    return `__Host-portal=${issueIdentityToken(KEY, host, NOW_S + 3600, { email, name })}`;
  }

  /** A steward that gave HOST to these people and domains; `null`, a site it never listed. */
  function withPeople(people: Record<string, Role> | null, domains: string[] = []) {
    const access = accessFolder("routes-identity");
    access.write(projection(people === null ? {} : { [HOST]: site("kanban", { people, domains }) }));
    return { access, r: routes({ settings: SETTINGS, access: access.reader() }) };
  }

  function visit(r: ReturnType<typeof routes>, cookie: string) {
    return r.verify(verification({ "X-Portal-Hote": HOST, Cookie: cookie, "X-Forwarded-Uri": "/board" }));
  }

  test("an admin email gets in everywhere, as admin, its email and name passed on", () => {
    const { r } = withPeople(null);
    const response = visit(r, identityCookie("owner@acme.test", "Owner Name"));
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "x-sitesolide-role": "admin",
      "x-sitesolide-user": "owner@acme.test",
      "x-sitesolide-user-name": "Owner%20Name",
    });
  });

  test("a site the steward never listed lets nobody else in, and says so, offering another account", async () => {
    const { r } = withPeople(null);
    const response = visit(r, identityCookie("alice@acme.test"));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-portal")).toBe("connexion");
    expect(response.headers.get("x-sitesolide-user")).toBeNull();
    const page = await response.text();
    expect(page).toInclude("You are signed in as alice@acme.test, but you don&#39;t have access to this site.");
    expect(page).toInclude("account=choose");
  });

  test("a person listed gets in with the role of their entry, the others do not", () => {
    for (const role of ["visitor", "viewer", "developer", "admin"] as const) {
      const { r } = withPeople({ "alice@acme.test": role });
      const alice = visit(r, identityCookie("alice@acme.test"));
      expect(alice.status).toBe(200);
      expect(alice.headers.get("x-sitesolide-role")).toBe(role);
      expect(alice.headers.get("x-sitesolide-user")).toBe("alice@acme.test");
      expect(alice.headers.get("x-sitesolide-user-name")).toBeNull();
      expect(visit(r, identityCookie("bob@acme.test")).status).toBe(401);
    }
  });

  test("a domain lets everyone at it in as visitor, and a person listed above that keeps their role", () => {
    const { r } = withPeople({ "alice@acme.test": "developer" }, ["acme.test"]);
    const bob = visit(r, identityCookie("bob@acme.test"));
    expect(bob.status).toBe(200);
    expect(bob.headers.get("x-sitesolide-role")).toBe("visitor");
    expect(visit(r, identityCookie("alice@acme.test")).headers.get("x-sitesolide-role")).toBe("developer");
    expect(visit(r, identityCookie("eve@elsewhere.test")).status).toBe(401);
  });

  test("lowered, then removed, at the very next request each time, cookie in hand", () => {
    const { access, r } = withPeople({ "alice@acme.test": "developer" });
    const cookie = identityCookie("alice@acme.test");
    expect(visit(r, cookie).headers.get("x-sitesolide-role")).toBe("developer");
    access.write(projection({ [HOST]: site("kanban", { people: { "alice@acme.test": "visitor" } }) }));
    expect(visit(r, cookie).headers.get("x-sitesolide-role")).toBe("visitor");
    access.write(projection({ [HOST]: site("kanban") }));
    expect(visit(r, cookie).status).toBe(401);
  });

  test("a projection the portal cannot believe closes everyone out but the admin emails", () => {
    const { access, r } = withPeople({ "alice@acme.test": "admin" });
    access.write("{ not json");
    expect(visit(r, identityCookie("alice@acme.test")).status).toBe(401);
    expect(visit(r, identityCookie("owner@acme.test")).status).toBe(200);
  });

  test("a domain taken off the allowed ones closes its people out at the next request, the admins excepted", () => {
    const access = accessFolder("routes-narrowed");
    access.write(projection({ [HOST]: site("kanban", { people: { "carol@partner.test": "viewer" }, domains: ["acme.test", "partner.test"] }) }));
    const narrowed = { ...SETTINGS, allowedDomains: ["acme.test"] };
    const r = routes({ settings: narrowed, access: access.reader() });
    expect(visit(r, identityCookie("bob@acme.test")).status).toBe(200);
    expect(visit(r, identityCookie("carol@partner.test")).status).toBe(401);
    expect(visit(r, identityCookie("dave@partner.test")).status).toBe(401);
    const admitted = routes({ settings: { ...narrowed, admins: ["boss@partner.test"] }, access: access.reader() });
    expect(visit(admitted, identityCookie("boss@partner.test")).status).toBe(200);
  });

  test("the identity cookie of another site opens nothing here, listed or not", () => {
    const { r } = withPeople({ "alice@acme.test": "visitor" });
    expect(visit(r, identityCookie("alice@acme.test", null, OTHER)).status).toBe(401);
  });

  test("without the provider's settings, an identity cookie opens nothing, an admin's included", () => {
    const access = accessFolder("routes-no-provider");
    access.write(projection({ [HOST]: site("kanban", { people: { "alice@acme.test": "admin" } }) }));
    const r = routes({ access: access.reader() });
    expect(visit(r, identityCookie("owner@acme.test")).status).toBe(401);
    expect(visit(r, identityCookie("alice@acme.test")).status).toBe(401);
  });

  test("the owner's cookie says admin and nobody, a password access's visitor and nobody, with or without a provider", () => {
    const access = accessFolder("routes-roles");
    access.write(projection({ [HOST]: site("kanban", { passwords: [grant({ id: "PaSsWoRdAcCeSs01", hash: guestHash(ACCESS_PASSWORD) })] }) }));
    for (const settings of [null, SETTINGS]) {
      const r = routes({ settings, access: access.reader() });
      const owner = visit(r, `__Host-portal=${issueToken(KEY, HOST, NOW_S + 60)}`);
      expect(Object.fromEntries(owner.headers)).toEqual({ "x-sitesolide-role": "admin" });
      const visitor = visit(r, `__Host-portal=${issueToken(KEY, HOST, NOW_S + 60, "PaSsWoRdAcCeSs01")}`);
      expect(Object.fromEntries(visitor.headers)).toEqual({ "x-sitesolide-role": "visitor" });
    }
  });

  test("before the steward writes its projection, a person the portal's own policy listed gets in, as visitor", () => {
    const sharing = memorySharing();
    sharing.put(HOST, { mode: "people", people: ["alice@acme.test"], domains: [] }, START);
    const r = routes({ settings: SETTINGS, access: accessFolder("routes-legacy-people").reader({ guests: memoryGuests(), sharing }) });
    const alice = visit(r, identityCookie("alice@acme.test"));
    expect(alice.status).toBe(200);
    expect(alice.headers.get("x-sitesolide-role")).toBe("visitor");
    expect(visit(r, identityCookie("owner@acme.test")).headers.get("x-sitesolide-role")).toBe("admin");
    expect(visit(r, identityCookie("bob@acme.test")).status).toBe(401);
  });

  test("a POST from elsewhere is refused to an identity as to anyone", () => {
    const { r } = withPeople(null);
    const request = verification({
      "X-Portal-Hote": HOST,
      Cookie: identityCookie("owner@acme.test"),
      "X-Forwarded-Method": "POST",
      Origin: "https://agency.test-zone.invalid",
    });
    expect(r.verify(request).status).toBe(403);
  });
});

describe("the sign-in page offers the provider", () => {
  test("when it is configured, a link that keeps the return", async () => {
    const page = await routes({ settings: SETTINGS })
      .verify(verification({ "X-Portal-Hote": HOST, "X-Forwarded-Uri": "/board?x=1" }))
      .text();
    expect(page).toInclude('href="/_portal/oidc?retour=%2Fboard%3Fx%3D1"');
    expect(page).toInclude("Sign in with Acme");
    expect(page).toInclude('name="motdepasse"');
  });

  test("never without a hash, nor without settings", async () => {
    expect(await routes().verify(verification({ "X-Portal-Hote": HOST })).text()).not.toInclude("/_portal/oidc");
    expect(await routes({ key: null, settings: SETTINGS }).verify(verification({ "X-Portal-Hote": HOST })).text()).not.toInclude(
      "/_portal/oidc",
    );
  });
});

describe("the audit of sign-ins", () => {
  test("the owner's password, a failure and a sign-out, never the password itself", async () => {
    const audit = memoryAudit();
    const r = routes({ audit });
    await r.signIn(signIn({ motdepasse: "wrong" }));
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: PASSWORD })));
    r.signOut(
      new Request("http://127.0.0.1:3026/_portal/deconnexion", {
        method: "POST",
        headers: { "X-Portal-Hote": HOST, Origin: ORIGIN, Cookie: cookie },
      }),
    );
    expect(audit.events.map(({ actor, action, target, detail }) => ({ actor, action, target, detail }))).toEqual([
      { actor: "anonymous", action: "portal.signin_failed", target: HOST, detail: { method: "password" } },
      { actor: "owner", action: "portal.signin", target: HOST, detail: { method: "password" } },
      { actor: "owner", action: "portal.signout", target: HOST, detail: null },
    ]);
    expect(JSON.stringify(audit.events)).not.toInclude(PASSWORD);
  });

  test("a password access is named by the email it was given to, never by its password", async () => {
    const audit = memoryAudit();
    const access = accessFolder("routes-audit-email");
    access.write(projection({ [HOST]: site("kanban", { passwords: [grant({ who: "zoe@elsewhere.test", hash: guestHash(ACCESS_PASSWORD) })] }) }));
    const r = routes({ audit, access: access.reader() });
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD })));
    r.signOut(
      new Request("http://127.0.0.1:3026/_portal/deconnexion", {
        method: "POST",
        headers: { "X-Portal-Hote": HOST, Origin: ORIGIN, Cookie: cookie },
      }),
    );
    expect(audit.events.map(({ actor, action, detail }) => ({ actor, action, detail }))).toEqual([
      { actor: "zoe@elsewhere.test", action: "portal.signin", detail: { method: "password-access" } },
      { actor: "zoe@elsewhere.test", action: "portal.signout", detail: null },
    ]);
    expect(JSON.stringify(audit.events)).not.toInclude(ACCESS_PASSWORD);
    expect(JSON.stringify(audit.events)).not.toInclude(guestHash(ACCESS_PASSWORD));
  });

  test("an access given under a name is named by its identifier, and so is one removed before its sign-out", async () => {
    const audit = memoryAudit();
    const access = accessFolder("routes-audit-name");
    access.write(projection({ [HOST]: site("kanban", { passwords: [grant({ id: "PaSsWoRdAcCeSs07", who: "Bob from the agency", hash: guestHash(ACCESS_PASSWORD) })] }) }));
    const r = routes({ audit, access: access.reader() });
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD })));

    const given = grant({ id: "PaSsWoRdAcCeSs08", who: "zoe@elsewhere.test" });
    access.write(projection({ [HOST]: site("kanban", { passwords: [given] }) }));
    r.signOut(
      new Request("http://127.0.0.1:3026/_portal/deconnexion", {
        method: "POST",
        headers: { "X-Portal-Hote": HOST, Origin: ORIGIN, Cookie: cookie },
      }),
    );
    expect(audit.events.map(({ actor, action }) => ({ actor, action }))).toEqual([
      { actor: "password:PaSsWoRdAcCeSs07", action: "portal.signin" },
      { actor: "password:PaSsWoRdAcCeSs07", action: "portal.signout" },
    ]);
  });

  test("who a cookie names: the owner, the email, the access by who it was given to when it is the same one", () => {
    const token = (guest: string | null) => ({ guest });
    expect(actorOf(null)).toBe("anonymous");
    expect(actorOf(token(null))).toBe("owner");
    expect(actorOf({ ...token(null), identity: { email: "alice@acme.test", name: null } })).toBe("alice@acme.test");
    expect(actorOf(token("PaSsWoRdAcCeSs01"), grant())).toBe("alice@elsewhere.test");
    expect(actorOf(token("PaSsWoRdAcCeSs01"))).toBe("password:PaSsWoRdAcCeSs01");
    expect(actorOf(token("PaSsWoRdAcCeSs09"), grant())).toBe("password:PaSsWoRdAcCeSs09");
  });

  test("a rate-limited attempt writes nothing: the limit bounds the audit too", async () => {
    const audit = memoryAudit();
    const r = routes({ audit });
    for (let i = 0; i < 10; i++) await r.signIn(signIn({ motdepasse: "wrong" }));
    expect(audit.events.length).toBe(4);
  });

  test("an audit that fails does not stop the sign-in", async () => {
    const audit = memoryAudit();
    audit.record = () => {
      throw new Error("disk full");
    };
    const original = console.error;
    console.error = () => {};
    try {
      expect((await routes({ audit }).signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(303);
    } finally {
      console.error = original;
    }
  });
});
