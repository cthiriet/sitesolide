#!/usr/bin/env bun
/**
 * Builds `sitesolide` as one executable per platform, into dist/.
 *
 *   bun bin/build.ts                          every platform, version `dev`
 *   bun bin/build.ts --version v0.3.0         the release of a tag
 *   bun bin/build.ts --target bun-darwin-arm64 --out /tmp/out
 *
 * Each binary is the CLI compiled with the Bun runtime, and the kit: the
 * scripts of bin/ and every file they read at run time, packed into one
 * archive the binary unpacks on first use. See bin/cli/kit.ts. A workstation
 * then needs bash, ssh, rsync, curl and shasum, which every Mac and every
 * Linux has, and neither Bun nor a clone of this repository.
 *
 * THE KIT IS WHAT GIT KNOWS, in the folders below: the tracked files, and the
 * new ones not yet added that no .gitignore excludes. What git ignores never
 * leaves, a workstation's `.env`, a `node_modules`, a database, the copies of
 * `borrowed/`, and a check below refuses the build outright should a name
 * that carries secrets ever get through.
 *
 * Cross-compiling fetches the Bun runtime of each target the first time, so
 * the first build of every platform needs the network. On macOS, the darwin
 * binaries are signed again, ad hoc, before their sums are written: see
 * signAdHoc.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packKit, shims, type KitEntry } from "./cli/kit";

const REPOSITORY = resolve(import.meta.dir, "..");

/** The platforms a release ships, in the names `bun build --compile` takes. */
export const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"] as const;
export type Target = (typeof TARGETS)[number];

/** The file a target's binary is published under, which install.sh asks for: `sitesolide-darwin-arm64`. */
export function binaryName(target: Target): string {
  return `sitesolide-${target.replace(/^bun-/, "")}`;
}

/** The folders the kit is made of: what the CLI and its scripts read, build and upload. */
export const KIT_FOLDERS = ["analytics", "api", "bin", "dashboard", "egress", "infra", "monitor", "portal"] as const;

/**
 * What stays out of the kit although it sits in those folders, and why. Each
 * is provably unread at run time: nothing in the kit imports, sources, builds
 * or uploads it. bin/tests/cli-kit.test.ts checks that every path the scripts
 * name is still in the kit.
 */
export const LEFT_OUT: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)tests\//, "tests run in the repository, never from a kit"],
  [/\.test\.ts$/, "tests run in the repository, never from a kit"],
  [/\.md$/, "documentation, read in the repository"],
  [/(^|\/)\.gitignore$/, "git's, and a kit is no checkout"],
  [/^bin\/(sitesolide|mcp|build)\.ts$/, "the CLI itself, which the binary is"],
  [/^bin\/(test\.sh|deprecations\.ts)$/, "the repository's own checks"],
];

/**
 * Names that carry secrets or a machine's state: an environment file, the
 * values and the state of Terraform. None is tracked, all are ignored; should
 * one ever get through anyway, the build stops rather than ship it inside a
 * public binary.
 */
export const NEVER_PACKED = /(^|\/)\.env($|\.)|\.env$|\.tfvars$|\.tfstate/;

