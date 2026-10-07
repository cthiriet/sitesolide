import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALLER_TEMPLATE, type InstallRequest, type InstallerResult, type TokenView } from "../src/control/protocol";
import { createControlSteward } from "../src/control/steward";
import { createControlSystem, type ControlSystem } from "../src/control/system";

/**
 * The steward's control routes on a throwaway tree: the real registry file,
 * the real request file, the real result reading, with `systemctl` and
 * `journalctl` simulated. The handler is called directly; the socket and the
 * dashboard in front of it are control-api.test.ts's business.
 */

const ZONE = "test-zone.invalid";
const UNLOCK = "unlock-token-of-the-secrets-routes";
const DEPLOYMENT = "00112233445566778899aabb";

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Setup = {
  root: string;
  calls: string[];
  active: Set<string>;
  journal: string;
  handler: (req: Request) => Promise<Response>;
  now: { value: number };
};

function setup(options: { template?: boolean } = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), "control-steward-"));
  toClean.push(root);
  for (const folder of ["state", "sites", "units", "installer"]) mkdirSync(join(root, folder));
  if (options.template !== false) writeFileSync(join(root, "units", INSTALLER_TEMPLATE), "[Service]\n");
  const calls: string[] = [];
  const active = new Set<string>();
  const now = { value: 1_800_000_000_000 };
  const state: Setup = { root, calls, active, journal: "", handler: async () => new Response(), now };
  const real = createControlSystem({
    stateFolder: join(root, "state"),
    sitesDir: join(root, "sites"),
    unitsFolder: join(root, "units"),
    installerFolder: join(root, "installer"),
    systemctl: "/bin/false",
    journalctl: "/bin/false",
  });
  const system: ControlSystem = {
    ...real,
    now: () => now.value,
    async systemctl(arguments_) {
      calls.push(arguments_.join(" "));
      if (arguments_[0] === "is-active") return { code: active.has(arguments_[1]!) ? 0 : 3, output: active.has(arguments_[1]!) ? "active\n" : "inactive\n" };
      return { code: 0, output: "" };
    },
    async journal(units, lines, cursor) {
      calls.push(`journal ${units.join(",")} ${lines} ${cursor ?? "-"}`);
      return { code: 0, output: state.journal };
    },
  };
  state.handler = createControlSteward(system, { zone: ZONE, isUnlocked: async (token) => token === UNLOCK, uidRoot: null, graceMs: 1000 });
  return state;
}

