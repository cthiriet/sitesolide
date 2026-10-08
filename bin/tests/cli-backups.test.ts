import { describe, expect, test } from "bun:test";
import {
  BACKUP_COMPONENT_MARKER,
  SERVICE_COMMANDS_FEATURE,
  backupComponentCommand,
  readBackupComponent,
  MARKER_NOT_INSTALLED,
  compactTime,
  humanSize,
  isBackupFolder,
  listCommand,
  listingLines,
  readCompactTime,
  readListAnswer,
  legacySnapshotName,
  readSnapshotName,
  snapshotName,
  twinName,
  type Listing,
} from "../cli/backups";
import { reachesOwnPorts, projectPortPairs } from "../cli/loopback";
import { KNOWN_KEYS, SERVICE_KEYS, commandWords, isBackedUp, isDataFolder, servicesOf, validate, type Manifest } from "../cli/manifest";
import { generateUnits } from "../cli/unit";

const ZONE = "test-zone.invalid";
const APP: Manifest = { slug: "budget", port: 3022, start: "bun run server.ts" };

/** 4 October 2026, 13:00:00 UTC. */
const AT = Date.UTC(2026, 9, 4, 13, 0, 0);

describe("a snapshot's name", () => {
  test("carries the folder, the UTC second and the kind", () => {
    expect(snapshotName("cms", AT, "scheduled")).toBe("cms-20261004T130000Z.tar");
    expect(snapshotName("cms", AT + 59_999, "pre-restore")).toBe("cms-20261004T130059Z-pre-restore.tar");
  });

  test("reads back what it wrote, kind and time", () => {
    for (const kind of ["scheduled", "pre-restore"] as const) {
      const name = snapshotName("shop-api", AT, kind);
      expect(readSnapshotName("shop-api", name)).toEqual({ name, folder: "shop-api", takenAt: AT, kind, legacy: false });
    }
  });

  test("an archive of the format before restic is read too, said so, and its imported copy named alike", () => {
    const legacy = legacySnapshotName("cms", AT, "pre-restore");
    expect(legacy).toBe("cms-20261004T130000Z-pre-restore.tar.gz");
    expect(readSnapshotName("cms", legacy)).toEqual({ name: legacy, folder: "cms", takenAt: AT, kind: "pre-restore", legacy: true });
    expect(twinName("cms", legacy)).toBe(snapshotName("cms", AT, "pre-restore"));
    expect(twinName("cms", snapshotName("cms", AT, "scheduled"))).toBe(snapshotName("cms", AT, "scheduled"));
    expect(twinName("cms", "notes.txt")).toBeNull();
  });

  test("the landing's folder, with its dots, is a folder like another", () => {
    const name = snapshotName(ZONE, AT, "scheduled");
    expect(name).toBe("test-zone.invalid-20261004T130000Z.tar");
    expect(readSnapshotName(ZONE, name)?.takenAt).toBe(AT);
  });

  test("belongs to the folder it is read for, not to a shorter slug", () => {
    // `shop-api-...` must not pass for a snapshot of `shop`: retention would
    // then count one project's archives as another's.
    const name = snapshotName("shop-api", AT, "scheduled");
    expect(readSnapshotName("shop", name)).toBeNull();
    expect(readSnapshotName("shop-ap", name)).toBeNull();
  });

  test("anything else is not a snapshot, and retention never touches it", () => {
    for (const name of [
      "cms-20261004T130000Z",
      "cms-20261004T130000Z.tgz",
      "cms-20261004T130000Z.tar.gz.tmp",
      ".cms-20261004T130000Z.tar.gz.0123456789abcdef.tmp",
      "cms-20261004T1300Z.tar.gz",
      "cms-20260231T130000Z.tar.gz",
      "cms-20261004T130000Z-manual.tar.gz",
      "cms-20261004T130000Z-pre-restore-pre-restore.tar.gz",
      "cms-../20261004T130000Z.tar.gz",
      "notes.txt",
    ]) {
      expect(readSnapshotName("cms", name)).toBeNull();
    }
  });

  test("a folder outside the rule never becomes a path", () => {
    for (const folder of ["", "..", "a/b", "-cms", "cms-", ".cms", "cms..x", "CMS", "a".repeat(254)]) {
      expect(isBackupFolder(folder)).toBe(false);
      expect(() => snapshotName(folder, AT, "scheduled")).toThrow();
    }
    expect(isBackupFolder("cms")).toBe(true);
    expect(isBackupFolder(ZONE)).toBe(true);
  });

  test("the compact time is exact to the second, and refuses a date that does not exist", () => {
    expect(compactTime(AT + 999)).toBe("20261004T130000Z");
    expect(readCompactTime("20261004T130000Z")).toBe(AT);
    expect(readCompactTime("20261304T130000Z")).toBeNull();
    expect(readCompactTime("20261004T250000Z")).toBeNull();
    expect(readCompactTime("2026-10-04T13:00:00Z")).toBeNull();
  });
});

