import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KIT_FOLDERS, kitEntries, kitFiles, NEVER_PACKED, isValidVersion, binaryName, TARGETS } from "../build";
import { DEFAULT_HINT, hintFor } from "../cli/hints";
import {
  isCompiled,
  isWholeKit,
  KIT_MARKER,
  kitDirectory,
  kitEnv,
  isKitPath,
  KitUnavailable,
  kitRoot,
  packKit,
  projectEnv,
  shims,
  SHIM_FOLDER,
  unpackKit,
  VERSION,
  type KitEntry,
} from "../cli/kit";

/**
 * The kit: what a compiled binary carries of the repository, and how it
 * unpacks it. See bin/cli/kit.ts and bin/build.ts.
 *
 * The unpacking is tested on archives packed here, with the functions the
 * binary runs; bin/tests/e2e/binary.test.ts runs a real binary. The contents
 * are tested against what the scripts name: a file left out of the kit is a
 * script that fails on a workstation, long after the release.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const KIT_SOURCE = join(import.meta.dir, "..", "cli", "kit.ts");
const WORK = mkdtempSync(join(tmpdir(), "kit-test-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

let counter = 0;
function scratch(): string {
  const folder = join(WORK, `case-${counter++}`);
  mkdirSync(folder, { recursive: true });
  return folder;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A small kit: a script, a plain file, a nested one, and the shims. */
function sampleEntries(): KitEntry[] {
  return [
    { path: "bin/hello.sh", mode: 0o755, content: encode("#!/bin/sh\necho hello from the kit\n") },
    { path: "infra/unit.service", mode: 0o644, content: encode("[Service]\nExecStart=/usr/bin/true\n") },
    { path: "dashboard/src/deep/module.ts", mode: 0o644, content: encode("export const value = 42;\n") },
    ...shims(),
  ];
}

