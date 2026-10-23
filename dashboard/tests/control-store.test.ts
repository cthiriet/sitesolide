import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTAL_PORT } from "../borrowed/portal";
import type { StoreChangeResponse, StoreView } from "../borrowed/store-protocol";
import { createAccessSystem } from "../src/access/system";
import { openDatabase } from "../src/database";
import { createApiRoutes, SECRETS_CHANGE_IDLE_S, storeRoutes } from "../src/control/api";
import { localControlSteward, type ControlSteward } from "../src/control/client";
import { createLimiter } from "../src/control/limiter";
import { INSTALLER_TEMPLATE, MAX_SECRET_NAMES, MAX_SECRETS_BODY_BYTES, type Identity, type Scope, type TokenView } from "../src/control/protocol";
import { FILE_NAME_REFUSAL } from "../src/control/secrets";
import { createSpool } from "../src/control/spool";
import { createControlSteward, isControlPath, STORE_FORM } from "../src/control/steward";
import { createControlStore } from "../src/control/store";
import { createControlSystem, type ControlSystem } from "../src/control/system";
import { MAX_UNCARRIED_NAMES } from "../src/control/tokens";
import { createTracker } from "../src/control/tracker";
import { createMembersSystem } from "../src/people/system";
import type { Who } from "../src/people/actions";
import { reread } from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";
import type { StoreForToken } from "../src/secrets/store-api";
import { createSteward } from "../src/secrets/steward";
import { createSystem, type Command, type System } from "../src/secrets/system";
import { readRegistryFile, registryOf, writeRegistry, type People } from "./registry-fixtures";

/**
 * A token's work on a project's store, both halves.
 *
 * The steward: the real control routes, wired as dashboard/steward.ts wires
 * them to the real secrets routes for the people, the access registry, the
 * journal of refusals and whether a project is restricted; the store's own
 * work (src/secrets/store-api.ts, the secrets steward's, which another part
 * of this release writes) simulated by a fake that records what it was
 * handed and lays the store's folder as the real one does. What is judged
 * here is what the control routes decide before handing anything over: the
 * token, its person's role, its flag, the slug deployed or to be created,
 * what a removed project or another token left under a name, the hour.
 *
 * Then the same routes with the secrets steward's real store behind them,
 * through the dashboard's API on a real port and the steward on a real
 * socket: the token path end to end, the values written in the store's env
 * and files, and nowhere else.
 *
 * Then the dashboard's API on a real port, the steward reduced to the
 * answers it gives: what the dashboard judges itself, and what it passes on,
 * keeps back, or never sends back.
 */

const ZONE = "test-zone.invalid";
const PASSWORD = "Owner-Password-For-The-Store-Tests-1";
const ALICE = "alice@acme.test";
const BOB = "bob@acme.test";
const CARL = "carl@acme.test";
/** Planted in every value and file a test sends: never to come out anywhere. */
const CANARY = "store-canary-5e81c2a9d0";
const CONTENT = Buffer.from(`{"private_key":"${CANARY}"}\n`).toString("base64");
/** A value pasted in a name's place: a variable name's shape, a key's start. Never quoted. */
const KEY_LIKE = "sk_live_quoted_never";
const DEPLOYMENT = "abcdefabcdefabcdefabcdef";

