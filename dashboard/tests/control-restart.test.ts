import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTAL_PORT } from "../borrowed/portal";
import { createAccessSystem } from "../src/access/system";
import { openDatabase } from "../src/database";
import { createApiRoutes, restartRoutes, STEWARD_IDLE_S } from "../src/control/api";
import type { ControlSteward } from "../src/control/client";
import { createLimiter } from "../src/control/limiter";
import { INSTALLER_TEMPLATE, TOKEN_REFUSALS_PER_HOUR, TOKEN_RESTARTS_PER_HOUR, type Identity, type Scope, type TokenView } from "../src/control/protocol";
import { createSpool } from "../src/control/spool";
import { createControlSteward, isControlPath } from "../src/control/steward";
import { createControlStore } from "../src/control/store";
import { createControlSystem, type ControlSystem } from "../src/control/system";
import { createTracker } from "../src/control/tracker";
import { createMembersSystem } from "../src/people/system";
import { reread } from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";
import { createSteward } from "../src/secrets/steward";
import { DEFAULT_TIMEOUTS } from "../src/secrets/client";
import { createSystem, type Command, type System } from "../src/secrets/system";
import { registryOf, writeRegistry, type People } from "./registry-fixtures";

/**
 * A token's restart, and the bounds its refusals spend, both halves.
 *
 * The steward: the real secrets routes (`createSteward`, with the people and
 * the access registry, on a throwaway tree, as people-actions.test.ts mounts
 * them) and the real control routes, wired exactly as dashboard/steward.ts
 * wires them, the real store, journal and token registry; `systemctl` alone
 * simulated. The token judged first, its person's role, its project; a
 * restart journaled under `token:<id>`; a refusal, of a restart, of a change
 * of a store or of access, counted against the token's hour; never a value
 * anywhere but in the store itself. A token's store itself is
 * control-store.test.ts's.
 *
 * Then the dashboard's API on a real port, the steward reduced to the
 * answers it gives: what the dashboard judges itself, and what it passes on
 * or keeps back.
 */

const ZONE = "test-zone.invalid";
const PASSWORD = "Owner-Password-For-The-Tests-1";
const ALICE = "alice@acme.test";
/** Planted in every request a test sends, searched for everywhere a value must never go. */
const CANARY = "leak-canary-7f3a9c";

const toClean: string[] = [];
const spies: Mock<(...args: unknown[]) => void>[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
  for (const spy of spies.splice(0)) spy.mockRestore();
});

type Bench = {
  root: string;
  clock: { t: number };
  /** Every `systemctl` the secrets routes ran: its arguments are argv. */
  calls: string[][];
  /** As long as it is set, `systemctl restart` waits on it. */
  barrier: { promise: Promise<void> | null };
  /** Installer units `is-active` reads as running. */
  installing: Set<string>;
  /** Every answer's text, for the leak checks. */
  answers: string[];
  /** The owner's unlock token: their own restart waits under the secrets' lock. */
  unlock: string;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  journal: () => LogEntry[];
  /** A project's store's env as it stands, "" when it has none yet. */
  storeEnv: (slug: string) => string;
  seed: (people: People) => void;
  ownerToken: (scope: Partial<Scope>) => Promise<{ token: TokenView; secret: string }>;
  personToken: (email: string, scope: Partial<Scope>) => Promise<{ token: TokenView; secret: string }>;
  /** What every console call printed since the bench was mounted. */
  printed: () => string;
  /** Everything a value must never reach: answers, journal, access log, previous versions' names, argv, the registry, the console. */
  everywhere: () => string;
};

const NONE: Scope = { slugs: [], create: false, outbound: false, domain: false, public: false, secrets: false };

/** A site's block as the gatekeeper lays it behind the portal: what general access reads as restricted. */
const protectedBlock = (slug: string) => `${slug}.${ZONE} {\n\tforward_auth @portal_guard 127.0.0.1:${PORTAL_PORT} {\n\t\turi /verifier\n\t}\n}\n`;

/**
 * cms: restricted, declares API_KEY and SMTP_URL; blog: public, declares
 * TOKEN; notes: a static site; the dashboard and the portal. A restricted
 * site's protected block is in service, as the gatekeeper laid it, and every
 * app's unit reads its store, as unit.ts writes it.
 */
