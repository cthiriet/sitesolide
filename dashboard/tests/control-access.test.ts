import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjection } from "../borrowed/access";
import type { AccessResponse, EntryResponse, SignInSettings } from "../src/access/protocol";
import { rightsOf } from "../src/access/registry";
import { createAccessRoutes, createAccessStore, type AccessEvent } from "../src/access/steward";
import { createAccessSystem } from "../src/access/system";
import { openDatabase } from "../src/database";
import { createApiRoutes } from "../src/control/api";
import type { ControlSteward } from "../src/control/client";
import { createLimiter } from "../src/control/limiter";
import { INSTALLER_TEMPLATE, type Identity, type ProjectAccess, type TokenView } from "../src/control/protocol";
import { createSpool } from "../src/control/spool";
import { createControlSteward, type ControlHandler, type MemberAuthority } from "../src/control/steward";
import { createControlStore } from "../src/control/store";
import { createControlSystem, type ControlSystem } from "../src/control/system";
import { createTracker } from "../src/control/tracker";
import { readRegistryFile, registryOf, writeRegistry, type People } from "./registry-fixtures";

/**
 * A project's access changed with a token, both halves.
 *
 * The steward's control routes, `/control/access/list` and `/control/access`,
 * with the real access store and rules on a throwaway registry, the real
 * token registry, `systemctl` simulated: the token judged first, the project
 * among those it reaches, then the access rules, which let a token give Can
 * open alone, to someone inside the company's domains or to one of those
 * domains, never a password, and remove Can open entries alone. The journal
 * names the token.
 *
 * Then the dashboard's control API, `/api/v1/projects/:slug/access`, on a
 * real port, the steward reduced to the answers it gives: what the dashboard
 * checks itself, the bearer and the project, the body's fields, and what it
 * passes on or keeps back.
 */

const ZONE = "test-zone.invalid";
const ADA = "ada@acme.test";
const CAROL = "carol@acme.test";
const DAN = "dan@acme.test";

// --- the steward's routes -------------------------------------------------------------

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const SCOPE = { slugs: [] as string[], create: false, outbound: false, domain: false, public: false };

type Bench = {
  root: string;
  handler: ControlHandler;
  signIn: SignInSettings;
  /** What the access store journaled, refusals included. */
  journal: AccessEvent[];
  /** The registry laid as the owner would have left it. */
  seed: (people: People, creators?: string[]) => void;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
};

