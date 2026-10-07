import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_AUDIENCE, encodeKey, generateKeyPair, verifyAssertion } from "../src/assertion";
import { DATA_DIR } from "../src/config";
import { deriveKey } from "../src/gate";
import { drawBinding, HANDOFF_PER_EMAIL, IDENTITY_DURATION_S, issueSession } from "../src/handoff";
import { makeSigner, startProvider, type MockProvider } from "./provider";

/**
 * The whole sign-in with an identity provider, through real HTTP: the
 * portal's own server.ts in a process of its own, configured like on the
 * machine, and a provider of the tests' making on another port.
 *
 * The test is the browser. It keeps one cookie jar per host, follows the
 * redirects by hand, and plays Caddy for the protected site: a request to
 * `kanban.localhost` goes to the portal's port with `X-Portal-Hote`, which is
 * what the site's fragment does for `/_portal/*` and `/verifier`. The
 * portal's own host is its port, as `PUBLIC_URL` says.
 */

if (!DATA_DIR.endsWith(".attempts")) throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);

const SITE = "kanban.localhost";
const OTHER_SITE = "roster.localhost";
/** The dashboard, which the test plays: the browser stops when it is sent there. */
const DASHBOARD = "dashboard.localhost";
const PASSWORD = "sample-portal-password";
const FOLDER = join(DATA_DIR, "sso-flow");

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

let provider: MockProvider;
let portal: ReturnType<typeof Bun.spawn>;
const pair = await generateKeyPair();
let hash = "";
const portalPort = freePort();
const PORTAL = `http://127.0.0.1:${portalPort}`;

/** One browser: its cookies by host, and what it asks of whom. */
class Browser {
  jars = new Map<string, Map<string, string>>();

  cookies(host: string): string {
    return [...(this.jars.get(host) ?? new Map()).entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  cookie(host: string, name: string): string | undefined {
    return this.jars.get(host)?.get(name);
  }

  keep(host: string, response: Response): void {
    const jar = this.jars.get(host) ?? new Map<string, string>();
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";").map((part) => part.trim());
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator);
      const value = pair!.slice(separator + 1);
      if (attributes.includes("Max-Age=0") || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    this.jars.set(host, jar);
  }

  /** One request, as the browser would send it; a protected site's goes through "Caddy". */
  async get(address: string, extra: Record<string, string> = {}): Promise<Response> {
    const url = new URL(address);
    const host = url.host;
    if (host === DASHBOARD) return new Response(null, { status: 204 });
    const isSite = host === SITE || host === OTHER_SITE;
    const target = isSite ? `${PORTAL}${url.pathname}${url.search}` : address;
    const headers: Record<string, string> = { ...extra };
    const cookie = this.cookies(host);
    if (cookie !== "") headers.Cookie = cookie;
    if (isSite) headers["X-Portal-Hote"] = url.hostname;
    const response = await fetch(target, { headers, redirect: "manual" });
    this.keep(host, response);
    return response;
  }

  /** Follows the redirects until an answer that is not one, and says where it stopped. */
  async follow(address: string, limit = 10): Promise<{ response: Response; url: string; visited: string[] }> {
    let url = address;
    const visited: string[] = [];
    for (let i = 0; i < limit; i++) {
      visited.push(url);
      const response = await this.get(url);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || location === null) return { response, url, visited };
      url = new URL(location, url).toString();
    }
    throw new Error(`too many redirects from ${address}`);
  }

  /** What Caddy's forward_auth would ask the portal before a request to the site. */
  verify(site = SITE, path = "/board"): Promise<Response> {
    return fetch(`${PORTAL}/verifier`, {
      headers: { "X-Portal-Hote": site, "X-Forwarded-Method": "GET", "X-Forwarded-Uri": path, Cookie: this.cookies(site) },
    });
  }
}

function signInAt(site: string, returnTo = "/board"): string {
  return `http://${site}/_portal/oidc?retour=${encodeURIComponent(returnTo)}`;
}

function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${PORTAL}${path}`, init);
}

function share(site: string, policy: object): Promise<Response> {
  return admin(`/admin/sharing/${site}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });
}

async function events(): Promise<{ actor: string; action: string; target: string | null; detail: Record<string, unknown> | null }[]> {
  const body = (await (await admin("/admin/audit?limit=500")).json()) as { events: never[] };
  return body.events;
}

