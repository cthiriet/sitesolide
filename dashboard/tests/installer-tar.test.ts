import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle, entryBlocks, header, paxRecord, tarArchive, type BundleEntry } from "../borrowed/bundle";
import { extract } from "../src/installer/extract";
import { checkPath, createTarReader, TarRefusal, type TarSink } from "../src/installer/tar";

/**
 * The archive a token sends, read by the reader the installer runs as the
 * project's account. The archives below are written by hand, block by block,
 * with the CLI's own writer for the honest parts: what a malicious client
 * would send, and what must be refused rather than skipped.
 */

const LIMITS = { maxBytes: 1024 * 1024, maxEntries: 100, maxPathBytes: 1024 };
const encoder = new TextEncoder();
const MTIME = 1_789_000_000;

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "installer-tar-"));
  toClean.push(path);
  const destination = join(path, "staging");
  mkdirSync(destination);
  return destination;
}

const file = (path: string, content = "x", executable = false): BundleEntry => ({ kind: "file", path, mtime: MTIME, executable, content: encoder.encode(content) });
const dir = (path: string): BundleEntry => ({ kind: "directory", path, mtime: MTIME });

/** Blocks put end to end, the end-of-archive added, gzip around it. */
function archive(...blocks: Uint8Array[]): Uint8Array {
  const all = [...blocks, new Uint8Array(1024)];
  const total = all.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of all) {
    out.set(block, offset);
    offset += block.length;
  }
  return Bun.gzipSync(out);
}

/** An entry header with no data: links, devices, pipes. */
function special(name: string, type: string): Uint8Array {
  return header(name, { type, mode: 0o777, size: 0, mtime: MTIME });
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream();
}

async function refused(bytes: Uint8Array, limits = LIMITS): Promise<string> {
  const destination = folder();
  const outcome = await extract(stream(bytes), destination, limits);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome.reason;
}

describe("an honest archive", () => {
  test("extracts app/ and public/, modes and dates kept, executables executable", async () => {
    const destination = folder();
    const bytes = bundle([dir("app"), file("app/server.ts", "console.log(1)"), file("app/bin/run", "#!/bin/sh", true), dir("public"), file("public/index.html", "<h1>hi</h1>")]);
    const outcome = await extract(stream(bytes), destination, LIMITS);
    expect(outcome).toEqual({ ok: true, summary: { files: 3, directories: 3, bytes: 14 + 9 + 11 } });
    expect(readFileSync(join(destination, "app/server.ts"), "utf8")).toBe("console.log(1)");
    expect(statSync(join(destination, "app/bin/run")).mode & 0o777).toBe(0o755);
    expect(statSync(join(destination, "public/index.html")).mode & 0o777).toBe(0o644);
    expect(Math.floor(statSync(join(destination, "public/index.html")).mtimeMs / 1000)).toBe(MTIME);
  });

  test("a path longer than the header's field travels in a pax record", async () => {
    const destination = folder();
    const long = `app/${"deep/".repeat(30)}file.txt`;
    const outcome = await extract(stream(bundle([file(long, "deep")])), destination, LIMITS);
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(destination, long), "utf8")).toBe("deep");
  });

  test("GNU's long name and git archive's comment-only global header are read", async () => {
    const destination = folder();
    const long = `public/${"n".repeat(120)}.html`;
    const name = encoder.encode(`${long}\0`);
    const padded = new Uint8Array(Math.ceil(name.length / 512) * 512);
    padded.set(name);
    const comment = encoder.encode(paxRecord("comment", "0123abcd"));
    const commentBlock = new Uint8Array(512);
    commentBlock.set(comment);
    const bytes = archive(
      header("pax_global_header", { type: "g", mode: 0o644, size: comment.length, mtime: MTIME }),
      commentBlock,
      header("././@LongLink", { type: "L", mode: 0o644, size: name.length, mtime: MTIME }),
      padded,
      ...entryBlocks(file("public/placeholder", "gnu")),
    );
    const outcome = await extract(stream(bytes), destination, LIMITS);
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(destination, long), "utf8")).toBe("gnu");
  });

  test("a leading ./ is the archive's root, and is read away", () => {
    expect(checkPath("./app/x", LIMITS)).toBe("app/x");
    expect(checkPath("./", LIMITS)).toBeNull();
    expect(checkPath("app/", LIMITS)).toBe("app");
  });
});

