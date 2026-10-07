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
import { fromJournal } from "../src/audit/normalize";
import { MAX_AUTH_AGE_S, MEMBER_SESSION_DURATION_MS } from "../src/members/protocol";
import { createMembersSystem, type MembersSystem } from "../src/members/system";
import { reread } from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";
import { createSteward, type StewardHandler } from "../src/secrets/steward";
import { createSystem, type Command, type System } from "../src/secrets/system";

/**
 * Every decision the steward takes for the members, as root would take it: on
 * a throwaway tree, with the real files, the real key pair and the real
 * journal, `systemctl` alone simulated.
 *
 * A member session opens only on an assertion the portal signed with the key
 * this steward laid, for the dashboard, unexpired, never seen, for a member of
 * the registry; a member's write is judged against the registry as it reads
 * at that moment; the journal names who the steward verified.
 */

const PASSWORD = "Owner-Password-For-The-Tests-1";
const ZONE = "test-zone.invalid";
const ALICE = "alice@acme.test";

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
  const make = () =>
    createSteward(system, { secretsFolder: secrets, checkAccounts: false, members: { system: members, zone: ZONE } });
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
  };
}

async function unlock(bench: Bench): Promise<string> {
  const response = await bench.call("POST", "/unlock", { password: PASSWORD });
  return ((await response.json()) as { token: string }).token;
}

/** What the portal hands the dashboard for this person, signed with the key the steward laid. */
function assertion(bench: Bench, email = ALICE, authAgeS = 60): Promise<string> {
  const nowS = Math.floor(bench.clock.t / 1000);
  return signAssertion(bench.privateKey(), { email, name: "Alice Martin", authTime: nowS - authAgeS }, nowS);
}

async function signIn(bench: Bench, token: string): Promise<Response> {
  return bench.call("POST", "/members/signin", { assertion: token });
}

async function sessionOf(bench: Bench, email = ALICE): Promise<string> {
  const response = await signIn(bench, await assertion(bench, email));
  expect(response.status).toBe(200);
  return ((await response.json()) as { session: string }).session;
}

/** Alice, developer on blog and viewer on shop, invited by root over the owner's SSH. */
async function withAlice(bench: Bench): Promise<void> {
  const response = await bench.asRoot("PUT", "/members/member", { email: ALICE, roles: { blog: "developer", shop: "viewer", notes: "developer" } });
  expect(response.status).toBe(201);
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

  test("not laid without the portal's folder: members cannot sign in, and are told why", async () => {
    const bench = await mount();
    rmSync(join(bench.root, "portal-key"), { recursive: true });
    rmSync(join(bench.root, "state", "assertion.pub"));
    const key = await bench.call("GET", "/members/key");
    expect(key.status).toBe(503);
    expect(await key.json()).toMatchObject({ error: "not-ready", message: expect.stringContaining("/etc/sitesolide-portal") });
  });
});

describe("inviting, changing, removing", () => {
  test("from the dashboard, only unlocked; the journal says the owner did it, and whom", async () => {
    const bench = await mount();
    const roles = { blog: "developer" };
    expect((await bench.call("PUT", "/members/member", { email: ALICE, roles })).status).toBe(401);
    expect((await bench.call("PUT", "/members/member", { token: "not-the-token", email: ALICE, roles })).status).toBe(401);
    const token = await unlock(bench);
    const invited = await bench.call("PUT", "/members/member", { token, email: ALICE, roles });
    expect(invited.status).toBe(201);
    expect(await invited.json()).toMatchObject({ change: "invite", member: { email: ALICE, roles, invitedBy: "owner" } });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "member.invite", actor: "owner", member: ALICE, detail: "blog: developer" });

    const changed = await bench.call("PUT", "/members/member", { token, email: ALICE, roles: { blog: "viewer" } });
    expect(await changed.json()).toMatchObject({ change: "role" });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "member.role", detail: "blog: viewer" });

    // Removing needs no unlock: closing someone out never waits for the password.
    const removed = await bench.call("DELETE", "/members/member", { email: ALICE });
    expect(removed.status).toBe(200);
    expect(bench.journal().at(-1)).toMatchObject({ operation: "member.remove", actor: "owner", member: ALICE });
    expect((await bench.call("DELETE", "/members/member", { email: ALICE })).status).toBe(404);
  });

  test("refuses an address the portal would turn away, a platform project, a project not deployed, a role of no name", async () => {
    const bench = await mount();
    const refusal = async (body: unknown) => {
      const response = await bench.asRoot("PUT", "/members/member", body);
      expect(response.status).toBe(400);
      return ((await response.json()) as { message: string }).message;
    };
    expect(await refusal({ email: "eve@elsewhere.test", roles: { blog: "viewer" } })).toContain("admits only acme.test");
    expect(await refusal({ email: ALICE, roles: { dashboard: "admin" } })).toContain("platform");
    expect(await refusal({ email: ALICE, roles: { gone: "viewer" } })).toContain("not deployed");
    expect(await refusal({ email: ALICE, roles: { blog: "superuser" } })).toContain("viewer, developer or admin");
    expect((await (await bench.asRoot("GET", "/members")).json()) as unknown).toMatchObject({ members: [], signIn: { configured: true, allowedDomains: ["acme.test"] } });
  });

  test("the owner's socket carries the registry and nothing else", async () => {
    const bench = await mount();
    await withAlice(bench);
    expect((await bench.asRoot("GET", "/members")).status).toBe(200);
    for (const path of ["/members/signin", "/members/restart", "/members/whoami", "/projects", "/unlock"]) {
      expect((await bench.asRoot("POST", path, {})).status).toBe(404);
    }
    // And a token in the body of root's request is refused as a field it does not take.
    expect((await bench.asRoot("PUT", "/members/member", { token: "x", email: ALICE, roles: {} })).status).toBe(400);
  });
});

