import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSERTION_ISSUER,
  ASSERTION_TYPE,
  DASHBOARD_AUDIENCE,
  generateKeyPair,
  readPrivateKey,
  readPublicKey,
  signAssertion,
  type PrivateKey,
} from "../borrowed/assertion";
import { createAccessSystem } from "../src/access/system";
import { fromJournal } from "../src/audit/normalize";
import { MAX_AUTH_AGE_S, MEMBER_SESSION_DURATION_MS } from "../src/members/protocol";
import { createMemberRoutes, type MemberEvent, type MemberRoutes, type RestartRefusal } from "../src/members/steward";
import { createMembersSystem, type MembersSystem } from "../src/members/system";
import { reread } from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";
import { createSteward, type StewardHandler } from "../src/secrets/steward";
import { createSystem, type Command, type System } from "../src/secrets/system";
import { memoryAccess, registryOf, writeRegistry, type People } from "./registry-fixtures";

/**
 * Every decision the steward takes for the people who sign in to the
 * dashboard, as root would take it: on a throwaway tree, with the real files,
 * the real key pair, the real access registry and the real journal,
 * `systemctl` alone simulated.
 *
 * A session opens only on an assertion the portal signed with the key this
 * steward laid, for the dashboard, unexpired, never seen, for someone the
 * access registry gives a role above Can open, or the right to create
 * projects; every later request is judged against the registry as it reads at
 * that moment; the journal names who the steward verified. The registry is
 * seeded here by writing it where the steward reads it: its own routes are
 * the access tests' business.
 */

const PASSWORD = "Owner-Password-For-The-Tests-1";
const ZONE = "test-zone.invalid";
const ALICE = "alice@acme.test";
const BOB = "bob@acme.test";

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Bench = {
  root: string;
  clock: { t: number };
  dashboard: StewardHandler;
  /** A new steward on the same files: what a restart of the unit does. */
  restartSteward: () => void;
  calls: string[][];
  barrier: { promise: Promise<void> | null };
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  asRoot: (method: string, path: string, body?: unknown) => Promise<Response>;
  journal: () => LogEntry[];
  privateKey: () => PrivateKey;
  /** The access registry laid as the owner would have left it. */
  seed: (people: People, creators?: string[]) => void;
  /** The tokens revocations the steward asked for: who, and under whom. */
  revoked: [string, string][];
};

