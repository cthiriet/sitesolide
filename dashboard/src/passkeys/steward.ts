/**
 * The owner's passkeys, on the steward's two sockets: the registry, every
 * ceremony of the dashboard verified here, the projection laid for the
 * portal, and root's one-time registration link.
 *
 * **Why here and not in the dashboard.** The dashboard's process is the one
 * the Internet reaches. Were it to verify the owner's assertions, whoever
 * took it over could also write a key of their own into the registry and
 * unlock the secrets with it. Here, the registry is root's file, an unlock
 * token is drawn only after this code verified a fresh assertion, and the
 * dashboard relays a ceremony it cannot forge. A public key needs integrity,
 * not secrecy, and root's file gives it that.
 *
 * **One origin.** An assertion counts only if the browser says it ran on
 * `https://dashboard.<zone>`: clientDataJSON carries the origin of the page
 * that asked, and the authenticator signs its hash. A site hosted under the
 * zone, compromised, can get the owner's browser to prompt for a passkey of
 * the zone, the relying party, but what it gets back names its own origin,
 * and is refused here and at the portal, which accepts its own origin alone
 * (portal/src/passkey-signin.ts).
 *
 * **The relying party is the zone**, so that one passkey signs in to the
 * dashboard and to every protected site through the portal. A relying party
 * of `dashboard.<zone>` alone would hold a hosted site off the prompt
 * entirely, at the price of a second passkey for the portal; the strict
 * origin above already makes what such a prompt yields worthless, so the
 * owner keeps one passkey per device.
 *
 * **The user is verified**, every time: sign-in, unlock and registration
 * alike refuse an authenticator that only saw a touch.
 *
 * **The way in without a passkey** is root's link, minted over the owner's
 * SSH (`sitesolide passkey link`): fifteen minutes, once, the last one
 * minted replacing any before it, kept here by its hash alone. Once a
 * passkey exists, the dashboard's password neither signs in nor unlocks:
 * the link is the recovery, and the last passkey is removed by root alone.
 *
 * **Bounded per client**: challenges and verifications per minute for each
 * address the dashboard read from Caddy, a far higher ceiling for everyone
 * together, and the failures journaled thirty a minute at most. A stranger's
 * flood never keeps the owner out.
 */
import { MAX_PASSKEYS } from "../../borrowed/passkeys";
import {
  ALGORITHMS,
  b64url,
  CHALLENGE_MS,
  Challenges,
  fromB64url,
  OWNER_USER_HANDLE,
  RateLimit,
  readPostedAssertion,
  readPostedRegistration,
  Refused,
  verifyAssertion,
  verifyRegistration,
} from "../../borrowed/webauthn";
import type { Operation } from "../secrets/protocol";
import type { Body, Routes } from "../secrets/requests";
import { tokenHash } from "../sessions";
import type { LinkResponse, PasskeysResponse, Purpose, RegisterResponse, SignInResponse } from "./protocol";
import { LINK_DURATION_MS } from "./protocol";
import {
  addRefusal,
  cleanName,
  encodeRegistry,
  listView,
  projectionText,
  readRegistry,
  used,
  withoutPasskey,
  withPasskey,
  type Registry,
  type StoredPasskey,
} from "./registry";
import type { PasskeySystem } from "./system";

export type PasskeyEvent = { operation: Operation; result: "ok" | "rejects"; detail: string | null };

export type PasskeyStewardOptions = {
  system: PasskeySystem;
  /** The served zone: the relying party, and the dashboard's origin under it. */
  zone: string;
  /** The one origin the dashboard's ceremonies may run on. Absent: `https://dashboard.<zone>`. */
  origin?: string;
  readBody: (req: Request, fields: string[]) => Promise<Body | Response>;
  /** Is this the owner's live unlock token? */
  isUnlocked: (token: unknown) => Promise<boolean>;
  /** Into the steward's journal, under the owner: the only one who has passkeys. */
  journal: (event: PasskeyEvent) => Promise<void>;
  /** The link's secret, drawn: the system's random source otherwise. */
  drawLink?: () => string;
};