const toClean: string[] = [];
const spies: Mock<(...args: unknown[]) => void>[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const NONE: Scope = { slugs: [], create: false, outbound: false, domain: false, public: false, secrets: false };

/** What the fake store was handed, in order. */
type Handed = { op: "list" | "change" | "generate" | "setFile" | "removeFile"; slug: string; who: Who; creating: boolean | null; request: unknown };

type Bench = {
  root: string;
  secrets: string;
  storeRoot: string;
  state: string;
  clock: { t: number };
  handed: Handed[];
  /** As long as it is set, a write waits on it before asking `still`. */
  barrier: { promise: Promise<void> | null };
  /** What `leftovers` adds, snapshots and grants of a removed project. */
  left: { snapshots: number; grants: number; unreadable: boolean };
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  control: ReturnType<typeof createControlSteward>;
  journal: () => LogEntry[];
  owners: () => Record<string, string>;
  seed: (people: People, creators?: string[]) => void;
  ownerToken: (scope: Partial<Scope>) => Promise<{ token: TokenView; secret: string }>;
  personToken: (email: string, scope: Partial<Scope>) => Promise<{ token: TokenView; secret: string }>;
  everywhere: () => string;
};

/** A store as the secrets steward would list it to a token. */
function viewOf(slug: string, exists: boolean): StoreView {
  return {
    slug,
    exists,
    state: exists ? "managed" : "absent",
    reason: null,
    variables: [],
    missing: [],
    files: [],
    legacy: [],
    build: [],
    public: [],
    unitReadsStore: null,
    modifiedAt: null,
    restartPending: false,
    previous: false,
    may: { write: true, reveal: false, restore: false, migrate: false },
  };
}

const protectedBlock = (slug: string) => `${slug}.${ZONE} {\n\tforward_auth @portal_guard 127.0.0.1:${PORTAL_PORT} {\n\t\turi /verifier\n\t}\n}\n`;

/**
 * cms: restricted; blog: in the open; kanban: restricted, its manifest
 * listing names, the store's form; notes: a static site; the dashboard and
 * the portal.
 */
async function mount(options: { store?: boolean | "real"; secretChangesPerHour?: number } = {}): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "control-store-"));
  toClean.push(root);
  const folder = (name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    return join(root, name);
  };
  const sites = folder("sites");
  const secrets = folder("secrets");
  const units = folder("units");
  const state = folder("state");
  const caddy = folder("caddy");
  const installer = folder("installer");
  const storeRoot = join(secrets, "projects");
  writeFileSync(join(units, INSTALLER_TEMPLATE), "[Service]\n");

  const manifest = (slug: string, content: Record<string, unknown>) => {
    mkdirSync(join(sites, slug), { recursive: true });
    writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, ...content }));
  };
  const app = (slug: string, port: number, extra: Record<string, unknown> = {}) => {
    manifest(slug, { start: "/usr/local/bin/bun run server.ts", port, publicDir: "public", ...extra });
    writeFileSync(join(units, `${slug}.service`), `[Service]\nEnvironment=PORT=${port}\nExecStart=/usr/local/bin/bun run server.ts\n`);
    if (extra.portal === true) writeFileSync(join(caddy, `${slug}.caddy`), protectedBlock(slug));
  };
  app("cms", 3048, { secrets: ["cms.env"], portal: true });
  app("blog", 3049);
  app("kanban", 3050, { secrets: ["API_KEY"], portal: true });
  manifest("notes", { publicDir: "public" });
  app("dashboard", 3022, { secrets: ["dashboard.env"] });
  app("portal", 3026, { secrets: ["portal.env"] });
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "cms.env"), "A=b\n", { mode: 0o600 });

  const clock = { t: Date.now() };
  const real = createSystem({
    sitesDir: sites,
    secretsFolder: secrets,
    unitsFolder: units,
    stateFolder: state,
    hashFile: join(secrets, "dashboard.env"),
    accountsFile: join(root, "passwd"),
    caddyFolder: caddy,
    gatekeeperFolder: folder("gatekeeper"),
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
      if (arguments_[0] === "show") return { code: 0, output: "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=\n" };
      return { code: 0, output: "" };
    },
  };
  const portalKey = folder("portal-key");
  const members = { ...createMembersSystem({ stateFolder: state, sitesDir: sites, secretsFolder: secrets, portalKeyFolder: portalKey, groupsFile: join(root, "group"), portalGroup: "" }), now: () => clock.t };
  const access = { ...createAccessSystem({ stateFolder: state, portalKeyFolder: portalKey, groupsFile: join(root, "group"), portalGroup: "", portalDataFolder: join(root, "portal-data") }, false), now: () => clock.t };
  const handler = createSteward(system, { secretsFolder: secrets, checkAccounts: false, members: { system: members, access, zone: ZONE } });

  // The store's own work, as the secrets steward does it: asks `still` once
  // its turn has come, lays the store's folders on a write, answers names.
  const handed: Handed[] = [];
  const barrier: Bench["barrier"] = { promise: null };
  const deployed = (slug: string) => existsSync(join(sites, slug));
  const lay = (slug: string): boolean => {
    if (existsSync(join(storeRoot, slug))) return false;
    mkdirSync(join(storeRoot, slug, "files"), { recursive: true, mode: 0o700 });
    return true;
  };
  const changed = (slug: string, created: boolean, extra: Partial<StoreChangeResponse>): Response =>
    Response.json(
      { store: viewOf(slug, true), created, set: [], generated: [], removed: [], absent: [], files: { set: [], removed: [] }, ...extra },
      { status: created ? 201 : 200 },
    );
  const write = async (still: () => Promise<Response | null>, slug: string, creating: boolean, then: (created: boolean) => Response): Promise<Response> => {
    if (barrier.promise !== null) await barrier.promise;
    const refused = await still();
    if (refused !== null) return refused;
    if (!creating && !deployed(slug)) return Response.json({ error: "not-found", message: `no project ${slug}` }, { status: 404 });
    return then(lay(slug));
  };
  const store: StoreForToken = {
    list: async (slug, who, creating) => {
      handed.push({ op: "list", slug, who, creating, request: null });
      return Response.json({ store: viewOf(slug, existsSync(join(storeRoot, slug))) });
    },
    change: async (_req, change, who, creating, still) => {
      handed.push({ op: "change", slug: change.slug, who, creating, request: change });
      return write(still, change.slug, creating, (created) => changed(change.slug, created, { set: change.set.map(([name]) => name), removed: change.remove }));
    },
    generate: async (_req, request, who, creating, still) => {
      handed.push({ op: "generate", slug: request.slug, who, creating, request });
      return write(still, request.slug, creating, (created) => changed(request.slug, created, { generated: [request.name] }));
    },
    setFile: async (_req, request, who, creating, still) => {
      handed.push({ op: "setFile", slug: request.slug, who, creating, request });
      return write(still, request.slug, creating, (created) => changed(request.slug, created, { files: { set: [request.name], removed: [] } }));
    },
    removeFile: async (_req, request, who, still) => {
      handed.push({ op: "removeFile", slug: request.slug, who, creating: null, request });
      return write(still, request.slug, false, () => changed(request.slug, false, { files: { set: [], removed: [request.name] } }));
    },
  };

  const left = { snapshots: 0, grants: 0, unreadable: false };
  const controlReal = createControlSystem({ stateFolder: state, sitesDir: sites, unitsFolder: units, installerFolder: installer, systemctl: "/bin/false", journalctl: "/bin/false", backups: null, connectors: null, storeRoot });
  const controlSystem: ControlSystem = {
    ...controlReal,
    now: () => clock.t,
    async leftovers(slug) {
      if (left.unreadable) throw new Error("the backups' index does not read");
      const read = await controlReal.leftovers(slug);
      return { ...read, snapshots: left.snapshots, grants: left.grants };
    },
    async systemctl(arguments_) {
      if (arguments_[0] === "is-active") return { code: 3, output: "inactive\n" };
      return { code: 0, output: "" };
    },
  };
  const control = createControlSteward(controlSystem, {
    zone: ZONE,
    isUnlocked: handler.isUnlocked,
    uidRoot: null,
    members: handler.memberAuthority ?? undefined,
    access: handler.accessForToken,
    forgetAccess: handler.forgetProjectAccess,
    secrets: handler.secretsForToken,
    store: options.store === false ? null : options.store === "real" ? handler.storeForToken : store,
    ...(options.secretChangesPerHour === undefined ? {} : { secretChangesPerHour: options.secretChangesPerHour }),
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
  const seed = (people: People, creators: string[] = []) => writeRegistry(state, registryOf(people, creators));
  seed({ [ALICE]: { cms: "developer", blog: "developer", kanban: "developer" }, [BOB]: { cms: "viewer" } }, [CARL]);

  const unlocked = await call("POST", "/unlock", { password: PASSWORD });
  const unlock = ((await unlocked.json()) as { token: string }).token;
  const mint = async (holder: string, scope: Partial<Scope>) => {
    const response = await call("POST", "/tokens/create", { token: unlock, label: "agent", holder, expiresAt: null, scope: { ...NONE, ...scope } });
    expect(response.status).toBe(201);
    return (await response.json()) as { token: TokenView; secret: string };
  };
  const readOr = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

  return {
    root,
    secrets,
    storeRoot,
    state,
    clock,
    handed,
    barrier,
    left,
    call,
    control,
    journal: () => reread(readOr(join(state, "journal.jsonl"))),
    owners: () => (JSON.parse(readOr(join(state, "team.json")) || "{}") as { owners?: Record<string, string> }).owners ?? {},
    seed,
    ownerToken: (scope) => mint("owner", scope),
    personToken: (email, scope) => mint(email, scope),
    everywhere: () =>
      [...answers, readOr(join(state, "journal.jsonl")), readOr(join(state, "access-log.jsonl")), readOr(join(state, "team.json")), printed.map((args) => args.map(String).join(" ")).join("\n")].join("\n"),
  };
}

async function body(response: Response): Promise<{ status: number } & Record<string, unknown>> {
  return { status: response.status, ...((await response.json()) as Record<string, unknown>) };
}

const list = (b: Bench, bearer: string, slug: string) => b.call("POST", "/control/store/list", { bearer, slug });
const change = (b: Bench, bearer: string, slug: string, set: Record<string, string> = {}, remove: string[] = []) => b.call("PATCH", "/control/store", { bearer, slug, set, remove });
const generate = (b: Bench, bearer: string, slug: string, extra: Record<string, unknown> = {}) => b.call("POST", "/control/store/generate", { bearer, slug, name: "SESSION_KEY", ...extra });
const setFile = (b: Bench, bearer: string, slug: string, name = "gcp.json", content = CONTENT) => b.call("PUT", "/control/store/file", { bearer, slug, name, content });
const removeFile = (b: Bench, bearer: string, slug: string, name = "gcp.json") => b.call("DELETE", "/control/store/file", { bearer, slug, name });
const preflight = (b: Bench, bearer: string, slug: string) => b.call("POST", "/control/preflight", { bearer, slug });
const deploy = (b: Bench, bearer: string, slug: string, deployment = DEPLOYMENT) =>
  b.call("POST", "/control/deploy", { bearer, deployment, slug, manifest: JSON.stringify({ slug, start: "/usr/local/bin/bun run server.ts", publicDir: "public", secrets: ["API_KEY"] }) });

describe("the steward: a deployed project's store", () => {
  test("listed and written as its secrets are, the token as who, never creating: a change, a value drawn, a file set and removed, each handed over as read", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["kanban"], secrets: true });
    const who = { actor: `token:${token.id}`, member: null, token: token.id };

    expect(await body(await list(b, secret, "kanban"))).toMatchObject({ status: 200, store: { slug: "kanban" } });
    expect(await body(await change(b, secret, "kanban", { API_KEY: CANARY }, ["OLD_KEY"]))).toMatchObject({ status: 201, created: true, set: ["API_KEY"], removed: ["OLD_KEY"] });
    expect(await body(await generate(b, secret, "kanban", { format: "base64url", bytes: 48, replace: true }))).toMatchObject({ status: 200, generated: ["SESSION_KEY"] });
    expect(await body(await setFile(b, secret, "kanban"))).toMatchObject({ status: 200, files: { set: ["gcp.json"] } });
    expect(await body(await removeFile(b, secret, "kanban"))).toMatchObject({ status: 200, files: { removed: ["gcp.json"] } });

    expect(b.handed).toEqual([
      { op: "list", slug: "kanban", who, creating: false, request: null },
      { op: "change", slug: "kanban", who, creating: false, request: { slug: "kanban", set: [["API_KEY", CANARY]], remove: ["OLD_KEY"] } },
      { op: "generate", slug: "kanban", who, creating: false, request: { slug: "kanban", name: "SESSION_KEY", format: "base64url", bytes: 48, replace: true } },
      { op: "setFile", slug: "kanban", who, creating: false, request: { slug: "kanban", name: "gcp.json", content: CONTENT } },
      { op: "removeFile", slug: "kanban", who, creating: null, request: { slug: "kanban", name: "gcp.json" } },
    ]);
    // A deployed project is no creation: no name recorded.
    expect(b.owners()).toEqual({});
  });

  test("the body judged before the token: an unexpected field, a malformed name, one that starts like a key, a value refused, a format, a size, a file's name or content; none quoted, nothing handed over", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["kanban"], secrets: true });
    const refusals = [
      await b.call("PATCH", "/control/store", { bearer: secret, slug: "kanban", set: {}, remove: [], extra: CANARY }),
      await change(b, secret, "kanban", { [KEY_LIKE]: "x" }),
      await change(b, secret, "kanban", { [`with space ${CANARY}`]: "x" }),
      await change(b, secret, "kanban", { API_KEY: `line\n${CANARY}` }),
      await change(b, secret, "kanban", Object.fromEntries(Array.from({ length: MAX_SECRET_NAMES + 1 }, (_, i) => [`NAME_${i}`, "x"]))),
      await generate(b, secret, "kanban", { name: "whsec_QuotedNever" }),
      await generate(b, secret, "kanban", { name: CANARY }),
      await generate(b, secret, "kanban", { format: "base32" }),
      await generate(b, secret, "kanban", { bytes: 8 }),
      await generate(b, secret, "kanban", { bytes: 65 }),
      await generate(b, secret, "kanban", { replace: "yes" }),
      await setFile(b, secret, "kanban", `.${CANARY}`),
      await setFile(b, secret, "kanban", `a/${CANARY}`),
      await setFile(b, secret, "kanban", `a..${CANARY}`),
      await setFile(b, secret, "kanban", "gcp.json", `${CONTENT}\n`),
      await setFile(b, secret, "kanban", "gcp.json", CANARY),
      await setFile(b, secret, "kanban", "gcp.json", Buffer.alloc(64 * 1024 + 1).toString("base64")),
      await removeFile(b, secret, "kanban", `../${CANARY}`),
    ];
    for (const refused of refusals) expect(refused.status).toBe(400);
    const messages = await Promise.all(refusals.map(async (refused) => ((await refused.json()) as { message: string }).message));
    expect(messages[1]).toBe("set: entry 1 starts like a secret key, not a variable name: a value never goes in a name's place");
    expect(messages[11]).toBe(FILE_NAME_REFUSAL);
    expect(b.handed).toEqual([]);
    expect(b.everywhere()).not.toContain(CANARY);
    expect(b.everywhere()).not.toContain(KEY_LIKE);
    expect(b.everywhere()).not.toContain("whsec_QuotedNever");
  });

  test("a token without the flag: refused, journaled, nothing handed over; a project outside its reach, the platform's included, unknown and never journaled", async () => {
    const b = await mount();
    const flagless = await b.ownerToken({ slugs: ["kanban"] });
    for (const response of [await list(b, flagless.secret, "kanban"), await change(b, flagless.secret, "kanban", { API_KEY: CANARY }), await setFile(b, flagless.secret, "kanban")]) {
      expect(await body(response)).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("this token may not manage secrets") });
    }
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${flagless.token.id}`, slug: "kanban", detail: "no secrets permission" });
    const { secret } = await b.ownerToken({ slugs: ["kanban"], secrets: true });
    const journaled = b.journal().length;
    for (const slug of ["cms", "dashboard", "portal", "analytics", "landing"]) {
      for (const response of [await list(b, secret, slug), await change(b, secret, slug, { A: "b" }), await generate(b, secret, slug), await removeFile(b, secret, slug)]) {
        expect(await body(response)).toMatchObject({ status: 404, error: "not-found" });
      }
    }
    expect(b.journal()).toHaveLength(journaled);
    expect(b.handed).toEqual([]);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("a person's token answers to their role first: a Developer writes, journaled as their token's; lowered to Viewer, refused naming the role, journaled", async () => {
    const b = await mount();
    const alice = await b.personToken(ALICE, { slugs: ["kanban"], secrets: true });
    expect((await change(b, alice.secret, "kanban", { API_KEY: CANARY })).status).toBe(201);
    expect(b.handed.at(-1)).toMatchObject({ op: "change", who: { actor: `token:${alice.token.id}`, member: ALICE, token: alice.token.id }, creating: false });
    // Lowered to Viewer since: the next write is refused, and so is a listing.
    b.seed({ [ALICE]: { kanban: "viewer" } }, [CARL]);
    const handed = b.handed.length;
    expect(await body(await change(b, alice.secret, "kanban", { API_KEY: "x" }))).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("Viewer") });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${alice.token.id}`, member: ALICE, slug: "kanban" });
    expect((await list(b, alice.secret, "kanban")).status).toBe(403);
    expect(b.handed).toHaveLength(handed);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("an owner's token without public writes the store of a project restricted on the machine alone; it lists every one it reaches", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ slugs: ["kanban", "blog"], secrets: true });
    expect(await body(await change(b, secret, "blog", { API_KEY: CANARY }))).toMatchObject({ status: 403, error: "out-of-scope", message: expect.stringContaining("blog is not restricted on the machine") });
    expect((await list(b, secret, "blog")).status).toBe(200);
    expect((await change(b, secret, "kanban", { API_KEY: "x" })).status).toBe(201);
    const open = await b.ownerToken({ slugs: ["blog"], secrets: true, public: true });
    expect((await change(b, open.secret, "blog", { API_KEY: "x" })).status).toBe(201);
  });

  test("revoked while its write waited its turn: judged again then, nothing written", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["kanban"], secrets: true });
    let release: () => void = () => {};
    b.barrier.promise = new Promise<void>((resolve) => (release = resolve));
    const pending = change(b, secret, "kanban", { API_KEY: CANARY });
    await Bun.sleep(10);
    expect((await b.call("POST", "/tokens/revoke", { id: token.id })).status).toBe(200);
    release();
    b.barrier.promise = null;
    expect(await body(await pending)).toMatchObject({ status: 401, error: "unauthenticated" });
    expect(existsSync(join(b.storeRoot, "kanban"))).toBe(false);
  });

  test("each write spends the token's hour, shared with its secrets: a change its names, a value drawn and a file one each, the store made one more; past it, 429 with the wait", async () => {
    const b = await mount({ secretChangesPerHour: 6 });
    const { secret } = await b.ownerToken({ slugs: ["kanban"], secrets: true });
    // Two names, and the store made: three.
    expect((await change(b, secret, "kanban", { A: "1", B: "2" })).status).toBe(201);
    expect((await generate(b, secret, "kanban")).status).toBe(200);
    expect((await setFile(b, secret, "kanban")).status).toBe(200);
    expect((await removeFile(b, secret, "kanban")).status).toBe(200);
    const refused = await body(await generate(b, secret, "kanban"));
    expect(refused).toMatchObject({ status: 429, error: "too-many-attempts" });
    expect(refused.wait).toBeGreaterThan(0);
    b.clock.t += 3_600_000;
    expect((await generate(b, secret, "kanban")).status).toBe(200);
  });
});