describe("what is refused, never skipped", () => {
  test("a path climbing out, anywhere in it", async () => {
    expect(await refused(archive(...entryBlocks(file("app/../../etc/passwd"))))).toContain("climbing");
    expect(await refused(archive(...entryBlocks(file("../outside"))))).toContain("climbing");
    expect(await refused(archive(...entryBlocks(file("app/a/../../b"))))).toContain("climbing");
  });

  test("an absolute path", async () => {
    expect(await refused(archive(...entryBlocks(file("/etc/cron.d/evil"))))).toContain("absolute");
  });

  test("a symbolic link, a hard link, a device, a named pipe", async () => {
    expect(await refused(archive(special("app/link", "2")))).toContain("symbolic link");
    expect(await refused(archive(...entryBlocks(file("app/a")), special("app/hard", "1")))).toContain("hard link");
    expect(await refused(archive(special("app/tty", "3")))).toContain("character device");
    expect(await refused(archive(special("app/disk", "4")))).toContain("block device");
    expect(await refused(archive(special("app/fifo", "6")))).toContain("named pipe");
  });

  test("a link smuggled through a pax record", async () => {
    const record = encoder.encode(paxRecord("linkpath", "/etc/shadow"));
    const block = new Uint8Array(512);
    block.set(record);
    expect(await refused(archive(header("PaxHeader", { type: "x", mode: 0o644, size: record.length, mtime: MTIME }), block, ...entryBlocks(file("app/a"))))).toContain("link");
  });

  test("a global header that changes paths", async () => {
    const record = encoder.encode(paxRecord("path", "app/x"));
    const block = new Uint8Array(512);
    block.set(record);
    expect(await refused(archive(header("pax_global_header", { type: "g", mode: 0o644, size: record.length, mtime: MTIME }), block))).toContain("global");
  });

  test("a path given twice, and a file then a directory of the same name", async () => {
    expect(await refused(archive(...entryBlocks(file("app/a", "1")), ...entryBlocks(file("app/a", "2"))))).toContain("twice");
    expect(await refused(archive(...entryBlocks(file("app/a")), ...entryBlocks(dir("app/a"))))).toContain("both a file and a directory");
    expect(await refused(archive(...entryBlocks(file("app/a")), ...entryBlocks(file("app/a/b"))))).toContain("under a file");
  });

  test("anything outside app/ and public/, and a file standing for one of them", async () => {
    expect(await refused(archive(...entryBlocks(file("etc/x"))))).toContain("app/ and public/");
    expect(await refused(archive(...entryBlocks(file("sitesolide.json"))))).toContain("app/ and public/");
    expect(await refused(archive(...entryBlocks(file("app"))))).toContain("must be a directory");
  });

  test("more data than allowed once extracted, counted before it is written", async () => {
    const destination = folder();
    const big = { kind: "file" as const, path: "app/big", mtime: MTIME, executable: false, content: new Uint8Array(2048) };
    const outcome = await extract(stream(bundle([big])), destination, { ...LIMITS, maxBytes: 1024 });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toContain("more than 1024 bytes");
    expect(existsSync(join(destination, "app/big"))).toBe(false);
  });

  test("a compression bomb stops at the cap, not at the disk", async () => {
    const zeros = { kind: "file" as const, path: "app/zeros", mtime: MTIME, executable: false, content: new Uint8Array(8 * 1024 * 1024) };
    const bytes = bundle([zeros]);
    expect(bytes.length).toBeLessThan(64 * 1024);
    expect(await refused(bytes, { ...LIMITS, maxBytes: 1024 * 1024 })).toContain("more than");
  });

  test("too many entries", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => file(`app/f${i}`));
    expect(await refused(bundle(entries), { ...LIMITS, maxEntries: 10 })).toContain("too many entries");
  });

  test("a path longer than allowed", async () => {
    expect(await refused(bundle([file(`app/${"a".repeat(80)}`)]), { ...LIMITS, maxPathBytes: 50 })).toContain("too long");
  });

  test("a corrupt header, a truncated archive, and what is not gzip", async () => {
    const tampered = tarArchive([file("app/a", "hello")]);
    tampered[0] = "b".charCodeAt(0);
    expect(await refused(Bun.gzipSync(tampered))).toContain("checksum");
    const whole = tarArchive([file("app/a", "x".repeat(2000))]);
    expect(await refused(Bun.gzipSync(whole.slice(0, 1024)))).toContain("truncated");
    expect(await refused(encoder.encode("plain text, not an archive"))).toContain("gzip");
  });

  test("an old tar with no ustar magic", async () => {
    const block = header("app/a", { type: "0", mode: 0o644, size: 0, mtime: MTIME });
    block.fill(0, 257, 265);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    expect(await refused(archive(block))).toContain("ustar");
  });

  test("a staging directory that is not empty is not extracted into", async () => {
    const destination = folder();
    mkdirSync(join(destination, "app"));
    const outcome = await extract(stream(bundle([file("app/a")])), destination, LIMITS);
    expect(outcome).toEqual({ ok: false, reason: "the staging directory is not empty" });
  });
});

describe("the reader on its own", () => {
  test("chunks of any size give the same events", () => {
    const bytes = tarArchive([file("app/a", "hello world"), dir("public"), file("public/b", "!")]);
    for (const size of [1, 7, 511, 512, 513, 4096]) {
      const events: string[] = [];
      const sink: TarSink = {
        directory: (path) => events.push(`d ${path}`),
        file: (path, executable, mtime, length) => events.push(`f ${path} ${executable} ${mtime} ${length}`),
        data: (piece) => events.push(`+${piece.length}`),
        end: () => events.push("end"),
      };
      const reader = createTarReader(sink, LIMITS);
      for (let offset = 0; offset < bytes.length; offset += size) reader.push(bytes.subarray(offset, offset + size));
      reader.end();
      const merged = events.join(" ").replace(/(\+\d+ )+end/g, (run) => `+${[...run.matchAll(/\+(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0)} end`);
      expect(merged).toBe(`d app f app/a false ${MTIME} 11 +11 end d public f public/b false ${MTIME} 1 +1 end`);
    }
  });

  test("a refusal is a TarRefusal, which names the rule", () => {
    const reader = createTarReader({ directory() {}, file() {}, data() {}, end() {} }, LIMITS);
    expect(() => reader.push(tarArchive([file("../x")]))).toThrow(TarRefusal);
  });

  test("nothing is written outside the staging directory, whatever was refused", async () => {
    const destination = folder();
    await extract(stream(archive(...entryBlocks(file("app/ok")), ...entryBlocks(file("app/../escape")))), destination, LIMITS);
    expect(readdirSync(join(destination, ".."))).toEqual(["staging"]);
    expect(lstatSync(join(destination, "app", "ok")).isFile()).toBe(true);
  });
});