async function mount(options: { restartsPerHour?: number; refusalsPerHour?: number } = {}): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "control-restart-"));
  toClean.push(root);
  const folder = (name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    return join(root, name);
  };
  const sites = folder("sites");
  const secrets = folder("secrets");
  const units = folder("units");
  const state = folder("state");
  const portalKey = folder("portal-key");
  const caddy = folder("caddy");
  const gatekeeper = folder("gatekeeper");
  const installer = folder("installer");
  writeFileSync(join(units, INSTALLER_TEMPLATE), "[Service]\n");

  const manifest = (slug: string, content: Record<string, unknown>) => {
    mkdirSync(join(sites, slug), { recursive: true });
    writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, ...content }));
  };
  const app = (slug: string, port: number, extra: Record<string, unknown> = {}) => {
    manifest(slug, { start: "/usr/local/bin/bun run server.ts", port, publicDir: "public", ...extra });
    const reads = slug === "dashboard" || slug === "portal" ? `EnvironmentFile=-${secrets}/${slug}.env\n` : `EnvironmentFile=-${secrets}/projects/${slug}/env\nLoadCredential=files:${secrets}/projects/${slug}/files\n`;
    writeFileSync(join(units, `${slug}.service`), `[Service]\nEnvironment=PORT=${port}\n${reads}ExecStart=/usr/local/bin/bun run server.ts\n`);
    if (extra.portal === true) writeFileSync(join(caddy, `${slug}.caddy`), protectedBlock(slug));
  };
  app("cms", 3048, { secrets: ["API_KEY", "SMTP_URL"], portal: true, env: { DEFAULT_SENDER: `me@${ZONE}` } });
  app("blog", 3049, { secrets: ["TOKEN"] });
  manifest("notes", { publicDir: "public" });
  app("dashboard", 3022);
  app("portal", 3026);

  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "portal.env"), "OIDC_ISSUER=https://login.test-zone.invalid\nOIDC_CLIENT_ID=client\nOIDC_CLIENT_SECRET=secret\nOIDC_ALLOWED_DOMAINS=acme.test\n", { mode: 0o600 });

  const clock = { t: Date.now() };
  const calls: string[][] = [];
  const barrier: Bench["barrier"] = { promise: null };
  const installing = new Set<string>();
  const real = createSystem({
    sitesDir: sites,
    secretsFolder: secrets,
    unitsFolder: units,
    stateFolder: state,
    hashFile: join(secrets, "dashboard.env"),
    accountsFile: join(root, "passwd"),
    caddyFolder: caddy,
    gatekeeperFolder: gatekeeper,
    codesFile: join(root, "locks-codes.json"),
    locksFragment: join(root, "verrous.caddy"),
    systemctl: "/path/that/does/not/exist",
  });
  const system: System = {
    ...real,
    now: () => clock.t,
    wait: async (ms) => {
      clock.t += ms;
    },
    systemctl: async (arguments_): Promise<Command> => {
      calls.push(arguments_);
      if (arguments_[0] === "restart" && barrier.promise !== null) await barrier.promise;
      if (arguments_[0] === "show") return { code: 0, output: "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=\n" };
      return { code: 0, output: "" };
    },
  };
  const members = { ...createMembersSystem({ stateFolder: state, sitesDir: sites, secretsFolder: secrets, portalKeyFolder: portalKey, groupsFile: join(root, "group"), portalGroup: "" }), now: () => clock.t };
  const access = { ...createAccessSystem({ stateFolder: state, portalKeyFolder: portalKey, groupsFile: join(root, "group"), portalGroup: "", portalDataFolder: join(root, "portal-data") }, false), now: () => clock.t };
  const handler = createSteward(system, { secretsFolder: secrets, checkAccounts: false, members: { system: members, access, zone: ZONE } });

  const controlReal = createControlSystem({ stateFolder: state, sitesDir: sites, unitsFolder: units, installerFolder: installer, systemctl: "/bin/false", journalctl: "/bin/false", backups: null, connectors: null });
  const controlSystem: ControlSystem = {
    ...controlReal,
    now: () => clock.t,
    async systemctl(arguments_) {
      if (arguments_[0] === "is-active") return installing.has(arguments_[1]!) ? { code: 0, output: "active\n" } : { code: 3, output: "inactive\n" };
      return { code: 0, output: "" };
    },
  };
  // As dashboard/steward.ts wires it.
  const control = createControlSteward(controlSystem, {
    zone: ZONE,
    isUnlocked: handler.isUnlocked,
    uidRoot: null,
    members: handler.memberAuthority ?? undefined,
    access: handler.accessForToken,
    forgetAccess: handler.forgetProjectAccess,
    secrets: handler.secretsForToken,
    store: handler.storeForToken,
    storeAside: handler.storeAside,
    ...options,
  });

  const printed: unknown[][] = [];
  for (const method of ["log", "error", "warn", "info"] as const) {
    const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args));
    spies.push(spy as unknown as Mock<(...args: unknown[]) => void>);
  }

  const answers: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const request = new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const response = await (isControlPath(path) ? control(request) : handler(request));
    answers.push(await response.clone().text());
    return response;
  };
  const seed = (people: People) => writeRegistry(state, registryOf(people));
  seed({ [ALICE]: { cms: "developer", blog: "developer" } });

  const unlocked = await call("POST", "/unlock", { password: PASSWORD });
  const unlock = ((await unlocked.json()) as { token: string }).token;
  const mint = async (holder: string, scope: Partial<Scope>) => {
    const response = await call("POST", "/tokens/create", { token: unlock, label: "agent", holder, expiresAt: null, scope: { ...NONE, ...scope } });
    expect(response.status).toBe(201);
    return (await response.json()) as { token: TokenView; secret: string };
  };
  const readOr = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  const journal = () => reread(readOr(join(state, "journal.jsonl")));

  return {
    root,
    clock,
    calls,
    barrier,
    installing,
    answers,
    unlock,
    call,
    journal,
    storeEnv: (slug) => readOr(join(secrets, "projects", slug, "env")),
    seed,
    ownerToken: (scope) => mint("owner", scope),
    personToken: (email, scope) => mint(email, scope),
    printed: () => printed.map((args) => args.map(String).join(" ")).join("\n"),
    everywhere: () =>
      [
        ...answers,
        readOr(join(state, "journal.jsonl")),
        readOr(join(state, "access-log.jsonl")),
        readOr(join(state, "team.json")),
        existsSync(join(state, "precedents")) ? readdirSync(join(state, "precedents"), { recursive: true }).join("\n") : "",
        JSON.stringify(calls),
        printed.map((args) => args.map(String).join(" ")).join("\n"),
      ].join("\n"),
  };
}

