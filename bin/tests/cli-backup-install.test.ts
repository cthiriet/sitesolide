import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BACKUP_DATABASE, IMPORT_ROLLBACK_MS, PRE_RESTIC_FOLDER, PRE_RESTIC_MARKER, preResticCommand, preResticRefusal, readPreResticState } from "../cli/backups";

/**
 * `bin/deploy-backup.sh install` refuses a machine where the import of the
 * archives written before restic, which the releases up to 0.16 ran, has
 * not finished: an archive left under /var/backups/sitesolide, or a copy
 * verified less than seven days ago. The judgement first, then the machine's
 * read run for real on a tree of its own, then the script itself, against an
 * ssh that runs that read on the same tree and answers the rest as a machine
 * that is ready would.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const WORK = mkdtempSync(join(tmpdir(), "backup-install-"));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const answer = (lines: string[]) => `${[...lines, PRE_RESTIC_MARKER].join("\n")}\n`;

let counter = 0;
/** A machine's two places: the archives' folder and the component's database, both absent until written. */
function machine(): { folder: string; database: string } {
  const root = join(WORK, `machine-${counter++}`);
  mkdirSync(root, { recursive: true });
  return { folder: join(root, "backups"), database: join(root, "state", "backup.db") };
}

/** An archive of the format before restic, as the releases before 0.4 wrote one. */
function archive(folder: string, name = "cms/cms-20261001T120000Z.tar.gz"): void {
  mkdirSync(dirname(join(folder, name)), { recursive: true });
  writeFileSync(join(folder, name), "gzip");
}

