import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SoftAuthenticator } from "../../portal/tests/authenticator";
import { readPasskeyProjection } from "../borrowed/passkeys";
import { OWNER_USER_HANDLE } from "../borrowed/webauthn";
import { LINK_DURATION_MS, type ChallengeResponse, type LinkResponse, type PasskeysResponse, type RegisterResponse } from "../src/passkeys/protocol";
import { VERIFICATIONS_PER_CLIENT } from "../src/passkeys/steward";
import type { LogEntry, UnlockResponse } from "../src/secrets/protocol";
import { DASHBOARD, json, mount, PASSWORD, ZONE, type Bench } from "./passkeys-bench";


function linesOf(bench: Bench, name: string): LogEntry[] {
  const path = join(bench.state, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as LogEntry);
}

/** The journal: sign-ins, unlocks, refusals. */
const journal = (bench: Bench) => linesOf(bench, "journal.jsonl");

/** The access log, kept 180 days: a passkey added or removed, a link minted, as who let whom in. */
const accessLog = (bench: Bench) => linesOf(bench, "access-log.jsonl");

function projected(bench: Bench) {
  const read = readPasskeyProjection(readFileSync(join(bench.portal, "passkeys.json"), "utf8"));
  if ("unreadable" in read) throw new Error(read.unreadable);
  return read;
}

async function passwordUnlock(bench: Bench): Promise<Response> {
  return bench.call("POST", "/unlock", { password: PASSWORD });
}

async function tokenOf(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  return (await json<UnlockResponse>(response)).token;
}

/** A passkey registered through the routes, with the live unlock or root's link. */
async function register(bench: Bench, key: SoftAuthenticator, name: string, auth: { token: string } | { link: string }, origin = DASHBOARD): Promise<Response> {
  const asked = await bench.call("POST", "/passkeys/challenge", { purpose: "register", client: "203.0.113.1", ...auth });
  expect(asked.status).toBe(200);
  const { challengeId, publicKey } = await json<ChallengeResponse>(asked);
  const credential = await key.register({ challenge: publicKey.challenge as string, origin, rpId: ZONE });
  return bench.call("POST", "/passkeys/register", { challengeId, credential, name, client: "203.0.113.1", ...auth });
}

async function assertion(bench: Bench, key: SoftAuthenticator, purpose: "signin" | "unlock", origin = DASHBOARD, flags?: { uv?: boolean }, client = "203.0.113.1") {
  const asked = await bench.call("POST", "/passkeys/challenge", { purpose, client });
  expect(asked.status).toBe(200);
  const { challengeId, publicKey } = await json<ChallengeResponse>(asked);
  const credential = await key.sign({ challenge: publicKey.challenge as string, origin, rpId: ZONE, userHandle: OWNER_USER_HANDLE, ...(flags === undefined ? {} : { flags }) });
  return { body: { challengeId, credential }, challengeId, credential, publicKey };
}

