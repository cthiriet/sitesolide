import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateKey, signAssertion } from "../borrowed/assertion";
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
let socketServer: ReturnType<typeof Bun.serve>;
let portalServer: ReturnType<typeof Bun.serve>;
let dashboard: ReturnType<typeof Bun.spawn>;
const restarts: string[] = [];
const dashboardPort = freePort();
const DASHBOARD = `http://127.0.0.1:${dashboardPort}`;
let PORTAL = "";

/** Who the portal signs in next, as the provider would after the person typed their password. */
const next = { email: ALICE };

/** The portal's side, reduced to what the dashboard sees of it. */
function startPortal(): ReturnType<typeof Bun.serve> {
  const flows = new Map<string, { binding: string; returnTo: string }>();
  const codes = new Map<string, { binding: string; returnTo: string; email: string }>();
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/admin/sharing": () => Response.json({ sso: { configured: true, providerName: "Acme", allowedDomains: ["acme.test"], admins: [], portalUrl: PORTAL }, sites: [] }),
      "/admin/audit": () => Response.json({ events: [] }),
      "/admin/dashboard/flow": {
        POST: async (req) => {
          const body = (await req.json()) as { binding: string; returnTo: string };
          const id = crypto.randomUUID();
          flows.set(id, { binding: body.binding, returnTo: body.returnTo });
          return Response.json({ start: `${PORTAL}/oidc/start?flow=${id}` });
        },
      },
      "/oidc/start": (req) => {
        const flow = flows.get(new URL(req.url).searchParams.get("flow") ?? "");
        if (flow === undefined) return new Response("unknown flow", { status: 400 });
        const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
        codes.set(code, { ...flow, email: next.email });
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
          const assertion = await signAssertion(key, { email: minted.email, name: null, authTime: nowS }, nowS);
          return Response.json({ assertion, returnTo: minted.returnTo });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
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

  /** Only the dashboard's cookies are kept: the portal's host has its own, which this portal does not use. */
  async get(url: string): Promise<Response> {
    const ours = url.startsWith(DASHBOARD);
    const response = await fetch(url, { redirect: "manual", headers: ours ? { Cookie: this.cookies() } : {} });
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
  const browser = new Browser();
  const landed = await browser.follow(`${DASHBOARD}/api/sso/begin?return=${encodeURIComponent(returnTo)}`);
  return { browser, landed };
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
  const app = (slug: string, port: number) => {
    mkdirSync(join(sites, slug), { recursive: true });
    const manifest = { slug, start: "/usr/local/bin/bun run server.ts", port, publicDir: "public" };
    writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify(manifest));
    writeFileSync(join(units, `${slug}.service`), "[Service]\nExecStart=/usr/local/bin/bun run server.ts\n");
    return manifest;
  };
  const manifests = [app("blog", 3040), app("shop", 3041), app("secret-project", 3042)];
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
      blocks: {},
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
    caddyFolder: folder("caddy"),
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
      },
    },
  );
  await steward.ensureMemberKeys();
  const socket = join(root, "steward.sock");
  socketServer = Bun.serve({ unix: socket, fetch: (req) => steward(req) });

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
    for (const path of ["/api/team", "/api/members", "/api/connectors", "/api/secrets", "/api/guests", "/api/sharing", "/api/backups?slug=blog"]) {
      const response = await browser.api(path);
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toMatchObject({ error: "owner-only" });
    }
    expect((await browser.api("/api/secrets/unlock", { method: "POST", body: { password: PASSWORD } })).status).toBe(403);
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
  });
});
