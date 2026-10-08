import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractData } from "../src/backup/extract";
import { ArchiveError, BLOCK, TarWriter, cleanEntryPath, gunzip, gzipSink, paxRecord, readTar, type ReadEntry, type Sink } from "../src/backup/tar";

const FOLDER = mkdtempSync(join(tmpdir(), "backup-tar-"));
afterAll(() => rmSync(FOLDER, { recursive: true, force: true }));

const META = { mode: 0o640, mtime: 1_790_000_000, uid: 1001, gid: 1001 };
/** A folder's mode: without the execute bit, nobody, its owner included, could go in. */
const FOLDER_META = { ...META, mode: 0o750 };
const LIMITS = { maxEntries: 1000, maxBytes: 1 << 30 };

function memorySink(): Sink & { bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  return {
    async write(bytes) {
      chunks.push(bytes.slice());
    },
    async close() {},
    bytes: () => Bun.concatArrayBuffers(chunks, Infinity, true),
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>;
}

async function entriesOf(tarBytes: Uint8Array, limits = LIMITS): Promise<(ReadEntry & { content: string })[]> {
  const found: (ReadEntry & { content: string })[] = [];
  await readTar(streamOf(tarBytes), limits, async (entry, data) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of data) chunks.push(chunk);
    found.push({ ...entry, content: new TextDecoder().decode(Bun.concatArrayBuffers(chunks)) });
  });
  return found;
}

// --- Hand-written archives, to forge what the writer never writes ----------------

function field(block: Uint8Array, offset: number, length: number, text: string): void {
  block.set(new TextEncoder().encode(text).subarray(0, length), offset);
}