/** kanban, roster and notes are deployed; ghost is not. Ada: Admin of kanban, Developer on roster. */
function bench(options: { access?: boolean; full?: () => boolean; changesPerHour?: number } = {}): Bench {
  const root = mkdtempSync(join(tmpdir(), "control-access-"));
  toClean.push(root);
  for (const folder of ["state", "sites", "units", "installer", "portal-key"]) mkdirSync(join(root, folder));
  writeFileSync(join(root, "units", INSTALLER_TEMPLATE), "[Service]\n");
  for (const slug of ["kanban", "roster", "notes"]) mkdirSync(join(root, "sites", slug));
  const state = join(root, "state");
  const seed = (people: People, creators: string[] = []) => writeRegistry(state, registryOf(people, creators));
  seed({ [ADA]: { kanban: "admin", roster: "developer" } });

  const signIn: SignInSettings = { configured: true, allowedDomains: ["acme.test", "acme-labs.test"], admins: ["ceo@acme.test"], providerName: "Acme" };
  const journal: AccessEvent[] = [];
  const hostOf = (slug: string) => `${slug}.${ZONE}`;
  const store = createAccessStore({
    system: createAccessSystem({ stateFolder: state, portalKeyFolder: join(root, "portal-key"), groupsFile: join(root, "group"), portalGroup: "", portalDataFolder: join(root, "portal-data") }, false),
    zone: ZONE,
    hostOf,
    journal: async (event) => void journal.push(event),
    ...(options.full === undefined ? {} : { logFull: async () => options.full!() }),
  });
  const refuse = (error: string, message: string, status: number) => Response.json({ error, message }, { status });
  const routes = createAccessRoutes({
    store,
    zone: ZONE,
    hostOf,
    projectExists: (slug) => existsSync(join(root, "sites", slug)),
    signIn: async () => signIn,
    general: async (slug) => (existsSync(join(root, "sites", slug)) ? { access: "restricted", modifiable: true, reason: null } : null),
    portalReading: async () => ({ reading: "steward", writtenAt: null }),
    isUnlocked: async () => false,
    readBody: async () => refuse("invalid", "the tokens' routes read no body here", 400),
    journal: async (event) => void journal.push(event),
    journalRefusal: async (event) => void journal.push(event),
    authorize: async () => refuse("signed-out", "no session in these tests", 401),
    leave: async () => [],
    ...(options.changesPerHour === undefined ? {} : { changesPerHour: options.changesPerHour }),
  });

  // Ada's session and unlock, for minting her own token; her rights read from the registry.
  const members: MemberAuthority = {
    async authorize(session, unlock) {
      if (session !== "ada-session") return refuse("signed-out", "this session is closed: sign in again", 401);
      const registry = await store.read();
      if (registry instanceof Response) return registry;
      const rights = rightsOf(registry, ADA);
      if (rights === null) return refuse("signed-out", "this session is closed: sign in again", 401);
      if (unlock !== null && unlock !== "ada-unlock") return refuse("locked", "locked", 401);
      return { email: ADA, roles: rights.roles, create: rights.create, session: "hash-of-ada-session" };
    },
    unlockedUntil: async () => null,
    rights: async (email) => {
      const registry = await store.read();
      return registry instanceof Response ? registry : rightsOf(registry, email);
    },
    rightless: async (emails) => {
      const registry = await store.read();
      return registry instanceof Response ? registry : emails.filter((email) => rightsOf(registry, email) === null);
    },
    recordCreation: async () => null,
    journal: async () => {},
    journalRefusal: async () => {},
  };

  const real = createControlSystem({
    stateFolder: state,
    sitesDir: join(root, "sites"),
    unitsFolder: join(root, "units"),
    installerFolder: join(root, "installer"),
    systemctl: "/bin/false",
    journalctl: "/bin/false",
  });
  const system: ControlSystem = { ...real, systemctl: async () => ({ code: 0, output: "" }), journal: async () => ({ code: 0, output: "" }) };
  const handler = createControlSteward(system, {
    zone: ZONE,
    isUnlocked: async (token) => token === "owner-unlock",
    uidRoot: null,
    members,
    ...(options.access === false ? {} : { access: routes.forToken }),
  });
  const call = (method: string, path: string, body?: unknown) =>
    handler(new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }));
  return { root, handler, signIn, journal, seed, call };
}

/** An owner's token, reaching these projects. */
async function ownerToken(b: Bench, slugs: string[]): Promise<{ token: TokenView; secret: string }> {
  const response = await b.call("POST", "/tokens/create", { token: "owner-unlock", label: "ci", holder: "owner", expiresAt: null, scope: { ...SCOPE, slugs } });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: TokenView; secret: string };
}

/** Ada's own token, minted under her unlock. */
async function adaToken(b: Bench, slugs: string[]): Promise<{ token: TokenView; secret: string }> {
  const response = await b.call("POST", "/team/member/tokens", { session: "ada-session", token: "ada-unlock", label: "laptop", expiresAt: null, scope: { ...SCOPE, slugs } });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: TokenView; secret: string };
}

async function answer(response: Response): Promise<{ status: number } & Record<string, unknown>> {
  return { status: response.status, ...((await response.json()) as Record<string, unknown>) };
}