/** How many times the browser went through the provider's sign-in page. */
function providerVisits(visited: string[]): number {
  return visited.filter((url) => url.startsWith(`${provider.url}/authorize`)).length;
}

beforeAll(async () => {
  rmSync(FOLDER, { recursive: true, force: true });
  mkdirSync(FOLDER, { recursive: true });
  provider = await startProvider();
  hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
  // The key the steward would lay for the portal.
  writeFileSync(join(FOLDER, "assertion.key"), encodeKey(pair.privateKey), { mode: 0o600 });
  Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "borrow.ts")], { stdout: "ignore" });
  portal = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "server.ts")], {
    env: {
      ...process.env,
      PORT: String(portalPort),
      DATA_DIR: FOLDER,
      PASSWORD_HASH: hash,
      NODE_ENV: "test",
      PUBLIC_URL: PORTAL,
      OIDC_ISSUER: provider.url,
      OIDC_CLIENT_ID: provider.clientId,
      OIDC_CLIENT_SECRET: provider.clientSecret,
      OIDC_ALLOWED_DOMAINS: "acme.test",
      OIDC_ADMIN_EMAILS: "owner@acme.test",
      OIDC_PROVIDER_NAME: "Acme",
      DASHBOARD_URL: `http://${DASHBOARD}`,
      ASSERTION_KEY_FILE: join(FOLDER, "assertion.key"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${PORTAL}/sante`);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("the portal does not answer");
});

afterAll(() => {
  portal?.kill();
  provider?.stop();
  rmSync(FOLDER, { recursive: true, force: true });
});

beforeEach(async () => {
  provider.next = {};
  await share(SITE, { mode: "admins" });
  await share(OTHER_SITE, { mode: "admins" });
});

describe("signing in with the provider, end to end", () => {
  test("the sign-in page of a protected site offers the provider", async () => {
    const page = await new Browser().verify();
    expect(page.status).toBe(401);
    expect(await page.text()).toInclude('href="/_portal/oidc?retour=%2Fboard"');
  });

  test("an admin email signs in on a site never shared, and the site learns who it is", async () => {
    const browser = new Browser();
    provider.next = { email: "owner@acme.test", name: "Owner Name" };
    const { response, url, visited } = await browser.follow(signInAt(SITE));

    // The way it went: site, portal, provider, portal, site, and the page asked for.
    expect(visited.map((one) => new URL(one).host + new URL(one).pathname)).toEqual([
      `${SITE}/_portal/oidc`,
      `127.0.0.1:${portalPort}/oidc/start`,
      `${new URL(provider.url).host}/authorize`,
      `127.0.0.1:${portalPort}/oidc/callback`,
      `${SITE}/_portal/oidc/complete`,
      `${SITE}/board`,
    ]);
    expect(url).toBe(`http://${SITE}/board`);
    // The last hop is the site itself, which only the portal's 200 lets through.
    expect(response.status).toBe(404);

    const verified = await browser.verify();
    expect(verified.status).toBe(200);
    expect(verified.headers.get("x-sitesolide-user")).toBe("owner@acme.test");
    expect(verified.headers.get("x-sitesolide-role")).toBe("admin");
    expect(decodeURIComponent(verified.headers.get("x-sitesolide-user-name")!)).toBe("Owner Name");

    // The flow's cookies are spent: the binding on the site, the transaction on the portal.
    expect([...(browser.jars.get(SITE)?.keys() ?? [])]).toEqual(["portal"]);
    expect([...(browser.jars.get(`127.0.0.1:${portalPort}`)?.keys() ?? [])]).toEqual(["portal-session"]);

    const recorded = (await events()).find((event) => event.action === "portal.signin" && event.actor === "owner@acme.test");
    expect(recorded).toMatchObject({ target: SITE, detail: { method: "oidc", role: "admin" } });
  });

  test("a person the site is shared with gets in as member, and out at the next request once removed", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    const { url } = await browser.follow(signInAt(SITE));
    expect(url).toBe(`http://${SITE}/board`);

    const verified = await browser.verify();
    expect(verified.status).toBe(200);
    expect(verified.headers.get("x-sitesolide-user")).toBe("alice@acme.test");
    expect(verified.headers.get("x-sitesolide-role")).toBe("member");

    await share(SITE, { mode: "people", people: [] });
    const refused = await browser.verify();
    expect(refused.status).toBe(401);
    expect(await refused.text()).toInclude("You are signed in as alice@acme.test, but this site isn&#39;t shared with you.");

    const audit = await events();
    expect(audit[0]).toMatchObject({ actor: "owner", action: "sharing.update", target: SITE, detail: { peopleRemoved: ["alice@acme.test"] } });
  });

  test("everyone at the domain gets in when the site is shared with it", async () => {
    await share(SITE, { mode: "domain", domains: ["acme.test"] });
    const browser = new Browser();
    provider.next = { email: "bob@acme.test" };
    await browser.follow(signInAt(SITE));
    expect((await browser.verify()).headers.get("x-sitesolide-user")).toBe("bob@acme.test");
  });

  test("someone the site is not shared with is told so, and gets no cookie", async () => {
    const browser = new Browser();
    const { response, url } = await browser.follow(signInAt(SITE));
    expect(url).toStartWith(`http://${SITE}/_portal/oidc/complete`);
    expect(response.status).toBe(403);
    const page = await response.text();
    expect(page).toInclude("alice@acme.test");
    expect(page).toInclude("account=choose");
    expect(browser.cookie(SITE, "portal")).toBeUndefined();
    expect((await events())[0]).toMatchObject({ actor: "alice@acme.test", action: "portal.signin_failed", detail: { reason: "not-shared" } });
  });

  test("the next site skips the provider: the portal remembers who signed in", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    await share(OTHER_SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    expect(providerVisits((await browser.follow(signInAt(SITE))).visited)).toBe(1);
    const second = await browser.follow(signInAt(OTHER_SITE, "/team"));
    expect(providerVisits(second.visited)).toBe(0);
    expect(second.url).toBe(`http://${OTHER_SITE}/team`);
    expect((await browser.verify(OTHER_SITE)).headers.get("x-sitesolide-user")).toBe("alice@acme.test");
  });

  test("another account goes back through the provider and asks which one", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test", "bob@acme.test"] });
    const browser = new Browser();
    await browser.follow(signInAt(SITE));
    provider.next = { email: "bob@acme.test" };
    const again = await browser.follow(`http://${SITE}/_portal/oidc?retour=%2F&account=choose`);
    const authorize = again.visited.find((url) => url.startsWith(`${provider.url}/authorize`))!;
    expect(new URL(authorize).searchParams.get("prompt")).toBe("select_account");
    expect((await browser.verify()).headers.get("x-sitesolide-user")).toBe("bob@acme.test");
  });

  test("a return path that leads elsewhere comes back to the site's home", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const { url } = await new Browser().follow(signInAt(SITE, "//evil.test/x"));
    expect(url).toBe(`http://${SITE}/`);
  });
});

