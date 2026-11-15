import { describe, expect, test } from "bun:test";
import { SoftAuthenticator } from "../../portal/tests/authenticator";
import type { PasskeyStewardClient } from "../src/passkeys/client";
import type { LinkResponse } from "../src/passkeys/protocol";
import { createPasskeyRoutes } from "../src/passkeys/routes";
import { createPasskeyState } from "../src/passkeys/state";
import { createRoutes, createSessionReader, ownerSessionOpener, ownerSessions, type Store } from "../src/routes";
import type { Steward } from "../src/secrets/client";
import { createSecretsRoutes } from "../src/secrets/routes";
import { createTokens } from "../src/secrets/tokens";
import { generateToken, tokenHash, type Session } from "../src/sessions";
import { DASHBOARD, json, mount, PASSWORD, ZONE } from "./passkeys-bench";

const WEEK = 7 * 24 * 3600 * 1000;
const FROM = "203.0.113.5";

function createStore(): Store & { sessions: Map<string, Session> } {
  const sessions = new Map<string, Session>();
  return {
    sessions,
    async openSession(now) {
      const token = generateToken();
      const hash = await tokenHash(token);
      sessions.set(hash, { hash, createdAt: now, seenAt: now, identity: "owner" });
      return token;
    },
    async readSession(token) {
      return sessions.get(await tokenHash(token)) ?? null;
    },
    touchSession() {},
    closeSession(hash) {
      sessions.delete(hash);
    },
    purgeSessions() {},
  };
}

/** The dashboard's process wired like server.ts, its steward the real one on a throwaway tree. */
async function dashboard() {
  const bench = await mount();
  const clock = () => bench.clock.t;
  const store = createStore();
  const client: PasskeyStewardClient = {
    list: () => bench.call("GET", "/passkeys"),
    challenge: (requested) => bench.call("POST", "/passkeys/challenge", requested),
    signIn: (requested) => bench.call("POST", "/passkeys/signin", requested),
    register: (requested) => bench.call("POST", "/passkeys/register", requested),
    remove: (requested) => bench.call("DELETE", "/passkeys/credential", requested),
  };
  let remembered: boolean | null = null;
  const state = createPasskeyState({ steward: client, passwordConfigured: true, readRemembered: () => remembered, remember: (value) => (remembered = value), clock });
  const options = { online: true, sessionDurationMs: WEEK };
  const owner = ownerSessions(createSessionReader(store, options));
  const tokens = createTokens(clock);
  const passkeys = createPasskeyRoutes(
    {
      publicUrl: DASHBOARD,
      steward: client,
      session: owner,
      tokens,
      openOwnerSession: ownerSessionOpener(store, options),
      closeOtherOwnerSessions: (kept) => {
        for (const hash of [...store.sessions.keys()]) if (hash !== kept) store.sessions.delete(hash);
      },
      state,
    },
    clock,
  );
  const secrets = createSecretsRoutes({ session: owner, publicUrl: DASHBOARD, steward: { unlock: (requested) => bench.call("POST", "/unlock", requested) } as Steward, tokens }, clock);
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  const routes = createRoutes(store, { ...options, hash, publicUrl: DASHBOARD, stateFile: "/nonexistent/state.json", passwordSignIn: state.passwordSignIn }, clock);
  return { bench, store, passkeys, secrets, routes, state, tokens, remembered: () => remembered };
}