async function mount(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "members-"));
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
  folder("caddy");
  folder("gatekeeper");

  const project = (slug: string, manifest: Record<string, unknown>) => {
    mkdirSync(join(sites, slug), { recursive: true });
    writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, ...manifest }));
  };
  const app = { start: "/usr/local/bin/bun run server.ts", port: 3040, publicDir: "public" };
  project("blog", app);
  project("shop", { ...app, port: 3041 });
  project("notes", { publicDir: "public" });
  project("dashboard", { ...app, port: 3022, secrets: ["dashboard.env"] });
  project("portal", { ...app, port: 3026, secrets: ["portal.env"] });
  writeFileSync(join(units, "blog.service"), "[Service]\nExecStart=/usr/local/bin/bun run server.ts\n");
  writeFileSync(join(units, "shop.service"), "[Service]\nExecStart=/usr/local/bin/bun run server.ts\n");

  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  writeFileSync(
    join(secrets, "portal.env"),
    "OIDC_ISSUER=https://login.test-zone.invalid\nOIDC_CLIENT_ID=client\nOIDC_CLIENT_SECRET=secret\nOIDC_ALLOWED_DOMAINS=acme.test\n",
    { mode: 0o600 },
  );

  const clock = { t: Date.now() };
  const calls: string[][] = [];
  const barrier: Bench["barrier"] = { promise: null };
  const real = createSystem({
    sitesDir: sites,
    secretsFolder: secrets,
    unitsFolder: units,
    stateFolder: state,
    hashFile: join(secrets, "dashboard.env"),
    accountsFile: join(root, "passwd"),
    caddyFolder: join(root, "caddy"),
    gatekeeperFolder: join(root, "gatekeeper"),
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
  const members: MembersSystem = {
    ...createMembersSystem({ stateFolder: state, sitesDir: sites, secretsFolder: secrets, portalKeyFolder: portalKey, groupsFile: join(root, "group"), portalGroup: "" }),
    now: () => clock.t,
  };
  const access = {
    ...createAccessSystem({ stateFolder: state, portalKeyFolder: portalKey, groupsFile: join(root, "group"), portalGroup: "", portalDataFolder: join(root, "portal-data") }, false),
    now: () => clock.t,
  };
  const revoked: [string, string][] = [];
  const make = () =>
    createSteward(system, {
      secretsFolder: secrets,
      checkAccounts: false,
      members: {
        system: members,
        access,
        zone: ZONE,
        revokeTokens: async (email, actor) => {
          revoked.push([email, actor]);
          return 1;
        },
      },
    });
  let dashboard = make();
  await dashboard.ensureMemberKeys();

  const request = (handler: () => StewardHandler["owner"]) => (method: string, path: string, body?: unknown) =>
    handler()(new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  return {
    root,
    clock,
    get dashboard() {
      return dashboard;
    },
    restartSteward: () => {
      dashboard = make();
    },
    calls,
    barrier,
    call: request(() => dashboard),
    asRoot: request(() => dashboard.owner),
    journal: () => (existsSync(join(state, "journal.jsonl")) ? reread(readFileSync(join(state, "journal.jsonl"), "utf8")) : []),
    privateKey: () => readPrivateKey(readFileSync(join(portalKey, "assertion.key"), "utf8"))!,
    seed: (people, creators = []) => writeRegistry(state, registryOf(people, creators)),
    revoked,
  };
}

async function unlock(bench: Bench): Promise<string> {
  const response = await bench.call("POST", "/unlock", { password: PASSWORD });
  return ((await response.json()) as { token: string }).token;
}

/** What the portal hands the dashboard for this person, signed with the key the steward laid. */
function assertion(bench: Pick<Bench, "clock" | "privateKey">, email = ALICE, authAgeS = 60, reauth = false): Promise<string> {
  const nowS = Math.floor(bench.clock.t / 1000);
  return signAssertion(bench.privateKey(), { email, name: "Alice Martin", authTime: nowS - authAgeS, reauth }, nowS);
}

async function signIn(bench: Bench, token: string): Promise<Response> {
  return bench.call("POST", "/members/signin", { assertion: token });
}

async function sessionOf(bench: Bench, email = ALICE): Promise<string> {
  const response = await signIn(bench, await assertion(bench, email));
  expect(response.status).toBe(200);
  return ((await response.json()) as { session: string }).session;
}

/** Alice: Developer on blog and notes, Viewer on shop. */
function withAlice(bench: Bench): void {
  bench.seed({ [ALICE]: { blog: "developer", shop: "viewer", notes: "developer" } });
}

describe("the key pair", () => {
  test("laid once, the private half for the portal, the public half kept, and laid again when they no longer match", async () => {
    const bench = await mount();
    const first = bench.privateKey();
    const kept = readPublicKey(readFileSync(join(bench.root, "state", "assertion.pub"), "utf8"));
    expect(kept?.kid).toBe(first.kid);
    expect(readFileSync(join(bench.root, "state", "assertion.pub"), "utf8")).not.toContain(first.d);

    await bench.dashboard.ensureMemberKeys();
    expect(bench.privateKey().kid).toBe(first.kid);

    rmSync(join(bench.root, "portal-key", "assertion.key"));
    const key = await bench.call("GET", "/members/key");
    const { publicKey } = (await key.json()) as { publicKey: { kid: string } };
    expect(publicKey.kid).not.toBe(first.kid);
    expect(bench.privateKey().kid).toBe(publicKey.kid);
  });

  test("not laid without the portal's folder: nobody signs in, and is told why", async () => {
    const bench = await mount();
    rmSync(join(bench.root, "portal-key"), { recursive: true });
    rmSync(join(bench.root, "state", "assertion.pub"));
    const key = await bench.call("GET", "/members/key");
    expect(key.status).toBe(503);
    expect(await key.json()).toMatchObject({ error: "not-ready", message: expect.stringContaining("/etc/sitesolide-portal") });
  });
});

describe("the owner's socket", () => {
  test("carries the access registry, and none of a person's routes", async () => {
    const bench = await mount();
    withAlice(bench);
    expect((await bench.asRoot("GET", "/people")).status).toBe(200);
    for (const path of ["/members/signin", "/members/restart", "/members/whoami", "/members/unlock", "/projects", "/unlock"]) {
      expect([path, (await bench.asRoot("POST", path, {})).status]).toEqual([path, 404]);
    }
    expect((await bench.asRoot("GET", "/members/key")).status).toBe(404);
  });
});

describe("signing in", () => {
  test("an assertion the portal signed opens a session for someone with a role, once; the journal names them", async () => {
    const bench = await mount();
    withAlice(bench);
    const token = await assertion(bench);
    const response = await signIn(bench, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: string; expiresAt: number; identity: unknown };
    expect(body.expiresAt).toBe(bench.clock.t + MEMBER_SESSION_DURATION_MS);
    expect(body.identity).toEqual({ kind: "member", email: ALICE, name: "Alice Martin", roles: { blog: "developer", shop: "viewer", notes: "developer" }, create: false });
    expect(bench.journal().at(-1)).toMatchObject({
      operation: "dashboard.signin",
      result: "ok",
      actor: ALICE,
      member: ALICE,
      detail: "blog: developer, notes: developer, shop: viewer",
    });
    // The session's token is nowhere in the steward's files: only its hash.
    expect(readFileSync(join(bench.root, "state", "member-sessions.json"), "utf8")).not.toContain(body.session);

    const replayed = await signIn(bench, token);
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ error: "invalid-assertion" });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "dashboard.signin_failed", actor: ALICE, detail: "replayed-assertion" });
  });

  test("the Activity page reads the sign-ins under their new names", async () => {
    const bench = await mount();
    withAlice(bench);
    await sessionOf(bench);
    const rows = fromJournal(bench.journal()).map((one) => one.row);
    expect(rows.at(-1)).toMatchObject({ actor: ALICE, action: "dashboard.signin", target: ALICE, detail: { result: "ok" } });
  });

  test("replayed after the steward restarted, still refused", async () => {
    const bench = await mount();
    withAlice(bench);
    const token = await assertion(bench);
    expect((await signIn(bench, token)).status).toBe(200);
    bench.restartSteward();
    expect((await signIn(bench, token)).status).toBe(401);
  });

  test("signed by another key, for another audience, expired, about a sign-in too old: refused", async () => {
    const bench = await mount();
    withAlice(bench);
    const nowS = Math.floor(bench.clock.t / 1000);

    const stranger = await generateKeyPair();
    const forged = await signAssertion(stranger.privateKey, { email: ALICE, name: null, authTime: nowS }, nowS);
    expect(await (await signIn(bench, forged)).json()).toMatchObject({ error: "invalid-assertion", message: expect.stringContaining("unknown-key") });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "dashboard.signin_failed", actor: "anonymous", member: null, detail: "unknown-key" });

    const key = bench.privateKey();
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signed = `${b64({ alg: "EdDSA", typ: ASSERTION_TYPE, kid: key.kid })}.${b64({
      iss: ASSERTION_ISSUER,
      aud: "site",
      email: ALICE,
      name: null,
      auth_time: nowS,
      iat: nowS,
      exp: nowS + 300,
      nonce: "a".repeat(43),
    })}`;
    const cryptoKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: key.x, d: key.d }, { name: "Ed25519" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, cryptoKey, new TextEncoder().encode(signed))).toString("base64url");
    expect(await (await signIn(bench, `${signed}.${signature}`)).json()).toMatchObject({ message: expect.stringContaining("wrong-audience") });
    expect(DASHBOARD_AUDIENCE).toBe("dashboard");

    const late = await assertion(bench);
    bench.clock.t += 300_000;
    expect(await (await signIn(bench, late)).json()).toMatchObject({ message: expect.stringContaining("expired") });

    const stale = await assertion(bench, ALICE, MAX_AUTH_AGE_S + 1);
    expect(await (await signIn(bench, stale)).json()).toMatchObject({ error: "invalid-assertion", message: expect.stringContaining("too old") });
  });

  test("an email the registry does not name is refused, and named in the journal", async () => {
    const bench = await mount();
    withAlice(bench);
    const response = await signIn(bench, await assertion(bench, BOB));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "not-a-member",
      message: `${BOB} has no role on this dashboard: ask its owner, or the Admin of a project, for access`,
    });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "dashboard.signin_failed", actor: BOB, detail: "no-role" });
  });

  test("someone who can only open sites, by name or by their domain, is refused: the dashboard has nothing for them", async () => {
    const bench = await mount();
    const carol = "carol@acme.test";
    bench.seed({ [ALICE]: { blog: "developer" }, [carol]: { blog: "visitor", shop: "visitor" }, "@acme.test": { notes: "visitor" } });
    for (const email of [carol, BOB]) {
      const response = await signIn(bench, await assertion(bench, email));
      expect([email, response.status]).toEqual([email, 403]);
      expect(await response.json()).toMatchObject({ error: "not-a-member", message: expect.stringContaining("has no role on this dashboard") });
    }
    expect(bench.journal().at(-1)).toMatchObject({ operation: "dashboard.signin_failed", actor: BOB, detail: "no-role" });
  });

  test("a role above Can open somewhere, or the create right alone, opens a session that names no visitor role", async () => {
    const bench = await mount();
    const carol = "carol@acme.test";
    const dave = "dave@acme.test";
    bench.seed({ [carol]: { blog: "visitor", shop: "viewer" }, [dave]: { blog: "visitor" } }, [dave]);
    const asCarol = await signIn(bench, await assertion(bench, carol));
    expect(((await asCarol.json()) as { identity: unknown }).identity).toMatchObject({ email: carol, roles: { shop: "viewer" }, create: false });
    const asDave = await signIn(bench, await assertion(bench, dave));
    expect(asDave.status).toBe(200);
    expect(((await asDave.json()) as { identity: unknown }).identity).toMatchObject({ email: dave, roles: {}, create: true });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "dashboard.signin", actor: dave, detail: "no project; may create projects" });
  });

  test("a registry that does not read refuses everyone, and says where to look", async () => {
    const bench = await mount();
    withAlice(bench);
    writeFileSync(join(bench.root, "state", "access.json"), "{ not json");
    const response = await signIn(bench, await assertion(bench));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "failure", message: expect.stringContaining("access.json") });
  });

  test("a flood of forged assertions fills a minute's share of the journal, never more", async () => {
    const bench = await mount();
    const before = bench.journal().length;
    for (let i = 0; i < 30; i++) await signIn(bench, "not.an.assertion");
    expect(bench.journal().length - before).toBe(20);
  });
});

