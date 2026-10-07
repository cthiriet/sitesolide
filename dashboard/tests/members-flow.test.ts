import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateKey, signAssertion } from "../borrowed/assertion";
import { INSTALLER_TEMPLATE } from "../src/control/protocol";
import { createControlSteward, isControlPath, type ControlHandler } from "../src/control/steward";
import { createControlSystem } from "../src/control/system";
import type { PortalAdmin } from "../src/members/portal";
import { createMembersSystem } from "../src/members/system";
import { createSteward, type StewardHandler } from "../src/secrets/steward";
import { createSystem, type Command } from "../src/secrets/system";

/**
 * A member's whole road through the real dashboard: its own server.ts in a
 * process of its own, the steward's real routes on a real Unix socket, and a
 * portal of the tests' making on a port, which signs its assertions with the
 * key the steward laid, as the real one does.
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
/** The control routes beside it, as dashboard/steward.ts mounts them: tokens, a member's own included. */
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

/** What reached the portal's admin API, and from whom: the steward's relay, or the dashboard. */
const portalCalls: { route: string; body: Record<string, unknown> }[] = [];

/** The portal's side, reduced to what the dashboard sees of it. */
function startPortal(): ReturnType<typeof Bun.serve> {
  const flows = new Map<string, { binding: string; returnTo: string; reauth: boolean }>();
  const codes = new Map<string, { binding: string; returnTo: string; email: string; reauth: boolean }>();
  const policies: { host: string; policy: unknown; updatedAt: number }[] = [];
  const guests: { id: string; host: string; label: string }[] = [{ id: "GUESTONBLOG00001", host: `blog.${ZONE}`, label: "Not shop's" }];
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/admin/sharing": () => Response.json({ sso: { configured: true, providerName: "Acme", allowedDomains: ["acme.test"], admins: [], portalUrl: PORTAL }, sites: policies }),
      "/admin/sharing/:host": {
        PUT: async (req) => {
          const body = (await req.json()) as Record<string, unknown>;
          portalCalls.push({ route: `PUT /admin/sharing/${req.params.host}`, body });
          const policy = { mode: body.mode, people: body.people, domains: body.domains };
          policies.push({ host: req.params.host, policy, updatedAt: Date.now() });
          return Response.json({ host: req.params.host, policy, updatedAt: Date.now() });
        },
      },
      "/admin/guests": {
        GET: () => Response.json({ guests }),
        POST: async (req) => {
          const body = (await req.json()) as Record<string, unknown>;
          portalCalls.push({ route: "POST /admin/guests", body });
          const guest = { id: "GUESTONSHOP00001", host: String(body.host), label: String(body.label) };
          guests.push(guest);
          return Response.json({ guest, password: "drawn-guest-password-0001" }, { status: 201 });
        },
      },
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
  const call = (method: string, path: string, body?: object) =>
    fetch(`${url()}${path}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  return {
    sharing: () => call("GET", "/admin/sharing"),
    replaceSharing: (host, body) => call("PUT", `/admin/sharing/${encodeURIComponent(host)}`, body),
    guests: () => call("GET", "/admin/guests"),
    createGuest: (body) => call("POST", "/admin/guests", body),
    revokeGuest: (id, actor) => call("DELETE", `/admin/invites/${id}`, { actor }),
  };
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

/** A member's unlock: the dashboard sends them through a forced sign-in, and back where they were. */
async function unlockAs(browser: Browser, email: string, returnTo = "/site/secrets/?s=blog"): Promise<string> {
  next.email = email;
  return browser.follow(`${DASHBOARD}/api/sso/begin?reauth=1&return=${encodeURIComponent(returnTo)}`);
}

const asRoot = (method: string, path: string, body?: unknown) =>
  steward.owner(new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

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
  // shop's block carries the portal: it may be shared, and given guests.
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
        zone: ZONE,
        portal: relayTo(() => PORTAL),
        revokeTokens: (email, actor) => control.revokeMember(email, actor),
      },
    },
  );
  await steward.ensureMemberKeys();
  writeFileSync(join(units, INSTALLER_TEMPLATE), "[Service]\n");
  control = createControlSteward(
    {
      ...createControlSystem({ stateFolder: state, sitesDir: sites, unitsFolder: units, installerFolder: folder("installer"), systemctl: "/bin/false", journalctl: "/bin/false" }),
      systemctl: async (arguments_) => {
        if (arguments_[0] === "start") installs.push(arguments_.at(-1)!);
        return arguments_[0] === "is-active" ? { code: 3, output: "inactive\n" } : { code: 0, output: "" };
      },
    },
    { zone: ZONE, isUnlocked: steward.isUnlocked, uidRoot: null, members: steward.memberAuthority!, share: steward.shareForToken },
  );
  const socket = join(root, "steward.sock");
  socketServer = Bun.serve({ unix: socket, fetch: (req) => (isControlPath(new URL(req.url).pathname) ? control(req) : steward(req)) });

  portalServer = startPortal();
  PORTAL = `http://127.0.0.1:${portalServer.port}`;

  expect((await asRoot("PUT", "/members/member", { email: ALICE, roles: { blog: "developer", shop: "viewer" } })).status).toBe(201);

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

describe("a member, end to end", () => {
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
    expect(session).toMatchObject({ open: true, identity: { kind: "member", email: ALICE, roles: { blog: "developer", shop: "viewer" } } });
  });

  test("sees their projects alone, and nothing of the machine's own figures", async () => {
    const { browser } = await signInAs(ALICE);
    const reading = (await (await browser.api("/api/state")).json()) as { snapshot: { sites: { slug: string }[]; machine: unknown } };
    expect(reading.snapshot.sites.map((site) => site.slug).sort()).toEqual(["blog", "shop"]);
    expect(reading.snapshot.machine).toBeNull();
  });

  test("cannot open the super admin's pages, whatever the route", async () => {
    const { browser } = await signInAs(ALICE);
    for (const path of ["/api/members", "/api/connectors", "/api/portal/audit"]) {
      const response = await browser.api(path);
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toMatchObject({ error: "owner-only" });
    }
    // A member never unlocks with the dashboard's password, nor changes a password hash.
    const unlock = await browser.api("/api/secrets/unlock", { method: "POST", body: { password: PASSWORD } });
    expect(unlock.status).toBe(400);
    expect(await unlock.json()).toMatchObject({ error: "reauthenticate" });
    const password = await browser.api("/api/secrets/password", { method: "POST", body: { slug: "blog", file: "blog.env", variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null } });
    expect(password.status).toBe(403);
    expect((await browser.api("/api/members/member", { method: "PUT", body: { email: "x@acme.test", roles: {} } })).status).toBe(403);
  });

  test("restarts the project they develop, and is refused, by the steward, on the one they only view", async () => {
    const { browser } = await signInAs(ALICE);
    const done = await browser.api("/api/members/restart", { method: "POST", body: { slug: "blog" } });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ verdict: { kind: "active" } });
    expect(restarts).toContain("blog");

    const refused = await browser.api("/api/members/restart", { method: "POST", body: { slug: "shop" } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "out-of-scope",
      message: `${ALICE} is a viewer on shop: restarting its service takes a developer or a project admin`,
    });
    expect(restarts).not.toContain("shop");
  });

  test("reads the activity of their projects, their own sign-ins and restarts named by their email", async () => {
    const { browser } = await signInAs(ALICE);
    await browser.api("/api/members/restart", { method: "POST", body: { slug: "blog" } });
    const page = (await (await browser.api("/api/audit?source=steward")).json()) as { rows: { actor: string; action: string; target: string | null }[] };
    expect(page.rows.some((row) => row.actor === ALICE && row.action === "member.signin")).toBe(true);
    expect(page.rows.some((row) => row.actor === ALICE && row.action === "service.restart" && row.target === "blog")).toBe(true);
    // The owner's invitation names no project of theirs and is not theirs: not shown.
    expect(page.rows.some((row) => row.action === "member.invite")).toBe(false);
  });

  test("someone the registry does not name is refused at sign-in, and gets no session", async () => {
    const { browser, landed } = await signInAs("bob@acme.test");
    expect(landed).toBe(`${DASHBOARD}/?signin=not-a-member`);
    expect(browser.jar.has("session")).toBe(false);
  });

  test("removed by the owner, their next write is refused and their session is gone", async () => {
    const bob = "carol@acme.test";
    await asRoot("PUT", "/members/member", { email: bob, roles: { blog: "developer" } });
    const { browser } = await signInAs(bob);
    expect((await (await browser.api("/api/session")).json()) as unknown).toMatchObject({ identity: { email: bob } });
    expect((await asRoot("DELETE", "/members/member", { email: bob })).status).toBe(200);
    const refused = await browser.api("/api/members/restart", { method: "POST", body: { slug: "blog" } });
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

describe("the owner, beside the members", () => {
  test("sees the Members page with the password, and invites only unlocked", async () => {
    const signIn = await fetch(`${DASHBOARD}/api/signin`, { method: "POST", headers: { Origin: DASHBOARD, "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    const browser = new Browser();
    browser.keep(signIn);
    const page = (await (await browser.api("/api/members")).json()) as Record<string, unknown>;
    expect(page).toMatchObject({ available: true, dashboardUrl: DASHBOARD, providerName: "Acme", projects: ["blog", "secret-project", "shop"] });
    expect((page.members as { email: string }[]).some((member) => member.email === ALICE)).toBe(true);
    const locked = await browser.api("/api/members/member", { method: "PUT", body: { email: "dave@acme.test", roles: { blog: "viewer" } } });
    expect(locked.status).toBe(423);
    // The member's restart route is a member's: the owner restarts from Secrets, unlocked.
    expect((await browser.api("/api/members/restart", { method: "POST", body: { slug: "blog" } })).status).toBe(403);

    // Unlocked, the Members page saves someone with the right to create projects alone, and no one with neither.
    expect((await browser.api("/api/secrets/unlock", { method: "POST", body: { password: PASSWORD } })).status).toBe(200);
    const creator = await browser.api("/api/members/member", { method: "PUT", body: { email: "erin@acme.test", roles: {}, create: true } });
    expect(creator.status).toBe(201);
    expect(await creator.json()).toMatchObject({ change: "invite", member: { email: "erin@acme.test", roles: {}, create: true } });
    const neither = await browser.api("/api/members/member", { method: "PUT", body: { email: "frank@acme.test", roles: {}, create: false } });
    expect(neither.status).toBe(400);
    expect(((await neither.json()) as { message: string }).message).toBe("roles: give them a role on one project at least, or the right to create projects");
    expect((await asRoot("DELETE", "/members/member", { email: "erin@acme.test" })).status).toBe(200);
  });
});

describe("a member's secrets, door and project, end to end", () => {
  async function json(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
  }

  test("a Developer sees names, unlocks through a forced sign-in, writes, and is refused a read by the steward", async () => {
    await asRoot("PUT", "/members/member", { email: ALICE, roles: { blog: "developer", shop: "viewer" } });
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

  test("another account's forced sign-in does not unlock this member's session", async () => {
    await asRoot("PUT", "/members/member", { email: "dan@acme.test", roles: { blog: "developer" } });
    const { browser } = await signInAs(ALICE);
    const landed = await unlockAs(browser, "dan@acme.test");
    expect(landed).toBe(`${DASHBOARD}/site/secrets/?s=blog&unlock=another-account`);
  });

  test("the super admin's unlock and a member's live side by side", async () => {
    await asRoot("PUT", "/members/member", { email: "gus@acme.test", roles: { blog: "developer" } });
    const { browser } = await signInAs("gus@acme.test");
    await unlockAs(browser, "gus@acme.test");
    const signIn = await fetch(`${DASHBOARD}/api/signin`, { method: "POST", headers: { Origin: DASHBOARD, "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    const owner = new Browser();
    owner.keep(signIn);
    expect((await owner.api("/api/secrets/unlock", { method: "POST", body: { password: PASSWORD } })).status).toBe(200);
    expect((await browser.api("/api/secrets/variable", { method: "PUT", body: { slug: "blog", file: "blog.env", variable: "SIDE", value: "by-side" } })).status).toBe(200);
    expect((await owner.api("/api/secrets/value", { method: "POST", body: { slug: "blog", file: "blog.env", variable: "SIDE" } })).status).toBe(200);
  });

  test("a Project admin reads, shares and gives guest access on their project, the portal told their email by the steward", async () => {
    const HAL = "hal@acme.test";
    await asRoot("PUT", "/members/member", { email: HAL, roles: { blog: "developer", shop: "admin" } });
    const { browser } = await signInAs(HAL);
    await unlockAs(browser, HAL, "/site/secrets/?s=shop");
    const read = await browser.api("/api/secrets/value", { method: "POST", body: { slug: "shop", file: "shop.env", variable: "API_KEY" } });
    expect(await json(read)).toEqual({ value: SECRET_VALUE });

    const before = portalCalls.length;
    const shared = await browser.api(`/api/sharing/shop.${ZONE}`, { method: "PUT", body: { mode: "people", people: ["bob@acme.test"], domains: [] } });
    expect(shared.status).toBe(200);
    expect(portalCalls.at(-1)).toEqual({ route: `PUT /admin/sharing/shop.${ZONE}`, body: { mode: "people", people: ["bob@acme.test"], domains: [], actor: HAL } });
    // blog is not behind the portal, and Alice is no admin there.
    expect((await browser.api(`/api/sharing/blog.${ZONE}`, { method: "PUT", body: { mode: "people", people: [], domains: [] } })).status).toBe(400);

    const guest = await browser.api("/api/guests", { method: "POST", body: { host: `shop.${ZONE}`, label: "Client", durationS: 3600 } });
    expect(guest.status).toBe(201);
    expect(portalCalls.at(-1)).toMatchObject({ route: "POST /admin/guests", body: { host: `shop.${ZONE}`, actor: HAL } });
    expect(portalCalls.length).toBe(before + 2);
    // The guests they see: shop's alone.
    const listed = await json(await browser.api("/api/guests"));
    expect((listed.guests as { host: string }[]).every((one) => one.host === `shop.${ZONE}`)).toBe(true);
  });

  test("a Project admin invites on their project, under their unlock, and is refused on another", async () => {
    const IVY = "ivy@acme.test";
    await asRoot("PUT", "/members/member", { email: IVY, roles: { blog: "developer", shop: "admin" } });
    const { browser } = await signInAs(IVY);
    expect((await browser.api("/api/members/project", { method: "PUT", body: { slug: "shop", email: "erin@acme.test", role: "viewer" } })).status).toBe(423);
    await unlockAs(browser, IVY, "/site/members/?s=shop");
    const invited = await browser.api("/api/members/project", { method: "PUT", body: { slug: "shop", email: "erin@acme.test", role: "viewer" } });
    expect(invited.status).toBe(201);
    const page = await json(await browser.api("/api/members/project?slug=shop"));
    const roles = (page.members as { email: string; role: string; roles?: unknown }[]).map((member) => [member.email, member.role]);
    expect(roles).toEqual(expect.arrayContaining([["erin@acme.test", "viewer"], [IVY, "admin"]]));
    // Their role on shop alone: nothing of the projects they hold elsewhere.
    expect((page.members as Record<string, unknown>[]).every((member) => !("roles" in member))).toBe(true);
    const refused = await browser.api("/api/members/project", { method: "PUT", body: { slug: "blog", email: "erin@acme.test", role: "viewer" } });
    expect(refused.status).toBe(403);
    expect((await browser.api("/api/members/project?slug=blog")).status).toBe(403);
    expect((await browser.api("/api/members/project", { method: "DELETE", body: { slug: "shop", email: "erin@acme.test" } })).status).toBe(200);
  });
});

describe("a member's own tokens, end to end", () => {
  /** The control API, as the CLI or an agent calls it, with a bearer. */
  const api = (path: string, bearer: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${DASHBOARD}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  test("minted on the Team page under their own unlock, within their roles, and narrowed with them", async () => {
    const carol = "carol@acme.test";
    expect((await asRoot("PUT", "/members/member", { email: carol, roles: { blog: "developer", shop: "admin" } })).status).toBe(201);
    const { browser } = await signInAs(carol);

    // Their Team page: their tokens alone, and what they may mint them for.
    const page = (await (await browser.api("/api/team")).json()) as { member: unknown; tokens: unknown[] };
    expect(page).toMatchObject({ member: { email: carol, roles: { blog: "developer", shop: "admin" }, create: false }, tokens: [] });

    const mint = (scope: Record<string, unknown>) =>
      browser.api("/api/team/tokens", { method: "POST", body: { label: "laptop", expiresAt: null, scope: { slugs: [], create: false, outbound: false, domain: false, public: false, ...scope } } });
    // Locked: the forced sign-in first.
    expect((await mint({ slugs: ["blog"] })).status).toBe(423);
    await unlockAs(browser, carol, "/team/");

    const created = await mint({ slugs: ["blog"] });
    expect(created.status).toBe(201);
    const { token, secret } = (await created.json()) as { token: { id: string; email: string; member: string }; secret: string };
    expect(token).toMatchObject({ email: carol, member: carol });

    // Above their roles, the steward's words: the options are a Project admin's.
    const above = await mint({ slugs: ["blog"], public: true });
    expect(above.status).toBe(403);
    expect(((await above.json()) as { message: string }).message).toBe(`scope.public: ${carol} is a developer on blog: deploying it in the open, without the portal, takes a project admin`);
    expect((await mint({ create: true })).status).toBe(403);
    // Within: the options where they are Project admin.
    expect((await mint({ slugs: ["shop"], outbound: true })).status).toBe(201);

    // The token works over the control API, as the member's, narrowed to their roles.
    const who = (await (await api("/api/v1/whoami", secret)).json()) as { identity: { member: string; scope: { slugs: string[] } } };
    expect(who.identity).toMatchObject({ member: carol, scope: { slugs: ["blog"] } });
    // blog is in the open on the machine: a Developer's token deploys it as it stands.
    const opened = await api("/api/v1/deployments", secret, { method: "POST", body: { manifest: { slug: "blog", start: "/usr/local/bin/bun run server.ts", port: 3040, publicDir: "public", secrets: ["blog.env"] } } });
    expect(opened.status).toBe(201);

    // Lowered to viewer on blog: the next deployment is refused by the steward, in its words.
    await asRoot("PUT", "/members/member", { email: carol, roles: { blog: "viewer", shop: "admin" } });
    const narrowed = (await (await api("/api/v1/whoami", secret)).json()) as { identity: { scope: { slugs: string[] } } };
    expect(narrowed.identity.scope.slugs).toEqual([]);
    const refused = await api("/api/v1/deployments", secret, { method: "POST", body: { manifest: { slug: "blog", start: "/usr/local/bin/bun run server.ts", port: 3040, publicDir: "public", secrets: ["blog.env"] } } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toBe(`${carol} is a viewer on blog: deploying it takes a developer or a project admin`);

    // Their own list, and the owner's: every token, with whose it is.
    const listed = (await (await browser.api("/api/team")).json()) as { tokens: { id: string }[] };
    expect(listed.tokens).toHaveLength(2);
    expect(listed.tokens.map((one) => one.id)).toContain(token.id);

    // Removed: every token of theirs refused, revoked under the owner.
    expect((await asRoot("DELETE", "/members/member", { email: carol })).status).toBe(200);
    const gone = await api("/api/v1/whoami", secret);
    expect(gone.status).toBe(401);
    const all = (await (await control(new Request("http://steward/team/tokens"))).json()) as { tokens: { member: string | null; revokedAt: number | null }[] };
    expect(all.tokens.filter((one) => one.member === carol).every((one) => one.revokedAt !== null)).toBe(true);
    expect(installs).toEqual([]);
  });

  test("a viewer everywhere has no Team page of their own to mint from", async () => {
    const dave = "dave@acme.test";
    await asRoot("PUT", "/members/member", { email: dave, roles: { blog: "viewer" } });
    const { browser } = await signInAs(dave);
    const page = (await (await browser.api("/api/team")).json()) as { member: { create: boolean } };
    expect(page.member.create).toBe(false);
    const refused = await browser.api("/api/team/tokens", { method: "POST", body: { label: "x", expiresAt: null, scope: { slugs: ["blog"], create: false, outbound: false, domain: false, public: false } } });
    // No unlock to hold for a viewer: locked before anything else.
    expect(refused.status).toBe(423);
    await asRoot("DELETE", "/members/member", { email: dave });
  });
});