describe("the steward: a project created by a person's token is a change of access", () => {
  const deploy = (b: Bench, secret: string, slug: string, deployment: string) => b.call("POST", "/control/deploy", { bearer: secret, deployment, slug, manifest: JSON.stringify({ slug }) });
  const create = async (b: Bench) => {
    const response = await b.call("POST", "/team/member/tokens", { session: "ada-session", token: "ada-unlock", label: "maker", expiresAt: null, scope: { ...SCOPE, slugs: ["kanban"], create: true } });
    expect(response.status).toBe(201);
    return ((await response.json()) as { secret: string }).secret;
  };

  test("refused before anything starts while the access log has no room for it", async () => {
    let full = false;
    const b = bench({ full: () => full });
    b.seed({ [ADA]: { kanban: "admin" } }, [ADA]);
    const secret = await create(b);
    full = true;
    const refused = await answer(await deploy(b, secret, "fresh", "aaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(refused).toMatchObject({ status: 503, error: "not-available", message: expect.stringContaining("the access log is full") });
    expect(existsSync(join(b.root, "state", "installs", "fresh.json"))).toBe(false);
    expect(existsSync(join(b.root, "state", "creations.json"))).toBe(false);
    // An existing project deploys all the same: nothing about access changes.
    expect((await deploy(b, secret, "kanban", "bbbbbbbbbbbbbbbbbbbbbbbb")).status).toBe(202);
    full = false;
    expect((await deploy(b, secret, "fresh", "cccccccccccccccccccccccc")).status).toBe(202);
  });

  test("counted among their changes of the hour", async () => {
    const b = bench({ changesPerHour: 1 });
    b.seed({ [ADA]: { kanban: "admin" } }, [ADA]);
    const secret = await create(b);
    expect((await deploy(b, secret, "fresh", "aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(202);
    expect(await answer(await deploy(b, secret, "another", "bbbbbbbbbbbbbbbbbbbbbbbb"))).toMatchObject({ status: 429, error: "too-many-attempts" });
  });
});

describe("the steward: reading a project's access with a token", () => {
  test("its project: the people with access, its general access, how people sign in, and what the portal reads", async () => {
    const b = bench();
    b.seed({ [ADA]: { kanban: "admin" }, [CAROL]: { kanban: "visitor" }, "@acme.test": { kanban: "visitor" } });
    const { secret } = await ownerToken(b, ["kanban"]);
    const response = await b.call("POST", "/control/access/list", { bearer: secret, slug: "kanban" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as AccessResponse;
    expect(body).toMatchObject({
      slug: "kanban",
      host: `kanban.${ZONE}`,
      url: `https://kanban.${ZONE}/`,
      general: { access: "restricted" },
      signIn: { configured: true, allowedDomains: ["acme.test", "acme-labs.test"] },
      portal: { reading: "steward" },
    });
    expect(body.entries.map((entry) => [entry.who, entry.kind, entry.role])).toEqual([
      [ADA, "person", "admin"],
      [CAROL, "person", "visitor"],
      ["@acme.test", "domain", "visitor"],
    ]);
  });

  test("a token reaches only its projects: any other slug reads as unknown, whatever is asked", async () => {
    const b = bench();
    const { secret } = await ownerToken(b, ["kanban"]);
    for (const [method, path, body] of [
      ["POST", "/control/access/list", { bearer: secret, slug: "notes" }],
      ["PUT", "/control/access", { bearer: secret, slug: "notes", who: CAROL, role: "visitor" }],
      ["DELETE", "/control/access", { bearer: secret, slug: "notes", who: CAROL }],
    ] as const) {
      expect(await answer(await b.call(method, path, body))).toMatchObject({ status: 404, error: "not-found", message: "no project notes for this token" });
    }
    expect(await answer(await b.call("POST", "/control/access/list", { bearer: secret, slug: "../x" }))).toMatchObject({ status: 400, error: "invalid" });
    expect(await answer(await b.call("POST", "/control/access/list", { bearer: "sst_".padEnd(47, "z"), slug: "kanban" }))).toMatchObject({ status: 401, error: "unauthenticated" });
    expect(b.journal).toEqual([]);
  });
});

describe("the steward: giving Can open with a token", () => {
  test("to a person inside the company's domains, and to one of those domains: written, journaled under the token, told to the portal", async () => {
    const b = bench();
    const { token, secret } = await ownerToken(b, ["kanban"]);
    const given = await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: " Carol@ACME.test ", role: "visitor" });
    expect(given.status).toBe(201);
    const body = (await given.json()) as EntryResponse;
    expect(body).toMatchObject({ slug: "kanban", change: "add", entry: { who: CAROL, kind: "person", role: "visitor", by: `token:${token.id}`, password: null } });
    expect(body.password).toBeUndefined();
    expect(b.journal.at(-1)).toEqual({ operation: "access.add", result: "ok", actor: `token:${token.id}`, member: CAROL, slug: "kanban", detail: `${CAROL}: Can open` });

    const domain = await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: "@acme-labs.test", role: "visitor" });
    expect(await answer(domain)).toMatchObject({ status: 201, change: "add", entry: { who: "@acme-labs.test", kind: "domain", role: "visitor" } });
    expect(b.journal.at(-1)).toMatchObject({ operation: "access.add", actor: `token:${token.id}`, member: null, detail: "@acme-labs.test: Can open" });

    // Asked again: nothing to change, nothing journaled.
    const journaled = b.journal.length;
    expect(await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: CAROL, role: "visitor" }))).toMatchObject({ status: 200, change: "none" });
    expect(b.journal).toHaveLength(journaled);

    // The registry names the token as who gave it; the portal's projection lets them in.
    expect(readRegistryFile(join(b.root, "state")).projects.kanban!.map((entry) => [entry.who, entry.by])).toEqual([
      ["@acme-labs.test", `token:${token.id}`],
      [ADA, "owner"],
      [CAROL, `token:${token.id}`],
    ]);
    const projection = readProjection(readFileSync(join(b.root, "portal-key", "access.json"), "utf8"));
    if ("unreadable" in projection) throw new Error(projection.unreadable);
    expect(projection.sites[`kanban.${ZONE}`]).toMatchObject({ slug: "kanban", people: { [ADA]: "admin", [CAROL]: "visitor" }, domains: ["acme-labs.test"] });
  });

  test("never a role above Can open, refused in the access rules' words and journaled", async () => {
    const b = bench();
    const { token, secret } = await ownerToken(b, ["kanban"]);
    for (const role of ["viewer", "developer", "admin"]) {
      const refused = await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: CAROL, role }));
      expect(refused).toMatchObject({ status: 403, error: "out-of-scope" });
      expect(refused.message).toStartWith("a token gives people Can open alone:");
    }
    expect(b.journal.at(-1)).toMatchObject({ operation: "access.add", result: "rejects", actor: `token:${token.id}`, member: CAROL, slug: "kanban" });
    // Nor lowering someone it could not have given that role.
    expect(await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: ADA, role: "visitor" }))).toMatchObject({
      status: 403,
      message: `${ADA} holds Admin on kanban: only someone who may give that role changes it`,
    });
    expect(await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: CAROL, role: "superuser" }))).toMatchObject({ status: 400, error: "invalid" });
    expect(readRegistryFile(join(b.root, "state")).projects.kanban!.map((entry) => entry.who)).toEqual([ADA]);
  });

  test("a domain only among the company's: outside them, or with none listed, or no company sign-in at all, refused", async () => {
    const b = bench();
    const { secret } = await ownerToken(b, ["kanban"]);
    const give = (who: string) => b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who, role: "visitor" });
    expect(await answer(await give("@gmail.test"))).toMatchObject({
      status: 400,
      error: "invalid",
      message: "@gmail.test is not among the company's domains (acme.test, acme-labs.test): only people at those domains sign in",
    });
    b.signIn.allowedDomains = [];
    expect((await answer(await give("@acme.test"))).message).toContain("the company's domains are not listed on this machine (OIDC_ALLOWED_DOMAINS)");
    b.signIn.configured = false;
    expect(await answer(await give("@acme.test"))).toMatchObject({ status: 400, error: "invalid", message: expect.stringContaining("signing in with a company account is not set up on this machine") });
    expect(readRegistryFile(join(b.root, "state")).projects.kanban!.map((entry) => entry.who)).toEqual([ADA]);
  });

  test("a person outside the company's domains is refused: password access is never given with a token", async () => {
    const b = bench();
    const { secret } = await ownerToken(b, ["kanban"]);
    const refused = await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: "eve@elsewhere.test", role: "visitor" }));
    expect(refused).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(refused.message).toBe(
      "eve@elsewhere.test would get password access (elsewhere.test is not among the company's domains (acme.test, acme-labs.test)), which is given from the dashboard or by the owner over SSH, never with a token",
    );
    // Without company sign-in, everyone would get one: refused alike.
    b.signIn.configured = false;
    expect((await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: CAROL, role: "visitor" }))).message).toContain("never with a token");
    expect(readRegistryFile(join(b.root, "state")).projects.kanban!.map((entry) => entry.who)).toEqual([ADA]);
  });

  test("a project the token reaches but the machine does not carry, or the platform's own: refused", async () => {
    const b = bench();
    const { secret } = await ownerToken(b, ["kanban", "ghost"]);
    expect(await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "ghost", who: CAROL, role: "visitor" }))).toMatchObject({
      status: 404,
      error: "not-found",
      message: "ghost is not deployed on this machine",
    });
  });

  test("a person's token needs Admin on the project, as the registry reads at that moment", async () => {
    const b = bench();
    const { token, secret } = await adaToken(b, ["kanban", "roster"]);
    expect(await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "roster", who: CAROL, role: "visitor" }))).toMatchObject({
      status: 403,
      error: "out-of-scope",
      message: `token:${token.id} does not manage the people with access to roster: that takes its Admin`,
    });
    expect(b.journal.at(-1)).toMatchObject({ operation: "access.add", result: "rejects", actor: `token:${token.id}`, slug: "roster" });
    expect(await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: CAROL, role: "visitor" }))).toMatchObject({ status: 201 });
    // An Admin's token still gives Can open alone.
    expect(await answer(await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: DAN, role: "viewer" }))).toMatchObject({ status: 403 });
    // People with access are read from Viewer up: the token lists both, a Developer's roster included, never the admin emails.
    expect((await b.call("POST", "/control/access/list", { bearer: secret, slug: "kanban" })).status).toBe(200);
    expect(await answer(await b.call("POST", "/control/access/list", { bearer: secret, slug: "roster" }))).toMatchObject({ status: 200, signIn: { admins: [] } });
    // Lowered to Developer on kanban: the token gives nothing there any more, nor removes; it still lists.
    b.seed({ [ADA]: { kanban: "developer", roster: "developer" }, [CAROL]: { kanban: "visitor" } });
    expect((await b.call("POST", "/control/access/list", { bearer: secret, slug: "kanban" })).status).toBe(200);
    expect((await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: DAN, role: "visitor" })).status).toBe(403);
    expect((await b.call("DELETE", "/control/access", { bearer: secret, slug: "kanban", who: CAROL })).status).toBe(403);
  });
});