function call(s: Setup, method: string, path: string, body?: unknown): Promise<Response> {
  return s.handler(
    new Request(`http://steward${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

const SCOPE = { slugs: ["cms"], create: true, outbound: false, domain: false, public: false };

async function newToken(s: Setup, scope = SCOPE): Promise<{ token: TokenView; secret: string }> {
  const response = await call(s, "POST", "/team/tokens", { token: UNLOCK, label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: TokenView; secret: string };
}

describe("the registry", () => {
  test("empty at first, then the token created, its value returned once and never written", async () => {
    const s = setup();
    expect(await (await call(s, "GET", "/team/tokens")).json()).toEqual({ tokens: [] });
    const { token, secret } = await newToken(s);
    expect(token).toMatchObject({ label: "Ada", email: "ada@test-zone.invalid", scope: SCOPE, owned: [], revokedAt: null });
    const file = join(s.root, "state", "team.json");
    expect(readFileSync(file, "utf8")).not.toContain(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const listed = (await (await call(s, "GET", "/team/tokens")).json()) as { tokens: TokenView[] };
    expect(listed.tokens.map((view) => view.id)).toEqual([token.id]);
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  test("creating demands the dashboard unlocked", async () => {
    const s = setup();
    const response = await call(s, "POST", "/team/tokens", { token: "stale", label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: SCOPE });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "locked" });
  });

  test("a malformed request says which field, a reserved slug is never granted", async () => {
    const s = setup();
    const bad = await call(s, "POST", "/team/tokens", { token: UNLOCK, label: "", email: "ada@test-zone.invalid", expiresAt: null, scope: SCOPE });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain("label");
    const reserved = await call(s, "POST", "/team/tokens", { token: UNLOCK, label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: { ...SCOPE, slugs: ["portal"] } });
    expect(((await reserved.json()) as { message: string }).message).toContain("reserved");
    const extra = await call(s, "POST", "/team/tokens", { token: UNLOCK, label: "Ada", email: "a@b.c", expiresAt: null, scope: SCOPE, admin: true });
    expect(extra.status).toBe(400);
  });

  test("revoked without unlocking, and refused at once afterwards", async () => {
    const s = setup();
    const { token, secret } = await newToken(s);
    expect((await call(s, "POST", "/control/authenticate", { bearer: secret })).status).toBe(200);
    const revoked = await call(s, "POST", "/team/revoke", { id: token.id });
    expect(revoked.status).toBe(200);
    const refused = await call(s, "POST", "/control/authenticate", { bearer: secret });
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { message: string }).message).toContain("revoked");
    expect((await call(s, "POST", "/team/revoke", { id: "000000000000" })).status).toBe(404);
  });

  test("a registry that does not read refuses every token, and says where to look", async () => {
    const s = setup();
    const { secret } = await newToken(s);
    writeFileSync(join(s.root, "state", "team.json"), "{ not json");
    const response = await call(s, "POST", "/control/authenticate", { bearer: secret });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { message: string }).message).toContain("team.json");
  });
});

describe("authentication and preflight", () => {
  test("the identity, with its scope and its projects", async () => {
    const s = setup();
    const { token, secret } = await newToken(s);
    const response = await call(s, "POST", "/control/authenticate", { bearer: secret });
    expect(await response.json()).toEqual({ identity: { id: token.id, label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: SCOPE, owned: [] } });
    expect((await call(s, "POST", "/control/authenticate", { bearer: `sst_${"x".repeat(43)}` })).status).toBe(401);
    expect((await call(s, "POST", "/control/authenticate", {})).status).toBe(401);
  });

  test("preflight: creating, granted, reserved, another's", async () => {
    const s = setup();
    const { secret } = await newToken(s);
    expect(await (await call(s, "POST", "/control/preflight", { bearer: secret, slug: "shop" })).json()).toEqual({ creating: true });
    mkdirSync(join(s.root, "sites", "cms"));
    expect(await (await call(s, "POST", "/control/preflight", { bearer: secret, slug: "cms" })).json()).toEqual({ creating: false });
    const reserved = await call(s, "POST", "/control/preflight", { bearer: secret, slug: "dashboard" });
    expect(reserved.status).toBe(403);
    expect(await reserved.json()).toMatchObject({ error: "reserved" });
    mkdirSync(join(s.root, "sites", "blog"));
    expect(await (await call(s, "POST", "/control/preflight", { bearer: secret, slug: "blog" })).json()).toMatchObject({ error: "out-of-scope" });
  });
});

describe("starting the installer", () => {
  const manifest = JSON.stringify({ slug: "shop", start: "x", publicDir: "public" });

  test("the request written for the installer, ownership recorded, the unit started without waiting", async () => {
    const s = setup();
    const { token, secret } = await newToken(s);
    const response = await call(s, "POST", "/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "shop", manifest });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ deployment: DEPLOYMENT, slug: "shop", creating: true });
    const request = JSON.parse(readFileSync(join(s.root, "state", "installs", "shop.json"), "utf8")) as InstallRequest;
    expect(request).toMatchObject({ deployment: DEPLOYMENT, slug: "shop", creating: true, scope: SCOPE, manifest, token: { id: token.id, email: "ada@test-zone.invalid" } });
    expect(s.calls).toContain("start --no-block sitesolide-installer@shop.service");
    const listed = (await (await call(s, "GET", "/team/tokens")).json()) as { tokens: TokenView[] };
    expect(listed.tokens[0]!.owned).toEqual(["shop"]);
  });

  test("a deployment of the same project already running is refused", async () => {
    const s = setup();
    const { secret } = await newToken(s);
    s.active.add("sitesolide-installer@shop.service");
    const response = await call(s, "POST", "/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "shop", manifest });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "busy" });
  });

  test("an installer not installed yet: not available, and what to run", async () => {
    const s = setup({ template: false });
    const { secret } = await newToken(s);
    const response = await call(s, "POST", "/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "shop", manifest });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "not-available", message: expect.stringContaining("sitesolide setup") });
  });

  test("a manifest for another slug, a bad deployment id, a token without scope", async () => {
    const s = setup();
    const { secret } = await newToken(s);
    expect((await call(s, "POST", "/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "shop", manifest: JSON.stringify({ slug: "cms" }) })).status).toBe(400);
    expect((await call(s, "POST", "/control/deploy", { bearer: secret, deployment: "../x", slug: "shop", manifest })).status).toBe(400);
    const none = await newToken(s, { slugs: [], create: false, outbound: false, domain: false, public: false });
    expect((await call(s, "POST", "/control/deploy", { bearer: none.secret, deployment: DEPLOYMENT, slug: "shop", manifest })).status).toBe(403);
    expect(s.calls.filter((line) => line.startsWith("start"))).toEqual([]);
  });
});

describe("the installer's result", () => {
  const result = (extra: Partial<InstallerResult> = {}): InstallerResult => ({
    deployment: DEPLOYMENT,
    slug: "shop",
    state: "running",
    startedAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    finishedAt: null,
    log: ["-> manifest", "\u001b[31mred\u001b[0m"],
    error: null,
    url: null,
    allocated: [],
    ...extra,
  });

  function lay(s: Setup, value: unknown, mode = 0o600): void {
    const path = join(s.root, "installer", `${DEPLOYMENT}.json`);
    writeFileSync(path, JSON.stringify(value));
    chmodSync(path, mode);
  }

  test("absent: not found yet; present: relayed, its log cleaned of control characters", async () => {
    const s = setup();
    expect((await call(s, "GET", `/control/deployment?id=${DEPLOYMENT}`)).status).toBe(404);
    s.active.add("sitesolide-installer@shop.service");
    lay(s, result());
    const response = (await (await call(s, "GET", `/control/deployment?id=${DEPLOYMENT}`)).json()) as { result: InstallerResult };
    expect(response.result.state).toBe("running");
    expect(response.result.log).toEqual(["-> manifest", "[31mred[0m"]);
  });

  test("still running while its unit is gone: an interrupted installer, reported as failed", async () => {
    const s = setup();
    lay(s, result());
    s.now.value += 5_000;
    const response = (await (await call(s, "GET", `/control/deployment?id=${DEPLOYMENT}`)).json()) as { result: InstallerResult };
    expect(response.result).toMatchObject({ state: "failed", error: { code: "interrupted" } });
  });

  test("a result others could rewrite, or naming another deployment, is not believed", async () => {
    const s = setup();
    lay(s, result(), 0o666);
    expect((await call(s, "GET", `/control/deployment?id=${DEPLOYMENT}`)).status).toBe(500);
    lay(s, result({ deployment: "ffffffffffffffffffffffff" }));
    expect((await call(s, "GET", `/control/deployment?id=${DEPLOYMENT}`)).status).toBe(500);
    lay(s, result({ state: "failed" }));
    expect((await call(s, "GET", `/control/deployment?id=${DEPLOYMENT}`)).status).toBe(500);
    expect((await call(s, "GET", "/control/deployment?id=../../etc/passwd")).status).toBe(400);
  });
});

describe("the journal", () => {
  test("the project's units, lines bounded, the cursor carried for the next call", async () => {
    const s = setup();
    const { secret } = await newToken(s);
    mkdirSync(join(s.root, "sites", "cms"));
    writeFileSync(join(s.root, "sites", "cms", "sitesolide.json"), JSON.stringify({ slug: "cms", publicDir: "p", services: { web: { start: "x", port: 3040 }, api: { start: "y", port: 3041, routes: ["/api/*"] } } }));
    s.journal = "2026-10-04T10:00:00+0000 vm cms[1]: started\n-- cursor: s=abc;i=1\n";
    const response = await call(s, "POST", "/control/logs", { bearer: secret, slug: "cms", lines: 50, cursor: null });
    expect(await response.json()).toEqual({ lines: ["2026-10-04T10:00:00+0000 vm cms[1]: started"], cursor: "s=abc;i=1" });
    expect(s.calls).toContain("journal cms,cms.api.service 50 -");
  });

  test("a static site has none, and a slug not granted is refused", async () => {
    const s = setup();
    const { secret } = await newToken(s);
    mkdirSync(join(s.root, "sites", "cms"));
    writeFileSync(join(s.root, "sites", "cms", "sitesolide.json"), JSON.stringify({ slug: "cms", publicDir: "p" }));
    expect((await call(s, "POST", "/control/logs", { bearer: secret, slug: "cms", lines: 50, cursor: null })).status).toBe(404);
    mkdirSync(join(s.root, "sites", "blog"));
    expect((await call(s, "POST", "/control/logs", { bearer: secret, slug: "blog", lines: 50, cursor: null })).status).toBe(403);
    expect((await call(s, "POST", "/control/logs", { bearer: secret, slug: "cms", lines: 0, cursor: null })).status).toBe(400);
    expect((await call(s, "POST", "/control/logs", { bearer: secret, slug: "cms", lines: 5, cursor: "$(reboot)" })).status).toBe(400);
  });
});

describe("routing", () => {
  test("an unknown route, a wrong method", async () => {
    const s = setup();
    expect(await (await call(s, "GET", "/control/nothing")).json()).toEqual({ error: "not-found", message: "no such route" });
    expect((await call(s, "DELETE", "/team/tokens")).status).toBe(405);
  });
});
