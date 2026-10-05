/**
 * The kit: every file the CLI and the scripts of bin/ read at run time, and
 * where it lives.
 *
 * In the repository, the kit is the repository itself. `kitRoot()` is its
 * root, `kitEnv()` adds nothing, and the scripts find `bun` on the PATH like
 * any other tool.
 *
 * A compiled binary (bin/build.ts) has no repository beside it: its whole
 * point is to run on a workstation that has neither a clone nor Bun. The
 * build packs the kit, the scripts of bin/, the sources of the components they
 * build and upload, the files of infra/, into one archive the binary embeds,
 * and the first command that needs it unpacks it, once per release, into
 * `~/.cache/sitesolide/<version>-<hash>/` (under `$XDG_CACHE_HOME` when it is
 * set). The scripts are bash, `rsync` and `bun build` read real files, and a
 * file inside the binary is not one: unpacking is what lets every script run
 * unchanged, from the same layout as the repository, its `REPO_ROOT` derived
 * from its own path as always.
 *
 * ONE ARCHIVE, NOT BUN'S EMBEDDED DIRECTORIES. `--asset` would serve the files
 * from inside the binary without their modes, the executable bit of every
 * script lost, and it is younger than the Bun this repository runs. One file
 * embedded with `with { type: "file" }` works on any Bun that compiles, and
 * the format below carries what the scripts need: the path, the mode and a
 * hash per file.
 *
 * UNPACKED ATOMICALLY. Two commands started together on a fresh install both
 * find the kit missing. Each unpacks into a temporary sibling of its own,
 * checks every file against the size, mode and hash the archive carries,
 * writes the marker last, and renames the folder into place. The rename lands
 * whole or not at all: no run ever reads a half-written kit, and the one that
 * loses the race throws its copy away and uses the winner's. A folder without
 * its marker was not made here, and is set aside rather than trusted.
 *
 * READ-ONLY, A CACHE. Every run of a release shares its kit, and nothing may
 * change it under the next one: its files and its folders lose their write
 * bits once checked, so that a stray write fails at once instead of altering
 * the cache. What writes into a component's folder, a deployment that follows
 * the door the dashboard set, `lock` rewriting the manifest, works on a
 * writable copy of that component instead (`kitComponent`, `workingFolder`),
 * thrown away when the process ends. Removing a kit, or what a dead run left,
 * gives the write bits back first (`removeTree`); so must whoever deletes the
 * cache by hand: `chmod -R u+w ~/.cache/sitesolide` before `rm -rf`.
 *
 * Its components arrive built: bin/build.ts ran, at release time, the build
 * of every component whose manifest has one, packed what it produced, and
 * dropped `build` from the manifest it packed. Deploying the dashboard from
 * the kit fetches no package and runs no Astro.
 *
 * BUN WITHOUT BUN. The scripts call `bun` some seventy times on the
 * workstation, to read the configuration, to bundle the components, to draw a
 * code. The binary is Bun: started with BUN_BE_BUN=1, it skips its own entry
 * point and behaves as the bun CLI, the bundler included. The kit therefore
 * carries `.bin/bun` and `.bin/bunx`, two shell scripts that do exactly that
 * with the binary SITESOLIDE_BINARY names, and `kitEnv()` puts their folder
 * first on the PATH of every script the CLI starts: the scripts run on the
 * Bun they were released with, whatever the workstation has. bin/config.sh
 * puts it first as well, for a script of an unpacked kit started by hand.
 *
 * BUN_BE_BUN stays in the environment of what that bun starts, and nothing
 * here can take it out. Bun reads it from the environment it was started
 * with, and hands that same environment down whatever the script does to
 * process.env; started as `bun` without the variable, through argv[0], the
 * binary is sitesolide again. A `sitesolide` started by such a bun would
 * behave as Bun too: nothing in the kit does that, and a project's build that
 * did would have to unset it.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { EMBEDDED_KIT } from "./kit-archive";

/** Replaced by bin/build.ts with the release's tag; undeclared, hence `dev`, everywhere else. */
declare const SITESOLIDE_BUILD_VERSION: string | undefined;