describe("the steward: removing with a token", () => {
  test("Can open entries alone, a person's or a domain's; a higher role is refused; someone absent is unknown", async () => {
    const b = bench();
    b.seed({ [ADA]: { kanban: "admin" }, [CAROL]: { kanban: "visitor" }, [DAN]: { kanban: "viewer" }, "@acme.test": { kanban: "visitor" } });
    const { token, secret } = await ownerToken(b, ["kanban"]);
    const remove = (who: string) => b.call("DELETE", "/control/access", { bearer: secret, slug: "kanban", who });
    expect(await answer(await remove(CAROL))).toMatchObject({ status: 200, change: "remove", entry: { who: CAROL, role: "visitor" } });
    expect(b.journal.at(-1)).toEqual({ operation: "access.remove", result: "ok", actor: `token:${token.id}`, member: CAROL, slug: "kanban", detail: `${CAROL}: was Can open` });
    expect((await remove("@acme.test")).status).toBe(200);
    expect(await answer(await remove(DAN))).toMatchObject({ status: 403, error: "out-of-scope", message: `${DAN} holds Viewer on kanban: a token removes Can open entries alone` });
    expect(b.journal.at(-1)).toMatchObject({ operation: "access.remove", result: "rejects", actor: `token:${token.id}`, member: DAN });
    const journaled = b.journal.length;
    expect(await answer(await remove(CAROL))).toMatchObject({ status: 404, error: "not-found", message: `${CAROL} has no access to kanban` });
    // Someone absent is no refusal worth journaling.
    expect(b.journal).toHaveLength(journaled);
    expect(readRegistryFile(join(b.root, "state")).projects.kanban!.map((entry) => entry.who)).toEqual([ADA, DAN]);
  });
});

