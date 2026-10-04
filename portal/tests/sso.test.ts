import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
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
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
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
    const replay = await browser.get(complete);
    expect(replay.status).toBe(400);
    // A code the portal does not know is noise, and is not recorded: anyone
    // can send one. The last event is still the sign-in.
    expect((await events())[0]).toMatchObject({ action: "portal.signin", actor: "alice@acme.test" });
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
