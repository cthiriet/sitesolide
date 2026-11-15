import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideSlug, everyProject, scopeRefusals } from "../src/control/policy";
import { INSTALLER_TEMPLATE, type Identity, type InstallRequest, type PlanResponse, type Scope, type TokenView } from "../src/control/protocol";
import { createControlSteward } from "../src/control/steward";
import { createControlSystem, type ControlSystem } from "../src/control/system";
import { readScope } from "../src/control/tokens";
import { mintRefusals } from "../src/people/tokens";
import { finalManifest, replaceable } from "../src/installer/pipeline";

/**
 * The owner's own token for every project, `scope.all`: what the owner
 * deploys with now that no deployment goes over SSH. It reaches every project
 * the machine carries but the platform's and those another token holds,
 * creates under a name a removed project left, takes a name back, replaces a
 * file edited by hand, keeps a `lock` key, and is bounded by no token cap. A
 * person's token never is.
 */

const ZONE = "test-zone.invalid";
const UNLOCK = "unlock-token-of-the-secrets-routes";
const DEPLOYMENT = "00112233445566778899aabb";
const NONE: Scope = { slugs: [], create: false, outbound: false, domain: false, public: false, secrets: false };
const EVERY: Scope = { slugs: [], create: true, outbound: true, domain: true, public: true, secrets: true, all: true };

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function identity(scope: Scope, member: string | null = null): Identity {
  return { id: "aaaaaaaaaaaa", label: "Laptop", email: "owner", expiresAt: null, scope, owned: [], member };
}

describe("the scope", () => {
  test("all carries every permission with it, whatever the other flags say; absent, it reads false", () => {
    expect(readScope({ ...NONE, all: true }, ZONE)).toEqual(EVERY);
    expect(readScope(NONE, ZONE)).toEqual(NONE);
    expect(readScope({ ...NONE, all: "yes" }, ZONE)).toEqual({ refusal: "scope.all must be true or false" });
  });

  test("a person's token is never minted with it, nor treated as one", () => {
    const rights = { email: "ada@acme.test", roles: { cms: "admin" as const }, create: true };
    expect(mintRefusals({ ...EVERY, slugs: ["cms"] }, rights).some((line) => line.startsWith("scope.all:"))).toBe(true);
    expect(everyProject(identity(EVERY))).toBe(true);
    expect(everyProject(identity(EVERY, "ada@acme.test"))).toBe(false);
    expect(everyProject(identity({ ...EVERY, all: false }))).toBe(false);
  });

  test("another token's name is refused with --adopt named, a new name is a creation", () => {
    const every = identity(EVERY);
    const held = decideSlug(every, "shop", { exists: true, owner: "bbbbbbbbbbbb", zone: ZONE });
    expect(held).toMatchObject({ kind: "refused", error: "out-of-scope" });
    expect(held.kind === "refused" && held.message).toContain("--adopt");
    expect(decideSlug(every, "fresh", { exists: false, owner: null, zone: ZONE })).toEqual({ kind: "allowed", creating: true });
    expect(decideSlug(every, "dashboard", { exists: true, owner: null, zone: ZONE })).toMatchObject({ kind: "refused", error: "reserved" });
  });

  test("no token cap, and the lock key kept, for it alone", () => {
    const big = { slug: "shop", start: "/usr/local/bin/bun run s.ts", port: 3040, memory: "2G", lock: true };
    expect(scopeRefusals(big as never, EVERY, "shop")).toEqual([]);
    const refused = scopeRefusals(big as never, { ...EVERY, all: false }, "shop");
    expect(refused.some((line) => line.startsWith("lock:"))).toBe(true);
    expect(refused.some((line) => line.startsWith("memory:"))).toBe(true);
  });
});

describe("the installer", () => {
  test("--force replaces a file edited by hand, only when asked", () => {
    expect(replaceable("[Service]\nUser=root\n", "[Service]\nUser=site-shop\n", null)).toBe(false);
    expect(replaceable("[Service]\nUser=root\n", "[Service]\nUser=site-shop\n", null, true)).toBe(true);
  });

  test("the owner's token adds a name to a domain switched on, which keeps its switch", () => {
    const before = `${JSON.stringify({ slug: "shop", publicDir: "public", domain: { name: "shop.example", active: true } })}\n`;
    const asked = JSON.stringify({ slug: "shop", publicDir: "public", domain: { name: "shop.example", aliases: ["shop.example.org"] } });
    const request = (scope: Scope): InstallRequest => ({
      deployment: DEPLOYMENT,
      slug: "shop",
      requestedAt: 0,
      token: { id: "aaaaaaaaaaaa", email: "owner", member: null },
      scope,
      creating: false,
      manifest: asked,
    });
    const deposited = new Map([["shop", before]]);
    expect(() => finalManifest(request({ ...EVERY, all: false }), deposited)).toThrow("switched on");
    const final = finalManifest(request(EVERY), deposited);
    expect(final.manifest.domain?.active).toBe(true);
  });
});

type Setup = { root: string; calls: string[]; handler: ReturnType<typeof createControlSteward> };

function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), "control-every-"));
  toClean.push(root);
  for (const folder of ["state", "sites", "units", "installer"]) mkdirSync(join(root, folder));
  writeFileSync(join(root, "units", INSTALLER_TEMPLATE), "[Service]\n");
  const calls: string[] = [];
  const real = createControlSystem({
    stateFolder: join(root, "state"),
    sitesDir: join(root, "sites"),
    unitsFolder: join(root, "units"),
    installerFolder: join(root, "installer"),
    systemctl: "/bin/false",
    journalctl: "/bin/false",
    backups: null,
  });
  const system: ControlSystem = {
    ...real,
    now: () => 1_800_000_000_000,
    async systemctl(arguments_) {
      calls.push(arguments_.join(" "));
      return arguments_[0] === "is-active" ? { code: 3, output: "inactive\n" } : { code: 0, output: "" };
    },
  };
  return { root, calls, handler: createControlSteward(system, { zone: ZONE, isUnlocked: async (token) => token === UNLOCK, uidRoot: null }) };
}