/** A message that starts with this text, matched as it is written. */
const startingWith = (text: string) => expect.stringMatching(new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

async function body(response: Response): Promise<{ status: number } & Record<string, unknown>> {
  return { status: response.status, ...((await response.json()) as Record<string, unknown>) };
}

/** A change of a project's store, as a token's request reaches the steward. */
const patch = (b: Bench, secret: string, slug: string, change: { set?: Record<string, string>; remove?: string[] }) => b.call("PATCH", "/control/store", { bearer: secret, slug, ...change });
const list = (b: Bench, secret: string, slug: string) => b.call("POST", "/control/store/list", { bearer: secret, slug });
const restart = (b: Bench, secret: string, slug: string) => b.call("POST", "/control/restart", { bearer: secret, slug });
const grantAccess = (b: Bench, secret: string, slug: string, who: string, role: string) => b.call("PUT", "/control/access", { bearer: secret, slug, who, role });

describe("the steward: what a token's hour bounds", () => {
  test("30 restarts an hour per token: 429 with wait; another token has its own hour", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms"] });
    for (let i = 0; i < TOKEN_RESTARTS_PER_HOUR; i++) expect((await restart(b, secret, "cms")).status).toBe(200);
    const restarts = await body(await restart(b, secret, "cms"));
    expect(restarts).toMatchObject({ status: 429, error: "too-many-attempts", message: startingWith(`${TOKEN_RESTARTS_PER_HOUR} restarts per hour at most for a token`) });
    expect(restarts.wait).toBeGreaterThan(0);
    expect(b.calls.filter((call) => call[0] === "restart")).toHaveLength(TOKEN_RESTARTS_PER_HOUR);
    const other = await b.ownerToken({ slugs: ["cms"] });
    expect((await restart(b, other.secret, "cms")).status).toBe(200);
    b.clock.t += 3_600_000;
    expect((await restart(b, secret, "cms")).status).toBe(200);
  });

  test("an owner's token without public changes the store of a project it could deploy as it stands alone: paths exempted from the portal, or a portal asked for and not in place, are public", async () => {
    const b = await mount();
    // hooks: behind the portal but for /webhook/*, which any visitor reaches; a deployment of it by this token is refused.
    const hooks = { slug: "hooks", start: "/usr/local/bin/bun run server.ts", port: 3060, publicDir: "public", secrets: ["WEBHOOK_SECRET"], portal: true, portalExempt: ["/webhook/*"] };
    mkdirSync(join(b.root, "sites", "hooks"), { recursive: true });
    writeFileSync(join(b.root, "sites", "hooks", "sitesolide.json"), JSON.stringify(hooks));
    writeFileSync(join(b.root, "units", "hooks.service"), `[Service]\nEnvironment=PORT=3060\nEnvironmentFile=-${join(b.root, "secrets")}/projects/hooks/env\nExecStart=/usr/local/bin/bun run server.ts\n`);
    writeFileSync(join(b.root, "caddy", "hooks.caddy"), protectedBlock("hooks"));
    const { token, secret } = await b.ownerToken({ slugs: ["hooks", "cms"], secrets: true });
    const exempted = await body(await patch(b, secret, "hooks", { set: { WEBHOOK_SECRET: CANARY } }));
    expect(exempted).toMatchObject({ status: 403, error: "out-of-scope", message: startingWith("hooks is not restricted on the machine as this token could deploy it") });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${token.id}`, slug: "hooks", detail: "not restricted" });
    expect(b.storeEnv("hooks")).toBe("");

    // cms asks for the portal, but its protected block is not in service: general access reads it public.
    unlinkSync(join(b.root, "caddy", "cms.caddy"));
    expect(await body(await patch(b, secret, "cms", { set: { API_KEY: CANARY } }))).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(b.storeEnv("cms")).toBe("");
    writeFileSync(join(b.root, "caddy", "cms.caddy"), protectedBlock("cms"));
    expect((await patch(b, secret, "cms", { set: { API_KEY: "v" } })).status).toBeLessThan(300);
    // With public, the token deploys both as they stand.
    const open = await b.ownerToken({ slugs: ["hooks"], secrets: true, public: true });
    expect((await patch(b, open.secret, "hooks", { set: { WEBHOOK_SECRET: "rotated" } })).status).toBeLessThan(300);
    expect(b.storeEnv("hooks")).toBe("WEBHOOK_SECRET=rotated\n");
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("a token's refusals are bounded per hour, charged before the line is written: past them too-many-attempts, journaled no more, and what it changed stays in the journal", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms", "blog"], secrets: true });
    // Minted now: the owner's unlock does not last the hour below.
    const idle = await b.ownerToken({ slugs: ["cms"] });
    // The theft: three variables replaced.
    expect((await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-1`, SMTP_URL: "smtp://elsewhere.invalid", EXTRA: "x" } })).status).toBeLessThan(300);
    const sets = () => b.journal().filter((line) => line.actor === `token:${token.id}` && line.result === "ok" && line.operation === "set");
    const refusals = () => b.journal().filter((line) => line.actor === `token:${token.id}` && line.result === "rejects");
    let bounded = 0;
    let wait = 0;
    // Then twenty refused requests a minute, a whole hour, on blog, which a token without public never writes: 1,200 lines through the shared bound before.
    for (let minute = 1; minute <= 60; minute++) {
      b.clock.t += 60_000;
      for (let i = 0; i < 20; i++) {
        const answer = await body(await patch(b, secret, "blog", { set: { A: "b" } }));
        if (answer.status === 429) {
          bounded++;
          wait = answer.wait as number;
          expect(answer).toMatchObject({ error: "too-many-attempts", message: startingWith(`${TOKEN_REFUSALS_PER_HOUR} refused requests per hour at most for a token`) });
        } else expect(answer.status).toBe(403);
      }
    }
    expect(refusals()).toHaveLength(TOKEN_REFUSALS_PER_HOUR);
    expect(bounded).toBe(60 * 20 - TOKEN_REFUSALS_PER_HOUR);
    expect(wait).toBeGreaterThan(0);
    expect(sets()).toHaveLength(3);
    // A missing flag's refusals spend the same kind of hour, the token's own.
    for (let i = 0; i < TOKEN_REFUSALS_PER_HOUR; i++) expect((await list(b, idle.secret, "cms")).status).toBe(403);
    const past = await list(b, idle.secret, "cms");
    expect(past.status).toBe(429);
    expect(b.journal().filter((line) => line.actor === `token:${idle.token.id}`)).toHaveLength(TOKEN_REFUSALS_PER_HOUR);
    // An hour later, journaled again.
    b.clock.t += 3_600_000;
    expect((await list(b, idle.secret, "cms")).status).toBe(403);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("a token's refusals never take another's place in the journal: a person's token refused in the same minute is journaled", async () => {
    const b = await mount();
    const idle = await b.ownerToken({ slugs: ["cms"] });
    const alice = await b.personToken(ALICE, { slugs: ["cms"], secrets: true });
    b.seed({ [ALICE]: { cms: "viewer" } });
    for (let i = 0; i < 20; i++) expect((await list(b, idle.secret, "cms")).status).toBe(403);
    expect((await patch(b, alice.secret, "cms", { set: { X: "y" } })).status).toBe(403);
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${alice.token.id}`, member: ALICE, detail: "role viewer" });
  });

  test("a token's refused changes of access spend the same hour: a stolen token, even one that manages no secret, cannot push what was changed out of the journal", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    // A deploy token alone, the kind any agent holds.
    const idle = await b.ownerToken({ slugs: ["cms"] });
    expect((await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-1`, SMTP_URL: "smtp://elsewhere.invalid", EXTRA: "x" } })).status).toBeLessThan(300);
    const sets = () => b.journal().filter((line) => line.actor === `token:${token.id}` && line.result === "ok" && line.operation === "set");
    const refusals = () => b.journal().filter((line) => line.actor === `token:${idle.token.id}` && line.result === "rejects");
    let bounded = 0;
    // A token gives Can open alone: Admin is refused, and journaled, twenty a minute for most of an hour.
    for (let minute = 1; minute <= 55; minute++) {
      b.clock.t += 60_000;
      for (let i = 0; i < 20; i++) {
        const answer = await body(await grantAccess(b, idle.secret, "cms", "someone@acme.test", "admin"));
        if (answer.status === 429) {
          bounded++;
          expect(answer).toMatchObject({ error: "too-many-attempts", message: startingWith(`${TOKEN_REFUSALS_PER_HOUR} refused requests per hour at most for a token`) });
        } else expect(answer.status).toBe(403);
      }
    }
    expect(sets()).toHaveLength(3);
    expect(refusals()).toHaveLength(TOKEN_REFUSALS_PER_HOUR);
    expect(bounded).toBe(55 * 20 - TOKEN_REFUSALS_PER_HOUR);
    // An accepted change is the access registry's to bound, and an entry not there to remove is never journaled: neither costs anything of this one.
    b.clock.t += 3_600_000;
    for (let i = 0; i < TOKEN_REFUSALS_PER_HOUR + 1; i++) expect((await grantAccess(b, idle.secret, "cms", "visitor@acme.test", "visitor")).status).toBeLessThan(300);
    for (let i = 0; i < TOKEN_REFUSALS_PER_HOUR + 1; i++) {
      expect((await b.call("DELETE", "/control/access", { bearer: idle.secret, slug: "cms", who: "nobody@acme.test" })).status).toBe(404);
    }
    expect((await grantAccess(b, idle.secret, "cms", "someone@acme.test", "admin")).status).toBe(403);
  });

  test("a token's refused changes of access never take another's place in the journal: a failed sign-in, another token, refused in the same minute are journaled", async () => {
    const b = await mount();
    const idle = await b.ownerToken({ slugs: ["cms"] });
    const other = await b.ownerToken({ slugs: ["cms"] });
    for (let i = 0; i < 20; i++) expect((await grantAccess(b, idle.secret, "cms", "someone@acme.test", "admin")).status).toBe(403);
    await b.call("POST", "/people/signin", { assertion: "forged" });
    expect(b.journal().at(-1)).toMatchObject({ operation: "dashboard.signin_failed", result: "rejects", actor: "anonymous" });
    expect((await grantAccess(b, other.secret, "cms", "someone@acme.test", "admin")).status).toBe(403);
    expect(b.journal().at(-1)).toMatchObject({ operation: "access.add", result: "rejects", actor: `token:${other.token.id}`, slug: "cms" });
  });
});