/** The files git knows under the kit's folders, minus LEFT_OUT, sorted. */
export function kitFiles(root = REPOSITORY): string[] {
  const listing = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...KIT_FOLDERS], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listing.exitCode !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${listing.stderr.toString().trim()}; the kit is built from a checkout`);
  }
  const paths = [...new Set(listing.stdout.toString().split("\0"))]
    .filter((path) => path !== "")
    .filter((path) => !LEFT_OUT.some(([pattern]) => pattern.test(path)))
    // Tracked but deleted from the working tree: what is built is the tree.
    .filter((path) => existsSync(join(root, path)))
    .sort();
  const forbidden = paths.filter((path) => NEVER_PACKED.test(path));
  if (forbidden.length > 0) throw new Error(`refusing to pack what may carry a secret: ${forbidden.join(", ")}`);
  return paths;
}

/**
 * The kit's entries: the files, with the mode git cares about, executable or
 * not, so that the hash does not depend on the umask of whoever builds; and
 * the shims that play bun.
 */
export function kitEntries(root = REPOSITORY): KitEntry[] {
  return [...kitFiles(root).map((path) => entry(root, path)), ...shims()];
}

/** One file as the kit packs it, its mode reduced to what git keeps: executable or not. */
function entry(base: string, path: string): KitEntry {
  return {
    path,
    mode: statSync(join(base, path)).mode & 0o100 ? 0o755 : 0o644,
    content: new Uint8Array(readFileSync(join(base, path))),
  };
}

/**
 * The sources a release's kit leaves out once their component is built, its
 * output standing in for them: nothing reads them any more.
 */
export const BUILT_FROM: ReadonlyArray<readonly [RegExp, string]> = [
  [/^dashboard\/web\//, "the dashboard's interface, which the kit carries built, as dashboard/public"],
];

/** A component built at release time: its command, and the files it produced that the kit carries. */
export type Prebuilt = { component: string; command: string; files: string[] };

/** Every file under `folder`, relative to it, but what a node_modules holds: a build's tools, never its output. */
function walk(folder: string, prefix = ""): string[] {
  return readdirSync(join(folder, prefix), { withFileTypes: true }).flatMap((item) => {
    const path = prefix === "" ? item.name : `${prefix}/${item.name}`;
    if (item.name === "node_modules") return [];
    if (item.isDirectory()) return walk(folder, path);
    return item.isFile() ? [path] : [];
  });
}

/**
 * The release's kit: its sources, every component whose manifest has a
 * `build` built, and the shims.
 *
 * THE BUILDS RUN AT RELEASE TIME, NOT ON THE WORKSTATION. The dashboard's
 * fetches Astro and some fifteen packages from npm, then compiles its
 * interface: run by `sitesolide setup` on every workstation, that was a
 * network and a toolchain each install needed, for an output that is the same
 * everywhere. Each runs once, here, in a copy of the kit's sources laid out as
 * the repository, since a borrow script reaches above its folder: nothing of
 * the checkout is touched, and nothing but the kit's sources goes in.
 *
 * What a build produced is packed, but a node_modules, the build's tools, and
 * what the manifest excludes, which a deployment never sends anyway. The
 * manifest packed loses `build`: deployed from the kit, the component sends
 * what was built and runs nothing. A checkout keeps its manifest whole, and
 * builds as it always did. The same sources and the same lockfiles build the
 * same bytes, so the release stays reproducible.
 */
export function releaseKit(root = REPOSITORY): { entries: KitEntry[]; prebuilt: Prebuilt[] } {
  const sources = kitFiles(root);
  const stage = mkdtempSync(join(tmpdir(), "sitesolide-stage-"));
  try {
    for (const path of sources) {
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      copyFileSync(join(root, path), join(stage, path));
    }
    const known = new Set(sources);
    const built = new Map<string, KitEntry>();
    const prebuilt: Prebuilt[] = [];
    for (const component of KIT_FOLDERS) {
      const manifestPath = join(stage, component, "sitesolide.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (typeof manifest.build !== "string") continue;
      const command = manifest.build;
      // The Bun running this build first on the PATH: the one the release
      // embeds, whatever else the machine has. Without NODE_ENV, which the
      // build sets itself: `bun test` sets it to `test`, and the dashboard's
      // interface then builds differently from one run to the next.
      const { NODE_ENV: _, ...environment } = process.env;
      const run = Bun.spawnSync(["sh", "-c", command], {
        cwd: join(stage, component),
        env: { ...environment, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (run.exitCode !== 0) {
        const tail = `${run.stdout.toString()}${run.stderr.toString()}`.trim().split("\n").slice(-20).join("\n");
        throw new Error(`the build of ${component} failed (${command}):\n${tail}`);
      }
      const excluded = new Set(Array.isArray(manifest.exclude) ? manifest.exclude.filter((name): name is string => typeof name === "string") : []);
      const files: string[] = [];
      for (const inside of walk(join(stage, component))) {
        if (excluded.has(inside.split("/")[0]!)) continue;
        const path = `${component}/${inside}`;
        const produced = entry(stage, path);
        // A source the build left as it was is packed from the checkout, below.
        if (known.has(path) && Buffer.from(produced.content).equals(readFileSync(join(root, path)))) continue;
        if (NEVER_PACKED.test(path)) throw new Error(`refusing to pack what may carry a secret: ${path}, made by the build of ${component}`);
        files.push(path);
        built.set(path, produced);
      }
      delete manifest.build;
      const path = `${component}/sitesolide.json`;
      built.set(path, { path, mode: 0o644, content: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) });
      prebuilt.push({ component, command, files: files.sort() });
    }
    const entries = new Map<string, KitEntry>();
    for (const path of sources) {
      const component = path.split("/")[0]!;
      const replacedByOutput = prebuilt.some((done) => done.component === component) && BUILT_FROM.some(([pattern]) => pattern.test(path));
      if (!replacedByOutput) entries.set(path, entry(root, path));
    }
    for (const [path, produced] of built) entries.set(path, produced);
    return { entries: [...entries.values(), ...shims()], prebuilt };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** A version a release may carry: `dev`, or a tag such as v0.3.0 or v0.3.0-rc.1. It names a folder and a release. */
export function isValidVersion(version: string): boolean {
  return version === "dev" || /^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version);
}

/**
 * Signs a darwin binary again, ad hoc. Bun leaves it a signature that
 * `codesign --verify` refuses once the kit is appended: the arm64 one is its
 * own ad-hoc signature, which the kernel happens to accept, the x64 one is
 * still the Bun runtime's, which no longer matches the file. An arm64 Mac runs
 * nothing unsigned, and an Intel one should not meet a signature that lies:
 * signed again, both verify strictly and keep their kit. `codesign` exists on
 * macOS only, which is why the release is built there.
 */
function signAdHoc(outfile: string): void {
  for (const command of [
    ["codesign", "--force", "--sign", "-", outfile],
    ["codesign", "--verify", "--strict", outfile],
  ]) {
    const run = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${run.stderr.toString().trim()}`);
  }
}