describe("packing and unpacking", () => {
  test("every file comes back with its bytes and its mode, the scripts executable", () => {
    const { archive, hash, files } = packKit(sampleEntries());
    const destination = join(scratch(), "kit");
    unpackKit(archive, hash, destination, "v0.0.0-test");
    expect(files.map((file) => file.path)).toEqual([".bin/bun", ".bin/bunx", "bin/hello.sh", "dashboard/src/deep/module.ts", "infra/unit.service"]);
    for (const entry of sampleEntries()) {
      const path = join(destination, entry.path);
      expect(readFileSync(path, "utf8")).toBe(new TextDecoder().decode(entry.content));
      expect(statSync(path).mode & 0o777).toBe(entry.mode);
    }
    const run = Bun.spawnSync([join(destination, "bin", "hello.sh")], { stdout: "pipe" });
    expect(run.stdout.toString()).toBe("hello from the kit\n");
    expect(JSON.parse(readFileSync(join(destination, KIT_MARKER), "utf8"))).toEqual({ version: "v0.0.0-test", hash, files: 5 });
    expect(isWholeKit(destination, hash)).toBe(true);
  });

  test("the modes are the archive's whatever the umask of whoever unpacks", () => {
    const { archive, hash } = packKit(sampleEntries());
    const folder = scratch();
    const destination = join(folder, "kit");
    writeFileSync(join(folder, "archive.gz"), archive);
    const child = Bun.spawnSync(
      [
        "sh",
        "-c",
        `umask 077; exec "${process.execPath}" -e 'import { unpackKit } from ${JSON.stringify(KIT_SOURCE)}; unpackKit(new Uint8Array(await Bun.file(${JSON.stringify(join(folder, "archive.gz"))}).arrayBuffer()), ${JSON.stringify(hash)}, ${JSON.stringify(destination)});'`,
      ],
      { stderr: "pipe" },
    );
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(statSync(join(destination, "bin", "hello.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(destination, "infra", "unit.service")).mode & 0o777).toBe(0o644);
  });

  test("the hash depends on the contents, not on the order they were given in", () => {
    const entries = sampleEntries();
    expect(packKit([...entries].reverse()).hash).toBe(packKit(entries).hash);
    const changed = entries.map((entry) => (entry.path === "bin/hello.sh" ? { ...entry, content: encode("#!/bin/sh\necho changed\n") } : entry));
    expect(packKit(changed).hash).not.toBe(packKit(entries).hash);
  });

  test("a kit already unpacked is used as it is, not unpacked again", () => {
    const { archive, hash } = packKit(sampleEntries());
    const destination = join(scratch(), "kit");
    unpackKit(archive, hash, destination);
    // A file only the first unpacking could have left: a second one that
    // rewrote the folder would lose it.
    writeFileSync(join(destination, "left-by-the-first"), "");
    const marker = statSync(join(destination, KIT_MARKER)).mtimeMs;
    unpackKit(archive, hash, destination);
    expect(existsSync(join(destination, "left-by-the-first"))).toBe(true);
    expect(statSync(join(destination, KIT_MARKER)).mtimeMs).toBe(marker);
  });

  test("a folder without its marker is not trusted: it is set aside and replaced", () => {
    const { archive, hash } = packKit(sampleEntries());
    const parent = scratch();
    const destination = join(parent, "kit");
    mkdirSync(join(destination, "bin"), { recursive: true });
    writeFileSync(join(destination, "bin", "hello.sh"), "half a file");
    unpackKit(archive, hash, destination);
    expect(readFileSync(join(destination, "bin", "hello.sh"), "utf8")).toBe("#!/bin/sh\necho hello from the kit\n");
    expect(isWholeKit(destination, hash)).toBe(true);
    // Nothing left beside it: neither the temporary copy nor the folder set aside.
    expect(readdirSync(parent)).toEqual(["kit"]);
  });

  test("a damaged archive is refused, and nothing is put in place", () => {
    const { archive, hash } = packKit(sampleEntries());
    const destination = join(scratch(), "kit");
    const other = packKit([{ path: "x", mode: 0o644, content: encode("x") }]);
    expect(() => unpackKit(other.archive, hash, destination)).toThrow(KitUnavailable);
    expect(() => unpackKit(archive, "0".repeat(64), destination)).toThrow("the kit embedded in this binary is damaged");
    expect(existsSync(destination)).toBe(false);
  });

  test("no path leaves the kit, packed or unpacked", () => {
    for (const path of ["../outside", "/etc/passwd", "a/../../b", "a//b", "./a", ""]) {
      expect({ path, inside: isKitPath(path) }).toEqual({ path, inside: false });
      expect(() => packKit([{ path, mode: 0o644, content: encode("") }])).toThrow("not a path inside the kit");
    }
    expect(isKitPath("bin/cli/kit.ts")).toBe(true);
    // An archive packed by something else than packKit, whose header names a
    // path above the kit: refused before anything is written, there or here.
    const content = encode("escaped");
    const header = encode(`${JSON.stringify({ format: 1, files: [{ path: "../escaped", mode: 0o644, size: content.byteLength, sha256: "" }] })}\n`);
    const payload = new Uint8Array([...header, ...content]);
    const hash = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    const parent = scratch();
    const destination = join(parent, "kit");
    expect(() => unpackKit(Bun.gzipSync(payload), hash, destination)).toThrow("is not a path inside it");
    expect(existsSync(join(parent, "escaped"))).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
  });

  test("what dead runs left beside the kits is swept, what a live one is writing is not", () => {
    const { archive, hash } = packKit(sampleEntries());
    const parent = scratch();
    const stale = join(parent, ".kit.1234.abc.tmp");
    const young = join(parent, ".kit.5678.def.tmp");
    mkdirSync(stale);
    mkdirSync(young);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    unpackKit(archive, hash, join(parent, "kit"));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });
});

describe("two runs started together", () => {
  test("both succeed, and no one ever sees a kit half written", async () => {
    // The real kit, large enough for the runs to overlap.
    const { archive, hash } = packKit(kitEntries());
    const parent = scratch();
    const destination = join(parent, "kit");
    const archivePath = join(WORK, "real-kit.gz");
    writeFileSync(archivePath, archive);
    const code = `import { unpackKit } from ${JSON.stringify(KIT_SOURCE)};
unpackKit(new Uint8Array(await Bun.file(${JSON.stringify(archivePath)}).arrayBuffer()), ${JSON.stringify(hash)}, ${JSON.stringify(destination)});`;
    const runs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }));
    let seenHalf = 0;
    let finished = false;
    const exits = Promise.all(runs.map((run) => run.exited)).then((codes) => {
      finished = true;
      return codes;
    });
    while (!finished) {
      if (existsSync(destination) && !isWholeKit(destination, hash)) seenHalf++;
      await Bun.sleep(1);
    }
    const errors = await Promise.all(runs.map((run) => new Response(run.stderr).text()));
    expect(errors.filter((error) => error !== "")).toEqual([]);
    expect(await exits).toEqual([0, 0, 0, 0, 0, 0]);
    expect(seenHalf).toBe(0);
    expect(isWholeKit(destination, hash)).toBe(true);
    // One kit, and no temporary copy left behind by the runs that lost.
    expect(readdirSync(parent)).toEqual(["kit"]);
  });
});