/** The component's database as 0.16 left it: its `imported` table, a row per verified copy, in WAL. */
function imported(database: string, ...at: number[]): void {
  mkdirSync(dirname(database), { recursive: true });
  const db = new Database(database, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS imported (folder TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, digest TEXT, at INTEGER NOT NULL, forgotten INTEGER, PRIMARY KEY (folder, name))");
  at.forEach((when, index) => db.query("INSERT INTO imported (folder, name, source, digest, at, forgotten) VALUES (?, ?, ?, NULL, ?, NULL)").run("cms", `cms-${index}.tar.gz`, "archive", when));
  db.close();
}

describe("the judgement", () => {
  test("nothing left and nothing recent: the install goes on", () => {
    expect(preResticRefusal(answer(["archives 0", `imported none ${NOW}`]))).toBeNull();
    expect(preResticRefusal(answer(["archives 0", `imported ${NOW - IMPORT_ROLLBACK_MS} ${NOW}`]))).toBeNull();
    expect(preResticRefusal(answer(["archives 0", `imported ${NOW - 30 * DAY} ${NOW}`]))).toBeNull();
  });

  test("an archive left on the server refuses, named", () => {
    const why = preResticRefusal(answer(["archives 1", `archive ${PRE_RESTIC_FOLDER}/cms/cms-20261001T120000Z.tar.gz`, `imported none ${NOW}`]));
    expect(why).not.toBeNull();
    expect(why![0]).toContain("1 archive(s) of the format before restic remain");
    expect(why).toContain(`   ${PRE_RESTIC_FOLDER}/cms/cms-20261001T120000Z.tar.gz`);
    expect(why!.at(-1)).toBe("nothing was installed");
  });

  test("more archives than it names are counted", () => {
    const named = Array.from({ length: 5 }, (_, index) => `archive ${PRE_RESTIC_FOLDER}/cms/cms-2026100${index + 1}T120000Z.tar.gz`);
    expect(preResticRefusal(answer(["archives 12", ...named, `imported none ${NOW}`]))).toContain("   and 7 more");
  });

  test("a copy verified less than seven days ago refuses, by the machine's clock, and says when it may go", () => {
    const why = preResticRefusal(answer(["archives 0", `imported ${NOW - 6 * DAY} ${NOW}`]));
    expect(why).toEqual([
      "an archive's copy was verified on 2026-10-30 12:00 UTC, less than seven days ago: the backups in service remove it, and its bucket's object, on 2026-11-06 12:00 UTC; install this release after that",
      "nothing was installed",
    ]);
    // The machine's clock, not the workstation's: a day later by it, still refused at that same instant.
    expect(preResticRefusal(answer(["archives 0", `imported ${NOW - DAY} ${NOW}`]))).not.toBeNull();
  });

  test("both at once say both", () => {
    const why = preResticRefusal(answer(["archives 1", `archive ${PRE_RESTIC_FOLDER}/a/a-20261001T120000Z.tar.gz`, `imported ${NOW - DAY} ${NOW}`]))!;
    expect(why.filter((line) => line.includes("archive(s)") || line.includes("verified on"))).toHaveLength(2);
  });

  test("an answer that does not read refuses: an install that cannot see may not go on", () => {
    for (const output of ["", "archives 0\nimported none 1\n", `archives 0\n${PRE_RESTIC_MARKER}\n`, answer(["archives x", `imported none ${NOW}`]), answer(["archives 0", "elsewhere", `imported none ${NOW}`])]) {
      expect(readPreResticState(output)).toBeNull();
      expect(preResticRefusal(output)![0]).toContain("did not say");
    }
  });
});

describe("the machine's read", () => {
  /** The command, run as the machine runs it, without sudo, on this tree. */
  function read(paths: { folder: string; database: string }): string {
    const run = Bun.spawnSync(["sh", "-c", preResticCommand({ ...paths, bun: process.execPath, sudo: "" })], { stdout: "pipe", stderr: "pipe" });
    expect(run.stderr.toString()).toBe("");
    return run.stdout.toString();
  }

  test("is one Bun program as root, the machine's paths in it, no single quote to break the shell", () => {
    const command = preResticCommand();
    expect(command.startsWith("sudo /usr/local/bin/bun -e '")).toBe(true);
    expect(command).toInclude(JSON.stringify(PRE_RESTIC_FOLDER));
    expect(command).toInclude(JSON.stringify(BACKUP_DATABASE));
    expect(command.slice("sudo /usr/local/bin/bun -e '".length, -1)).not.toInclude("'");
    expect(() => preResticCommand({ folder: "/a b", database: BACKUP_DATABASE, bun: "/usr/local/bin/bun", sudo: "sudo" })).toThrow();
  });

  test("a machine that never had archives nor a database: nothing to refuse", () => {
    const paths = machine();
    expect(preResticRefusal(read(paths))).toBeNull();
  });

  test("an archive left in a project's folder is found, and refuses", () => {
    const paths = machine();
    archive(paths.folder);
    writeFileSync(join(dirname(paths.folder), "notes.txt"), "not an archive");
    const state = readPreResticState(read(paths));
    expect(state).toMatchObject({ archives: 1, named: [join(paths.folder, "cms", "cms-20261001T120000Z.tar.gz")], importedAt: null });
    expect(preResticRefusal(read(paths))).not.toBeNull();
  });

  test("a copy verified yesterday refuses; the archives gone and the copies older than seven days, it goes on", () => {
    const recent = machine();
    imported(recent.database, Date.now() - 30 * DAY, Date.now() - DAY);
    expect(preResticRefusal(read(recent))![0]).toContain("less than seven days ago");

    const settled = machine();
    mkdirSync(settled.folder, { recursive: true });
    imported(settled.database, Date.now() - 30 * DAY, Date.now() - 8 * DAY);
    expect(readPreResticState(read(settled))).toMatchObject({ archives: 0, importedAt: expect.any(Number) });
    expect(preResticRefusal(read(settled))).toBeNull();
  });

  test("a database without the table, as this release creates it, has nothing imported", () => {
    const paths = machine();
    mkdirSync(dirname(paths.database), { recursive: true });
    const db = new Database(paths.database, { create: true });
    db.run("CREATE TABLE snapshots (store TEXT)");
    db.close();
    expect(readPreResticState(read(paths))).toMatchObject({ archives: 0, importedAt: null });
  });
});

describe("bin/deploy-backup.sh install", () => {
  /**
   * The script, against an ssh that runs the pre-restic read on `paths`,
   * with the test's Bun and no sudo, and answers every other command as a
   * machine that is ready: its prerequisites there, no run in progress,
   * restic 0.18. Past the refusal, it goes on to send; the verification
   * after then fails, the fake machine having installed nothing.
   */
  function install(paths: { folder: string; database: string }): { code: number; stdout: string; stderr: string } {
    const fakes = join(WORK, `fakes-${counter++}`);
    mkdirSync(fakes, { recursive: true });
    writeFileSync(
      join(fakes, "ssh"),
      [
        "#!/bin/bash",
        'for argument in "$@"; do command="$argument"; done',
        'case "$command" in',
        `  *${PRE_RESTIC_MARKER}*)`,
        '    command="${command//sudo \\/usr\\/local\\/bin\\/bun/$FAKE_BUN}"',
        '    command="${command//\\/var\\/backups\\/sitesolide/$FAKE_FOLDER}"',
        '    command="${command//\\/var\\/lib\\/sitesolide-backup\\/backup.db/$FAKE_DATABASE}"',
        '    exec sh -c "$command" ;;',
        '  *"restic version"*) echo "restic 0.18.0 compiled with go1.24.4 on linux/amd64" ;;',
        '  *"mktemp -d"*) echo /tmp/sitesolide-fake-remote ;;',
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    writeFileSync(join(fakes, "rsync"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakes, "ssh"), 0o755);
    chmodSync(join(fakes, "rsync"), 0o755);
    const home = join(WORK, `home-${counter++}`);
    mkdirSync(home, { recursive: true });
    const run = Bun.spawnSync(["bash", join(REPO_ROOT, "bin", "deploy-backup.sh"), "install"], {
      env: {
        PATH: `${fakes}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        SITESOLIDE_SERVER: "sample@invalid.local",
        SITESOLIDE_ZONE: "test-zone.invalid",
        SITESOLIDE_EMAIL: "sample@test-zone.invalid",
        FAKE_BUN: process.execPath,
        FAKE_FOLDER: paths.folder,
        FAKE_DATABASE: paths.database,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  }

  test(
    "refuses with an archive left, before restic or anything else reaches the machine",
    () => {
      const paths = machine();
      archive(paths.folder);
      const run = install(paths);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("!! 1 archive(s) of the format before restic remain");
      expect(run.stderr).toContain(join(paths.folder, "cms", "cms-20261001T120000Z.tar.gz"));
      expect(run.stderr).toContain("nothing was installed");
      expect(run.stdout).toContain("-> archives of the format before restic");
      expect(run.stdout).not.toContain("-> restic");
      expect(run.stdout).not.toContain("-> sending");
    },
    120_000,
  );

  test(
    "refuses with a copy younger than seven days",
    () => {
      const paths = machine();
      imported(paths.database, Date.now() - 2 * DAY);
      const run = install(paths);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("less than seven days ago");
      expect(run.stdout).not.toContain("-> sending");
    },
    120_000,
  );

  test(
    "goes on otherwise, to restic and the sending",
    () => {
      const paths = machine();
      mkdirSync(paths.folder, { recursive: true });
      imported(paths.database, Date.now() - 20 * DAY);
      const run = install(paths);
      expect(run.stdout).toContain("   none left, none imported in the last seven days");
      expect(run.stdout).toContain("-> restic");
      expect(run.stdout).toContain("-> sending");
      expect(run.stderr).not.toContain("format before restic");
      // The fake machine installed nothing: the verification says so, which is past the refusal.
      expect(run.stderr).toContain("the installed file does not match the local build");
    },
    120_000,
  );
});