describe("signing in to the dashboard, end to end", () => {
  const json = { "Content-Type": "application/json" };

  /** What the dashboard does on a click: draw a binding, have the portal seal the flow, send the browser to it. */
  async function begin(browser: Browser, chooseAccount = false, reauth = false): Promise<{ binding: string; url: string; visited: string[] }> {
    const binding = drawBinding();
    const sealed = await admin("/admin/dashboard/flow", { method: "POST", headers: json, body: JSON.stringify({ binding, returnTo: "/activity/", chooseAccount, reauth }) });
    expect(sealed.status).toBe(200);
    const { start } = (await sealed.json()) as { start: string };
    const { url, visited } = await browser.follow(start);
    return { binding, url, visited };
  }

  function redeem(code: string | null, binding: string | null): Promise<Response> {
    return admin("/admin/dashboard/redeem", { method: "POST", headers: json, body: JSON.stringify({ code, binding }) });
  }

  test("the provider, then back to the dashboard with a code redeemed for a signed assertion", async () => {
    const browser = new Browser();
    provider.next = { email: "alice@acme.test", name: "Alice Martin" };
    const { binding, url, visited } = await begin(browser);
    expect(visited.map((one) => new URL(one).host + new URL(one).pathname)).toEqual([
      `127.0.0.1:${portalPort}/oidc/start`,
      `${new URL(provider.url).host}/authorize`,
      `127.0.0.1:${portalPort}/oidc/callback`,
      `${DASHBOARD}/api/sso/complete`,
    ]);
    const code = new URL(url).searchParams.get("code");

    const answer = await redeem(code, binding);
    expect(answer.status).toBe(200);
    const { assertion } = (await answer.json()) as { assertion: string };
    const reading = await verifyAssertion(assertion, pair.publicKey, { audience: DASHBOARD_AUDIENCE, nowS: Math.floor(Date.now() / 1000) });
    expect("claims" in reading && reading.claims).toMatchObject({ email: "alice@acme.test", name: "Alice Martin", aud: "dashboard" });

    // Once: the same code again is unknown, and recorded nowhere.
    const before = await events();
    expect(await (await redeem(code, binding)).json()).toMatchObject({ error: "unknown-code" });
    expect(await events()).toEqual(before);
  });

  test("a code is redeemed only with the binding of the browser that began", async () => {
    const { url } = await begin(new Browser());
    const refused = await redeem(new URL(url).searchParams.get("code"), drawBinding());
    expect(refused.status).toBe(400);
    expect((await events())[0]).toMatchObject({ action: "portal.signin_failed", target: DASHBOARD, detail: { reason: "wrong-browser" } });
  });

  test("a dashboard's code signs nobody in on a site", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    const { url } = await begin(browser);
    const code = new URL(url).searchParams.get("code")!;
    const response = await browser.get(`http://${SITE}/_portal/oidc/complete?code=${code}`);
    expect(response.status).toBe(400);
    expect(browser.cookie(SITE, "portal")).toBeUndefined();
    expect((await events())[0]).toMatchObject({ action: "portal.signin_failed", target: SITE, detail: { reason: "wrong-audience" } });
  });

  test("the portal's session spares the provider for the next sign-in, unless another account is asked for", async () => {
    const browser = new Browser();
    expect(providerVisits((await begin(browser)).visited)).toBe(1);
    expect(providerVisits((await begin(browser)).visited)).toBe(0);
    const chosen = await begin(browser, true);
    const authorize = chosen.visited.find((one) => one.startsWith(`${provider.url}/authorize`))!;
    expect(new URL(authorize).searchParams.get("prompt")).toBe("select_account");
  });

  test("a forced sign-in skips the portal's session, asks the provider for one, and signs an assertion that says so", async () => {
    const browser = new Browser();
    const first = await begin(browser);
    const plain = await verifyAssertion(
      ((await (await redeem(new URL(first.url).searchParams.get("code"), first.binding)).json()) as { assertion: string }).assertion,
      pair.publicKey,
      { audience: DASHBOARD_AUDIENCE, nowS: Math.floor(Date.now() / 1000) },
    );
    expect("claims" in plain && plain.claims.reauth).toBe(false);

    // The portal's session would spare the provider: a forced sign-in goes there all the same.
    const forced = await begin(browser, false, true);
    expect(providerVisits(forced.visited)).toBe(1);
    const authorize = new URL(forced.visited.find((one) => one.startsWith(`${provider.url}/authorize`))!).searchParams;
    expect(authorize.get("prompt")).toBe("login");
    expect(authorize.get("max_age")).toBe("0");
    const answer = await redeem(new URL(forced.url).searchParams.get("code"), forced.binding);
    const body = (await answer.json()) as { assertion: string; reauth: boolean };
    expect(body.reauth).toBe(true);
    const reading = await verifyAssertion(body.assertion, pair.publicKey, { audience: DASHBOARD_AUDIENCE, nowS: Math.floor(Date.now() / 1000) });
    expect("claims" in reading && reading.claims.reauth).toBe(true);
    expect("claims" in reading && Math.floor(Date.now() / 1000) - reading.claims.auth_time).toBeLessThan(5);
  });

  test("a provider that ignores the forced sign-in, or does not say when, mints no code", async () => {
    for (const next of [{ claims: { auth_time: Math.floor(Date.now() / 1000) - 3600 } }, { without: ["auth_time"] }]) {
      provider.next = next;
      const { url } = await begin(new Browser(), false, true);
      expect(new URL(url).pathname).toBe("/oidc/callback");
      expect((await events())[0]).toMatchObject({ actor: "alice@acme.test", action: "portal.signin_failed", target: DASHBOARD, detail: { reason: "stale-authentication" } });
    }
  });

  test("a site's flow cannot carry a forced sign-in", async () => {
    const response = await admin("/admin/dashboard/flow", { method: "POST", headers: json, body: JSON.stringify({ binding: drawBinding(), returnTo: "/", reauth: "yes" }) });
    expect(response.status).toBe(400);
  });

  test("an account the portal does not admit never reaches the dashboard", async () => {
    provider.next = { email: "eve@elsewhere.test" };
    const { url } = await begin(new Browser());
    expect(new URL(url).pathname).toBe("/oidc/callback");
    expect((await events())[0]).toMatchObject({ actor: "eve@elsewhere.test", target: DASHBOARD, detail: { reason: "domain-not-allowed" } });
  });
});

