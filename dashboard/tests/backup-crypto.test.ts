import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_BYTES, DecryptionError, HEADER_BYTES, TAG_BYTES, VERSION, VERSION_UNBOUND, decodeHeader, decryptStream, encryptFile, newMaster } from "../src/backup/crypto";

const FOLDER = mkdtempSync(join(tmpdir(), "backup-crypto-"));
afterAll(() => rmSync(FOLDER, { recursive: true, force: true }));

const PASSPHRASE = "a passphrase long enough to pass";
/** The production count costs a few tenths of a second; the tests use the floor the reader accepts. */
const ITERATIONS = 100_000;
/** Small chunks, so that a few kilobytes already make several. */
const CHUNK = 4096;
/** The name the copies of these tests are stored under. */
const KEY = "sitesolide/cms/cms-20261004T130000Z.tar.gz.enc";
/** What a version 2 header weighs with that key. */
const SEALED_HEADER = HEADER_BYTES + 2 + new TextEncoder().encode(KEY).byteLength;

async function encrypt(plain: Uint8Array, chunk = CHUNK, passphrase = PASSPHRASE): Promise<Uint8Array> {
  const path = join(FOLDER, `plain-${crypto.randomUUID()}`);
  writeFileSync(path, plain);
  const master = await newMaster(passphrase, ITERATIONS);
  const out: Uint8Array[] = [];
  const written = await encryptFile(path, KEY, master, async (bytes) => void out.push(bytes.slice()), chunk);
  const sealed = Bun.concatArrayBuffers(out, Infinity, true);
  expect(written).toBe(sealed.byteLength);
  return sealed;
}

async function decrypt(sealed: Uint8Array, passphrase = PASSPHRASE): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  await decryptStream(new Blob([sealed as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>, passphrase, async (bytes) => void out.push(bytes.slice()));
  return Bun.concatArrayBuffers(out, Infinity, true);
}

describe("the offsite encryption", () => {
  test("round trip, across chunks, and on an exact multiple of a chunk", async () => {
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 17]) {
      const plain = crypto.getRandomValues(new Uint8Array(size));
      const sealed = await encrypt(plain);
      expect(sealed.byteLength).toBe(SEALED_HEADER + plain.byteLength + Math.max(1, Math.ceil(size / CHUNK)) * TAG_BYTES);
      expect(await decrypt(sealed)).toEqual(plain);
    }
  });

  test("the default chunk, for a file of several", async () => {
    const plain = crypto.getRandomValues(new Uint8Array(65536));
    const big = new Uint8Array(2 * CHUNK_BYTES + 100);
    for (let i = 0; i < big.byteLength; i += plain.byteLength) big.set(plain.subarray(0, Math.min(plain.byteLength, big.byteLength - i)), i);
    expect(await decrypt(await encrypt(big, CHUNK_BYTES))).toEqual(big);
  });

  test("what leaves the machine does not hold the plaintext", async () => {
    const plain = new TextEncoder().encode("INSERT INTO customers VALUES ('alice@example.org');".repeat(50));
    const sealed = new TextDecoder().decode(await encrypt(plain));
    expect(sealed).not.toContain("alice@example.org");
    expect(sealed).not.toContain("INSERT");
  });

  test("two encryptions of the same file differ: a salt per file", async () => {
    const plain = new Uint8Array(100);
    const [a, b] = [await encrypt(plain), await encrypt(plain)];
    expect(a).not.toEqual(b);
  });

  test("a wrong passphrase says so", async () => {
    const sealed = await encrypt(new Uint8Array(10));
    await expect(decrypt(sealed, "not the right passphrase at all")).rejects.toThrow("wrong passphrase");
  });

  test("one byte changed anywhere fails", async () => {
    const sealed = await encrypt(crypto.getRandomValues(new Uint8Array(3 * CHUNK)));
    for (const position of [20, HEADER_BYTES + 5, SEALED_HEADER + 5, SEALED_HEADER + CHUNK + TAG_BYTES + 3, sealed.byteLength - 1]) {
      const damaged = sealed.slice();
      damaged[position]! ^= 1;
      await expect(decrypt(damaged)).rejects.toThrow(DecryptionError);
    }
  });

  test("a copy cut after a whole chunk fails: the last one is flagged", async () => {
    const sealed = await encrypt(crypto.getRandomValues(new Uint8Array(3 * CHUNK)));
    const cut = sealed.subarray(0, SEALED_HEADER + 2 * (CHUNK + TAG_BYTES));
    await expect(decrypt(cut)).rejects.toThrow("damaged or truncated");
    await expect(decrypt(sealed.subarray(0, SEALED_HEADER + 10))).rejects.toThrow(DecryptionError);
    await expect(decrypt(sealed.subarray(0, HEADER_BYTES + 10))).rejects.toThrow(DecryptionError);
  });

  test("chunks swapped fail", async () => {
    const sealed = await encrypt(crypto.getRandomValues(new Uint8Array(3 * CHUNK)));
    const size = CHUNK + TAG_BYTES;
    const swapped = sealed.slice();
    swapped.set(sealed.subarray(SEALED_HEADER, SEALED_HEADER + size), SEALED_HEADER + size);
    swapped.set(sealed.subarray(SEALED_HEADER + size, SEALED_HEADER + 2 * size), SEALED_HEADER);
    await expect(decrypt(swapped)).rejects.toThrow(DecryptionError);
  });

  test("a forged header cannot make the reader derive for an hour", () => {
    const header = new Uint8Array(HEADER_BYTES);
    header.set(new TextEncoder().encode("SSBACKUP"));
    header[8] = 1;
    header[9] = 1;
    new DataView(header.buffer).setUint32(10, 0xffffffff);
    new DataView(header.buffer).setUint32(46, CHUNK);
    expect(() => decodeHeader(header)).toThrow("implausible iteration count");
    expect(() => decodeHeader(new TextEncoder().encode("not a backup at all, really not one"))).toThrow("not an encrypted sitesolide backup");
  });
});

