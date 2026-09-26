/**
 * The gatekeeper's real machine: disk, `caddy validate`, `systemctl`, probes.
 *
 * It decides nothing. Every path and every command come from `MachineConfig`,
 * so that the tests mount it as it stands on a throwaway tree in front of a
 * test Caddy, `systemctl` alone replaced.
 *
 * **Synchronous `node:fs`, like src/secrets/system.ts**, and for the same
 * reasons: `O_EXCL`, `O_NOFOLLOW`, `fchown` on the descriptor before the first
 * write, `fsync` of the file then of the directory do not exist in `Bun.file`.
 *
 * **The rights the unit must give, and why** (measured on the bench on 17 September 2026, measurement 5):
 *
 *   - CAP_DAC_OVERRIDE: /srv/sites/<slug> belongs to the deployment account in
 *     0755. Root is only one more there, and creating the temporary file then
 *     renaming it onto sitesolide.json demands the right to write in that
 *     directory. The unit bounds the writing to the directory of the named
 *     site alone (`ReadWritePaths=/srv/sites/%i`);
 *   - CAP_CHOWN: giving the rewritten manifest back to its owner, the
 *     deployment account. The mode is set before the owner, while the file
 *     still belongs to root: afterwards, `fchmod` would demand CAP_FOWNER;
 *   - nothing for /etc/caddy/sites nor /run/sitesolide-gatekeeper, root's;
 *   - nothing for `systemctl`: PID 1 judges the caller's uid 0 by the socket,
 *     not its capabilities (measurement for the steward, RESULTS.md,
 *     measurement 3);
 *   - nothing for `caddy validate`: /usr/bin/caddy carries no file capability
 *     on the VM (`security.capability` incomplete, reading of 17 September 2026),
 *     and therefore asks none of the bounding set.
 *
 * `caddy validate` inherits these capabilities and asks for no other, as long
 * as /etc/caddy/cloudflare.env stays readable by root.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidSlug } from "../../borrowed/manifest";
import { parseEnvBytes } from "../secrets/envfile";
import { BACKUPS_NAME, HOLDER_NAME, LOCK_NAME } from "./instance";
import {
  judgeLock,
  holderText,
  type Command,
  type Permissions,
  type Release,
  type Machine,
  type ManifestRead,
  type LockResult,
  type Backup,
} from "./machine";
import type { ProbeResponse } from "./probe";

/** What running a command returns, before any interpretation. */
export type Execution = { code: number; stdout: string; stderr: string };

/** `systemctl` and its arguments, bounded in time. Replaced by the tests. */
export type Systemctl = (arguments_: string[], timeoutMs: number) => Promise<Execution>;

export type MachineConfig = {
  /** /srv/sites */
  sitesDir: string;
  /** /etc/caddy/sites */
  blocksFolder: string;
  /** /etc/caddy/Caddyfile */
  caddyfile: string;
  /** /etc/caddy/cloudflare.env, which systemd injects into Caddy through EnvironmentFile. */
  caddyEnvFile: string;
  /**
   * /etc/caddy/sitesolide.env: the served zone, the authority's contact
   * address and the label that carries the slug. The Caddyfile and the
   * fragments name no machine, they read these variables, and `caddy validate`
   * would refuse them without these.
   *
   * A second file rather than one more line in the first: nothing here is
   * secret, and the values of the first are purged from the log. The zone,
   * purged, would make the slightest error message unreadable, every address
   * carrying it.
   */
  zoneEnvFile: string;
  /** The binary, /usr/bin/caddy. Never called with anything but `validate`. */
  caddy: string;
  /** /run/sitesolide-gatekeeper: lock, backups, results. */
  runFolder: string;
  /** root:root for a block, like bin/deploy-caddy.sh. null: unchanged, for the workstation. */
  blockOwner: { uid: number; gid: number } | null;
  /** Where to reach Caddy: the loopback and port 443 in production. */
  probeConfig: { address: string; port: number; ca: string | null };
  /** caddy.service */
  caddyUnit: string;
  /** sitesolide-collector.service */
  collectorUnit: string;
  systemctl: Systemctl;
  log: (line: string) => void;
};