/** What a verified unlock assertion leaves: the steward then draws its token. */
export type UnlockCheck = { ok: true } | { ok: false; response: Response };

export type PasskeySteward = {
  /** The routes of the dashboard's socket. */
  dashboard: Routes;
  /** The routes of the owner's socket, root's. */
  owner: Routes;
  /** The registry read, the portal's projection written again: at startup. */
  start: () => Promise<void>;
  /** How many passkeys the owner holds; `unreadable` counts as some, never as none. */
  count: () => Promise<number | "unreadable">;
  /**
   * A posted unlock assertion, verified: the challenge, the passkey, the
   * user. `operation`: what a refusal is journaled as, the unlock itself or
   * what the assertion confirms, a password change.
   */
  unlock: (body: Body, operation?: Operation) => Promise<UnlockCheck>;
};

/** Per client and per minute. */
export const CHALLENGES_PER_CLIENT = 20;
export const VERIFICATIONS_PER_CLIENT = 10;
/** Everyone together, per minute: the work bounded, out of one stranger's reach. */
export const CHALLENGES_PER_MINUTE = 600;
export const VERIFICATIONS_PER_MINUTE = 300;
/** In flight at once: enough that a flood within the bounds above does not evict the owner's. */
const CHALLENGES_IN_FLIGHT = 1_000;
/** Failures journaled per minute at most: the journal is not the flood's. */
const FAILURES_PER_MINUTE = 30;

const STATUSES = { refused: 401, locked: 401, invalid: 400, "not-found": 404, "out-of-scope": 403, "too-many-attempts": 429, failure: 500 } as const;
type Code = keyof typeof STATUSES;

function error(code: Code, message: string, wait?: number): Response {
  return Response.json(wait === undefined ? { error: code, message } : { error: code, message, wait }, { status: STATUSES[code] });
}

/** What the owner reads for every refused ceremony: the reason goes to the journal. */
const REFUSED = "This passkey can't be used here. Try again, or use a passkey registered on this server.";

const clientOf = (body: Body): string => (typeof body.client === "string" && body.client.length > 0 && body.client.length <= 64 ? body.client : "unknown");