describe("a person's session", () => {
  test("says who it is and their roles as the registry reads now, survives a restart of the steward, and closes on sign-out", async () => {
    const bench = await mount();
    withAlice(bench);
    const session = await sessionOf(bench);
    const whoami = async () => bench.call("POST", "/members/whoami", { session });
    expect(await (await whoami()).json()).toMatchObject({ identity: { email: ALICE, roles: { blog: "developer" } } });

    bench.seed({ [ALICE]: { blog: "viewer" } });
    expect(((await (await whoami()).json()) as { identity: { roles: unknown } }).identity.roles).toEqual({ blog: "viewer" });

    bench.restartSteward();
    expect((await whoami()).status).toBe(200);

    expect((await bench.call("POST", "/members/signout", { session })).status).toBe(204);
    expect(bench.journal().at(-1)).toMatchObject({ operation: "dashboard.signout", actor: ALICE });
    expect((await whoami()).status).toBe(401);
    // Signing out what is already closed is not a fault.
    expect((await bench.call("POST", "/members/signout", { session })).status).toBe(204);
  });

  test("lapses after half a day", async () => {
    const bench = await mount();
    withAlice(bench);
    const session = await sessionOf(bench);
    bench.clock.t += MEMBER_SESSION_DURATION_MS;
    expect((await bench.call("POST", "/members/whoami", { session })).status).toBe(401);
  });

  test("falls with its person: taken off the registry, they are out at the next request", async () => {
    const bench = await mount();
    withAlice(bench);
    const session = await sessionOf(bench);
    bench.seed({});
    const whoami = await bench.call("POST", "/members/whoami", { session });
    expect(whoami.status).toBe(401);
    expect(await whoami.json()).toEqual({ error: "signed-out", message: `${ALICE} no longer has a role on this dashboard` });
    const restart = await bench.call("POST", "/members/restart", { session, slug: "blog" });
    expect(restart.status).toBe(401);
    expect(await restart.json()).toMatchObject({ error: "signed-out" });
    expect(bench.calls.some((call) => call[0] === "restart")).toBe(false);
  });

  test("lowered to Can open everywhere, they are out as well", async () => {
    const bench = await mount();
    withAlice(bench);
    const session = await sessionOf(bench);
    bench.seed({ [ALICE]: { blog: "visitor", shop: "visitor" } });
    expect(await (await bench.call("POST", "/members/whoami", { session })).json()).toMatchObject({ error: "signed-out" });
  });
});