describe("what the provider sends back, refused", () => {
  /** A sign-in that stops at the callback, and what it left behind. */
  async function refusedAtCallback(): Promise<{ response: Response; browser: Browser }> {
    const browser = new Browser();
    const { response, url } = await browser.follow(signInAt(SITE));
    expect(new URL(url).pathname).toBe("/oidc/callback");
    expect(browser.cookie(`127.0.0.1:${portalPort}`, "portal-session")).toBeUndefined();
    expect(browser.cookie(SITE, "portal")).toBeUndefined();
    return { response, browser };
  }

  test("a token signed by a key the provider does not publish", async () => {
    provider.next = { signer: await makeSigner("RS256", "key-1") };
    expect((await refusedAtCallback()).response.status).toBe(403);
    expect((await events())[0]).toMatchObject({ action: "portal.signin_failed", detail: { method: "oidc", reason: "bad-signature" } });
  });

  test("a token for another client", async () => {
    provider.next = { claims: { aud: "another-client" } };
    expect((await refusedAtCallback()).response.status).toBe(403);
    expect((await events())[0]!.detail).toMatchObject({ reason: "wrong-audience" });
  });

  test("an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    provider.next = { claims: { iat: past - 300, exp: past } };
    expect((await refusedAtCallback()).response.status).toBe(403);
    expect((await events())[0]!.detail).toMatchObject({ reason: "expired" });
  });

  test("a token carrying another nonce, a replayed one for instance", async () => {
    provider.next = { claims: { nonce: "a-nonce-from-another-flow" } };
    expect((await refusedAtCallback()).response.status).toBe(403);
    expect((await events())[0]!.detail).toMatchObject({ reason: "wrong-nonce" });
  });

  test("an email the provider did not verify", async () => {
    provider.next = { claims: { email_verified: false } };
    const { response } = await refusedAtCallback();
    expect(response.status).toBe(403);
    expect(await response.text()).toInclude("didn&#39;t confirm this account&#39;s email address");
    expect((await events())[0]!.detail).toMatchObject({ reason: "unverified-email" });
  });

  test("an email from a domain that is not allowed, named in the audit", async () => {
    provider.next = { email: "eve@elsewhere.test" };
    const { response } = await refusedAtCallback();
    expect(response.status).toBe(403);
    expect(await response.text()).toInclude(`Back to ${SITE}`);
    expect((await events())[0]).toMatchObject({ actor: "eve@elsewhere.test", detail: { reason: "domain-not-allowed" } });
  });

  test("a sign-in the person cancelled at the provider", async () => {
    provider.next = { error: "access_denied" };
    const { response } = await refusedAtCallback();
    expect(await response.text()).toInclude("cancelled or refused");
  });
});

