/**
 * The backup component's modes, one file for all of them, built by
 * bin/deploy-backup.sh into /usr/local/lib/sitesolide/backup.js:
 *
 *   backup.js run                     the timer's run, as root
 *   backup.js restore <unit name>     a restore, as root, from its template unit
 *   backup.js after-restore <unit>    its ExecStopPost: a restore cut short never leaves a site stopped
 *   backup.js copy <data> ...         as a project, the archive on stdout
 *   backup.js extract <folder> ...    as a project, the archive on stdin
 *   backup.js measure <data>          as a project, what its data weighs
 *   backup.js download <folder> <s>   as a dynamic user, a snapshot of the bucket's repository on stdout
 *   backup.js hook <dir> <ms> <cmd>   as a project, a service's backup command
 *   backup.js discard <dir>           as a project, what the backup commands left, removed
 *   backup.js list <folder>           what `sitesolide backups` prints, read-only
 *   backup.js decrypt <in> <out>      an object of the format before restic back to a tar.gz, anywhere
 *   backup.js features                what this build does that an older one did not
 *
 * `dashboard/backup.ts` does nothing but call `main`: the body lives here, so
 * that typing and the tests cover it.
 *
 * The exit code of `restore` does not carry the verdict, like the gatekeeper's:
 * the result file does, and a refused restore is not a failed unit.
 */
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isBackupFolder, SERVICE_COMMANDS_FEATURE, type Listing, type ListedSnapshot } from "../../borrowed/backups";
import { copyMain, discardMain, downloadMain, extractMain, hookMain, measureMain } from "./child";
import { configFrom, type Environment } from "./config";
import { decryptStream } from "./crypto";
import { DATABASE_NAME, openForReading, readSnapshots } from "./database";
import { readRestoreLaunch } from "./request";
import { afterRestore, restore, type Command } from "./restore";
import { runBackups } from "./run";
import { STATUS_NAME, readStatus, writeStatus } from "./status";

/** systemctl as an array of arguments, never a shell line, and bounded in time. */
export function realSystemctl(path: string): (args: string[], timeoutMs: number) => Promise<Command> {
  return async (args, timeoutMs) => {
    const child = Bun.spawn([path, ...args], { stdin: "ignore", stdout: "pipe", stderr: "inherit", timeout: timeoutMs, killSignal: "SIGKILL" });
    const [output, code] = await Promise.all([child.stdout.text(), child.exited]);
    return { code, output };
  };
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * A folder's snapshots, in the server's repository and the bucket's as the
 * last run listed them, newest first, and its line of the last run. Reads
 * only: the database is opened read-only, and not created if it is missing;
 * restic is not run, its listing is the index the run wrote.
 */
export function listing(env: Environment, folder: string): Listing {
  const config = configFrom(env, { bun: process.execPath, script: Bun.main });
  const byName = new Map<string, ListedSnapshot>();
  const db = openForReading(join(config.stateFolder, DATABASE_NAME));
  // A database the version before wrote, between this version's install and its first run, has no index yet.
  const read = (store: "local" | "offsite") => {
    try {
      return db === null ? [] : readSnapshots(db, store, folder);
    } catch {
      return [];
    }
  };
  try {
    for (const row of read("local")) {
      byName.set(row.name, { name: row.name, takenAt: row.takenAt, kind: row.kind, bytes: row.bytes, added: row.added, local: true, offsite: false });
    }
    for (const row of read("offsite")) {
      const known = byName.get(row.name);
      if (known !== undefined) {
        known.offsite = true;
        continue;
      }
      byName.set(row.name, { name: row.name, takenAt: row.takenAt, kind: row.kind, bytes: row.bytes, added: row.added, local: false, offsite: true });
    }
  } finally {
    db?.close();
  }
  const status = readStatus(readOptional(join(config.stateFolder, STATUS_NAME)));
  const mine = status?.projects[folder];
  const lastRun = status === null || mine === undefined ? null : { startedAt: status.startedAt, finishedAt: status.finishedAt, ...mine };
  return { folder, snapshots: [...byName.values()].sort((a, b) => b.takenAt - a.takenAt), lastRun };
}

/** A secret typed without echo, or read from a pipe. Same as scripts/fingerprint.ts. */
async function readSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const entry = process.stdin;
  if (!entry.isTTY) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry) chunks.push(chunk as Uint8Array);
    process.stderr.write("\n");
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  entry.setRawMode(true);
  entry.resume();
  let value = "";
  for await (const chunk of entry) {
    for (const character of (chunk as Uint8Array).toString()) {
      if (character === "\u0003" || character === "\u0004") {
        entry.setRawMode(false);
        process.stderr.write("\n");
        process.exit(1);
      }
      if (character === "\r" || character === "\n") {
        entry.setRawMode(false);
        entry.pause();
        process.stderr.write("\n");
        return value;
      }
      if (character === "\u007f" || character === "\b") {
        value = value.slice(0, -1);
        continue;
      }
      value += character;
    }
  }
  entry.setRawMode(false);
  return value;
}

