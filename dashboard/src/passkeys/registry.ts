/**
 * The owner's passkeys as the steward keeps them: rules alone, no input or
 * output, so that every one is judged without a file.
 *
 * A passkey here is its public half: the COSE key the authenticator made, its
 * algorithm, the counter it last showed, a name the owner gave it, and two
 * dates. Nothing in it is secret: what it needs is integrity, which root's
 * file gives it (`/var/lib/sitesolide-steward/passkeys.json`, 0600). Whoever
 * could add a line there could sign in as the owner; whoever reads it learns
 * nothing that lets them.
 *
 * The portal reads a projection of it, the ids, keys and algorithms alone,
 * which the steward writes beside the access projection (portal/src/passkeys.ts).
 */
import { encodePasskeyProjection, MAX_PASSKEYS, type PasskeyProjection } from "../../borrowed/passkeys";
import { ALGORITHMS, fromB64url } from "../../borrowed/webauthn";

export type StoredPasskey = {
  /** The credential id, base64url. */
  id: string;
  /** The COSE public key, base64url. */
  publicKey: string;
  alg: number;
  /** What the owner called it: "Laptop", "Phone". */
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  signCount: number;
  transports: string[];
};

export type Registry = { version: 1; credentials: StoredPasskey[] };

export const EMPTY_REGISTRY: Registry = { version: 1, credentials: [] };

/** The registry's file in the steward's state folder. */
export const REGISTRY_NAME = "passkeys.json";

/** Far above twenty passkeys: a bigger file is not one the steward wrote. */
export const REGISTRY_MAX_BYTES = 256 * 1024;

/** A passkey's name: printable, short, given by the owner. */
export const NAME_MAX = 60;

/** What the page lists of a passkey: never its key. */
export type PasskeyView = { id: string; name: string; createdAt: number; lastUsedAt: number | null };

const TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card"]);

/** The name the owner gave, trimmed, or null when it cannot be one. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "" || name.length > NAME_MAX) return null;
  // Printable characters alone, accents included: a name goes into a list and a journal line.
  return /^[^\p{C}]+$/u.test(name) ? name : null;
}

function isStored(value: unknown): value is StoredPasskey {
  if (typeof value !== "object" || value === null) return false;
  const one = value as Record<string, unknown>;
  return (
    typeof one.id === "string" &&
    fromB64url(one.id) !== null &&
    typeof one.publicKey === "string" &&
    fromB64url(one.publicKey) !== null &&
    typeof one.alg === "number" &&
    ALGORITHMS.includes(one.alg as (typeof ALGORITHMS)[number]) &&
    cleanName(one.name) === one.name &&
    typeof one.createdAt === "number" &&
    Number.isSafeInteger(one.createdAt) &&
    (one.lastUsedAt === null || (typeof one.lastUsedAt === "number" && Number.isSafeInteger(one.lastUsedAt))) &&
    typeof one.signCount === "number" &&
    Number.isSafeInteger(one.signCount) &&
    one.signCount >= 0 &&
    Array.isArray(one.transports) &&
    one.transports.every((transport) => typeof transport === "string" && TRANSPORTS.has(transport))
  );
}

/**
 * The registry read from its text: null text, a registry still empty. A text
 * that does not read whole is `unreadable`, never an empty registry: the
 * owner's passkeys forgotten would put the password back in force.
 */
export function readRegistry(text: string | null): Registry | "unreadable" {
  if (text === null) return EMPTY_REGISTRY;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  if (typeof value !== "object" || value === null) return "unreadable";
  const { version, credentials } = value as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(credentials) || credentials.length > MAX_PASSKEYS) return "unreadable";
  if (!credentials.every(isStored)) return "unreadable";
  if (new Set(credentials.map((one) => one.id)).size !== credentials.length) return "unreadable";
  return { version: 1, credentials };
}

export function encodeRegistry(registry: Registry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function listView(registry: Registry): PasskeyView[] {
  return registry.credentials.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt }));
}

/** Why a passkey cannot be added, or null. */
export function addRefusal(registry: Registry, id: string): string | null {
  if (registry.credentials.some((one) => one.id === id)) return "this passkey is already registered";
  if (registry.credentials.length >= MAX_PASSKEYS) return `${MAX_PASSKEYS} passkeys at most`;
  return null;
}

export function withPasskey(registry: Registry, passkey: StoredPasskey): Registry {
  return { version: 1, credentials: [...registry.credentials, passkey] };
}

export function withoutPasskey(registry: Registry, id: string): Registry {
  return { version: 1, credentials: registry.credentials.filter((one) => one.id !== id) };
}

/** The counter and the date of a passkey that just signed. */
export function used(registry: Registry, id: string, signCount: number, now: number): Registry {
  return { version: 1, credentials: registry.credentials.map((one) => (one.id === id ? { ...one, signCount, lastUsedAt: now } : one)) };
}

/** What the portal reads: ids, keys and algorithms, for this relying party. */
export function projectionText(registry: Registry, rpId: string, now: number): string {
  const projection: PasskeyProjection = {
    version: 1,
    writtenAt: now,
    rpId,
    credentials: registry.credentials.map(({ id, publicKey, alg }) => ({ id, publicKey, alg })),
  };
  return encodePasskeyProjection(projection);
}