describe("signing in", () => {
  test("an assertion the portal signed opens a session for a member, once; the journal names them", async () => {
    const bench = await mount();
    await withAlice(bench);
    const token = await assertion(bench);
    const response = await signIn(bench, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: string; expiresAt: number; identity: unknown };
    expect(body.expiresAt).toBe(bench.clock.t + MEMBER_SESSION_DURATION_MS);
    expect(body.identity).toEqual({ kind: "member", email: ALICE, name: "Alice Martin", roles: { blog: "developer", shop: "viewer", notes: "developer" } });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "member.signin", result: "ok", actor: ALICE, member: ALICE });
    // The session's token is nowhere in the steward's files: only its hash.
    expect(readFileSync(join(bench.root, "state", "member-sessions.json"), "utf8")).not.toContain(body.session);

    const replayed = await signIn(bench, token);
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ error: "invalid-assertion" });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "member.signin_failed", actor: ALICE, detail: "replayed-assertion" });
  });

  test("replayed after the steward restarted, still refused", async () => {
    const bench = await mount();
    await withAlice(bench);
    const token = await assertion(bench);
    expect((await signIn(bench, token)).status).toBe(200);
    bench.restartSteward();
    expect((await signIn(bench, token)).status).toBe(401);
  });

  test("signed by another key, for another audience, expired, about a sign-in too old: refused", async () => {
    const bench = await mount();
    await withAlice(bench);
    const nowS = Math.floor(bench.clock.t / 1000);

    const stranger = await generateKeyPair();
    const forged = await signAssertion(stranger.privateKey, { email: ALICE, name: null, authTime: nowS }, nowS);
    expect(await (await signIn(bench, forged)).json()).toMatchObject({ error: "invalid-assertion", message: expect.stringContaining("unknown-key") });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "member.signin_failed", actor: "anonymous", member: null, detail: "unknown-key" });

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
    await withAlice(bench);
    const response = await signIn(bench, await assertion(bench, "bob@acme.test"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "not-a-member", message: expect.stringContaining("bob@acme.test is not a member") });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "member.signin_failed", actor: "bob@acme.test", detail: "not-a-member" });
  });

  test("a flood of forged assertions fills a minute's share of the journal, never more", async () => {
    const bench = await mount();
    const before = bench.journal().length;
    for (let i = 0; i < 30; i++) await signIn(bench, "not.an.assertion");
    expect(bench.journal().length - before).toBe(20);
  });
});