describe("a person's restart", () => {
  test("a developer restarts their project's service; the journal names them", async () => {
    const bench = await mount();
    withAlice(bench);
    const session = await sessionOf(bench);
    const response = await bench.call("POST", "/members/restart", { session, slug: "blog" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verdict: { kind: "active" } });
    expect(bench.calls).toContainEqual(["restart", "blog"]);
    const entry = bench.journal().at(-1)!;
    expect(entry).toMatchObject({ operation: "restart", result: "ok", actor: ALICE, member: ALICE, slug: "blog" });
    // The Activity page reads the email, not `owner`.
    expect(fromJournal([entry])[0]?.row).toMatchObject({ actor: ALICE, action: "service.restart", target: "blog" });
  });

  test("a viewer is refused, and so is anyone on a project they hold no role on or can only open: nothing restarts", async () => {
    const bench = await mount();
    bench.seed({ [ALICE]: { blog: "visitor", shop: "viewer", notes: "developer" } });
    const session = await sessionOf(bench);
    const viewer = await bench.call("POST", "/members/restart", { session, slug: "shop" });
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toEqual({
      error: "out-of-scope",
      message: `${ALICE} is a Viewer on shop: restarting its service takes a Developer or an Admin`,
    });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "restart", result: "rejects", actor: ALICE, slug: "shop", detail: "role viewer" });
    const stranger = await bench.call("POST", "/members/restart", { session, slug: "dashboard" });
    expect(await stranger.json()).toMatchObject({ error: "out-of-scope", message: `${ALICE} holds no role on dashboard` });
    // Can open is no role the dashboard knows.
    const visitor = await bench.call("POST", "/members/restart", { session, slug: "blog" });
    expect(await visitor.json()).toMatchObject({ error: "out-of-scope", message: `${ALICE} holds no role on blog` });
    expect(bench.calls.some((call) => call[0] === "restart")).toBe(false);
  });

  test("a static site has no service to restart", async () => {
    const bench = await mount();
    withAlice(bench);
    const session = await sessionOf(bench);
    const response = await bench.call("POST", "/members/restart", { session, slug: "notes" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "notes is a static site: it has no service to restart" });
  });

  test("a session the steward did not open restarts nothing", async () => {
    const bench = await mount();
    withAlice(bench);
    const response = await bench.call("POST", "/members/restart", { session: "a".repeat(43), slug: "blog" });
    expect(response.status).toBe(401);
  });

  test("taken off while the restart waited its turn, the person restarts nothing", async () => {
    const bench = await mount();
    bench.seed({ [ALICE]: { blog: "developer" }, [BOB]: { shop: "admin" } });
    const alice = await sessionOf(bench);
    const bob = await sessionOf(bench, BOB);
    let release = () => {};
    bench.barrier.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Bob's restart holds the lock; Alice's waits behind it.
    const first = bench.call("POST", "/members/restart", { session: bob, slug: "shop" });
    await Bun.sleep(20);
    const second = bench.call("POST", "/members/restart", { session: alice, slug: "blog" });
    await Bun.sleep(20);
    bench.seed({ [BOB]: { shop: "admin" } });
    bench.barrier.promise = null;
    release();
    expect((await first).status).toBe(200);
    const refused = await second;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ message: `${ALICE} may no longer restart blog` });
    expect(bench.calls.filter((call) => call[0] === "restart")).toEqual([["restart", "shop"]]);
  });
});