describe("the steward: what a token cannot do", () => {
  test("name an actor, or any field the route does not read", async () => {
    const b = bench();
    const { secret } = await ownerToken(b, ["kanban"]);
    for (const extra of [{ actor: "owner" }, { expiresInS: null }, { session: "ada-session" }]) {
      expect((await b.call("PUT", "/control/access", { bearer: secret, slug: "kanban", who: CAROL, role: "visitor", ...extra })).status).toBe(400);
    }
    expect((await b.call("DELETE", "/control/access", { bearer: secret, slug: "kanban", who: CAROL, role: "visitor" })).status).toBe(400);
    expect(b.journal).toEqual([]);
  });

  test("reach a steward without the access registry, which says so; nor the sharing route of before", async () => {
    const b = bench({ access: false });
    const { secret } = await ownerToken(b, ["kanban"]);
    expect(await answer(await b.call("POST", "/control/access/list", { bearer: secret, slug: "kanban" }))).toMatchObject({
      status: 503,
      error: "not-available",
      message: "this steward does not carry the access registry: the owner must run sitesolide upgrade",
    });
    expect(await answer(await b.call("PUT", "/control/sharing", { bearer: secret, slug: "kanban", mode: "admins", people: [], domains: [] }))).toMatchObject({ status: 404, message: "no such route" });
  });
});