describe("the backup key of the manifest", () => {
  test("is known, so that it is not refused as a typo", () => {
    expect(KNOWN_KEYS).toContain("backup");
  });

  test("false opts an app out, absent keeps it in", () => {
    expect(validate({ ...APP, backup: false }, ZONE)).toEqual([]);
    expect(isBackedUp({ ...APP, backup: false })).toBe(false);
    expect(isBackedUp(APP)).toBe(true);
  });

  test("true is refused: the absence already says it", () => {
    expect(validate({ ...APP, backup: true } as unknown as Manifest, ZONE)).toEqual([
      'backup: false to keep the data folder out of the snapshots, an object such as { "folder": "postgres", "command": "..." } for a service that keeps a live database there, or absent',
    ]);
    expect(validate({ ...APP, backup: "no" } as unknown as Manifest, ZONE)).toHaveLength(1);
  });

  test("a static site has no data folder to keep out", () => {
    expect(validate({ slug: "notes", publicDir: "dist", backup: false }, ZONE)).toEqual([
      "backup: without `start`, there is no data folder to back up",
    ]);
  });
});

describe("a service's backup command", () => {
  const BACKUP = { folder: "postgres", command: "/bin/sh /srv/sites/shop/app/postgres-backup.sh" };
  const SHOP = (postgres: Record<string, unknown> = {}, project: Record<string, unknown> = {}): Manifest =>
    ({
      slug: "shop",
      services: {
        web: { start: "/usr/local/bin/bun run server.ts", port: 3080 },
        postgres: { start: "/bin/sh /srv/sites/shop/app/postgres.sh", port: 3081, internal: true, backup: BACKUP, ...postgres },
      },
      secrets: ["shop.env"],
      ...project,
    }) as Manifest;

  test("is a key of a service, so that it is not refused as a typo", () => {
    expect(SERVICE_KEYS).toContain("backup");
    expect(validate(SHOP(), ZONE)).toEqual([]);
    expect(servicesOf(SHOP())[1]!.backup).toEqual(BACKUP);
    expect(servicesOf(SHOP())[0]!.backup).toBeNull();
  });

  test("changes nothing in the units: the service runs as it did", () => {
    const without = SHOP({ backup: undefined });
    const placeholders = { slug: "shop", zone: ZONE, contact: "" };
    expect(generateUnits(SHOP(), placeholders)).toEqual(generateUnits(without, placeholders));
  });

  test("in the form with one start, the project's own backup is its service's", () => {
    const single = { ...APP, backup: BACKUP } as Manifest;
    expect(validate(single, ZONE)).toEqual([]);
    expect(servicesOf(single)[0]!.backup).toEqual(BACKUP);
    expect(isBackedUp(single)).toBe(true);
  });

  test("under services, the top level keeps false alone", () => {
    expect(validate(SHOP({}, { backup: BACKUP }), ZONE)).toEqual([
      "backup: a backup command is declared per service once `services` is present; at the top level, only false, which keeps the whole project out",
    ]);
  });

  test("is refused on a project that keeps its data out of the snapshots", () => {
    expect(validate(SHOP({}, { backup: false }), ZONE)).toEqual([
      'services.postgres.backup: the project\'s "backup": false keeps its data out of the snapshots, so this command would never run',
    ]);
  });

  test("is refused on a static site, which has no data folder", () => {
    expect(validate({ slug: "notes", publicDir: "dist", backup: BACKUP } as Manifest, ZONE)).toEqual([
      "backup: without `start`, there is no data folder to back up",
    ]);
  });

  test("names a folder inside the data, relative and already normalized", () => {
    for (const folder of ["postgres", "db/main", "mongo.data", "pg_17", ".pg"]) expect(isDataFolder(folder)).toBe(true);
    for (const folder of ["", ".", "..", "/srv/sites/shop/data/pg", "../app", "db/../pg", "db//pg", "db/", "/db", "./db", "db/.", "d b", "db\\pg", "~/pg", "a".repeat(256), 3]) {
      expect(isDataFolder(folder)).toBe(false);
    }
    expect(validate(SHOP({ backup: { ...BACKUP, folder: "../app" } }), ZONE)).toEqual([
      "services.postgres.backup.folder: a folder inside the data, relative, such as postgres or db/main, with no `..`, `.` or empty part",
    ]);
    expect(validate(SHOP({ backup: { ...BACKUP, folder: "." } }), ZONE)).toHaveLength(1);
  });

  test("takes folder and command, and nothing else", () => {
    expect(validate(SHOP({ backup: { ...BACKUP, foldr: "pg" } }), ZONE)).toEqual(["services.postgres.backup.foldr: unknown key, a backup takes `folder` and `command`"]);
    expect(validate(SHOP({ backup: { folder: "postgres" } }), ZONE)).toEqual([
      "services.postgres.backup.command: required, the command that leaves a consistent copy of the folder in $BACKUP_DIR",
    ]);
    expect(validate(SHOP({ backup: "pg_basebackup" }), ZONE)).toHaveLength(1);
    expect(validate(SHOP({ backup: null }), ZONE)).toHaveLength(1);
  });

  test("its command is judged like start: never a prefix systemd would read as root", () => {
    for (const command of ["+/bin/sh backup.sh", "!/bin/sh backup.sh", "-/bin/sh backup.sh", "/bin/sh backup.sh\nUser=root", "/bin/sh backup.sh \\"]) {
      const errors = validate(SHOP({ backup: { ...BACKUP, command } }), ZONE);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((error) => error.startsWith("services.postgres.backup.command:"))).toBe(true);
    }
  });

  test("its command is one program, read as systemd reads a command line", () => {
    expect(commandWords("/bin/sh /srv/sites/shop/app/postgres-backup.sh")).toEqual(["/bin/sh", "/srv/sites/shop/app/postgres-backup.sh"]);
    expect(commandWords(`/bin/sh -c 'pg_basebackup -D "$BACKUP_DIR"'  --x`)).toEqual(["/bin/sh", "-c", 'pg_basebackup -D "$BACKUP_DIR"', "--x"]);
    expect(commandWords('/usr/bin/tool --label="two words" "" a\\\\b \\"q\\" \\s')).toEqual(["/usr/bin/tool", "--label=two words", "", "a\\b", '"q"', " "]);
    expect(commandWords("/usr/bin/tool $PORT ${BACKUP_DIR}/x 100%")).toEqual(["/usr/bin/tool", "$PORT", "${BACKUP_DIR}/x", "100%"]);
    for (const command of ["", "   ", "/bin/sh 'open", '/bin/sh "open', "/bin/sh a\\", "/bin/sh \\x41", "/bin/true ; /bin/sh", "/bin/sh\tx"]) {
      expect(commandWords(command)).toBeNull();
    }
    expect(validate(SHOP({ backup: { ...BACKUP, command: "/bin/true ; /bin/rm -rf /srv" } }), ZONE)).toEqual([
      "services.postgres.backup.command: one program and its arguments, read as systemd reads them: no quote left open, no lone ;, and no escape but \\\\ \\\" \\' \\s \\n \\t; a script does the rest",
    ]);
  });

  test("BACKUP_ names are the component's: no env of such a name beside a backup command", () => {
    expect(validate(SHOP({ env: { BACKUP_DIR: "/tmp" } }), ZONE)).toEqual([
      "services.postgres.env: BACKUP_DIR is a name of the backup component, which sets BACKUP_DIR for the backup command: no BACKUP_ variable beside one",
    ]);
    // The uid the hook mode checks, which an empty value would have it skip, were it read from there.
    expect(validate(SHOP({ env: { BACKUP_EXPECTED_UID: "" } }), ZONE)).toHaveLength(1);
    expect(validate(SHOP({}, { env: { BACKUP_EXPECTED_UID: "0" } }), ZONE)).toHaveLength(1);
    expect(validate({ ...APP, env: { BACKUP_DIR: "/tmp" }, backup: BACKUP } as Manifest, ZONE)).toHaveLength(1);
    // Beside no backup command, they are variables like any other.
    expect(validate({ ...APP, env: { BACKUP_DIR: "/tmp", BACKUP_EXPECTED_UID: "1" } }, ZONE)).toEqual([]);
  });

  test("two services cannot keep the same folder live, nor one inside the other", () => {
    const twice = (folder: string): Manifest =>
      ({
        slug: "shop",
        publicDir: "public",
        services: {
          postgres: { start: "/bin/sh pg.sh", port: 3081, internal: true, backup: BACKUP },
          mongo: { start: "/bin/sh mongo.sh", port: 3082, internal: true, backup: { folder, command: "/bin/sh mongo-backup.sh" } },
        },
      }) as Manifest;
    expect(validate(twice("mongo"), ZONE)).toEqual([]);
    expect(validate(twice("postgres"), ZONE)).toEqual(["services: postgres (postgres) and mongo (postgres) back up the same folder, or one inside the other: one service per live folder"]);
    expect(validate(twice("postgres/mongo"), ZONE)).toHaveLength(1);
    expect(validate(twice("postgres-old"), ZONE)).toEqual([]);
  });

  test("a project whose service has one reaches its own ports, the form with one start included", () => {
    const single = { ...APP, port: 3050, backup: BACKUP } as Manifest;
    expect(reachesOwnPorts(single)).toBe(true);
    expect(reachesOwnPorts({ ...APP, port: 3050 })).toBe(false);
    expect(reachesOwnPorts(SHOP())).toBe(true);
    expect(projectPortPairs([{ manifest: single, uid: 1700 }, { manifest: { ...APP, slug: "other", port: 3051 }, uid: 1701 }])).toEqual(["3050 . 1700"]);
  });
});

