import { describe, expect, test } from "bun:test";
import {
  MARKER_NOT_INSTALLED,
  compactTime,
  humanSize,
  isBackupFolder,
  listCommand,
  listingLines,
  readCompactTime,
  readListAnswer,
  readSnapshotName,
  snapshotName,
  type Listing,
} from "../cli/backups";
import { KNOWN_KEYS, isBackedUp, validate, type Manifest } from "../cli/manifest";

const ZONE = "test-zone.invalid";
const APP: Manifest = { slug: "budget", port: 3022, start: "bun run server.ts" };

/** 4 October 2026, 13:00:00 UTC. */
const AT = Date.UTC(2026, 9, 4, 13, 0, 0);

describe("a snapshot's name", () => {
  test("carries the folder, the UTC second and the kind", () => {
    expect(snapshotName("cms", AT, "scheduled")).toBe("cms-20261004T130000Z.tar.gz");
    expect(snapshotName("cms", AT + 59_999, "pre-restore")).toBe("cms-20261004T130059Z-pre-restore.tar.gz");
  });

  test("reads back what it wrote, kind and time", () => {
    for (const kind of ["scheduled", "pre-restore"] as const) {
      const name = snapshotName("shop-api", AT, kind);
      expect(readSnapshotName("shop-api", name)).toEqual({ name, folder: "shop-api", takenAt: AT, kind });
    }
  });

  test("the landing's folder, with its dots, is a folder like another", () => {
    const name = snapshotName(ZONE, AT, "scheduled");
    expect(name).toBe("test-zone.invalid-20261004T130000Z.tar.gz");
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
      "cms-20261004T130000Z.tar",
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
    expect(validate({ ...APP, backup: true }, ZONE)).toEqual([
      "backup: false to keep the data folder out of the snapshots, or absent",
    ]);
    expect(validate({ ...APP, backup: "no" as unknown as boolean }, ZONE)).toHaveLength(1);
  });

  test("a static site has no data folder to keep out", () => {
    expect(validate({ slug: "notes", publicDir: "dist", backup: false }, ZONE)).toEqual([
      "backup: without `start`, there is no data folder to back up",
    ]);
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
      snapshots: [{ name: snapshotName("cms", AT, "scheduled"), takenAt: AT, kind: "scheduled", bytes: 2048, local: true, offsite: false }],
      lastRun: null,
    };
    expect(readListAnswer(JSON.stringify(listing))).toEqual({ kind: "listing", listing });
  });

  test("prints the newest first, with where each one lives", () => {
    const listing: Listing = {
      folder: "cms",
      snapshots: [
        { name: snapshotName("cms", AT - 3_600_000, "scheduled"), takenAt: AT - 3_600_000, kind: "scheduled", bytes: 1536, local: false, offsite: true },
        { name: snapshotName("cms", AT, "pre-restore"), takenAt: AT, kind: "pre-restore", bytes: 12_900_000, local: true, offsite: true },
      ],
      lastRun: { startedAt: "2026-10-04T13:00:02.000Z", finishedAt: "2026-10-04T13:00:09.000Z", ok: false, snapshot: null, error: "not enough disk space" },
    };
    expect(listingLines(listing, "https://dashboard.test-zone.invalid")).toEqual([
      "=== backups of cms ===",
      "TAKEN                 KIND          SIZE      WHERE",
      "2026-10-04 13:00 UTC  pre-restore   12 MB     server, offsite",
      "2026-10-04 12:00 UTC  scheduled     1.5 KB    offsite only",
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