// --- the dashboard's control API ------------------------------------------------------

const tokenOf = (letter: string) => `sst_${letter.repeat(43)}`;
const scope = (slugs: string[]) => ({ slugs, create: false, outbound: false, domain: false, public: false });

/** kanban is Grace's, granted; notes belongs to Linus's token. */
const IDENTITIES: Record<string, Identity> = {
  [tokenOf("g")]: { id: "bbbbbbbbbbbb", label: "Grace", email: "grace@acme.test", expiresAt: null, scope: scope(["kanban"]), owned: [], member: null },
  [tokenOf("l")]: { id: "cccccccccccc", label: "Linus", email: "linus@acme.test", expiresAt: null, scope: scope([]), owned: ["notes"], member: null },
};
const GRACE = tokenOf("g");

/** What the simulated steward answers, and what it was asked. */
const stewardState = {
  outdated: false,
  refusal: null as { status: number; error: string; message: string } | null,
  asked: [] as { route: string; requested: unknown }[],
};

/** The steward's access answer, the admin emails and the portal's reading in it, which a token never sees. */
function stewardAccess(slug: string): AccessResponse {
  return {
    slug,
    host: `${slug}.${ZONE}`,
    url: `https://${slug}.${ZONE}/`,
    general: { access: "restricted", modifiable: true, reason: null },
    entries: [{ who: CAROL, kind: "person", role: "visitor", by: "owner", createdAt: 1, updatedAt: 1, password: null }],
    signIn: { configured: true, allowedDomains: ["acme.test"], admins: ["ceo@acme.test"], providerName: "Acme" },
    portal: { reading: "steward", writtenAt: 1 },
    leaving: {},
  };
}