describe("whether the server's backup component runs backup commands", () => {
  test("a search of its build for the feature, nothing run, the end of the answer marked", () => {
    expect(backupComponentCommand()).toBe(
      `sh -c 'if [ ! -f /usr/local/lib/sitesolide/backup.js ]; then echo absent; elif grep -qF ${SERVICE_COMMANDS_FEATURE} /usr/local/lib/sitesolide/backup.js; then echo current; else echo outdated; fi; echo DONE'`,
    );
    for (const state of ["current", "outdated", "absent"] as const) expect(readBackupComponent(`${state}\n${BACKUP_COMPONENT_MARKER}\n`)).toBe(state);
    for (const output of ["", "current\n", "sudo: refused\nDONE\n", "current\nDONE\nextra\n"]) expect(readBackupComponent(output)).toBe("unreadable");
  });
});

describe("sitesolide backups", () => {
  test("sends one read-only command, which says when the component is missing", () => {
    const command = listCommand("cms");
    expect(command).toBe(
      `if [ -f /usr/local/lib/sitesolide/backup.js ]; then sudo /usr/local/bin/bun /usr/local/lib/sitesolide/backup.js list cms; else echo ${MARKER_NOT_INSTALLED}; fi`,
    );
    expect(() => listCommand("cms; rm -rf /")).toThrow();
  });

  test("reads the component's answer, and nothing else", () => {
    expect(readListAnswer(`${MARKER_NOT_INSTALLED}\n`)).toEqual({ kind: "not-installed" });
    expect(readListAnswer("")).toEqual({ kind: "unreadable" });
    expect(readListAnswer("sudo: a password is required")).toEqual({ kind: "unreadable" });
    expect(readListAnswer(JSON.stringify({ folder: "cms", snapshots: [{ name: "x" }], lastRun: null }))).toEqual({
      kind: "unreadable",
    });
    const listing: Listing = {
      folder: "cms",
      snapshots: [{ name: snapshotName("cms", AT, "scheduled"), takenAt: AT, kind: "scheduled", bytes: 2048, added: 512, local: true, offsite: false }],
      lastRun: null,
    };
    expect(readListAnswer(JSON.stringify(listing))).toEqual({ kind: "listing", listing });
    // A component before restic says nothing of what a snapshot added.
    const older = { ...listing, snapshots: [{ name: snapshotName("cms", AT, "scheduled"), takenAt: AT, kind: "scheduled", bytes: 2048, local: true, offsite: false }] };
    expect(readListAnswer(JSON.stringify(older))).toMatchObject({ kind: "listing" });
  });

  test("prints the newest first, with where each one lives", () => {
    const listing: Listing = {
      folder: "cms",
      snapshots: [
        { name: snapshotName("cms", AT - 3_600_000, "scheduled"), takenAt: AT - 3_600_000, kind: "scheduled", bytes: 1536, added: null, local: false, offsite: true },
        { name: snapshotName("cms", AT, "pre-restore"), takenAt: AT, kind: "pre-restore", bytes: 12_900_000, added: 340_000, local: true, offsite: true },
      ],
      lastRun: { startedAt: "2026-10-04T13:00:02.000Z", finishedAt: "2026-10-04T13:00:09.000Z", ok: false, snapshot: null, error: "not enough disk space" },
    };
    expect(listingLines(listing, "https://dashboard.test-zone.invalid")).toEqual([
      "=== backups of cms ===",
      "TAKEN                 KIND          SIZE      ADDED     WHERE",
      "2026-10-04 13:00 UTC  pre-restore   12 MB     332 KB    server, offsite",
      "2026-10-04 12:00 UTC  scheduled     1.5 KB    -         offsite only",
      "",
      "last run: 2026-10-04 13:00 UTC, failed: not enough disk space",
      "",
      "restore from the Backups section of https://dashboard.test-zone.invalid",
    ]);
  });

  test("says so when there is nothing yet", () => {
    expect(listingLines({ folder: "cms", snapshots: [], lastRun: null }, "https://dashboard.test-zone.invalid")[1]).toBe(
      "no snapshot yet",
    );
  });

  test("sizes are counted like the dashboard's", () => {
    expect(humanSize(null)).toBe("-");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(200 * 1024 * 1024)).toBe("200 MB");
  });
});
