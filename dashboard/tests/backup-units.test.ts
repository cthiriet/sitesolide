import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CHILD_TIMEOUT_MS } from "../src/backup/config";
import { readRestoreLaunch, restoreUnit } from "../src/backup/request";
import { AFTER_STOP_MS, DOWNLOAD_TIMEOUT_MS, MEASURE_TIMEOUT_MS, RESTORE_LOCK_WAIT_MS, RESTORE_TIMEOUT_MS } from "../src/backup/restore";
import { LOCK_WAIT_MS, OFFSITE_DEADLINE_MS, OFFSITE_STOP_MS, SNAPSHOT_DEADLINE_MS } from "../src/backup/run";

/**
 * The backup component's three units, read the way systemd reads them. Only a
 * machine proves they start (src/backup/README.md lists the commands); what
 * makes them safe is checked here: the code they run, what they may write,
 * the capabilities they keep, and that nothing starts by itself.
 */
const FOLDER = join(import.meta.dir, "..", "..", "infra", "backup");
const read = (name: string) => readFileSync(join(FOLDER, name), "utf8");

function directives(text: string, section: string): [string, string][] {
  const found: [string, string][] = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      current = header[1]!;
      continue;
    }
    if (current !== section) continue;
    const equal = line.indexOf("=");
    found.push([line.slice(0, equal), line.slice(equal + 1)]);
  }
  return found;
}

const values = (text: string, key: string, section = "Service") =>
  directives(text, section)
    .filter(([name]) => name === key)
    .map(([, value]) => value);

const sections = (text: string) => [...text.matchAll(/^\[(.+)\]$/gm)].map((match) => match[1]);

describe("sitesolide-backup.service", () => {
  const text = read("sitesolide-backup.service");

  test("runs the installed build, once per start", () => {
    expect(values(text, "Type")).toEqual(["oneshot"]);
    expect(values(text, "ExecStart")).toEqual(["/usr/local/bin/bun /usr/local/lib/sitesolide/backup.js run"]);
    expect(values(text, "ConditionPathExists", "Unit")).toEqual(["/usr/local/lib/sitesolide/backup.js"]);
  });

  test("reads the zone, and the bucket's settings only if the file is there", () => {
    expect(values(text, "EnvironmentFile")).toEqual(["/etc/caddy/sitesolide.env", "-/etc/sitesolide/dashboard-backup.env"]);
  });

  test("sees no project's secrets, though PID 1 hands it the bucket's settings from among them", () => {
    expect(values(text, "InaccessiblePaths")).toEqual(["-/etc/sitesolide -/var/lib/sitesolide-steward"]);
  });

  test("writes only its archives and its own folders, with one capability, to read", () => {
    expect(values(text, "ProtectSystem")).toEqual(["strict"]);
    expect(values(text, "ReadWritePaths")).toEqual(["/var/backups/sitesolide"]);
    expect(values(text, "CapabilityBoundingSet")).toEqual(["CAP_DAC_READ_SEARCH"]);
    expect(values(text, "NoNewPrivileges")).toEqual(["true"]);
    expect(values(text, "UMask")).toEqual(["0077"]);
  });

  test("its status folder is readable by an unprivileged monitor", () => {
    expect(values(text, "StateDirectory")).toEqual(["sitesolide-backup"]);
    expect(values(text, "StateDirectoryMode")).toEqual(["0755"]);
    expect(values(text, "RuntimeDirectoryPreserve")).toEqual(["yes"]);
  });

  test("ends before the next hour, and never disputes the disk with a site", () => {
    expect(values(text, "TimeoutStartSec")).toEqual(["50min"]);
    // The last copy starts by 25 minutes and lasts 20 at most, which leaves the
    // pruning and the status file time; the uploads stop at 40.
    expect(SNAPSHOT_DEADLINE_MS + DEFAULT_CHILD_TIMEOUT_MS).toBeLessThan(50 * 60_000);
    expect(OFFSITE_DEADLINE_MS).toBeLessThan(OFFSITE_STOP_MS);
    expect(OFFSITE_STOP_MS).toBeLessThan(50 * 60_000);
    expect(LOCK_WAIT_MS).toBeLessThan(SNAPSHOT_DEADLINE_MS);
    expect(values(text, "Nice")).toEqual(["10"]);
    expect(values(text, "IOSchedulingClass")).toEqual(["idle"]);
  });

  test("no [Install]: the timer starts it", () => {
    expect(sections(text)).toEqual(["Unit", "Service"]);
  });
});

