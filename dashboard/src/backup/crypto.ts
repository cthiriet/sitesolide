/**
 * The encryption of the copies sent to the bucket: AES-256-GCM through
 * WebCrypto, on the machine, before anything leaves it. The bucket's provider
 * stores bytes it cannot read, and a stolen access key yields nothing without
 * the passphrase.
 *
 * GCM seals a message whole, and an archive can weigh gigabytes: it is cut into
 * chunks of 1 MiB, each sealed on its own, with a nonce made of its rank and a
 * flag on the last one. That is the "STREAM" construction (Hoang, Reyhanitabar,
 * Rogaway, Vizár, 2015), the one `age` and Tink use: a chunk moved, repeated
 * or dropped fails its tag, and so does a file cut after any chunk but the
 * flagged last one. Memory stays at one chunk whatever the size.
 *
 * The key: PBKDF2-SHA256 over the passphrase, with a salt drawn for each run,
 * 600,000 iterations (OWASP's figure for that function in 2023). WebCrypto has
 * neither scrypt nor argon2, and adding a dependency to a root component for
 * that was not worth it: the passphrase is drawn by the dashboard's *Generate*,
 * 32 random bytes, and no derivation would make a weak one strong. From that
 * key, HKDF-SHA256 draws one key per file with a salt of its own: two files
 * never share a key, so their nonces never meet.
 *
 * The format, every number big-endian:
 *
 *   0   8   "SSBACKUP"
 *   8   1   version, 2
 *   9   1   derivation, 1 for PBKDF2-SHA256
 *   10  4   iterations
 *   14  16  derivation salt
 *   30  16  file salt, for HKDF
 *   46  4   plaintext bytes per chunk
 *   50  2   length of the object's key, in bytes
 *   52  n   the object's key, UTF-8: `<prefix>/<folder>/<snapshot>.enc`
 *   52+n    chunks: ciphertext and its 16-byte tag; the whole header, key
 *           included, is the associated data of every one of them
 *
 * **Why the key is sealed in.** Without it, a copy is bound to the passphrase
 * and nothing else: someone who may write to the bucket, and only that, could
 * copy project alpha's object under beta's prefix, and an admin restoring beta
 * would hand alpha's data to beta's service. The key sits in the header, which
 * every chunk authenticates: it cannot be changed without failing them all,
 * and the restore refuses an object sealed for another key than the one it
 * fetched. By hand, `decrypt` prints the key the object was sealed for.
 *
 * Version 1 is the same without the two key fields (the header is 50 bytes,
 * and those 50 bytes are the associated data). It is still read, by the
 * restore and by `decrypt`: the objects uploaded before version 2 must stay
 * restorable, and refusing them would cost exactly the copies a lost machine
 * needs. They carry no name, which the reader reports; retention replaces
 * them with sealed ones as it prunes, within the policy's horizon (four weeks
 * by default). None is written any more.
 *
 * `bun dashboard/backup.ts decrypt <file> <output>` reads it back anywhere,
 * with the passphrase alone: see src/backup/README.md.
 */
import { open } from "node:fs/promises";
import { ByteSource } from "./tar";

export const MAGIC = "SSBACKUP";
/** The version written: the object's key sealed in the header. */
export const VERSION = 2;
/** The version before it, without the key: read, never written. */
export const VERSION_UNBOUND = 1;
export const KDF_PBKDF2_SHA256 = 1;
export const ITERATIONS = 600_000;
export const CHUNK_BYTES = 1024 * 1024;
/** The fixed part of the header, the whole of it in version 1. */
export const HEADER_BYTES = 50;
/** A key longer than this is not one of ours: S3 itself stops at 1024 bytes. */
export const MAX_KEY_BYTES = 1024;
export const TAG_BYTES = 16;
/** A passphrase shorter than this is refused: offsite copies stay off rather than weakly sealed. */
export const MIN_PASSPHRASE = 16;
/** The bounds a header is read within: a forged one must not make the reader derive for an hour. */
const ITERATIONS_RANGE = [100_000, 10_000_000] as const;
const CHUNK_RANGE = [4096, 16 * 1024 * 1024] as const;
const INFO = new TextEncoder().encode("sitesolide backup v1");

export class DecryptionError extends Error {
  override name = "DecryptionError";
}

/** Bytes WebCrypto accepts: backed by an ArrayBuffer of their own, never a shared one. */
type Bytes = Uint8Array<ArrayBuffer>;

