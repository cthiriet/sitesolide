/**
 * WebAuthn for the owner's passkeys: the minimum CBOR and COSE a passkey
 * needs, the verification of a registration and of an assertion, the
 * challenges that bind one to the other, and a rate limit for the routes
 * that take them. No dependency: WebCrypto does the signatures.
 *
 * One copy for two verifiers. The steward, as root, verifies the
 * dashboard's ceremonies, a sign-in, an unlock, a registration
 * (dashboard/src/passkeys/), and the portal verifies its own sign-in in
 * front of the restricted sites (src/passkey.ts) against the public keys
 * the steward projects for it. The dashboard borrows this file
 * (dashboard/scripts/borrow.ts): a second writing of the same checks would
 * end up accepting what the other refuses.
 *
 * Pure: no disk, no network, the clock as a parameter. Adapted from the
 * passkeys of devbox, which runs the same ceremonies for one user.
 *
 * Attestation is "none" and never checked. The machine wants a key it can
 * verify later, not a statement about the authenticator that made it, and
 * the only person who can register one is the owner: unlocked in the
 * dashboard, or through a one-time link root minted on the machine.
 */

/* --- base64url ---------------------------------------------------------------- */

const encoder = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Null for anything that is not unpadded base64url: nothing here is decoded leniently. */
export function fromB64url(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const sha256 = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

/* --- CBOR -------------------------------------------------------------------- */

export type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

/** Deep enough for an attestation object (a map holding a map) and a COSE key, and no deeper. */
const CBOR_DEPTH = 8;

/**
 * One data item, and where it ended - an authenticator's data holds a COSE key and may be followed
 * by extensions, so the caller has to know how much was read. Definite lengths only, no tags, no
 * floats: that is all a WebAuthn authenticator writes (CTAP2's canonical form), and everything
 * else is refused rather than half understood.
 */
export function decodeCbor(bytes: Uint8Array, at = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > CBOR_DEPTH) throw new Error("cbor: nested too deep");
  if (at >= bytes.length) throw new Error("cbor: truncated");
  const major = bytes[at]! >> 5;
  const info = bytes[at]! & 0x1f;
  let pos = at + 1;

  const argument = (): number => {
    if (info < 24) return info;
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (width === 0) throw new Error("cbor: indefinite or reserved length");
    if (pos + width > bytes.length) throw new Error("cbor: truncated");
    let n = 0;
    for (let i = 0; i < width; i += 1) n = n * 256 + bytes[pos + i]!;
    pos += width;
    if (!Number.isSafeInteger(n)) throw new Error("cbor: integer out of range");
    return n;
  };

  if (major === 7) {
    if (info === 20) return { value: false, end: pos };
    if (info === 21) return { value: true, end: pos };
    if (info === 22) return { value: null, end: pos };
    throw new Error("cbor: unsupported simple value");
  }
  if (major === 6) throw new Error("cbor: tags are not supported");

  const n = argument();
  if (major === 0) return { value: n, end: pos };
  if (major === 1) return { value: -1 - n, end: pos };
  if (major === 2 || major === 3) {
    if (pos + n > bytes.length) throw new Error("cbor: truncated");
    const slice = bytes.subarray(pos, pos + n);
    pos += n;
    return { value: major === 2 ? slice : new TextDecoder("utf-8", { fatal: true }).decode(slice), end: pos };
  }
  if (n > bytes.length) throw new Error("cbor: a length longer than the data");
  if (major === 4) {
    const items: Cbor[] = [];
    for (let i = 0; i < n; i += 1) {
      const item = decodeCbor(bytes, pos, depth + 1);
      items.push(item.value);
      pos = item.end;
    }
    return { value: items, end: pos };
  }
  const map = new Map<Cbor, Cbor>();
  for (let i = 0; i < n; i += 1) {
    const key = decodeCbor(bytes, pos, depth + 1);
    const item = decodeCbor(bytes, key.end, depth + 1);
    if (typeof key.value !== "number" && typeof key.value !== "string") throw new Error("cbor: a map key that is not an integer or a string");
    map.set(key.value, item.value);
    pos = item.end;
  }
  return { value: map, end: pos };
}

/* --- COSE keys ------------------------------------------------------------------ */

export const ES256 = -7;
export const EDDSA = -8;
export const RS256 = -257;
export const ALGORITHMS = [ES256, EDDSA, RS256] as const;