describe("the steward: restarting with a token", () => {
  test("any token that deploys the project restarts it, with or without the permission; the verdict journaled under the token", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms", "notes"] });
    const response = await restart(b, secret, "cms");
    expect(await body(response)).toEqual({ status: 200, verdict: { kind: "active", state: "active", subState: "running", restarts: 0 } });
    expect(b.calls).toContainEqual(["reset-failed", "cms"]);
    expect(b.calls).toContainEqual(["restart", "cms"]);
    expect(b.journal().at(-1)).toMatchObject({ operation: "restart", result: "ok", actor: `token:${token.id}`, member: null, slug: "cms", detail: "active, active/running, 0 restarts" });
    // A public project, which a token without public never writes the store of, restarts all the same.
    const plain = await b.ownerToken({ slugs: ["blog"] });
    expect((await restart(b, plain.secret, "blog")).status).toBe(200);
  });

  test("busy while a deployment of it runs; a static site has no service; a person's token below Developer is refused", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms", "notes"] });
    b.installing.add("sitesolide-installer@cms.service");
    expect(await body(await restart(b, secret, "cms"))).toMatchObject({ status: 409, error: "busy", message: expect.stringContaining("a deployment of cms is running") });
    expect(await body(await restart(b, secret, "notes"))).toMatchObject({ status: 404, error: "not-found", message: "notes is a static site: it has no service to restart" });
    expect(b.calls.some((call) => call[0] === "restart")).toBe(false);

    const alice = await b.personToken(ALICE, { slugs: ["blog"] });
    b.seed({ [ALICE]: { blog: "viewer" } });
    expect(await body(await restart(b, alice.secret, "blog"))).toMatchObject({ status: 403, message: `${ALICE} is a Viewer on blog: restarting its service takes a Developer or an Admin` });
    b.seed({ [ALICE]: { blog: "developer" } });
    expect((await restart(b, alice.secret, "blog")).status).toBe(200);
    expect(b.journal().at(-1)).toMatchObject({ operation: "restart", result: "ok", actor: `token:${alice.token.id}`, member: ALICE, slug: "blog" });
  });

  test("a token's restart never holds the secrets' lock: a change of a store waits for nothing while a service will not stop; restarts of the same project wait their turn; one at a time per token", async () => {
    const b = await mount();
    const first = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const second = await b.ownerToken({ slugs: ["cms"] });
    let release!: () => void;
    b.barrier.promise = new Promise((resolve) => (release = resolve));
    // A unit that ignores SIGTERM: its restart hangs.
    const hanging = restart(b, first.secret, "cms");
    await Bun.sleep(20);
    // A change of the store, and the owner's own unlock-protected work, go through meanwhile.
    const write = patch(b, first.secret, "cms", { set: { API_KEY: "rotated" } });
    expect(await Promise.race([write.then((response) => response.status), Bun.sleep(500).then(() => "still waiting")])).toBe(201);
    expect(b.storeEnv("cms")).toContain("API_KEY=rotated");
    // Another token's restart of cms waits for the first one's turn to end; the same token's second is busy at once.
    const queued = restart(b, second.secret, "cms");
    expect(await body(await restart(b, first.secret, "cms"))).toMatchObject({ status: 409, error: "busy", message: startingWith("this token's previous restart is still under way") });
    await Bun.sleep(20);
    expect(b.calls.filter((call) => call[0] === "restart")).toHaveLength(1);
    b.barrier.promise = null;
    release();
    expect((await hanging).status).toBe(200);
    expect((await queued).status).toBe(200);
    expect(b.calls.filter((call) => call[0] === "restart")).toHaveLength(2);
  });

  test("a restart that waited its turn while a deployment of the project started is refused busy then, and journaled so", async () => {
    const b = await mount();
    const first = await b.ownerToken({ slugs: ["cms"] });
    const second = await b.ownerToken({ slugs: ["cms"] });
    let release!: () => void;
    b.barrier.promise = new Promise((resolve) => (release = resolve));
    const running = restart(b, first.secret, "cms");
    await Bun.sleep(20);
    const waiting = restart(b, second.secret, "cms");
    await Bun.sleep(20);
    // The deployment of cms starts now: it restarts the service at its own end.
    b.installing.add("sitesolide-installer@cms.service");
    b.barrier.promise = null;
    release();
    expect((await running).status).toBe(200);
    expect(await body(await waiting)).toMatchObject({ status: 409, error: "busy", message: expect.stringContaining("a deployment of cms is running") });
    expect(b.calls.filter((call) => call[0] === "restart")).toHaveLength(1);
    expect(b.journal().at(-1)).toMatchObject({ operation: "restart", result: "rejects", actor: `token:${second.token.id}`, slug: "cms", detail: "busy" });
  });
});