/** This build's version: the tag it was released from, or `dev` outside a release build. */
export const VERSION: string = typeof SITESOLIDE_BUILD_VERSION === "string" ? SITESOLIDE_BUILD_VERSION : "dev";

/** The repository's root, the kit of every run that is not a compiled binary. */
const REPOSITORY = resolve(import.meta.dir, "..", "..");

/** Written last into an unpacked kit: its presence says the folder is whole. */
export const KIT_MARKER = ".kit.json";

/** The kit's folder holding the bun shims, put first on the PATH of its scripts. */
export const SHIM_FOLDER = ".bin";

/** A PATH for a process that was started without one. */
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

/** A temporary or set-aside folder older than this is a run that died, and is removed. */
const STALE_MS = 60 * 60 * 1000;

/** One file of the kit, as the archive's header lists it. */
export type KitFile = { path: string; mode: number; size: number; sha256: string };

/** A file to pack: its path inside the kit, its mode, its bytes. */
export type KitEntry = { path: string; mode: number; content: Uint8Array };

/** What a run needs from the kit and cannot have; the CLI words it as a refusal. */
export class KitUnavailable extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Whether this process is a compiled binary. `Bun.isStandaloneExecutable` says
 * so on the Bun releases that have it; on the older ones, a compiled binary is
 * the one whose modules live in its embedded file system, under `/$bunfs`.
 */
export function isCompiled(): boolean {
  const flag = (Bun as { isStandaloneExecutable?: boolean }).isStandaloneExecutable;
  return flag ?? import.meta.dir.startsWith("/$bunfs");
}

/**
 * Whether `path` stays inside the kit: relative, normalised, without `..`.
 * The archive is this repository's own, built by bin/build.ts; the check
 * costs nothing, and keeps a damaged header from writing anywhere but the kit.
 */
export function isKitPath(path: string): boolean {
  const normalised = normalize(path);
  return path !== "" && !isAbsolute(path) && normalised === path && !normalised.split("/").includes("..");
}

/**
 * The archive: a header line, the JSON list of the files, then their bytes
 * one after the other in that order, the whole gzipped. `hash` is the SHA-256
 * of what was gzipped, which names the kit's folder and is checked again
 * before anything is unpacked.
 */
export function packKit(entries: KitEntry[]): { archive: Uint8Array<ArrayBuffer>; hash: string; files: KitFile[]; size: number } {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const outside = sorted.find((entry) => !isKitPath(entry.path));
  if (outside !== undefined) throw new Error(`not a path inside the kit: ${JSON.stringify(outside.path)}`);
  const files: KitFile[] = sorted.map((entry) => ({
    path: entry.path,
    mode: entry.mode & 0o777,
    size: entry.content.byteLength,
    sha256: sha256(entry.content),
  }));
  const header = new TextEncoder().encode(`${JSON.stringify({ format: 1, files })}\n`);
  const payload = new Uint8Array(header.byteLength + files.reduce((total, file) => total + file.size, 0));
  payload.set(header, 0);
  let offset = header.byteLength;
  for (const entry of sorted) {
    payload.set(entry.content, offset);
    offset += entry.content.byteLength;
  }
  return { archive: Bun.gzipSync(payload, { level: 9 }), hash: sha256(payload), files, size: payload.byteLength };
}

/** Where a kit of this version and hash is unpacked: `<cache>/sitesolide/<version>-<hash>`. */
export function kitDirectory(version: string, hash: string, environment: Record<string, string | undefined>, home = homedir()): string {
  // The XDG specification ignores a relative XDG_CACHE_HOME, and so does this.
  const xdg = environment.XDG_CACHE_HOME;
  const cache = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".cache");
  return join(cache, "sitesolide", `${version}-${hash.slice(0, 16)}`);
}

/** Whether `folder` is a whole kit of this hash: its marker, written last, names it. */
export function isWholeKit(folder: string, hash: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(folder, KIT_MARKER), "utf8")) as { hash?: unknown }).hash === hash;
  } catch {
    return false;
  }
}