/** A COSE key (RFC 9052) as a WebCrypto key, and the algorithm to verify with. Throws on one this service does not take. */
async function coseKey(cose: Uint8Array): Promise<{ alg: number; key: CryptoKey }> {
  const { value } = decodeCbor(cose);
  if (!(value instanceof Map)) throw new Error("cose: not a map");
  const alg = value.get(3);
  const kty = value.get(1);
  const bytes = (label: number): string => {
    const part = value.get(label);
    if (!(part instanceof Uint8Array)) throw new Error(`cose: parameter ${label} missing`);
    return b64url(part);
  };
  if (alg === ES256 && kty === 2 && value.get(-1) === 1) {
    const x = value.get(-2);
    const y = value.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw new Error("cose: bad P-256 point");
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { alg, key };
  }
  if (alg === EDDSA && kty === 1 && value.get(-1) === 6) {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: bytes(-2) }, { name: "Ed25519" }, false, ["verify"]);
    return { alg, key };
  }
  if (alg === RS256 && kty === 3) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", alg: "RS256", n: bytes(-1), e: bytes(-2) },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return { alg, key };
  }
  throw new Error("cose: an algorithm or key type this service does not take");
}

/** An ECDSA signature as an authenticator sends it, ASN.1 DER, as the raw r || s WebCrypto verifies. */
function derToRaw(der: Uint8Array, size: number): Uint8Array {
  let at = 0;
  const length = (): number => {
    let n = der[at++]!;
    if (n & 0x80) {
      const width = n & 0x7f;
      if (width < 1 || width > 2) throw new Error("der: bad length");
      n = 0;
      for (let i = 0; i < width; i += 1) n = n * 256 + (der[at++] ?? 0);
    }
    return n;
  };
  if (der[at++] !== 0x30) throw new Error("der: not a sequence");
  if (length() !== der.length - at) throw new Error("der: bad length");
  const out = new Uint8Array(size * 2);
  for (const half of [0, 1]) {
    if (der[at++] !== 0x02) throw new Error("der: not an integer");
    let n = length();
    if (at + n > der.length) throw new Error("der: truncated");
    let integer = der.subarray(at, at + n);
    at += n;
    while (integer.length > 0 && integer[0] === 0) integer = integer.subarray(1);
    n = integer.length;
    if (n > size) throw new Error("der: integer too long");
    out.set(integer, half * size + (size - n));
  }
  if (at !== der.length) throw new Error("der: trailing bytes");
  return out;
}

async function verifySignature(cose: Uint8Array, signature: Uint8Array, signed: Uint8Array): Promise<boolean> {
  const { alg, key } = await coseKey(cose);
  // Copied into fresh buffers: what WebCrypto takes, whichever lib a project types against.
  const bytes = new Uint8Array(signed);
  if (alg === ES256) return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(derToRaw(signature, 32)), bytes);
  if (alg === EDDSA) return crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signature), bytes);
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, new Uint8Array(signature), bytes);
}

/* --- what the authenticator and the browser sent ---------------------------------- */

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export type Expected = {
  /** The challenge this service issued, base64url. */
  challenge: string;
  /** The origin of the page that ran the ceremony: `https://dashboard.<zone>`, or the portal's own. */
  origin: string;
  /** The relying party id: the zone, so that one passkey serves the dashboard and the portal. */
  rpId: string;
};

export class Refused extends Error {}

const refuse = (reason: string): never => {
  throw new Refused(reason);
};

/**
 * clientDataJSON: what the browser says it did - the ceremony, the challenge it was given, and
 * the origin of the page that asked. Equal to what was issued, or refused.
 */
function checkClientData(raw: Uint8Array, type: "webauthn.get" | "webauthn.create", expected: Expected): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<string, unknown>;
  } catch {
    return refuse("the client data is not JSON");
  }
  if (data === null || typeof data !== "object") return refuse("the client data is not an object");
  if (data.type !== type) return refuse("the client data is for another ceremony");
  if (data.challenge !== expected.challenge) return refuse("the challenge is not the one issued");
  if (data.origin !== expected.origin) return refuse("the origin is not this service's");
  if (data.crossOrigin === true) return refuse("a cross-origin ceremony");
}

/** The fixed part of authenticator data, checked against the relying party. */
async function checkAuthData(authData: Uint8Array, expected: Expected): Promise<{ flags: number; signCount: number }> {
  if (authData.length < 37) return refuse("the authenticator data is too short");
  if (!same(authData.subarray(0, 32), await sha256(encoder.encode(expected.rpId)))) return refuse("the relying party id is not this service's");
  const flags = authData[32]!;
  if ((flags & FLAG_UP) === 0) return refuse("the user was not present");
  if ((flags & FLAG_UV) === 0) return refuse("the user was not verified");
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  return { flags, signCount };
}