/**
 * The bundler plugin that swaps bin/cli/kit-archive.ts for a module embedding
 * the packed kit. The archive never touches the disk: it is a module of its
 * own namespace, loaded as a file. A path on disk would end up in the
 * binary, and a temporary one would make every build of the same tree differ.
 */
function embedKit(archive: Uint8Array, hash: string): Bun.BunPlugin {
  return {
    name: "sitesolide-kit",
    setup(build) {
      build.onResolve({ filter: /^sitesolide-kit:archive$/ }, () => ({ path: "kit.gz", namespace: "sitesolide-kit" }));
      build.onLoad({ filter: /.*/, namespace: "sitesolide-kit" }, () => ({ contents: archive, loader: "file" }));
      build.onLoad({ filter: /[\\/]bin[\\/]cli[\\/]kit-archive\.ts$/ }, () => ({
        contents: [
          `import path from "sitesolide-kit:archive" with { type: "file" };`,
          `export const EMBEDDED_KIT = { path, hash: ${JSON.stringify(hash)} };`,
        ].join("\n"),
        loader: "ts",
      }));
    },
  };
}

export type Built = {
  kit: { files: number; size: number; packed: number; hash: string; prebuilt: Prebuilt[] };
  binaries: { name: string; path: string; size: number; sha256: string; signed: boolean }[];
};

/**
 * Packs the kit, compiles one binary per target into `out`, and writes
 * SHA256SUMS beside them, the file install.sh checks a download against.
 */