export type Header = { iterations: number; kdfSalt: Bytes; fileSalt: Bytes; chunkBytes: number };

/** The fixed part, as both versions read it: the key, if any, follows it. */
export type FixedHeader = Header & { version: number };

/** A version 2 header: the fixed part, the key's length, the key. */
export function encodeHeader(header: Header, key: string): Bytes {
  const keyBytes = new TextEncoder().encode(key);
  if (keyBytes.byteLength === 0 || keyBytes.byteLength > MAX_KEY_BYTES) throw new Error("an object's key must be 1 to 1024 bytes long");
  const bytes = new Uint8Array(HEADER_BYTES + 2 + keyBytes.byteLength);
  bytes.set(new TextEncoder().encode(MAGIC), 0);
  bytes[8] = VERSION;
  bytes[9] = KDF_PBKDF2_SHA256;
  const view = new DataView(bytes.buffer);
  view.setUint32(10, header.iterations);
  bytes.set(header.kdfSalt, 14);
  bytes.set(header.fileSalt, 30);
  view.setUint32(46, header.chunkBytes);
  view.setUint16(HEADER_BYTES, keyBytes.byteLength);
  bytes.set(keyBytes, HEADER_BYTES + 2);
  return bytes;
}

/** The fixed 50 bytes, judged. Version 2 says how many bytes of key follow. */
export function decodeHeader(bytes: Uint8Array): FixedHeader {
  if (bytes.byteLength < HEADER_BYTES || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
    throw new DecryptionError("not an encrypted sitesolide backup");
  }
  const version = bytes[8]!;
  if (version !== VERSION && version !== VERSION_UNBOUND) throw new DecryptionError(`unknown format version ${version}`);
  if (bytes[9] !== KDF_PBKDF2_SHA256) throw new DecryptionError("unknown key derivation");
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const iterations = view.getUint32(10);
  const chunkBytes = view.getUint32(46);
  if (iterations < ITERATIONS_RANGE[0] || iterations > ITERATIONS_RANGE[1]) throw new DecryptionError("implausible iteration count in the header");
  if (chunkBytes < CHUNK_RANGE[0] || chunkBytes > CHUNK_RANGE[1]) throw new DecryptionError("implausible chunk size in the header");
  return { version, iterations, kdfSalt: bytes.slice(14, 30), fileSalt: bytes.slice(30, 46), chunkBytes };
}

/** The key all of a run's files derive from. Costly on purpose: derived once per run, not per file. */
export async function deriveMaster(passphrase: string, kdfSalt: Bytes, iterations = ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: kdfSalt, iterations }, material, 256);
  return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
}

async function fileKey(master: CryptoKey, fileSalt: Bytes): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: fileSalt, info: INFO }, master, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** The rank on eight bytes, three zeros, and the last-chunk flag. */
function nonce(index: number, last: boolean): Bytes {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(index));
  bytes[11] = last ? 1 : 0;
  return bytes;
}

export type Master = { key: CryptoKey; kdfSalt: Bytes; iterations: number };

/** A run's master key, with a fresh salt. */
export async function newMaster(passphrase: string, iterations = ITERATIONS): Promise<Master> {
  const kdfSalt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveMaster(passphrase, kdfSalt, iterations), kdfSalt, iterations };
}

/**
 * Encrypts a file into `write`, chunk by chunk, read at known positions: the
 * last chunk is known from the size, with no lookahead. Returns the number of
 * bytes written. A file that changes size while being read is refused: the
 * archives are never written in place, so that only happens to a file that
 * is not one. `objectKey` is the name the copy is stored under, sealed in.
 */
export async function encryptFile(
  path: string,
  objectKey: string,
  master: Master,
  write: (bytes: Uint8Array) => Promise<void>,
  chunkBytes = CHUNK_BYTES,
): Promise<number> {
  const header = encodeHeader(
    { iterations: master.iterations, kdfSalt: master.kdfSalt, fileSalt: crypto.getRandomValues(new Uint8Array(16)), chunkBytes },
    objectKey,
  );
  const key = await fileKey(master.key, header.slice(30, 46));
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const chunks = Math.max(1, Math.ceil(size / chunkBytes));
    await write(header);
    let total = header.byteLength;
    const buffer = new Uint8Array(chunkBytes);
    for (let index = 0; index < chunks; index++) {
      const wanted = Math.min(chunkBytes, size - index * chunkBytes);
      let got = 0;
      while (got < wanted) {
        const { bytesRead } = await handle.read(buffer, got, wanted - got, index * chunkBytes + got);
        if (bytesRead === 0) throw new Error("the archive shrank while being encrypted");
        got += bytesRead;
      }
      const last = index === chunks - 1;
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(index, last), additionalData: header }, key, buffer.subarray(0, wanted)),
      );
      await write(sealed);
      total += sealed.byteLength;
    }
    if ((await handle.stat()).size !== size) throw new Error("the archive changed while being encrypted");
    return total;
  } finally {
    await handle.close();
  }
}