function post(path: string, body: unknown, cookie: string | null = null, origin = DASHBOARD, method = "POST"): Request {
  return new Request(`${DASHBOARD}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, "X-Forwarded-For": FROM, ...(cookie === null ? {} : { Cookie: cookie }) },
    body: JSON.stringify(body),
  });
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  expect(header).toContain("__Host-session=");
  return header.slice(0, header.indexOf(";"));
}

async function asked(response: Response): Promise<{ challengeId: string; challenge: string }> {
  expect(response.status).toBe(200);
  const body = await json<{ challengeId: string; publicKey: { challenge: string } }>(response);
  return { challengeId: body.challengeId, challenge: body.publicKey.challenge };
}

/** The first passkey, registered with root's link: what the dashboard's page does with `#passkey=`. */
async function firstPasskey(d: Awaited<ReturnType<typeof dashboard>>, key: SoftAuthenticator): Promise<string> {
  const { link } = await json<LinkResponse>(await d.bench.owner("POST", "/passkeys/link", {}));
  const { challengeId, challenge } = await asked(await d.passkeys.challenge(post("/api/passkeys/challenge", { purpose: "register", link })));
  const credential = await key.register({ challenge, origin: DASHBOARD, rpId: ZONE });
  const registered = await d.passkeys.register(post("/api/passkeys/register", { challengeId, credential, name: "Laptop", link }));
  expect(registered.status).toBe(200);
  expect(await json(registered.clone() as Response)).toMatchObject({ viaLink: true, count: 1 });
  return cookieOf(registered);
}

describe("signing in to the dashboard with a passkey", () => {
  test("root's link registers the first passkey and signs the owner in; the password then signs nobody in", async () => {
    const d = await dashboard();
    expect(await d.state.offer()).toEqual({ registered: false, passwordSignIn: true });
    const key = await SoftAuthenticator.create(-7);
    const cookie = await firstPasskey(d, key);
    expect(d.store.sessions.size).toBe(1);
    expect((await d.passkeys.list(new Request(`${DASHBOARD}/api/passkeys`, { headers: { Cookie: cookie } }))).status).toBe(200);

    expect(await d.state.offer()).toEqual({ registered: true, passwordSignIn: false });
    expect(d.remembered()).toBe(true);
    const password = await d.routes.signIn(post("/api/signin", { password: PASSWORD }));
    expect(password.status).toBe(403);
  });

  test("a passkey's assertion opens the owner's session, and nothing else does", async () => {
    const d = await dashboard();
    const key = await SoftAuthenticator.create(-7);
    await firstPasskey(d, key);
    d.store.sessions.clear();

    expect((await d.passkeys.challenge(post("/api/passkeys/challenge", { purpose: "signin" }, null, `https://kanban.${ZONE}`))).status).toBe(403);
    const { challengeId, challenge } = await asked(await d.passkeys.challenge(post("/api/passkeys/challenge", { purpose: "signin" })));
    const credential = await key.sign({ challenge, origin: DASHBOARD, rpId: ZONE });
    const signedIn = await d.passkeys.signIn(post("/api/passkeys/signin", { challengeId, credential }));
    expect(signedIn.status).toBe(200);
    cookieOf(signedIn);
    expect(d.store.sessions.size).toBe(1);

    // Signed by a hosted site's page: the steward refuses, no session opens.
    const again = await asked(await d.passkeys.challenge(post("/api/passkeys/challenge", { purpose: "signin" })));
    const phished = await key.sign({ challenge: again.challenge, origin: `https://kanban.${ZONE}`, rpId: ZONE });
    const refused = await d.passkeys.signIn(post("/api/passkeys/signin", { challengeId: again.challengeId, credential: phished }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(d.store.sessions.size).toBe(1);
  });

  test("an unlock is a fresh assertion; a second passkey needs it, and removing one signs out the other sessions", async () => {
    const d = await dashboard();
    const key = await SoftAuthenticator.create(-7);
    const cookie = await firstPasskey(d, key);
    const elsewhere = await d.store.openSession(d.bench.clock.t);
    expect(d.store.sessions.size).toBe(2);

    // Locked: no registration.
    expect((await d.passkeys.challenge(post("/api/passkeys/challenge", { purpose: "register" }, cookie))).status).toBe(423);
    // An unlock's challenge is the owner's session's.
    expect((await d.passkeys.challenge(post("/api/passkeys/challenge", { purpose: "unlock" }))).status).toBe(401);
    // The password does not unlock.
    expect((await d.secrets.unlock(post("/api/secrets/unlock", { password: PASSWORD }, cookie))).status).toBe(403);

    const unlock = await asked(await d.passkeys.challenge(post("/api/passkeys/challenge", { purpose: "unlock" }, cookie)));
    const assertion = await key.sign({ challenge: unlock.challenge, origin: DASHBOARD, rpId: ZONE });
    const unlocked = await d.secrets.unlock(post("/api/secrets/unlock", { challengeId: unlock.challengeId, credential: assertion }, cookie));
    expect(unlocked.status).toBe(200);
    // The steward's token stays in this process.
    expect(JSON.stringify(await json(unlocked))).not.toContain("token");

    const phone = await SoftAuthenticator.create(-8);
    const register = await asked(await d.passkeys.challenge(post("/api/passkeys/challenge", { purpose: "register" }, cookie)));
    const credential = await phone.register({ challenge: register.challenge, origin: DASHBOARD, rpId: ZONE });
    const added = await d.passkeys.register(post("/api/passkeys/register", { challengeId: register.challengeId, credential, name: "Phone" }, cookie));
    expect(added.status).toBe(200);
    expect(added.headers.get("set-cookie")).toBeNull();

    const removed = await d.passkeys.remove(post("/api/passkeys/credential", { id: key.credentialId }, cookie, DASHBOARD, "DELETE"));
    expect(removed.status).toBe(200);
    expect(d.store.sessions.size).toBe(1);
    expect(d.store.sessions.has(await tokenHash(elsewhere))).toBe(false);
  });

  test("a steward that does not answer keeps the last answer: the password stays refused", async () => {
    let up = true;
    let remembered: boolean | null = null;
    const state = createPasskeyState({
      steward: { list: async () => (up ? Response.json({ passkeys: [{ id: "x" }], readable: true }) : Promise.reject(new Error("down"))) },
      passwordConfigured: true,
      readRemembered: () => remembered,
      remember: (value) => (remembered = value),
      clock: () => 0,
    });
    expect(await state.passwordSignIn()).toBe(false);
    up = false;
    state.changed();
    expect(await state.passwordSignIn()).toBe(false);
    remembered = null;
    expect(await state.passwordSignIn()).toBe(true);
  });
});

