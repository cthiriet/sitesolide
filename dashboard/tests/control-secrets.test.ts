import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTAL_PORT } from "../borrowed/portal";
import { createAccessSystem } from "../src/access/system";
import { openDatabase } from "../src/database";
import { createApiRoutes, SECRETS_CHANGE_IDLE_S, secretsRoutes, STEWARD_IDLE_S } from "../src/control/api";
import type { ControlSteward } from "../src/control/client";
import { createLimiter } from "../src/control/limiter";
import {
  INSTALLER_TEMPLATE,
  MAX_SECRET_NAMES,
  TOKEN_REFUSALS_PER_HOUR,
  TOKEN_RESTARTS_PER_HOUR,
  TOKEN_SECRET_CHANGES_PER_HOUR,
  type Identity,
  type Scope,
  type SecretsListResponse,
  type StewardSecretsChange,
  type TokenView,
} from "../src/control/protocol";
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
 * A token's secrets and restart, both halves.
 *
 * The steward: the real secrets routes (`createSteward`, with the people and
 * the access registry, on a throwaway tree, as people-actions.test.ts mounts
 * them) and the real control routes, wired exactly as dashboard/steward.ts
 * wires them, the real files, journal and token registry; `systemctl` alone
 * simulated. The token judged first, its person's role, its project, its
 * flag; the change all or nothing, one write, one previous version, one
 * journal line per name under `token:<id>`; never a value anywhere but in
 * the file itself.
 *
 * Then the dashboard's API on a real port, the steward reduced to the
 * answers it gives: what the dashboard judges itself, and what it passes on
 * or keeps back.
 */

const ZONE = "test-zone.invalid";
const PASSWORD = "Owner-Password-For-The-Tests-1";
const ALICE = "alice@acme.test";
/** What cms.env holds to begin with: never to come out but from the file and its previous version. */
const CMS_VALUE = "cms-original-value-0b5e2d";
const CMS_ENV = `API_KEY=${CMS_VALUE}\nSMTP_URL=smtp://mail.test-zone.invalid\n`;
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
  file: (name: string) => string;
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
 * cms: restricted, declares cms.env; blog: public, declares blog.env; fresh:
 * restricted, declares fresh.env, which is missing; wiki: restricted,
 * declares nothing, its wiki.env there all the same; hand: its hand.env
 * edited by hand; notes: a static site; the dashboard and the portal. A
 * restricted site's protected block is in service, as the gatekeeper laid it.
 */
async function mount(options: { secretChangesPerHour?: number; restartsPerHour?: number; refusalsPerHour?: number } = {}): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "control-secrets-"));
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
    writeFileSync(join(units, `${slug}.service`), `[Service]\nEnvironment=PORT=${port}\nEnvironmentFile=-${secrets}/${slug}.env\nExecStart=/usr/local/bin/bun run server.ts\n`);
    if (extra.portal === true) writeFileSync(join(caddy, `${slug}.caddy`), protectedBlock(slug));
  };
  app("cms", 3048, { secrets: ["cms.env"], portal: true, env: { DEFAULT_SENDER: `me@${ZONE}` } });
  app("blog", 3049, { secrets: ["blog.env"] });
  app("fresh", 3050, { secrets: ["fresh.env"], portal: true });
  app("wiki", 3051, { portal: true });
  app("hand", 3052, { secrets: ["hand.env"], portal: true });
  manifest("notes", { publicDir: "public" });
  app("dashboard", 3022, { secrets: ["dashboard.env"] });
  app("portal", 3026, { secrets: ["portal.env"] });

  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "portal.env"), "OIDC_ISSUER=https://login.test-zone.invalid\nOIDC_CLIENT_ID=client\nOIDC_CLIENT_SECRET=secret\nOIDC_ALLOWED_DOMAINS=acme.test\n", { mode: 0o600 });
  writeFileSync(join(secrets, "cms.env"), CMS_ENV, { mode: 0o600 });
  writeFileSync(join(secrets, "cms-signing.key"), "-----BEGIN KEY-----\nnot-a-real-key\n", { mode: 0o400 });
  mkdirSync(join(secrets, "cms-secrets"), { mode: 0o755 });
  writeFileSync(join(secrets, "cms-secrets", "x"), "registry-token\n", { mode: 0o400 });
  writeFileSync(join(secrets, "blog.env"), "TOKEN=blog-token\n", { mode: 0o600 });
  writeFileSync(join(secrets, "wiki.env"), "A=b\n", { mode: 0o600 });
  writeFileSync(join(secrets, "hand.env"), "export A=b\n", { mode: 0o600 });

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

  const controlReal = createControlSystem({ stateFolder: state, sitesDir: sites, unitsFolder: units, installerFolder: installer, systemctl: "/bin/false", journalctl: "/bin/false" });
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
    file: (name) => readFileSync(join(secrets, name), "utf8"),
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

/** The previous versions kept, by name. */
const previousVersions = (b: Bench): string[] => {
  const folder = join(b.root, "state", "precedents");
  return existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String).sort() : [];
};

async function body(response: Response): Promise<{ status: number } & Record<string, unknown>> {
  return { status: response.status, ...((await response.json()) as Record<string, unknown>) };
}

const patch = (b: Bench, secret: string, slug: string, change: { set?: Record<string, string>; remove?: string[] }, file = `${slug}.env`) =>
  b.call("PATCH", "/control/secrets", { bearer: secret, slug, file, ...change });
const list = (b: Bench, secret: string, slug: string) => b.call("POST", "/control/secrets/list", { bearer: secret, slug });
const restart = (b: Bench, secret: string, slug: string) => b.call("POST", "/control/restart", { bearer: secret, slug });
const grantAccess = (b: Bench, secret: string, slug: string, who: string, role: string) => b.call("PUT", "/control/access", { bearer: secret, slug, who, role });

describe("the steward: listing a project's secrets with a token", () => {
  test("an owner's token with the permission lists cms's files and variable names, never a value, a size nor a previous version; writable on cms.env alone", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    // A previous version kept: a token is not told so.
    expect((await patch(b, secret, "cms", { set: { EXTRA: `${CANARY}-1` } })).status).toBe(200);
    const response = await list(b, secret, "cms");
    expect(response.status).toBe(200);
    const { secrets } = (await response.json()) as SecretsListResponse;
    expect(secrets.slug).toBe("cms");
    expect(secrets.service).toMatchObject({ unit: "cms", state: "active", subState: "running" });
    expect(secrets.files[0]!.name).toBe("cms.env");
    expect(secrets.files.map((file) => [file.name, file.kind, file.readable, file.bytes, file.previous, file.writable]).sort()).toEqual([
      ["cms-secrets/x", "content", false, null, false, false],
      ["cms-signing.key", "content", false, null, false, false],
      ["cms.env", "variables", false, null, false, true],
    ]);
    expect(secrets.files[0]!.variables).toEqual(["API_KEY", "SMTP_URL", "EXTRA"]);
    expect(Object.keys(secrets)).toEqual(["slug", "service", "files"]);
    expect(b.everywhere()).not.toContain(CMS_VALUE);
    expect(b.everywhere()).not.toContain(CANARY);
    expect(JSON.stringify(secrets)).not.toContain("not-a-real-key");
  });
});