describe("a member's session", () => {
  test("says who it is and their roles as the registry reads now, survives a restart of the steward, and closes on sign-out", async () => {
    const bench = await mount();
    await withAlice(bench);
    const session = await sessionOf(bench);
    const whoami = async () => bench.call("POST", "/members/whoami", { session });
    expect(await (await whoami()).json()).toMatchObject({ identity: { email: ALICE, roles: { blog: "developer" } } });

    await bench.asRoot("PUT", "/members/member", { email: ALICE, roles: { blog: "viewer" } });
    expect(await (await whoami()).json()).toMatchObject({ identity: { roles: { blog: "viewer" } } });

    bench.restartSteward();
    expect((await whoami()).status).toBe(200);

    expect((await bench.call("POST", "/members/signout", { session })).status).toBe(204);
    expect(bench.journal().at(-1)).toMatchObject({ operation: "member.signout", actor: ALICE });
    expect((await whoami()).status).toBe(401);
    // Signing out what is already closed is not a fault.
    expect((await bench.call("POST", "/members/signout", { session })).status).toBe(204);
  });

  test("lapses after half a day", async () => {
    const bench = await mount();
    await withAlice(bench);
    const session = await sessionOf(bench);
    bench.clock.t += MEMBER_SESSION_DURATION_MS;
    expect((await bench.call("POST", "/members/whoami", { session })).status).toBe(401);
  });

  test("falls with its member: removed, they are out at the next request", async () => {
    const bench = await mount();
    await withAlice(bench);
    const session = await sessionOf(bench);
    await bench.asRoot("DELETE", "/members/member", { email: ALICE });
    const whoami = await bench.call("POST", "/members/whoami", { session });
    expect(whoami.status).toBe(401);
    const restart = await bench.call("POST", "/members/restart", { session, slug: "blog" });
    expect(restart.status).toBe(401);
    expect(await restart.json()).toMatchObject({ error: "signed-out" });
    expect(bench.calls.some((call) => call[0] === "restart")).toBe(false);
  });
});

describe("a member's restart", () => {
  test("a developer restarts their project's service; the journal names them", async () => {
    const bench = await mount();
    await withAlice(bench);
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

  test("a viewer is refused, and so is anyone on a project they hold no role on: nothing restarts", async () => {
    const bench = await mount();
    await withAlice(bench);
    const session = await sessionOf(bench);
    const viewer = await bench.call("POST", "/members/restart", { session, slug: "shop" });
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toEqual({
      error: "out-of-scope",
      message: `${ALICE} is a viewer on shop: restarting its service takes a developer or a project admin`,
    });
    expect(bench.journal().at(-1)).toMatchObject({ operation: "restart", result: "rejects", actor: ALICE, slug: "shop", detail: "role viewer" });
    const stranger = await bench.call("POST", "/members/restart", { session, slug: "dashboard" });
    expect(await stranger.json()).toMatchObject({ error: "out-of-scope", message: `${ALICE} holds no role on dashboard` });
    expect(bench.calls.some((call) => call[0] === "restart")).toBe(false);
  });

  test("a static site has no service to restart", async () => {
    const bench = await mount();
    await withAlice(bench);
    const session = await sessionOf(bench);
    const response = await bench.call("POST", "/members/restart", { session, slug: "notes" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "notes is a static site: it has no service to restart" });
  });

  test("a session the steward did not open restarts nothing", async () => {
    const bench = await mount();
    await withAlice(bench);
    const response = await bench.call("POST", "/members/restart", { session: "a".repeat(43), slug: "blog" });
    expect(response.status).toBe(401);
  });

  test("removed while the restart waited its turn, the member restarts nothing", async () => {
    const bench = await mount();
    await withAlice(bench);
    await bench.asRoot("PUT", "/members/member", { email: "bob@acme.test", roles: { shop: "admin" } });
    const alice = await sessionOf(bench);
    const bob = await sessionOf(bench, "bob@acme.test");
    let release = () => {};
    bench.barrier.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Bob's restart holds the lock; Alice's waits behind it.
    const first = bench.call("POST", "/members/restart", { session: bob, slug: "shop" });
    await Bun.sleep(20);
    const second = bench.call("POST", "/members/restart", { session: alice, slug: "blog" });
    await Bun.sleep(20);
    await bench.asRoot("DELETE", "/members/member", { email: ALICE });
    bench.barrier.promise = null;
    release();
    expect((await first).status).toBe(200);
    const refused = await second;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ message: `${ALICE} may no longer restart blog` });
    expect(bench.calls.filter((call) => call[0] === "restart")).toEqual([["restart", "shop"]]);
  });
});

describe("the journal from before members", () => {
  test("a line without an actor reads as the owner's", () => {
    const earlier = `${JSON.stringify({ a: 1, operation: "set", result: "ok", slug: "blog", file: "blog.env", variable: "TOKEN", detail: null })}\n`;
    expect(reread(earlier)).toEqual([{ a: 1, operation: "set", result: "ok", actor: "owner", member: null, slug: "blog", file: "blog.env", variable: "TOKEN", detail: null }]);
  });
});
