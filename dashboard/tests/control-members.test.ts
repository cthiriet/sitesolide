import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALLER_TEMPLATE, type Identity, type InstallRequest, type TokenView } from "../src/control/protocol";
import { createControlSteward, type ControlHandler, type MemberAuthority } from "../src/control/steward";
import { createControlSystem, type ControlSystem } from "../src/control/system";
import type { Role } from "../borrowed/access";
import { mayCreate, putEntry, recordCreation, removePerson, rightsOf, setCreate, type Registry } from "../src/access/registry";
import type { MemberEvent } from "../src/members/steward";
import { registryOf } from "./registry-fixtures";

/**
 * A person's own tokens, as the steward's control routes judge them: the real
 * registry of tokens on a throwaway tree, `systemctl` simulated, and the
 * members routes reduced to what the control routes ask of them, a session
 * and its unlock, the rights the access registry reads, and a creation
 * recorded, on an access registry kept in memory and changed by the test as
 * the owner would change it. The members routes themselves are
 * members-steward.test.ts's business; a token's changes of access,
 * control-access.test.ts's; the whole road through the dashboard,
 * members-flow.test.ts's.
 */

const ZONE = "test-zone.invalid";
const DEPLOYMENT = "00112233445566778899aabb";
const ADA = "ada@acme.test";
const BOB = "bob@acme.test";

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Bench = {
  root: string;
  handler: ControlHandler;
  registry: { value: Registry };
  journal: MemberEvent[];
  /** Sessions the members routes know, and the one unlocked. */
  sessions: Map<string, string>;
  unlocked: Set<string>;
};

function bench(): Bench {
  const root = mkdtempSync(join(tmpdir(), "control-members-"));
  toClean.push(root);
  for (const folder of ["state", "sites", "units", "installer"]) mkdirSync(join(root, folder));
  writeFileSync(join(root, "units", INSTALLER_TEMPLATE), "[Service]\n");
  for (const slug of ["alpha", "beta", "gamma"]) mkdirSync(join(root, "sites", slug));
  const registry = { value: registryOf({ [ADA]: { alpha: "developer", beta: "admin", gamma: "viewer" }, [BOB]: { gamma: "viewer", beta: "visitor" } }) };
  const journal: MemberEvent[] = [];
  const sessions = new Map<string, string>([
    ["ada-session", ADA],
    ["bob-session", BOB],
  ]);
  const unlocked = new Set<string>(["ada-session", "bob-session"]);
  const refuse = (error: string, message: string, status: number) => Response.json({ error, message }, { status });

  const members: MemberAuthority = {
    async authorize(session, unlock) {
      const email = typeof session === "string" ? sessions.get(session) : undefined;
      const rights = email === undefined ? null : rightsOf(registry.value, email);
      if (rights === null) return refuse("signed-out", "this session is closed: sign in again", 401);
      if (unlock !== null && (unlock !== `unlock-of-${session as string}` || !unlocked.has(session as string))) {
        return refuse("locked", "locked: unlock again, signing in once more with your provider", 401);
      }
      return { email: rights.email, roles: rights.roles, create: rights.create, session: `hash-of-${session as string}` };
    },
    unlockedUntil: async (session) => (unlocked.has(session as string) ? 1_900_000_000_000 : null),
    rights: async (email) => rightsOf(registry.value, email),
    async recordCreation(slug, email, tokenId) {
      const result = recordCreation(registry.value, email, slug, Date.now());
      if ("refusal" in result) return refuse("out-of-scope", result.refusal, 403);
      registry.value = result.registry;
      journal.push({ operation: "project.create", result: "ok", actor: email, member: email, detail: `admin, created with token ${tokenId}`, slug });
      return null;
    },
    journal: async (event) => void journal.push(event),
    journalRefusal: async (event) => void journal.push(event),
  };

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
    async systemctl(arguments_) {
      if (arguments_[0] === "is-active") return { code: 3, output: "inactive\n" };
      return { code: 0, output: "" };
    },
    journal: async () => ({ code: 0, output: "line\n" }),
  };
  const handler = createControlSteward(system, {
    zone: ZONE,
    isUnlocked: async (token) => token === "owner-unlock",
    uidRoot: null,
    members,
  });
  return { root, handler, registry, journal, sessions, unlocked };
}