describe("the steward: a store ahead of the first deployment", () => {
  test("a token that may create the slug lists and writes its store, the name recorded once as its own; its deployment then creates the project as its own, the store no leftover", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ create: true, secrets: true });
    expect(await body(await list(b, secret, "shop"))).toMatchObject({ status: 200, store: { slug: "shop", exists: false } });
    expect(b.owners()).toEqual({});
    expect((await change(b, secret, "shop", { API_KEY: CANARY })).status).toBe(201);
    expect(b.owners()).toEqual({ shop: token.id });
    expect(existsSync(join(b.storeRoot, "shop", "files"))).toBe(true);
    expect((await generate(b, secret, "shop")).status).toBe(200);
    expect((await setFile(b, secret, "shop")).status).toBe(200);
    expect(b.handed.map((handed) => [handed.op, handed.creating])).toEqual([
      ["list", true],
      ["change", true],
      ["generate", true],
      ["setFile", true],
    ]);
    expect(await body(await preflight(b, secret, "shop"))).toMatchObject({ status: 200, creating: true });
    expect(await body(await deploy(b, secret, "shop"))).toEqual({ status: 202, deployment: DEPLOYMENT, slug: "shop", creating: true });
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("another token never takes the name nor the store: unknown to one that may create, nothing handed over; a leftover to one granted the name, its deployment refused too", async () => {
    const b = await mount();
    const first = await b.ownerToken({ create: true, secrets: true });
    expect((await change(b, first.secret, "shop", { API_KEY: CANARY })).status).toBe(201);
    const handed = b.handed.length;

    const creator = await b.ownerToken({ create: true, secrets: true });
    for (const response of [await list(b, creator.secret, "shop"), await change(b, creator.secret, "shop", { API_KEY: "x" }), await setFile(b, creator.secret, "shop")]) {
      expect(await body(response)).toMatchObject({ status: 404, error: "not-found", message: "no project shop for this token" });
    }
    const granted = await b.ownerToken({ slugs: ["shop"], secrets: true });
    for (const response of [await list(b, granted.secret, "shop"), await generate(b, granted.secret, "shop"), await preflight(b, granted.secret, "shop")]) {
      expect(await body(response)).toMatchObject({ status: 403, error: "reserved", message: expect.stringContaining("the machine still keeps a secrets store of a project once named shop") });
    }
    expect(b.handed).toHaveLength(handed);
    expect(b.owners()).toEqual({ shop: first.token.id });
  });

  test("a store the owner laid ahead is no token's: a leftover to every one, written nowhere, and no token's deployment takes it", async () => {
    const b = await mount();
    mkdirSync(join(b.storeRoot, "shop", "files"), { recursive: true });
    const { secret } = await b.ownerToken({ create: true, secrets: true });
    for (const response of [await list(b, secret, "shop"), await change(b, secret, "shop", { API_KEY: CANARY }), await setFile(b, secret, "shop"), await preflight(b, secret, "shop")]) {
      expect(await body(response)).toMatchObject({ status: 403, error: "reserved", message: expect.stringContaining("remove the store with sitesolide remove --confirm shop") });
    }
    expect((await deploy(b, secret, "shop")).status).toBe(403);
    expect(b.handed).toEqual([]);
    expect(b.owners()).toEqual({});
    // A link there is no folder to trust either.
    rmSync(join(b.storeRoot, "shop"), { recursive: true });
    Bun.spawnSync(["ln", "-s", b.root, join(b.storeRoot, "shop")]);
    expect(await body(await change(b, secret, "shop", { API_KEY: "x" }))).toMatchObject({ status: 403, error: "reserved" });
  });

  test("a token that may not create, and a person without the right: unknown, nothing recorded; a person with it writes, recorded, and is made Admin of nothing by a store alone", async () => {
    const b = await mount();
    const plain = await b.ownerToken({ slugs: ["kanban"], secrets: true });
    expect(await body(await change(b, plain.secret, "shop", { API_KEY: "x" }))).toMatchObject({ status: 404, error: "not-found" });
    const alice = await b.personToken(ALICE, { slugs: ["kanban"], secrets: true });
    // Alice may not create projects: a name the machine does not carry is no project of hers.
    expect(await body(await change(b, alice.secret, "shop", { API_KEY: "x" }))).toMatchObject({ status: 404, error: "not-found" });
    // Given the right, then taken back: her token's create flag narrowed to nothing again.
    b.seed({ [ALICE]: { kanban: "developer" } }, [ALICE, CARL]);
    const creating = await b.personToken(ALICE, { slugs: ["kanban"], create: true, secrets: true });
    b.seed({ [ALICE]: { kanban: "developer" } }, [CARL]);
    expect(await body(await change(b, creating.secret, "shop", { API_KEY: "x" }))).toMatchObject({ status: 404, error: "not-found" });
    expect(b.owners()).toEqual({});
    const carl = await b.personToken(CARL, { create: true, secrets: true });
    expect((await change(b, carl.secret, "shop", { API_KEY: CANARY })).status).toBe(201);
    expect(b.owners()).toEqual({ shop: carl.token.id });
    expect(b.handed.at(-1)).toMatchObject({ op: "change", creating: true, who: { member: CARL } });
    expect(readRegistryFile(b.state).projects.shop ?? []).toEqual([]);
    // Without the flag, a creator writes no store either.
    const flagless = await b.personToken(CARL, { create: true });
    expect(await body(await change(b, flagless.secret, "other", { API_KEY: "x" }))).toMatchObject({ status: 403, error: "out-of-scope" });
  });

  test("a file removed records nothing: removing lays no store", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ create: true, secrets: true });
    expect((await removeFile(b, secret, "shop")).status).toBe(404);
    expect(b.owners()).toEqual({});
    expect(existsSync(join(b.storeRoot, "shop"))).toBe(false);
  });

  test("what a removed project left under the name refuses its store, and what cannot be read refuses it too", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ create: true, secrets: true });
    b.left.snapshots = 2;
    expect(await body(await change(b, secret, "shop", { API_KEY: "x" }))).toMatchObject({ status: 403, error: "reserved", message: expect.stringContaining("2 backup snapshots") });
    b.left.snapshots = 0;
    b.left.unreadable = true;
    expect(await body(await list(b, secret, "shop"))).toMatchObject({ status: 500, error: "failure" });
    expect(b.handed).toEqual([]);
    expect(b.owners()).toEqual({});
  });

  test("a token holding as many names the machine does not carry as it may writes no store under a new one", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ create: true, secrets: true });
    const team = JSON.parse(readFileSync(join(b.state, "team.json"), "utf8")) as { owners: Record<string, string> };
    for (let index = 0; index < MAX_UNCARRIED_NAMES; index++) team.owners[`held-${index}`] = token.id;
    writeFileSync(join(b.state, "team.json"), JSON.stringify(team));
    expect(await body(await change(b, secret, "shop", { API_KEY: "x" }))).toMatchObject({ status: 429, error: "too-many-attempts", message: expect.stringContaining("stores written ahead") });
    expect(existsSync(join(b.storeRoot, "shop"))).toBe(false);
    // One it holds already is written as before.
    expect((await change(b, secret, "held-0", { API_KEY: "x" })).status).toBe(201);
  });

  test("a creation of a person's undone keeps its name while its store is there: the store stays its writer's to deploy", async () => {
    const b = await mount();
    const carl = await b.personToken(CARL, { create: true, secrets: true });
    expect((await change(b, carl.secret, "shop", { API_KEY: CANARY })).status).toBe(201);
    expect((await deploy(b, carl.secret, "shop")).status).toBe(202);
    // Its installer failed before laying anything: the creation is undone.
    const at = b.clock.t;
    writeFileSync(
      join(b.root, "installer", `${DEPLOYMENT}.json`),
      JSON.stringify({ deployment: DEPLOYMENT, slug: "shop", state: "failed", startedAt: at, updatedAt: at, finishedAt: at, log: [], error: { code: "install-failed", message: "x" }, url: null, allocated: [], missingSecrets: null }),
      { mode: 0o600 },
    );
    await b.control.settleCreations();
    expect(b.owners()).toEqual({ shop: carl.token.id });
    expect(await body(await preflight(b, carl.secret, "shop"))).toMatchObject({ status: 200, creating: true });
    // Without a store, the name goes back, as before.
    const other = await b.personToken(CARL, { create: true, secrets: true });
    expect((await deploy(b, other.secret, "plain", "bcdefabcdefabcdefabcdefa")).status).toBe(202);
    writeFileSync(
      join(b.root, "installer", "bcdefabcdefabcdefabcdefa.json"),
      JSON.stringify({ deployment: "bcdefabcdefabcdefabcdefa", slug: "plain", state: "failed", startedAt: at, updatedAt: at, finishedAt: at, log: [], error: { code: "x", message: "x" }, url: null, allocated: [], missingSecrets: null }),
      { mode: 0o600 },
    );
    await b.control.settleCreations();
    expect(b.owners()).toEqual({ shop: carl.token.id });
  });
});