describe("the owner's first passkey", () => {
  test("is registered from the unlocked dashboard, kept by root, and projected for the portal", async () => {
    const bench = await mount();
    expect(projected(bench)).toMatchObject({ rpId: ZONE, credentials: [] });
    expect(await json(await bench.call("POST", "/passkeys/challenge", { purpose: "signin" }))).toMatchObject({ error: "not-found" });

    const token = await tokenOf(await passwordUnlock(bench));
    const asked = await json<ChallengeResponse>(await bench.call("POST", "/passkeys/challenge", { purpose: "register", token }));
    expect(asked.publicKey).toMatchObject({
      rp: { id: ZONE },
      user: { id: OWNER_USER_HANDLE },
      attestation: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: [],
    });

    const key = await SoftAuthenticator.create(-7);
    const registered = await register(bench, key, "Laptop", { token });
    expect(registered.status).toBe(200);
    expect(await json<RegisterResponse>(registered)).toMatchObject({ passkey: { id: key.credentialId, name: "Laptop", lastUsedAt: null }, viaLink: false, count: 1 });

    expect(projected(bench).credentials.map((one) => one.id)).toEqual([key.credentialId]);
    const list = await json<PasskeysResponse>(await bench.call("GET", "/passkeys"));
    expect(list).toEqual({ passkeys: [{ id: key.credentialId, name: "Laptop", createdAt: bench.clock.t, lastUsedAt: null }], readable: true });
    // The page's listing names, never keys.
    expect(JSON.stringify(list)).not.toContain("publicKey");
    expect(accessLog(bench).at(-1)).toMatchObject({ operation: "passkey.add", result: "ok", actor: "owner", detail: "Laptop" });
  });

  test("is not registered while locked, nor from another origin, nor without the user verified", async () => {
    const bench = await mount();
    expect((await bench.call("POST", "/passkeys/challenge", { purpose: "register" })).status).toBe(401);
    expect((await bench.call("POST", "/passkeys/challenge", { purpose: "register", token: "made-up" })).status).toBe(401);
    const token = await tokenOf(await passwordUnlock(bench));
    const key = await SoftAuthenticator.create(-7);
    expect((await register(bench, key, "Laptop", { token }, `https://kanban.${ZONE}`)).status).toBe(401);

    const asked = await json<ChallengeResponse>(await bench.call("POST", "/passkeys/challenge", { purpose: "register", token }));
    const credential = await key.register({ challenge: asked.publicKey.challenge as string, origin: DASHBOARD, rpId: ZONE, flags: { uv: false } });
    expect((await bench.call("POST", "/passkeys/register", { challengeId: asked.challengeId, credential, name: "Laptop", token })).status).toBe(401);
    expect(journal(bench).at(-1)).toMatchObject({ operation: "passkey.add", result: "rejects", detail: "the user was not verified" });
    expect((await json<PasskeysResponse>(await bench.call("GET", "/passkeys"))).passkeys).toEqual([]);
  });
});