describe("the journal", () => {
  test("a line without an actor reads as the owner's", () => {
    const earlier = `${JSON.stringify({ a: 1, operation: "set", result: "ok", slug: "blog", file: "blog.env", variable: "TOKEN", detail: null })}\n`;
    expect(reread(earlier)).toEqual([{ a: 1, operation: "set", result: "ok", actor: "owner", member: null, slug: "blog", file: "blog.env", variable: "TOKEN", detail: null }]);
  });

  test("the sign-ins written before the access registry read back under their old names; a token and the steward itself are actors", () => {
    const line = (operation: string, actor: string) => JSON.stringify({ a: 1, operation, result: "ok", actor, member: null, slug: null, file: null, variable: null, detail: null });
    const lines = [line("member.signin", ALICE), line("access.add", "token:aaaaaaaaaaaa"), line("access.migrate", "system")].join("\n");
    expect(reread(`${lines}\n`).map((entry) => [entry.operation, entry.actor])).toEqual([
      ["member.signin", ALICE],
      ["access.add", "token:aaaaaaaaaaaa"],
      ["access.migrate", "system"],
    ]);
  });
});

describe("the create right, and a person's own tokens", () => {
  test("a Viewer everywhere who may create projects unlocks, to mint a token that creates", async () => {
    const bench = await mount();
    bench.seed({ [ALICE]: { blog: "viewer" } });
    const session = await sessionOf(bench);
    const forced = () => assertion(bench, ALICE, 10, true);
    const refused = await bench.call("POST", "/members/unlock", { session, assertion: await forced() });
    expect(await refused.json()).toMatchObject({ error: "out-of-scope", message: `${ALICE} is a Viewer on every project: there is nothing to unlock` });
    bench.seed({ [ALICE]: { blog: "viewer" } }, [ALICE]);
    expect((await bench.call("POST", "/members/unlock", { session, assertion: await forced() })).status).toBe(200);
  });

  test("taken off every project by root, their sessions close and their tokens go, revoked under the owner", async () => {
    const bench = await mount();
    withAlice(bench);
    const session = await sessionOf(bench);
    expect((await bench.asRoot("DELETE", "/people/person", { email: ALICE })).status).toBe(200);
    expect(bench.revoked).toEqual([[ALICE, "owner"]]);
    expect((await bench.call("POST", "/members/whoami", { session })).status).toBe(401);
  });

  test("their rights as the registry reads now, and a creation recorded: Admin of it, journaled under them", async () => {
    const bench = await mount();
    bench.seed({ [ALICE]: { blog: "developer", shop: "visitor" }, "carol@acme.test": { blog: "visitor" } }, [ALICE]);
    const authority = bench.dashboard.memberAuthority!;
    expect(await authority.rights(ALICE)).toEqual({ email: ALICE, roles: { blog: "developer" }, create: true });
    expect(await authority.rights("eve@acme.test")).toBeNull();
    // Can open alone: no rights on the dashboard.
    expect(await authority.rights("carol@acme.test")).toBeNull();
    expect(await authority.recordCreation("omega", ALICE, "aaaaaaaaaaaa")).toBeNull();
    expect(await authority.rights(ALICE)).toMatchObject({ roles: { blog: "developer", omega: "admin" } });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "project.create", result: "ok", actor: ALICE, member: ALICE, slug: "omega", detail: "admin, created with token aaaaaaaaaaaa" });
    const refused = await authority.recordCreation("omega", "eve@acme.test", "aaaaaaaaaaaa");
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ error: "out-of-scope", message: "eve@acme.test no longer signs in to this dashboard" });
  });
});

