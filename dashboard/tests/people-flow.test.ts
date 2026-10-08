import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjection, type Role } from "../borrowed/access";
import { readPrivateKey, signAssertion } from "../borrowed/assertion";
import { createAccessSystem } from "../src/access/system";
import { INSTALLER_TEMPLATE } from "../src/control/protocol";
import { createControlSteward, isControlPath, type ControlHandler } from "../src/control/steward";
import { createControlSystem } from "../src/control/system";
import type { PortalAdmin } from "../src/people/portal";
import { createMembersSystem } from "../src/people/system";
import { createSteward, type StewardHandler } from "../src/secrets/steward";
import { createSystem, type Command } from "../src/secrets/system";

/**
 * A person's whole road through the real dashboard: its own server.ts in a
 * process of its own, the steward's real routes on a real Unix socket, the
 * real access registry on a throwaway tree, and a portal of the tests' making
 * on a port, which signs its assertions with the key the steward laid, as the
 * real one does. Who holds which role is given by the owner over the owner's
 * socket, as `sitesolide share` and `sitesolide people` do.
 *
 * The test is the browser: a cookie jar, the redirects followed by hand. The
 * portal's own side of the flow, the provider included, is tested through real
 * HTTP in portal/tests/sso.test.ts; here it signs in at once whoever the test
 * chose.
 */

const PASSWORD = "Owner-Password-For-The-Flow-1";
const SECRET_VALUE = "a-value-only-a-project-admin-reads-1";
const ZONE = "test-zone.invalid";
const ALICE = "alice@acme.test";

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

let root: string;
let steward: StewardHandler;
/** The control routes beside it, as dashboard/steward.ts mounts them: tokens, a person's own included. */
let control: ControlHandler;
/** What the steward asked of the installer: the requests it wrote. */
const installs: string[] = [];
let socketServer: ReturnType<typeof Bun.serve>;
let portalServer: ReturnType<typeof Bun.serve>;
let dashboard: ReturnType<typeof Bun.spawn>;
const restarts: string[] = [];
const dashboardPort = freePort();
const DASHBOARD = `http://127.0.0.1:${dashboardPort}`;
let PORTAL = "";

/**
 * Who the portal signs in next, as the provider would after the person typed
 * their password; `ignoreReauth`, a provider that does not sign them in again
 * when asked, and the portal that then says nothing of a forced sign-in.
 */
const next = { email: ALICE, ignoreReauth: false };

