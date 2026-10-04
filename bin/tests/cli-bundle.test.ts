import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle, excludedBy, isExcluded, paxRecord, tarArchive, type BundleEntry } from "../cli/bundle";

/**
 * The archive the CLI sends through the control API. The installer's reader
 * on the other side is tested in dashboard/tests/installer-tar.test.ts; here,
 * that what the CLI writes is a tar any `tar` reads, and that the exclusions
 * leave out what rsync would have.
 */

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const file = (path: string, content: string, executable = false): BundleEntry => ({ kind: "file", path, mtime: 1_789_000_000, executable, content: encoder.encode(content) });

describe("the archive", () => {
  test("the system's tar reads it back: paths, contents, modes, dates, a long path", async () => {
    const folder = mkdtempSync(join(tmpdir(), "cli-bundle-"));
    toClean.push(folder);
    const long = `app/${"segment/".repeat(20)}deep.txt`;
    const archive = join(folder, "bundle.tar.gz");
    writeFileSync(
      archive,
      bundle([
        { kind: "directory", path: "app", mtime: 1_789_000_000 },
        file("app/server.ts", "Bun.serve({})"),
        file("app/run", "#!/bin/sh\n", true),
        file(long, "deep"),
        file("public/index.html", "<h1>hi</h1>"),
      ]),
    );
    const out = join(folder, "out");
    Bun.spawnSync(["mkdir", out]);
    const extracted = Bun.spawnSync(["tar", "-xzf", archive, "-C", out]);
    expect(extracted.exitCode).toBe(0);
    expect(readFileSync(join(out, "app", "server.ts"), "utf8")).toBe("Bun.serve({})");
    expect(readFileSync(join(out, long), "utf8")).toBe("deep");
    expect(statSync(join(out, "app", "run")).mode & 0o111).not.toBe(0);
    expect(statSync(join(out, "public", "index.html")).mode & 0o777).toBe(0o644);
    expect(Math.floor(statSync(join(out, "public", "index.html")).mtimeMs / 1000)).toBe(1_789_000_000);
  });

  test("ends with two empty blocks, every header on a block boundary", () => {
    const tar = tarArchive([file("app/a", "x".repeat(700))]);
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
    expect(tar.length).toBe(512 + 1024 + 1024);
  });

  test("a pax record counts its own length", () => {
    const record = paxRecord("path", "app/x");
    expect(record).toBe("14 path=app/x\n");
    expect(encoder.encode(record).length).toBe(14);
    const longer = paxRecord("path", "a".repeat(95));
    expect(encoder.encode(longer).length).toBe(Number(longer.split(" ")[0]));
  });
});

describe("the exclusions, as rsync reads them", () => {
  test("a name without a slash matches at any depth", () => {
    expect(isExcluded("node_modules", true, "node_modules")).toBe(true);
    expect(isExcluded("packages/a/node_modules", true, "node_modules")).toBe(true);
    expect(isExcluded("my_node_modules", true, "node_modules")).toBe(false);
  });

  test("wildcards: * within a component, ** across them, ? one character", () => {
    expect(isExcluded("logs/today.log", false, "*.log")).toBe(true);
    expect(isExcluded("a/b/c.tmp", false, "a/**")).toBe(true);
    expect(isExcluded("cache1", true, "cache?")).toBe(true);
    expect(isExcluded("cache12", true, "cache?")).toBe(false);
  });

  test("a slash anchors at the end of the path, a leading slash at the root", () => {
    expect(isExcluded("dist/site", true, "dist/site")).toBe(true);
    expect(isExcluded("packages/dist/site", true, "dist/site")).toBe(true);
    expect(isExcluded("packages/dist/site", true, "/dist/site")).toBe(false);
    expect(isExcluded("dist/site", true, "/dist/site")).toBe(true);
  });

  test("a trailing slash only matches a directory", () => {
    expect(isExcluded("data", true, "data/")).toBe(true);
    expect(isExcluded("data", false, "data/")).toBe(false);
  });

  test("any of several patterns", () => {
    expect(excludedBy(".git", true, ["node_modules", ".git"])).toBe(true);
    expect(excludedBy("src/index.ts", false, ["node_modules", ".git"])).toBe(false);
  });
});