describe("the steward: the registry from before the permission", () => {
  test("a team.json without the key reads, its tokens refused the store's routes, and is written back with secrets: false", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const teamFile = join(b.root, "state", "team.json");
    const before = JSON.parse(readFileSync(teamFile, "utf8")) as { tokens: { scope: Record<string, unknown>; lastUsedAt: number | null }[] };
    for (const record of before.tokens) {
      delete record.scope.secrets;
      record.lastUsedAt = null;
    }
    writeFileSync(teamFile, JSON.stringify(before));
    expect(readFileSync(teamFile, "utf8")).not.toContain("secrets");
    expect(await body(await list(b, secret, "cms"))).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(await body(await patch(b, secret, "cms", { set: { A: "b" } }))).toMatchObject({ status: 403 });
    // It still deploys and restarts as before.
    expect((await restart(b, secret, "cms")).status).toBe(200);
    // Its last use, written in the background, writes the flag with it.
    await Bun.sleep(30);
    const after = JSON.parse(readFileSync(teamFile, "utf8")) as { tokens: { scope: Record<string, unknown> }[] };
    expect(after.tokens.map((record) => record.scope.secrets)).toEqual([false]);
  });
});

describe("the API in front of the real steward", () => {
  /** The dashboard's API, its steward client calling the bench's control routes as the socket would. */
  function apiOf(b: Bench) {
    const steward = {
      authenticate: (bearer: string) => b.call("POST", "/control/authenticate", { bearer }),
      restart: (bearer: string, slug: string) => b.call("POST", "/control/restart", { bearer, slug }),
    } as unknown as ControlSteward;
    const folder = join(b.root, "api");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "state.json"), "{}");
    const store = createControlStore(openDatabase(join(folder, "dashboard.db")));
    const spool = createSpool(join(folder, "spool"));
    return createApiRoutes({ steward, store, spool, limiter: createLimiter(), tracker: createTracker({ store, steward, spool }), stateFile: join(folder, "state.json"), publicUrl: `https://dashboard.${ZONE}`, zone: ZONE });
  }

  test("a person lowered to Viewer: their token reads the steward's refusal naming the role, journaled, never an unknown project", async () => {
    const b = await mount();
    const api = apiOf(b);
    const { token, secret } = await b.personToken(ALICE, { slugs: ["cms", "blog"] });
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const send = () => api.restartProject(new Request("http://dashboard/api/v1/projects/cms/restart", { method: "POST", headers }), "cms");
    expect((await send()).status).toBe(200);

    b.seed({ [ALICE]: { cms: "viewer", blog: "developer" } });
    const before = b.journal().length;
    expect(await body(await send())).toEqual({
      status: 403,
      error: "out-of-scope",
      message: `${ALICE} is a Viewer on cms: restarting its service takes a Developer or an Admin`,
    });
    expect(b.journal().slice(before).map((line) => [line.operation, line.actor, line.member, line.slug, line.detail])).toEqual([["restart", `token:${token.id}`, ALICE, "cms", "role viewer"]]);

    // An owner's token on a project it does not reach: unknown, nothing journaled.
    const plain = await b.ownerToken({ slugs: ["cms"] });
    const journaled = b.journal().length;
    const elsewhere = await api.restartProject(new Request("http://dashboard/api/v1/projects/blog/restart", { method: "POST", headers: { Authorization: `Bearer ${plain.secret}` } }), "blog");
    expect(await body(elsewhere)).toMatchObject({ status: 404, error: "not-found", message: "no project blog for this token" });
    expect(b.journal()).toHaveLength(journaled);
  });

  test("the route as the dashboard mounts it: a restart waits long enough for one call", () => {
    const routes = restartRoutes({ restartProject: async () => new Response() });
    const delays: number[] = [];
    const server = { timeout: (_req: Request, seconds: number) => void delays.push(seconds) };
    const request = Object.assign(new Request("http://dashboard/"), { params: { slug: "cms" } });
    void routes["/api/v1/projects/:slug/restart"].POST(request as never, server);
    // The client waits `longMs` on a call to the steward; Bun cuts a connection silent past its timeout, 255 s at most.
    expect(delays).toEqual([STEWARD_IDLE_S]);
    expect(delays[0]! * 1000).toBeGreaterThanOrEqual(DEFAULT_TIMEOUTS.longMs);
    expect(delays[0]).toBeLessThanOrEqual(255);
    expect(Object.keys(routes)).toEqual(["/api/v1/projects/:slug/restart"]);
  });
});