function call(b: Bench, method: string, path: string, body?: unknown): Promise<Response> {
  return b.handler(
    new Request(`http://steward${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

const SCOPE = { slugs: [] as string[], create: false, outbound: false, domain: false, public: false };

async function mint(b: Bench, scope: Partial<typeof SCOPE>, session = "ada-session"): Promise<Response> {
  return call(b, "POST", "/team/member/tokens", { session, token: `unlock-of-${session}`, label: "laptop", expiresAt: null, scope: { ...SCOPE, ...scope } });
}

async function minted(b: Bench, scope: Partial<typeof SCOPE>, session = "ada-session"): Promise<{ token: TokenView; secret: string }> {
  const response = await mint(b, scope, session);
  expect(response.status).toBe(201);
  return (await response.json()) as { token: TokenView; secret: string };
}

async function message(response: Response): Promise<{ status: number; error: string; message: string; details?: string[] }> {
  return { status: response.status, ...((await response.json()) as { error: string; message: string; details?: string[] }) };
}

/** This person's roles replaced, as the owner would set them; the create right kept unless named. */
function setRoles(b: Bench, email: string, roles: Record<string, Role>, create?: boolean) {
  const keeps = create ?? mayCreate(b.registry.value, email);
  let registry = removePerson(b.registry.value, email).registry;
  for (const [slug, role] of Object.entries(roles)) {
    const put = putEntry(registry, slug, email, role, "owner", 1);
    if ("refusal" in put) throw new Error(put.refusal);
    registry = put.registry;
  }
  if (keeps) {
    const set = setCreate(registry, email, true, "owner", 1);
    if ("refusal" in set) throw new Error(set.refusal);
    registry = set.registry;
  }
  b.registry.value = registry;
}

describe("a person mints their own", () => {
  test("within their roles, under their unlock: their email on it, the person recorded, the journal naming them", async () => {
    const b = bench();
    const { token, secret } = await minted(b, { slugs: ["alpha", "beta"] });
    expect(token).toMatchObject({ label: "laptop", email: ADA, member: ADA, scope: { ...SCOPE, slugs: ["alpha", "beta"] }, owned: [] });
    const file = JSON.parse(readFileSync(join(b.root, "state", "team.json"), "utf8")) as { tokens: { member?: string }[] };
    expect(file.tokens[0]!.member).toBe(ADA);
    expect(readFileSync(join(b.root, "state", "team.json"), "utf8")).not.toContain(secret);
    expect(b.journal.at(-1)).toEqual({ operation: "token.create", result: "ok", actor: ADA, member: ADA, detail: `${token.id}: alpha, beta` });
    // The owner sees it among every token, with whose it is.
    const all = (await (await call(b, "GET", "/team/tokens")).json()) as { tokens: TokenView[] };
    expect(all.tokens.map((one) => [one.id, one.member])).toEqual([[token.id, ADA]]);
  });

  test("an email in the request is not theirs to choose: refused as a field, the token always carries the person's", async () => {
    const b = bench();
    const response = await call(b, "POST", "/team/member/tokens", { session: "ada-session", token: "unlock-of-ada-session", label: "x", email: "ceo@acme.test", expiresAt: null, scope: SCOPE });
    expect(response.status).toBe(400);
  });

  test("without their unlock, or signed out: refused before anything is judged", async () => {
    const b = bench();
    b.unlocked.delete("ada-session");
    expect(await message(await mint(b, { slugs: ["alpha"] }))).toMatchObject({ status: 401, error: "locked" });
    expect(await message(await mint(b, { slugs: ["alpha"] }, "nobody"))).toMatchObject({ status: 401, error: "signed-out" });
    expect(b.journal).toEqual([]);
  });

  test("above their roles: refused in the steward's words, every reason, journaled", async () => {
    const b = bench();
    const viewed = await message(await mint(b, { slugs: ["gamma"] }));
    expect(viewed).toMatchObject({ status: 403, error: "out-of-scope" });
    expect(viewed.message).toBe("scope.slugs: ada@acme.test is a Viewer on gamma: deploying it takes a Developer or an Admin");
    const options = await message(await mint(b, { slugs: ["alpha", "beta"], public: true }));
    expect(options.details).toEqual(["scope.public: ada@acme.test is a Developer on alpha: deploying it in the open, its general access public, takes an Admin"]);
    const create = await message(await mint(b, { create: true }));
    expect(create.message).toContain("may not create projects");
    expect(b.journal.map((event) => [event.operation, event.result])).toEqual([
      ["token.create", "rejects"],
      ["token.create", "rejects"],
      ["token.create", "rejects"],
    ]);
    expect((await (await call(b, "GET", "/team/tokens")).json()) as unknown).toEqual({ tokens: [] });
  });

  test("a Viewer everywhere mints nothing, Can open somewhere changing nothing", async () => {
    const b = bench();
    const refused = await message(await mint(b, { slugs: ["gamma"] }, "bob-session"));
    expect(refused).toMatchObject({ status: 403, error: "out-of-scope", message: "bob@acme.test is a Viewer on every project and may not create projects: a Viewer mints no token" });
  });

  test("the options where they are Admin, and creating once the right is granted", async () => {
    const b = bench();
    expect((await mint(b, { slugs: ["beta"], public: true, outbound: true, domain: true })).status).toBe(201);
    setRoles(b, ADA, { alpha: "developer", beta: "admin" }, true);
    expect((await mint(b, { create: true, outbound: true })).status).toBe(201);
  });

  test("ten live tokens per person at most", async () => {
    const b = bench();
    for (let i = 0; i < 10; i++) await minted(b, { slugs: ["alpha"] });
    expect(await message(await mint(b, { slugs: ["alpha"] }))).toMatchObject({ status: 400, error: "invalid", message: "10 live tokens per person at most: revoke one you no longer use" });
  });

  test("they list and revoke their own alone; another's reads as unknown", async () => {
    const b = bench();
    const own = await minted(b, { slugs: ["alpha"] });
    setRoles(b, BOB, { gamma: "developer" });
    const bobs = await minted(b, { slugs: ["gamma"] }, "bob-session");
    const listed = (await (await call(b, "POST", "/team/member/list", { session: "ada-session" })).json()) as { tokens: TokenView[]; rights: unknown; until: number | null };
    expect(listed.tokens.map((one) => one.id)).toEqual([own.token.id]);
    expect(listed.rights).toEqual({ roles: { alpha: "developer", beta: "admin", gamma: "viewer" }, create: false });
    expect(listed.until).toBe(1_900_000_000_000);
    expect(await message(await call(b, "POST", "/team/member/revoke", { session: "ada-session", id: bobs.token.id }))).toMatchObject({ status: 404, message: "no such token of yours" });
    // No unlock needed to revoke.
    b.unlocked.delete("ada-session");
    const revoked = await call(b, "POST", "/team/member/revoke", { session: "ada-session", id: own.token.id });
    expect(revoked.status).toBe(200);
    expect(b.journal.at(-1)).toEqual({ operation: "token.revoke", result: "ok", actor: ADA, member: ADA, detail: own.token.id });
    // A person mints another; an owner's token holder asks the owner.
    expect(await message(await call(b, "POST", "/control/authenticate", { bearer: own.secret }))).toMatchObject({
      status: 401,
      message: "this token was revoked: mint a new one from the dashboard's Tokens page if you still have a role there, then run sitesolide login again",
    });
    // The owner revokes any token, a person's included.
    expect((await call(b, "POST", "/team/revoke", { id: bobs.token.id })).status).toBe(200);
  });
});

describe("narrowed to the person's roles at every use", () => {
  test("the identity a token authenticates with is the person's rights now, not as minted", async () => {
    const b = bench();
    const { secret } = await minted(b, { slugs: ["alpha", "beta"], create: false });
    const before = (await (await call(b, "POST", "/control/authenticate", { bearer: secret })).json()) as { identity: Identity };
    expect(before.identity).toMatchObject({ member: ADA, scope: { slugs: ["alpha", "beta"] } });
    setRoles(b, ADA, { alpha: "viewer", beta: "admin" });
    const after = (await (await call(b, "POST", "/control/authenticate", { bearer: secret })).json()) as { identity: Identity };
    expect(after.identity.scope.slugs).toEqual(["beta"]);
  });

  test("a role lowered from Developer to Viewer or Can open stops that project's deployments, its logs too, in the steward's words", async () => {
    const b = bench();
    const { secret } = await minted(b, { slugs: ["alpha"] });
    expect((await call(b, "POST", "/control/preflight", { bearer: secret, slug: "alpha" })).status).toBe(200);
    setRoles(b, ADA, { alpha: "viewer", beta: "admin" });
    for (const [path, body] of [
      ["/control/preflight", { bearer: secret, slug: "alpha" }],
      ["/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "alpha", manifest: JSON.stringify({ slug: "alpha" }) }],
      ["/control/logs", { bearer: secret, slug: "alpha", lines: 10, cursor: null }],
    ] as const) {
      expect(await message(await call(b, "POST", path, body))).toMatchObject({
        status: 403,
        error: "out-of-scope",
        message: "ada@acme.test is a Viewer on alpha: deploying it takes a Developer or an Admin",
      });
    }
    // Can open is no role on the dashboard: the project reads as one they hold no role on.
    setRoles(b, ADA, { alpha: "visitor", beta: "admin" });
    expect(await message(await call(b, "POST", "/control/preflight", { bearer: secret, slug: "alpha" }))).toMatchObject({ status: 403, message: "ada@acme.test holds no role on alpha" });
    // Nothing was asked of the installer.
    expect(existsSync(join(b.root, "state", "installs", "alpha.json"))).toBe(false);
  });

  test("a project the token created stops too once its role there is lowered: the role says, not who created it", async () => {
    const b = bench();
    setRoles(b, ADA, { alpha: "developer" }, true);
    const { secret, token } = await minted(b, { create: true });
    const deployed = await call(b, "POST", "/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "omega", manifest: JSON.stringify({ slug: "omega" }) });
    expect(deployed.status).toBe(202);
    mkdirSync(join(b.root, "sites", "omega"));
    setRoles(b, ADA, { alpha: "developer", omega: "viewer" }, true);
    const refused = await message(await call(b, "POST", "/control/preflight", { bearer: secret, slug: "omega" }));
    expect(refused).toMatchObject({ status: 403, message: "ada@acme.test is a Viewer on omega: deploying it takes a Developer or an Admin" });
    const identity = (await (await call(b, "POST", "/control/authenticate", { bearer: secret })).json()) as { identity: Identity };
    expect(identity.identity.owned).toEqual([]);
    expect(token.owned).toEqual([]);
  });

  test("the create right taken back stops new projects", async () => {
    const b = bench();
    setRoles(b, ADA, { alpha: "developer" }, true);
    const { secret } = await minted(b, { create: true });
    setRoles(b, ADA, { alpha: "developer" }, false);
    expect(await message(await call(b, "POST", "/control/preflight", { bearer: secret, slug: "fresh" }))).toMatchObject({ status: 403, message: expect.stringContaining("may not create projects") });
  });

  test("a project not among the token's: said in a person's words, the Tokens page where they mint another", async () => {
    const b = bench();
    const { secret } = await minted(b, { slugs: ["alpha"] });
    expect((await message(await call(b, "POST", "/control/preflight", { bearer: secret, slug: "beta" }))).message).toBe(
      "beta is not among this token's projects: mint a token for it from the dashboard's Tokens page",
    );
  });
});

describe("a person who no longer signs in", () => {
  test("their tokens are revoked under who took them off, and refused even before", async () => {
    const b = bench();
    const one = await minted(b, { slugs: ["alpha"] });
    const two = await minted(b, { slugs: ["beta"] });
    // Off the registry, the tokens are refused at once, revoked or not.
    b.registry.value = removePerson(b.registry.value, ADA).registry;
    const refused = await message(await call(b, "POST", "/control/authenticate", { bearer: one.secret }));
    expect(refused).toMatchObject({ status: 401, error: "unauthenticated", message: "this token belongs to ada@acme.test, who no longer has a role on this dashboard: it is refused" });
    expect(await b.handler.revokeMember(ADA, "owner")).toBe(2);
    expect(b.journal.at(-1)).toEqual({
      operation: "token.revoke",
      result: "ok",
      actor: "owner",
      member: ADA,
      detail: `${one.token.id}, ${two.token.id}: ada@acme.test no longer has a role on this dashboard`,
    });
    const all = (await (await call(b, "GET", "/team/tokens")).json()) as { tokens: TokenView[] };
    expect(all.tokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(await b.handler.revokeMember(ADA, "owner")).toBe(0);
  });

  test("lowered to Can open everywhere, their tokens are refused as well", async () => {
    const b = bench();
    const { secret } = await minted(b, { slugs: ["alpha"] });
    setRoles(b, ADA, { alpha: "visitor", beta: "visitor" });
    expect(await message(await call(b, "POST", "/control/authenticate", { bearer: secret }))).toMatchObject({ status: 401, message: expect.stringContaining("no longer has a role on this dashboard") });
  });
});

describe("ownership of what a person's token creates", () => {
  test("the person becomes its Admin, before the token owns it, and the installer is told whose token it is", async () => {
    const b = bench();
    setRoles(b, ADA, { alpha: "developer" }, true);
    const { secret, token } = await minted(b, { create: true });
    const response = await call(b, "POST", "/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "omega", manifest: JSON.stringify({ slug: "omega" }) });
    expect(response.status).toBe(202);
    expect(rightsOf(b.registry.value, ADA)?.roles).toEqual({ alpha: "developer", omega: "admin" });
    expect(b.journal.at(-1)).toEqual({ operation: "project.create", result: "ok", actor: ADA, member: ADA, detail: `admin, created with token ${token.id}`, slug: "omega" });
    const team = JSON.parse(readFileSync(join(b.root, "state", "team.json"), "utf8")) as { owners: Record<string, string> };
    expect(team.owners).toEqual({ omega: token.id });
    const request = JSON.parse(readFileSync(join(b.root, "state", "installs", "omega.json"), "utf8")) as InstallRequest;
    expect(request.token).toEqual({ id: token.id, email: ADA, member: ADA });
    expect(request.creating).toBe(true);
  });
});

describe("a project removed from the machine", () => {
  const forget = (b: Bench, slug: unknown) =>
    b.handler.owner(new Request("http://steward/team/project", { method: "DELETE", body: JSON.stringify({ slug }) }));

  test("on the owner's socket, once the machine no longer carries it: its name free for another token, journaled", async () => {
    const b = bench();
    setRoles(b, ADA, { alpha: "developer" }, true);
    const { secret, token } = await minted(b, { create: true });
    expect((await call(b, "POST", "/control/deploy", { bearer: secret, deployment: DEPLOYMENT, slug: "omega", manifest: JSON.stringify({ slug: "omega" }) })).status).toBe(202);
    mkdirSync(join(b.root, "sites", "omega"));

    // Still on the machine: refused, the ownership kept.
    expect(await message(await forget(b, "omega"))).toMatchObject({ status: 409, error: "busy", message: "omega is still on the machine: remove it first, with sitesolide remove --confirm omega" });
    // Another token may not create it meanwhile.
    const other = await call(b, "POST", "/team/tokens", { token: "owner-unlock", label: "ci", email: "ci@acme.test", expiresAt: null, scope: { ...SCOPE, create: true } });
    const ci = (await other.json()) as { secret: string };
    rmSync(join(b.root, "sites", "omega"), { recursive: true });
    expect((await message(await call(b, "POST", "/control/preflight", { bearer: ci.secret, slug: "omega" }))).message).toContain("belongs to another token");

    // Removed: forgotten, journaled under the owner, the token in the detail.
    const released = await forget(b, "omega");
    expect(await released.json()).toEqual({ slug: "omega", forgotten: token.id });
    expect(b.journal.at(-1)).toEqual({ operation: "project.remove", result: "ok", actor: "owner", member: null, detail: `created by token ${token.id}, its name free again`, slug: "omega" });
    const team = JSON.parse(readFileSync(join(b.root, "state", "team.json"), "utf8")) as { owners: Record<string, string> };
    expect(team.owners).toEqual({});
    expect(await (await call(b, "POST", "/control/preflight", { bearer: ci.secret, slug: "omega" })).json()).toEqual({ creating: true });
    // Asked again: nothing left to forget, nothing journaled.
    const journaled = b.journal.length;
    expect(await (await forget(b, "omega")).json()).toEqual({ slug: "omega", forgotten: null });
    expect(b.journal).toHaveLength(journaled);
  });

  test("never on the dashboard's socket, and a slug of no shape refused", async () => {
    const b = bench();
    const asDashboard = await call(b, "DELETE", "/team/project", { slug: "omega" });
    expect(await message(asDashboard)).toMatchObject({ status: 404, message: "no such route" });
    expect((await forget(b, "../x")).status).toBe(400);
    expect((await b.handler.owner(new Request("http://steward/team/tokens"))).status).toBe(404);
  });
});