describe("the steward: around the store", () => {
  test("a steward built without the store's work: no store route, as one from before", async () => {
    const b = await mount({ store: false });
    const { secret } = await b.ownerToken({ slugs: ["kanban"], secrets: true });
    expect(await body(await list(b, secret, "kanban"))).toEqual({ status: 404, error: "not-found", message: "no such route" });
    expect(await body(await change(b, secret, "kanban"))).toEqual({ status: 404, error: "not-found", message: "no such route" });
  });

  test("the old token route on a project whose manifest lists names: told to update, journaled, nothing written; a project still in the old form keeps it", async () => {
    const b = await mount();
    const { token, secret } = await b.ownerToken({ slugs: ["kanban", "cms"], secrets: true });
    const refused = await b.call("PATCH", "/control/secrets", { bearer: secret, slug: "kanban", file: "kanban.env", set: { API_KEY: CANARY }, remove: [] });
    expect(await body(refused)).toEqual({ status: 403, error: "out-of-scope", message: STORE_FORM });
    expect(b.journal().at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: `token:${token.id}`, slug: "kanban", detail: "kept in its store" });
    expect(existsSync(join(b.secrets, "kanban.env"))).toBe(false);
    const kept = await b.call("PATCH", "/control/secrets", { bearer: secret, slug: "cms", file: "cms.env", set: { API_KEY: "x" }, remove: [] });
    expect(kept.status).toBe(200);
    expect(b.everywhere()).not.toContain(CANARY);
  });

  test("the preflight names what {zone} and {contact} become, from the steward's own settings", async () => {
    const b = await mount();
    const { secret } = await b.ownerToken({ create: true });
    expect(await body(await preflight(b, secret, "shop"))).toEqual({ status: 200, creating: true, placeholders: { zone: ZONE, contact: "" } });
  });
});

