import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../borrowed/bundle";
import { openDatabase } from "../src/database";
import { createApiRoutes } from "../src/control/api";
import { localControlSteward } from "../src/control/client";
import { createLimiter } from "../src/control/limiter";
import { INSTALLER_TEMPLATE, type DeploymentView, type Identity } from "../src/control/protocol";
import { createSpool } from "../src/control/spool";
import { createControlSteward } from "../src/control/steward";
import { createControlStore, type ControlStore } from "../src/control/store";
import { createControlSystem, type ControlSystem } from "../src/control/system";
import { createTracker } from "../src/control/tracker";
import type { Raw } from "../src/state";
import { readRequest } from "../src/installer/instance";
import { createReporter } from "../src/installer/main";
import { runPipeline } from "../src/installer/pipeline";
import { createBench, file, hostOf, ZONE, type Bench } from "./installer-bench";

/**
 * The whole chain on the workstation, each piece the real one: the dashboard's
 * API on a real port, the steward's control routes on a real Unix socket, the
 * steward's registry and request files, and the installer's pipeline started
 * when the steward asks systemd for `sitesolide-installer@<slug>.service`,
 * writing its result where the steward reads it. Only what needs root or a
 * machine is simulated (installer-bench.ts), and `systemctl` itself.
 */

const UNLOCK = "unlock-token-of-the-secrets-routes";
const SCOPE = { slugs: [], create: true, outbound: false, domain: false, public: false };

let root: string;
let bench: Bench;
let store: ControlStore;
let steward: ReturnType<typeof Bun.serve>;
let dashboard: ReturnType<typeof Bun.serve>;
let base: string;
let secret: string;
let other: string;
let tick: () => Promise<void>;
const installs: Promise<void>[] = [];

async function startInstaller(system: ControlSystem, slug: string): Promise<void> {
  const text = readFileSync(join(root, "state", "installs", `${slug}.json`), "utf8");
  const read = readRequest(text, slug, Date.now());
  if (!read.ok) throw new Error(read.reason);
  const reporter = createReporter(join(root, "installer"), read.request, Date.now, () => {});
  const outcome = await runPipeline(hostOf(bench, (line) => reporter.log(line)), read.request, { zone: ZONE, runFolder: bench.run });
  reporter.finish(outcome);
  void system;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "control-api-"));
  bench = createBench();
  for (const folder of ["state", "units", "installer"]) mkdirSync(join(root, folder));
  writeFileSync(join(root, "units", INSTALLER_TEMPLATE), "[Service]\n");

  const real = createControlSystem({
    stateFolder: join(root, "state"),
    sitesDir: bench.sites,
    unitsFolder: join(root, "units"),
    installerFolder: join(root, "installer"),
    systemctl: "/bin/false",
    journalctl: "/bin/false",
  });
  const system: ControlSystem = {
    ...real,
    async systemctl(arguments_) {
      const unit = /^sitesolide-installer@([a-z0-9-]+)\.service$/.exec(arguments_.at(-1) ?? "");
      if (arguments_[0] === "start" && unit !== null) installs.push(startInstaller(system, unit[1]!));
      if (arguments_[0] === "is-active") return { code: 3, output: "inactive\n" };
      return { code: 0, output: "" };
    },
    journal: async () => ({ code: 0, output: "2026-10-04T10:00:00+0000 vm shop[1]: listening\n-- cursor: s=1\n" }),
  };
  const control = createControlSteward(system, { zone: ZONE, isUnlocked: async (token) => token === UNLOCK, uidRoot: null });
  const socket = join(root, "steward.sock");
  steward = Bun.serve({ unix: socket, fetch: control });

  store = createControlStore(openDatabase(join(root, "dashboard.db")));
  const client = localControlSteward(socket);
  const spool = createSpool(bench.spool);
  const tracker = createTracker({ store, steward: client, spool });
  tick = tracker.tick;
  const api = createApiRoutes({ steward: client, store, spool, limiter: createLimiter(), tracker, stateFile: join(root, "state.json"), publicUrl: "http://dashboard.test-zone.invalid", zone: ZONE });
  dashboard = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/api/v1/whoami": { GET: api.whoami },
      "/api/v1/deployments": { POST: api.createDeployment },
      "/api/v1/deployments/:id": { GET: (req) => api.readDeployment(req, req.params.id) },
      "/api/v1/deployments/:id/bundle": { PUT: (req) => api.uploadBundle(req, req.params.id) },
      "/api/v1/projects": { GET: api.projects },
      "/api/v1/projects/:slug": { GET: (req) => api.project(req, req.params.slug) },
      "/api/v1/projects/:slug/logs": { GET: (req) => api.projectLogs(req, req.params.slug) },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  base = `http://127.0.0.1:${dashboard.port}`;

  const create = async (scope: object) => {
    const response = await control(
      new Request("http://steward/team/tokens", {
        method: "POST",
        body: JSON.stringify({ token: UNLOCK, label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope }),
      }),
    );
    return ((await response.json()) as { secret: string }).secret;
  };
  secret = await create(SCOPE);
  other = await create(SCOPE);
});

