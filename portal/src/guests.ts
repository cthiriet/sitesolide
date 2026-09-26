/**
 * The guest accesses: a password drawn for one person and a single site, which
 * the owner creates and revokes from the dashboard.
 *
 * Pure and with no import at all: the dashboard borrows this file for its
 * types and its durations, the browser page included, and a copy cannot carry
 * its dependencies along. The draw and the hash, which need Bun,
 * therefore live in `gate.ts`.
 *
 * ## Why a SHA-256 and not argon2id
 *
 * argon2id slows down whoever is guessing a password chosen by a human. This
 * one is drawn at random over about 92 bits: nothing to guess, and a fast
 * hash makes it possible to find it back by index instead of checking
 * each guest one by one, 64 MiB at a time.
 */

export type Guest = {
  id: string;
  /** The host this password opens, and it alone. */
  host: string;
  /** For whom, stated by the owner. Shown in the dashboard, nowhere else. */
  label: string;
  /** Milliseconds, like `seenAt` and `expiresAt`. */
  createdAt: number;
  /** `null`: no deadline, until revocation. */
  expiresAt: number | null;
  /** Last accepted request, noted at most once a minute. */
  seenAt: number | null;
};

/**
 * The durations offered at creation. The portal refuses any other value: the
 * dashboard offers only these, and an arbitrary duration coming from
 * elsewhere has no reason to be accepted.
 */
export const GUEST_DURATIONS = [
  { seconds: 24 * 3600, label: "24 h" },
  { seconds: 7 * 24 * 3600, label: "7 days" },
  { seconds: 30 * 24 * 3600, label: "30 days" },
  { seconds: null, label: "no expiry" },
] as const;

export const DEFAULT_GUEST_DURATION_S = 7 * 24 * 3600;

/** Four groups of four, `Xith-G4r4-nRJs-uDMV`: about 92 bits, and still readable. */
export const GUEST_PASSWORD_GROUPS = 4;

export const LABEL_MAX = 80;

/** 12 bytes in base64url: 16 characters, which travel in the cookie. */
const ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export function isValidDuration(duration: unknown): duration is number | null {
  return GUEST_DURATIONS.some((choice) => choice.seconds === duration);
}

/** The label cleaned of its edge spaces, or `null` if it is empty, too long or carries a control character. */
export function cleanLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const cleaned = label.trim();
  if (cleaned.length === 0 || cleaned.length > LABEL_MAX) return null;
  if (/[\x00-\x1f\x7f]/.test(cleaned)) return null;
  return cleaned;
}

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * Does this access open this host, right now? Re-read on every request by the
 * gate: a deleted or lapsed row closes from the next request on, without
 * waiting for the end of the cookie.
 */
export function guestOpens(guest: Guest | null, host: string, now: number): guest is Guest {
  if (guest === null || guest.host !== host) return false;
  return guest.expiresAt === null || guest.expiresAt > now;
}

/**
 * The expiration of a guest's cookie, in seconds: that of any cookie, but
 * never beyond the deadline of the access. A cookie that would outlive the
 * access would be refused anyway, so the browser may as well forget it in
 * time.
 */
export function guestExpiration(guest: Guest, nowS: number, durationS: number): number {
  const cap = nowS + durationS;
  return guest.expiresAt === null ? cap : Math.min(cap, Math.floor(guest.expiresAt / 1000));
}