describe("end to end, with the secrets steward's real store", () => {
  /** The API on a real port, the steward on a real socket, as dashboard/server.ts and dashboard/steward.ts mount them. */
  async function chain(b: Bench) {
    const socket = join(b.root, "steward.sock");
    const steward = Bun.serve({ unix: socket, fetch: (req) => b.control(req) });
    const store = createControlStore(openDatabase(join(b.root, "dashboard.db")));
    const client = localControlSteward(socket);
    const spool = createSpool(join(b.root, "spool"));
    const api = createApiRoutes({ steward: client, store, spool, limiter: createLimiter(), tracker: createTracker({ store, steward: client, spool }), stateFile: join(b.root, "state.json"), publicUrl: `https://dashboard.${ZONE}`, zone: ZONE });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: storeRoutes(api), fetch: () => new Response("not found", { status: 404 }) });
    const texts: string[] = [];
    const send = async (bearer: string, method: string, path: string, payload?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/projects${path}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, "X-Forwarded-For": "198.51.100.9", "Content-Type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await response.text();
      texts.push(text);
      return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
    };
    return { send, texts, stop: () => (server.stop(true), steward.stop(true)) };
  }

  test("a token's names, a value drawn and a file reach the project's store, and come back to no one: listed as names, its view a Developer's", async () => {
    const b = await mount({ store: "real" });
    const c = await chain(b);
    try {
      const { token, secret } = await b.ownerToken({ slugs: ["kanban"], secrets: true });
      expect(await c.send(secret, "PATCH", "/kanban/store", { set: { API_KEY: CANARY } })).toMatchObject({ status: 201, json: { created: true, set: ["API_KEY"] } });
      expect(readFileSync(join(b.storeRoot, "kanban", "env"), "utf8")).toContain(`API_KEY=${CANARY}`);
      const drawn = await c.send(secret, "POST", "/kanban/store/generate", { name: "SESSION_KEY", bytes: 32 });
      expect(drawn).toMatchObject({ status: 200, json: { generated: ["SESSION_KEY"] } });
      const value = /^SESSION_KEY=([0-9a-f]{64})$/m.exec(readFileSync(join(b.storeRoot, "kanban", "env"), "utf8"))?.[1];
      expect(value).toBeDefined();
      expect(await c.send(secret, "PUT", "/kanban/store/files/gcp.json", { content: CONTENT })).toMatchObject({ status: 200, json: { files: { set: ["gcp.json"] } } });
      expect(readFileSync(join(b.storeRoot, "kanban", "files", "gcp.json"), "utf8")).toContain(CANARY);

      const listed = await c.send(secret, "GET", "/kanban/store");
      expect(listed.status).toBe(200);
      const view = listed.json.store as StoreView;
      expect(view.variables.find((variable) => variable.name === "API_KEY")).toMatchObject({ source: "store", declared: true });
      expect(view.variables.find((variable) => variable.name === "SESSION_KEY")).toMatchObject({ source: "store", declared: false });
      expect(view.missing).toEqual([]);
      expect(view.files).toEqual([expect.objectContaining({ name: "gcp.json", state: "set", bytes: null })]);
      expect(view.may).toEqual({ write: true, reveal: false, restore: false, migrate: false });

      // Journaled under the token, names alone.
      expect(b.journal().filter((entry) => entry.actor === `token:${token.id}` && entry.result === "ok").length).toBeGreaterThan(0);
      for (const text of [...c.texts, b.everywhere()]) {
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain(value!);
      }
      // A file removed, that file alone: the folder every unit loads stays.
      expect(await c.send(secret, "DELETE", "/kanban/store/files/gcp.json")).toMatchObject({ status: 200, json: { files: { removed: ["gcp.json"] } } });
      expect(readdirSync(join(b.storeRoot, "kanban", "files"))).toEqual([]);
    } finally {
      c.stop();
    }
  });

  test("the rules hold against the real store: a token without the flag, another's project, a person below Developer; nothing written", async () => {
    const b = await mount({ store: "real" });
    const c = await chain(b);
    try {
      const flagless = await b.ownerToken({ slugs: ["kanban"] });
      expect(await c.send(flagless.secret, "PATCH", "/kanban/store", { set: { API_KEY: CANARY } })).toMatchObject({ status: 403, json: { error: "out-of-scope" } });
      const elsewhere = await b.ownerToken({ slugs: ["blog"], secrets: true });
      expect(await c.send(elsewhere.secret, "GET", "/kanban/store")).toMatchObject({ status: 404 });
      const alice = await b.personToken(ALICE, { slugs: ["kanban"], secrets: true });
      b.seed({ [ALICE]: { kanban: "viewer" } }, [CARL]);
      expect(await c.send(alice.secret, "POST", "/kanban/store/generate", { name: "SESSION_KEY" })).toMatchObject({ status: 403, json: { error: "out-of-scope" } });
      expect(existsSync(join(b.storeRoot, "kanban", "env"))).toBe(false);
      for (const text of [...c.texts, b.everywhere()]) expect(text).not.toContain(CANARY);
    } finally {
      c.stop();
    }
  });

  test("a store written ahead of the first deployment is the writing token's alone: recorded, then its deployment its own; another token neither sees nor takes it", async () => {
    const b = await mount({ store: "real" });
    const c = await chain(b);
    try {
      const { token, secret } = await b.ownerToken({ create: true, secrets: true });
      expect(await c.send(secret, "PATCH", "/shop/store", { set: { API_KEY: CANARY } })).toMatchObject({ status: 201, json: { created: true } });
      expect(readFileSync(join(b.storeRoot, "shop", "env"), "utf8")).toContain(`API_KEY=${CANARY}`);
      expect(b.owners()).toEqual({ shop: token.id });
      expect(await c.send(secret, "GET", "/shop/store")).toMatchObject({ status: 200, json: { store: { slug: "shop", exists: true } } });
      expect(await body(await deploy(b, secret, "shop"))).toMatchObject({ status: 202, creating: true });

      const other = await b.ownerToken({ create: true, secrets: true });
      expect(await c.send(other.secret, "GET", "/shop/store")).toMatchObject({ status: 404 });
      expect(await c.send(other.secret, "PATCH", "/shop/store", { set: { API_KEY: "taken" } })).toMatchObject({ status: 404 });
      expect(readFileSync(join(b.storeRoot, "shop", "env"), "utf8")).toContain(`API_KEY=${CANARY}`);
      for (const text of [...c.texts, b.everywhere()]) expect(text).not.toContain(CANARY);
    } finally {
      c.stop();
    }
  });
});

