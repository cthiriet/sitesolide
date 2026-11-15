import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { PasswordGrant } from "../src/access";
import { DATA_DIR } from "../src/config";
import { deriveKey, issueToken, guestHash } from "../src/gate";
import { actorOf, createRoutes, type Options } from "../src/routes";
import { accessFolder, grant, projection, site } from "./access-file";
import { memoryAudit } from "./memory";

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

/** A steward that gave access to nobody, what every case without accesses of its own reads. */
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

  test("a WebSocket handshake from another origin is refused, though it is a GET", () => {
    // A sibling project under the zone is the same site to the browser: the
    // Lax cookie goes with its page's handshake to this host, and a socket's
    // messages are readable by the page that opened it. Every browser sends
    // the Origin with a handshake, so the site's own pages keep theirs.
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const base = {
      "X-Portal-Hote": HOST,
      Cookie: `__Host-portal=${token}`,
      "X-Forwarded-Method": "GET",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    };
    expect(routes().verify(verification({ ...base, Origin: "https://agency.test-zone.invalid" })).status).toBe(403);
    expect(routes().verify(verification(base)).status).toBe(403);
    expect(routes().verify(verification({ ...base, Origin: ORIGIN })).status).toBe(200);
    // Caddy may keep the version without the Upgrade it treats as hop by hop.
    const { Upgrade: _, ...withoutUpgrade } = base;
    expect(routes().verify(verification({ ...withoutUpgrade, Origin: "https://agency.test-zone.invalid" })).status).toBe(403);
  });

  test("a frame of another origin is refused, the site's own frames and pages go through", () => {
    // A sibling host's page is the same site: its frame carries the Lax
    // cookie, and could have the visitor click through the app.
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const base = { "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}`, "X-Forwarded-Method": "GET" };
    for (const dest of ["iframe", "frame", "embed", "object"]) {
      expect(routes().verify(verification({ ...base, "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": "same-site" })).status).toBe(403);
      expect(routes().verify(verification({ ...base, "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
      expect(routes().verify(verification({ ...base, "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    }
    // A navigation, a sibling's fetch or image, a browser that sends nothing: as before.
    expect(routes().verify(verification({ ...base, "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "same-site" })).status).toBe(200);
    expect(routes().verify(verification({ ...base, "Sec-Fetch-Dest": "image", "Sec-Fetch-Site": "same-site" })).status).toBe(200);
    expect(routes().verify(verification({ ...base, "Sec-Fetch-Dest": "iframe" })).status).toBe(200);
    expect(routes().verify(verification(base)).status).toBe(200);
  });

  test("the sign-in page is never framed", () => {
    const response = routes().verify(verification({ "X-Portal-Hote": HOST }));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toInclude("frame-ancestors 'none'");
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

  test("once the owner holds a passkey, the owner's password opens nothing, a password access still does", async () => {
    const access = accessFolder("routes-passkey-only");
    access.write(projection({ [HOST]: site("kanban", { passwords: [grant({ id: ACCESS_ID, hash: guestHash(ACCESS_PASSWORD) })] }) }));
    let checked = 0;
    let held = true;
    const r = routes({
      access: access.reader(),
      verifyPassword: async (submitted) => (checked++, Bun.password.verify(submitted, hash)),
      passkeys: { offered: () => held, known: () => false },
    });

    const refused = await r.signIn(signIn({ motdepasse: PASSWORD }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("set-cookie")).toBeNull();
    const refusal = await refused.text();
    // Under the password's field, which the passkey's button now leads.
    expect(refusal).toInclude('<p class="alert" role="alert">Password refused.</p>');
    expect(refusal.indexOf('href="/_portal/passkey')).toBeLessThan(refusal.indexOf('name="motdepasse"'));
    // Not even verified: no argon2id for a password that cannot open.
    expect(checked).toBe(0);

    // A visitor with no cookie meets the passkey first as well.
    const door = await r.verify(verification({ "X-Portal-Hote": HOST })).text();
    expect(door).toInclude("Sign in with your passkey, or enter the password you were given.");
    expect(door).not.toInclude('role="alert"');

    expect((await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }))).status).toBe(303);

    // Root removed the last passkey: the password opens again.
    held = false;
    expect((await r.signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(303);
    expect(checked).toBe(1);
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

  test("its sign-in does not reset the site's failure count: it proves nothing of the owner's password", async () => {
    // Whoever holds a password access for one site must not be able to clear
    // the rate limiting of the owner's password there by signing in between
    // failures: the owner's password opens every site as admin.
    const { r } = withGrant();
    for (let i = 0; i < 3; i++) expect((await r.signIn(signIn({ motdepasse: "wrong" }))).status).toBe(401);
    expect((await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }))).status).toBe(303);
    expect((await r.signIn(signIn({ motdepasse: "wrong" }))).status).toBe(401);
    expect((await r.signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(429);
  });

  test("a site's failures are forgotten after a quiet day: a burst long past does not slow every later typo", async () => {
    // Only the owner's own success clears them, so without a quiet period a
    // burst of failures left every later typo on that site, a guest's
    // included, waiting longer each time, up to an hour, for good.
    let now = START;
    const { r } = withGrant({}, () => now);
    for (let i = 0; i < 4; i++) expect((await r.signIn(signIn({ motdepasse: "wrong" }))).status).toBe(401);
    now += 10_000;
    expect((await r.signIn(signIn({ motdepasse: "wrong" }))).status).toBe(401);
    expect((await r.signIn(signIn({ motdepasse: "wrong" }))).status).toBe(429);
    now += 24 * 3_600_000 + 10_000;
    expect((await r.signIn(signIn({ motdepasse: "wrong" }))).status).toBe(401);
    expect((await r.signIn(signIn({ motdepasse: "wrong" }))).status).toBe(401);
    expect((await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD }))).status).toBe(303);
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

  test("signs the owner out the same way, cookie in hand, with no page in between", () => {
    const owner = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const request = new Request("http://127.0.0.1:3026/_portal/deconnexion", {
      method: "POST",
      headers: { "X-Portal-Hote": HOST, Origin: ORIGIN, Cookie: `__Host-portal=${owner}` },
    });
    const response = routes().signOut(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toInclude("Max-Age=0");
  });
});

test("/sante says whether a hash is in place, without saying anything more about it", async () => {
  expect(await routes().health().json()).toEqual({ ok: true, configure: true });
  expect(await routes({ key: null }).health().json()).toEqual({ ok: true, configure: false });
});

describe("who came in, as the site learns it", () => {
  const NOW_S = START / 1000;

  function visit(r: ReturnType<typeof routes>, cookie: string) {
    return r.verify(verification({ "X-Portal-Hote": HOST, Cookie: cookie }));
  }

  test("the owner's cookie says admin and nobody, a password access's visitor and nobody", () => {
    const access = accessFolder("routes-roles");
    access.write(projection({ [HOST]: site("kanban", { passwords: [grant({ id: "PaSsWoRdAcCeSs01", hash: guestHash(ACCESS_PASSWORD) })] }) }));
    const r = routes({ access: access.reader() });
    const owner = visit(r, `__Host-portal=${issueToken(KEY, HOST, NOW_S + 60)}`);
    expect(Object.fromEntries(owner.headers)).toEqual({ "x-sitesolide-role": "admin" });
    const visitor = visit(r, `__Host-portal=${issueToken(KEY, HOST, NOW_S + 60, "PaSsWoRdAcCeSs01")}`);
    expect(Object.fromEntries(visitor.headers)).toEqual({ "x-sitesolide-role": "visitor" });
  });

  test("the company account's routes are gone: nothing answers them here", () => {
    const r = routes() as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["health", "signIn", "signOut", "verify"]);
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

  test("an access given under a name is named by its identifier, its name beside it, and so is one removed before its sign-out", async () => {
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
    expect(audit.events.map(({ actor, action, detail }) => ({ actor, action, detail }))).toEqual([
      { actor: "password:PaSsWoRdAcCeSs07", action: "portal.signin", detail: { method: "password-access", name: "Bob from the agency" } },
      { actor: "password:PaSsWoRdAcCeSs07", action: "portal.signout", detail: null },
    ]);
  });

  test("who a cookie names: the owner, or the access by who it was given to when it is the same one", () => {
    const token = (guest: string | null) => ({ guest });
    expect(actorOf(null)).toBe("anonymous");
    expect(actorOf(token(null))).toBe("owner");
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

describe("a site's own domain", () => {
  const DOMAIN = "kanban.example";
  const DOMAIN_ORIGIN = `https://${DOMAIN}`;
  /** What the block of kanban's own domain announces: its host, then the site's address. */
  const ANNOUNCED = `${DOMAIN} ${HOST}`;
  const ACCESS_ID = "PaSsWoRdAcCeSs03";
  const NOW_S = START / 1000;

  /** A steward that filed kanban's accesses under its preview, the one address it knows. */
  function withSite(rest: Parameters<typeof site>[1] = {}) {
    const access = accessFolder("routes-domain");
    access.write(projection({ [HOST]: site("kanban", rest) }));
    return routes({ access: access.reader() });
  }

  function onDomain(fields: Record<string, string>): Request {
    return signIn(fields, { "X-Portal-Hote": ANNOUNCED, Origin: DOMAIN_ORIGIN });
  }

  function visit(r: ReturnType<typeof routes>, cookie: string, announced = ANNOUNCED) {
    return r.verify(verification({ "X-Portal-Hote": announced, Cookie: cookie }));
  }

  test("a password access given on the site opens it on its domain too, with a cookie for the domain alone", async () => {
    const r = withSite({ passwords: [grant({ id: ACCESS_ID, hash: guestHash(ACCESS_PASSWORD) })] });
    const response = await r.signIn(onDomain({ motdepasse: ACCESS_PASSWORD, retour: "/list" }));
    expect(response.status).toBe(303);
    const cookie = cookieOf(response);
    expect(visit(r, cookie).status).toBe(200);
    // Signed for the host the browser is on: the preview does not take it,
    // and the preview's cookie does not open the domain.
    expect(visit(r, cookie, HOST).status).toBe(401);
    const preview = cookieOf(await r.signIn(signIn({ motdepasse: ACCESS_PASSWORD })));
    expect(visit(r, preview).status).toBe(401);
    expect(visit(r, preview, HOST).status).toBe(200);
  });

  test("a password access of another site gets nothing here by announcing it: only the block says whose site it is", async () => {
    // The visitor cannot write X-Portal-Hote, Caddy overwrites it; a block
    // that announced a site other than its own would be a generator's fault,
    // and the cookie, signed for its host, still opens nothing elsewhere.
    const access = accessFolder("routes-domain-other");
    access.write(projection({ [HOST]: site("kanban"), [OTHER]: site("roster", { passwords: [grant({ id: ACCESS_ID, hash: guestHash(ACCESS_PASSWORD) })] }) }));
    const r = routes({ access: access.reader() });
    const roster = `__Host-portal=${issueToken(KEY, DOMAIN, NOW_S + 3600, ACCESS_ID)}`;
    expect(visit(r, roster).status).toBe(401);
    expect(visit(r, roster, `${DOMAIN} ${OTHER}`).status).toBe(200);
    expect(visit(r, roster, `${OTHER} ${OTHER}`).status).toBe(401);
    expect((await r.signIn(onDomain({ motdepasse: ACCESS_PASSWORD }))).status).toBe(401);
  });

  test("the owner's password opens the domain, and the failures count with the preview's", async () => {
    const r = withSite();
    for (let i = 0; i < 2; i++) await r.signIn(signIn({ motdepasse: "wrong" }));
    for (let i = 0; i < 2; i++) await r.signIn(onDomain({ motdepasse: "wrong" }));
    // Four failures on one site, two per address: the right password waits.
    expect((await r.signIn(onDomain({ motdepasse: PASSWORD }))).status).toBe(429);
    expect((await withSite().signIn(onDomain({ motdepasse: PASSWORD }))).status).toBe(303);
  });

  test("the origin checked is the domain's", async () => {
    const r = withSite();
    const fromPreview = signIn({ motdepasse: PASSWORD }, { "X-Portal-Hote": ANNOUNCED, Origin: ORIGIN });
    expect((await r.signIn(fromPreview)).status).toBe(403);
  });

  test("an announcement of any other shape opens nothing", async () => {
    const r = withSite();
    const owner = cookieOf(await r.signIn(onDomain({ motdepasse: PASSWORD })));
    expect(visit(r, owner).status).toBe(200);
    // Spaces around the value are no part of it in HTTP, and never reach here.
    for (const announced of [`${DOMAIN} ${HOST} ${OTHER}`, `${DOMAIN}  ${HOST}`, `${DOMAIN},${HOST}`, `${DOMAIN}\t${HOST}`]) {
      expect(visit(r, owner, announced).status).toBe(401);
    }
  });
});