function rawHeader(name: string | Uint8Array, typeflag: string, size: number, options: { link?: string; magic?: string } = {}): Uint8Array {
  const block = new Uint8Array(BLOCK);
  if (typeof name === "string") field(block, 0, 100, name);
  else block.set(name.subarray(0, 100), 0);
  field(block, 100, 8, "0000644\0");
  field(block, 108, 8, "0000000\0");
  field(block, 116, 8, "0000000\0");
  field(block, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  field(block, 136, 12, "15000000000\0");
  block[156] = typeflag.charCodeAt(0);
  if (options.link !== undefined) field(block, 157, 100, options.link);
  field(block, 257, 8, options.magic ?? "ustar\u000000");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  field(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padded(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(content.byteLength / BLOCK) * BLOCK);
  out.set(content);
  return out;
}

function archive(...parts: Uint8Array[]): Uint8Array {
  return Bun.concatArrayBuffers([...parts, new Uint8Array(2 * BLOCK)], Infinity, true);
}

function fileEntry(name: string, content: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(content);
  return [rawHeader(name, "0", bytes.byteLength), padded(bytes)];
}

async function refusal(bytes: Uint8Array): Promise<string> {
  try {
    await entriesOf(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return (error as Error).message;
  }
  throw new Error("the archive was accepted");
}

describe("writing and reading back", () => {
  test("files, folders, modes and times come back as written", async () => {
    const sink = memorySink();
    const tar = new TarWriter(sink);
    await tar.directory("data", FOLDER_META);
    await tar.file("data/notes.txt", META, 5, new TextEncoder().encode("hello"));
    await tar.directory("data/empty", { ...FOLDER_META, mode: 0o700 });
    await tar.file("data/zero", META, 0, new Uint8Array(0));
    await tar.end();
    // GNU tar's record: the archive is whole records.
    expect(sink.bytes().byteLength % (20 * BLOCK)).toBe(0);

    expect(await entriesOf(sink.bytes())).toEqual([
      { path: "data", type: "directory", size: 0, mode: 0o750, mtime: META.mtime, content: "" },
      { path: "data/notes.txt", type: "file", size: 5, mode: 0o640, mtime: META.mtime, content: "hello" },
      { path: "data/empty", type: "directory", size: 0, mode: 0o700, mtime: META.mtime, content: "" },
      { path: "data/zero", type: "file", size: 0, mode: 0o640, mtime: META.mtime, content: "" },
    ]);
  });

  test("set-id and sticky bits are never written", async () => {
    const sink = memorySink();
    const tar = new TarWriter(sink);
    await tar.file("data/run", { ...META, mode: 0o4755 }, 1, new Uint8Array([1]));
    await tar.end();
    expect((await entriesOf(sink.bytes()))[0]!.mode).toBe(0o755);
  });

  test("long names, accented ones included, go through pax", async () => {
    const deep = `data/${"dossier-très-profond/".repeat(12)}fichier-été.txt`;
    const sink = memorySink();
    const tar = new TarWriter(sink);
    await tar.file(deep, META, 2, new TextEncoder().encode("ok"));
    await tar.file(`data/${"a".repeat(90)}/${"b".repeat(90)}`, META, 0, new Uint8Array(0));
    await tar.end();
    const found = await entriesOf(sink.bytes());
    expect(found.map((entry) => entry.path)).toEqual([deep, `data/${"a".repeat(90)}/${"b".repeat(90)}`]);
    expect(found[0]!.content).toBe("ok");
  });

  test("a file that shrinks or grows while read is padded or cut, and says so", async () => {
    const sink = memorySink();
    const tar = new TarWriter(sink);
    expect(await tar.file("data/short", META, 6, new TextEncoder().encode("abc"))).toBe("shorter");
    expect(await tar.file("data/long", META, 2, new TextEncoder().encode("abcdef"))).toBe("longer");
    expect(await tar.file("data/exact", META, 3, new TextEncoder().encode("abc"))).toBe("exact");
    await tar.end();
    const found = await entriesOf(sink.bytes());
    expect(found.map((entry) => entry.content)).toEqual(["abc\0\0\0", "ab", "abc"]);
  });

  test("the pax length counts bytes, itself included", () => {
    // 2 digits, " path=", 5 bytes for three accented letters, the line feed.
    const record = paxRecord("path", "été");
    expect(new TextDecoder().decode(record)).toBe("14 path=été\n");
    expect(record.byteLength).toBe(14);
    const near = paxRecord("path", "x".repeat(91));
    expect(near.byteLength).toBe(Number(new TextDecoder().decode(near).split(" ")[0]));
  });
});

describe("readable by tar itself, and compressed for the archives of the format before restic", () => {
  test("gzip on the way out, and back: the archives the import reads", async () => {
    const sink = memorySink();
    const tar = new TarWriter(gzipSink(sink));
    await tar.directory("data", FOLDER_META);
    await tar.file("data/big.bin", META, 3 * 1024 * 1024, new Uint8Array(3 * 1024 * 1024).fill(7));
    await tar.end();
    const compressed = sink.bytes();
    expect([compressed[0], compressed[1]]).toEqual([0x1f, 0x8b]);
    expect(compressed.byteLength).toBeLessThan(100_000);
    const found: ReadEntry[] = [];
    await readTar(gunzip(streamOf(compressed)), LIMITS, async (entry) => {
      found.push(entry);
    });
    expect(found.map((entry) => [entry.path, entry.size])).toEqual([
      ["data", 0],
      ["data/big.bin", 3 * 1024 * 1024],
    ]);
  });

  test("tar -xf reads what this writer writes, as restic stores it", async () => {
    const sink = memorySink();
    const tar = new TarWriter(sink);
    await tar.directory("data", FOLDER_META);
    await tar.file("data/a.txt", META, 3, new TextEncoder().encode("one"));
    await tar.file(`data/${"x".repeat(150)}.txt`, META, 3, new TextEncoder().encode("two"));
    await tar.end();
    const path = join(FOLDER, "ours.tar");
    writeFileSync(path, sink.bytes());
    const out = join(FOLDER, "out-system");
    mkdirSync(out);
    const extraction = Bun.spawnSync(["tar", "-xf", path, "-C", out]);
    expect(extraction.exitCode).toBe(0);
    expect(readFileSync(join(out, "data", "a.txt"), "utf8")).toBe("one");
    expect(readFileSync(join(out, "data", `${"x".repeat(150)}.txt`), "utf8")).toBe("two");
  });

  test("this reader reads what tar -czf writes", async () => {
    const source = join(FOLDER, "made-by-tar");
    mkdirSync(join(source, "data", "sub"), { recursive: true });
    writeFileSync(join(source, "data", "sub", "file.txt"), "from tar");
    const path = join(FOLDER, "theirs.tar.gz");
    const creation = Bun.spawnSync(["tar", "-czf", path, "-C", source, "data"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    expect(creation.exitCode).toBe(0);
    const found = await entriesOf(await new Response(gunzip(Bun.file(path).stream() as ReadableStream<Uint8Array>)).bytes());
    expect(found.find((entry) => entry.path === "data/sub/file.txt")?.content).toBe("from tar");
  });
});

describe("the reader refuses what could leave the destination", () => {
  test("an absolute path", async () => {
    expect(await refusal(archive(...fileEntry("/etc/cron.d/evil", "x")))).toContain("absolute path");
  });

  test("a path that climbs, even after a folder", async () => {
    expect(await refusal(archive(...fileEntry("data/../../etc/passwd", "x")))).toContain("climbing");
    expect(await refusal(archive(...fileEntry("..", "x")))).toContain("climbing");
  });

  test("a symbolic link, a hard link, a device, a pipe", async () => {
    expect(await refusal(archive(rawHeader("data/link", "2", 0, { link: "/etc/shadow" })))).toContain("symbolic link");
    expect(await refusal(archive(rawHeader("data/hard", "1", 0, { link: "data/x" })))).toContain("hard link");
    expect(await refusal(archive(rawHeader("data/dev", "3", 0)))).toContain("character device");
    expect(await refusal(archive(rawHeader("data/fifo", "6", 0)))).toContain("named pipe");
  });

  test("a pax header that names a climbing path", async () => {
    const record = paxRecord("path", "data/../../../root/.ssh/authorized_keys");
    expect(await refusal(archive(rawHeader("pax", "x", record.byteLength), padded(record), ...fileEntry("data/ok", "x")))).toContain("climbing");
  });

  test("a GNU long name that climbs", async () => {
    const name = new TextEncoder().encode("data/../../evil\0");
    expect(await refusal(archive(rawHeader("././@LongLink", "L", name.byteLength), padded(name), ...fileEntry("data/ok", "x")))).toContain("climbing");
  });

  test("a name that is not UTF-8", async () => {
    const name = new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x2f, 0xff, 0xfe]);
    expect(await refusal(archive(rawHeader(name, "0", 0)))).toContain("UTF-8");
  });

  test("a damaged header, another format, a cut archive", async () => {
    const damaged = archive(...fileEntry("data/a", "x"));
    damaged[10] = 0x41;
    expect(await refusal(damaged)).toContain("checksum");
    expect(await refusal(archive(rawHeader("data/a", "0", 0, { magic: "garbage!" })))).toContain("not a ustar");
    const full = archive(...fileEntry("data/a", "content"));
    expect(await refusal(full.subarray(0, BLOCK + 3))).toContain("truncated");
    expect(await refusal(full.subarray(0, 2 * BLOCK))).toContain("no end marker");
  });

  test("more entries or more bytes than allowed", async () => {
    const many = archive(...fileEntry("data/a", "x"), ...fileEntry("data/b", "y"), ...fileEntry("data/c", "z"));
    await expect(entriesOf(many, { maxEntries: 2, maxBytes: 1000 })).rejects.toThrow("more than 2 entries");
    await expect(entriesOf(many, { maxEntries: 10, maxBytes: 2 })).rejects.toThrow("more data than there is room for");
  });

  test("a damaged gzip fails while being read", async () => {
    const sink = memorySink();
    const tar = new TarWriter(gzipSink(sink));
    await tar.file("data/a", META, 100_000, crypto.getRandomValues(new Uint8Array(65536)));
    await tar.end();
    const bytes = sink.bytes();
    const cut = bytes.slice(0, bytes.byteLength - 20);
    await expect(readTar(gunzip(streamOf(cut)), LIMITS, async () => {})).rejects.toThrow();
  });

  test("the path rule, entry by entry", () => {
    expect(cleanEntryPath("./data/a/")).toEqual({ path: "data/a" });
    expect(cleanEntryPath("data//a")).toHaveProperty("refusal");
    expect(cleanEntryPath("data/./a")).toHaveProperty("refusal");
    expect(cleanEntryPath(`data/${"a".repeat(256)}`)).toHaveProperty("refusal");
    expect(cleanEntryPath("")).toHaveProperty("refusal");
  });
});

describe("the extraction", () => {
  async function extract(bytes: Uint8Array, destination: string) {
    mkdirSync(destination, { recursive: true });
    return extractData(streamOf(bytes), destination, LIMITS);
  }

  test("writes data/ and only data/, with modes and times", async () => {
    const sink = memorySink();
    const tar = new TarWriter(sink);
    await tar.directory("data", FOLDER_META);
    await tar.directory("data/sub", { ...META, mode: 0o700 });
    await tar.file("data/sub/a.txt", { ...META, mode: 0o600 }, 3, new TextEncoder().encode("one"));
    await tar.file("sitesolide-backup.json", META, 13, new TextEncoder().encode('{"format": 1}'));
    await tar.end();
    const destination = join(FOLDER, "x1");
    const summary = await extract(sink.bytes(), destination);
    expect(summary).toEqual({ files: 1, directories: 1, bytes: 3, description: { format: 1 } });
    expect(readdirSync(destination)).toEqual(["sub"]);
    expect(readFileSync(join(destination, "sub", "a.txt"), "utf8")).toBe("one");
    expect(statSync(join(destination, "sub", "a.txt")).mode & 0o777).toBe(0o600);
    expect(Math.floor(statSync(join(destination, "sub", "a.txt")).mtimeMs / 1000)).toBe(META.mtime);
    expect(Math.floor(statSync(join(destination, "sub")).mtimeMs / 1000)).toBe(META.mtime);
  });

  test("refuses an entry beside data/", async () => {
    await expect(extract(archive(...fileEntry("etc/passwd", "x")), join(FOLDER, "x2"))).rejects.toThrow("outside data/");
  });

  test("refuses the same path twice, rather than overwrite", async () => {
    await expect(extract(archive(...fileEntry("data/a", "1"), ...fileEntry("data/a", "2")), join(FOLDER, "x3"))).rejects.toThrow("twice");
  });

  test("refuses a file and a folder under one name", async () => {
    await expect(extract(archive(...fileEntry("data/a", "1"), rawHeader("data/a/", "5", 0)), join(FOLDER, "x4"))).rejects.toThrow("share a path");
  });

  test("refuses a destination that is not empty, and never follows a link found there", async () => {
    const destination = join(FOLDER, "x5");
    mkdirSync(destination);
    symlinkSync("/tmp", join(destination, "sub"));
    await expect(extract(archive(...fileEntry("data/sub/evil", "x")), destination)).rejects.toThrow("not empty");
    expect(lstatSync(join(destination, "sub")).isSymbolicLink()).toBe(true);
  });
});
