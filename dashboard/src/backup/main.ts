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
 *   backup.js download <folder> <s>   as a dynamic user, a bucket's copy on stdout
 *   backup.js list <folder>           what `sitesolide backups` prints, read-only
 *   backup.js decrypt <in> <out>      a bucket's copy back to a tar.gz, anywhere
 *
 * `dashboard/backup.ts` does nothing but call `main`: the body lives here, so
 * that typing and the tests cover it.
 *
 * The exit code of `restore` does not carry the verdict, like the gatekeeper's:
 * the result file does, and a refused restore is not a failed unit.
 */
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isBackupFolder, readSnapshotName, type Listing, type ListedSnapshot } from "../../borrowed/backups";
import { copyMain, downloadMain, extractMain, measureMain } from "./child";
import { configFrom, type Environment } from "./config";
import { decryptStream } from "./crypto";
import { DATABASE_NAME, openForReading, readOffsite } from "./database";
import { readRestoreLaunch } from "./request";
import { afterRestore, restore, type Command } from "./restore";
import { localSnapshots } from "./listing";
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
 * A folder's snapshots, on the server and in the bucket as the last run listed
 * it, newest first, and its line of the last run. Reads only: the database is
 * opened read-only, and not created if it is missing.
 */
export function listing(env: Environment, folder: string): Listing {
  const config = configFrom(env, { bun: process.execPath, script: Bun.main });
  const byName = new Map<string, ListedSnapshot>();
  for (const snapshot of localSnapshots(config.backupFolder, folder)) {
    byName.set(snapshot.name, { name: snapshot.name, takenAt: snapshot.takenAt, kind: snapshot.kind, bytes: snapshot.bytes, local: true, offsite: false });
  }
  const db = openForReading(join(config.stateFolder, DATABASE_NAME));
  try {
    for (const row of db === null ? [] : readOffsite(db, folder)) {
      const known = byName.get(row.name);
      if (known !== undefined) {
        known.offsite = true;
        continue;
      }
      const snapshot = readSnapshotName(folder, row.name);
      if (snapshot !== null) byName.set(row.name, { name: row.name, takenAt: snapshot.takenAt, kind: snapshot.kind, bytes: row.bytes, local: false, offsite: true });
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
 * A bucket's copy decrypted into a `.tar.gz`, on any machine with Bun and this
 * repository: the passphrase from `BACKUP_ENCRYPTION_PASSPHRASE`, or typed
 * without echo. Never as an argument, which would land in the shell's history.
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
    case "decrypt":
      return decryptMain(args, env);
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
      console.error("usage: backup.js run | restore <unit> | after-restore <unit> | list <folder> | decrypt <in> <out> | copy | extract | measure | download");
      return 2;
  }
}