/** The mode a kit's file has once unpacked: the archive's, without any write bit. */
export function readOnly(mode: number): number {
  return mode & 0o555;
}

/**
 * Removes a folder, read-only as a kit is: a folder without its write bit
 * keeps its entries, so every folder below gets it back first. Nothing there,
 * nothing done.
 */
export function removeTree(path: string): void {
  const reopen = (folder: string): void => {
    try {
      chmodSync(folder, 0o700);
    } catch {
      return;
    }
    for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) reopen(join(folder, entry.name));
  };
  try {
    if (lstatSync(path).isDirectory()) reopen(path);
  } catch {
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

/**
 * Removes what earlier runs left beside the kits when they died: temporary
 * folders and folders set aside, all older than an hour. A younger one may
 * belong to a run in progress, and is left alone.
 */
function sweep(parent: string, now: number): void {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(".") || !/\.(tmp|aside)$/.test(name)) continue;
    const path = join(parent, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) removeTree(path);
    } catch {
      // Gone already: another run swept it.
    }
  }
}

/** A name for a sibling of `destination` that no other run will pick. */
function sibling(destination: string, suffix: string): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36);
  return join(dirname(destination), `.${basename(destination)}.${process.pid}.${random}.${suffix}`);
}

/**
 * Unpacks `archive` into `destination`, unless a whole kit of this hash is
 * already there. See the header of this file for the order of the gestures,
 * which is what makes two runs started together safe.
 */
export function unpackKit(archive: Uint8Array<ArrayBuffer>, hash: string, destination: string, version = VERSION): void {
  if (isWholeKit(destination, hash)) return;

  const payload = Bun.gunzipSync(archive);
  if (sha256(payload) !== hash) {
    throw new KitUnavailable("the kit embedded in this binary is damaged: its hash does not match", [
      "download the release again, or build the binary again with `bun bin/build.ts`",
    ]);
  }
  const newline = payload.indexOf(10);
  const header = JSON.parse(new TextDecoder().decode(payload.subarray(0, newline))) as { format: number; files: KitFile[] };
  if (header.format !== 1) {
    throw new KitUnavailable(`the kit embedded in this binary has a format this binary does not read: ${header.format}`);
  }
  const outside = header.files.find((file) => !isKitPath(file.path));
  if (outside !== undefined) {
    throw new KitUnavailable(`the kit embedded in this binary is damaged: ${JSON.stringify(outside.path)} is not a path inside it`, [
      "download the release again, or build the binary again with `bun bin/build.ts`",
    ]);
  }

  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  sweep(parent, Date.now());
  const temporary = sibling(destination, "tmp");
  const folders = new Set<string>([temporary]);
  try {
    let offset = newline + 1;
    for (const file of header.files) {
      const target = join(temporary, file.path);
      mkdirSync(dirname(target), { recursive: true });
      for (let folder = dirname(target); folder !== temporary; folder = dirname(folder)) folders.add(folder);
      writeFileSync(target, payload.subarray(offset, offset + file.size));
      // After the write, so that the umask has no say: a script stays
      // executable, and nothing keeps a write bit.
      chmodSync(target, readOnly(file.mode));
      offset += file.size;
    }
    // Read back, not trusted: a disk that filled up or a write cut short
    // shows here, before the folder is put in place.
    for (const file of header.files) {
      const target = join(temporary, file.path);
      const stat = statSync(target);
      if ((stat.mode & 0o777) !== readOnly(file.mode) || stat.size !== file.size || sha256(readFileSync(target)) !== file.sha256) {
        throw new KitUnavailable(`cannot unpack the kit into ${destination}`, [`${file.path} did not read back as it was written`]);
      }
    }
    const marker = join(temporary, KIT_MARKER);
    writeFileSync(marker, `${JSON.stringify({ version, hash, files: header.files.length })}\n`);
    chmodSync(marker, 0o444);
    // The folders last, the deepest first: each one closed once nothing is
    // left to write in it. All but the kit's own root, which place() closes
    // once it has its name: macOS 15 refuses to rename a folder its owner
    // cannot write (EACCES), which macOS 26 and Linux allow. GitHub's macOS
    // runner met it on the first release built there, and so would every
    // workstation on that system, at the binary's first run.
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
      if (folder !== temporary) chmodSync(folder, 0o555);
    }
    place(temporary, destination, hash);
  } finally {
    removeTree(temporary);
  }
}

