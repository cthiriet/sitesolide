import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus } from "../../monitor/src/status";
import { monitorRefusal } from "../src/monitor";
import type { Raw } from "../src/state";

/**
 * The collector, run as its timer runs it, on a test tree, when the account
 * that owns a directory it reads or writes as root lays a trap there.
 *
 * Three such directories: the monitor's state directory, which its account,
 * sitesolide-monitor, owns; analytics' data directory, which site-analytics
 * owns; and the dashboard's own, which site-dashboard owns. A link put in the
 * right place would have root copy a file only root may read into a snapshot
 * site-dashboard reads, or overwrite a file of somebody else's, and chown it
 * to the account that laid the link.
 *
 * Every path is handed through the environment and lies under a temporary
 * directory; the owners are left empty, this test running without root. The
 * machine's readings, `systemctl show`, `du`, `ss`, answer what they answer on
 * the workstation, or fail, which the collector takes as a blank: nothing here
 * depends on them, but for the units read beside a project's main one, where
 * a fake `systemctl` first on the PATH says what was asked of which unit.
 */

const COLLECTOR = join(import.meta.dir, "..", "collector.ts");
const D = mkdtempSync(join(tmpdir(), "collector-"));
const SITES = join(D, "srv", "sites");
const DASHBOARD_DATA = join(SITES, "dashboard", "data");
const ANALYTICS_DATA = join(SITES, "analytics", "data");
const MONITOR = join(D, "var", "lib", "sitesolide-monitor");
const ETC = join(D, "etc");
/** A file only root could read on the machine, and what must never leak of it. */
const SECRET_FILE = join(ETC, "dashboard-secret.env");
const SECRET = "TOKEN=collector-test-secret-value";
/** A file of another project's, which nothing may overwrite. */
const VICTIM = join(SITES, "shop", "data", "shop.db");

afterAll(() => rmSync(D, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(D, { recursive: true, force: true });
  for (const folder of [DASHBOARD_DATA, ANALYTICS_DATA, MONITOR, ETC, join(SITES, "shop", "data")]) mkdirSync(folder, { recursive: true });
  writeFileSync(SECRET_FILE, `${SECRET}\n`);
  writeFileSync(VICTIM, "untouched");
});

