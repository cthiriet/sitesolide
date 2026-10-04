import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_BYTES, DecryptionError, HEADER_BYTES, TAG_BYTES, decodeHeader, decryptStream, encryptFile, newMaster } from "../src/backup/crypto";

const FOLDER = mkdtempSync(join(tmpdir(), "backup-crypto-"));
afterAll(() => rmSync(FOLDER, { recursive: true, force: true }));

const PASSPHRASE = "a passphrase long enough to pass";
/** The production count costs a few tenths of a second; the tests use the floor the reader accepts. */
const ITERATIONS = 100_000;
/** Small chunks, so that a few kilobytes already make several. */
const CHUNK = 4096;

async function encrypt(plain: Uint8Array, chunk = CHUNK, passphrase = PASSPHRASE): Promise<Uint8Array> {
  const path = join(FOLDER, `plain-${crypto.randomUUID()}`);
  writeFileSync(path, plain);
  const master = await newMaster(passphrase, ITERATIONS);
  const out: Uint8Array[] = [];
  const written = await encryptFile(path, master, async (bytes) => void out.push(bytes.slice()), chunk);
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
      expect(sealed.byteLength).toBe(HEADER_BYTES + plain.byteLength + Math.max(1, Math.ceil(size / CHUNK)) * TAG_BYTES);
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
    for (const position of [20, HEADER_BYTES + 5, HEADER_BYTES + CHUNK + TAG_BYTES + 3, sealed.byteLength - 1]) {
      const damaged = sealed.slice();
      damaged[position]! ^= 1;
      await expect(decrypt(damaged)).rejects.toThrow(DecryptionError);
    }
  });

  test("a copy cut after a whole chunk fails: the last one is flagged", async () => {
    const sealed = await encrypt(crypto.getRandomValues(new Uint8Array(3 * CHUNK)));
    const cut = sealed.subarray(0, HEADER_BYTES + 2 * (CHUNK + TAG_BYTES));
    await expect(decrypt(cut)).rejects.toThrow("damaged or truncated");
    await expect(decrypt(sealed.subarray(0, HEADER_BYTES + 10))).rejects.toThrow(DecryptionError);
  });

  test("chunks swapped fail", async () => {
    const sealed = await encrypt(crypto.getRandomValues(new Uint8Array(3 * CHUNK)));
    const size = CHUNK + TAG_BYTES;
    const swapped = sealed.slice();
    swapped.set(sealed.subarray(HEADER_BYTES, HEADER_BYTES + size), HEADER_BYTES + size);
    swapped.set(sealed.subarray(HEADER_BYTES + size, HEADER_BYTES + 2 * size), HEADER_BYTES);
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