describe("where the kit lives", () => {
  test("under ~/.cache, or the absolute XDG_CACHE_HOME, named by version and hash", () => {
    const hash = "ab".repeat(32);
    expect(kitDirectory("v0.3.0", hash, {}, "/home/someone")).toBe("/home/someone/.cache/sitesolide/v0.3.0-abababababababab");
    expect(kitDirectory("v0.3.0", hash, { XDG_CACHE_HOME: "/var/cache/me" }, "/home/someone")).toBe("/var/cache/me/sitesolide/v0.3.0-abababababababab");
    // The specification ignores a relative one, and so does the kit.
    expect(kitDirectory("dev", hash, { XDG_CACHE_HOME: "cache" }, "/home/someone")).toBe("/home/someone/.cache/sitesolide/dev-abababababababab");
  });

  test("in the repository, the repository is the kit and nothing is added to the environment", () => {
    expect(isCompiled()).toBe(false);
    expect(VERSION).toBe("dev");
    expect(kitRoot()).toBe(REPO_ROOT);
    expect(kitEnv()).toEqual({});
    expect(projectEnv()).toEqual({});
  });

  test("a kit that cannot be had is a refusal with a hint, never the default one", () => {
    for (const message of [
      "cannot unpack the kit into /home/someone/.cache/sitesolide/v0.3.0-abababababababab",
      "the kit embedded in this binary is damaged: its hash does not match",
      "this binary carries no kit",
    ]) {
      expect({ message, hint: hintFor(message) === DEFAULT_HINT }).toEqual({ message, hint: false });
    }
  });
});