export type Registered = {
  /** The credential id, base64url. */
  id: string;
  /** The COSE key, as the authenticator made it: what is stored. */
  publicKey: Uint8Array;
  alg: number;
  signCount: number;
};

/**
 * A registration: the attestation object's authenticator data carries the new credential. Format
 * `none`, and the statement of any other is ignored - see the header.
 */
export async function verifyRegistration(
  response: { clientDataJSON: Uint8Array; attestationObject: Uint8Array },
  expected: Expected,
): Promise<Registered> {
  checkClientData(response.clientDataJSON, "webauthn.create", expected);
  let attestation: Cbor;
  try {
    attestation = decodeCbor(response.attestationObject).value;
  } catch (error) {
    return refuse(`the attestation object is not CBOR (${(error as Error).message})`);
  }
  if (!(attestation instanceof Map)) return refuse("the attestation object is not a map");
  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array)) return refuse("the attestation object has no authenticator data");
  const { flags, signCount } = await checkAuthData(authData, expected);
  if ((flags & FLAG_AT) === 0) return refuse("no credential in the authenticator data");

  // aaguid (16), credential id length (2), the id, the COSE key.
  if (authData.length < 55) return refuse("the credential data is truncated");
  const idLength = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0);
  if (idLength < 1 || idLength > 1023 || 55 + idLength >= authData.length) return refuse("the credential id is out of range");
  const credentialId = authData.slice(55, 55 + idLength);
  let end: number;
  try {
    end = decodeCbor(authData, 55 + idLength).end;
  } catch (error) {
    return refuse(`the public key is not CBOR (${(error as Error).message})`);
  }
  const publicKey = authData.slice(55 + idLength, end);
  let alg: number;
  try {
    alg = (await coseKey(publicKey)).alg;
  } catch (error) {
    return refuse((error as Error).message);
  }
  return { id: b64url(credentialId), publicKey, alg, signCount };
}

/**
 * An assertion against a stored credential. The counter: when either side is zero the
 * authenticator keeps none (a synced passkey) and nothing is compared; when both are not, it must
 * have grown, or the key was cloned.
 */
export async function verifyAssertion(
  response: { clientDataJSON: Uint8Array; authenticatorData: Uint8Array; signature: Uint8Array },
  expected: Expected,
  stored: { publicKey: Uint8Array; signCount: number },
): Promise<{ signCount: number }> {
  checkClientData(response.clientDataJSON, "webauthn.get", expected);
  const { signCount } = await checkAuthData(response.authenticatorData, expected);
  if (stored.signCount !== 0 && signCount !== 0 && signCount <= stored.signCount) return refuse("the signature counter did not grow");

  const signed = new Uint8Array(response.authenticatorData.length + 32);
  signed.set(response.authenticatorData);
  signed.set(await sha256(response.clientDataJSON), response.authenticatorData.length);
  let good = false;
  try {
    good = await verifySignature(stored.publicKey, response.signature, signed);
  } catch {
    good = false;
  }
  if (!good) return refuse("the signature is not valid");
  return { signCount };
}

/* --- challenges ------------------------------------------------------------------ */

export const CHALLENGE_MS = 120_000;

/** Outstanding at once, anonymous callers included: past it the oldest is evicted. */
export const CHALLENGES_MAX = 100;

type Pending = { challenge: string; purpose: string; bound: string; expires: number };

/**
 * Challenges in memory: single use, two minutes, at most `max`. Anyone can ask for one without a
 * session, so the bound is what keeps that from being a way to fill the memory, and a flood
 * evicting the owner's challenge costs them one more click. A challenge issued for one purpose is
 * refused by another, and one bound to something (a registration link's hash, the unlock it was
 * asked under, a sign-in flow's binding) is refused with anything else.
 */
export class Challenges {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly max = CHALLENGES_MAX) {}

  issue(purpose: string, now: number, bound = ""): { id: string; challenge: string } {
    const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
    const id = random(16);
    const challenge = random(32);
    for (const [key, one] of this.pending) if (one.expires <= now) this.pending.delete(key);
    while (this.pending.size >= this.max) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    this.pending.set(id, { challenge, purpose, bound, expires: now + CHALLENGE_MS });
    return { id, challenge };
  }

  /** The challenge, and it is gone: a second take of one id answers null, whatever the first did. */
  take(id: unknown, purpose: string, now: number, bound = ""): string | null {
    if (typeof id !== "string") return null;
    const one = this.pending.get(id);
    if (one === undefined) return null;
    this.pending.delete(id);
    return one.expires > now && one.purpose === purpose && one.bound === bound ? one.challenge : null;
  }

  get size(): number {
    return this.pending.size;
  }
}