describe("once the owner holds a passkey", () => {
  async function withPasskey() {
    const bench = await mount();
    const key = await SoftAuthenticator.create(-7);
    const token = await tokenOf(await passwordUnlock(bench));
    expect((await register(bench, key, "Laptop", { token })).status).toBe(200);
    return { bench, key, token };
  }

  test("the password no longer unlocks, a fresh assertion does", async () => {
    const { bench, key } = await withPasskey();
    const refused = await passwordUnlock(bench);
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ error: "out-of-scope" });

    const { challengeId, credential, publicKey } = await assertion(bench, key, "unlock");
    expect(publicKey).toMatchObject({ userVerification: "required", allowCredentials: [{ id: key.credentialId }] });
    const token = await tokenOf(await bench.call("POST", "/unlock", { challengeId, credential }));
    expect(await bench.handler.isUnlocked(token)).toBe(true);
    expect(journal(bench).at(-1)).toMatchObject({ operation: "unlock", result: "ok", detail: "passkey" });

    // The same challenge twice: refused.
    expect((await bench.call("POST", "/unlock", { challengeId, credential })).status).toBe(401);
    // A sign-in's challenge does not unlock.
    const signIn = await assertion(bench, key, "signin");
    expect((await bench.call("POST", "/unlock", { challengeId: signIn.challengeId, credential: signIn.credential })).status).toBe(401);
    // Without the user verified: refused.
    const touched = await assertion(bench, key, "unlock", DASHBOARD, { uv: false });
    expect((await bench.call("POST", "/unlock", touched.body)).status).toBe(401);
  });

  test("signs in on the dashboard's origin alone: a hosted site's assertion is refused", async () => {
    const { bench, key } = await withPasskey();
    const good = await assertion(bench, key, "signin");
    expect(good.publicKey).toMatchObject({ rpId: ZONE, userVerification: "required", allowCredentials: [] });
    const signedIn = await bench.call("POST", "/passkeys/signin", { ...good.body, client: "203.0.113.1" });
    expect(signedIn.status).toBe(200);
    expect(await json<unknown>(signedIn)).toEqual({ id: key.credentialId, name: "Laptop" });
    expect(journal(bench).at(-1)).toMatchObject({ operation: "passkey.signin", result: "ok", detail: "Laptop" });
    expect((await json<PasskeysResponse>(await bench.call("GET", "/passkeys"))).passkeys[0]!.lastUsedAt).toBe(bench.clock.t);

    const phished = await assertion(bench, key, "signin", `https://kanban.${ZONE}`);
    expect((await bench.call("POST", "/passkeys/signin", phished.body)).status).toBe(401);
    expect(journal(bench).at(-1)).toMatchObject({ operation: "passkey.signin_failed", result: "rejects", detail: "the origin is not this service's" });

    const portal = await assertion(bench, key, "signin", `https://portal.${ZONE}`);
    expect((await bench.call("POST", "/passkeys/signin", portal.body)).status).toBe(401);

    const stranger = await SoftAuthenticator.create(-7);
    const unknown = await assertion(bench, stranger, "signin");
    expect((await bench.call("POST", "/passkeys/signin", unknown.body)).status).toBe(401);
    expect(journal(bench).at(-1)).toMatchObject({ detail: "unknown passkey" });
  });

  test("a cloned key is caught by its counter", async () => {
    const { bench, key } = await withPasskey();
    const first = await assertion(bench, key, "signin");
    expect((await bench.call("POST", "/passkeys/signin", first.body)).status).toBe(200);
    const asked = await json<ChallengeResponse>(await bench.call("POST", "/passkeys/challenge", { purpose: "signin" }));
    const replayed = await key.sign({ challenge: asked.publicKey.challenge as string, origin: DASHBOARD, rpId: ZONE, signCount: 1 });
    expect((await bench.call("POST", "/passkeys/signin", { challengeId: asked.challengeId, credential: replayed })).status).toBe(401);
    expect(journal(bench).at(-1)).toMatchObject({ detail: "the signature counter did not grow" });
  });

  test("verifications are bounded per client: a stranger's flood leaves the owner's address free", async () => {
    const { bench, key } = await withPasskey();
    for (let i = 0; i < VERIFICATIONS_PER_CLIENT; i += 1) {
      expect((await bench.call("POST", "/passkeys/signin", { challengeId: "x", credential: null, client: "198.51.100.9" })).status).toBe(401);
    }
    expect((await bench.call("POST", "/passkeys/signin", { challengeId: "x", credential: null, client: "198.51.100.9" })).status).toBe(429);
    const owner = await assertion(bench, key, "signin", DASHBOARD, undefined, "203.0.113.1");
    expect((await bench.call("POST", "/passkeys/signin", { ...owner.body, client: "203.0.113.1" })).status).toBe(200);
  });

  test("a second passkey is registered from the unlocked dashboard, and either may then be removed but the last", async () => {
    const { bench, key } = await withPasskey();
    const unlock = await assertion(bench, key, "unlock");
    const token = await tokenOf(await bench.call("POST", "/unlock", unlock.body));
    const phone = await SoftAuthenticator.create(-8);
    const second = await register(bench, phone, "Phone", { token });
    expect(await json(second)).toMatchObject({ count: 2 });
    expect(projected(bench).credentials).toHaveLength(2);

    expect((await bench.call("DELETE", "/passkeys/credential", { id: key.credentialId })).status).toBe(401);
    expect((await bench.call("DELETE", "/passkeys/credential", { token: "made-up", id: key.credentialId })).status).toBe(401);
    const removed = await bench.call("DELETE", "/passkeys/credential", { token, id: key.credentialId });
    expect(removed.status).toBe(200);
    expect((await json<PasskeysResponse>(removed)).passkeys.map((one) => one.name)).toEqual(["Phone"]);
    expect(projected(bench).credentials.map((one) => one.id)).toEqual([phone.credentialId]);
    expect(accessLog(bench).at(-1)).toMatchObject({ operation: "passkey.remove", result: "ok", detail: "Laptop" });

    const last = await bench.call("DELETE", "/passkeys/credential", { token, id: phone.credentialId });
    expect(last.status).toBe(403);
    expect(projected(bench).credentials).toHaveLength(1);
  });
});