export function createPasskeySteward(options: PasskeyStewardOptions): PasskeySteward {
  const { system } = options;
  const rpId = options.zone;
  const origin = options.origin ?? (options.zone === "" ? "" : `https://dashboard.${options.zone}`);
  const offered = rpId !== "" && origin !== "";
  const drawLink = options.drawLink ?? (() => b64url(crypto.getRandomValues(new Uint8Array(32))));

  const challenges = new Challenges(CHALLENGES_IN_FLIGHT);
  const challengeRate = new RateLimit(CHALLENGES_PER_CLIENT, CHALLENGES_PER_MINUTE);
  const verifyRate = new RateLimit(VERIFICATIONS_PER_CLIENT, VERIFICATIONS_PER_MINUTE);
  let link: { hash: string; expiresAt: number } | null = null;
  let failures = { minute: -1, count: 0 };

  // One write at a time: a sign-in's counter and a registration never
  // overwrite each other's registry.
  let turn: Promise<unknown> = Promise.resolve();
  function serially<T>(work: () => Promise<T>): Promise<T> {
    const next = turn.then(work, work);
    turn = next.catch(() => undefined);
    return next;
  }

  async function load(): Promise<Registry | "unreadable"> {
    const text = await system.readRegistry();
    return text === "unreadable" ? "unreadable" : readRegistry(text);
  }

  /** The registry written, then the projection: the portal follows within a second. */
  async function save(registry: Registry): Promise<void> {
    await system.writeRegistry(encodeRegistry(registry));
    await publish(registry);
  }

  async function publish(registry: Registry): Promise<void> {
    try {
      const written = await system.writeProjection(projectionText(registry, rpId, system.now()));
      if (written !== "written") console.error(`passkeys: projection for the portal not written (${written})`);
    } catch (e) {
      console.error(`passkeys: projection for the portal not written (${(e as Error).name})`);
    }
  }

  async function refusal(operation: Operation, detail: string): Promise<void> {
    const minute = Math.floor(system.now() / 60_000);
    failures = failures.minute === minute ? { minute, count: failures.count + 1 } : { minute, count: 1 };
    if (failures.count <= FAILURES_PER_MINUTE) await options.journal({ operation, result: "rejects", detail });
  }

  function tooMany(wait: number): Response {
    return error("too-many-attempts", `too many attempts, try again in ${wait} s`, wait);
  }

  async function liveLink(submitted: unknown, now: number): Promise<string | null> {
    if (link === null || typeof submitted !== "string" || submitted.length === 0 || submitted.length > 128) return null;
    if (now >= link.expiresAt) {
      link = null;
      return null;
    }
    return (await tokenHash(submitted)) === link.hash ? link.hash : null;
  }

  /** What a registration is bound to: root's live link, or the owner's live unlock. */
  async function registrationBound(body: Body, now: number): Promise<string | Response> {
    if (body.link !== undefined) {
      const hash = await liveLink(body.link, now);
      return hash === null ? error("refused", "this registration link has expired or was already used: ask for another with `sitesolide passkey link`") : `link:${hash}`;
    }
    return (await options.isUnlocked(body.token)) ? "unlock" : error("locked", "locked, unlock again");
  }

  function assertionOptions(challenge: string, allow: StoredPasskey[]): Record<string, unknown> {
    return {
      challenge,
      rpId,
      timeout: CHALLENGE_MS,
      userVerification: "required",
      allowCredentials: allow.map((one) => ({ type: "public-key", id: one.id, ...(one.transports.length > 0 ? { transports: one.transports } : {}) })),
    };
  }

  /** The assertion verified against the registry, its counter kept, or why not. */
  async function verified(purpose: Purpose, body: Body): Promise<{ passkey: StoredPasskey } | { reason: string }> {
    const now = system.now();
    const challenge = challenges.take(body.challengeId, purpose, now);
    if (challenge === null) return { reason: "no such challenge, or expired" };
    const posted = readPostedAssertion(body.credential);
    if (posted === null) return { reason: "malformed assertion" };
    return serially(async () => {
      const registry = await load();
      if (registry === "unreadable") return { reason: "the registry is unreadable" };
      const stored = registry.credentials.find((one) => one.id === posted.id);
      if (stored === undefined) return { reason: "unknown passkey" };
      const publicKey = fromB64url(stored.publicKey);
      if (publicKey === null) return { reason: "unknown passkey" };
      let signCount: number;
      try {
        ({ signCount } = await verifyAssertion(posted, { challenge, origin, rpId }, { publicKey, signCount: stored.signCount }));
      } catch (e) {
        if (e instanceof Refused) return { reason: e.message };
        throw e;
      }
      try {
        await system.writeRegistry(encodeRegistry(used(registry, stored.id, signCount, system.now())));
      } catch (e) {
        // The counter stays where it was: the next assertion is compared to it.
        console.error(`passkeys: last use not written (${(e as Error).name})`);
      }
      return { passkey: stored };
    });
  }

  const notOffered = () => error("not-found", "passkeys need the zone, SITESOLIDE_ZONE, which the steward does not have");

  async function list(): Promise<Response> {
    const registry = await load();
    const body: PasskeysResponse = registry === "unreadable" ? { passkeys: [], readable: false } : { passkeys: listView(registry), readable: true };
    return Response.json(body);
  }

  async function challenge(req: Request): Promise<Response> {
    if (!offered) return notOffered();
    const body = await options.readBody(req, ["purpose", "client", "token", "link"]);
    if (body instanceof Response) return body;
    const now = system.now();
    const wait = challengeRate.hit(clientOf(body), now);
    if (wait > 0) return tooMany(wait);
    const registry = await load();
    if (registry === "unreadable") return error("failure", "the passkey registry cannot be read: see the steward's log");

    if (body.purpose === "signin" || body.purpose === "unlock") {
      if (registry.credentials.length === 0) return error("not-found", "no passkey is registered yet");
      const issued = challenges.issue(body.purpose, now);
      // A sign-in names no passkey: anybody may ask, and the authenticator
      // offers those it holds for the zone. An unlock is the owner's session.
      return Response.json({ challengeId: issued.id, publicKey: assertionOptions(issued.challenge, body.purpose === "unlock" ? registry.credentials : []) });
    }
    if (body.purpose !== "register") return error("invalid", "purpose must be signin, unlock or register");

    const bound = await registrationBound(body, now);
    if (bound instanceof Response) return bound;
    if (registry.credentials.length >= MAX_PASSKEYS) return error("out-of-scope", `${MAX_PASSKEYS} passkeys at most: remove one first`);
    const issued = challenges.issue("register", now, bound);
    return Response.json({
      challengeId: issued.id,
      publicKey: {
        challenge: issued.challenge,
        rp: { id: rpId, name: `sitesolide, ${rpId}` },
        // One user, the owner, the same handle on every passkey: a new
        // passkey on an authenticator that holds one for this zone replaces it.
        user: { id: OWNER_USER_HANDLE, name: "owner", displayName: `Owner of ${rpId}` },
        pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
        timeout: CHALLENGE_MS,
        attestation: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        excludeCredentials: registry.credentials.map((one) => ({ type: "public-key", id: one.id })),
      },
    });
  }

  async function signIn(req: Request): Promise<Response> {
    if (!offered) return notOffered();
    const body = await options.readBody(req, ["challengeId", "credential", "client"]);
    if (body instanceof Response) return body;
    const wait = verifyRate.hit(clientOf(body), system.now());
    if (wait > 0) return tooMany(wait);
    const result = await verified("signin", body);
    if ("reason" in result) {
      await refusal("passkey.signin_failed", result.reason);
      return error("refused", REFUSED);
    }
    await options.journal({ operation: "passkey.signin", result: "ok", detail: result.passkey.name });
    const answer: SignInResponse = { id: result.passkey.id, name: result.passkey.name };
    return Response.json(answer);
  }

  async function register(req: Request): Promise<Response> {
    if (!offered) return notOffered();
    const body = await options.readBody(req, ["challengeId", "credential", "name", "client", "token", "link"]);
    if (body instanceof Response) return body;
    const now = system.now();
    const wait = verifyRate.hit(clientOf(body), now);
    if (wait > 0) return tooMany(wait);
    const name = cleanName(body.name);
    if (name === null) return error("invalid", "give the passkey a name of 60 characters at most");
    const bound = await registrationBound(body, now);
    if (bound instanceof Response) return bound;
    const viaLink = bound.startsWith("link:");

    const challenge = challenges.take(body.challengeId, "register", now, bound);
    const posted = readPostedRegistration(body.credential);
    const refuse = async (reason: string): Promise<Response> => {
      await refusal("passkey.add", reason);
      return error("refused", REFUSED);
    };
    if (challenge === null) return refuse("no such challenge, or expired");
    if (posted === null) return refuse("malformed registration");
    let made;
    try {
      made = await verifyRegistration(posted, { challenge, origin, rpId });
    } catch (e) {
      if (e instanceof Refused) return refuse(e.message);
      throw e;
    }
    if (made.id !== posted.id) return refuse("the credential id does not match");

    return serially(async () => {
      const registry = await load();
      if (registry === "unreadable") return error("failure", "the passkey registry cannot be read: see the steward's log");
      const refused = addRefusal(registry, made.id);
      if (refused !== null) return error("out-of-scope", refused);
      // The link is spent before anything is written: used twice at once,
      // the second finds it gone.
      if (viaLink) {
        if ((await liveLink(body.link, system.now())) === null) return error("refused", "this registration link was already used");
        link = null;
      }
      const passkey: StoredPasskey = {
        id: made.id,
        publicKey: b64url(made.publicKey),
        alg: made.alg,
        name,
        createdAt: system.now(),
        lastUsedAt: null,
        signCount: made.signCount,
        transports: posted.transports,
      };
      const next = withPasskey(registry, passkey);
      await save(next);
      await options.journal({ operation: "passkey.add", result: "ok", detail: viaLink ? `${name}, with root's registration link` : name });
      const answer: RegisterResponse = { passkey: listView(next).at(-1)!, viaLink, count: next.credentials.length };
      return Response.json(answer);
    });
  }

  /** A passkey removed: from the unlocked dashboard, never the last; by root, any. */
  function remove(byRoot: boolean) {
    return async (req: Request): Promise<Response> => {
      const body = await options.readBody(req, byRoot ? ["id"] : ["token", "id"]);
      if (body instanceof Response) return body;
      if (!byRoot && !(await options.isUnlocked(body.token))) return error("locked", "locked, unlock again");
      if (typeof body.id !== "string" || body.id.length > 1400) return error("invalid", "id must be a passkey's id");
      const id = body.id;
      return serially(async () => {
        const registry = await load();
        if (registry === "unreadable") return error("failure", "the passkey registry cannot be read: see the steward's log");
        const found = registry.credentials.find((one) => one.id === id);
        if (found === undefined) return error("not-found", "no such passkey");
        if (!byRoot && registry.credentials.length === 1) {
          await options.journal({ operation: "passkey.remove", result: "rejects", detail: "the last passkey" });
          return error("out-of-scope", "the last passkey stays: register another first, or remove it over SSH with `sitesolide passkey remove`");
        }
        const next = withoutPasskey(registry, id);
        await save(next);
        await options.journal({ operation: "passkey.remove", result: "ok", detail: byRoot ? `${found.name}, over SSH` : found.name });
        const answer: PasskeysResponse = { passkeys: listView(next), readable: true };
        return Response.json(answer);
      });
    };
  }

  async function mintLink(req: Request): Promise<Response> {
    if (!offered) return notOffered();
    const body = await options.readBody(req, []);
    if (body instanceof Response) return body;
    const secret = drawLink();
    const expiresAt = system.now() + LINK_DURATION_MS;
    link = { hash: await tokenHash(secret), expiresAt };
    await options.journal({ operation: "passkey.link", result: "ok", detail: "over SSH, valid 15 minutes" });
    const answer: LinkResponse = { link: secret, expiresAt };
    return Response.json(answer);
  }

  return {
    dashboard: {
      "/passkeys": { GET: list },
      "/passkeys/challenge": { POST: challenge },
      "/passkeys/signin": { POST: signIn },
      "/passkeys/register": { POST: register },
      "/passkeys/credential": { DELETE: remove(false) },
    },
    owner: {
      "/passkeys": { GET: list },
      "/passkeys/link": { POST: mintLink },
      "/passkeys/credential": { DELETE: remove(true) },
    },
    async start() {
      const registry = await load();
      if (registry === "unreadable") {
        console.error("passkeys: the registry cannot be read, nobody signs in with a passkey until it is repaired");
        return;
      }
      if (offered) await publish(registry);
    },
    async count() {
      const registry = await load();
      return registry === "unreadable" ? "unreadable" : registry.credentials.length;
    },
    async unlock(body, operation = "unlock") {
      if (!offered) return { ok: false, response: notOffered() };
      // One bucket for the owner's unlocks and confirmations: the same
      // challenges, the same passkeys, the same user.
      const wait = verifyRate.hit("unlock", system.now());
      if (wait > 0) return { ok: false, response: tooMany(wait) };
      const result = await verified("unlock", body);
      if ("reason" in result) {
        await refusal(operation, `passkey: ${result.reason}`);
        return { ok: false, response: error("refused", REFUSED) };
      }
      return { ok: true };
    },
  };
}
