/**
 * The owner's passkeys as the portal reads them: the public half of each,
 * projected by the steward into `/etc/sitesolide-portal/passkeys.json`,
 * `root:site-portal 0640`, beside the access projection and the assertion
 * key. The steward writes it after every registration and every removal;
 * the portal reads it again as soon as it changes (src/passkey-signin.ts).
 *
 * **Why the portal holds a copy and does not ask.** The portal answers
 * Caddy's `forward_auth` on every request of every restricted site, and
 * has no way to the steward: the relay goes the other way, root asking the
 * portal. A public key is no secret, so a projection root writes and the
 * portal only reads costs nothing, and the steward stays the one that
 * decides which keys exist: the registry, with names, counters and dates,
 * is root's alone, `/var/lib/sitesolide-steward/passkeys.json`.
 *
 * One copy of this format for both sides: the steward borrows this file
 * (dashboard/scripts/borrow.ts), as it does the access projection's.
 */

/** Where the steward lays the projection, beside access.json. */
export const PASSKEYS_FILE = "/etc/sitesolide-portal/passkeys.json";
export const PASSKEYS_NAME = "passkeys.json";

/** A projection of the most passkeys the owner may hold is a few kilobytes. */
export const PASSKEYS_MAX_BYTES = 64 * 1024;

/** How many passkeys the owner may hold at once: a phone, a laptop, a security key or two, with room. */
export const MAX_PASSKEYS = 20;

export type ProjectedPasskey = {
  /** The credential id, base64url. */
  id: string;
  /** The COSE key, base64url, as the authenticator made it. */
  publicKey: string;
  alg: number;
};

export type PasskeyProjection = {
  version: 1;
  /** When the steward wrote it, in milliseconds. */
  writtenAt: number;
  /** The relying party the keys were registered for: the zone. */
  rpId: string;
  credentials: ProjectedPasskey[];
};

export const EMPTY_PASSKEYS: PasskeyProjection = { version: 1, writtenAt: 0, rpId: "", credentials: [] };

const B64URL = /^[A-Za-z0-9_-]+$/;

export function encodePasskeyProjection(projection: PasskeyProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

/** The projection, every field judged; or why it cannot serve. */
export function readPasskeyProjection(text: string): PasskeyProjection | { unreadable: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { unreadable: "passkeys.json is not JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { unreadable: "passkeys.json is not an object" };
  const { version, writtenAt, rpId, credentials } = value as Record<string, unknown>;
  if (version !== 1) return { unreadable: "passkeys.json is of a version this portal does not read" };
  if (typeof writtenAt !== "number" || !Number.isFinite(writtenAt) || writtenAt < 0) return { unreadable: "passkeys.json has no date" };
  if (typeof rpId !== "string" || rpId.length > 253) return { unreadable: "passkeys.json names no relying party" };
  if (!Array.isArray(credentials) || credentials.length > MAX_PASSKEYS) return { unreadable: "passkeys.json holds no list of passkeys" };
  const read: ProjectedPasskey[] = [];
  for (const one of credentials) {
    if (typeof one !== "object" || one === null) return { unreadable: "passkeys.json holds a passkey that is not an object" };
    const { id, publicKey, alg } = one as Record<string, unknown>;
    if (typeof id !== "string" || id.length > 1400 || !B64URL.test(id)) return { unreadable: "passkeys.json holds a passkey without an id" };
    if (typeof publicKey !== "string" || publicKey.length > 2048 || !B64URL.test(publicKey)) return { unreadable: "passkeys.json holds a passkey without a key" };
    if (typeof alg !== "number" || !Number.isSafeInteger(alg)) return { unreadable: "passkeys.json holds a passkey without an algorithm" };
    read.push({ id, publicKey, alg });
  }
  return { version: 1, writtenAt, rpId, credentials: read };
}

/**
 * What a site's owner cookie opened with a passkey carries of it: a short
 * hash of the credential's id, 128 bits, never the id itself. The gate
 * looks it up in the projection on every request, so that removing the
 * passkey closes every site it opened at the next request.
 */
export function passkeyRef(id: string): string {
  return new Bun.CryptoHasher("sha256").update(`sitesolide-passkey|${id}`).digest("base64url").slice(0, 22);
}

export function isPasskeyRef(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}
