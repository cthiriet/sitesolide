/**
 * The members' unlocks, as the steward holds them: one per member session,
 * beside the owner's own (src/secrets/unlock.ts), which neither
 * replaces nor is replaced by any of them.
 *
 * - **One principal, one token.** The owner has one, which a new unlock
 *   of theirs replaces, as before. A member has one per session: the same
 *   member unlocking again in that session replaces it, another member, or
 *   the same one in another browser, holds their own. Ten minutes fixed,
 *   which use does not extend, kept by its hash.
 * - **Opened by a forced sign-in**, never a password: the portal's assertion
 *   says the provider was made to ask again, minutes ago, for the email the
 *   session is (src/people/steward.ts checks it).
 * - **Bounded**: per member, three refusals tolerated, then five seconds
 *   doubling up to an hour, the password's rule; for the whole machine, sixty
 *   attempts a minute, whoever makes them. The owner's password counter
 *   stays its own, on disk: a member's refusals never slow the owner, nor the
 *   other way round.
 *
 * In memory: a restart of the steward locks everyone, as it locks the super
 * admin. An attempt costs a round trip through the provider, which no one
 * guesses; the counters bound the work, not a secret.
 *
 * Pure: the book comes in as a value, a new one goes out; the clock and the
 * random source are parameters.
 */
import { remainingWait } from "../auth";
import { generateToken, tokenHash, type RandomSource } from "../sessions";
import { UNLOCK_DURATION_MS } from "../secrets/protocol";

export type MemberUnlock = { session: string; email: string; hash: string; expiresAt: number };

export type UnlockBook = {
  tokens: MemberUnlock[];
  failures: Record<string, { failures: number; lastFailureAt: number }>;
  minute: number;
  attempts: number;
};

export const EMPTY_UNLOCKS: UnlockBook = { tokens: [], failures: {}, minute: -1, attempts: 0 };

/** Live unlocks on the machine: one per member session at most, and sessions are bounded alike. */
export const MAX_UNLOCKS = 1000;

/** Unlock attempts on the machine in one minute, everyone together. */
export const UNLOCK_ATTEMPTS_PER_MINUTE = 60;

/** Emails whose refusals are remembered; past it, the oldest are forgotten. */
const MAX_FAILURES = 10_000;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function live(book: UnlockBook, now: number): MemberUnlock[] {
  return book.tokens.filter((token) => token.expiresAt > now);
}

/**
 * Milliseconds before this member may try to unlock again, zero when the way
 * is clear: the machine's cap first, then their own refusals. Counts nothing.
 */
export function attemptWait(book: UnlockBook, email: string, now: number): number {
  const minute = Math.floor(now / 60_000);
  if (book.minute === minute && book.attempts >= UNLOCK_ATTEMPTS_PER_MINUTE) return (minute + 1) * 60_000 - now;
  const record = Object.hasOwn(book.failures, email) ? book.failures[email]! : null;
  return record === null ? 0 : remainingWait(record.failures, record.lastFailureAt, now);
}

/** One more attempt in this minute, whatever comes of it. */
export function countAttempt(book: UnlockBook, now: number): UnlockBook {
  const minute = Math.floor(now / 60_000);
  return { ...book, minute, attempts: book.minute === minute ? book.attempts + 1 : 1 };
}

export function failed(book: UnlockBook, email: string, now: number): UnlockBook {
  const failures = { ...book.failures };
  const known = Object.hasOwn(failures, email) ? failures[email]! : { failures: 0, lastFailureAt: 0 };
  if (!Object.hasOwn(failures, email) && Object.keys(failures).length >= MAX_FAILURES) delete failures[Object.keys(failures)[0]!];
  failures[email] = { failures: known.failures + 1, lastFailureAt: now };
  return { ...book, failures };
}

/**
 * A new token for this member session, the old one of that session gone,
 * nobody else's touched. The token in the clear lives only in what is
 * returned. The member's refusals are forgotten.
 */
export async function grant(
  book: UnlockBook,
  session: string,
  email: string,
  now: number,
  random?: RandomSource,
): Promise<{ book: UnlockBook; token: string; expiresAt: number }> {
  const token = generateToken(random);
  const expiresAt = now + UNLOCK_DURATION_MS;
  let tokens = live(book, now).filter((unlock) => unlock.session !== session);
  if (tokens.length >= MAX_UNLOCKS) tokens = [...tokens].sort((a, b) => a.expiresAt - b.expiresAt).slice(tokens.length - MAX_UNLOCKS + 1);
  const failures = { ...book.failures };
  delete failures[email];
  return { book: { ...book, tokens: [...tokens, { session, email, hash: await tokenHash(token), expiresAt }], failures }, token, expiresAt };
}

/**
 * Is this the live token of this member session, for this member? The expiry
 * falls at the millisecond `expiresAt` included, and use does not push it back.
 */
export async function isUnlocked(book: UnlockBook, session: string, email: string, token: unknown, now: number): Promise<boolean> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return false;
  const found = book.tokens.find((unlock) => unlock.session === session);
  if (found === undefined || found.email !== email || now >= found.expiresAt) return false;
  return (await tokenHash(token)) === found.hash;
}

/** When this session's unlock ends, null when it has none. */
export function unlockedUntil(book: UnlockBook, session: string, now: number): number | null {
  const found = book.tokens.find((unlock) => unlock.session === session && unlock.expiresAt > now);
  return found?.expiresAt ?? null;
}

/** This session's unlock gone: a lock, a sign-out. */
export function revokeSession(book: UnlockBook, session: string): UnlockBook {
  return { ...book, tokens: book.tokens.filter((unlock) => unlock.session !== session) };
}

/** Every unlock of this member gone: removed. A role taken away needs nothing: each request is judged on the roles of that moment. */
export function revokeMember(book: UnlockBook, email: string): UnlockBook {
  return { ...book, tokens: book.tokens.filter((unlock) => unlock.email !== email) };
}