/** What a decryption read: its size, its version, and the key it was sealed for (null in version 1). */
export type Decrypted = { bytes: number; version: number; sealedFor: string | null };

export type DecryptOptions = {
  /**
   * The key the object was fetched from. A version 2 object sealed for
   * another key is refused before a byte is handed over; a version 1 object
   * names none and is accepted, its `sealedFor` null says so.
   */
  expectedKey?: string;
  /** Master keys already derived, by salt: a run reads several objects of one passphrase. */
  masters?: Map<string, CryptoKey>;
};

/**
 * Decrypts a stream into `write`. Every chunk is checked before it is handed
 * over, and the end must be the flagged last chunk: a truncated object fails
 * here, never later as a short archive. A wrong passphrase fails on the first
 * chunk, with a message that says so.
 */
export async function decryptStream(
  stream: ReadableStream<Uint8Array>,
  passphrase: string,
  write: (bytes: Uint8Array) => Promise<void>,
  options: DecryptOptions = {},
): Promise<Decrypted> {
  const masters = options.masters ?? new Map<string, CryptoKey>();
  const source = new ByteSource(stream);
  try {
    const fixed = await source.exact(HEADER_BYTES);
    if (fixed === null) throw new DecryptionError("not an encrypted sitesolide backup");
    const header = decodeHeader(fixed);
    // Version 2: the key follows, and the associated data is the whole header.
    let headerBytes: Uint8Array<ArrayBuffer> = fixed;
    let sealedFor: string | null = null;
    if (header.version === VERSION) {
      const lengthBytes = await source.exact(2);
      if (lengthBytes === null) throw new DecryptionError("the encrypted backup is truncated");
      const length = new DataView(lengthBytes.buffer).getUint16(0);
      if (length === 0 || length > MAX_KEY_BYTES) throw new DecryptionError("implausible key length in the header");
      const keyBytes = await source.exact(length);
      if (keyBytes === null) throw new DecryptionError("the encrypted backup is truncated");
      try {
        sealedFor = new TextDecoder("utf-8", { fatal: true }).decode(keyBytes);
      } catch {
        throw new DecryptionError("the key in the header is not UTF-8");
      }
      headerBytes = Bun.concatArrayBuffers([fixed, lengthBytes, keyBytes], Infinity, true) as Uint8Array<ArrayBuffer>;
      if (options.expectedKey !== undefined && sealedFor !== options.expectedKey) {
        throw new DecryptionError(`this copy was sealed as ${JSON.stringify(sealedFor.slice(0, 200))}, not as the object it was read from: refused`);
      }
    }
    const cacheKey = `${header.iterations}:${[...header.kdfSalt].join(",")}`;
    let master = masters.get(cacheKey);
    if (master === undefined) {
      master = await deriveMaster(passphrase, header.kdfSalt, header.iterations);
      masters.set(cacheKey, master);
    }
    const key = await fileKey(master, header.fileSalt);

    const sealedBytes = header.chunkBytes + TAG_BYTES;
    let total = 0;
    let current = await source.upTo(sealedBytes);
    for (let index = 0; ; index++) {
      if (current.byteLength < TAG_BYTES) throw new DecryptionError("the encrypted backup is truncated");
      // A full chunk is the last one only if nothing follows it.
      const next = current.byteLength === sealedBytes ? await source.upTo(sealedBytes) : new Uint8Array(0);
      const last = next.byteLength === 0;
      let plain: ArrayBuffer;
      try {
        plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(index, last), additionalData: headerBytes }, key, current);
      } catch {
        throw new DecryptionError(
          index === 0 ? "wrong passphrase, or the encrypted backup is damaged" : "the encrypted backup is damaged or truncated",
        );
      }
      await write(new Uint8Array(plain));
      total += plain.byteLength;
      if (last) return { bytes: total, version: header.version, sealedFor };
      current = next;
    }
  } finally {
    await source.cancel();
  }
}