// --- the dashboard's control API ------------------------------------------------------

const tokenOf = (letter: string) => `sst_${letter.repeat(43)}`;
const scopeOf = (slugs: string[], secrets: boolean | undefined): Scope => ({ slugs, create: false, outbound: false, domain: false, public: false, ...(secrets === undefined ? {} : { secrets }) });

const GRACE = tokenOf("g");
const NOSEC = tokenOf("n");
const IDENTITIES: Record<string, Identity> = {
  [GRACE]: { id: "bbbbbbbbbbbb", label: "Grace", email: "owner", expiresAt: null, scope: scopeOf(["kanban"], true), owned: [], member: null },
  [NOSEC]: { id: "dddddddddddd", label: "Deployer", email: "owner", expiresAt: null, scope: scopeOf(["kanban"], false), owned: [], member: null },
};

type Refusal = { status: number; error: string; message: string; wait?: number };

const sim = {
  outdated: false,
  restartRefusal: null as Refusal | null,
  asked: [] as { route: string; requested: unknown }[],
};

let apiRoot: string;
let dashboard: ReturnType<typeof Bun.serve>;
let base: string;
let store: ReturnType<typeof createControlStore>;

beforeAll(() => {
  apiRoot = mkdtempSync(join(tmpdir(), "control-restart-api-"));
  writeFileSync(join(apiRoot, "state.json"), "{}");
  const outdated = () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
  const refusal = (one: Refusal) => Response.json({ error: one.error, message: one.message, ...(one.wait === undefined ? {} : { wait: one.wait }) }, { status: one.status });
  /** What the steward judges and the dashboard no longer does: the project. */
  const judged = (bearer: string, slug: string): Response | null => {
    const identity = IDENTITIES[bearer]!;
    if (!identity.owned.includes(slug) && !identity.scope.slugs.includes(slug)) return refusal({ status: 404, error: "not-found", message: `no project ${slug} for this token` });
    return null;
  };
  const steward = {
    authenticate: async (bearer: string) =>
      IDENTITIES[bearer] === undefined
        ? Response.json({ error: "unauthenticated", message: "missing or unknown token" }, { status: 401 })
        : Response.json({ identity: IDENTITIES[bearer] }),
    restart: async (bearer: string, slug: string) => {
      sim.asked.push({ route: "restart", requested: { bearer, slug } });
      if (sim.outdated) return outdated();
      if (sim.restartRefusal !== null) return refusal(sim.restartRefusal);
      const refused = judged(bearer, slug);
      if (refused !== null) return refused;
      return Response.json({ verdict: { kind: "active", state: "active", subState: "running", restarts: 0, unit: "kanban" } });
    },
  } as unknown as ControlSteward;
  store = createControlStore(openDatabase(join(apiRoot, "dashboard.db")));
  const spool = createSpool(join(apiRoot, "spool"));
  const api = createApiRoutes({
    steward,
    store,
    spool,
    limiter: createLimiter(),
    tracker: createTracker({ store, steward, spool }),
    stateFile: join(apiRoot, "state.json"),
    publicUrl: `https://dashboard.${ZONE}`,
    zone: ZONE,
  });
  // The routes as dashboard/server.ts mounts them, their idle delays included.
  dashboard = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: restartRoutes(api),
    fetch: () => new Response("not found", { status: 404 }),
  });
  base = `http://127.0.0.1:${dashboard.port}`;
});