describe("root's registration link", () => {
  test("registers a passkey once, within fifteen minutes, with no unlock", async () => {
    const bench = await mount();
    // The dashboard's socket mints none.
    expect((await bench.call("POST", "/passkeys/link", {})).status).toBe(404);
    const minted = await json<LinkResponse>(await bench.owner("POST", "/passkeys/link", {}));
    expect(minted.expiresAt).toBe(bench.clock.t + LINK_DURATION_MS);
    expect(accessLog(bench).at(-1)).toMatchObject({ operation: "passkey.link", result: "ok" });
    // Never kept in clear.
    expect(JSON.stringify([...journal(bench), ...accessLog(bench)])).not.toContain(minted.link);

    const key = await SoftAuthenticator.create(-7);
    const registered = await register(bench, key, "Laptop", { link: minted.link });
    expect(registered.status).toBe(200);
    expect(await json(registered)).toMatchObject({ viaLink: true, count: 1 });
    expect(accessLog(bench).at(-1)).toMatchObject({ operation: "passkey.add", detail: "Laptop, with root's registration link" });

    // Spent.
    expect((await bench.call("POST", "/passkeys/challenge", { purpose: "register", link: minted.link })).status).toBe(401);
  });

  test("lapses, and a new one replaces the last", async () => {
    const bench = await mount();
    const first = await json<LinkResponse>(await bench.owner("POST", "/passkeys/link", {}));
    const second = await json<LinkResponse>(await bench.owner("POST", "/passkeys/link", {}));
    expect((await bench.call("POST", "/passkeys/challenge", { purpose: "register", link: first.link })).status).toBe(401);
    expect((await bench.call("POST", "/passkeys/challenge", { purpose: "register", link: second.link })).status).toBe(200);
    bench.clock.t += LINK_DURATION_MS;
    expect((await bench.call("POST", "/passkeys/challenge", { purpose: "register", link: second.link })).status).toBe(401);
  });

  test("a challenge asked for under a link registers with that link alone", async () => {
    const bench = await mount();
    const minted = await json<LinkResponse>(await bench.owner("POST", "/passkeys/link", {}));
    const token = await tokenOf(await passwordUnlock(bench));
    const asked = await json<ChallengeResponse>(await bench.call("POST", "/passkeys/challenge", { purpose: "register", link: minted.link }));
    const key = await SoftAuthenticator.create(-7);
    const credential = await key.register({ challenge: asked.publicKey.challenge as string, origin: DASHBOARD, rpId: ZONE });
    expect((await bench.call("POST", "/passkeys/register", { challengeId: asked.challengeId, credential, name: "Laptop", token })).status).toBe(401);
  });

  test("root lists and removes any passkey, the last included, and the password unlocks again", async () => {
    const bench = await mount();
    const minted = await json<LinkResponse>(await bench.owner("POST", "/passkeys/link", {}));
    const key = await SoftAuthenticator.create(-7);
    expect((await register(bench, key, "Laptop", { link: minted.link })).status).toBe(200);
    expect((await passwordUnlock(bench)).status).toBe(403);
    expect((await json<PasskeysResponse>(await bench.owner("GET", "/passkeys"))).passkeys).toHaveLength(1);
    const removed = await bench.owner("DELETE", "/passkeys/credential", { id: key.credentialId });
    expect(removed.status).toBe(200);
    expect(accessLog(bench).at(-1)).toMatchObject({ operation: "passkey.remove", detail: "Laptop, over SSH" });
    expect(projected(bench).credentials).toEqual([]);
    expect((await passwordUnlock(bench)).status).toBe(200);
  });
});

test("a registry that cannot be read counts as passkeys: the password does not unlock, nothing signs in", async () => {
  const bench = await mount();
  writeFileSync(join(bench.state, "passkeys.json"), "{ not json");
  expect((await passwordUnlock(bench)).status).toBe(403);
  expect(await json<unknown>(await bench.call("GET", "/passkeys"))).toEqual({ passkeys: [], readable: false });
  expect((await bench.call("POST", "/passkeys/challenge", { purpose: "signin" })).status).toBe(500);
});