// --- the dashboard's control API ---------------------------------------------------------

const tokenOf = (letter: string) => `sst_${letter.repeat(43)}`;
const GRACE = tokenOf("g");
const IDENTITY: Identity = { id: "bbbbbbbbbbbb", label: "Grace", email: "owner", expiresAt: null, scope: { slugs: ["kanban"], create: false, outbound: false, domain: false, public: false, secrets: true }, owned: [], member: null };

type Refusal = { status: number; error: string; message: string; wait?: number };

const sim = {
  outdated: false,
  refusal: null as Refusal | null,
  restartRefusal: null as Refusal | null,
  created: false,
  /** Strings the steward copies into its answer by mistake. */
  echo: null as string | null,
  /** A store whose variables lack their fields. */
  broken: false,
  asked: [] as { route: string; requested: unknown }[],
};

/** What the simulated steward wrongly puts in its answers: never relayed. */
const LEAK = "steward-leak-1b2c3d4e5f";

/** A store as the steward might answer it, with what a token must never see in it. */
const STEWARD_STORE = {
  slug: "kanban",
  exists: true,
  state: "managed",
  reason: null,
  variables: [{ name: "API_KEY", source: "store", file: null, shadows: ["kanban.env"], declared: true, value: LEAK }],
  missing: ["STRIPE_KEY"],
  files: [{ name: "gcp.json", state: "set", declared: true, reason: null, bytes: 120, modifiedAt: 1_760_000_000_000, restartPending: true }],
  legacy: [{ name: "kanban.env", state: "managed", reason: null, variables: ["API_KEY"], read: true, leftover: false, covered: true }],
  build: ["CMS_TOKEN"],
  public: [{ name: "PUBLIC_URL", value: `https://kanban.${ZONE}` }],
  unitReadsStore: true,
  modifiedAt: 1_760_000_000_000,
  restartPending: true,
  previous: true,
  may: { write: true, reveal: true, restore: true, migrate: true },
  extra: LEAK,
};

/** The same store as a token reads it from the API: a Developer's view. */
const TOKEN_STORE: StoreView = {
  slug: "kanban",
  exists: true,
  state: "managed",
  reason: null,
  variables: [{ name: "API_KEY", source: "store", file: null, shadows: ["kanban.env"], declared: true }],
  missing: ["STRIPE_KEY"],
  files: [{ name: "gcp.json", state: "set", declared: true, reason: null, bytes: null, modifiedAt: 1_760_000_000_000, restartPending: true }],
  legacy: [{ name: "kanban.env", state: "managed", reason: null, variables: ["API_KEY"], read: true, leftover: false, covered: null }],
  build: ["CMS_TOKEN"],
  public: [{ name: "PUBLIC_URL", value: `https://kanban.${ZONE}` }],
  unitReadsStore: true,
  modifiedAt: 1_760_000_000_000,
  restartPending: true,
  previous: false,
  may: { write: true, reveal: false, restore: false, migrate: false },
};