/** A manifest or a block has no reason to be any bigger. */
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_OUTPUT = 16 * 1024;
/** What the probe reads at most of a body: `/sante` fits in a few dozen bytes. */
export const MAX_BODY = 4 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function code(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Runs a command, bounded in time, output truncated. Never fails by exception. */
export async function spawn(
  command: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<Execution> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const process = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
      signal: timeout,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, output] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const truncated = (text: string) => (text.length > MAX_OUTPUT ? text.slice(-MAX_OUTPUT) : text);
    if (timeout.aborted) {
      return { code: 124, stdout: truncated(stdout), stderr: `${truncated(stderr)}\nError: timed out after ${timeoutMs} ms` };
    }
    return { code: output, stdout: truncated(stdout), stderr: truncated(stderr) };
  } catch (error) {
    return { code: 127, stdout: "", stderr: `Error: cannot run ${command[0]}: ${(error as Error).message}` };
  }
}

export function realSystemctl(path: string): Systemctl {
  return (arguments_, timeoutMs) => spawn([path, ...arguments_], timeoutMs, { PATH: "/usr/bin:/bin" });
}

function toCommand(execution: Execution): Command {
  return { ok: execution.code === 0, output: `${execution.stderr}\n${execution.stdout}` };
}

/**
 * Reads a file without following a link, and only if it is regular, with a
 * single link and of reasonable size. null if it is missing; an exception if it
 * is there but not readable without risk.
 */