afterAll(() => {
  steward.stop(true);
  dashboard.stop(true);
  rmSync(root, { recursive: true, force: true });
  bench.cleanup();
});

function api(path: string, init: RequestInit & { token?: string; address?: string } = {}): Promise<Response> {
  const { token = secret, address = "198.51.100.7", ...rest } = init;
  return fetch(`${base}${path}`, {
    ...rest,
    headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": address, "Content-Type": "application/json", ...(rest.headers ?? {}) },
  });
}

async function follow(id: string, token = secret): Promise<DeploymentView> {
  for (let attempt = 0; attempt < 200; attempt++) {
    await Promise.all(installs);
    const view = ((await (await api(`/api/v1/deployments/${id}`, { token })).json()) as { deployment: DeploymentView }).deployment;
    if (view.state !== "running") return view;
    await Bun.sleep(25);
  }
  throw new Error("the deployment never finished");
}

describe("a deployment, from the manifest to the site", () => {
  test("whoami says who the token is", async () => {
    const identity = ((await (await api("/api/v1/whoami")).json()) as { identity: Identity }).identity;
    expect(identity).toMatchObject({ email: "ada@test-zone.invalid", scope: SCOPE, owned: [] });
  });

  test("manifest, archive, installer, result: a private site, its port chosen on the machine", async () => {
    const created = await api("/api/v1/deployments", { method: "POST", body: JSON.stringify({ manifest: { slug: "shop", start: "/usr/local/bin/bun run server.ts", publicDir: "public" } }) });
    expect(created.status).toBe(201);
    const deployment = ((await created.json()) as { deployment: DeploymentView }).deployment;
    expect(deployment).toMatchObject({ slug: "shop", state: "awaiting-bundle", creating: true });
    expect(deployment.uploadUrl).toBe(`http://dashboard.test-zone.invalid/api/v1/deployments/${deployment.id}/bundle`);

    const archive = bundle([file("app/server.ts", "Bun.serve({})"), file("public/index.html", "<h1>shop</h1>")]);
    const uploaded = await api(`/api/v1/deployments/${deployment.id}/bundle`, { method: "PUT", body: archive, headers: { "Content-Type": "application/gzip" } });
    expect(uploaded.status).toBe(202);

    const done = await follow(deployment.id);
    expect(done).toMatchObject({ state: "succeeded", url: `https://shop.${ZONE}/`, allocated: [{ service: null, port: 3002 }], error: null });
    expect(done.log).toContain("-> archive, extracted as the project's own account");
    expect(readFileSync(join(bench.sites, "shop", "public", "index.html"), "utf8")).toBe("<h1>shop</h1>");
    expect(JSON.parse(readFileSync(join(bench.sites, "shop", "sitesolide.json"), "utf8"))).toMatchObject({ portal: true, port: 3002 });

    // The log from an index on, for a client that already read the start.
    const tail = ((await (await api(`/api/v1/deployments/${deployment.id}?after=${done.next - 1}`)).json()) as { deployment: DeploymentView }).deployment;
    expect(tail.log).toEqual([done.log.at(-1)!]);

    // The audit says who started it and how it ended, once each, and the spool is empty.
    await tick();
    const actions = store.listAudit(10, "deploy.").map((entry) => `${entry.action} ${entry.actor.startsWith("token:")} ${entry.target}`);
    expect(actions).toEqual(["deploy.success true shop", "deploy.start true shop"]);
    expect(existsSync(join(bench.spool, deployment.id))).toBe(false);
  });

  test("the project is the token's now: listed, its journal readable, closed to another token", async () => {
    const projects = (await (await api("/api/v1/projects")).json()) as { projects: { slug: string; access: string }[] };
    expect(projects.projects).toEqual([expect.objectContaining({ slug: "shop", access: "owned" })]);
    const logs = await (await api("/api/v1/projects/shop/logs?lines=20")).json();
    expect(logs).toEqual({ lines: ["2026-10-04T10:00:00+0000 vm shop[1]: listening"], cursor: "s=1" });
    expect((await api("/api/v1/projects/shop", { token: other })).status).toBe(404);
    const taken = await api("/api/v1/deployments", { token: other, method: "POST", body: JSON.stringify({ manifest: { slug: "shop", start: "x", publicDir: "public" } }) });
    expect(taken.status).toBe(403);
    expect(((await taken.json()) as { message: string }).message).toContain("belongs to another token");
  });

});