/* --- what the page posts --------------------------------------------------------- */

/** An assertion as the page serialises it (base64url fields), decoded. */
export type PostedAssertion = {
  id: string;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  userHandle: string | null;
};

/** A registration as the page serialises it, decoded. */
export type PostedRegistration = {
  id: string;
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
  transports: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Beyond this, a field is no WebAuthn answer: an RSA signature is 256 bytes, an attestation a few hundred. */
const MAX_FIELD_CHARACTERS = 16 * 1024;

function fieldBytes(object: Record<string, unknown>, name: string): Uint8Array | null {
  const value = object[name];
  if (typeof value !== "string" || value.length > MAX_FIELD_CHARACTERS) return null;
  return fromB64url(value);
}

/** The credential's id, which its rawId must spell the same. */
function credentialIdOf(credential: Record<string, unknown>): string | null {
  if (credential.type !== "public-key" || typeof credential.id !== "string") return null;
  const raw = fieldBytes(credential, "rawId");
  if (raw === null || raw.length < 1 || raw.length > 1023) return null;
  return credential.id === b64url(raw) ? credential.id : null;
}

/** What `navigator.credentials.get()` answered, as the page posts it; null when anything is off. */
export function readPostedAssertion(credential: unknown): PostedAssertion | null {
  if (!isRecord(credential) || !isRecord(credential.response)) return null;
  const id = credentialIdOf(credential);
  const response = credential.response;
  const clientDataJSON = fieldBytes(response, "clientDataJSON");
  const authenticatorData = fieldBytes(response, "authenticatorData");
  const signature = fieldBytes(response, "signature");
  if (id === null || clientDataJSON === null || authenticatorData === null || signature === null) return null;
  const handle = response.userHandle;
  if (handle !== undefined && handle !== null && (typeof handle !== "string" || handle.length > 256 || fromB64url(handle) === null)) return null;
  return { id, clientDataJSON, authenticatorData, signature, userHandle: typeof handle === "string" && handle !== "" ? handle : null };
}

/** What `navigator.credentials.create()` answered, as the page posts it; null when anything is off. */
export function readPostedRegistration(credential: unknown): PostedRegistration | null {
  if (!isRecord(credential) || !isRecord(credential.response)) return null;
  const id = credentialIdOf(credential);
  const response = credential.response;
  const clientDataJSON = fieldBytes(response, "clientDataJSON");
  const attestationObject = fieldBytes(response, "attestationObject");
  if (id === null || clientDataJSON === null || attestationObject === null) return null;
  const transports = Array.isArray(response.transports)
    ? response.transports.filter((one): one is string => typeof one === "string" && /^[a-z-]{1,16}$/.test(one)).slice(0, 8)
    : [];
  return { id, clientDataJSON, attestationObject, transports };
}

/** The user handle every passkey of the owner is registered under: the same bytes on every machine, naming the role, not a person. */
export const OWNER_USER_HANDLE = b64url(encoder.encode("sitesolide-owner"));

/* --- rate limit -------------------------------------------------------------------- */

/**
 * A fixed window per key and one for everybody, in memory. Answers the seconds to wait, or 0.
 * The keys are bounded: a window that has passed is dropped when the table grows.
 */
export class RateLimit {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private all = { start: 0, count: 0 };

  constructor(
    private readonly perKey: number,
    private readonly total: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Counts one request; the seconds until it would be accepted when it is not. */
  hit(key: string, now: number): number {
    if (now - this.all.start >= this.windowMs) this.all = { start: now, count: 0 };
    let mine = this.windows.get(key);
    if (mine === undefined || now - mine.start >= this.windowMs) {
      if (this.windows.size >= 10_000) {
        for (const [one, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(one);
        if (this.windows.size >= 10_000) this.windows.clear();
      }
      mine = { start: now, count: 0 };
      this.windows.set(key, mine);
    }
    if (mine.count >= this.perKey) return Math.max(1, Math.ceil((mine.start + this.windowMs - now) / 1000));
    if (this.all.count >= this.total) return Math.max(1, Math.ceil((this.all.start + this.windowMs - now) / 1000));
    mine.count += 1;
    this.all.count += 1;
    return 0;
  }
}
