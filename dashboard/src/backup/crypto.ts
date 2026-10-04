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
 *   8   1   version, 1
 *   9   1   derivation, 1 for PBKDF2-SHA256
 *   10  4   iterations
 *   14  16  derivation salt
 *   30  16  file salt, for HKDF
 *   46  4   plaintext bytes per chunk
 *   50      chunks: ciphertext and its 16-byte tag; the header is the
 *           associated data of every one of them
 *
 * `bun dashboard/backup.ts decrypt <file> <output>` reads it back anywhere,
 * with the passphrase alone: see src/backup/README.md.
 */
import { open } from "node:fs/promises";
import { ByteSource } from "./tar";

export const MAGIC = "SSBACKUP";
export const VERSION = 1;
export const KDF_PBKDF2_SHA256 = 1;
export const ITERATIONS = 600_000;
export const CHUNK_BYTES = 1024 * 1024;
export const HEADER_BYTES = 50;
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

export function encodeHeader(header: Header): Bytes {
  const bytes = new Uint8Array(HEADER_BYTES);
  bytes.set(new TextEncoder().encode(MAGIC), 0);
  bytes[8] = VERSION;
  bytes[9] = KDF_PBKDF2_SHA256;
  const view = new DataView(bytes.buffer);
  view.setUint32(10, header.iterations);
  bytes.set(header.kdfSalt, 14);
  bytes.set(header.fileSalt, 30);
  view.setUint32(46, header.chunkBytes);
  return bytes;
}

export function decodeHeader(bytes: Uint8Array): Header {
  if (bytes.byteLength < HEADER_BYTES || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
    throw new DecryptionError("not an encrypted sitesolide backup");
  }
  if (bytes[8] !== VERSION) throw new DecryptionError(`unknown format version ${bytes[8]}`);
  if (bytes[9] !== KDF_PBKDF2_SHA256) throw new DecryptionError("unknown key derivation");
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const iterations = view.getUint32(10);
  const chunkBytes = view.getUint32(46);
  if (iterations < ITERATIONS_RANGE[0] || iterations > ITERATIONS_RANGE[1]) throw new DecryptionError("implausible iteration count in the header");
  if (chunkBytes < CHUNK_RANGE[0] || chunkBytes > CHUNK_RANGE[1]) throw new DecryptionError("implausible chunk size in the header");
  return { iterations, kdfSalt: bytes.slice(14, 30), fileSalt: bytes.slice(30, 46), chunkBytes };
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
 * is not one.
 */
export async function encryptFile(path: string, master: Master, write: (bytes: Uint8Array) => Promise<void>, chunkBytes = CHUNK_BYTES): Promise<number> {
  const header = encodeHeader({ iterations: master.iterations, kdfSalt: master.kdfSalt, fileSalt: crypto.getRandomValues(new Uint8Array(16)), chunkBytes });
  const key = await fileKey(master.key, header.subarray(30, 46));
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const chunks = Math.max(1, Math.ceil(size / chunkBytes));
    await write(header);
    let total = HEADER_BYTES;
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
  masters: Map<string, CryptoKey> = new Map(),
): Promise<number> {
  const source = new ByteSource(stream);
  try {
    const headerBytes = await source.exact(HEADER_BYTES);
    if (headerBytes === null) throw new DecryptionError("not an encrypted sitesolide backup");
    const header = decodeHeader(headerBytes);
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
      if (last) return total;
      current = next;
    }
  } finally {
    await source.cancel();
  }
}