function readFileSafely(path: string): { bytes: Uint8Array; permissions: Permissions; modifiedAt: number } | null {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (!before.isFile()) throw new Error(`${path} is not a regular file`);
  if (before.nlink > 1) throw new Error(`${path} has more than one link`);
  if (before.size > MAX_TEXT_BYTES) throw new Error(`${path} is too large`);

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error(`${path} was replaced while being read`);
    const buffer = new Uint8Array(MAX_TEXT_BYTES + 1);
    let fieldsRead = 0;
    for (;;) {
      const n = readSync(fd, buffer, fieldsRead, buffer.length - fieldsRead, null);
      if (n === 0) break;
      fieldsRead += n;
      if (fieldsRead > MAX_TEXT_BYTES) throw new Error(`${path} is too large`);
    }
    return {
      bytes: buffer.slice(0, fieldsRead),
      permissions: { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 },
      modifiedAt: stat.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

/** A real directory, not a link: the slug ends up in a path written under root. */
function requireFolder(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} is not a plain directory`);
}

function syncFolder(folder: string): void {
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function suffix(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((o) => o.toString(16).padStart(2, "0")).join("");
}

/**
 * Temporary file in `O_EXCL`, in root's name and in 0600; mode, then owner,
 * then content; `fsync`, rename, `fsync` of the directory. The temporary file
 * ends in `.tmp`: in /etc/caddy/sites, `import /etc/caddy/sites/*.caddy` never
 * reads it, even when left behind by an abrupt stop.
 */
function writeAtomically(
  folder: string,
  name: string,
  text: string,
  mode: number,
  owner: { uid: number; gid: number } | null,
): void {
  const final = join(folder, name);
  const temporary = join(folder, `.${name}.${suffix()}.tmp`);
  const bytes = encoder.encode(text);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let place = false;
  try {
    try {
      fchmodSync(fd, mode);
      if (owner !== null) fchownSync(fd, owner.uid, owner.gid);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, final);
    place = true;
    syncFolder(folder);
  } finally {
    if (!place) {
      try {
        unlinkSync(temporary);
      } catch {
        // already gone
      }
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process lives under that pid, under another account. When in
    // doubt, alive: the lock's age will decide.
    return code(error) !== "ESRCH";
  }
}

/**
 * The variables of /etc/caddy/cloudflare.env, read by the module that knows how
 * to read this file exactly as systemd does (src/secrets/envfile.ts). A file
 * it refuses is not guessed at: the validation fails, before any action at all.
 * The reason never quotes a line of the file.
 */
function readCaddyEnv(path: string): { ok: true; variables: Record<string, string> } | { ok: false; error: string } {
  let parsed;
  try {
    parsed = readFileSafely(path);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (parsed === null) return { ok: false, error: `${path} is missing` };
  const analyse = parseEnvBytes(parsed.bytes);
  if (!analyse.ok) return { ok: false, error: `${path} line ${analyse.line}: ${analyse.reason}` };
  const variables: Record<string, string> = {};
  for (const line of analyse.document.lines) {
    if (line.kind === "assignment") variables[line.key] = line.value;
  }
  return { ok: true, variables };
}

/** Every value of Caddy's environment removed from a text meant for the log. */
export function redact(text: string, secrets: string[]): string {
  let clean = text;
  for (const value of secrets) {
    if (value.length >= 4) clean = clean.split(value).join("[redacted]");
  }
  return clean;
}

/**
 * At most `max` bytes of the body, then the connection closed.
 *
 * `response.text()` read everything: a compromised site that answers with an
 * endless body got the gatekeeper killed at `MemoryMax`, with neither restore
 * nor result, and its backup then refused every action. Measured on Bun
 * 1.3.11: `text()` on a fast stream climbs to 3 GiB before the delay. And the
 * reader's `cancel()` is not enough: Bun goes on receiving and discarding the
 * stream (1 GiB in two seconds) as long as the request is not interrupted.
 * `close` interrupts it.
 *
 * The request's delay runs on the body too: a site that sends its headers then
 * falls silent returns `TimeoutError`, as before.
 */
async function readStart(response: Response, max: number, timeout: AbortSignal, close: () => void): Promise<Uint8Array> {
  const stream = response.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cut = () => {
    reader.cancel().catch(() => {});
  };
  timeout.addEventListener("abort", cut, { once: true });
  try {
    while (total < max && !timeout.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      const kept = value.subarray(0, max - total);
      chunks.push(kept);
      total += kept.length;
    }
    if (timeout.aborted) throw timeout.reason;
  } finally {
    timeout.removeEventListener("abort", cut);
    close();
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  return bytes;
}

export function createMachine(config: MachineConfig): Machine {
  const backupsFolder = join(config.runFolder, BACKUPS_NAME);
  const lockPath = join(config.runFolder, LOCK_NAME);

  function siteFolder(slug: string): string {
    if (!isValidSlug(slug)) throw new Error("invalid slug");
    return join(config.sitesDir, slug);
  }

  function blockName(slug: string): string {
    if (!isValidSlug(slug)) throw new Error("invalid slug");
    return `${slug}.caddy`;
  }

  /**
   * The lock as it stands: its inode, its date, and the holder's text, null if
   * it is missing or not readable without risk. null altogether if the lock
   * itself has disappeared.
   */
  function examineLock(path: string): { ino: number; modifiedAt: number; text: string | null } | null {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (code(error) === "ENOENT") return null;
      throw error;
    }
    let text: string | null = null;
    try {
      const parsed = readFileSafely(join(path, HOLDER_NAME));
      text = parsed === null ? null : decoder.decode(parsed.bytes);
    } catch {
      // A link, a directory, a file too big: unreadable, therefore held.
      text = null;
    }
    return { ino: stat.ino, modifiedAt: stat.mtimeMs, text };
  }

  async function validation(timeoutMs: number): Promise<Command> {
    const parsed = readCaddyEnv(config.caddyEnvFile);
    if (!parsed.ok) return { ok: false, output: `Error: ${parsed.error}` };
    const env = parsed.variables;

    // The zone's variables, which Caddy substitutes before reading the file.
    // Their absence is not a missing secret but a badly set up machine, and
    // the message says so as it stands.
    const zone = readCaddyEnv(config.zoneEnvFile);
    if (!zone.ok) return { ok: false, output: `Error: ${zone.error}` };
    // A throwaway HOME and throwaway XDG directories: validate must write
    // nothing into Caddy's storage, and /root is masked by ProtectHome.
    // PrivateTmp makes them disappear with the unit.
    const disposable = mkdtempSync(join(tmpdir(), "gatekeeper-validate-"));
    try {
      const execution = await spawn(
        [config.caddy, "validate", "--config", config.caddyfile, "--adapter", "caddyfile"],
        timeoutMs,
        {
          PATH: "/usr/bin:/bin",
          HOME: disposable,
          XDG_DATA_HOME: join(disposable, "data"),
          XDG_CONFIG_HOME: join(disposable, "config"),
          ...zone.variables,
          ...env,
        },
      );
      const command = toCommand(execution);
      return { ok: command.ok, output: redact(command.output, Object.values(env)) };
    } finally {
      rmSync(disposable, { recursive: true, force: true });
    }
  }

  return {
    now: () => Date.now(),
    wait: (ms) => Bun.sleep(ms),
    log: config.log,

    async takeLock(): Promise<LockResult> {
      mkdirSync(config.runFolder, { recursive: true, mode: 0o755 });

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Non-recursive: EEXIST if another holds it. That is the only taking.
          mkdirSync(lockPath, { mode: 0o755 });
        } catch (error) {
          if (code(error) !== "EEXIST") throw error;

          const found = examineLock(lockPath);
          if (found === null) continue;
          const judgement = judgeLock(found.text, found.modifiedAt, Date.now(), alive);
          if (judgement.kind === "held") {
            return { kind: "held", who: judgement.holder?.who ?? null, since: judgement.since };
          }

          // Takeover of a stale lock. The rename is atomic: of two that judge
          // it stale together, only one sets it aside. The one that would have
          // set aside a brand-new lock, taken between its examination and its
          // rename, recognises it by its inode and puts it back in place.
          const setAside = join(config.runFolder, `.${LOCK_NAME}.${suffix()}.stale`);
          try {
            renameSync(lockPath, setAside);
          } catch (renameError) {
            if (code(renameError) === "ENOENT") continue;
            throw renameError;
          }
          if (lstatSync(setAside).ino !== found.ino) {
            try {
              renameSync(setAside, lockPath);
            } catch {
              // A third took the place in the meantime: he holds it.
              rmSync(setAside, { recursive: true, force: true });
            }
            continue;
          }
          const who = judgement.holder === null ? "an unreadable holder" : `${judgement.holder.who} ${judgement.holder.pid}`;
          config.log(
            `gatekeeper: stale Caddy lock of ${who} since ${new Date(judgement.since).toISOString()} taken over (${judgement.reason})`,
          );
          rmSync(setAside, { recursive: true, force: true });
          continue;
        }

        const mine = holderText({ who: "gatekeeper", pid: process.pid, a: Date.now() });
        try {
          writeAtomically(lockPath, HOLDER_NAME, mine, 0o644, null);
        } catch (error) {
          rmSync(lockPath, { recursive: true, force: true });
          throw error;
        }
        const release: Release = () => {
          try {
            const current = examineLock(lockPath);
            if (current === null) {
              config.log("gatekeeper: the Caddy lock was already gone when released");
            } else if (current.text !== mine) {
              config.log("gatekeeper: the Caddy lock was taken over by another, left in place");
            } else {
              rmSync(lockPath, { recursive: true, force: true });
            }
          } catch (error) {
            config.log(`gatekeeper: the Caddy lock could not be released: ${(error as Error).message}`);
          }
        };
        return { kind: "taken", release };
      }
      // Three takeovers in a row lost: somebody else is dealing with it.
      const last = examineLock(lockPath);
      return { kind: "held", who: null, since: last?.modifiedAt ?? Date.now() };
    },

    async interruptedTransaction() {
      try {
        const entries = readdirSync(backupsFolder).sort();
        return entries[0] ?? null;
      } catch (error) {
        if (code(error) === "ENOENT") return null;
        throw error;
      }
    },

    async saveBackup(slug: string, backup: Backup) {
      if (!isValidSlug(slug)) throw new Error("invalid slug");
      const folder = join(backupsFolder, slug);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeAtomically(folder, "sitesolide.json", backup.manifest.text, 0o600, null);
      writeAtomically(folder, "permissions.json", `${JSON.stringify(backup.manifest.permissions)}\n`, 0o600, null);
      if (backup.block === null) writeAtomically(folder, `${slug}.caddy.absent`, "", 0o600, null);
      else writeAtomically(folder, `${slug}.caddy`, backup.block, 0o600, null);
    },

    async clearBackup(slug: string) {
      if (!isValidSlug(slug)) throw new Error("invalid slug");
      rmSync(join(backupsFolder, slug), { recursive: true, force: true });
      try {
        if (readdirSync(backupsFolder).length === 0) rmSync(backupsFolder, { recursive: true, force: true });
      } catch {
        // already gone
      }
    },

    async readManifest(slug: string): Promise<ManifestRead | null> {
      const folder = siteFolder(slug);
      try {
        requireFolder(folder);
      } catch (error) {
        if (code(error) === "ENOENT") return null;
        throw error;
      }
      const parsed = readFileSafely(join(folder, "sitesolide.json"));
      if (parsed === null) return null;
      return { text: decoder.decode(parsed.bytes), permissions: parsed.permissions };
    },

    async readBlock(slug: string) {
      const parsed = readFileSafely(join(config.blocksFolder, blockName(slug)));
      return parsed === null ? null : decoder.decode(parsed.bytes);
    },

    async writeManifest(slug: string, text: string, permissions: Permissions) {
      const folder = siteFolder(slug);
      requireFolder(folder);
      writeAtomically(folder, "sitesolide.json", text, permissions.mode & 0o777, { uid: permissions.uid, gid: permissions.gid });
    },

    async writeBlock(slug: string, text: string) {
      requireFolder(config.blocksFolder);
      writeAtomically(config.blocksFolder, blockName(slug), text, 0o644, config.blockOwner);
    },

    async removeBlock(slug: string) {
      try {
        unlinkSync(join(config.blocksFolder, blockName(slug)));
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
      syncFolder(config.blocksFolder);
    },

    validateCaddy: validation,

    async reloadCaddy(timeoutMs: number) {
      return toCommand(await config.systemctl(["reload", config.caddyUnit], timeoutMs));
    },

    async startCaddy(timeoutMs: number) {
      return toCommand(await config.systemctl(["start", config.caddyUnit], timeoutMs));
    },

    async isCaddyActive(timeoutMs: number) {
      return (await config.systemctl(["is-active", "--quiet", config.caddyUnit], timeoutMs)).code === 0;
    },

    async servedSites(timeoutMs: number) {
      const candidates = readdirSync(config.sitesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isValidSlug(entry.name))
        .map((entry) => entry.name)
        .sort();

      const served = new Set<string>();
      const toAsk: string[] = [];
      for (const slug of candidates) {
        let publicFiles = 0;
        try {
          publicFiles = readdirSync(join(config.sitesDir, slug, "public")).length;
        } catch {
          publicFiles = 0;
        }
        if (publicFiles > 0) served.add(slug);
        else toAsk.push(slug);
      }

      // A single question for all of them: `is-active` returns one line per
      // unit, in order, and a non-zero code as soon as a single one is inactive.
      if (toAsk.length > 0) {
        const execution = await config.systemctl(["is-active", ...toAsk.map((s) => `${s}.service`)], timeoutMs);
        const lines = execution.stdout.split("\n");
        toAsk.forEach((slug, i) => {
          if (lines[i]?.trim() === "active") served.add(slug);
        });
      }
      return [...served].sort();
    },

    async probe(host: string, path: string, timeoutMs: number): Promise<ProbeResponse> {
      // Measured on 17 September 2026 on Bun 1.3.11, against a local Caddy with
      // two certificates: the Host header sets the SNI AND the name the
      // certificate must carry. A certificate with another name fails with
      // ERR_TLS_CERT_ALTNAME_INVALID. It is the equivalent of `curl --resolve`,
      // verification included. `keepalive: false` so that a connection opened
      // for one host never serves to question another.
      //
      // The body comes from a site that may be compromised: see `readStart`.
      // `Accept-Encoding: identity` so that an honest site sends nothing
      // compressed, and `decompress: false` so that a dishonest site cannot
      // inflate a gzip bomb inside the gatekeeper: measured on Bun 1.3.11,
      // 256 MiB of compressed zeros take the process up to 140 MiB from the
      // very first read, against 34 without decompression. The option exists at
      // runtime without appearing in bun-types' types.
      const url = `https://${config.probeConfig.address}:${config.probeConfig.port}${path}`;
      const timeout = AbortSignal.timeout(timeoutMs);
      const closing = new AbortController();
      const options: BunFetchRequestInit & { decompress: boolean } = {
        headers: { Host: host, "Accept-Encoding": "identity" },
        redirect: "manual",
        keepalive: false,
        decompress: false,
        signal: AbortSignal.any([timeout, closing.signal]),
        ...(config.probeConfig.ca === null ? {} : { tls: { ca: config.probeConfig.ca } }),
      };
      try {
        const response = await fetch(url, options);
        const bytes = await readStart(response, MAX_BODY, timeout, () => closing.abort());
        return {
          code: response.status,
          door: response.headers.get("x-portal") === "connexion",
          body: decoder.decode(bytes),
        };
      } catch (error) {
        // The code alone when it exists (ConnectionRefused,
        // ERR_TLS_CERT_ALTNAME_INVALID), otherwise the name (TimeoutError,
        // whose code is a number): Bun's message quotes the URL again and a hint.
        const { code: kind, name, message } = error as { code?: unknown; name?: string; message?: string };
        const short =
          typeof kind === "string" ? kind : name !== undefined && name !== "Error" ? name : (message ?? String(error));
        return { error: short.length > 120 ? `${short.slice(0, 120)}...` : short };
      } finally {
        closing.abort();
      }
    },

    async restartCollector(timeoutMs: number) {
      return toCommand(await config.systemctl(["start", "--no-block", config.collectorUnit], timeoutMs));
    },
  };
}

/**
 * The result, in /run/sitesolide-gatekeeper/<slug>.json, root 0644: the steward
 * re-reads it after `systemctl start`, which returns nothing but a code.
 * Written by rename, so that it never reads half of it.
 */
export function writeResult(runFolder: string, slug: string, result: unknown): void {
  if (!isValidSlug(slug)) throw new Error("invalid slug");
  mkdirSync(runFolder, { recursive: true, mode: 0o755 });
  writeAtomically(runFolder, `${slug}.json`, `${JSON.stringify(result)}\n`, 0o644, null);
}