describe("refusals an agent can act on", () => {
  test("a manifest the scope refuses: every reason in details, before any upload", async () => {
    const response = await api("/api/v1/deployments", {
      method: "POST",
      body: JSON.stringify({ manifest: { slug: "blog", start: "x", publicDir: "public", network: "outbound", secrets: ["dashboard.env"] } }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; details: string[] };
    expect(body.error).toBe("invalid-manifest");
    expect(body.details.join(" ")).toContain("network");
    expect(body.details.join(" ")).toContain("dashboard.env");
  });

  test("a manifest validate() refuses, as the CLI would", async () => {
    const response = await api("/api/v1/deployments", { method: "POST", body: JSON.stringify({ manifest: { slug: "blog", publicDir: "public", portal: "yes" } }) });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { details: string[] }).details).toContain("portal: true, or absent");
  });

  test("a reserved slug", async () => {
    const response = await api("/api/v1/deployments", { method: "POST", body: JSON.stringify({ manifest: { slug: "dashboard", start: "x", publicDir: "public" } }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "reserved" });
  });

  test("a reserved slug the machine serves in the open is still reserved, not a door to ask for", async () => {
    // The snapshot shows the dashboard public, as on a real machine: judged on
    // its door first, a private token got 422 "this site is public on the
    // machine", and was told to ask the owner for what nobody can grant.
    const snapshot: Raw = {
      generated: Date.now(),
      zone: ZONE,
      folders: [{ slug: "dashboard", manifest: JSON.stringify({ slug: "dashboard", port: 3022, start: "/usr/local/bin/bun server.ts" }), unit: null, bytes: 1024, deployed: Date.now() }],
      codes: "{}",
      domains: null,
      ports: [],
      blocks: { dashboard: "reverse_proxy 127.0.0.1:3022" },
      machine: null,
      previous: null,
    };
    writeFileSync(join(root, "state.json"), JSON.stringify(snapshot));
    try {
      for (const manifest of [
        { slug: "dashboard", start: "x", publicDir: "public" },
        { slug: "dashboard", publicDir: "public", secrets: ["dashboard.env"] },
      ]) {
        const response = await api("/api/v1/deployments", { method: "POST", body: JSON.stringify({ manifest }) });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: "reserved", message: expect.stringContaining("pick another slug") });
      }
    } finally {
      rmSync(join(root, "state.json"), { force: true });
    }
  });

  test("an upload that is not gzip, and a deployment that is another token's", async () => {
    const created = await api("/api/v1/deployments", { method: "POST", body: JSON.stringify({ manifest: { slug: "notes", start: "x", publicDir: "public" } }) });
    const id = ((await created.json()) as { deployment: DeploymentView }).deployment.id;
    expect((await api(`/api/v1/deployments/${id}`, { token: other })).status).toBe(404);
    expect((await api(`/api/v1/deployments/${id}/bundle`, { token: other, method: "PUT", body: "x" })).status).toBe(404);
    const plain = await api(`/api/v1/deployments/${id}/bundle`, { method: "PUT", body: "this is not an archive" });
    expect(plain.status).toBe(400);
    expect(((await plain.json()) as { message: string }).message).toContain("gzip");
  });

  test("an archive the installer refuses: the deployment fails, saying why", async () => {
    const created = await api("/api/v1/deployments", { method: "POST", body: JSON.stringify({ manifest: { slug: "evil", start: "x", publicDir: "public" } }) });
    const id = ((await created.json()) as { deployment: DeploymentView }).deployment.id;
    await api(`/api/v1/deployments/${id}/bundle`, { method: "PUT", body: bundle([file("app/../../../etc/cron.d/x", "* * * * * root id")]) });
    const done = await follow(id);
    expect(done.state).toBe("failed");
    expect(done.error).toMatchObject({ code: "bundle-refused" });
    expect(done.error!.message).toContain("climbing");
    // A project that did not exist is left as it was: no directory for the
    // snapshot to list as a public project of no type.
    expect(existsSync(join(bench.sites, "evil"))).toBe(false);
    expect(done.log).toContain("   removed    site-evil");
  });

  test("no token, a malformed one, a wrong one, and the rate limiting per address", async () => {
    const none = await fetch(`${base}/api/v1/whoami`);
    expect(none.status).toBe(401);
    expect(((await none.json()) as { message: string }).message).toContain("Authorization: Bearer");
    const address = "203.0.113.99";
    for (let i = 0; i < 4; i++) expect((await api("/api/v1/whoami", { token: `sst_${"z".repeat(43)}`, address })).status).toBe(401);
    const limited = await api("/api/v1/whoami", { token: `sst_${"z".repeat(43)}`, address });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    // Even the right token waits, from that address; another address does not.
    expect((await api("/api/v1/whoami", { address })).status).toBe(429);
    expect((await api("/api/v1/whoami", { address: "203.0.113.100" })).status).toBe(200);
  });
});