let root: string;
let dashboard: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "control-access-api-"));
  writeFileSync(join(root, "state.json"), "{}");
  const outdated = () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
  const steward = {
    authenticate: async (bearer: string) =>
      IDENTITIES[bearer] === undefined
        ? Response.json({ error: "unauthenticated", message: "unknown token: ask the owner of the machine for one" }, { status: 401 })
        : Response.json({ identity: IDENTITIES[bearer] }),
    accessList: async (bearer: string, slug: string) => {
      stewardState.asked.push({ route: "list", requested: { bearer, slug } });
      return stewardState.outdated ? outdated() : Response.json(stewardAccess(slug));
    },
    accessPut: async (requested: unknown) => {
      stewardState.asked.push({ route: "put", requested });
      if (stewardState.outdated) return outdated();
      if (stewardState.refusal !== null) return Response.json({ error: stewardState.refusal.error, message: stewardState.refusal.message }, { status: stewardState.refusal.status });
      const { slug, who } = requested as { slug: string; who: string };
      return Response.json({ slug, change: "add", entry: { who, kind: "person", role: "visitor", by: "token:bbbbbbbbbbbb", createdAt: 1, updatedAt: 1, password: null } }, { status: 201 });
    },
    accessRemove: async (requested: unknown) => {
      stewardState.asked.push({ route: "remove", requested });
      if (stewardState.outdated) return outdated();
      const { slug, who } = requested as { slug: string; who: string };
      return Response.json({ slug, change: "remove", entry: { who, kind: "person", role: "visitor", by: "owner", createdAt: 1, updatedAt: 1, password: null } });
    },
  } as unknown as ControlSteward;
  const store = createControlStore(openDatabase(join(root, "dashboard.db")));
  const spool = createSpool(join(root, "spool"));
  const api = createApiRoutes({
    steward,
    store,
    spool,
    limiter: createLimiter(),
    tracker: createTracker({ store, steward, spool }),
    stateFile: join(root, "state.json"),
    publicUrl: `https://dashboard.${ZONE}`,
    zone: ZONE,
  });
  dashboard = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/api/v1/projects/:slug/access": {
        GET: (req) => api.projectAccess(req, req.params.slug),
        PUT: (req) => api.putProjectAccess(req, req.params.slug),
        DELETE: (req) => api.removeProjectAccess(req, req.params.slug),
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  base = `http://127.0.0.1:${dashboard.port}`;
});

afterAll(() => {
  dashboard.stop(true);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  stewardState.outdated = false;
  stewardState.refusal = null;
  stewardState.asked.length = 0;
});