/** The portal's side, reduced to what the dashboard and the steward see of it. */
function startPortal(): ReturnType<typeof Bun.serve> {
  const flows = new Map<string, { binding: string; returnTo: string; reauth: boolean }>();
  const codes = new Map<string, { binding: string; returnTo: string; email: string; reauth: boolean }>();
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      // How people sign in, which the dashboard reads; who may open a site is no longer the portal's.
      "/admin/sharing": () => Response.json({ sso: { configured: true, providerName: "Acme", allowedDomains: ["acme.test"], admins: [], portalUrl: PORTAL }, sites: [] }),
      // What the steward asks through its relay: the portal reads the steward's projection.
      "/admin/access": () => Response.json({ reading: "steward", writtenAt: Date.now() }),
      "/admin/audit": () => Response.json({ events: [] }),
      "/admin/dashboard/flow": {
        POST: async (req) => {
          const body = (await req.json()) as { binding: string; returnTo: string; reauth?: boolean };
          const id = crypto.randomUUID();
          flows.set(id, { binding: body.binding, returnTo: body.returnTo, reauth: body.reauth === true });
          return Response.json({ start: `${PORTAL}/oidc/start?flow=${id}` });
        },
      },
      "/oidc/start": (req) => {
        const flow = flows.get(new URL(req.url).searchParams.get("flow") ?? "");
        if (flow === undefined) return new Response("unknown flow", { status: 400 });
        const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
        codes.set(code, { ...flow, email: next.email, reauth: flow.reauth && !next.ignoreReauth });
        return new Response(null, { status: 303, headers: { Location: `${DASHBOARD}/api/sso/complete?code=${code}` } });
      },
      "/admin/dashboard/redeem": {
        POST: async (req) => {
          const body = (await req.json()) as { code: string; binding: string };
          const minted = codes.get(body.code);
          codes.delete(body.code);
          if (minted === undefined || minted.binding !== body.binding) return Response.json({ error: "wrong-browser" }, { status: 400 });
          const key = readPrivateKey(readFileSync(join(root, "portal-key", "assertion.key"), "utf8"))!;
          const nowS = Math.floor(Date.now() / 1000);
          // A sign-in rides on an older proof; a forced one is fresh, and says so.
          const assertion = await signAssertion(key, { email: minted.email, name: null, authTime: minted.reauth ? nowS : nowS - 3600, reauth: minted.reauth }, nowS);
          return Response.json({ assertion, returnTo: minted.returnTo, reauth: minted.reauth });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
}

/** The steward's relay to the portal, as a function of the portal's port: root's road, not the dashboard's. */
function relayTo(url: () => string): PortalAdmin {
  return { access: () => fetch(`${url()}/admin/access`) };
}

class Browser {
  jar = new Map<string, string>();

  cookies(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  keep(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";").map((part) => part.trim());
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator);
      const value = pair!.slice(separator + 1);
      if (attributes.includes("Max-Age=0") || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  /**
   * Only the dashboard's cookies are kept: the portal's host has its own,
   * which this portal does not use. The way back from the provider is a
   * cross-site navigation, as with a real provider on another domain: the
   * session cookie, `SameSite=Strict`, does not travel with it, the binding,
   * `Lax`, does.
   */
  async get(url: string): Promise<Response> {
    const ours = url.startsWith(DASHBOARD);
    const crossSite = ours && new URL(url).pathname === "/api/sso/complete";
    const cookie = crossSite ? [...this.jar.entries()].filter(([name]) => name === "sso").map(([name, value]) => `${name}=${value}`).join("; ") : this.cookies();
    const response = await fetch(url, { redirect: "manual", headers: ours ? { Cookie: cookie } : {} });
    if (ours) this.keep(response);
    return response;
  }

  /** Follows the redirects; a dashboard page itself, which Caddy would serve from public/, ends the road. */
  async follow(url: string): Promise<string> {
    let current = url;
    for (let i = 0; i < 10; i++) {
      if (current.startsWith(DASHBOARD) && !new URL(current).pathname.startsWith("/api/")) return current;
      const response = await this.get(current);
      const location = response.headers.get("location");
      if (location === null) return current;
      current = new URL(location, current).toString();
    }
    throw new Error("too many redirects");
  }

  api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return fetch(`${DASHBOARD}${path}`, {
      method: init.method ?? "GET",
      headers: { Cookie: this.cookies(), Origin: DASHBOARD, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }
}

async function signInAs(email: string, returnTo = "/"): Promise<{ browser: Browser; landed: string }> {
  next.email = email;
  next.ignoreReauth = false;
  const browser = new Browser();
  const landed = await browser.follow(`${DASHBOARD}/api/sso/begin?return=${encodeURIComponent(returnTo)}`);
  return { browser, landed };
}

/** A person's unlock: the dashboard sends them through a forced sign-in, and back where they were. */
async function unlockAs(browser: Browser, email: string, returnTo = "/site/secrets/?s=blog"): Promise<string> {
  next.email = email;
  return browser.follow(`${DASHBOARD}/api/sso/begin?reauth=1&return=${encodeURIComponent(returnTo)}`);
}

const asRoot = (method: string, path: string, body?: unknown) =>
  steward.owner(new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

/** Roles given by the owner, over the owner's socket, as `sitesolide share` gives them. */
async function give(email: string, roles: Record<string, Role>): Promise<void> {
  for (const [slug, role] of Object.entries(roles)) {
    const response = await asRoot("PUT", "/access/entry", { slug, who: email, role });
    expect([email, slug, response.status < 300]).toEqual([email, slug, true]);
  }
}

/** Someone taken off every project by the owner, as `sitesolide people --remove` does. */
async function takeOff(email: string): Promise<void> {
  expect((await asRoot("DELETE", "/people/person", { email })).status).toBe(200);
}

/** The portal's projection, as the steward laid it beside the assertion key. */
function projection() {
  const read = readProjection(readFileSync(join(root, "portal-key", "access.json"), "utf8"));
  if ("unreadable" in read) throw new Error(read.unreadable);
  return read;
}

function folder(name: string): string {
  mkdirSync(join(root, name), { recursive: true });
  return join(root, name);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "members-flow-"));
  const sites = folder("sites");
  const secrets = folder("secrets");
  const units = folder("units");
  const state = folder("state");
  const data = folder("data");
  folder("portal-key");
  const app = (slug: string, port: number, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(sites, slug), { recursive: true });
    const manifest = { slug, start: "/usr/local/bin/bun run server.ts", port, publicDir: "public", secrets: [`${slug}.env`], ...extra };
    writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify(manifest));
    writeFileSync(join(units, `${slug}.service`), "[Service]\nExecStart=/usr/local/bin/bun run server.ts\n");
    writeFileSync(join(secrets, `${slug}.env`), `API_KEY=${SECRET_VALUE}\n`, { mode: 0o600 });
    return manifest;
  };
  const manifests = [app("blog", 3040), app("shop", 3041, { portal: true }), app("secret-project", 3042)];
  // shop's block carries the portal: its general access is restricted.
  const guarded = "shop.{$SITESOLIDE_ZONE} {\n\tforward_auth @portal_guard 127.0.0.1:3026 {\n\t\turi /verifier\n\t}\n}\n";
  writeFileSync(join(folder("caddy"), "shop.caddy"), guarded);
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "portal.env"), "OIDC_ISSUER=https://login.test-zone.invalid\nOIDC_CLIENT_ID=c\nOIDC_CLIENT_SECRET=s\nOIDC_ALLOWED_DOMAINS=acme.test\n", { mode: 0o600 });

  // The collector's reading, as the dashboard reads it.
  writeFileSync(
    join(data, "state.json"),
    JSON.stringify({
      generated: Date.now(),
      zone: ZONE,
      folders: manifests.map((manifest) => ({ slug: manifest.slug, manifest: JSON.stringify(manifest), unit: { ActiveState: "active", SubState: "running" }, bytes: 1, deployed: 1 })),
      codes: null,
      domains: null,
      ports: [],
      blocks: { shop: guarded },
      machine: { memoryTotal: 1, memoryAvailable: 1, diskTotal: 1, diskFree: 1, load1: 0, load5: 0, load15: 0, cores: 1 },
      previous: null,
    }),
  );

  const real = createSystem({
    sitesDir: sites,
    secretsFolder: secrets,
    unitsFolder: units,
    stateFolder: state,
    hashFile: join(secrets, "dashboard.env"),
    accountsFile: join(root, "passwd"),
    caddyFolder: join(root, "caddy"),
    gatekeeperFolder: folder("gatekeeper"),
    systemctl: "/path/that/does/not/exist",
  });
  let clock = Date.now();
  steward = createSteward(
    {
      ...real,
      now: () => Math.max(clock, Date.now()),
      wait: async (ms) => {
        clock = Math.max(clock, Date.now()) + ms;
      },
      systemctl: async (arguments_): Promise<Command> => {
        if (arguments_[0] === "restart") restarts.push(arguments_[1]!);
        if (arguments_[0] === "show") return { code: 0, output: "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=\n" };
        return { code: 0, output: "" };
      },
    },
    {
      secretsFolder: secrets,
      checkAccounts: false,
      members: {
        system: createMembersSystem({ stateFolder: state, sitesDir: sites, secretsFolder: secrets, portalKeyFolder: join(root, "portal-key"), groupsFile: join(root, "group"), portalGroup: "" }),
        access: createAccessSystem({ stateFolder: state, portalKeyFolder: join(root, "portal-key"), groupsFile: join(root, "group"), portalGroup: "", portalDataFolder: join(root, "portal-data") }, false),
        zone: ZONE,
        portal: relayTo(() => PORTAL),
        revokeTokens: (email, actor) => control.revokeMember(email, actor),
      },
    },
  );
  await steward.ensureMemberKeys();
  // The registry made before anything asks, as the entry point starts it.
  await steward.startAccess();
  writeFileSync(join(units, INSTALLER_TEMPLATE), "[Service]\n");
  control = createControlSteward(
    {
      ...createControlSystem({ stateFolder: state, sitesDir: sites, unitsFolder: units, installerFolder: folder("installer"), systemctl: "/bin/false", journalctl: "/bin/false" }),
      systemctl: async (arguments_) => {
        if (arguments_[0] === "start") installs.push(arguments_.at(-1)!);
        return arguments_[0] === "is-active" ? { code: 3, output: "inactive\n" } : { code: 0, output: "" };
      },
    },
    { zone: ZONE, isUnlocked: steward.isUnlocked, uidRoot: null, members: steward.memberAuthority!, access: steward.accessForToken },
  );
  const socket = join(root, "steward.sock");
  socketServer = Bun.serve({ unix: socket, fetch: (req) => (isControlPath(new URL(req.url).pathname) ? control(req) : steward(req)) });

  portalServer = startPortal();
  PORTAL = `http://127.0.0.1:${portalServer.port}`;

  await give(ALICE, { blog: "developer", shop: "viewer" });

  dashboard = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server.ts")], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PORT: String(dashboardPort),
      DATA_DIR: data,
      STATE_FILE: join(data, "state.json"),
      STEWARD_SOCKET: socket,
      PORTAL_URL: PORTAL,
      EGRESS_URL: "http://127.0.0.1:9",
      PUBLIC_URL: DASHBOARD,
      PASSWORD_HASH: hash,
      SITESOLIDE_ZONE: ZONE,
      NODE_ENV: "test",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${DASHBOARD}/api/session`);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("the dashboard does not answer");
});

afterAll(() => {
  dashboard?.kill();
  socketServer?.stop(true);
  portalServer?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("a person, end to end", () => {
  test("the sign-in page offers the portal's provider", async () => {
    const body = (await (await fetch(`${DASHBOARD}/api/session`)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ open: false, configured: true, identity: null, sso: { offered: true, providerName: "Acme" } });
  });

  test("signs in through the portal, lands where they asked, and is told who they are and on what", async () => {
    const { browser, landed } = await signInAs(ALICE, "/site/?s=blog");
    expect(landed).toBe(`${DASHBOARD}/site/?s=blog`);
    expect(browser.jar.has("session")).toBe(true);
    expect(browser.jar.has("sso")).toBe(false);
    const session = (await (await browser.api("/api/session")).json()) as Record<string, unknown>;
    expect(session).toMatchObject({ open: true, identity: { kind: "person", email: ALICE, roles: { blog: "developer", shop: "viewer" } } });
  });

  test("sees their projects alone, and nothing of the machine's own figures", async () => {
    const { browser } = await signInAs(ALICE);
    const reading = (await (await browser.api("/api/state")).json()) as { snapshot: { sites: { slug: string }[]; machine: unknown } };
    expect(reading.snapshot.sites.map((site) => site.slug).sort()).toEqual(["blog", "shop"]);
    expect(reading.snapshot.machine).toBeNull();
  });

  test("cannot open the owner's pages, whatever the route", async () => {
    const { browser } = await signInAs(ALICE);
    for (const path of ["/api/people", "/api/connectors", "/api/portal/audit"]) {
      const response = await browser.api(path);
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toMatchObject({ error: "owner-only" });
    }
    // A person never unlocks with the dashboard's password, nor changes a password hash.
    const unlock = await browser.api("/api/secrets/unlock", { method: "POST", body: { password: PASSWORD } });
    expect(unlock.status).toBe(400);
    expect(await unlock.json()).toMatchObject({ error: "reauthenticate" });
    const password = await browser.api("/api/secrets/password", { method: "POST", body: { slug: "blog", file: "blog.env", variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null } });
    expect(password.status).toBe(403);
    expect((await browser.api("/api/people/person", { method: "PUT", body: { email: "x@acme.test", create: true } })).status).toBe(403);
    expect((await browser.api("/api/people/person", { method: "DELETE", body: { email: ALICE } })).status).toBe(403);
  });

  test("restarts the project they develop, and is refused, by the steward, on the one they only view", async () => {
    const { browser } = await signInAs(ALICE);
    const done = await browser.api("/api/secrets/restart", { method: "POST", body: { slug: "blog" } });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ verdict: { kind: "active" } });
    expect(restarts).toContain("blog");

    const refused = await browser.api("/api/secrets/restart", { method: "POST", body: { slug: "shop" } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "out-of-scope",
      message: `${ALICE} is a Viewer on shop: restarting its service takes a Developer or an Admin`,
    });
    expect(restarts).not.toContain("shop");
  });

  test("reads the activity of their projects, their own sign-ins and restarts named by their email", async () => {
    // Someone given access to a project that is not theirs: nothing of it is theirs to read.
    await give("zed@acme.test", { "secret-project": "viewer" });
    const { browser } = await signInAs(ALICE);
    await browser.api("/api/secrets/restart", { method: "POST", body: { slug: "blog" } });
    const page = (await (await browser.api("/api/audit?source=steward")).json()) as { rows: { actor: string; action: string; target: string | null }[] };
    expect(page.rows.some((row) => row.actor === ALICE && row.action === "dashboard.signin")).toBe(true);
    expect(page.rows.some((row) => row.actor === ALICE && row.action === "service.restart" && row.target === "blog")).toBe(true);
    expect(page.rows.some((row) => row.target === "secret-project" || row.target === "zed@acme.test")).toBe(false);
    await takeOff("zed@acme.test");
  });

  test("someone the registry does not name, or who can only open a site, is refused at sign-in, and gets no session", async () => {
    const { browser, landed } = await signInAs("bob@acme.test");
    expect(landed).toBe(`${DASHBOARD}/?signin=no-role`);
    expect(browser.jar.has("session")).toBe(false);
    await give("vera@acme.test", { shop: "visitor" });
    const visitor = await signInAs("vera@acme.test");
    expect(visitor.landed).toBe(`${DASHBOARD}/?signin=can-open-only`);
    expect(visitor.browser.jar.has("session")).toBe(false);
    await takeOff("vera@acme.test");
  });

  test("taken off by the owner, their next write is refused and their session is gone", async () => {
    const bob = "carol@acme.test";
    await give(bob, { blog: "developer" });
    const { browser } = await signInAs(bob);
    expect((await (await browser.api("/api/session")).json()) as unknown).toMatchObject({ identity: { email: bob } });
    await takeOff(bob);
    const refused = await browser.api("/api/secrets/restart", { method: "POST", body: { slug: "blog" } });
    expect(refused.status).toBe(401);
    expect((await (await browser.api("/api/session")).json()) as unknown).toMatchObject({ open: false });
  });

  test("signing out closes the steward's side too", async () => {
    const { browser } = await signInAs(ALICE);
    const token = browser.jar.get("session")!;
    await browser.api("/api/signout", { method: "POST" });
    const whoami = await steward(new Request("http://steward/members/whoami", { method: "POST", body: JSON.stringify({ session: token }) }));
    expect(whoami.status).toBe(401);
  });
});

describe("the owner, beside the people", () => {
  test("sees the People page with the password, and gives the create right or a role only unlocked", async () => {
    const signIn = await fetch(`${DASHBOARD}/api/signin`, { method: "POST", headers: { Origin: DASHBOARD, "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    const browser = new Browser();
    browser.keep(signIn);
    const page = (await (await browser.api("/api/people")).json()) as Record<string, unknown>;
    expect(page).toMatchObject({ available: true, dashboardUrl: DASHBOARD, providerName: "Acme", projects: ["blog", "secret-project", "shop"], signIn: { configured: true, allowedDomains: ["acme.test"] } });
    expect((page.people as { who: string; roles: unknown }[]).find((person) => person.who === ALICE)?.roles).toEqual({ blog: "developer", shop: "viewer" });
    const creator = { email: "erin@acme.test", create: true };
    expect((await browser.api("/api/people/person", { method: "PUT", body: creator })).status).toBe(423);
    const role = { slug: "blog", who: "frank@acme.test", role: "viewer" };
    expect((await browser.api("/api/access/entry", { method: "PUT", body: role })).status).toBe(423);
    // Can open needs no unlock, nor does taking someone off.
    expect((await browser.api("/api/access/entry", { method: "PUT", body: { slug: "shop", who: "frank@acme.test", role: "visitor" } })).status).toBe(201);
    expect((await browser.api("/api/access/entry", { method: "DELETE", body: { slug: "shop", who: "frank@acme.test" } })).status).toBe(200);
    // The one restart route: a person's session restarts with its role alone, the owner's waits for the unlock.
    expect((await browser.api("/api/secrets/restart", { method: "POST", body: { slug: "blog" } })).status).toBe(423);

    // Unlocked, the People page gives the create right alone, and the Access section a role.
    expect((await browser.api("/api/secrets/unlock", { method: "POST", body: { password: PASSWORD } })).status).toBe(200);
    const created = await browser.api("/api/people/person", { method: "PUT", body: creator });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ change: "create", person: { who: "erin@acme.test", roles: {}, create: true } });
    const given = await browser.api("/api/access/entry", { method: "PUT", body: role });
    expect(given.status).toBe(201);
    expect(await given.json()).toMatchObject({ change: "add", entry: { who: "frank@acme.test", role: "viewer", by: "owner" } });
    for (const email of ["erin@acme.test", "frank@acme.test"]) {
      const removed = await browser.api("/api/people/person", { method: "DELETE", body: { email } });
      expect([email, removed.status]).toEqual([email, 200]);
    }
  });
});

describe("a person's secrets, general access and people, end to end", () => {
  async function json(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
  }

  test("a Developer sees names, unlocks through a forced sign-in, writes, and is refused a read by the steward", async () => {
    await give(ALICE, { blog: "developer", shop: "viewer" });
    const { browser } = await signInAs(ALICE);
    const listed = await json(await browser.api("/api/secrets"));
    expect((listed.projects as { slug: string }[]).map((project) => project.slug)).toEqual(["blog"]);
    expect((listed.projects as { files: { readable: boolean; variables: string[] }[] }[])[0]!.files[0]).toMatchObject({ readable: false, variables: ["API_KEY"] });
    expect(JSON.stringify(listed)).not.toContain(SECRET_VALUE);
    expect(listed.until).toBeNull();

    const write = { slug: "blog", file: "blog.env", variable: "FEATURE", value: "on-from-a-developer" };
    const locked = await browser.api("/api/secrets/variable", { method: "PUT", body: write });
    expect(locked.status).toBe(423);

    const landed = await unlockAs(browser, ALICE);
    expect(landed).toBe(`${DASHBOARD}/site/secrets/?s=blog`);
    expect(((await json(await browser.api("/api/secrets"))).until as number) > Date.now()).toBe(true);
    const written = await browser.api("/api/secrets/variable", { method: "PUT", body: write });
    expect(written.status).toBe(200);
    expect(readFileSync(join(root, "secrets", "blog.env"), "utf8")).toContain("FEATURE=on-from-a-developer");

    const read = await browser.api("/api/secrets/value", { method: "POST", body: { slug: "blog", file: "blog.env", variable: "API_KEY" } });
    expect(read.status).toBe(403);
    const refusal = await json(read);
    expect(refusal.message).toContain("never reads one");
    expect(JSON.stringify(refusal)).not.toContain(SECRET_VALUE);

    // The activity names them for the write and for the refused read.
    const rows = ((await json(await browser.api("/api/audit?source=steward"))).rows as { actor: string; action: string; target: string; detail: { result?: string } }[]);
    expect(rows.some((row) => row.actor === ALICE && row.action === "secrets.set" && row.target === "blog" && row.detail.result === "ok")).toBe(true);
    expect(rows.some((row) => row.actor === ALICE && row.action === "secrets.read" && row.detail.result === "rejects")).toBe(true);
    expect(rows.some((row) => row.actor === ALICE && row.action === "secrets.unlock")).toBe(true);
  });

  test("a sign-in that was not forced at the provider unlocks nothing", async () => {
    const { browser } = await signInAs(ALICE);
    next.ignoreReauth = true;
    const landed = await unlockAs(browser, ALICE);
    expect(landed).toBe(`${DASHBOARD}/site/secrets/?s=blog&unlock=refused`);
    expect((await browser.api("/api/secrets/variable", { method: "PUT", body: { slug: "blog", file: "blog.env", variable: "A", value: "b" } })).status).toBe(423);
  });

  test("another account's forced sign-in does not unlock this person's session", async () => {
    await give("dan@acme.test", { blog: "developer" });
    const { browser } = await signInAs(ALICE);
    const landed = await unlockAs(browser, "dan@acme.test");
    expect(landed).toBe(`${DASHBOARD}/site/secrets/?s=blog&unlock=another-account`);
  });

  test("the owner's unlock and a person's live side by side", async () => {
    await give("gus@acme.test", { blog: "developer" });
    const { browser } = await signInAs("gus@acme.test");
    await unlockAs(browser, "gus@acme.test");
    const signIn = await fetch(`${DASHBOARD}/api/signin`, { method: "POST", headers: { Origin: DASHBOARD, "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    const owner = new Browser();
    owner.keep(signIn);
    expect((await owner.api("/api/secrets/unlock", { method: "POST", body: { password: PASSWORD } })).status).toBe(200);
    expect((await browser.api("/api/secrets/variable", { method: "PUT", body: { slug: "blog", file: "blog.env", variable: "SIDE", value: "by-side" } })).status).toBe(200);
    expect((await owner.api("/api/secrets/value", { method: "POST", body: { slug: "blog", file: "blog.env", variable: "SIDE" } })).status).toBe(200);
  });

  test("an Admin reads their project's values, and gives people access to it, which the portal is told through the steward's projection", async () => {
    const HAL = "hal@acme.test";
    await give(HAL, { blog: "developer", shop: "admin" });
    const { browser } = await signInAs(HAL);
    await unlockAs(browser, HAL, "/site/secrets/?s=shop");
    const read = await browser.api("/api/secrets/value", { method: "POST", body: { slug: "shop", file: "shop.env", variable: "API_KEY" } });
    expect(await json(read)).toEqual({ value: SECRET_VALUE });

    const page = await json(await browser.api("/api/access?slug=shop"));
    expect(page).toMatchObject({ slug: "shop", you: { kind: "person", email: HAL, role: "admin" }, grantable: ["visitor", "viewer", "developer", "admin"], portal: { reading: "steward" } });
    // A Developer on blog reads its people, read-only, and changes nothing there.
    expect(await json(await browser.api("/api/access?slug=blog"))).toMatchObject({ slug: "blog", you: { role: "developer" }, grantable: [], signIn: { admins: [] } });
    expect((await browser.api("/api/access/entry", { method: "PUT", body: { slug: "blog", who: "bob@acme.test", role: "visitor" } })).status).toBe(403);

    const given = await browser.api("/api/access/entry", { method: "PUT", body: { slug: "shop", who: "bob@acme.test", role: "visitor" } });
    expect(given.status).toBe(201);
    expect(await json(given)).toMatchObject({ change: "add", entry: { who: "bob@acme.test", role: "visitor", by: HAL } });
    expect(projection().sites[`shop.${ZONE}`]?.people["bob@acme.test"]).toBe("visitor");
    // Someone outside the company's domains gets password access: the password shown this once.
    const outsider = await json(await browser.api("/api/access/entry", { method: "PUT", body: { slug: "shop", who: "eve@elsewhere.test", role: "visitor", expiresInS: 86400 } }));
    expect(outsider).toMatchObject({ change: "add", entry: { who: "eve@elsewhere.test", kind: "password", password: { expired: false } } });
    expect(typeof outsider.password).toBe("string");
    expect(JSON.stringify(projection())).not.toContain(outsider.password as string);
    // Not on blog, where they are a Developer.
    expect((await browser.api("/api/access/entry", { method: "PUT", body: { slug: "blog", who: "bob@acme.test", role: "visitor" } })).status).toBe(403);
    for (const who of ["bob@acme.test", "eve@elsewhere.test"]) {
      expect((await browser.api("/api/access/entry", { method: "DELETE", body: { slug: "shop", who } })).status).toBe(200);
    }
  });

  test("an Admin gives a role above Can open under their unlock, at most their own, and is refused on another project", async () => {
    const IVY = "ivy@acme.test";
    await give(IVY, { blog: "developer", shop: "admin" });
    const { browser } = await signInAs(IVY);
    const viewer = { slug: "shop", who: "erin@acme.test", role: "viewer" };
    expect((await browser.api("/api/access/entry", { method: "PUT", body: viewer })).status).toBe(423);
    await unlockAs(browser, IVY, "/site/access/?s=shop");
    expect((await browser.api("/api/access/entry", { method: "PUT", body: viewer })).status).toBe(201);
    const page = await json(await browser.api("/api/access?slug=shop"));
    const roles = (page.entries as { who: string; role: string }[]).map((entry) => [entry.who, entry.role]);
    expect(roles).toEqual(expect.arrayContaining([["erin@acme.test", "viewer"], [IVY, "admin"]]));
    expect((await browser.api("/api/access/entry", { method: "PUT", body: { ...viewer, slug: "blog" } })).status).toBe(403);
    // Taking someone off needs no unlock; it closes their way in at once.
    expect((await browser.api("/api/access/entry", { method: "DELETE", body: { slug: "shop", who: "erin@acme.test" } })).status).toBe(200);
    expect(projection().sites[`shop.${ZONE}`]?.people["erin@acme.test"]).toBeUndefined();
  });
});

describe("a person's own tokens, end to end", () => {
  /** The control API, as the CLI or an agent calls it, with a bearer. */
  const api = (path: string, bearer: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${DASHBOARD}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  test("minted on the Tokens page under their own unlock, within their roles, and narrowed with them", async () => {
    const carol = "carol@acme.test";
    await give(carol, { blog: "developer", shop: "admin" });
    const { browser } = await signInAs(carol);

    // Their Tokens page: their tokens alone, and what they may mint them for.
    const page = (await (await browser.api("/api/tokens")).json()) as { member: unknown; tokens: unknown[] };
    expect(page).toMatchObject({ member: { email: carol, roles: { blog: "developer", shop: "admin" }, create: false }, tokens: [] });

    const mint = (scope: Record<string, unknown>) =>
      browser.api("/api/tokens", { method: "POST", body: { label: "laptop", expiresAt: null, scope: { slugs: [], create: false, outbound: false, domain: false, public: false, ...scope } } });
    // Locked: the forced sign-in first.
    expect((await mint({ slugs: ["blog"] })).status).toBe(423);
    await unlockAs(browser, carol, "/team/");

    const created = await mint({ slugs: ["blog"] });
    expect(created.status).toBe(201);
    const { token, secret } = (await created.json()) as { token: { id: string; email: string; member: string }; secret: string };
    expect(token).toMatchObject({ email: carol, member: carol });

    // Above their roles, the steward's words: the options are an Admin's.
    const above = await mint({ slugs: ["blog"], public: true });
    expect(above.status).toBe(403);
    expect(((await above.json()) as { message: string }).message).toBe(`scope.public: ${carol} is a Developer on blog: deploying it in the open, its general access public, takes an Admin`);
    expect((await mint({ create: true })).status).toBe(403);
    // Within: the options where they are Admin.
    expect((await mint({ slugs: ["shop"], outbound: true })).status).toBe(201);

    // The token works over the control API, as the person's, narrowed to their roles.
    const who = (await (await api("/api/v1/whoami", secret)).json()) as { identity: { member: string; scope: { slugs: string[] } } };
    expect(who.identity).toMatchObject({ member: carol, scope: { slugs: ["blog"] } });
    // blog is in the open on the machine: a Developer's token deploys it as it stands.
    const opened = await api("/api/v1/deployments", secret, { method: "POST", body: { manifest: { slug: "blog", start: "/usr/local/bin/bun run server.ts", port: 3040, publicDir: "public", secrets: ["blog.env"] } } });
    expect(opened.status).toBe(201);

    // Lowered to Viewer on blog: the next deployment is refused by the steward, in its words.
    await give(carol, { blog: "viewer" });
    const narrowed = (await (await api("/api/v1/whoami", secret)).json()) as { identity: { scope: { slugs: string[] } } };
    expect(narrowed.identity.scope.slugs).toEqual([]);
    const refused = await api("/api/v1/deployments", secret, { method: "POST", body: { manifest: { slug: "blog", start: "/usr/local/bin/bun run server.ts", port: 3040, publicDir: "public", secrets: ["blog.env"] } } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toBe(`${carol} is a Viewer on blog: deploying it takes a Developer or an Admin`);

    // Their own list, and the owner's: every token, with whose it is.
    const listed = (await (await browser.api("/api/tokens")).json()) as { tokens: { id: string }[] };
    expect(listed.tokens).toHaveLength(2);
    expect(listed.tokens.map((one) => one.id)).toContain(token.id);

    // Taken off: every token of theirs refused, revoked under the owner.
    await takeOff(carol);
    const gone = await api("/api/v1/whoami", secret);
    expect(gone.status).toBe(401);
    const all = (await (await control(new Request("http://steward/team/tokens"))).json()) as { tokens: { member: string | null; revokedAt: number | null }[] };
    expect(all.tokens.filter((one) => one.member === carol).every((one) => one.revokedAt !== null)).toBe(true);
    expect(installs).toEqual([]);
  });

  test("a Viewer everywhere has no Tokens page of their own to mint from", async () => {
    const dave = "dave@acme.test";
    await give(dave, { blog: "viewer" });
    const { browser } = await signInAs(dave);
    const page = (await (await browser.api("/api/tokens")).json()) as { member: { create: boolean } };
    expect(page.member.create).toBe(false);
    const refused = await browser.api("/api/tokens", { method: "POST", body: { label: "x", expiresAt: null, scope: { slugs: ["blog"], create: false, outbound: false, domain: false, public: false } } });
    // No unlock to hold for a Viewer: locked before anything else.
    expect(refused.status).toBe(423);
    await takeOff(dave);
  });
});