/**
 * Renames the checked kit into place. A rename onto a folder that holds
 * something fails: if that folder is a whole kit of this hash, another run
 * got there first and its kit is used; if it is not, it is set aside, and the
 * rename tried once more.
 */
function place(temporary: string, destination: string, hash: string): void {
  let failure: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      renameSync(temporary, destination);
      chmodSync(destination, 0o555);
      return;
    } catch (error) {
      failure = error;
    }
    if (isWholeKit(destination, hash)) return;
    if (attempt === 0 && existsSync(destination)) {
      const aside = sibling(destination, "aside");
      try {
        // Writable for the rename, as above: a read-only folder cannot be
        // moved on macOS 15. A real folder only: chmod would follow a link.
        if (lstatSync(destination).isDirectory()) chmodSync(destination, 0o755);
        renameSync(destination, aside);
      } catch {
        // Another run set it aside first.
      }
      removeTree(aside);
    }
  }
  throw new KitUnavailable(`cannot unpack the kit into ${destination}`, [
    (failure as Error).message,
    "if that folder exists, it is not a kit this binary unpacked: remove it, then run the same command again",
  ]);
}

/** The kit's folder in this process, once unpacked. */
let unpacked: string | null = null;

/**
 * Where the kit lives: the repository, or the folder a compiled binary
 * unpacked it into, unpacking it on the first call. Throws KitUnavailable
 * when it cannot, which the CLI turns into a refusal.
 */
export function kitRoot(): string {
  if (!isCompiled()) return REPOSITORY;
  if (unpacked !== null) return unpacked;
  if (EMBEDDED_KIT === null) {
    throw new KitUnavailable("this binary carries no kit", [
      "it was compiled without bin/build.ts, which embeds the scripts and the files they read",
      "build it with `bun bin/build.ts`, or install a release",
    ]);
  }
  const destination = kitDirectory(VERSION, EMBEDDED_KIT.hash, process.env);
  // Every run after the first finds its kit whole, and reads nothing more
  // than the marker: the archive is read only to be unpacked.
  if (!isWholeKit(destination, EMBEDDED_KIT.hash)) {
    try {
      unpackKit(new Uint8Array(readFileSync(EMBEDDED_KIT.path)), EMBEDDED_KIT.hash, destination);
    } catch (error) {
      if (error instanceof KitUnavailable) throw error;
      throw new KitUnavailable(`cannot unpack the kit into ${destination}`, [
        (error as Error).message,
        "the folder must be writable: free some space, fix its permissions, or point XDG_CACHE_HOME at a writable folder",
      ]);
    }
  }
  unpacked = destination;
  return destination;
}

/**
 * Copies `source` into `destination` with the write bits a checkout has: the
 * owner may write every file and folder, and nothing else changes. rsync -a
 * carries modes to the machine, and a release uploaded read-only could not
 * take its node_modules, nor be replaced by the next one.
 */
function copyWritable(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  chmodSync(destination, 0o755);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyWritable(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, (statSync(from).mode & 0o777) | 0o200);
    }
  }
}

/**
 * One component of the kit, `dashboard` or `portal`, where a command may
 * write into it and upload it. In the repository, the component itself: a
 * checkout is writable, and a manifest rewritten there is one to commit. From
 * a compiled binary, a writable copy in a temporary folder of its own, thrown
 * away when the process ends: the kit is read-only, and what a deployment
 * writes there, the door the dashboard set, a port, belongs to no repository.
 */