let apiRoot: string;
let dashboard: ReturnType<typeof Bun.serve>;
let base: string;
let delays: number[] = [];

beforeAll(() => {
  apiRoot = mkdtempSync(join(tmpdir(), "control-store-api-"));
  writeFileSync(join(apiRoot, "state.json"), "{}");
  const refusal = (one: Refusal) => Response.json({ error: one.error, message: one.message, ...(one.wait === undefined ? {} : { wait: one.wait }) }, { status: one.status });
  const answer = (route: string, requested: unknown, made: (requested: Record<string, unknown>) => Record<string, unknown>) => {
    sim.asked.push({ route, requested });
    if (sim.outdated) return Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
    if (sim.refusal !== null) return refusal(sim.refusal);
    const changed = { store: sim.broken ? { ...STEWARD_STORE, variables: [{ name: "API_KEY" }] } : STEWARD_STORE, created: sim.created, set: [], generated: [], removed: [], absent: [], files: { set: [], removed: [] }, ...made(requested as Record<string, unknown>) };
    return Response.json(sim.echo === null ? changed : { ...changed, reason: sim.echo }, { status: sim.created ? 201 : 200 });
  };
  const steward = {
    authenticate: async (bearer: string) =>
      bearer === GRACE ? Response.json({ identity: IDENTITY }) : Response.json({ error: "unauthenticated", message: "missing or unknown token" }, { status: 401 }),
    storeList: async (bearer: string, slug: string) => {
      sim.asked.push({ route: "list", requested: { bearer, slug } });
      if (sim.outdated) return Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
      if (sim.refusal !== null) return refusal(sim.refusal);
      return Response.json({ store: sim.broken ? { ...STEWARD_STORE, variables: [{ name: "API_KEY" }] } : STEWARD_STORE, extra: LEAK });
    },
    storeChange: async (requested: unknown) => answer("change", requested, (r) => ({ set: Object.keys(r.set as object), removed: r.remove })),
    storeGenerate: async (requested: unknown) => answer("generate", requested, (r) => ({ generated: [r.name], value: "drawn-value-never-relayed" })),
    storeSetFile: async (requested: unknown) => answer("setFile", requested, (r) => ({ files: { set: [r.name], removed: [] } })),
    storeRemoveFile: async (requested: unknown) => answer("removeFile", requested, (r) => ({ files: { set: [], removed: [r.name] } })),
    restart: async (bearer: string, slug: string) => {
      sim.asked.push({ route: "restart", requested: { bearer, slug } });
      if (sim.restartRefusal !== null) return refusal(sim.restartRefusal);
      return Response.json({ verdict: { kind: "active", state: "active", subState: "running", restarts: 0 } });
    },
  } as unknown as ControlSteward;
  const store = createControlStore(openDatabase(join(apiRoot, "dashboard.db")));
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
  // The routes as dashboard/server.ts mounts them, their idle delays recorded.
  const routes = storeRoutes(api);
  const timed = Object.fromEntries(
    Object.entries(routes).map(([path, verbs]) => [
      path,
      Object.fromEntries(
        Object.entries(verbs).map(([verb, handler]) => [
          verb,
          (req: Request, server: { timeout: (req: Request, seconds: number) => void }) =>
            (handler as (req: Request, server: unknown) => Promise<Response>)(req, {
              timeout: (r: Request, seconds: number) => {
                delays.push(seconds);
                server.timeout(r, seconds);
              },
            }),
        ]),
      ),
    ]),
  );
  dashboard = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: timed as never, fetch: () => new Response("not found", { status: 404 }) });
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
  sim.echo = null;
  sim.broken = false;
  sim.asked.length = 0;
  delays = [];
});

let address = 1;
function headers(token = GRACE): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-Forwarded-For": `198.51.100.${address++ % 250}`, "Content-Type": "application/json" };
}
const send = (method: string, path: string, payload?: unknown, token = GRACE) =>
  fetch(`${base}/api/v1/projects/kanban/store${path}`, { method, headers: headers(token), ...(payload === undefined ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }) });

async function read(response: Response): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const text = await response.text();
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(LEAK);
  expect(text).not.toContain(GRACE);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

describe("the API: a project's store", () => {
  test("GET passes the bearer and the slug, and sends back a Developer's view from the known fields: no size, no cover, no previous version, never reveal, restore nor migrate", async () => {
    const answer = await read(await send("GET", ""));
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ store: TOKEN_STORE });
    expect(sim.asked).toEqual([{ route: "list", requested: { bearer: GRACE, slug: "kanban" } }]);
  });

  test("a store that does not read is no answer: 502", async () => {
    sim.broken = true;
    expect((await read(await send("GET", ""))).status).toBe(502);
    expect((await read(await send("PATCH", "", { set: { A: "b" } }))).status).toBe(502);
  });

  test("a steward from before: not-available, saying to run sitesolide upgrade; its refusals in the API's codes", async () => {
    sim.outdated = true;
    expect((await read(await send("GET", ""))).json).toMatchObject({ error: "not-available", message: expect.stringContaining("sitesolide upgrade") });
    expect((await read(await send("PATCH", "", { set: { A: "b" } }))).status).toBe(503);
    sim.outdated = false;
    sim.refusal = { status: 409, error: "already-present", message: "SESSION_KEY is already set; --replace draws a new value in the store, which overrides it" };
    expect(await read(await send("POST", "/generate", { name: "SESSION_KEY" }))).toMatchObject({ status: 409, json: { error: "already-present" } });
    sim.refusal = { status: 503, error: "failure", message: "the server is busy" };
    expect((await read(await send("PATCH", "", { set: { A: "b" } }))).json).toMatchObject({ error: "busy" });
    sim.refusal = { status: 409, error: "unmanaged", message: "the store's env is not managed here" };
    expect((await read(await send("DELETE", "/files/gcp.json"))).status).toBe(409);
  });
});

