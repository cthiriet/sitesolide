/**
 * Member sessions, as the steward holds them: who each one belongs to, until
 * when, and the assertions already spent. Kept in
 * `/var/lib/sitesolide-steward/member-sessions.json`, root 0600, so that a
 * steward restarted to update it signs nobody out.
 *
 * **The session token is the dashboard's cookie.** The steward draws it when
 * an assertion checks out, the dashboard sets it as the browser's
 * `__Host-session` and keeps only its hash, as it does for the owner's: on
 * every member request the browser presents it, and the dashboard hands it to
 * the steward for anything the steward decides. The steward keeps only its
 * hash too. A backup of either file that leaks yields no usable session, and
 * a dashboard that is compromised holds the sessions of the members who come
 * through it while it is, within their roles, never more.
 *
 * **An assertion opens one session, once.** Its nonce is remembered until it
 * would have expired anyway, on disk with the sessions: a dashboard replaying
 * one, even across a restart of the steward, is refused.
 *
 * Pure: the book comes in as a value, a new one goes out; the clock and the
 * random source are parameters.
 */
import { generateToken, tokenHash, type RandomSource } from "../sessions";
import { MAX_SESSIONS, MAX_SESSIONS_PER_MEMBER, MEMBER_SESSION_DURATION_MS } from "./protocol";

export type SessionRecord = { hash: string; email: string; createdAt: number; expiresAt: number };

export type SessionBook = {
  sessions: SessionRecord[];
  /** An assertion's nonce, and when it expires, in milliseconds. */
  nonces: Record<string, number>;
};

export const EMPTY_BOOK: SessionBook = { sessions: [], nonces: {} };

const HASH_SHAPE = /^[0-9a-f]{64}$/;
const NONCE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** A token's shape, as `generateToken` draws it: 32 bytes in base64url. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Nonces kept at most: a sign-in a second for five minutes, and more. */
export const MAX_NONCES = 2000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function isSession(value: unknown): value is SessionRecord {
  if (!isObject(value)) return false;
  return typeof value.hash === "string" && HASH_SHAPE.test(value.hash) && typeof value.email === "string" && isDate(value.createdAt) && isDate(value.expiresAt);
}

/**
 * The book's file, read. Missing or unreadable, it is empty: every member
 * signs in again, which is the safe failure for a list of open sessions, and
 * forgets the spent nonces, which costs nothing past five minutes.
 */
export function readBook(text: string | null): SessionBook {
  if (text === null) return EMPTY_BOOK;
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return EMPTY_BOOK;
  }
  if (!isObject(object) || !Array.isArray(object.sessions) || !isObject(object.nonces)) return EMPTY_BOOK;
  const nonces: Record<string, number> = {};
  for (const [nonce, until] of Object.entries(object.nonces)) {
    if (NONCE_SHAPE.test(nonce) && isDate(until)) nonces[nonce] = until;
  }
  return { sessions: object.sessions.filter(isSession), nonces };
}

export function encodeBook(book: SessionBook): string {
  return `${JSON.stringify({ sessions: book.sessions, nonces: book.nonces })}\n`;
}

/** The book without what has expired. */
export function prune(book: SessionBook, now: number): SessionBook {
  const nonces: Record<string, number> = {};
  for (const [nonce, until] of Object.entries(book.nonces)) if (until > now) nonces[nonce] = until;
  return { sessions: book.sessions.filter((session) => session.expiresAt > now), nonces };
}

/**
 * Spends an assertion's nonce, or says it was already spent. Past
 * `MAX_NONCES` live ones, refused too: nobody signs in that fast, and
 * forgetting one to make room would let it be replayed.
 */
export function spendNonce(book: SessionBook, nonce: string, expiresAt: number, now: number): SessionBook | "replayed" | "too-many" {
  const live = prune(book, now);
  if (Object.hasOwn(live.nonces, nonce)) return "replayed";
  if (Object.keys(live.nonces).length >= MAX_NONCES) return "too-many";
  return { sessions: live.sessions, nonces: { ...live.nonces, [nonce]: expiresAt } };
}

/**
 * A new session for this member, the token in the clear only in what is
 * returned. Half a day, never longer. Past `MAX_SESSIONS_PER_MEMBER` live
 * ones, the member's oldest goes; past `MAX_SESSIONS`, the machine's oldest.
 */
export async function openMemberSession(
  book: SessionBook,
  email: string,
  now: number,
  random?: RandomSource,
): Promise<{ book: SessionBook; token: string; record: SessionRecord }> {
  const live = prune(book, now);
  const token = generateToken(random);
  const record: SessionRecord = { hash: await tokenHash(token), email, createdAt: now, expiresAt: now + MEMBER_SESSION_DURATION_MS };
  let sessions = [...live.sessions].sort((a, b) => a.createdAt - b.createdAt);
  const theirs = sessions.filter((session) => session.email === email);
  if (theirs.length >= MAX_SESSIONS_PER_MEMBER) {
    const dropped = new Set(theirs.slice(0, theirs.length - MAX_SESSIONS_PER_MEMBER + 1).map((session) => session.hash));
    sessions = sessions.filter((session) => !dropped.has(session.hash));
  }
  if (sessions.length >= MAX_SESSIONS) sessions = sessions.slice(sessions.length - MAX_SESSIONS + 1);
  return { book: { sessions: [...sessions, record], nonces: live.nonces }, token, record };
}

/** The live session this token opens, or null. Found by its hash, never compared in the clear. */
export async function findSession(book: SessionBook, token: unknown, now: number): Promise<SessionRecord | null> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  const hash = await tokenHash(token);
  return book.sessions.find((session) => session.hash === hash && session.expiresAt > now) ?? null;
}

export function dropSession(book: SessionBook, hash: string): SessionBook {
  return { sessions: book.sessions.filter((session) => session.hash !== hash), nonces: book.nonces };
}

/** Every session of a member, closed: what removing them does. */
export function dropMember(book: SessionBook, email: string): SessionBook {
  return { sessions: book.sessions.filter((session) => session.email !== email), nonces: book.nonces };
}