/**
 * An object of the format before restic decrypted into a `.tar.gz`, on any
 * machine with Bun and this repository: the passphrase from
 * `BACKUP_ENCRYPTION_PASSPHRASE`, or typed without echo. Never as an
 * argument, which would land in the shell's history. The snapshots of the
 * bucket's restic repository need restic alone (README).
 */
async function decryptMain(args: string[], env: Environment): Promise<number> {
  const [input, output] = args;
  if (input === undefined || output === undefined || args.length !== 2) {
    console.error("usage: backup.js decrypt <encrypted file> <output .tar.gz>");
    return 2;
  }
  try {
    lstatSync(output);
    console.error(`${output} already exists, nothing was written`);
    return 2;
  } catch {
    // the expected case
  }
  const passphrase = env.BACKUP_ENCRYPTION_PASSPHRASE ?? (await readSecret("passphrase (no echo): "));
  const writer = Bun.file(output).writer();
  try {
    const read = await decryptStream(Bun.file(input).stream() as ReadableStream<Uint8Array>, passphrase, async (chunk) => {
      writer.write(chunk);
      await writer.flush();
    });
    await writer.end();
    console.log(`${output}: ${read.bytes} bytes, read it with: tar -xzf ${output}`);
    // The key it was sealed for says which project and which snapshot it is,
    // whatever name the file was given since: check it before restoring it.
    console.log(
      read.sealedFor === null
        ? "sealed before format 2: the copy does not name the object it was stored as, check its sitesolide-backup.json"
        : `sealed as ${read.sealedFor}`,
    );
    return 0;
  } catch (error) {
    await writer.end();
    rmSync(output, { force: true });
    console.error(`decrypt: ${(error as Error).message}`);
    return 1;
  }
}

export async function main(argv: string[], env: Environment): Promise<number> {
  const [mode, ...args] = argv;
  const log = (line: string) => console.log(line);
  switch (mode) {
    case "copy":
      return copyMain(args, env);
    case "extract":
      return extractMain(args, env);
    case "measure":
      return measureMain(args, env);
    case "download":
      return downloadMain(args, env);
    case "hook":
      return hookMain(args, env);
    case "discard":
      return discardMain(args, env);
    case "decrypt":
      return decryptMain(args, env);
    case "features":
      // What `sitesolide deploy` looks for in this build (bin/cli/backups.ts).
      console.log(SERVICE_COMMANDS_FEATURE);
      return 0;
    case "list": {
      const folder = args[0];
      if (args.length !== 1 || !isBackupFolder(folder)) {
        console.error("usage: backup.js list <folder>");
        return 2;
      }
      console.log(JSON.stringify(listing(env, folder)));
      return 0;
    }
    case "run": {
      let config;
      try {
        config = configFrom(env, { bun: process.execPath, script: Bun.main });
      } catch (error) {
        // A setting at fault, from the file the dashboard edits for one: the
        // run says so where the monitor looks, rather than dying in silence.
        const at = new Date().toISOString();
        const reason = (error as Error).message;
        console.error(`backup: the run did not start: ${reason}`);
        try {
          // The contract's shape and nothing more: the reason is in the journal.
          writeStatus(env.BACKUP_STATE_FOLDER ?? "/var/lib/sitesolide-backup", { startedAt: at, finishedAt: at, ok: false, projects: {} });
        } catch (failure) {
          console.error(`backup: the status file could not be written: ${(failure as Error).message}`);
        }
        return 1;
      }
      const status = await runBackups({ config, now: Date.now, log });
      return status.ok ? 0 : 1;
    }
    case "restore": {
      const launch = readRestoreLaunch(args);
      if (!launch.ok) {
        console.error(`restore: refused to start: ${launch.reason} (got ${JSON.stringify((args[0] ?? "").slice(0, 80))})`);
        return 2;
      }
      const config = configFrom(env, { bun: process.execPath, script: Bun.main });
      await restore({ config, now: Date.now, log, systemctl: realSystemctl(config.systemctl) }, launch.folder);
      return 0;
    }
    case "after-restore": {
      const launch = readRestoreLaunch(args);
      if (!launch.ok) {
        console.error(`after-restore: refused: ${launch.reason}`);
        return 2;
      }
      const config = configFrom(env, { bun: process.execPath, script: Bun.main });
      await afterRestore({ config, now: Date.now, log, systemctl: realSystemctl(config.systemctl) }, launch.folder);
      return 0;
    }
    default:
      console.error("usage: backup.js run | restore <unit> | after-restore <unit> | list <folder> | decrypt <in> <out> | features | copy | extract | measure | download | hook | discard");
      return 2;
  }
}
