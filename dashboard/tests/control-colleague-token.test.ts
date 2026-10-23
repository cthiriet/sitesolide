import { afterEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "../borrowed/bundle";
import { generateFragment } from "../borrowed/fragment";
import { readManifest, type Manifest } from "../borrowed/manifest";
import { fragmentIsProtected } from "../borrowed/portal";
import type { StoreView } from "../borrowed/store-protocol";
import { generateUnits } from "../borrowed/unit";
import { encodeRegistry, type Registry } from "../src/access/registry";
import { createAccessSystem } from "../src/access/system";
import { openDatabase } from "../src/database";
import { createApiRoutes, failure, secretsRoutes, storeRoutes } from "../src/control/api";
import { CLAIMS_NAME } from "../src/control/claims";
import { localControlSteward } from "../src/control/client";
import { createLimiter } from "../src/control/limiter";
import { INSTALLER_TEMPLATE, type Scope, type TokenView } from "../src/control/protocol";
import { createSpool } from "../src/control/spool";
import { createControlSteward, installerUnit, isControlPath, STORE_FORM } from "../src/control/steward";
import { createControlStore } from "../src/control/store";
import { createControlSystem, type ControlSystem } from "../src/control/system";
import { createTracker } from "../src/control/tracker";
import { readRequest } from "../src/installer/instance";
import { createReporter } from "../src/installer/main";
import { runPipeline, type Outcome } from "../src/installer/pipeline";
import { createHost } from "../src/installer/real";
import { createMembersSystem } from "../src/people/system";
import { reread } from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";
import { createSteward } from "../src/secrets/steward";
import { createSystem, type Command, type System } from "../src/secrets/system";
import { commandsOf, createBench, file, INSTALLER, machineOf, OWN_UID, ZONE, type Bench as InstallerBench } from "./installer-bench";
import { readRegistryFile, registryOf, writeRegistry } from "./registry-fixtures";

/**
 * What a deploy token the owner gives a colleague can and cannot do, proved
 * on one machine through the paths that machine runs: the dashboard's
 * control API on a real port, the routes the CLI calls; the control steward
 * on a real socket, with the secrets steward's real store, its journal, the
 * access registry and the token registry behind it; and the installer's
 * pipeline on the same tree, started on the request the steward wrote, as
 * systemd would start it. Only what needs root or a machine is simulated
 * (systemctl, useradd, Caddy, the probes; see installer-bench.ts).
 *
 * The machine, every name in it fictional: shop, an app in the open,
 * `"network": "outbound"`, a domain not switched on, its secrets named, the
 * store's form; billing, in the open too, with legacy files and its own
 * domain switched on; notes, restricted, the store's form; the dashboard
 * and the portal. The owner filled the stores of shop and notes, and
 * billing's legacy file, before the token was minted.
 *
 * The token, minted by the owner for the owner as holder: shop alone,
 * no creation, outbound, a domain, public sites, and secrets.
 */

const PASSWORD = "Owner-Password-For-The-Colleague-Tests-1";
const COLLEAGUE: Scope = { slugs: ["shop"], create: false, outbound: true, domain: true, public: true, secrets: true };

const DEVELOPER = "dev@acme.test";
const VIEWER = "viewer@acme.test";
const GUEST = "guest@acme.test";
const NEWCOMER = "new@acme.test";
const OUTSIDER = "someone@elsewhere.test";
const BILLING_ADMIN = "admin@acme.test";

/** Every value the machine holds or the token sends: none ever comes back, anywhere. */
const OWNER_ADMIN = "owner-shop-admin-91f3c7";
const OWNER_STRIPE = "owner-shop-stripe-2b8e04";
const OWNER_FILE = "owner-shop-file-0d6a15";
const BILLING_VALUE = "owner-billing-mail-value-55e0b2";
const NOTES_VALUE = "owner-notes-agent-value-a83b6d";
const OIDC_SECRET = "owner-oidc-client-secret-3f9c41";
const TYPED = "colleague-typed-value-7c1e9a";
const TYPED_FILE = "colleague-file-content-4b2d88";
const PLANTED = [OWNER_ADMIN, OWNER_STRIPE, OWNER_FILE, BILLING_VALUE, NOTES_VALUE, OIDC_SECRET, TYPED, TYPED_FILE];

const base64 = (text: string) => Buffer.from(text).toString("base64");

/** shop's manifest: an app in the open, outbound, a domain not switched on, its secrets named. */
const SHOP = {
  slug: "shop",
  port: 3040,
  publicDir: "dist",
  build: "bun run build",
  install: "bun install --production",
  start: "/usr/local/bin/bun run server.ts",
  routes: ["/api/*", "/r/*"],
  env: { NODE_ENV: "production" },
  exclude: ["node_modules", "data", ".test-data", "tests", "scripts", "public"],
  memory: "256M",
  network: "outbound",
  secrets: ["ADMIN_TOKEN", "SMTP_USER", "SMTP_PASSWORD", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "MAPS_API_KEY", "SEARCH_API_KEY"],
  domain: { name: "shop.example.test", aliases: ["www.shop.example.test"], active: false },
};

/**
 * What the colleague deploys: the same manifest without `install`, which
 * the installer runs as a real command on this bench, and `bun install`
 * would reach the network.
 */
const { install: _install, ...DEPLOYED } = SHOP;

/** billing: in the open, legacy files, its own domain switched on. */
const BILLING = {
  slug: "billing",
  port: 3041,
  publicDir: "dist",
  start: "/usr/local/bin/bun run server.ts",
  routes: ["/api/*"],
  env: { NODE_ENV: "production" },
  memory: "128M",
  network: "outbound",
  secrets: ["billing-mail.env", "billing-stripe.env", "billing-stats.env"],
  domain: { name: "billing.example.test", aliases: ["www.billing.example.test"], active: true },
};

/** notes: restricted, one path exempted, the store's form. */
const NOTES = {
  slug: "notes",
  port: 3042,
  publicDir: "public",
  start: "/usr/local/bin/bun run server.ts",
  routes: ["/", "/notes", "/notes/*", "/agent/*"],
  env: { NODE_ENV: "production" },
  memory: "128M",
  network: "localhost",
  secrets: ["AGENT_TOKEN"],
  headers: { "X-Robots-Tag": "noindex, nofollow, noarchive" },
  portal: true,
  portalExempt: ["/agent/*"],
};

const DASHBOARD = { slug: "dashboard", start: "/usr/local/bin/bun run server.ts", port: 3022, publicDir: "public", secrets: ["dashboard.env"] };
const PORTAL = { slug: "portal", start: "/usr/local/bin/bun run server.ts", port: 3026, publicDir: "public", secrets: ["portal.env"] };

/** What every deployment sends: an app and its pages. */
const ARCHIVE = bundle([file("app/server.ts", "Bun.serve({ fetch: () => new Response('shop') })"), file("public/index.html", "<h1>shop</h1>")]);

const PEOPLE = { [DEVELOPER]: { shop: "developer" }, [VIEWER]: { shop: "viewer" }, [GUEST]: { shop: "visitor" }, [BILLING_ADMIN]: { billing: "admin", notes: "developer" } } as const;

type Answer = { status: number; json: Record<string, unknown>; text: string };

type Machine = {
  bench: InstallerBench;
  state: string;
  /** The owner's unlock, from the dashboard's password. */
  unlock: string;
  /** The API, as the CLI calls it: the path in full. */
  send: (bearer: string, method: string, path: string, payload?: unknown) => Promise<Answer>;
  /** The archive sent where the deployment said. */
  upload: (bearer: string, id: string) => Promise<Answer>;
  /** The steward's socket, which only root opens. */
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  mint: (scope: Scope) => Promise<{ token: TokenView; secret: string }>;
  /** The installer, as systemd starts it on the steward's request. */
  install: (slug: string) => Promise<Outcome>;
  /** What the steward asked systemctl to start. */
  started: string[];
  /** What the secrets steward asked systemctl, restarts among them. */
  restarted: string[];
  journal: () => LogEntry[];
  registry: () => Registry;
  owners: () => Record<string, string>;
  env: (slug: string) => string;
  deposited: (slug: string) => Manifest;
  /** Everything said, journaled, printed or recorded anywhere but the stores and the legacy files themselves. */
  everything: () => string;
  stop: () => void;
};

const machines: Machine[] = [];
const spies: Mock<(...args: unknown[]) => void>[] = [];
afterEach(() => {
  for (const machine of machines.splice(0)) {
    machine.stop();
    machine.bench.cleanup();
  }
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** A project as the owner deployed it: its manifest, its units and block as `deploy` generates them, its account. */
function deposit(bench: InstallerBench, object: Record<string, unknown> & { slug: string }): void {
  const { manifest, errors } = readManifest(JSON.stringify(object));
  expect(errors).toEqual([]);
  mkdirSync(join(bench.sites, object.slug, "app"), { recursive: true });
  mkdirSync(join(bench.sites, object.slug, "public"), { recursive: true });
  writeFileSync(join(bench.sites, object.slug, "sitesolide.json"), `${JSON.stringify(object, null, 2)}\n`);
  for (const { unit, text } of generateUnits(manifest!)) writeFileSync(join(bench.units, unit.endsWith(".timer") ? unit : `${unit}.service`), text);
  const block = generateFragment(manifest!);
  if (block !== null) writeFileSync(join(bench.blocks, `${object.slug}.caddy`), block);
  const passwd = join(bench.root, "passwd");
  writeFileSync(passwd, `${readFileSync(passwd, "utf8")}site-${object.slug}:x:${OWN_UID}:${OWN_UID}::/nonexistent:/usr/sbin/nologin\n`);
}

/** Every file of a folder, as text: what a process wrote there. */
function folderText(folder: string): string {
  if (!existsSync(folder)) return "";
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
    .join("\n");
}

async function mount(): Promise<Machine> {
  const bench = createBench();
  const folder = (name: string) => {
    mkdirSync(join(bench.root, name), { recursive: true });
    return join(bench.root, name);
  };
  const state = folder("state");
  const results = folder("installer");
  writeFileSync(join(bench.units, INSTALLER_TEMPLATE), "[Service]\n");
  for (const project of [SHOP, BILLING, NOTES, DASHBOARD, PORTAL]) deposit(bench, project);
  // The stores the installer laid when each project in the store's form was deployed.
  for (const slug of ["shop", "notes"]) mkdirSync(join(bench.store, slug, "files"), { recursive: true, mode: 0o700 });
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(bench.secrets, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  // Signing in with a company account set up, acme.test the company's domain: a token's Can open is then the token's to give or not.
  writeFileSync(
    join(bench.secrets, "portal.env"),
    `OIDC_ISSUER=https://id.acme.test\nOIDC_CLIENT_ID=sitesolide\nOIDC_CLIENT_SECRET=${OIDC_SECRET}\nOIDC_ALLOWED_DOMAINS=acme.test\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(bench.secrets, "billing-mail.env"), `MAIL_SECRET=${BILLING_VALUE}\n`, { mode: 0o600 });
  writeRegistry(state, registryOf(PEOPLE));

  const clock = { t: Date.now() };
  const restarted: string[] = [];
  const real = createSystem({
    sitesDir: bench.sites,
    secretsFolder: bench.secrets,
    unitsFolder: bench.units,
    stateFolder: state,
    hashFile: join(bench.secrets, "dashboard.env"),
    accountsFile: join(bench.root, "passwd"),
    caddyFolder: bench.blocks,
    gatekeeperFolder: folder("gatekeeper"),
    codesFile: join(bench.root, "locks-codes.json"),
    locksFragment: join(bench.root, "verrous.caddy"),
    systemctl: "/path/that/does/not/exist",
  });
  const system: System = {
    ...real,
    now: () => clock.t,
    wait: async (ms) => {
      clock.t += ms;
    },
    systemctl: async (arguments_): Promise<Command> => {
      if (arguments_[0] === "show") return { code: 0, output: "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=\n" };
      restarted.push(arguments_.join(" "));
      return { code: 0, output: "" };
    },
  };
  const portalKey = folder("portal-key");
  const members = { ...createMembersSystem({ stateFolder: state, sitesDir: bench.sites, secretsFolder: bench.secrets, portalKeyFolder: portalKey, groupsFile: join(bench.root, "group"), portalGroup: "" }), now: () => clock.t };
  const access = { ...createAccessSystem({ stateFolder: state, portalKeyFolder: portalKey, groupsFile: join(bench.root, "group"), portalGroup: "", portalDataFolder: join(bench.root, "portal-data") }, false), now: () => clock.t };
  let ownerStoreWritten: (slug: string) => Promise<void> = async () => undefined;
  const handler = createSteward(system, {
    secretsFolder: bench.secrets,
    checkAccounts: false,
    members: { system: members, access, zone: ZONE },
    ownerStoreWritten: (slug) => ownerStoreWritten(slug),
  });

  const started: string[] = [];
  const controlReal = createControlSystem({ stateFolder: state, sitesDir: bench.sites, unitsFolder: bench.units, installerFolder: results, systemctl: "/bin/false", journalctl: "/bin/false", backups: null, connectors: null, storeRoot: bench.store });
  const controlSystem: ControlSystem = {
    ...controlReal,
    now: () => clock.t,
    async systemctl(arguments_) {
      if (arguments_[0] === "is-active") return { code: 3, output: "inactive\n" };
      started.push(arguments_.join(" "));
      return { code: 0, output: "" };
    },
    journal: async () => ({ code: 0, output: "-- No entries --\n" }),
  };
  const control = createControlSteward(controlSystem, {
    zone: ZONE,
    isUnlocked: handler.isUnlocked,
    uidRoot: null,
    members: handler.memberAuthority ?? undefined,
    access: handler.accessForToken,
    forgetAccess: handler.forgetProjectAccess,
    secrets: handler.secretsForToken,
    store: handler.storeForToken,
  });
  ownerStoreWritten = control.ownerWroteStore;

  const printed: unknown[][] = [];
  for (const method of ["log", "error", "warn", "info"] as const) {
    const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args));
    spies.push(spy as unknown as Mock<(...args: unknown[]) => void>);
  }

  // The steward's socket, and the dashboard's API on a real port, as dashboard/steward.ts and dashboard/server.ts mount them.
  const answers: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const request = new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await (isControlPath(path) ? control(request) : handler(request));
    answers.push(await response.clone().text());
    return response;
  };
  const socket = join(bench.root, "steward.sock");
  const steward = Bun.serve({ unix: socket, fetch: (req) => control(req) });
  const database = join(bench.root, "dashboard.db");
  const store = createControlStore(openDatabase(database));
  const client = localControlSteward(socket);
  const spool = createSpool(bench.spool);
  const api = createApiRoutes({ steward: client, store, spool, limiter: createLimiter(), tracker: createTracker({ store, steward: client, spool }), stateFile: join(bench.root, "state.json"), publicUrl: `https://dashboard.${ZONE}`, zone: ZONE });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // The token's part of dashboard/server.ts, as it stands there.
    routes: {
      "/api/v1/whoami": { GET: api.whoami },
      "/api/v1/deployments": { POST: api.createDeployment },
      "/api/v1/deployments/:id": { GET: (req) => api.readDeployment(req, req.params.id) },
      "/api/v1/deployments/:id/bundle": { PUT: (req) => api.uploadBundle(req, req.params.id) },
      "/api/v1/projects": { GET: api.projects },
      "/api/v1/projects/:slug": { GET: (req) => api.project(req, req.params.slug) },
      "/api/v1/projects/:slug/logs": { GET: (req) => api.projectLogs(req, req.params.slug) },
      "/api/v1/projects/:slug/access": {
        GET: (req) => api.projectAccess(req, req.params.slug),
        PUT: (req) => api.putProjectAccess(req, req.params.slug),
        DELETE: (req) => api.removeProjectAccess(req, req.params.slug),
      },
      ...secretsRoutes(api),
      ...storeRoutes(api),
      "/api/v1/*": () => failure("not-found", "no such route: see docs/access.md for the control API's routes"),
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  const texts: string[] = [];
  const answered = async (response: Response): Promise<Answer> => {
    const text = await response.text();
    texts.push(text);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: response.status, json, text };
  };
  const address = `http://127.0.0.1:${server.port}`;
  const send = async (bearer: string, method: string, path: string, payload?: unknown) =>
    answered(
      await fetch(`${address}${path}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, "X-Forwarded-For": "198.51.100.9", "Content-Type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
    );
  const upload = async (bearer: string, id: string) =>
    answered(await fetch(`${address}/api/v1/deployments/${id}/bundle`, { method: "PUT", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/gzip" }, body: ARCHIVE }));

  const unlocked = await call("POST", "/unlock", { password: PASSWORD });
  const unlock = ((await unlocked.json()) as { token: string }).token;
  // The owner's values, typed in the dashboard unlocked before any token existed.
  for (const [slug, name, value] of [
    ["shop", "ADMIN_TOKEN", OWNER_ADMIN],
    ["shop", "STRIPE_SECRET_KEY", OWNER_STRIPE],
    ["notes", "AGENT_TOKEN", NOTES_VALUE],
  ] as const) {
    expect((await call("PUT", "/store/variable", { token: unlock, slug, name, value })).status).toBe(200);
  }
  expect((await call("PUT", "/store/file", { token: unlock, slug: "shop", name: "owner.json", content: base64(OWNER_FILE) })).status).toBe(200);

  const echoed: string[] = [];
  const readOr = (path: string) => (existsSync(path) ? readFileSync(path).toString("latin1") : "");
  const machine: Machine = {
    bench,
    state,
    unlock,
    send,
    upload,
    call,
    async mint(scope) {
      const response = await call("POST", "/tokens/create", { token: unlock, label: "colleague", holder: "owner", expiresAt: null, scope });
      expect(response.status).toBe(201);
      return (await response.json()) as { token: TokenView; secret: string };
    },
    async install(slug) {
      const read = readRequest(readFileSync(join(state, "installs", `${slug}.json`), "utf8"), slug, clock.t);
      if (!read.ok) throw new Error(read.reason);
      const reporter = createReporter(results, read.request, Date.now, (line) => echoed.push(line));
      const host = createHost({
        sitesDir: bench.sites,
        unitsFolder: bench.units,
        secretsFolder: bench.secrets,
        storePreviousFolder: join(state, "precedents", "projects"),
        claimsFile: join(state, CLAIMS_NAME),
        spoolFolder: bench.spool,
        accountsFile: join(bench.root, "passwd"),
        projectPortsFile: join(bench.root, "projects.nft"),
        tlsZoneFile: join(bench.root, "tls-zone.caddy"),
        zoneNamesFile: join(bench.root, "zone-names"),
        deployAccount: null,
        dashboardAccount: null,
        extractor: [process.execPath, INSTALLER],
        machine: machineOf(bench),
        commands: commandsOf(bench),
        log: (line) => reporter.log(line),
      });
      const outcome = await runPipeline(host, read.request, { zone: ZONE, runFolder: bench.run });
      reporter.finish(outcome);
      return outcome;
    },
    started,
    restarted,
    journal: () => reread(readOr(join(state, "journal.jsonl"))),
    registry: () => readRegistryFile(state),
    owners: () => (JSON.parse(readOr(join(state, "team.json")) || "{}") as { owners?: Record<string, string> }).owners ?? {},
    env: (slug) => readOr(join(bench.store, slug, "env")),
    deposited: (slug) => readManifest(readFileSync(join(bench.sites, slug, "sitesolide.json"), "utf8")).manifest!,
    everything: () =>
      [
        ...texts,
        ...answers,
        ...["journal.jsonl", "access-log.jsonl", "team.json", CLAIMS_NAME, "access.json", "creations.json"].map((name) => readOr(join(state, name))),
        folderText(join(state, "installs")),
        folderText(results),
        readOr(database),
        readOr(`${database}-wal`),
        printed.map((args) => args.map(String).join(" ")).join("\n"),
        ...echoed,
        ...bench.events,
      ].join("\n"),
    stop: () => {
      server.stop(true);
      steward.stop(true);
    },
  };
  machines.push(machine);
  return machine;
}

/** Nothing the machine holds or the token sent, in anything said, journaled, printed or recorded; `more`: a value drawn on the machine. */
function expectNoValue(machine: Machine, more: string[] = []): void {
  const everything = machine.everything();
  for (const value of [...PLANTED, ...more]) expect(everything).not.toContain(value);
}

/** A deployment as `sitesolide deploy` makes it: the manifest judged, then the archive. */
async function deploy(machine: Machine, bearer: string, manifest: object): Promise<{ created: Answer; uploaded: Answer | null; id: string | null }> {
  const created = await machine.send(bearer, "POST", "/api/v1/deployments", { manifest });
  if (created.status !== 201) return { created, uploaded: null, id: null };
  const id = (created.json.deployment as { id: string }).id;
  return { created, uploaded: await machine.upload(bearer, id), id };
}

/** A deployment followed to its end, as the CLI follows it once the installer has run. */
async function deployed(machine: Machine, bearer: string, manifest: object): Promise<{ outcome: Outcome; read: Answer }> {
  const { created, uploaded, id } = await deploy(machine, bearer, manifest);
  expect(created.status).toBe(201);
  expect(created.json.deployment).toMatchObject({ slug: "shop", creating: false, state: "awaiting-bundle" });
  expect(uploaded).toMatchObject({ status: 202, json: { deployment: { id, state: "running" } } });
  const outcome = await machine.install("shop");
  return { outcome, read: await machine.send(bearer, "GET", `/api/v1/deployments/${id}`) };
}

const store = (slug: string) => `/api/v1/projects/${slug}/store`;

describe("a colleague's token scoped to one project", () => {
  test("it is what the owner minted, and reaches shop alone: who it is, its projects, their status and logs", async () => {
    const m = await mount();
    const { token, secret } = await m.mint(COLLEAGUE);
    expect(token.scope).toEqual(COLLEAGUE);
    const who = await m.send(secret, "GET", "/api/v1/whoami");
    expect(who).toMatchObject({ status: 200, json: { identity: { id: token.id, email: "owner", member: null, owned: [], scope: COLLEAGUE } } });
    const projects = await m.send(secret, "GET", "/api/v1/projects");
    expect(projects.status).toBe(200);
    expect((projects.json.projects as { slug: string }[]).map((project) => project.slug)).toEqual(["shop"]);
    expect((await m.send(secret, "GET", "/api/v1/projects/shop")).status).toBe(200);
    expect(await m.send(secret, "GET", "/api/v1/projects/shop/logs")).toMatchObject({ status: 200, json: { lines: [] } });
    for (const slug of ["billing", "notes", "dashboard", "portal"]) {
      expect(await m.send(secret, "GET", `/api/v1/projects/${slug}`)).toMatchObject({ status: 404, json: { error: "not-found" } });
      expect(await m.send(secret, "GET", `/api/v1/projects/${slug}/logs`)).toMatchObject({ status: 404, json: { error: "not-found" } });
    }
    expectNoValue(m);
  });

  test("a deployment of shop is accepted and installed; one asking for a door or a domain switched on gets neither, the machine's stand; a preview lock is refused", async () => {
    const m = await mount();
    const { secret } = await m.mint(COLLEAGUE);
    const preflight = await m.call("POST", "/control/preflight", { bearer: secret, slug: "shop" });
    expect(await preflight.json()).toEqual({ creating: false, placeholders: { zone: ZONE, contact: "" } });

    const first = await deployed(m, secret, DEPLOYED);
    expect(first.outcome).toMatchObject({ ok: true, url: `https://shop.${ZONE}/` });
    expect(first.read).toMatchObject({ status: 200, json: { deployment: { slug: "shop", state: "succeeded", error: null } } });
    expect(m.started).toEqual([`start --no-block ${installerUnit("shop")}`]);
    expect(m.bench.events).toContain("systemctl restart shop");
    const after = m.deposited("shop");
    expect(after.portal).toBeUndefined();
    expect(after.network).toBe("outbound");
    expect(after.domain).toEqual({ name: "shop.example.test", aliases: ["www.shop.example.test"], active: false });
    expect(fragmentIsProtected(readFileSync(join(m.bench.blocks, "shop.caddy"), "utf8"))).toBe(false);

    // Behind the portal, and its domain switched on: the deployment goes through, and the machine keeps both as they were.
    const second = await deployed(m, secret, { ...DEPLOYED, portal: true, domain: { ...SHOP.domain, active: true } });
    expect(second.outcome.ok).toBe(true);
    expect(second.read.json.deployment).toMatchObject({ state: "succeeded" });
    expect(m.deposited("shop").portal).toBeUndefined();
    expect(m.deposited("shop").domain?.active).toBe(false);
    expect(fragmentIsProtected(readFileSync(join(m.bench.blocks, "shop.caddy"), "utf8"))).toBe(false);

    // A preview code is never a deployment's.
    const locked = await deploy(m, secret, { ...DEPLOYED, lock: true });
    expect(locked.created).toMatchObject({ status: 422, json: { error: "invalid-manifest", details: [expect.stringContaining("lock: a preview code is chosen")] } });
    expect(locked.uploaded).toBeNull();
    // The dashboard's own record of the deployments is among what is searched.
    expect(m.everything()).toContain("deploy.start");
    expectNoValue(m);
  });

  test("its secrets: names listed, a value set, drawn, replaced and removed, a file set and removed, its service restarted; journaled under the token, names alone", async () => {
    const m = await mount();
    const { token, secret } = await m.mint(COLLEAGUE);

    const listed = await m.send(secret, "GET", store("shop"));
    expect(listed.status).toBe(200);
    const view = listed.json.store as StoreView;
    expect(view.variables.filter((variable) => variable.source === "store").map((variable) => variable.name).sort()).toEqual(["ADMIN_TOKEN", "STRIPE_SECRET_KEY"]);
    expect(view.missing.sort()).toEqual(["MAPS_API_KEY", "SEARCH_API_KEY", "SMTP_PASSWORD", "SMTP_USER", "STRIPE_WEBHOOK_SECRET"]);
    expect(view.files).toEqual([expect.objectContaining({ name: "owner.json", state: "set", bytes: null })]);
    expect(view.may).toEqual({ write: true, reveal: false, restore: false, migrate: false });
    // The route of before lists the files a legacy project reads: none here.
    expect(await m.send(secret, "GET", "/api/v1/projects/shop/secrets")).toMatchObject({ status: 200, json: { secrets: { slug: "shop", files: [] } } });

    expect(await m.send(secret, "PATCH", store("shop"), { set: { SEARCH_API_KEY: TYPED } })).toMatchObject({ status: 200, json: { created: false, set: ["SEARCH_API_KEY"] } });
    expect(m.env("shop")).toContain(`SEARCH_API_KEY=${TYPED}`);
    expect(await m.send(secret, "POST", `${store("shop")}/generate`, { name: "STRIPE_WEBHOOK_SECRET" })).toMatchObject({ status: 200, json: { generated: ["STRIPE_WEBHOOK_SECRET"] } });
    const drawn = /^STRIPE_WEBHOOK_SECRET=([0-9a-f]{64})$/m.exec(m.env("shop"))?.[1];
    expect(drawn).toBeDefined();
    // The owner's value, replaced only when asked to.
    expect(await m.send(secret, "POST", `${store("shop")}/generate`, { name: "ADMIN_TOKEN" })).toMatchObject({ status: 409, json: { error: "already-present" } });
    expect(m.env("shop")).toContain(`ADMIN_TOKEN=${OWNER_ADMIN}`);
    expect(await m.send(secret, "POST", `${store("shop")}/generate`, { name: "ADMIN_TOKEN", replace: true })).toMatchObject({ status: 200, json: { generated: ["ADMIN_TOKEN"] } });
    const replaced = /^ADMIN_TOKEN=([0-9a-f]{64})$/m.exec(m.env("shop"))?.[1];
    expect(replaced).toBeDefined();
    expect(await m.send(secret, "PATCH", store("shop"), { remove: ["SEARCH_API_KEY"] })).toMatchObject({ status: 200, json: { removed: ["SEARCH_API_KEY"] } });
    expect(m.env("shop")).not.toContain("SEARCH_API_KEY=");
    expect(m.env("shop")).toContain(`STRIPE_SECRET_KEY=${OWNER_STRIPE}`);

    expect(await m.send(secret, "PUT", `${store("shop")}/files/gcp.json`, { content: base64(TYPED_FILE) })).toMatchObject({ status: 200, json: { files: { set: ["gcp.json"] } } });
    expect(readFileSync(join(m.bench.store, "shop", "files", "gcp.json"), "utf8")).toBe(TYPED_FILE);
    expect(await m.send(secret, "DELETE", `${store("shop")}/files/gcp.json`)).toMatchObject({ status: 200, json: { files: { removed: ["gcp.json"] } } });
    expect(readdirSync(join(m.bench.store, "shop", "files"))).toEqual(["owner.json"]);

    expect(await m.send(secret, "POST", "/api/v1/projects/shop/restart")).toMatchObject({ status: 200, json: { verdict: { kind: "active" } } });
    const withRestart = await m.send(secret, "PATCH", store("shop"), { set: { MAPS_API_KEY: TYPED }, restart: true });
    expect(withRestart).toMatchObject({ status: 200, json: { set: ["MAPS_API_KEY"], restart: { verdict: { kind: "active" } } } });
    expect(m.restarted.filter((line) => line.startsWith("restart "))).toEqual(["restart shop", "restart shop"]);

    // The route of before, on a project that keeps its variables in its store: told to update, nothing written.
    expect(await m.send(secret, "PATCH", "/api/v1/projects/shop/secrets/shop.env", { set: { SEARCH_API_KEY: TYPED } })).toMatchObject({ status: 403, json: { error: "out-of-scope", message: STORE_FORM } });
    expect(existsSync(join(m.bench.secrets, "shop.env"))).toBe(false);

    const own = m.journal().filter((entry) => entry.actor === `token:${token.id}`);
    expect(own.filter((entry) => entry.result === "ok").length).toBeGreaterThanOrEqual(7);
    expect(own.every((entry) => entry.slug === "shop")).toBe(true);
    expect(m.everything()).toContain("STRIPE_WEBHOOK_SECRET");
    expectNoValue(m, [drawn!, replaced!]);
  });

  test("no value comes back, on shop either: no route of the API, nor of the steward's token routes, reads one", async () => {
    const m = await mount();
    const { secret } = await m.mint(COLLEAGUE);
    for (const [method, path, payload] of [
      ["GET", `${store("shop")}/files/owner.json`, undefined],
      ["POST", `${store("shop")}/value`, { name: "ADMIN_TOKEN" }],
      ["GET", `${store("shop")}/variables/ADMIN_TOKEN`, undefined],
      ["POST", `${store("shop")}/restore`, {}],
      ["POST", `${store("shop")}/migrate`, {}],
      ["GET", "/api/v1/projects/shop/secrets/shop.env", undefined],
      ["POST", "/api/v1/projects/shop/secrets/value", { name: "ADMIN_TOKEN" }],
    ] as const) {
      const answer = await m.send(secret, method, path, payload);
      expect([404, 405]).toContain(answer.status);
    }
    for (const path of ["/control/store/value", "/control/secrets/value", "/control/store/restore"]) {
      expect((await m.call("POST", path, { bearer: secret, slug: "shop", name: "ADMIN_TOKEN" })).status).toBe(404);
    }
    const listed = await m.send(secret, "GET", store("shop"));
    expect(listed.status).toBe(200);
    expectNoValue(m);
  });

  test("the others: billing and notes are neither deployed, listed, written nor restarted, their stores and legacy files as the owner left them", async () => {
    const m = await mount();
    const { token, secret } = await m.mint(COLLEAGUE);
    const before = { billing: readFileSync(join(m.bench.secrets, "billing-mail.env"), "utf8"), notes: m.env("notes"), journal: m.journal().length };

    // Deployed through the API: billing's own manifest is refused for its files before the steward is asked; stripped of them, and notes, by the steward.
    const billing = await deploy(m, secret, BILLING);
    expect(billing.created).toMatchObject({ status: 422, json: { error: "invalid-manifest", details: expect.arrayContaining([expect.stringContaining("billing-mail.env is not its own")]) } });
    const { secrets: _files, ...billingBare } = BILLING;
    for (const manifest of [billingBare, NOTES]) {
      const refused = await deploy(m, secret, manifest);
      expect(refused.created).toMatchObject({ status: 403, json: { error: "out-of-scope", message: expect.stringContaining("already exists on the machine and your token may not deploy it") } });
      expect(refused.uploaded).toBeNull();
    }
    // And on the steward itself, whatever a dashboard relays.
    for (const [slug, manifest] of [["billing", BILLING], ["notes", NOTES]] as const) {
      expect(await (await m.call("POST", "/control/preflight", { bearer: secret, slug })).json()).toMatchObject({ error: "out-of-scope" });
      const direct = await m.call("POST", "/control/deploy", { bearer: secret, deployment: "abcdefabcdefabcdefabcdef", slug, manifest: JSON.stringify(manifest) });
      expect(direct.status).toBe(403);
    }
    expect(m.started).toEqual([]);
    expect(existsSync(join(m.state, "installs"))).toBe(false);

    for (const slug of ["billing", "notes"]) {
      for (const [method, path, payload] of [
        ["GET", store(slug), undefined],
        ["PATCH", store(slug), { set: { AGENT_TOKEN: TYPED } }],
        ["PATCH", store(slug), { remove: ["AGENT_TOKEN"] }],
        ["POST", `${store(slug)}/generate`, { name: "AGENT_TOKEN", replace: true }],
        ["PUT", `${store(slug)}/files/gcp.json`, { content: base64(TYPED_FILE) }],
        ["DELETE", `${store(slug)}/files/gcp.json`, undefined],
        ["GET", `/api/v1/projects/${slug}/secrets`, undefined],
        ["PATCH", `/api/v1/projects/${slug}/secrets/${slug}.env`, { set: { MAIL_SECRET: TYPED } }],
        ["PATCH", `/api/v1/projects/${slug}/secrets/billing-mail.env`, { set: { MAIL_SECRET: TYPED } }],
        ["PATCH", `/api/v1/projects/${slug}/secrets/notes.env`, { remove: ["AGENT_TOKEN"] }],
        ["POST", `/api/v1/projects/${slug}/restart`, undefined],
      ] as const) {
        expect(await m.send(secret, method, path, payload)).toMatchObject({ status: 404, json: { error: "not-found" } });
      }
    }
    expect(readFileSync(join(m.bench.secrets, "billing-mail.env"), "utf8")).toBe(before.billing);
    expect(m.env("notes")).toBe(before.notes);
    expect(readdirSync(join(m.bench.store, "notes", "files"))).toEqual([]);
    expect(existsSync(join(m.bench.store, "billing"))).toBe(false);
    expect(existsSync(join(m.bench.secrets, "billing.env"))).toBe(false);
    expect(existsSync(join(m.bench.secrets, "notes.env"))).toBe(false);
    expect(m.restarted).toEqual([]);
    // A project out of reach reads as unknown, and is never journaled: a guess learns nothing.
    expect(m.journal()).toHaveLength(before.journal);
    expect(m.journal().some((entry) => entry.actor === `token:${token.id}`)).toBe(false);
    expectNoValue(m);
  });

  test("no new project: none deployed under any new name, no store written ahead for one, a platform's name neither", async () => {
    const m = await mount();
    const { secret } = await m.mint(COLLEAGUE);
    for (const slug of ["shop-staging", "newsite"]) {
      const refused = await deploy(m, secret, { ...DEPLOYED, slug, domain: undefined });
      expect(refused.created).toMatchObject({ status: 403, json: { error: "out-of-scope", message: expect.stringContaining("your token may not create projects") } });
      expect(await (await m.call("POST", "/control/deploy", { bearer: secret, deployment: "bcdefabcdefabcdefabcdefa", slug, manifest: JSON.stringify({ ...DEPLOYED, slug, domain: undefined }) })).json()).toMatchObject({ error: "out-of-scope" });
      for (const [method, path, payload] of [
        ["GET", store(slug), undefined],
        ["PATCH", store(slug), { set: { ADMIN_TOKEN: TYPED } }],
        ["POST", `${store(slug)}/generate`, { name: "ADMIN_TOKEN" }],
        ["PUT", `${store(slug)}/files/gcp.json`, { content: base64(TYPED_FILE) }],
        ["DELETE", `${store(slug)}/files/gcp.json`, undefined],
        ["POST", `/api/v1/projects/${slug}/restart`, undefined],
      ] as const) {
        expect(await m.send(secret, method, path, payload)).toMatchObject({ status: 404, json: { error: "not-found" } });
      }
      expect(existsSync(join(m.bench.store, slug))).toBe(false);
      expect(existsSync(join(m.bench.sites, slug))).toBe(false);
    }
    const platform = await deploy(m, secret, DASHBOARD);
    expect(platform.created).toMatchObject({ status: 403, json: { error: "reserved" } });
    for (const slug of ["dashboard", "portal"]) {
      expect(await m.send(secret, "PATCH", store(slug), { set: { PASSWORD_HASH: TYPED } })).toMatchObject({ status: 404, json: { error: "not-found" } });
      expect(await m.send(secret, "PATCH", `/api/v1/projects/${slug}/secrets/${slug}.env`, { set: { PASSWORD_HASH: TYPED } })).toMatchObject({ status: 404, json: { error: "not-found" } });
    }
    expect(m.owners()).toEqual({});
    expect(m.started).toEqual([]);
    expectNoValue(m);
  });

  test("its people: listed, but nobody given a role above Can open, raised, lowered or removed above it, given password access, and shop's general access not changed", async () => {
    const m = await mount();
    const { secret } = await m.mint(COLLEAGUE);
    const seeded = encodeRegistry(m.registry());
    const listed = await m.send(secret, "GET", "/api/v1/projects/shop/access");
    expect(listed).toMatchObject({ status: 200, json: { access: { slug: "shop", general: { access: "public" } } } });

    for (const [method, payload, status] of [
      ["PUT", { who: NEWCOMER, role: "viewer" }, 403],
      ["PUT", { who: NEWCOMER, role: "developer" }, 403],
      ["PUT", { who: NEWCOMER, role: "admin" }, 403],
      ["PUT", { who: GUEST, role: "developer" }, 403],
      ["PUT", { who: DEVELOPER, role: "visitor" }, 403],
      ["PUT", { who: VIEWER, role: "admin" }, 403],
      ["DELETE", { who: DEVELOPER }, 403],
      ["DELETE", { who: VIEWER }, 403],
      ["PUT", { who: OUTSIDER }, 403],
      ["PUT", { who: "@elsewhere.test" }, 400],
      ["PUT", { who: NEWCOMER, general: "restricted" }, 400],
      ["PUT", { who: NEWCOMER, role: "visitor", portal: true }, 400],
    ] as const) {
      const answer = await m.send(secret, method, "/api/v1/projects/shop/access", payload);
      expect({ payload, status: answer.status }).toEqual({ payload, status });
    }
    // No route of the API changes a site's general access, or a person.
    for (const [method, path] of [
      ["POST", "/api/v1/projects/shop/general"],
      ["PUT", "/api/v1/projects/shop/general"],
      ["GET", "/api/v1/people"],
      ["PUT", `/api/v1/people/${NEWCOMER}`],
      ["DELETE", `/api/v1/people/${DEVELOPER}`],
    ] as const) {
      expect(await m.send(secret, method, path, method === "GET" ? undefined : { access: "restricted", create: true })).toMatchObject({ status: 404, json: { error: "not-found", message: expect.stringContaining("no such route") } });
    }
    // Another project's people: unknown.
    for (const [method, payload] of [
      ["GET", undefined],
      ["PUT", { who: NEWCOMER }],
      ["DELETE", { who: BILLING_ADMIN }],
    ] as const) {
      for (const slug of ["billing", "notes"]) expect(await m.send(secret, method, `/api/v1/projects/${slug}/access`, payload)).toMatchObject({ status: 404, json: { error: "not-found" } });
    }
    expect(encodeRegistry(m.registry())).toBe(seeded);
    expect(m.deposited("shop").portal).toBeUndefined();
    expect(fragmentIsProtected(readFileSync(join(m.bench.blocks, "shop.caddy"), "utf8"))).toBe(false);
    expectNoValue(m);
  });

  // A token gives Can open on the projects it reaches, by design (docs/access.md).
  test("it gives Can open on shop to a company account", async () => {
    const m = await mount();
    const { token, secret } = await m.mint(COLLEAGUE);
    const given = await m.send(secret, "PUT", "/api/v1/projects/shop/access", { who: NEWCOMER, role: "visitor" });
    expect(given).toMatchObject({ status: 201, json: { change: "add", entry: { who: NEWCOMER, kind: "person", role: "visitor", by: `token:${token.id}` } } });
    expect(m.registry().projects.shop?.some((entry) => entry.who === NEWCOMER && entry.role === "visitor")).toBe(true);
    expectNoValue(m);
  });

  // A token gives Can open on the projects it reaches, by design (docs/access.md).
  test("it gives Can open on shop to the company's whole domain", async () => {
    const m = await mount();
    const { token, secret } = await m.mint(COLLEAGUE);
    const given = await m.send(secret, "PUT", "/api/v1/projects/shop/access", { who: "@acme.test" });
    expect(given).toMatchObject({ status: 201, json: { change: "add", entry: { who: "@acme.test", kind: "domain", role: "visitor", by: `token:${token.id}` } } });
    expect(m.registry().projects.shop?.some((entry) => entry.who === "@acme.test" && entry.role === "visitor")).toBe(true);
    expectNoValue(m);
  });

  // A token gives Can open on the projects it reaches, by design (docs/access.md), and takes it off.
  test("it takes someone's Can open off shop", async () => {
    const m = await mount();
    const { secret } = await m.mint(COLLEAGUE);
    const taken = await m.send(secret, "DELETE", "/api/v1/projects/shop/access", { who: GUEST });
    expect(taken).toMatchObject({ status: 200, json: { change: "remove", entry: { who: GUEST, role: "visitor" } } });
    expect(m.registry().projects.shop?.some((entry) => entry.who === GUEST)).toBe(false);
    expectNoValue(m);
  });

  test("another project's domain is never shop's: a name or an alias billing declares stops the installer before anything is written, an address under the zone is refused before any upload", async () => {
    const m = await mount();
    const { secret } = await m.mint(COLLEAGUE);
    const before = { shop: readFileSync(join(m.bench.sites, "shop", "sitesolide.json"), "utf8"), billing: readFileSync(join(m.bench.sites, "billing", "sitesolide.json"), "utf8") };
    for (const domain of [
      { name: "billing.example.test", aliases: ["www.billing.example.test"] },
      { name: "shop.example.test", aliases: ["www.shop.example.test", "www.billing.example.test"] },
    ]) {
      const { outcome, read } = await deployed(m, secret, { ...DEPLOYED, domain });
      expect(outcome).toMatchObject({ ok: false, code: "domain-taken", message: expect.stringContaining("www.billing.example.test is already declared by project billing") });
      expect(read).toMatchObject({ status: 200, json: { deployment: { state: "failed", error: { code: "domain-taken" } } } });
    }
    expect(readFileSync(join(m.bench.sites, "shop", "sitesolide.json"), "utf8")).toBe(before.shop);
    expect(readFileSync(join(m.bench.sites, "billing", "sitesolide.json"), "utf8")).toBe(before.billing);
    expect(m.bench.events).not.toContain("systemctl restart shop");
    for (const domain of [{ name: `notes.${ZONE}` }, { name: "shop.example.test", aliases: [`billing.${ZONE}`] }]) {
      const refused = await deploy(m, secret, { ...DEPLOYED, domain });
      expect(refused.created).toMatchObject({ status: 422, json: { error: "invalid-manifest" } });
      expect(refused.uploaded).toBeNull();
    }
    expectNoValue(m);
  });

  test("the same token without secrets: deploys shop and restarts it, and lists, sets, draws or removes none of its secrets", async () => {
    const m = await mount();
    const { token, secret } = await m.mint({ ...COLLEAGUE, secrets: false });
    const before = { env: m.env("shop"), files: readdirSync(join(m.bench.store, "shop", "files")) };

    const { outcome, read } = await deployed(m, secret, DEPLOYED);
    expect(outcome.ok).toBe(true);
    expect(read.json.deployment).toMatchObject({ state: "succeeded" });
    expect(await m.send(secret, "POST", "/api/v1/projects/shop/restart")).toMatchObject({ status: 200, json: { verdict: { kind: "active" } } });

    for (const [method, path, payload] of [
      ["GET", store("shop"), undefined],
      ["PATCH", store("shop"), { set: { SEARCH_API_KEY: TYPED } }],
      ["PATCH", store("shop"), { remove: ["ADMIN_TOKEN"] }],
      ["POST", `${store("shop")}/generate`, { name: "ADMIN_TOKEN", replace: true }],
      ["PUT", `${store("shop")}/files/gcp.json`, { content: base64(TYPED_FILE) }],
      ["DELETE", `${store("shop")}/files/owner.json`, undefined],
      ["GET", "/api/v1/projects/shop/secrets", undefined],
      ["PATCH", "/api/v1/projects/shop/secrets/shop.env", { set: { SEARCH_API_KEY: TYPED } }],
    ] as const) {
      expect(await m.send(secret, method, path, payload)).toMatchObject({ status: 403, json: { error: "out-of-scope", message: expect.stringContaining("this token may not manage secrets") } });
    }
    expect(m.env("shop")).toBe(before.env);
    expect(readdirSync(join(m.bench.store, "shop", "files"))).toEqual(before.files);
    const refusals = m.journal().filter((entry) => entry.actor === `token:${token.id}`);
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((entry) => entry.result === "rejects" || entry.operation === "restart")).toBe(true);
    expect(refusals.filter((entry) => entry.result === "rejects").every((entry) => entry.detail === "no secrets permission")).toBe(true);
    expectNoValue(m);
  });
});