afterAll(() => {
  dashboard.stop(true);
  rmSync(apiRoot, { recursive: true, force: true });
});

beforeEach(() => {
  sim.outdated = false;
  sim.restartRefusal = null;
  sim.asked.length = 0;
});

let address = 1;
/** A fresh address per request unless one is named: the limiter counts per address. */
function headers(token: string, from = `198.51.100.${address++ % 250}`): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-Forwarded-For": from, "Content-Type": "application/json" };
}

const restartIt = (slug: string, token = GRACE, from?: string) => fetch(`${base}/api/v1/projects/${slug}/restart`, { method: "POST", headers: headers(token, from) });

describe("the API: restarting", () => {
  test("any token of the project restarts it, the verdict from known fields alone; another's project reads as unknown", async () => {
    expect(await body(await restartIt("kanban", NOSEC))).toEqual({ status: 200, verdict: { kind: "active", state: "active", subState: "running", restarts: 0 } });
    expect(sim.asked).toEqual([{ route: "restart", requested: { bearer: NOSEC, slug: "kanban" } }]);
    // Judged by the steward: the dashboard asked it.
    expect(await body(await restartIt("notes"))).toMatchObject({ status: 404, error: "not-found", message: "no project notes for this token" });
    expect(sim.asked.at(-1)).toEqual({ route: "restart", requested: { bearer: GRACE, slug: "notes" } });
    sim.restartRefusal = { status: 404, error: "not-found", message: "kanban is a static site: it has no service to restart" };
    expect(await body(await restartIt("kanban"))).toMatchObject({ status: 404, message: "kanban is a static site: it has no service to restart" });
  });

  test("wrong tokens are counted per address: past three, that address waits, another does not", async () => {
    const from = "203.0.113.9";
    for (let i = 0; i < 4; i++) expect((await restartIt("kanban", tokenOf("z"), from)).status).toBe(401);
    const slowed = await restartIt("kanban", GRACE, from);
    expect(slowed.status).toBe(429);
    expect(Number(slowed.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await restartIt("kanban", NOSEC, from)).status).toBe(429);
    expect((await restartIt("kanban", GRACE, "203.0.113.10")).status).toBe(200);
  });
});