function read(slug: string, token = GRACE): Promise<Response> {
  return fetch(`${base}/api/v1/projects/${slug}/access`, { headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": "198.51.100.7" } });
}

function change(method: "PUT" | "DELETE", slug: string, body: unknown, token = GRACE): Promise<Response> {
  return fetch(`${base}/api/v1/projects/${slug}/access`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": "198.51.100.7", "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("the API: reading a project's access", () => {
  test("its project: general access, people with access, the company's domains; never the admin emails nor the portal's reading", async () => {
    const response = await read("kanban");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { access } = (await response.json()) as { access: ProjectAccess };
    expect(access).toEqual({
      slug: "kanban",
      host: `kanban.${ZONE}`,
      url: `https://kanban.${ZONE}/`,
      general: { access: "restricted", modifiable: true, reason: null },
      entries: [{ who: CAROL, kind: "person", role: "visitor", by: "owner", createdAt: 1, updatedAt: 1, password: null }],
      signIn: { configured: true, allowedDomains: ["acme.test"], providerName: "Acme" },
    });
    expect(JSON.stringify(access)).not.toContain("ceo@acme.test");
    expect(stewardState.asked).toEqual([{ route: "list", requested: { bearer: GRACE, slug: "kanban" } }]);
  });

  test("another token's project reads as unknown, and the steward is not asked", async () => {
    expect(await answer(await read("notes"))).toMatchObject({ status: 404, error: "not-found" });
    expect(stewardState.asked).toEqual([]);
  });

  test("no token, or an unknown one: unauthenticated", async () => {
    expect((await fetch(`${base}/api/v1/projects/kanban/access`)).status).toBe(401);
    expect(await answer(await read("kanban", tokenOf("z")))).toMatchObject({ status: 401, error: "unauthenticated" });
  });

  test("a steward from before the access registry: not-available, saying what the owner runs", async () => {
    stewardState.outdated = true;
    expect(await answer(await read("kanban"))).toMatchObject({ status: 503, error: "not-available", message: expect.stringContaining("sitesolide upgrade") });
  });
});

describe("the API: changing it, as its token", () => {
  test("someone given Can open: who and role passed on with the bearer, Can open when no role is named, the access as it stands sent back", async () => {
    const response = await change("PUT", "kanban", { who: CAROL });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { entry: unknown; change: string; access: ProjectAccess };
    expect(body).toMatchObject({ change: "add", entry: { who: CAROL, role: "visitor" }, access: { slug: "kanban", signIn: { allowedDomains: ["acme.test"] } } });
    expect(JSON.stringify(body)).not.toContain("ceo@acme.test");
    expect(stewardState.asked).toEqual([
      { route: "put", requested: { bearer: GRACE, slug: "kanban", who: CAROL, role: "visitor" } },
      { route: "list", requested: { bearer: GRACE, slug: "kanban" } },
    ]);
    // A role named is passed on as it is: the steward judges it.
    await change("PUT", "kanban", { who: CAROL, role: "admin" });
    expect(stewardState.asked.at(-2)).toEqual({ route: "put", requested: { bearer: GRACE, slug: "kanban", who: CAROL, role: "admin" } });
  });

  test("someone taken off: who alone passed on", async () => {
    const response = await change("DELETE", "kanban", { who: CAROL });
    expect(await answer(response)).toMatchObject({ status: 200, change: "remove", entry: { who: CAROL } });
    expect(stewardState.asked[0]).toEqual({ route: "remove", requested: { bearer: GRACE, slug: "kanban", who: CAROL } });
  });

  test("the steward's refusal passed on as it stands", async () => {
    stewardState.refusal = { status: 403, error: "out-of-scope", message: "a token gives people Can open alone: Admin is given from the dashboard, or by the owner over SSH" };
    expect(await answer(await change("PUT", "kanban", { who: CAROL, role: "admin" }))).toEqual({
      status: 403,
      error: "out-of-scope",
      message: "a token gives people Can open alone: Admin is given from the dashboard, or by the owner over SSH",
    });
    expect(stewardState.asked.map((one) => one.route)).toEqual(["put"]);
  });

  test("the access registry's bounds in the API's own codes: an hour used up is 429, a full access log 503", async () => {
    stewardState.refusal = { status: 429, error: "too-many-changes", message: "120 changes of access per hour at most: try again later" };
    expect(await answer(await change("PUT", "kanban", { who: CAROL }))).toMatchObject({ status: 429, error: "too-many-attempts", message: "120 changes of access per hour at most: try again later" });
    stewardState.refusal = { status: 507, error: "log-full", message: "the access log is full of changes younger than 180 days" };
    expect(await answer(await change("PUT", "kanban", { who: CAROL }))).toMatchObject({ status: 503, error: "not-available", message: "the access log is full of changes younger than 180 days" });
  });

  test("another token's project reads as unknown, before the body is even judged", async () => {
    expect(await answer(await change("PUT", "notes", { who: CAROL }))).toMatchObject({ status: 404, error: "not-found" });
    expect(await answer(await change("DELETE", "notes", "{"))).toMatchObject({ status: 404, error: "not-found" });
    expect(stewardState.asked).toEqual([]);
  });

  test("an actor or any other field in the body is refused: the token speaks for nobody else", async () => {
    for (const extra of [{ actor: "owner" }, { by: "ceo@acme.test" }, { expiresInS: null }]) {
      expect(await answer(await change("PUT", "kanban", { who: CAROL, ...extra }))).toMatchObject({ status: 400, error: "invalid", message: `unexpected field: ${Object.keys(extra)[0]}` });
    }
    expect(await answer(await change("DELETE", "kanban", { who: CAROL, role: "visitor" }))).toMatchObject({ status: 400, message: "unexpected field: role" });
    expect(await answer(await change("PUT", "kanban", "["))).toMatchObject({ status: 400, error: "invalid" });
    expect(stewardState.asked).toEqual([]);
  });

  test("a steward from before the access registry: not-available", async () => {
    stewardState.outdated = true;
    expect(await answer(await change("PUT", "kanban", { who: CAROL }))).toMatchObject({ status: 503, error: "not-available" });
    expect(await answer(await change("DELETE", "kanban", { who: CAROL }))).toMatchObject({ status: 503, error: "not-available" });
  });
});