const call = (s: Setup, method: string, path: string, body: unknown) =>
  s.handler(new Request(`http://steward${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

function deployed(s: Setup, slug: string, manifest: object): void {
  mkdirSync(join(s.root, "sites", slug), { recursive: true });
  writeFileSync(join(s.root, "sites", slug, "sitesolide.json"), `${JSON.stringify({ slug, ...manifest })}\n`);
}

describe("the steward", () => {
  test("the owner's socket mints the owner's token for every project, its value once and never written", async () => {
    const s = setup();
    const response = await s.handler.owner(new Request("http://steward/tokens/owner", { method: "POST", body: JSON.stringify({ label: "workstation", expiresAt: null }) }));
    expect(response.status).toBe(201);
    const { token, secret } = (await response.json()) as { token: TokenView; secret: string };
    expect(token).toMatchObject({ email: "owner", member: null, scope: EVERY });
    expect(secret).toMatch(/^sst_[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(s.root, "state", "team.json"), "utf8")).not.toContain(secret);
    // Never on the dashboard's socket.
    expect((await call(s, "POST", "/tokens/owner", { label: "x", expiresAt: null })).status).toBe(404);
  });

  test("it reaches every project the machine carries, but the platform's and another token's", async () => {
    const s = setup();
    const created = await call(s, "POST", "/tokens/create", { token: UNLOCK, label: "Laptop", holder: "owner", expiresAt: null, scope: { ...NONE, all: true } });
    const { secret } = (await created.json()) as { secret: string };
    const other = await call(s, "POST", "/tokens/create", { token: UNLOCK, label: "CI", holder: "owner", expiresAt: null, scope: { ...NONE, create: true } });
    const { secret: ci } = (await other.json()) as { secret: string };
    deployed(s, "blog", { publicDir: "public" });
    deployed(s, "dashboard", { start: "x", port: 3001 });
    // The CI token creates `shop`: its own name, which the owner takes back with --adopt alone.
    expect((await call(s, "POST", "/control/deploy", { bearer: ci, deployment: DEPLOYMENT, slug: "shop", manifest: JSON.stringify({ slug: "shop", start: "x" }) })).status).toBe(202);
    deployed(s, "shop", { start: "x", port: 3040 });
    const at = 1_800_000_000_000;
    const result = { deployment: DEPLOYMENT, slug: "shop", state: "succeeded", startedAt: at, updatedAt: at, finishedAt: at, log: [], error: null, url: null, allocated: [], missingSecrets: null, laid: true };
    writeFileSync(join(s.root, "installer", `${DEPLOYMENT}.json`), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    const who = (await (await call(s, "POST", "/control/authenticate", { bearer: secret })).json()) as { identity: Identity };
    expect(who.identity.scope.slugs).toEqual(["blog"]);
    const held = await call(s, "POST", "/control/preflight", { bearer: secret, slug: "shop" });
    expect(await held.json()).toMatchObject({ error: "out-of-scope", message: expect.stringContaining("--adopt") });
    // --adopt: the name taken back, then it is the owner's token's to deploy.
    const taken = await call(s, "DELETE", "/control/claim", { bearer: secret, slug: "shop" });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ slug: "shop", released: expect.any(String) });
    expect(await (await call(s, "POST", "/control/preflight", { bearer: secret, slug: "shop" })).json()).toMatchObject({ creating: false });
    // Any other token is refused the take back.
    expect(await (await call(s, "DELETE", "/control/claim", { bearer: ci, slug: "blog" })).json()).toMatchObject({ error: "out-of-scope" });
  });

  test("a plan judges and writes nothing; --force is carried to the installer for it alone", async () => {
    const s = setup();
    const created = await call(s, "POST", "/tokens/create", { token: UNLOCK, label: "Laptop", holder: "owner", expiresAt: null, scope: { ...NONE, all: true } });
    const { secret } = (await created.json()) as { secret: string };
    deployed(s, "blog", { start: "x", port: 3040, portal: true });
    const manifest = JSON.stringify({ slug: "blog", start: "x" });
    const planned = await call(s, "POST", "/control/plan", { bearer: secret, slug: "blog", manifest });
    expect(planned.status).toBe(200);
    const plan = (await planned.json()) as PlanResponse;
    expect(plan).toMatchObject({ slug: "blog", creating: false, existing: true, portal: true, allocated: [{ service: null, port: 3040 }] });
    expect(JSON.parse(plan.manifest)).toMatchObject({ slug: "blog", port: 3040, portal: true });
    expect(s.calls.filter((line) => line.startsWith("start"))).toEqual([]);

    expect((await call(s, "POST", "/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "blog", manifest, force: true })).status).toBe(202);
    const request = JSON.parse(readFileSync(join(s.root, "state", "installs", "blog.json"), "utf8")) as InstallRequest;
    expect(request.force).toBe(true);

    const other = await call(s, "POST", "/tokens/create", { token: UNLOCK, label: "CI", holder: "owner", expiresAt: null, scope: { ...NONE, slugs: ["blog"] } });
    const { secret: ci } = (await other.json()) as { secret: string };
    expect(await (await call(s, "POST", "/control/plan", { bearer: ci, slug: "blog", manifest, force: true })).json()).toMatchObject({ error: "out-of-scope" });
  });
});