describe("sitesolide-backup.timer", () => {
  const text = read("sitesolide-backup.timer");

  test("every hour, a missed run caught up at boot", () => {
    expect(values(text, "OnCalendar", "Timer")).toEqual(["hourly"]);
    expect(values(text, "Persistent", "Timer")).toEqual(["true"]);
    expect(values(text, "WantedBy", "Install")).toEqual(["timers.target"]);
  });
});

describe("sitesolide-restore@.service", () => {
  const text = read("sitesolide-restore@.service");

  test("one restore per start, the full unit name handed over, and accepted", () => {
    expect(values(text, "Type")).toEqual(["oneshot"]);
    expect(values(text, "ExecStart")).toEqual(["/usr/local/bin/bun /usr/local/lib/sitesolide/backup.js restore %n"]);
    const name = restoreUnit("cms")!;
    expect(readRestoreLaunch([name])).toEqual({ ok: true, folder: "cms" });
  });

  test("writes only into the folder of the project it is named for, and the archives", () => {
    expect(values(text, "ReadWritePaths")).toEqual(["/srv/sites/%i /var/backups/sitesolide"]);
    expect(values(text, "ReadOnlyPaths")).toEqual(["-/srv/sites/%i/app -/srv/sites/%i/public"]);
    expect(values(text, "InaccessiblePaths")).toEqual(["-/var/lib/sitesolide-steward -/etc/sitesolide"]);
    // `%I` would turn a slug's dashes into slashes: in no directive.
    expect(directives(text, "Service").some(([, value]) => value.includes("%I"))).toBe(false);
  });

  test("outlasts its longest path: the lock's wait, a measure, a download, an extraction, a snapshot, the watch", () => {
    expect(values(text, "TimeoutStartSec")).toEqual(["90min"]);
    expect(RESTORE_TIMEOUT_MS).toBe(90 * 60_000);
    expect(RESTORE_LOCK_WAIT_MS + MEASURE_TIMEOUT_MS + DOWNLOAD_TIMEOUT_MS + 2 * DEFAULT_CHILD_TIMEOUT_MS + AFTER_STOP_MS).toBeLessThanOrEqual(RESTORE_TIMEOUT_MS);
  });

  test("a restore cut short starts the project again once its process is gone", () => {
    expect(values(text, "ExecStopPost")).toEqual(["/usr/local/bin/bun /usr/local/lib/sitesolide/backup.js after-restore %n"]);
    expect(values(text, "TimeoutStopSec")).toEqual(["3min"]);
    expect(readRestoreLaunch(["sitesolide-restore@cms.service"])).toEqual({ ok: true, folder: "cms" });
  });

  test("has no network: the bucket is a download child's business", () => {
    expect(values(text, "RestrictAddressFamilies")).toEqual(["AF_UNIX"]);
    expect(values(text, "IPAddressDeny")).toEqual(["any"]);
    // The settings still reach it, read by PID 1 before the walls.
    expect(values(text, "EnvironmentFile")).toContain("-/etc/sitesolide/dashboard-backup.env");
  });

  test("two capabilities, the ones a folder swap and a chown need", () => {
    expect(values(text, "CapabilityBoundingSet")).toEqual(["CAP_DAC_OVERRIDE CAP_CHOWN"]);
    expect(values(text, "NoNewPrivileges")).toEqual(["true"]);
  });

  test("never starts by itself: no [Install], only the steward starts it", () => {
    expect(sections(text)).toEqual(["Unit", "Service"]);
  });

  test("shares the lock and the results with the run", () => {
    expect(values(text, "RuntimeDirectory")).toEqual(values(read("sitesolide-backup.service"), "RuntimeDirectory"));
    expect(values(text, "StateDirectory")).toEqual(values(read("sitesolide-backup.service"), "StateDirectory"));
    expect(values(text, "StateDirectoryMode")).toEqual(["0755"]);
  });
});

describe("what none of them does", () => {
  test("touch Caddy", () => {
    for (const name of ["sitesolide-backup.service", "sitesolide-restore@.service"]) {
      const commands = directives(read(name), "Service").filter(([key]) => key.startsWith("Exec")).map(([, value]) => value);
      expect(commands.join(" ")).not.toContain("caddy");
    }
  });
});