describe("the flow's defences", () => {
  test("a callback opened in another browser finds no transaction: login CSRF refused", async () => {
    // The attacker signs in at the provider and stops before the callback,
    // then sends the victim the address.
    const attacker = new Browser();
    let url = signInAt(SITE);
    for (let i = 0; i < 3; i++) url = new URL((await attacker.get(url)).headers.get("location")!, url).toString();
    expect(new URL(url).pathname).toBe("/oidc/callback");

    const victim = new Browser();
    const response = await victim.get(url);
    expect(response.status).toBe(400);
    expect(victim.cookie(`127.0.0.1:${portalPort}`, "portal-session")).toBeUndefined();
  });

  test("a callback replayed by the browser that made it finds nothing the second time", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    const { visited } = await browser.follow(signInAt(SITE));
    const callback = visited.find((one) => one.includes("/oidc/callback"))!;
    expect((await browser.get(callback)).status).toBe(400);
  });

  test("a handoff code works once, then it is gone", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    const { visited } = await browser.follow(signInAt(SITE));
    const complete = visited.find((one) => one.includes("/_portal/oidc/complete"))!;
    const before = await events();
    const replay = await browser.get(complete);
    expect(replay.status).toBe(400);
    // A code the portal does not know is noise, and is not recorded: anyone
    // can send one. The audit is as the sign-in left it.
    expect(await events()).toEqual(before);
  });


  test("a handoff code sent to someone else's browser signs nobody in: session fixation refused", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const attacker = new Browser();
    let url = signInAt(SITE);
    for (let i = 0; i < 4; i++) url = new URL((await attacker.get(url)).headers.get("location")!, url).toString();
    expect(new URL(url).pathname).toBe("/_portal/oidc/complete");

    const victim = new Browser();
    const response = await victim.get(url);
    expect(response.status).toBe(400);
    expect(victim.cookie(SITE, "portal")).toBeUndefined();
    expect((await events())[0]!.detail).toMatchObject({ reason: "wrong-browser" });
    // Burnt: the attacker cannot use it after the victim's attempt either.
    expect((await attacker.get(url)).status).toBe(400);
  });

  test("a handoff code carried to another site is refused there, and burnt", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    await share(OTHER_SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    let url = signInAt(SITE);
    for (let i = 0; i < 4; i++) url = new URL((await browser.get(url)).headers.get("location")!, url).toString();
    const elsewhere = url.replace(SITE, OTHER_SITE);
    // The binding cookie is the site's own: copy it, the host still decides.
    browser.jars.set(OTHER_SITE, new Map(browser.jars.get(SITE)));
    expect((await browser.get(elsewhere)).status).toBe(400);
    expect((await events())[0]!.detail).toMatchObject({ reason: "wrong-host" });
    expect((await browser.get(url)).status).toBe(400);
  });

  test("a flow forged or altered on the way to the portal is refused before the provider", async () => {
    const browser = new Browser();
    const start = new URL((await browser.get(signInAt(SITE))).headers.get("location")!);
    const [payload, signature] = start.searchParams.get("flow")!.split(".");
    const fields = JSON.parse(Buffer.from(payload!, "base64url").toString());
    fields.h = "bank.localhost";
    start.searchParams.set("flow", `${Buffer.from(JSON.stringify(fields)).toString("base64url")}.${signature}`);
    const response = await browser.get(start.toString());
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  test("on the portal's own host a forged X-Portal-Hote changes nothing: the sealed flow names the site", async () => {
    // Caddy does not overwrite that header on the portal's own block, so the
    // visitor chooses it there. The two steps must never read it.
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    const forged = { "X-Portal-Hote": "bank.localhost" };
    let url = new URL((await browser.get(signInAt(SITE))).headers.get("location")!).toString();
    url = new URL((await browser.get(url, forged)).headers.get("location")!, url).toString();
    url = new URL((await browser.get(url)).headers.get("location")!, url).toString();
    const toSite = new URL((await browser.get(url, forged)).headers.get("location")!);
    expect(toSite.host).toBe(SITE);
    expect(toSite.pathname).toBe("/_portal/oidc/complete");
  });

  test("an issuer named in the callback must be the configured one", async () => {
    const browser = new Browser();
    let url = signInAt(SITE);
    for (let i = 0; i < 3; i++) url = new URL((await browser.get(url)).headers.get("location")!, url).toString();
    const mixedUp = new URL(url);
    mixedUp.searchParams.set("iss", "https://another-provider.test-zone.invalid");
    expect((await browser.get(mixedUp.toString())).status).toBe(403);
    expect((await events())[0]!.detail).toMatchObject({ reason: "wrong-issuer" });
  });

  test("the password still works beside the provider, and names nobody", async () => {
    const browser = new Browser();
    const response = await fetch(`${PORTAL}/_portal/connexion`, {
      method: "POST",
      headers: { "X-Portal-Hote": SITE, Origin: `http://${SITE}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ motdepasse: PASSWORD, retour: "/" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    browser.keep(SITE, response);
    const verified = await browser.verify();
    expect(verified.headers.get("x-sitesolide-role")).toBe("admin");
    expect(verified.headers.get("x-sitesolide-user")).toBeNull();
  });
});

describe("what a session, a flow and a sign-out may still do", () => {
  const PORTAL_HOST = `127.0.0.1:${portalPort}`;

  /** The portal's key, as the server derived it: the tests own its data folder and its hash. */
  function portalKey(): Uint8Array {
    return deriveKey(new Uint8Array(readFileSync(join(FOLDER, "key"))), hash)!;
  }

  /** The portal's start address of a fresh flow for this site. */
  async function startOf(browser: Browser, site = SITE): Promise<string> {
    return new URL((await browser.get(signInAt(site))).headers.get("location")!).toString();
  }

  function maxAge(response: Response, name: string): number | null {
    const cookie = response.headers.getSetCookie().find((one) => one.startsWith(`${name}=`));
    const match = cookie?.match(/Max-Age=(\d+)/);
    return match === undefined || match === null ? null : Number(match[1]);
  }

  async function signOutOf(browser: Browser, site: string): Promise<Response> {
    const response = await fetch(`${PORTAL}/_portal/deconnexion`, {
      method: "POST",
      headers: { "X-Portal-Hote": site, Origin: `http://${site}`, Cookie: browser.cookies(site) },
      redirect: "manual",
    });
    browser.keep(site, response);
    return response;
  }

  /** Follows a sign-in up to the site's last step, and gives that step's answer. */
  async function completion(browser: Browser, site = SITE): Promise<Response> {
    let address = signInAt(site);
    for (let i = 0; i < 6; i++) {
      const answer = await browser.get(address);
      if (new URL(address).pathname === "/_portal/oidc/complete") return answer;
      address = new URL(answer.headers.get("location")!, address).toString();
    }
    throw new Error("the sign-in never reached the site");
  }

  test("a site's cookie never outlives the portal session that vouched for the person", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    // Through the provider, the session is new: a day for the site.
    expect(maxAge(await completion(new Browser()), "portal")).toBe(IDENTITY_DURATION_S);

    // Through a session with two minutes left: two minutes, not a day.
    // Otherwise someone disabled at the provider kept every site for up to two
    // days, the session's day and then the last site's.
    const browser = new Browser();
    const nowS = Math.floor(Date.now() / 1000);
    const session = issueSession(portalKey(), { email: "alice@acme.test", name: null }, nowS - IDENTITY_DURATION_S + 120);
    browser.jars.set(PORTAL_HOST, new Map([["portal-session", session]]));
    const response = await completion(browser);
    expect(response.status).toBe(303);
    const age = maxAge(response, "portal")!;
    expect(age).toBeGreaterThan(100);
    expect(age).toBeLessThanOrEqual(120);
    // The token says the same as the cookie: the gate refuses it past then.
    const expiry = Number(browser.cookie(SITE, "portal")!.split(".")[0]);
    expect(expiry).toBeLessThanOrEqual(nowS + 121);
  });

  test("a flow replayed with a portal session mints no second code", async () => {
    // One account replaying one flow used to fill every code in flight, and
    // block every sign-in on every site.
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    await browser.follow(signInAt(SITE));
    const start = await startOf(browser);
    expect((await browser.get(start)).status).toBe(303);
    const replayed = await browser.get(start);
    expect(replayed.status).toBe(400);
    expect(replayed.headers.get("location")).toBeNull();
    expect(await replayed.text()).toInclude("already used");
  });

  test("one account holds ten codes in flight at most", async () => {
    provider.next = { email: "carol@acme.test" };
    const browser = new Browser();
    await browser.follow(signInAt(SITE));
    const starts: string[] = [];
    for (let i = 0; i <= HANDOFF_PER_EMAIL; i++) starts.push(await startOf(browser));
    // The first sign-in's code was redeemed: ten more may wait, not eleven.
    for (const start of starts.slice(0, HANDOFF_PER_EMAIL)) expect((await browser.get(start)).status).toBe(303);
    expect((await browser.get(starts.at(-1)!)).status).toBe(503);
    // Someone else is not held back.
    const other = new Browser();
    const { url } = await other.follow(signInAt(SITE));
    expect(url).not.toInclude("/oidc/start");
  });

  test("signing out of a site ends the portal's session too, and the next sign-in asks which account", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test", "bob@acme.test"] });
    await share(OTHER_SITE, { mode: "people", people: ["alice@acme.test", "bob@acme.test"] });
    const browser = new Browser();
    await browser.follow(signInAt(SITE));
    expect(browser.cookie(PORTAL_HOST, "portal-session")).toBeDefined();

    // The site's answer is a page that goes on to the portal's host on its own.
    const signedOut = await signOutOf(browser, SITE);
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("x-portal")).toBe("connexion");
    expect(browser.cookie(SITE, "portal")).toBeUndefined();
    const page = await signedOut.text();
    const next = page.match(/<meta http-equiv="refresh" content="0; url=([^"]+)">/)![1]!.replaceAll("&amp;", "&");
    expect(next).toStartWith(`${PORTAL}/oidc/signout?ticket=`);
    expect(page).toInclude(`href="${next}"`);

    // The portal's host ends its session and sends the browser back to the site.
    const back = await browser.get(next);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`http://${SITE}/`);
    expect(browser.cookie(PORTAL_HOST, "portal-session")).toBeUndefined();
    expect(browser.cookie(PORTAL_HOST, "portal-signed-out")).toBe("1");

    // The next person at this computer clicking "Sign in with" goes to the
    // provider, which is told to ask which account, even on another site.
    provider.next = { email: "bob@acme.test" };
    const again = await browser.follow(signInAt(OTHER_SITE, "/team"));
    const authorize = again.visited.find((url) => url.startsWith(`${provider.url}/authorize`));
    expect(authorize).toBeDefined();
    expect(new URL(authorize!).searchParams.get("prompt")).toBe("select_account");
    expect((await browser.verify(OTHER_SITE)).headers.get("x-sitesolide-user")).toBe("bob@acme.test");

    // Signed in again: no longer signed out, and the next site skips the provider.
    expect(browser.cookie(PORTAL_HOST, "portal-signed-out")).toBeUndefined();
    expect(providerVisits((await browser.follow(signInAt(SITE))).visited)).toBe(0);
  });

  test("a sign-out link forged, expired or replayed elsewhere signs nobody out", async () => {
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });
    const browser = new Browser();
    await browser.follow(signInAt(SITE));
    for (const ticket of ["", "forged.ticket", "eyJoIjoiYmFuay5sb2NhbGhvc3QiLCJlIjo5OTk5OTk5OTk5fQ.AAAA"]) {
      const response = await browser.get(`${PORTAL}/oidc/signout?${new URLSearchParams({ ticket })}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
    expect(browser.cookie(PORTAL_HOST, "portal-session")).toBeDefined();
  });
});

describe("what the audit hands to the dashboard", () => {
  test("no row carries a password, the client secret, a code, a verifier or a cookie", async () => {
    // One of each on top of everything above: a password sign-in and a wrong
    // one, a provider's sign-in and a refused one, a sharing change.
    const WRONG = "a-wrong-password-for-the-audit-test";
    const signIn = (password: string) =>
      fetch(`${PORTAL}/_portal/connexion`, {
        method: "POST",
        headers: { "X-Portal-Hote": SITE, Origin: `http://${SITE}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ motdepasse: password, retour: "/" }),
        redirect: "manual",
      });
    const owner = new Browser();
    owner.keep(SITE, await signIn(PASSWORD));
    await signIn(WRONG);
    const member = new Browser();
    provider.next = { email: "owner@acme.test" };
    await member.follow(signInAt(SITE));
    provider.next = { email: "eve@elsewhere.test" };
    await new Browser().follow(signInAt(SITE));
    await share(SITE, { mode: "people", people: ["alice@acme.test"] });

    // Every row the dashboard can read, page after page, as the Activity page does.
    const rows: unknown[] = [];
    let before: number | null = null;
    for (;;) {
      const query: string = before === null ? "limit=500" : `limit=500&before=${before}`;
      const page = ((await (await admin(`/admin/audit?${query}`)).json()) as { events: { id: number }[] }).events;
      rows.push(...page);
      if (page.length < 500) break;
      before = page.at(-1)!.id;
    }
    const handed = JSON.stringify(rows);
    expect(handed).toInclude("portal.signin_failed");
    expect(handed).toInclude("sharing.update");

    const codes = provider.tokenRequests.flatMap((request) => [request.body.get("code"), request.body.get("code_verifier")]);
    const cookies = [owner, member].flatMap((browser) => [...browser.jars.values()].flatMap((jar) => [...jar.values()]));
    const forbidden = [PASSWORD, WRONG, hash, provider.clientSecret, ...codes, ...cookies].filter((value): value is string => typeof value === "string" && value.length >= 8);
    expect(forbidden.length).toBeGreaterThan(4);
    for (const value of forbidden) expect(handed).not.toInclude(value);
  });
});

// Last, on purpose: the bound it reaches holds for the rest of the minute on
// that host, and would hide the failures the tests above read.
describe("the audit under a flood", () => {
  test("a stranger making sign-ins fail writes a bounded number of rows", async () => {
    // Thirty per minute: seventy attempts stay above what two minutes allow,
    // should the flood straddle the turn of one.
    const before = (await events()).length;
    for (let i = 0; i < 70; i++) {
      provider.next = { email: "eve@elsewhere.test" };
      await new Browser().follow(signInAt(OTHER_SITE));
    }
    const recorded = (await events()).length - before;
    expect(recorded).toBeLessThanOrEqual(60);
    expect(recorded).toBeGreaterThan(0);
  });
});