/** One pass of the collector; the snapshot it wrote. `path` goes before the PATH, for a fake command. */
async function collect(path: string | null = null): Promise<Raw> {
  const child = Bun.spawn([process.execPath, "run", COLLECTOR], {
    env: {
      PATH: `${path === null ? "" : `${path}:`}${process.env.PATH ?? "/usr/bin:/bin"}`,
      SITESOLIDE_ZONE: "test-zone.invalid",
      SITES_DIR: SITES,
      STATE_FILE: join(DASHBOARD_DATA, "state.json"),
      OWNER: "",
      CODES_FILE: join(D, "locks-codes.json"),
      DOMAINS_FILE: join(D, "domaines.map"),
      BLOCKS_FOLDER: join(D, "blocks"),
      AUDIENCE_FILE: join(ANALYTICS_DATA, "instantane.json"),
      HOSTS_FILE: join(ANALYTICS_DATA, "hotes.json"),
      HOSTS_OWNER: "",
      MONITOR_FILE: join(MONITOR, "status.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(readFileSync(join(DASHBOARD_DATA, "state.json"), "utf8")) as Raw;
}

/** A status as the monitor writes it, by its own code. */
function monitorStatus(): string {
  return JSON.stringify(
    buildStatus({ now: Date.now(), zone: "test-zone.invalid", checks: {}, heartbeat: "ok", webhook: "idle", undelivered: 0, unchecked: 0 }),
  );
}

/**
 * A `systemctl` that answers `show` with every property it is asked for, each
 * valued with the unit it was asked about: what the collector asks, of which
 * unit, reads straight from the snapshot. Anything else fails.
 */
function fakeSystemctl(): string {
  const bin = join(D, "bin");
  mkdirSync(bin, { recursive: true });
  const script = [
    "#!/bin/sh",
    '[ "$1" = show ] || exit 1',
    'unit="$2"',
    "shift 2",
    'for argument in "$@"; do',
    '  case "$argument" in -p|--*) ;; *) printf "%s=%s\\n" "$argument" "$unit" ;; esac',
    "done",
    "",
  ].join("\n");
  writeFileSync(join(bin, "systemctl"), script, { mode: 0o755 });
  return bin;
}

function project(slug: string, manifest: unknown): void {
  mkdirSync(join(SITES, slug), { recursive: true });
  writeFileSync(join(SITES, slug, "sitesolide.json"), JSON.stringify(manifest));
}

describe("the units read beside a project's main one", () => {
  const SERVICE = ["LoadState", "ActiveState", "SubState", "MemoryCurrent", "MemoryPeak", "MemoryMax", "NRestarts", "ActiveEnterTimestamp", "CPUUsageNSec"];
  const RUN = [...SERVICE, "Result", "ExecMainStatus", "ExecMainStartTimestamp", "ExecMainExitTimestamp"];
  const TIMER = ["LoadState", "ActiveState", "SubState", "LastTriggerUSec", "NextElapseUSecRealtime"];

  test("named from the manifest, never by rank: a scheduled service written first is not the main unit", async () => {
    project("lab", {
      slug: "lab",
      services: {
        sync: { start: "/srv/sites/lab/app/sync", schedule: "hourly" },
        web: { start: "/srv/sites/lab/app/web", port: 3050 },
        queue: { start: "/srv/sites/lab/app/queue", internal: true },
      },
    });
    const lab = (await collect(fakeSystemctl())).folders.find((one) => one.slug === "lab")!;
    expect(Object.keys(lab.unit!)).toEqual(SERVICE);
    expect(lab.unit!.LoadState).toBe("lab");
    expect(Object.keys(lab.units!).sort()).toEqual(["lab.queue", "lab.sync", "lab.sync.timer"]);
    // The service and its timer, side by side under their own names, each
    // asked of systemd by the name it takes.
    expect(lab.units!["lab.queue"]).toEqual(Object.fromEntries(SERVICE.map((key) => [key, "lab.queue.service"])));
    expect(lab.units!["lab.sync"]).toEqual(Object.fromEntries(RUN.map((key) => [key, "lab.sync.service"])));
    expect(lab.units!["lab.sync.timer"]).toEqual(Object.fromEntries(TIMER.map((key) => [key, "lab.sync.timer"])));
  });

  test("a project whose every service is scheduled: the anchor is its main unit, every service and timer beside it", async () => {
    project("nightly", {
      slug: "nightly",
      services: {
        report: { start: "/srv/sites/nightly/app/report", schedule: "daily" },
        purge: { start: "/srv/sites/nightly/app/purge", schedule: "*:0/15" },
      },
    });
    const nightly = (await collect(fakeSystemctl())).folders.find((one) => one.slug === "nightly")!;
    expect(nightly.unit!.LoadState).toBe("nightly");
    expect(Object.keys(nightly.units!).sort()).toEqual(["nightly.purge", "nightly.purge.timer", "nightly.report", "nightly.report.timer"]);
    expect(nightly.units!["nightly.report"]!.Result).toBe("nightly.report.service");
  });

  test("a single start, a static site and a manifest that does not read have no other unit", async () => {
    project("tool", { slug: "tool", start: "bun run server.ts", port: 3030 });
    project("notes", { slug: "notes", publicDir: "public" });
    mkdirSync(join(SITES, "broken"), { recursive: true });
    writeFileSync(join(SITES, "broken", "sitesolide.json"), "{ not json");
    const { folders } = await collect(fakeSystemctl());
    for (const slug of ["tool", "notes", "broken"]) expect([slug, folders.find((one) => one.slug === slug)!.units]).toEqual([slug, undefined]);
  });
});

describe("the monitor's status, copied as root from the monitor's directory", () => {
  test("no status, no field: the monitor is not installed", async () => {
    rmSync(MONITOR, { recursive: true, force: true });
    expect((await collect()).monitor).toBeNull();
  });

  test("a status of the directory's owner is copied from the fields the dashboard knows", async () => {
    const written = monitorStatus();
    writeFileSync(join(MONITOR, "status.json"), JSON.stringify({ ...JSON.parse(written), smuggled: SECRET }));
    const raw = await collect();
    expect(JSON.parse(raw.monitor!)).toEqual(JSON.parse(written));
    expect(JSON.stringify(raw)).not.toContain(SECRET);
  });

  test("on a machine that ran the DynamicUser unit, still read through the link systemd made, until the directory moves back", async () => {
    // /var/lib/sitesolide-monitor -> private/sitesolide-monitor, relative as
    // systemd writes it, until the static account's unit first starts.
    const hidden = join(D, "var", "lib", "private", "sitesolide-monitor");
    rmSync(MONITOR, { recursive: true, force: true });
    mkdirSync(hidden, { recursive: true });
    symlinkSync(join("private", "sitesolide-monitor"), MONITOR);
    const written = monitorStatus();
    writeFileSync(join(hidden, "status.json"), written);
    expect(JSON.parse((await collect()).monitor!)).toEqual(JSON.parse(written));

    // The link systemd made is followed; one at status.json still is not.
    rmSync(join(hidden, "status.json"));
    symlinkSync(SECRET_FILE, join(hidden, "status.json"));
    expect((await collect()).monitor).toBe(monitorRefusal("status.json is a symbolic link"));
  });

  test("a symbolic link in its place is refused, and what it points to never reaches the snapshot", async () => {
    symlinkSync(SECRET_FILE, join(MONITOR, "status.json"));
    const raw = await collect();
    expect(raw.monitor).toBe(monitorRefusal("status.json is a symbolic link"));
    expect(readFileSync(join(DASHBOARD_DATA, "state.json"), "utf8")).not.toContain("collector-test-secret-value");

    // Even towards a well-formed status: a link is never followed.
    rmSync(join(MONITOR, "status.json"));
    writeFileSync(join(ETC, "status.json"), monitorStatus());
    symlinkSync(join(ETC, "status.json"), join(MONITOR, "status.json"));
    expect((await collect()).monitor).toBe(monitorRefusal("status.json is a symbolic link"));
  });

  test("a hard link, a named pipe and an oversized file are refused, the pipe without hanging", async () => {
    linkSync(SECRET_FILE, join(MONITOR, "status.json"));
    expect((await collect()).monitor).toBe(monitorRefusal("status.json has more than one name"));

    rmSync(join(MONITOR, "status.json"));
    expect(Bun.spawnSync(["mkfifo", join(MONITOR, "status.json")]).exitCode).toBe(0);
    expect((await collect()).monitor).toBe(monitorRefusal("status.json is not a regular file"));

    rmSync(join(MONITOR, "status.json"));
    writeFileSync(join(MONITOR, "status.json"), JSON.stringify({ ...JSON.parse(monitorStatus()), padding: "x".repeat(1024 * 1024) }));
    expect((await collect()).monitor).toBe(monitorRefusal(`status.json is larger than ${1024 * 1024} bytes`));
  });
});

describe("the audience snapshot, copied as root from analytics' directory", () => {
  const AUDIENCE = join(ANALYTICS_DATA, "instantane.json");

  test("a snapshot of the directory's owner is copied as it stands", async () => {
    writeFileSync(AUDIENCE, '{"version":1}');
    expect((await collect()).audience).toBe('{"version":1}');
  });

  test("a symbolic link in its place is not followed, and what it points to never reaches the snapshot", async () => {
    symlinkSync(SECRET_FILE, AUDIENCE);
    const raw = await collect();
    expect(raw.audience ?? null).toBeNull();
    expect(JSON.stringify(raw)).not.toContain(SECRET);
  });

  test("a hard link to a file elsewhere is refused too", async () => {
    linkSync(SECRET_FILE, AUDIENCE);
    const raw = await collect();
    expect(raw.audience ?? null).toBeNull();
    expect(JSON.stringify(raw)).not.toContain(SECRET);
  });
});

describe("the files the collector writes as root into directories it does not own", () => {
  test("a link at the old temporary name of the host table is not followed", async () => {
    symlinkSync(VICTIM, join(ANALYTICS_DATA, "hotes.json.tmp"));
    await collect();
    expect(readFileSync(VICTIM, "utf8")).toBe("untouched");
    const hosts = JSON.parse(readFileSync(join(ANALYTICS_DATA, "hotes.json"), "utf8")) as { hosts: unknown };
    expect(typeof hosts.hosts).toBe("object");
  });

  test("a link in place of the host table is replaced, never written through", async () => {
    symlinkSync(VICTIM, join(ANALYTICS_DATA, "hotes.json"));
    await collect();
    expect(readFileSync(VICTIM, "utf8")).toBe("untouched");
    expect(lstatSync(join(ANALYTICS_DATA, "hotes.json")).isFile()).toBe(true);
    // No temporary file left behind.
    expect(readdirSync(ANALYTICS_DATA)).toEqual(["hotes.json"]);
  });

  test("analytics' data directory replaced by a link: nothing is written through it", async () => {
    rmSync(ANALYTICS_DATA, { recursive: true });
    symlinkSync(join(SITES, "shop", "data"), ANALYTICS_DATA);
    await collect();
    expect(readdirSync(join(SITES, "shop", "data"))).toEqual(["shop.db"]);
  });

  test("a link at the old temporary name of the snapshot is not followed", async () => {
    symlinkSync(VICTIM, join(DASHBOARD_DATA, "state.json.tmp"));
    const raw = await collect();
    expect(readFileSync(VICTIM, "utf8")).toBe("untouched");
    expect(raw.zone).toBe("test-zone.invalid");
    expect(lstatSync(join(DASHBOARD_DATA, "state.json")).isFile()).toBe(true);
  });
});

describe("the previous snapshot, read back as root from the dashboard's directory", () => {
  const STATE = join(DASHBOARD_DATA, "state.json");

  test("one the collector wrote is read back for the processor rates", async () => {
    writeFileSync(STATE, JSON.stringify({ generated: 1234, folders: [{ slug: "shop", unit: { CPUUsageNSec: "42" } }] }));
    expect((await collect()).previous).toEqual({ generated: 1234, cpu: { shop: 42 } });
  });

  test("a symbolic link in its place is not followed: what it points to never reaches the snapshot", async () => {
    // A file of root's, of the shape the collector reads its counters from:
    // through the link, root copied its date and its keys into a reading
    // site-dashboard reads.
    const elsewhere = join(ETC, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ generated: 1234, folders: [{ slug: "copied-through-the-link", unit: { CPUUsageNSec: "7" } }] }));
    symlinkSync(elsewhere, STATE);
    const raw = await collect();
    expect(raw.previous).toBeNull();
    expect(lstatSync(STATE).isFile()).toBe(true);
    expect(readFileSync(elsewhere, "utf8")).toContain("copied-through-the-link");
  });

  test("a named pipe in its place neither hangs the collector nor stops the snapshot", async () => {
    // A pipe nobody writes into held root's collector on its open until the
    // unit's timeout, at every pass, and nothing was ever written again: the
    // snapshot, nor analytics' host table.
    expect(Bun.spawnSync(["mkfifo", STATE]).exitCode).toBe(0);
    const raw = await collect();
    expect(raw.previous).toBeNull();
    expect(lstatSync(STATE).isFile()).toBe(true);
    expect(lstatSync(join(ANALYTICS_DATA, "hotes.json")).isFile()).toBe(true);
  }, 30_000);
});

/**
 * An `ss` that prints what the machine would: the listening ports for `-ltnH`,
 * and for `-tnpH state established` the two ends of one connection to 3049,
 * held by a process that no longer exists by the time the collector reads its
 * cgroup.
 */
function fakeSs(): string {
  const bin = join(D, "bin-ss");
  mkdirSync(bin, { recursive: true });
  const script = [
    "#!/bin/sh",
    'case "$*" in',
    '  *-ltnH*) printf "LISTEN 0 511 127.0.0.1:3049 0.0.0.0:*\\n" ;;',
    "  *established*)",
    "    printf '0 0 127.0.0.1:41000 127.0.0.1:3049 users:((\"bun\",pid=999999999,fd=9))\\n'",
    "    printf '0 0 127.0.0.1:3049 127.0.0.1:41000 users:((\"bun\",pid=999999998,fd=4))\\n'",
    "    ;;",
    "  *) exit 1 ;;",
    "esac",
    "",
  ].join("\n");
  writeFileSync(join(bin, "ss"), script, { mode: 0o755 });
  return bin;
}

describe("the links between processes", () => {
  test("seen now, and remembered from the reading before, its malformed lines dropped", async () => {
    const hourAgo = Date.now() - 3_600_000;
    writeFileSync(
      join(DASHBOARD_DATA, "state.json"),
      JSON.stringify({
        generated: hourAgo,
        folders: [],
        links: [
          { from: "lab.api.service", port: 3050, open: 2, seen: hourAgo },
          { from: "../../etc/passwd", port: 3050, open: 2, seen: hourAgo },
        ],
      }),
    );
    const raw = await collect(fakeSs());
    expect(raw.ports).toEqual([3049]);
    expect(raw.links).toEqual([
      { from: null, port: 3049, open: 1, seen: raw.generated },
      { from: "lab.api.service", port: 3050, open: 0, seen: hourAgo },
    ]);
  });
});
