/**
 * A software authenticator, built with WebCrypto and nothing of src/webauthn.ts: it writes the
 * bytes a browser would hand the page - an attestation object of format "none", authenticator
 * data, clientDataJSON, a signature - so that the verification is tested against an independent
 * encoder. Never imported by src/: the portal's tests and the dashboard's use it.
 */

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

/* --- CBOR, the encoding half --------------------------------------------------- */

export type Item = number | string | Uint8Array | Item[] | Map<number | string, Item>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function cbor(item: Item): Uint8Array {
  const out: number[] = [];
  const put = (value: Item): void => {
    if (typeof value === "number") out.push(...(value >= 0 ? head(0, value) : head(1, -1 - value)));
    else if (typeof value === "string") {
      const bytes = encoder.encode(value);
      out.push(...head(3, bytes.length), ...bytes);
    } else if (value instanceof Uint8Array) out.push(...head(2, value.length), ...value);
    else if (Array.isArray(value)) {
      out.push(...head(4, value.length));
      for (const one of value) put(one);
    } else {
      out.push(...head(5, value.size));
      for (const [key, one] of value) {
        put(key);
        put(one);
      }
    }
  };
  put(item);
  return Uint8Array.from(out);
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const u32 = (n: number) => Uint8Array.from([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

/** ECDSA's raw r || s as the DER an authenticator sends. */
function toDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const body = Array.from(bytes.subarray(start));
    if (body[0]! & 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const r = integer(raw.subarray(0, raw.length / 2));
  const s = integer(raw.subarray(raw.length / 2));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

export type Alg = -7 | -8 | -257;

export type Flags = { up?: boolean; uv?: boolean };

export type Ceremony = {
  challenge: string;
  origin: string;
  rpId: string;
  flags?: Flags;
  /** What goes in clientDataJSON's `type`, when a test wants the wrong ceremony. */
  type?: string;
};

export class SoftAuthenticator {
  readonly id: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
  signCount = 0;

  private constructor(
    readonly alg: Alg,
    private readonly keys: CryptoKeyPair,
    private readonly cose: Uint8Array,
  ) {}

  static async create(alg: Alg): Promise<SoftAuthenticator> {
    if (alg === -7) {
      const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
      const cose = cbor(new Map<number, Item>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
      return new SoftAuthenticator(alg, keys, cose);
    }
    if (alg === -8) {
      const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
      const cose = cbor(new Map<number, Item>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, "base64url")]]));
      return new SoftAuthenticator(alg, keys, cose);
    }
    const keys = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const cose = cbor(new Map<number, Item>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n!, "base64url")], [-2, Buffer.from(jwk.e!, "base64url")]]));
    return new SoftAuthenticator(alg, keys, cose);
  }

  get credentialId(): string {
    return b64url(this.id);
  }

  private async authData(rpId: string, flags: Flags, attested: boolean): Promise<Uint8Array> {
    const byte = (flags.up === false ? 0 : 0x01) | (flags.uv === false ? 0 : 0x04) | (attested ? 0x40 : 0);
    const head = concat(await sha256(encoder.encode(rpId)), Uint8Array.of(byte), u32(this.signCount));
    if (!attested) return head;
    return concat(head, new Uint8Array(16), Uint8Array.of(this.id.length >> 8, this.id.length & 255), this.id, this.cose);
  }

  private clientData(ceremony: Ceremony, type: string): Uint8Array {
    return encoder.encode(JSON.stringify({ type: ceremony.type ?? type, challenge: ceremony.challenge, origin: ceremony.origin, crossOrigin: false }));
  }

  /** What navigator.credentials.create() answers, fields as the page serialises them (base64url). */
  async register(ceremony: Ceremony): Promise<{ id: string; rawId: string; type: "public-key"; response: { clientDataJSON: string; attestationObject: string; transports: string[] } }> {
    const authData = await this.authData(ceremony.rpId, ceremony.flags ?? {}, true);
    const attestation = cbor(new Map<string, Item>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: { clientDataJSON: b64url(this.clientData(ceremony, "webauthn.create")), attestationObject: b64url(attestation), transports: ["internal"] },
    };
  }

  /** What navigator.credentials.get() answers: the counter goes up by one unless `signCount` is given. */
  async sign(ceremony: Ceremony & { signCount?: number; userHandle?: string | null }): Promise<{
    id: string;
    rawId: string;
    type: "public-key";
    response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
  }> {
    this.signCount = ceremony.signCount ?? this.signCount + 1;
    const authData = await this.authData(ceremony.rpId, ceremony.flags ?? {}, false);
    const clientData = this.clientData(ceremony, "webauthn.get");
    const signed = concat(authData, await sha256(clientData));
    let signature: Uint8Array;
    if (this.alg === -7) signature = toDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed)));
    else if (this.alg === -8) signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.keys.privateKey, signed));
    else signature = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, this.keys.privateKey, signed));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: ceremony.userHandle === undefined ? b64url(encoder.encode("1")) : ceremony.userHandle,
      },
    };
  }
}