export function kitComponent(name: string): string {
  const source = join(kitRoot(), name);
  if (!isCompiled()) return source;
  if (!isKitPath(name) || name.includes("/") || !existsSync(join(source, "sitesolide.json"))) {
    throw new KitUnavailable(`the kit has no component named ${JSON.stringify(name)}`, [
      "a component is a folder of the kit that holds a sitesolide.json: dashboard, portal, analytics",
    ]);
  }
  const copy = mkdtempSync(join(tmpdir(), `sitesolide-${name}-`));
  process.on("exit", () => removeTree(copy));
  copyWritable(source, copy);
  return copy;
}

/** A path with its symbolic links resolved, or as it is when it does not exist. */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The folder a command works in: `folder` itself, unless it lies inside the
 * unpacked kit, read-only; then the same place in a writable copy of its
 * component, see `kitComponent`. Unpacks nothing: a folder can only be inside
 * a kit that is already there.
 */
export function workingFolder(folder: string): string {
  if (!isCompiled() || EMBEDDED_KIT === null) return folder;
  const kit = real(kitDirectory(VERSION, EMBEDDED_KIT.hash, process.env));
  const inside = relative(kit, real(folder));
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return folder;
  const [component, ...rest] = inside.split(sep);
  // Elsewhere in the kit, bin/ or infra/, nothing is deployed: the folder is
  // read as it is, and a write there fails, as it should.
  if (!existsSync(join(kit, component!, "sitesolide.json"))) return folder;
  return join(kitComponent(component!), ...rest);
}

/**
 * What a script of the kit needs in its environment: nothing in the
 * repository; from a compiled binary, the shims first on the PATH, the binary
 * they run, and the version, which bin/deploy-api.sh names its releases after
 * since an unpacked kit is no git checkout.
 */
export function kitEnv(): Record<string, string> {
  if (!isCompiled()) return {};
  return {
    PATH: `${join(kitRoot(), SHIM_FOLDER)}:${process.env.PATH ?? DEFAULT_PATH}`,
    SITESOLIDE_BINARY: process.execPath,
    SITESOLIDE_KIT_VERSION: VERSION,
  };
}

/**
 * What a project's own build, and the command `sitesolide run` starts, need:
 * the project's toolchain is its owner's, so the shims come last on the PATH,
 * and only on a workstation with no `bun` of its own. A Bun project then
 * builds where Bun was never installed, and one that has its own Bun keeps it.
 */
export function projectEnv(): Record<string, string> {
  if (!isCompiled() || Bun.which("bun") !== null) return {};
  return {
    PATH: `${process.env.PATH ?? DEFAULT_PATH}:${join(kitRoot(), SHIM_FOLDER)}`,
    SITESOLIDE_BINARY: process.execPath,
  };
}

/**
 * The two shims the kit carries in `.bin/`, packed by bin/build.ts. Each runs
 * the binary SITESOLIDE_BINARY names as Bun, or the `sitesolide` of the PATH
 * for a script started by hand, outside the CLI.
 */
export function shims(): KitEntry[] {
  const shim = (name: string, command: string): KitEntry => ({
    path: `${SHIM_FOLDER}/${name}`,
    mode: 0o755,
    content: new TextEncoder().encode(
      [
        "#!/bin/sh",
        `# ${name}, played by the sitesolide binary: BUN_BE_BUN=1 makes it skip its`,
        "# own entry point and behave as the bun CLI. Laid by bin/build.ts, see",
        "# bin/cli/kit.ts.",
        'binary="${SITESOLIDE_BINARY:-}"',
        'if [ -z "$binary" ]; then binary="$(command -v sitesolide 2>/dev/null || true)"; fi',
        'if [ -z "$binary" ]; then',
        `  echo "${name}: no sitesolide binary to play it: SITESOLIDE_BINARY is unset and sitesolide is not on the PATH" >&2`,
        "  exit 127",
        "fi",
        `BUN_BE_BUN=1 exec "$binary" ${command}"$@"`,
        "",
      ].join("\n"),
    ),
  });
  return [shim("bun", ""), shim("bunx", "x ")];
}