export async function build(options: { version: string; targets: readonly Target[]; out: string; root?: string }): Promise<Built> {
  const root = options.root ?? REPOSITORY;
  const out = resolve(options.out);
  if (!isValidVersion(options.version)) throw new Error(`--version: ${options.version} is neither dev nor a tag like v0.3.0`);
  const release = releaseKit(root);
  const kit = packKit(release.entries);
  // The embedded source map names each module relative to the working
  // directory: from the root, it says bin/cli/kit.ts, and never where the
  // builder keeps the repository. The same tree then builds the same bytes.
  const before = process.cwd();
  process.chdir(root);
  try {
    mkdirSync(out, { recursive: true });
    const binaries: Built["binaries"] = [];
    for (const target of options.targets) {
      const outfile = join(out, binaryName(target));
      const result = await Bun.build({
        entrypoints: [join(root, "bin", "sitesolide.ts")],
        compile: {
          target,
          outfile,
          // A binary started in a project's folder must not take that
          // project's .env for its own environment, nor its bunfig.toml,
          // whose preload would run the folder's code before the CLI's: the
          // configuration is ~/.config/sitesolide/config.json, and a dry run
          // on a folder just cloned runs nothing of it.
          autoloadDotenv: false,
          autoloadBunfig: false,
        },
        minify: true,
        sourcemap: "linked",
        define: { SITESOLIDE_BUILD_VERSION: JSON.stringify(options.version) },
        plugins: [embedKit(kit.archive, kit.hash)],
      });
      if (!result.success) throw new Error(`bun build --compile ${target} failed:\n${result.logs.map(String).join("\n")}`);
      // The binary carries its source map, which turns a stack trace back
      // into lines of the source; the copy Bun also writes beside it is
      // nobody's.
      for (const output of result.outputs) if (output.kind === "sourcemap") rmSync(output.path, { force: true });
      // Signed before it is hashed: the sum published is the file's as shipped.
      const signed = target.startsWith("bun-darwin") && process.platform === "darwin";
      if (signed) signAdHoc(outfile);
      const bytes = readFileSync(outfile);
      binaries.push({
        name: binaryName(target),
        path: outfile,
        size: bytes.byteLength,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        signed,
      });
    }
    // The format of `shasum -a 256` and `sha256sum`: two spaces, then the name.
    await Bun.write(join(out, "SHA256SUMS"), binaries.map((binary) => `${binary.sha256}  ${binary.name}\n`).join(""));
    return { kit: { files: kit.files.length, size: kit.size, packed: kit.archive.byteLength, hash: kit.hash, prebuilt: release.prebuilt }, binaries };
  } finally {
    process.chdir(before);
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const values = (name: string): string[] =>
    arguments_.flatMap((argument, index) => (argument === name && arguments_[index + 1] !== undefined ? [arguments_[index + 1]!] : []));
  const version = values("--version")[0] ?? "dev";
  const out = resolve(values("--out")[0] ?? join(REPOSITORY, "dist"));
  const asked = values("--target");
  const unknown = asked.filter((target) => !(TARGETS as readonly string[]).includes(target));
  if (unknown.length > 0) {
    console.error(`!! unknown target: ${unknown.join(", ")}; known: ${TARGETS.join(", ")}`);
    process.exit(2);
  }
  const targets = asked.length === 0 ? TARGETS : (asked as Target[]);
  try {
    const built = await build({ version, targets, out });
    for (const done of built.kit.prebuilt) console.log(`built at release time: ${done.component} (${done.command}), ${done.files.length} files packed`);
    console.log(`kit: ${built.kit.files} files, ${megabytes(built.kit.size)}, ${megabytes(built.kit.packed)} packed, ${built.kit.hash.slice(0, 16)}`);
    for (const binary of built.binaries) console.log(`${binary.name}: ${megabytes(binary.size)}  ${binary.sha256}${binary.signed ? "  signed ad hoc" : ""}`);
    const unsigned = built.binaries.filter((binary) => binary.name.includes("darwin") && !binary.signed);
    if (unsigned.length > 0) {
      console.error(`!! not signed again, codesign being macOS's: ${unsigned.map((binary) => binary.name).join(", ")}; build a release on macOS`);
    }
    console.log(`written: ${out} (version ${version})`);
  } catch (error) {
    console.error(`!! ${(error as Error).message}`);
    process.exit(1);
  }
}