describe("the steward: changing a project's secrets with a token", () => {
  test("sets, replaces and removes in one write: one previous version, each name journaled under token:<id>, the value nowhere", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const before = b.journal().length;
    const response = await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-api`, NEW_ONE: `${CANARY}-new` }, remove: ["SMTP_URL"] });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as StewardSecretsChange;
    expect(answer).toMatchObject({ created: false, set: ["API_KEY", "NEW_ONE"], removed: ["SMTP_URL"], absent: [] });
    expect(answer.file).toMatchObject({ name: "cms.env", readable: false, bytes: null, previous: false, writable: true, variables: ["API_KEY", "NEW_ONE"] });
    expect(b.file("cms.env")).toBe(`API_KEY=${CANARY}-api\nNEW_ONE=${CANARY}-new\n`);
    // One previous version: the file as it was before this write, whole.
    expect(previousVersions(b)).toEqual(["cms.env"]);
    expect(readFileSync(join(b.root, "state", "precedents", "cms.env"), "utf8")).toBe(CMS_ENV);
    const lines = b.journal().slice(before);
    expect(lines.map((line) => [line.operation, line.result, line.actor, line.member, line.slug, line.file, line.variable, line.detail])).toEqual([
      ["set", "ok", `token:${token.id}`, null, "cms", "cms.env", "API_KEY", null],
      ["set", "ok", `token:${token.id}`, null, "cms", "cms.env", "NEW_ONE", null],
      ["remove", "ok", `token:${token.id}`, null, "cms", "cms.env", "SMTP_URL", null],
    ]);
    // Where the values are looked for is really there: the answers, the journal, the console, argv.
    expect(b.everywhere()).toContain('"variable":"NEW_ONE"');
    expect(b.everywhere()).toContain("API_KEY");
    expect(b.printed()).toContain(`control: token ${token.id} created for the owner`);
    expect(b.everywhere()).not.toContain(CANARY);
    expect(b.everywhere()).not.toContain(CMS_VALUE);
  });

  test("a name the JSON reads as `__proto__` is a variable like another: set, never the object's prototype", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const raw = `{"bearer":${JSON.stringify(secret)},"slug":"cms","file":"cms.env","set":{"__proto__":"${CANARY}"}}`;
    const response = await b.call("PATCH", "/control/secrets", raw);
    expect(await body(response)).toMatchObject({ status: 200, set: ["__proto__"] });
    expect(b.file("cms.env")).toContain(`__proto__=${CANARY}`);
  });

  test("creates cms.env when declared and missing, then sets: 201, journaled create then set; a removal alone creates nothing", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["fresh"], secrets: true });
    const removing = await body(await patch(b, secret, "fresh", { remove: ["A"] }));
    expect(removing).toMatchObject({ status: 404, error: "not-found", message: "fresh.env does not exist: there is nothing to remove" });
    expect(existsSync(join(b.root, "secrets", "fresh.env"))).toBe(false);
    const before = b.journal().length;
    const response = await patch(b, secret, "fresh", { set: { API_KEY: CANARY } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ created: true, set: ["API_KEY"], file: { name: "fresh.env", state: "managed", variables: ["API_KEY"] } });
    expect(b.file("fresh.env")).toBe(`API_KEY=${CANARY}\n`);
    expect(b.journal().slice(before).map((line) => [line.operation, line.actor, line.file, line.variable])).toEqual([
      ["create", `token:${token.id}`, "fresh.env", null],
      ["set", `token:${token.id}`, "fresh.env", "API_KEY"],
    ]);
    // `{}` alone on a file already there: nothing written, nothing journaled.
    const journaled = b.journal().length;
    expect(await body(await patch(b, secret, "fresh", {}))).toMatchObject({ status: 200, created: false, set: [], removed: [], absent: [] });
    expect(b.journal()).toHaveLength(journaled);
  });

  test("`{}` alone creates the declared file, empty", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["fresh"], secrets: true });
    expect(await body(await patch(b, secret, "fresh", {}))).toMatchObject({ status: 201, created: true, set: [] });
    expect(b.file("fresh.env")).toBe("");
  });

  test("a token without the permission: list and write refused out-of-scope, journaled 'no secrets permission', a listing as a listing, nothing written; it still restarts", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms"] });
    expect(await body(await list(b, secret, "cms"))).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("this token may not manage secrets") });
    // A listing reads no value: journaled as one, never as a `read`, which Activity says "Tried to read".
    expect(b.journal().at(-1)).toMatchObject({ operation: "list", result: "rejects", actor: `token:${token.id}`, member: null, slug: "cms", file: null, detail: "no secrets permission" });
    expect(await body(await patch(b, secret, "cms", { set: { API_KEY: CANARY } }))).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${token.id}`, detail: "no secrets permission" });
    expect(b.file("cms.env")).toBe(CMS_ENV);
    expect(previousVersions(b)).toEqual([]);
    expect(await body(await restart(b, secret, "cms"))).toMatchObject({ status: 200, verdict: { kind: "active" } });
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("a project outside the token's scope reads as not-found, nothing journaled; the platform's projects are never reachable", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const journaled = b.journal().length;
    for (const slug of ["blog", "ghost", "dashboard", "portal"]) {
      for (const response of [await list(b, secret, slug), await patch(b, secret, slug, { set: { A: "b" } }), await restart(b, secret, slug)]) {
        expect(await body(response)).toMatchObject({ status: 404, error: "not-found", message: `no project ${slug} for this token` });
      }
    }
    // A registry edited by hand to name the dashboard opens nothing of it.
    const teamFile = join(b.root, "state", "team.json");
    const team = JSON.parse(readFileSync(teamFile, "utf8")) as { tokens: { id: string; scope: Scope }[] };
    team.tokens.find((record) => record.id === token.id)!.scope.slugs.push("dashboard");
    writeFileSync(teamFile, JSON.stringify(team));
    expect(await body(await list(b, secret, "dashboard"))).toMatchObject({ status: 404 });
    expect(await body(await patch(b, secret, "dashboard", { set: { A: "b" } }, "dashboard.env"))).toMatchObject({ status: 404 });
    expect(b.journal()).toHaveLength(journaled);
    expect(b.calls.some((call) => call[0] === "restart")).toBe(false);
  });

  test("a person's token: the journal names the token, and the person in member; their person a Viewer now, refused naming the role, journaled; Developer again, it works", async () => {
    const b = await mount();
    const { token, secret } = await b.personToken(ALICE, { slugs: ["cms"], secrets: true });
    const before = b.journal().length;
    expect((await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-1` } })).status).toBe(200);
    expect(b.journal().slice(before)).toEqual([expect.objectContaining({ operation: "set", result: "ok", actor: `token:${token.id}`, member: ALICE, slug: "cms", variable: "API_KEY" })]);

    b.seed({ [ALICE]: { cms: "viewer", blog: "developer" } });
    const refused = await body(await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-2` } }));
    expect(refused).toEqual({ status: 403, error: "out-of-scope", message: `${ALICE} is a Viewer on cms: changing its secrets takes a Developer or an Admin` });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${token.id}`, member: ALICE, slug: "cms", detail: "role viewer" });
    expect(await body(await list(b, secret, "cms"))).toMatchObject({ status: 403, message: `${ALICE} is a Viewer on cms: its secret files are for a Developer or an Admin` });
    expect(await body(await restart(b, secret, "cms"))).toMatchObject({ status: 403, message: `${ALICE} is a Viewer on cms: restarting its service takes a Developer or an Admin` });
    expect(b.journal().at(-1)).toMatchObject({ operation: "restart", result: "rejects", detail: "role viewer" });
    expect(b.file("cms.env")).toContain(`${CANARY}-1`);

    b.seed({ [ALICE]: { cms: "developer" } });
    expect((await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-3` } })).status).toBe(200);
    expect(b.file("cms.env")).toContain(`API_KEY=${CANARY}-3`);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("revoked, or the person lowered, while the write waited behind a restart: nothing written", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    let release!: () => void;
    b.barrier.promise = new Promise((resolve) => (release = resolve));
    // The owner's restart, from the Secrets section, holds the secrets' lock.
    const restarting = b.call("POST", "/restart", { token: b.unlock, slug: "cms" });
    await Bun.sleep(20);
    const write = patch(b, secret, "cms", { set: { LATE: CANARY } });
    await Bun.sleep(20);
    expect((await b.call("POST", "/tokens/revoke", { id: token.id })).status).toBe(200);
    b.barrier.promise = null;
    release();
    expect((await restarting).status).toBe(200);
    expect(await body(await write)).toMatchObject({ status: 401, error: "unauthenticated", message: expect.stringContaining("revoked") });
    expect(b.file("cms.env")).toBe(CMS_ENV);

    // A person lowered while waiting: the same.
    const alice = await b.personToken(ALICE, { slugs: ["cms"], secrets: true });
    b.barrier.promise = new Promise((resolve) => (release = resolve));
    const again = b.call("POST", "/restart", { token: b.unlock, slug: "cms" });
    await Bun.sleep(20);
    const hers = patch(b, alice.secret, "cms", { set: { LATE: CANARY } });
    await Bun.sleep(20);
    b.seed({ [ALICE]: { cms: "viewer" } });
    b.barrier.promise = null;
    release();
    expect((await again).status).toBe(200);
    expect(await body(await hers)).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("Viewer on cms") });
    expect(b.file("cms.env")).toBe(CMS_ENV);
    expect(b.journal().some((line) => line.variable === "LATE")).toBe(false);
  });

  test("a name refused, malformed, reserved, set by the unit or the manifest, a password hash: the whole batch refused, nothing written, a malformed name never quoted", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const malformed = await body(await patch(b, secret, "cms", { set: { GOOD: "x", [`bad-${CANARY}`]: "y" } }));
    expect(malformed).toMatchObject({ status: 400, error: "invalid", message: startingWith("set: entry 2 is not a variable name") });
    expect(await body(await patch(b, secret, "cms", { remove: ["GOOD", `${CANARY} x`] }))).toMatchObject({ status: 400, message: startingWith("remove: entry 2 is not a variable name") });
    for (const [name, message] of [
      ["LD_PRELOAD", "set: LD_PRELOAD changes how the runtime behaves"],
      ["HTTPS_PROXY", "set: HTTPS_PROXY changes how the runtime behaves"],
      ["PORT", "set: PORT is set by the deployment"],
      ["DEFAULT_SENDER", "set: DEFAULT_SENDER is set by the service unit"],
    ] as const) {
      const refused = await body(await patch(b, secret, "cms", { set: { GOOD: "x", [name]: CANARY } }));
      expect(refused).toMatchObject({ status: 400, error: "invalid", message: startingWith(message) });
    }
    expect(await body(await patch(b, secret, "cms", { set: { GOOD: "x", PASSWORD_HASH: CANARY } }))).toMatchObject({
      status: 403,
      error: "out-of-scope",
      message: "PASSWORD_HASH is a password hash, change it with Change password",
    });
    expect(await body(await patch(b, secret, "cms", { remove: ["SMTP_URL", "PASSWORD_HASH"] }))).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(b.file("cms.env")).toBe(CMS_ENV);
    expect(previousVersions(b)).toEqual([]);
    // A refused name is never journaled, but for the password hash: a value pasted in a name's place would stay.
    const refusals = b.journal().filter((line) => line.result === "rejects");
    expect(refusals.map((line) => line.variable)).toEqual([null, null, null, null, "PASSWORD_HASH", "PASSWORD_HASH"]);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("a value refused, a line break, a null byte, a lone surrogate, over 8 KiB: the message never quotes it, nothing written", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    for (const [value, reason] of [
      [`${CANARY}\nINJECTED=1`, "the value must fit on one line"],
      [`${CANARY}\0`, "the value contains a null byte"],
      [`${CANARY}\ud800`, "the value is not valid Unicode"],
      [`${CANARY}${"x".repeat(8 * 1024)}`, "the value is larger than 8 KiB"],
    ] as const) {
      const refused = await body(await patch(b, secret, "cms", { set: { GOOD: "x", API_KEY: value } }));
      expect(refused).toEqual({ status: 400, error: "invalid", message: `set: API_KEY: ${reason}` });
    }
    expect(b.file("cms.env")).toBe(CMS_ENV);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("a file other than cms.env, whatever it is, is out of scope, and never quoted", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    for (const file of ["cms-signing.key", "notes.env", "dashboard.env", "cms-secrets/x", `cms-${CANARY}.env`, "../cms.env"]) {
      const refused = await body(await patch(b, secret, "cms", { set: { A: "b" } }, file));
      expect(refused).toEqual({ status: 403, error: "out-of-scope", message: "a token manages cms.env alone" });
    }
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${token.id}`, file: null });
    expect(b.file("cms-signing.key")).toContain("not-a-real-key");
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("cms.env present but undeclared: refused; absent and undeclared: never created", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["wiki"], secrets: true });
    const message = 'the sitesolide.json deployed for wiki does not declare wiki.env: add "secrets": ["wiki.env"] to it and deploy, then set its variables';
    expect(await body(await patch(b, secret, "wiki", { set: { A: "c" } }))).toEqual({ status: 403, error: "out-of-scope", message });
    expect(b.file("wiki.env")).toBe("A=b\n");
    // Listed, but not writable.
    const { secrets } = (await (await list(b, secret, "wiki")).json()) as SecretsListResponse;
    expect(secrets.files.map((file) => [file.name, file.writable])).toEqual([["wiki.env", false]]);
    unlinkSync(join(b.root, "secrets", "wiki.env"));
    for (const change of [{ set: { A: "c" } }, {}]) expect(await body(await patch(b, secret, "wiki", change))).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(existsSync(join(b.root, "secrets", "wiki.env"))).toBe(false);
  });

  test("a file edited by hand in a form the steward does not rewrite: unmanaged, 409, untouched", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["hand"], secrets: true });
    expect(await body(await patch(b, secret, "hand", { set: { B: CANARY } }))).toMatchObject({ status: 409, error: "unmanaged", message: startingWith("hand.env is not managed here: line 1") });
    expect(b.file("hand.env")).toBe("export A=b\n");
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("removing an absent name is said in absent and journals nothing; a set never says whether the value changed", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const journaled = b.journal().length;
    expect(await body(await patch(b, secret, "cms", { remove: ["NOT_THERE"] }))).toMatchObject({ status: 200, removed: [], absent: ["NOT_THERE"], set: [] });
    expect(b.journal()).toHaveLength(journaled);
    expect(b.file("cms.env")).toBe(CMS_ENV);
    expect(previousVersions(b)).toEqual([]);
    // The same value, then another: the same answer, both written and journaled.
    const same = (await (await patch(b, secret, "cms", { set: { API_KEY: CMS_VALUE } })).json()) as StewardSecretsChange;
    const other = (await (await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-other` } })).json()) as StewardSecretsChange;
    expect({ ...same, file: { ...same.file, modifiedAt: 0 } }).toEqual({ ...other, file: { ...other.file, modifiedAt: 0 } });
    expect(b.journal().slice(journaled).map((line) => [line.operation, line.variable])).toEqual([
      ["set", "API_KEY"],
      ["set", "API_KEY"],
    ]);
  });

  test("a batch that would grow the file past 256 KiB: refused whole, nothing written", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms", "fresh"], secrets: true });
    const set = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`BIG_${i}`, `${CANARY}${"v".repeat(7000)}`]));
    expect(await body(await patch(b, secret, "cms", { set }))).toEqual({ status: 400, error: "invalid", message: "the file would grow beyond 256 KiB" });
    expect(b.file("cms.env")).toBe(CMS_ENV);
    // Nor a file created for a change that does not fit.
    expect(await body(await patch(b, secret, "fresh", { set }))).toMatchObject({ status: 400 });
    expect(existsSync(join(b.root, "secrets", "fresh.env"))).toBe(false);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("fifty names a request; 120 names and 30 restarts an hour per token: 429 with wait", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const names = (count: number, prefix: string) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}_${i}`, "v"]));
    expect(await body(await patch(b, secret, "cms", { set: names(MAX_SECRET_NAMES + 1, "N") }))).toMatchObject({ status: 400, message: "50 variable names at most in one change, set and removed together: split it" });
    expect((await patch(b, secret, "cms", { set: names(50, "N") })).status).toBe(200);
    expect((await patch(b, secret, "cms", { remove: Object.keys(names(50, "N")) })).status).toBe(200);
    const over = await body(await patch(b, secret, "cms", { set: names(21, "M") }));
    expect(over).toMatchObject({ status: 429, error: "too-many-attempts", message: startingWith(`${TOKEN_SECRET_CHANGES_PER_HOUR} variable names set or removed per hour at most for a token`) });
    expect(over.wait).toBeGreaterThan(0);
    expect(over.wait).toBeLessThanOrEqual(3600);
    expect(b.file("cms.env")).not.toContain("M_0");
    expect((await patch(b, secret, "cms", { set: names(20, "M") })).status).toBe(200);
    expect((await patch(b, secret, "cms", {})).status).toBe(429);
    // Another token has its own hour.
    const other = await b.ownerToken({ slugs: ["cms"], secrets: true });
    expect((await patch(b, other.secret, "cms", { set: { OTHER: "v" } })).status).toBe(200);
    b.clock.t += 3_600_000;
    expect((await patch(b, secret, "cms", { set: names(50, "L") })).status).toBe(200);

    for (let i = 0; i < TOKEN_RESTARTS_PER_HOUR; i++) expect((await restart(b, secret, "cms")).status).toBe(200);
    const restarts = await body(await restart(b, secret, "cms"));
    expect(restarts).toMatchObject({ status: 429, error: "too-many-attempts", message: startingWith(`${TOKEN_RESTARTS_PER_HOUR} restarts per hour at most for a token`) });
    expect(restarts.wait).toBeGreaterThan(0);
    expect(b.calls.filter((call) => call[0] === "restart")).toHaveLength(TOKEN_RESTARTS_PER_HOUR);
  });

  test("an owner's token without public: a write refused on a public project, allowed on a restricted one; list and restart allowed; with public, or a person's token by its role, allowed", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms", "blog"], secrets: true });
    const refused = await body(await patch(b, secret, "blog", { set: { TOKEN: CANARY } }));
    expect(refused).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("blog is not restricted on the machine") });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${token.id}`, slug: "blog", detail: "not restricted" });
    expect(b.file("blog.env")).toBe("TOKEN=blog-token\n");
    expect((await patch(b, secret, "cms", { set: { API_KEY: "v" } })).status).toBe(200);
    expect((await list(b, secret, "blog")).status).toBe(200);
    expect((await restart(b, secret, "blog")).status).toBe(200);

    const open = await b.ownerToken({ slugs: ["blog"], secrets: true, public: true });
    expect((await patch(b, open.secret, "blog", { set: { TOKEN: "v" } })).status).toBe(200);
    const alice = await b.personToken(ALICE, { slugs: ["blog"], secrets: true });
    expect((await patch(b, alice.secret, "blog", { set: { TOKEN: "w" } })).status).toBe(200);
    expect(b.file("blog.env")).toBe("TOKEN=w\n");
  });

  test("an owner's token without public changes the secrets of a project it could deploy as it stands alone: paths exempted from the portal, or a portal asked for and not in place, are public", async () => {
    const b = await mount();
    // hooks: behind the portal but for /webhook/*, which any visitor reaches; a deployment of it by this token is refused.
    const hooks = { slug: "hooks", start: "/usr/local/bin/bun run server.ts", port: 3060, publicDir: "public", secrets: ["hooks.env"], portal: true, portalExempt: ["/webhook/*"] };
    mkdirSync(join(b.root, "sites", "hooks"), { recursive: true });
    writeFileSync(join(b.root, "sites", "hooks", "sitesolide.json"), JSON.stringify(hooks));
    writeFileSync(join(b.root, "units", "hooks.service"), `[Service]\nEnvironment=PORT=3060\nEnvironmentFile=-${join(b.root, "secrets")}/hooks.env\nExecStart=/usr/local/bin/bun run server.ts\n`);
    writeFileSync(join(b.root, "caddy", "hooks.caddy"), protectedBlock("hooks"));
    writeFileSync(join(b.root, "secrets", "hooks.env"), "WEBHOOK_SECRET=original\n", { mode: 0o600 });
    const { token, secret } = await b.ownerToken({ slugs: ["hooks", "cms"], secrets: true });
    const exempted = await body(await patch(b, secret, "hooks", { set: { WEBHOOK_SECRET: CANARY } }));
    expect(exempted).toMatchObject({ status: 403, error: "out-of-scope", message: startingWith("hooks is not restricted on the machine as this token could deploy it") });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${token.id}`, slug: "hooks", detail: "not restricted" });
    expect(b.file("hooks.env")).toBe("WEBHOOK_SECRET=original\n");

    // cms asks for the portal, but its protected block is not in service: general access reads it public.
    unlinkSync(join(b.root, "caddy", "cms.caddy"));
    expect(await body(await patch(b, secret, "cms", { set: { API_KEY: CANARY } }))).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(b.file("cms.env")).toBe(CMS_ENV);
    writeFileSync(join(b.root, "caddy", "cms.caddy"), protectedBlock("cms"));
    expect((await patch(b, secret, "cms", { set: { API_KEY: "v" } })).status).toBe(200);
    // With public, the token deploys both as they stand.
    const open = await b.ownerToken({ slugs: ["hooks"], secrets: true, public: true });
    expect((await patch(b, open.secret, "hooks", { set: { WEBHOOK_SECRET: "rotated" } })).status).toBe(200);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("a token's refusals are bounded per hour, charged before the line is written: past them too-many-attempts, journaled no more, and what it changed stays in the journal", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["cms"], secrets: true });
    // Minted now: the owner's unlock does not last the hour below.
    const idle = await b.ownerToken({ slugs: ["cms"] });
    // The theft: three variables replaced.
    expect((await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-1`, SMTP_URL: "smtp://elsewhere.invalid", EXTRA: "x" } })).status).toBe(200);
    const sets = () => b.journal().filter((line) => line.actor === `token:${token.id}` && line.result === "ok" && line.operation === "set");
    const refusals = () => b.journal().filter((line) => line.actor === `token:${token.id}` && line.result === "rejects");
    let bounded = 0;
    let wait = 0;
    // Then twenty refused requests a minute, a whole hour: 1,200 lines through the shared bound before.
    for (let minute = 1; minute <= 60; minute++) {
      b.clock.t += 60_000;
      for (let i = 0; i < 20; i++) {
        const answer = await body(await patch(b, secret, "cms", { set: { A: "b" } }, "other.env"));
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
    expect((await patch(b, secret, "cms", { set: { API_KEY: `${CANARY}-1`, SMTP_URL: "smtp://elsewhere.invalid", EXTRA: "x" } })).status).toBe(200);
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

  test("a token's restart never holds the secrets' lock: a change waits for nothing while a service will not stop; restarts of the same project wait their turn; one at a time per token", async () => {
    const b = await mount();
    const first = await b.ownerToken({ slugs: ["cms"], secrets: true });
    const second = await b.ownerToken({ slugs: ["cms"] });
    let release!: () => void;
    b.barrier.promise = new Promise((resolve) => (release = resolve));
    // A unit that ignores SIGTERM: its restart hangs.
    const hanging = restart(b, first.secret, "cms");
    await Bun.sleep(20);
    // A change of secrets, and the owner's own unlock-protected work, go through meanwhile.
    const write = patch(b, first.secret, "cms", { set: { API_KEY: "rotated" } });
    expect(await Promise.race([write.then((response) => response.status), Bun.sleep(500).then(() => "still waiting")])).toBe(200);
    expect(b.file("cms.env")).toContain("API_KEY=rotated");
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
  test("a team.json without the key reads, its tokens refused the secrets routes, and is written back with secrets: false", async () => {
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
      secretsList: (bearer: string, slug: string) => b.call("POST", "/control/secrets/list", { bearer, slug }),
      secretsChange: (requested: object) => b.call("PATCH", "/control/secrets", requested),
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
    const { token, secret } = await b.personToken(ALICE, { slugs: ["cms", "blog"], secrets: true });
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const send = (body: object) => api.changeProjectSecrets(new Request("http://dashboard/api/v1/projects/cms/secrets/cms.env", { method: "PATCH", headers, body: JSON.stringify(body) }), "cms", "cms.env");
    expect((await send({ set: { API_KEY: "v2" } })).status).toBe(200);

    b.seed({ [ALICE]: { cms: "viewer", blog: "developer" } });
    const before = b.journal().length;
    expect(await body(await send({ set: { API_KEY: CANARY } }))).toEqual({ status: 403, error: "out-of-scope", message: `${ALICE} is a Viewer on cms: changing its secrets takes a Developer or an Admin` });
    expect(await body(await api.projectSecrets(new Request("http://dashboard/api/v1/projects/cms/secrets", { headers }), "cms"))).toEqual({
      status: 403,
      error: "out-of-scope",
      message: `${ALICE} is a Viewer on cms: its secret files are for a Developer or an Admin`,
    });
    expect(await body(await api.restartProject(new Request("http://dashboard/api/v1/projects/cms/restart", { method: "POST", headers }), "cms"))).toEqual({
      status: 403,
      error: "out-of-scope",
      message: `${ALICE} is a Viewer on cms: restarting its service takes a Developer or an Admin`,
    });
    expect(b.journal().slice(before).map((line) => [line.operation, line.actor, line.member, line.slug, line.detail])).toEqual([
      ["set", `token:${token.id}`, ALICE, "cms", "role viewer"],
      ["list", `token:${token.id}`, ALICE, "cms", "role viewer"],
      ["restart", `token:${token.id}`, ALICE, "cms", "role viewer"],
    ]);
    expect(b.file("cms.env")).toContain("API_KEY=v2");

    // Without the permission, and another file: the steward's refusals, journaled.
    const plain = await b.ownerToken({ slugs: ["cms"] });
    const plainHeaders = { Authorization: `Bearer ${plain.secret}`, "Content-Type": "application/json" };
    const other = await api.changeProjectSecrets(new Request("http://dashboard/api/v1/projects/cms/secrets/cms.env", { method: "PATCH", headers: plainHeaders, body: JSON.stringify({ set: { A: "b" } }) }), "cms", "cms.env");
    expect(await body(other)).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("may not manage secrets") });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", actor: `token:${plain.token.id}`, detail: "no secrets permission" });
    b.seed({ [ALICE]: { cms: "developer" } });
    const wrongFile = await api.changeProjectSecrets(new Request("http://dashboard/api/v1/projects/cms/secrets/cms-signing.key", { method: "PATCH", headers, body: JSON.stringify({ set: { A: "b" } }) }), "cms", "cms-signing.key");
    expect(await body(wrongFile)).toEqual({ status: 403, error: "out-of-scope", message: "a token manages cms.env alone" });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", actor: `token:${token.id}`, file: null, detail: "out-of-scope" });
    // An owner's token on a project it does not reach: unknown, nothing journaled.
    const journaled = b.journal().length;
    expect(await body(await api.projectSecrets(new Request("http://dashboard/api/v1/projects/wiki/secrets", { headers: plainHeaders }), "wiki"))).toMatchObject({ status: 404, error: "not-found", message: "no project wiki for this token" });
    expect(b.journal()).toHaveLength(journaled);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("the routes as the dashboard mounts them: a change waits long enough for its write and its restart, a restart for one call", () => {
    const routes = secretsRoutes({
      projectSecrets: async () => new Response(),
      changeProjectSecrets: async () => new Response(),
      restartProject: async () => new Response(),
    });
    const delays: number[] = [];
    const server = { timeout: (_req: Request, seconds: number) => void delays.push(seconds) };
    const request = (slug: string, file?: string) => Object.assign(new Request("http://dashboard/"), { params: { slug, ...(file === undefined ? {} : { file }) } });
    void routes["/api/v1/projects/:slug/secrets/:file"].PATCH(request("cms", "cms.env") as never, server);
    void routes["/api/v1/projects/:slug/restart"].POST(request("cms") as never, server);
    // The client waits `longMs` on each call to the steward; Bun cuts a connection silent past its timeout, 255 s at most.
    expect(delays[0]! * 1000).toBeGreaterThanOrEqual(2 * DEFAULT_TIMEOUTS.longMs);
    expect(delays[0]).toBe(SECRETS_CHANGE_IDLE_S);
    expect(delays[0]).toBeLessThanOrEqual(255);
    expect(delays[1]).toBe(STEWARD_IDLE_S);
    expect(delays[1]! * 1000).toBeGreaterThanOrEqual(DEFAULT_TIMEOUTS.longMs);
  });
});

// --- the dashboard's control API ------------------------------------------------------

const tokenOf = (letter: string) => `sst_${letter.repeat(43)}`;
const scopeOf = (slugs: string[], secrets: boolean | undefined): Scope => ({ slugs, create: false, outbound: false, domain: false, public: false, ...(secrets === undefined ? {} : { secrets }) });

const GRACE = tokenOf("g");
const NOSEC = tokenOf("n");
const OLDER = tokenOf("o");
const LINUS = tokenOf("l");
const IDENTITIES: Record<string, Identity> = {
  [GRACE]: { id: "bbbbbbbbbbbb", label: "Grace", email: "owner", expiresAt: null, scope: scopeOf(["kanban"], true), owned: [], member: null },
  [NOSEC]: { id: "dddddddddddd", label: "Deployer", email: "owner", expiresAt: null, scope: scopeOf(["kanban"], false), owned: [], member: null },
  // What a steward from before the permission answers: no `secrets` key at all.
  [OLDER]: { id: "eeeeeeeeeeee", label: "Old", email: "owner", expiresAt: null, scope: scopeOf(["kanban"], undefined), owned: [], member: null },
  [LINUS]: { id: "cccccccccccc", label: "Linus", email: "owner", expiresAt: null, scope: scopeOf([], true), owned: ["notes"], member: null },
};

type Refusal = { status: number; error: string; message: string; wait?: number };

const sim = {
  outdated: false,
  refusal: null as Refusal | null,
  restartRefusal: null as Refusal | null,
  created: false,
  asked: [] as { route: string; requested: unknown }[],
};

/** A file as the steward might answer it, with what a token must never see in it. */
const stewardFile = {
  name: "kanban.env",
  kind: "variables",
  state: "managed",
  reason: null,
  expected: "site-kanban:site-kanban 0600",
  readable: true,
  variables: ["API_KEY"],
  passwords: [],
  bytes: 42,
  modifiedAt: 1_760_000_000_000,
  previous: true,
  restartPending: true,
  writable: true,
  value: CANARY,
};

let apiRoot: string;
let dashboard: ReturnType<typeof Bun.serve>;
let base: string;
let store: ReturnType<typeof createControlStore>;

beforeAll(() => {
  apiRoot = mkdtempSync(join(tmpdir(), "control-secrets-api-"));
  writeFileSync(join(apiRoot, "state.json"), "{}");
  const outdated = () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
  const refusal = (one: Refusal) => Response.json({ error: one.error, message: one.message, ...(one.wait === undefined ? {} : { wait: one.wait }) }, { status: one.status });
  /** What the steward judges and the dashboard no longer does: the project, the flag, the file. */
  const judged = (bearer: string, slug: string, work: "list" | "write" | "restart", file?: string): Response | null => {
    const identity = IDENTITIES[bearer]!;
    if (!identity.owned.includes(slug) && !identity.scope.slugs.includes(slug)) return refusal({ status: 404, error: "not-found", message: `no project ${slug} for this token` });
    if (work !== "restart" && identity.scope.secrets !== true) return refusal({ status: 403, error: "out-of-scope", message: "this token may not manage secrets: ask the owner of the machine for one that may manage secrets" });
    if (file !== undefined && file !== `${slug}.env`) return refusal({ status: 403, error: "out-of-scope", message: `a token manages ${slug}.env alone` });
    return null;
  };
  const steward = {
    authenticate: async (bearer: string) =>
      IDENTITIES[bearer] === undefined
        ? Response.json({ error: "unauthenticated", message: "missing or unknown token" }, { status: 401 })
        : Response.json({ identity: IDENTITIES[bearer] }),
    secretsList: async (bearer: string, slug: string) => {
      sim.asked.push({ route: "list", requested: { bearer, slug } });
      if (sim.outdated) return outdated();
      if (sim.refusal !== null) return refusal(sim.refusal);
      const refused = judged(bearer, slug, "list");
      if (refused !== null) return refused;
      return Response.json({
        secrets: { slug, service: { unit: slug, state: "active", subState: "running", startedAt: 1, mainPid: 4242 }, files: [stewardFile], portal: { requested: true } },
        extra: CANARY,
      });
    },
    secretsChange: async (requested: unknown) => {
      sim.asked.push({ route: "change", requested });
      if (sim.outdated) return outdated();
      if (sim.refusal !== null) return refusal(sim.refusal);
      const { bearer, slug, file, set, remove } = requested as { bearer: string; slug: string; file: string; set: Record<string, string>; remove: string[] };
      const refused = judged(bearer, slug, "write", file);
      if (refused !== null) return refused;
      return Response.json(
        { file: stewardFile, created: sim.created, set: Object.keys(set), removed: remove, absent: [], echo: Object.values(set) },
        { status: sim.created ? 201 : 200 },
      );
    },
    restart: async (bearer: string, slug: string) => {
      sim.asked.push({ route: "restart", requested: { bearer, slug } });
      if (sim.outdated) return outdated();
      if (sim.restartRefusal !== null) return refusal(sim.restartRefusal);
      const refused = judged(bearer, slug, "restart");
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
    routes: secretsRoutes(api),
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
  sim.refusal = null;
  sim.restartRefusal = null;
  sim.created = false;
  sim.asked.length = 0;
});

let address = 1;
/** A fresh address per request unless one is named: the limiter counts per address. */
function headers(token: string, from = `198.51.100.${address++ % 250}`): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-Forwarded-For": from, "Content-Type": "application/json" };
}

const read = (slug: string, token = GRACE) => fetch(`${base}/api/v1/projects/${slug}/secrets`, { headers: headers(token) });
const change = (slug: string, body: unknown, options: { token?: string; file?: string; from?: string } = {}) =>
  fetch(`${base}/api/v1/projects/${slug}/secrets/${options.file ?? `${slug}.env`}`, {
    method: "PATCH",
    headers: headers(options.token ?? GRACE, options.from),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const restartIt = (slug: string, token = GRACE, from?: string) => fetch(`${base}/api/v1/projects/${slug}/restart`, { method: "POST", headers: headers(token, from) });

describe("the API: a project's secrets", () => {
  test("GET passes the bearer and the slug, and sends back the known fields alone, every file write-only", async () => {
    const response = await read("kanban");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      secrets: {
        slug: "kanban",
        service: { unit: "kanban", state: "active", subState: "running", startedAt: 1 },
        files: [
          {
            name: "kanban.env",
            kind: "variables",
            state: "managed",
            reason: null,
            expected: "site-kanban:site-kanban 0600",
            readable: false,
            variables: ["API_KEY"],
            passwords: [],
            bytes: null,
            modifiedAt: 1_760_000_000_000,
            previous: false,
            restartPending: true,
            writable: true,
          },
        ],
      },
    });
    expect(text).not.toContain(CANARY);
    expect(sim.asked).toEqual([{ route: "list", requested: { bearer: GRACE, slug: "kanban" } }]);
  });

  test("the project and the flag are the steward's to judge, which journals its refusals: another token's project, a token without the permission, relayed in their codes", async () => {
    expect(await body(await read("notes"))).toMatchObject({ status: 404, error: "not-found", message: "no project notes for this token" });
    expect(await body(await read("kanban", NOSEC))).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("may not manage secrets") });
    expect(sim.asked).toEqual([
      { route: "list", requested: { bearer: GRACE, slug: "notes" } },
      { route: "list", requested: { bearer: NOSEC, slug: "kanban" } },
    ]);
    expect((await read("notes", LINUS)).status).toBe(200);
  });

  test("a steward from before: not-available, saying to run sitesolide upgrade, the token without the key included", async () => {
    sim.outdated = true;
    for (const token of [GRACE, OLDER]) {
      expect(await body(await read("kanban", token))).toMatchObject({ status: 503, error: "not-available", message: expect.stringContaining("sitesolide upgrade") });
      expect(await body(await change("kanban", { set: { A: "b" } }, { token }))).toMatchObject({ status: 503, error: "not-available" });
      expect(await body(await restartIt("kanban", token))).toMatchObject({ status: 503, error: "not-available" });
    }
  });
});

describe("the API: changing them", () => {
  test("names and values passed on, the answer built from known fields: never a value, even one the steward would send back", async () => {
    const response = await change("kanban", { set: { API_KEY: CANARY }, remove: ["OLD"] });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({
      file: expect.objectContaining({ name: "kanban.env", readable: false, bytes: null, previous: false, writable: true }),
      created: false,
      set: ["API_KEY"],
      removed: ["OLD"],
      absent: [],
      restart: null,
    });
    expect(sim.asked).toEqual([{ route: "change", requested: { bearer: GRACE, slug: "kanban", file: "kanban.env", set: { API_KEY: CANARY }, remove: ["OLD"] } }]);
    sim.created = true;
    expect(await body(await change("kanban", {}))).toMatchObject({ status: 201, created: true });
  });

  test("the body judged before the steward is asked: an unknown field, set not an object, remove not a list, a name in both, over fifty names, a malformed name, a value refused; over 512 KiB, too-large", async () => {
    const fifty = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`N_${i}`, "v"]));
    for (const [sent, message] of [
      [{ set: {}, values: { A: CANARY } }, "unexpected field: send set, remove and restart alone"],
      [{ set: [["A", "b"]] }, "set: an object of variable names and their values"],
      [{ set: "A=b" }, "set: an object of variable names and their values"],
      [{ remove: "A" }, "remove: a list of variable names"],
      [{ set: { A: "b" }, remove: ["A"] }, "A is both set and removed: name it in one list"],
      [{ set: fifty }, "50 variable names at most in one change, set and removed together: split it"],
      [{ set: { [CANARY]: "b" } }, "set: entry 1 is not a variable name"],
      [{ set: { A: `${CANARY}\n` } }, "set: A: the value must fit on one line"],
      [{ set: { A: 1 } }, "set: A: the value must be a string"],
      [{ restart: "yes" }, "restart must be true or false"],
    ] as const) {
      const refused = await body(await change("kanban", sent));
      expect(refused).toMatchObject({ status: 400, error: "invalid", message: startingWith(message) });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
    }
    expect(await body(await change("kanban", "{"))).toMatchObject({ status: 400, error: "invalid" });
    expect(await body(await change("kanban", { set: { A: "x".repeat(512 * 1024) } }))).toMatchObject({ status: 413, error: "too-large" });
    expect(sim.asked).toEqual([]);
  });

  test("a token without the permission, a file other than <slug>.env, another token's project: the steward judges them, the file as the URL names it, never quoted back", async () => {
    expect(await body(await change("kanban", { set: { A: "b" } }, { token: NOSEC }))).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("may not manage secrets") });
    for (const file of ["kanban-signing.key", "notes.env", "dashboard.env", `kanban-${CANARY}.env`]) {
      const refused = await body(await change("kanban", { set: { A: "b" } }, { file }));
      expect(refused).toEqual({ status: 403, error: "out-of-scope", message: "a token manages kanban.env alone" });
    }
    expect(await body(await change("notes", { set: { A: "b" } }))).toMatchObject({ status: 404, error: "not-found" });
    expect(sim.asked.map((one) => (one.requested as { file: string }).file)).toEqual(["kanban.env", "kanban-signing.key", "notes.env", "dashboard.env", `kanban-${CANARY}.env`, "notes.env"]);
  });

  test("with restart: the write, then the restart, both in the answer; a refused restart keeps the write's status", async () => {
    const both = await body(await change("kanban", { set: { A: "b" }, restart: true }));
    expect(both).toMatchObject({ status: 200, set: ["A"], restart: { verdict: { kind: "active", state: "active", subState: "running", restarts: 0 } } });
    expect((both.restart as { verdict: Record<string, unknown> }).verdict).not.toHaveProperty("unit");
    expect(sim.asked.map((one) => one.route)).toEqual(["change", "restart"]);

    sim.created = true;
    sim.restartRefusal = { status: 409, error: "busy", message: "a deployment of kanban is running, and restarts it once done: wait for it to finish" };
    const busy = await body(await change("kanban", { set: { A: "b" }, restart: true }));
    expect(busy).toMatchObject({ status: 201, created: true, restart: { error: "busy", message: expect.stringContaining("a deployment of kanban is running") } });
    sim.restartRefusal = { status: 429, error: "too-many-attempts", message: "30 restarts per hour at most for a token: try again in 60 s", wait: 60 };
    expect(await body(await change("kanban", { set: { A: "b" }, restart: true }))).toMatchObject({ status: 201, restart: { error: "too-many-attempts", wait: 60 } });

    // A write refused: no restart asked.
    sim.asked.length = 0;
    sim.refusal = { status: 400, error: "invalid", message: "the file would grow beyond 256 KiB" };
    expect(await body(await change("kanban", { set: { A: "b" }, restart: true }))).toMatchObject({ status: 400, error: "invalid" });
    expect(sim.asked.map((one) => one.route)).toEqual(["change"]);
  });

  test("the steward's refusals in the API's codes: its queue full is busy, its hourly bound keeps its wait, a file it does not rewrite is unmanaged", async () => {
    sim.refusal = { status: 503, error: "failure", message: "the server is busy, try again in a moment" };
    expect(await body(await change("kanban", { set: { A: "b" } }))).toMatchObject({ status: 409, error: "busy" });
    // A restart's own 503, its turn's queue full or the socket's requests in flight: busy too.
    sim.restartRefusal = { status: 503, error: "failure", message: "the server is busy, try again in a moment" };
    expect(await body(await restartIt("kanban"))).toMatchObject({ status: 409, error: "busy", message: "the server is busy with other changes: try again in a moment" });
    sim.restartRefusal = null;
    sim.refusal = { status: 429, error: "too-many-attempts", message: "120 variable names set or removed per hour at most for a token: try again in 42 s", wait: 42 };
    const bounded = await change("kanban", { set: { A: "b" } });
    expect(bounded.headers.get("retry-after")).toBe("42");
    expect(await body(bounded)).toMatchObject({ status: 429, error: "too-many-attempts", wait: 42 });
    sim.refusal = { status: 409, error: "unmanaged", message: "kanban.env is not managed here: line 1: unquoted value with whitespace, a quote or a backslash" };
    expect(await body(await change("kanban", { set: { A: "b" } }))).toMatchObject({ status: 409, error: "unmanaged", message: startingWith("kanban.env is not managed here") });
    sim.refusal = { status: 403, error: "out-of-scope", message: "kanban is not restricted on the machine" };
    expect(await body(await read("kanban"))).toMatchObject({ status: 403, error: "out-of-scope" });
  });

  test("a value sent never appears in the answer, in dashboard.db, nor on the console, even when the steward refuses quoting it", async () => {
    const printed: unknown[][] = [];
    for (const method of ["log", "error", "warn", "info"] as const) {
      const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args));
      spies.push(spy as unknown as Mock<(...args: unknown[]) => void>);
    }
    const texts: string[] = [];
    const send = async (sent: unknown) => {
      const response = await change("kanban", sent);
      texts.push(await response.text());
      return response.status;
    };
    expect(await send({ set: { API_KEY: CANARY } })).toBe(200);
    sim.refusal = { status: 400, error: "invalid", message: `set: API_KEY: ${CANARY} is refused` };
    expect(await send({ set: { API_KEY: CANARY } })).toBe(400);
    expect(texts.at(-1)).toContain("its message is withheld");
    sim.refusal = { status: 500, error: "failure", message: `boom ${CANARY}` };
    expect(await send({ set: { API_KEY: CANARY } })).toBe(502);
    sim.refusal = null;
    expect(await send({ set: { API_KEY: `${CANARY}\n` } })).toBe(400);
    for (const text of texts) expect(text).not.toContain(CANARY);
    expect(JSON.stringify(store.listAudit(1000))).not.toContain(CANARY);
    for (const name of readdirSync(apiRoot).filter((one) => one.startsWith("dashboard.db"))) {
      expect(readFileSync(join(apiRoot, name)).toString("latin1")).not.toContain(CANARY);
    }
    expect(JSON.stringify(printed)).not.toContain(CANARY);
  });
});

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
    expect((await change("kanban", { set: { A: "b" } }, { from })).status).toBe(429);
    expect((await restartIt("kanban", GRACE, "203.0.113.10")).status).toBe(200);
  });
});