/**
 * `leave`, on the members routes alone: the registry in memory, behind the
 * access store's two methods, so that a person may leave while it still
 * names them, which is when only `leave` can be what closed their sessions.
 */
describe("leaving", () => {
  type Alone = {
    routes: MemberRoutes;
    clock: { t: number };
    privateKey: () => PrivateKey;
    call: (path: string, body: unknown) => Promise<Response>;
    revoked: [string, string][];
    journal: (MemberEvent | RestartRefusal)[];
  };

  async function alone(revokeTokens: "records" | "throws" | "absent" = "records"): Promise<Alone> {
    const root = mkdtempSync(join(tmpdir(), "members-leave-"));
    toClean.push(root);
    for (const name of ["state", "sites/blog", "secrets", "portal-key"]) mkdirSync(join(root, name), { recursive: true });
    const clock = { t: Date.now() };
    const revoked: [string, string][] = [];
    const journal: (MemberEvent | RestartRefusal)[] = [];
    const routes = createMemberRoutes({
      system: {
        ...createMembersSystem({
          stateFolder: join(root, "state"),
          sitesDir: join(root, "sites"),
          secretsFolder: join(root, "secrets"),
          portalKeyFolder: join(root, "portal-key"),
          groupsFile: join(root, "group"),
          portalGroup: "",
        }),
        now: () => clock.t,
      },
      access: memoryAccess(registryOf({ [ALICE]: { blog: "developer" }, [BOB]: { blog: "viewer" } })),
      zone: ZONE,
      readBody: async (req, fields) => {
        const body = (await req.json()) as Record<string, unknown>;
        return Object.keys(body).every((key) => fields.includes(key)) ? body : Response.json({ error: "invalid", message: "unexpected field in the request body" }, { status: 400 });
      },
      journal: async (event) => void journal.push(event),
      restart: async () => Response.json({ verdict: { kind: "active" } }),
      ...(revokeTokens === "absent"
        ? {}
        : {
            revokeTokens: async (email: string, actor: string) => {
              if (revokeTokens === "throws") throw Object.assign(new Error("the control routes are down"), { code: "EIO" });
              revoked.push([email, actor]);
              return 2;
            },
          }),
    });
    expect((await routes.ensureKeys()).kind).toBe("ready");
    const privateKey = () => readPrivateKey(readFileSync(join(root, "portal-key", "assertion.key"), "utf8"))!;
    const call = (path: string, body: unknown) => {
      const route = routes.dashboard[path]!;
      return route.POST!(new Request(`http://steward${path}`, { method: "POST", body: JSON.stringify(body) }));
    };
    return { routes, clock, privateKey, call, revoked, journal };
  }

  async function sessionIn(bench: Alone, email: string): Promise<string> {
    const response = await bench.call("/members/signin", { assertion: await assertion(bench, email) });
    expect(response.status).toBe(200);
    return ((await response.json()) as { session: string }).session;
  }

  test("closes every session of theirs at once, while the registry still names them, their unlocks and their tokens with them", async () => {
    const bench = await alone();
    const laptop = await sessionIn(bench, ALICE);
    const phone = await sessionIn(bench, ALICE);
    const bob = await sessionIn(bench, BOB);
    const opened = await bench.call("/members/unlock", { session: laptop, assertion: await assertion(bench, ALICE, 10, true) });
    expect(opened.status).toBe(200);
    const { token } = (await opened.json()) as { token: string };
    expect(await bench.routes.authorize(laptop, token)).toMatchObject({ email: ALICE });

    await bench.routes.leave(ALICE, "admin@acme.test");

    for (const session of [laptop, phone]) {
      expect(await (await bench.call("/members/whoami", { session })).json()).toEqual({ error: "signed-out", message: "this session is closed: sign in again" });
    }
    const unlocked = await bench.routes.authorize(laptop, token);
    expect(unlocked instanceof Response && unlocked.status).toBe(401);
    expect(await bench.routes.unlockedUntil(laptop)).toBeNull();
    expect(bench.revoked).toEqual([[ALICE, "admin@acme.test"]]);
    // Someone else's session is untouched.
    expect((await bench.call("/members/whoami", { session: bob })).status).toBe(200);
    // The registry decides who signs in: still named there, she may sign in again.
    expect((await bench.call("/members/signin", { assertion: await assertion(bench, ALICE) })).status).toBe(200);
  });

  test("a failure to revoke their tokens is said and left: their sessions are closed all the same", async () => {
    const bench = await alone("throws");
    const session = await sessionIn(bench, ALICE);
    await bench.routes.leave(ALICE, "owner");
    expect((await bench.call("/members/whoami", { session })).status).toBe(401);
  });

  test("without the control routes to ask, nothing is revoked and the sessions close", async () => {
    const bench = await alone("absent");
    const session = await sessionIn(bench, ALICE);
    await bench.routes.leave(ALICE, "owner");
    expect((await bench.call("/members/whoami", { session })).status).toBe(401);
    expect(bench.revoked).toEqual([]);
  });
});