describe("the bun shims", () => {
  const { archive, hash } = packKit(sampleEntries());
  const destination = join(WORK, "shim-kit");
  unpackKit(archive, hash, destination);
  const shimFolder = join(destination, SHIM_FOLDER);

  /** A binary that says how it was called, in place of sitesolide. */
  function recorder(folder: string, name: string): string {
    const path = join(folder, name);
    writeFileSync(path, '#!/bin/sh\necho "BUN_BE_BUN=$BUN_BE_BUN $*"\n');
    chmodSync(path, 0o755);
    return path;
  }

  test("bun runs the binary SITESOLIDE_BINARY names as Bun, with every argument", () => {
    const binary = recorder(scratch(), "sitesolide");
    const run = Bun.spawnSync([join(shimFolder, "bun"), "build", "steward.ts", "--target=bun"], {
      env: { PATH: "/usr/bin:/bin", SITESOLIDE_BINARY: binary },
      stdout: "pipe",
    });
    expect(run.stdout.toString()).toBe("BUN_BE_BUN=1 build steward.ts --target=bun\n");
  });

  test("bunx is `bun x`", () => {
    const binary = recorder(scratch(), "sitesolide");
    const run = Bun.spawnSync([join(shimFolder, "bunx"), "--bun", "astro", "build"], {
      env: { PATH: "/usr/bin:/bin", SITESOLIDE_BINARY: binary },
      stdout: "pipe",
    });
    expect(run.stdout.toString()).toBe("BUN_BE_BUN=1 x --bun astro build\n");
  });

  test("a script started by hand finds the sitesolide of the PATH", () => {
    const folder = scratch();
    recorder(folder, "sitesolide");
    const run = Bun.spawnSync([join(shimFolder, "bun"), "--version"], { env: { PATH: `${shimFolder}:${folder}:/usr/bin:/bin` }, stdout: "pipe" });
    expect(run.stdout.toString()).toBe("BUN_BE_BUN=1 --version\n");
  });

  test("with no binary to play it, bun says so and fails as a missing command would", () => {
    const run = Bun.spawnSync([join(shimFolder, "bun"), "--version"], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(127);
    expect(run.stderr.toString()).toContain("no sitesolide binary to play it");
  });

  test("handed a real Bun, the shim is that Bun", () => {
    const run = Bun.spawnSync([join(shimFolder, "bun"), "--version"], {
      env: { PATH: "/usr/bin:/bin", SITESOLIDE_BINARY: process.execPath },
      stdout: "pipe",
    });
    expect(run.stdout.toString().trim()).toBe(Bun.version);
  });
});

describe("what the kit carries", () => {
  const files = kitFiles();
  const carried = new Set(files);
  const has = (path: string): boolean => carried.has(path) || files.some((file) => file.startsWith(`${path.replace(/\/$/, "")}/`));
  const scripts = files.filter((file) => /^bin\/[^/]+\.sh$/.test(file));

  test("the scripts, their configuration reader, and the sources of every component they deploy", () => {
    for (const path of [
      "bin/config.sh",
      "bin/lock.sh",
      "bin/deploy-caddy.sh",
      "bin/deploy-api.sh",
      "bin/portal-guard.ts",
      "bin/cli/settings.ts",
      "bin/cli/manifest.ts",
      "api/server.ts",
      "api/scripts/generate-domains.ts",
      "api/deploy/sitesolide-api.service",
      "dashboard/sitesolide.json",
      "dashboard/scripts/borrow.ts",
      "dashboard/scripts/fingerprint.ts",
      "dashboard/web/package.json",
      "portal/sitesolide.json",
      "portal/scripts/lock-page.ts",
      "monitor/monitor.ts",
      "egress/server.ts",
      "infra/caddy/Caddyfile",
      "infra/caddy/caddy.service.d/override.conf",
    ]) {
      expect({ path, carried: carried.has(path) }).toEqual({ path, carried: true });
    }
    expect(scripts.length).toBeGreaterThan(12);
  });

  test("no test, no documentation, no Terraform, not the CLI itself, nothing that may hold a secret", () => {
    for (const file of files) {
      expect({ file, left: /(^|\/)tests\/|\.test\.ts$|\.md$|\.tf$|\.tfvars|^bin\/(sitesolide|mcp|build|deprecations)\.ts$|^bin\/test\.sh$/.test(file) }).toEqual({ file, left: false });
      expect({ file, secret: NEVER_PACKED.test(file) }).toEqual({ file, secret: false });
      expect(KIT_FOLDERS.some((folder) => file.startsWith(`${folder}/`))).toBe(true);
    }
  });

  test("every path of the repository a script names is in the kit", () => {
    const named: string[] = [];
    for (const script of scripts) {
      const text = readFileSync(join(REPO_ROOT, script), "utf8");
      for (const match of text.matchAll(/\$REPO_ROOT\/([A-Za-z0-9_.\/-]+)/g)) named.push(match[1]!.replace(/\/$/, ""));
    }
    expect(named.length).toBeGreaterThan(40);
    const shimPaths = kitEntries().map((entry) => entry.path).filter((path) => path.startsWith(`${SHIM_FOLDER}/`));
    for (const path of new Set(named)) {
      // The kit's own: its marker, written when it is unpacked, and a
      // checkout's .git, which deploy-api.sh only asks about.
      if (path === KIT_MARKER || path === ".git") continue;
      const found = path.startsWith(SHIM_FOLDER) ? shimPaths.some((shim) => shim === path || shim.startsWith(`${path}/`)) : has(path);
      expect({ path, carried: found }).toEqual({ path, carried: true });
    }
  });

  test("every module a script imports through `bun -e` is in the kit", () => {
    const imported: string[] = [];
    for (const script of scripts) {
      const text = readFileSync(join(REPO_ROOT, script), "utf8");
      for (const match of text.matchAll(/from "\.\/([A-Za-z0-9_.\/-]+)"/g)) imported.push(`${match[1]!}.ts`);
    }
    expect(imported.length).toBeGreaterThan(3);
    for (const module of new Set(imported)) {
      // Relative to the folder the script moved into: the root, or api/.
      const found = files.some((file) => file === module || file.endsWith(`/${module}`));
      expect({ module, found }).toEqual({ module, found: true });
    }
  });

  test("every module the dashboard and the portal borrow before their build is in the kit", () => {
    const borrowed: string[] = [];
    for (const script of ["dashboard/scripts/borrow.ts", "portal/scripts/borrow.ts"]) {
      const text = readFileSync(join(REPO_ROOT, script), "utf8");
      for (const match of text.matchAll(/^\s*\[?\s*"([a-z]+\/[A-Za-z0-9_.\/-]+\.ts)"/gm)) borrowed.push(match[1]!);
      for (const match of text.matchAll(/BORROWED = \[([^\]]+)\]/g)) {
        for (const inner of match[1]!.matchAll(/"([^"]+)"/g)) borrowed.push(inner[1]!);
      }
    }
    expect(borrowed.length).toBeGreaterThan(15);
    for (const path of new Set(borrowed)) expect({ path, carried: carried.has(path) }).toEqual({ path, carried: true });
  });

  test("the shims are packed with the files", () => {
    const entries = kitEntries();
    for (const name of ["bun", "bunx"]) {
      const shim = entries.find((entry) => entry.path === `${SHIM_FOLDER}/${name}`);
      expect(shim?.mode).toBe(0o755);
    }
    // The executable bit as git keeps it, so that the hash does not depend on
    // the umask of whoever builds.
    expect(entries.find((entry) => entry.path === "bin/lock.sh")?.mode).toBe(0o755);
    expect(entries.find((entry) => entry.path === "bin/config.sh")?.mode).toBe(0o644);
  });

  test("a script started by hand from an unpacked kit finds its bun and its release, without the CLI", () => {
    const { archive, hash } = packKit(kitEntries());
    const kit = join(scratch(), "kit");
    unpackKit(archive, hash, kit, "v0.0.0-hand.1");
    // As bin/deploy-api.sh and its siblings begin, with no Bun on the PATH:
    // config.sh puts the kit's shims first, and reads the release from the
    // marker. The shim is handed the Bun running these tests to play.
    const run = Bun.spawnSync(["bash", "-c", '. "$REPO_ROOT/bin/config.sh"; echo "$SITESOLIDE_KIT_VERSION"; command -v bun'], {
      env: { PATH: "/usr/bin:/bin", HOME: scratch(), REPO_ROOT: kit, SITESOLIDE_BINARY: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString()).toBe(`v0.0.0-hand.1\n${join(kit, SHIM_FOLDER, "bun")}\n`);
  });

  test("unpacked, the kit builds every component the scripts bundle, with no repository beside it", () => {
    const { archive, hash } = packKit(kitEntries());
    const kit = join(scratch(), "kit");
    unpackKit(archive, hash, kit);
    const bundles: [string, string][] = [];
    for (const script of scripts) {
      const text = readFileSync(join(kit, script), "utf8");
      for (const match of text.matchAll(/cd "\$REPO_ROOT\/([a-z]+)" && bun build ([a-z-]+\.ts) --target=bun/g)) bundles.push([match[1]!, match[2]!]);
    }
    expect(bundles.length).toBeGreaterThanOrEqual(6);
    // The copies the dashboard's bundles import, made as the scripts make them.
    const borrow = Bun.spawnSync([process.execPath, "run", "borrow"], { cwd: join(kit, "dashboard"), stdout: "pipe", stderr: "pipe" });
    expect(borrow.stderr.toString().replace(/^\$ .*\n/gm, "")).toBe("");
    for (const [folder, entry] of bundles) {
      const out = join(WORK, `bundle-${folder}-${entry}.js`);
      const run = Bun.spawnSync([process.execPath, "build", entry, "--target=bun", "--outfile", out], { cwd: join(kit, folder), stdout: "pipe", stderr: "pipe" });
      expect({ folder, entry, code: run.exitCode, error: run.exitCode === 0 ? "" : run.stderr.toString() }).toEqual({ folder, entry, code: 0, error: "" });
    }
    const settings = Bun.spawnSync([process.execPath, join(kit, "bin", "cli", "settings.ts")], {
      env: { PATH: "/usr/bin:/bin", HOME: scratch() },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(settings.stdout.toString()).toContain("SITESOLIDE_SERVER=''");
  });
});

describe("the release's names", () => {
  test("one binary per platform, named as install.sh asks for them", () => {
    expect(TARGETS.map(binaryName)).toEqual(["sitesolide-darwin-arm64", "sitesolide-darwin-x64", "sitesolide-linux-x64", "sitesolide-linux-arm64"]);
  });

  test("a version names a folder and a release: dev or a tag, nothing else", () => {
    for (const version of ["dev", "v0.3.0", "0.3.0", "v0.3.0-rc.1", "v1.20.3-beta"]) expect({ version, valid: isValidVersion(version) }).toEqual({ version, valid: true });
    for (const version of ["", "v1", "latest", "v0.3.0/../x", "v0.3.0 x", "v0.3.0-", "main"]) expect({ version, valid: isValidVersion(version) }).toEqual({ version, valid: false });
  });
});