describe("the machine's cap on deployments", () => {
  const open = async (slug: string, token = secret) => {
    const response = await api("/api/v1/deployments", { token, method: "POST", body: JSON.stringify({ manifest: { slug, start: "/usr/local/bin/bun run server.ts", publicDir: "public" } }) });
    return { status: response.status, deployment: ((await response.json()) as { deployment?: DeploymentView }).deployment };
  };
  const state = async (id: string, token = secret) => ((await (await api(`/api/v1/deployments/${id}`, { token })).json()) as { deployment: DeploymentView }).deployment.state;

  test("deployments waiting for their archive never stand in another token's way", async () => {
    // Three requests that never upload used to take the machine's three
    // places for fifteen minutes, renewable: nobody else could deploy.
    const waiting = [];
    for (const slug of ["wait-a", "wait-b", "wait-c"]) {
      const opened = await open(slug);
      expect(opened.status).toBe(201);
      waiting.push(opened.deployment!.id);
    }
    expect((await open("wait-other", other)).status).toBe(201);

    // A token holds three at most: a fourth replaces its oldest, which then
    // refuses its archive.
    expect((await open("wait-d")).status).toBe(201);
    expect(await state(waiting[0]!)).toBe("expired");
    expect(await state(waiting[1]!)).toBe("awaiting-bundle");
    const late = await api(`/api/v1/deployments/${waiting[0]}/bundle`, { method: "PUT", body: bundle([file("app/server.ts", "x")]) });
    expect(late.status).toBe(409);
  });

  test("the cap is claimed when the archive arrives: full, the deployment waits, and takes it again later", async () => {
    const opened = await open("capped", other);
    expect(opened.status).toBe(201);
    const id = opened.deployment!.id;

    // Three deployments the installer is running, every token together.
    const running = ["1", "2", "3"].map((digit) => "f".repeat(23) + digit);
    running.forEach((fake, rank) => {
      store.createDeployment({ id: fake, tokenId: "cccccccccccc", email: "c@test-zone.invalid", slug: `running-${rank}`, creating: true, manifest: "{}", createdAt: Date.now() });
      expect(store.markRunning(fake, Date.now())).toBe(true);
    });
    const archive = bundle([file("app/server.ts", "Bun.serve({})"), file("public/index.html", "<h1>capped</h1>")]);
    const full = await api(`/api/v1/deployments/${id}/bundle`, { token: other, method: "PUT", body: archive, headers: { "Content-Type": "application/gzip" } });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: "busy", message: expect.stringContaining("send the archive again") });
    expect(await state(id, other)).toBe("awaiting-bundle");
    expect(existsSync(join(bench.spool, id))).toBe(false);

    for (const fake of running) store.finish(fake, "succeeded", Date.now(), null);
    const again = await api(`/api/v1/deployments/${id}/bundle`, { token: other, method: "PUT", body: archive, headers: { "Content-Type": "application/gzip" } });
    expect(again.status).toBe(202);
    expect((await follow(id, other)).state).toBe("succeeded");
  });
});

describe("an older steward, without the control routes", () => {
  test("the API says it is not available yet, and what the owner must run", async () => {
    const socket = join(root, "old.sock");
    const old = Bun.serve({ unix: socket, fetch: () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 }) });
    try {
      const routes = createApiRoutes({
        steward: localControlSteward(socket),
        store,
        spool: createSpool(join(root, "old-spool")),
        limiter: createLimiter(),
        tracker: createTracker({ store, steward: localControlSteward(socket), spool: createSpool(join(root, "old-spool")) }),
        stateFile: join(root, "state.json"),
        publicUrl: "http://dashboard.test-zone.invalid",
        zone: ZONE,
      });
      const response = await routes.whoami(new Request("http://x/api/v1/whoami", { headers: { Authorization: `Bearer ${secret}` } }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "not-available", message: expect.stringContaining("sitesolide upgrade") });
    } finally {
      old.stop(true);
    }
  });
});

// After every deployment above, the succeeded, the failed and the refused.
describe("what the Activity page reads of this audit", () => {
  test("no entry carries a token's value, nor the unlock token", async () => {
    await tick();
    const rows = store.readAudit(null, 500);
    const actions = new Set(rows.map((row) => row.action));
    expect(actions.has("deploy.start") && actions.has("deploy.success")).toBe(true);
    const handed = JSON.stringify(rows);
    for (const value of [secret, other, UNLOCK, secret.slice(4), other.slice(4)]) expect(handed).not.toContain(value);
  });
});