describe("the API: changing a store", () => {
  test("names and values passed on, 201 when the store was made; the answer from the known fields, a value never in it", async () => {
    sim.created = true;
    const answer = await read(await send("PATCH", "", { set: { API_KEY: CANARY, __proto__: "proto-value" }, remove: ["OLD"] }));
    expect(answer.status).toBe(201);
    expect(answer.json).toEqual({ store: TOKEN_STORE, created: true, set: ["API_KEY"], generated: [], removed: ["OLD"], absent: [], files: { set: [], removed: [] }, restart: null });
    expect(sim.asked).toEqual([{ route: "change", requested: { bearer: GRACE, slug: "kanban", set: { API_KEY: CANARY }, remove: ["OLD"] } }]);
    sim.created = false;
    expect((await read(await send("PATCH", "", {}))).status).toBe(200);
  });

  test("the body judged before the steward is asked, a name that starts like a key never quoted; over 512 KiB, too-large", async () => {
    for (const [payload, message] of [
      [{ set: {}, extra: CANARY }, "unexpected field: send set, remove and restart alone"],
      [{ set: [] }, "set: an object of variable names and their values"],
      [{ remove: "A" }, "remove: a list of variable names"],
      [{ set: { [KEY_LIKE]: "x" } }, "set: entry 1 starts like a secret key, not a variable name: a value never goes in a name's place"],
      [{ remove: [KEY_LIKE, KEY_LIKE] }, "remove: entry 2 is named twice"],
      [{ set: { [`${CANARY} x`]: "x" } }, expect.stringContaining("set: entry 1 is not a variable name")],
      [{ set: { A: `x\n${CANARY}` } }, "set: A: the value must fit on one line"],
      [{ set: { A: "x" }, remove: ["A"] }, "A is both set and removed: name it in one list"],
      [{ set: { A: "x" }, restart: "yes" }, "restart must be true or false"],
      ["not json", expect.stringContaining("send a JSON object")],
    ] as const) {
      expect(await read(await send("PATCH", "", payload))).toMatchObject({ status: 400, json: { error: "invalid", message } });
    }
    const huge = await read(await send("PATCH", "", { set: { A: "x".repeat(MAX_SECRETS_BODY_BYTES) } }));
    expect(huge).toMatchObject({ status: 413, json: { error: "too-large" } });
    expect(sim.asked).toEqual([]);
  });

  test("with restart: the write, then the restart, both in the answer; a refused restart keeps the write's status", async () => {
    sim.created = true;
    const restarted = await read(await send("PATCH", "", { set: { A: "x" }, restart: true }));
    expect(restarted).toMatchObject({ status: 201, json: { restart: { verdict: { kind: "active" } } } });
    expect(sim.asked.map((asked) => asked.route)).toEqual(["change", "restart"]);
    sim.restartRefusal = { status: 429, error: "too-many-attempts", message: "30 restarts per hour at most for a token: try again in 60 s", wait: 60 };
    const refused = await read(await send("POST", "/generate", { name: "SESSION_KEY", restart: true }));
    expect(refused).toMatchObject({ status: 201, json: { generated: ["SESSION_KEY"], restart: { error: "too-many-attempts", wait: 60 } } });
    // Every write waits a change's delay, which the restart's follows.
    expect(delays).toEqual([SECRETS_CHANGE_IDLE_S, SECRETS_CHANGE_IDLE_S]);
  });

  test("a value the steward copies back never comes out: not in an answer, not in a refusal's message, nor on the console", async () => {
    const printed: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")));
    try {
      // In an answer, or a refusal: the answer does not read.
      sim.echo = `the value ${CANARY}`;
      expect((await read(await send("PATCH", "", { set: { API_KEY: CANARY } }))).status).toBe(502);
      sim.echo = null;
      sim.refusal = { status: 400, error: "invalid", message: `API_KEY: refused ${CANARY}` };
      expect(await read(await send("PATCH", "", { set: { API_KEY: CANARY } }))).toMatchObject({ status: 502, json: { error: "failure" } });
      // A value too short to be looked for in a whole answer: the message alone is withheld, the code stays.
      sim.refusal = { status: 400, error: "invalid", message: "API_KEY: refused s3cr3t-v" };
      const short = await read(await send("PATCH", "", { set: { API_KEY: "s3cr3t-v" } }));
      expect(short).toMatchObject({ status: 400, json: { error: "invalid", message: expect.stringContaining("withheld") } });
      expect(short.text).not.toContain("s3cr3t-v");
      // A file's content, as its base64 or a line of it decoded, the same.
      sim.refusal = { status: 400, error: "invalid", message: `gcp.json holds {"private_key":"${CANARY}"}` };
      expect((await read(await send("PUT", "/files/gcp.json", { content: CONTENT }))).status).toBe(502);
      sim.refusal = { status: 400, error: "invalid", message: `refused ${CONTENT}` };
      expect((await read(await send("PUT", "/files/gcp.json", { content: CONTENT }))).status).toBe(502);
    } finally {
      spy.mockRestore();
    }
    expect(printed.join("\n")).not.toContain(CANARY);
  });
});

describe("the API: a value drawn, a file", () => {
  test("generate: name, format, size and replace passed on; the value never sent back, even one the steward would send", async () => {
    const answer = await read(await send("POST", "/generate", { name: "SESSION_KEY", format: "hex", bytes: 64, replace: false }));
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ generated: ["SESSION_KEY"], restart: null });
    expect(answer.text).not.toContain("drawn-value-never-relayed");
    expect(sim.asked).toEqual([{ route: "generate", requested: { bearer: GRACE, slug: "kanban", name: "SESSION_KEY", format: "hex", bytes: 64, replace: false } }]);
  });

  test("generate's body judged first: a name that is none or starts like a key, a format, a size out of bounds, an unexpected field", async () => {
    for (const payload of [{}, { name: "ghp_QuotedNever" }, { name: "A B" }, { name: "A", format: "base32" }, { name: "A", bytes: 15 }, { name: "A", bytes: 64.5 }, { name: "A", replace: 1 }, { name: "A", value: CANARY }]) {
      expect((await read(await send("POST", "/generate", payload))).status).toBe(400);
    }
    expect(sim.asked).toEqual([]);
  });

  test("a file: its name from the address, its content in base64, passed on; the name and the content judged first and never quoted", async () => {
    const answer = await read(await send("PUT", "/files/gcp.json", { content: CONTENT }));
    expect(answer).toMatchObject({ status: 200, json: { files: { set: ["gcp.json"], removed: [] } } });
    expect(sim.asked).toEqual([{ route: "setFile", requested: { bearer: GRACE, slug: "kanban", name: "gcp.json", content: CONTENT } }]);
    sim.asked.length = 0;
    for (const [name, payload] of [
      [".env", { content: CONTENT }],
      [`..${CANARY}`, { content: CONTENT }],
      [`a%2F${CANARY}`, { content: CONTENT }],
      ["gcp.json", { content: `${CONTENT}\n` }],
      ["gcp.json", { content: `not base64 ${CANARY}` }],
      ["gcp.json", { content: Buffer.alloc(64 * 1024 + 1).toString("base64") }],
      ["gcp.json", { content: CONTENT, mode: "0600" }],
      ["gcp.json", {}],
    ] as const) {
      expect((await read(await send("PUT", `/files/${name}`, payload))).status).toBe(400);
    }
    expect(sim.asked).toEqual([]);
  });

  test("a file removed: no body, or restart alone", async () => {
    expect((await read(await send("DELETE", "/files/gcp.json"))).json).toMatchObject({ files: { removed: ["gcp.json"] }, restart: null });
    expect((await read(await send("DELETE", "/files/gcp.json", { restart: true }))).json).toMatchObject({ restart: { verdict: { kind: "active" } } });
    expect((await read(await send("DELETE", "/files/gcp.json", { restart: true, content: CANARY }))).status).toBe(400);
    expect((await read(await send("DELETE", `/files/.${CANARY}`))).status).toBe(400);
    expect(sim.asked.map((asked) => asked.route)).toEqual(["removeFile", "removeFile", "restart"]);
  });

  test("a wrong token is refused before anything is asked of the store", async () => {
    expect((await read(await send("GET", "", undefined, tokenOf("x")))).status).toBe(401);
    expect(sim.asked).toEqual([]);
  });
});