/**
 * A version 1 copy, sealed by hand from the format crypto.ts documents: the
 * same derivation, a 50-byte header, those 50 bytes as the associated data.
 * Built here rather than by the module, which writes version 2 only.
 */
async function sealVersion1(plain: Uint8Array, passphrase = PASSPHRASE): Promise<Uint8Array> {
  const kdfSalt = crypto.getRandomValues(new Uint8Array(16));
  const fileSalt = crypto.getRandomValues(new Uint8Array(16));
  const header = new Uint8Array(HEADER_BYTES);
  header.set(new TextEncoder().encode("SSBACKUP"));
  header[8] = 1;
  header[9] = 1;
  new DataView(header.buffer).setUint32(10, ITERATIONS);
  header.set(kdfSalt, 14);
  header.set(fileSalt, 30);
  new DataView(header.buffer).setUint32(46, CHUNK);
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: kdfSalt, iterations: ITERATIONS }, material, 256);
  const master = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const info = new TextEncoder().encode("sitesolide backup v1");
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: fileSalt, info }, master, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const chunks = Math.max(1, Math.ceil(plain.byteLength / CHUNK));
  const out: Uint8Array[] = [header];
  for (let index = 0; index < chunks; index++) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(0, BigInt(index));
    iv[11] = index === chunks - 1 ? 1 : 0;
    const part = plain.subarray(index * CHUNK, (index + 1) * CHUNK) as Uint8Array<ArrayBuffer>;
    out.push(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, key, part)));
  }
  return Bun.concatArrayBuffers(out, Infinity, true);
}

describe("a copy is bound to the name it is stored under", () => {
  const read = (sealed: Uint8Array, expectedKey?: string) =>
    decryptStream(
      new Blob([sealed as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>,
      PASSPHRASE,
      async () => undefined,
      expectedKey === undefined ? {} : { expectedKey },
    );

  test("it reads back under its own key, and says which key that is", async () => {
    const sealed = await encrypt(new TextEncoder().encode("alpha's data"));
    expect(decodeHeader(sealed).version).toBe(VERSION);
    expect(await read(sealed, KEY)).toEqual({ bytes: 12, version: 2, sealedFor: KEY });
    expect((await read(sealed)).sealedFor).toBe(KEY);
  });

  test("copied under another project's key, it is refused before a byte is handed over", async () => {
    const sealed = await encrypt(new TextEncoder().encode("alpha's data"));
    let handed = 0;
    await expect(
      decryptStream(new Blob([sealed as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>, PASSPHRASE, async () => void handed++, {
        expectedKey: "sitesolide/beta/beta-20261004T130000Z.tar.gz.enc",
      }),
    ).rejects.toThrow(`this copy was sealed as "${KEY}"`);
    expect(handed).toBe(0);
  });

  test("its key cannot be rewritten in the header: every chunk authenticates it", async () => {
    const sealed = await encrypt(new TextEncoder().encode("alpha's data"));
    const forged = sealed.slice();
    // `cms` in the key becomes `cmt`: the same length, another name.
    forged[HEADER_BYTES + 2 + KEY.indexOf("/cms/") + 3] = "t".charCodeAt(0);
    await expect(read(forged, KEY.replace("/cms/", "/cmt/"))).rejects.toThrow("wrong passphrase, or the encrypted backup is damaged");
  });

  test("a version 1 copy, uploaded before the binding, still reads, and says it names nothing", async () => {
    const plain = crypto.getRandomValues(new Uint8Array(3 * CHUNK + 5));
    const sealed = await sealVersion1(plain);
    expect(await decrypt(sealed)).toEqual(plain);
    expect(await read(sealed, KEY)).toEqual({ bytes: plain.byteLength, version: VERSION_UNBOUND, sealedFor: null });
  });

  test("a key longer than S3 allows is not written", async () => {
    const path = join(FOLDER, "plain-long-key");
    writeFileSync(path, "x");
    const master = await newMaster(PASSPHRASE, ITERATIONS);
    await expect(encryptFile(path, "k".repeat(1025), master, async () => undefined)).rejects.toThrow("1 to 1024 bytes");
  });
});
