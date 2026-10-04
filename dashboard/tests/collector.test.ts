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
 * Three such directories: the monitor's state directory, which its dynamic
 * account owns; analytics' data directory, which site-analytics owns; and the
 * dashboard's own, which site-dashboard owns. A link put in the right place
 * would have root copy a file only root may read into a snapshot
 * site-dashboard reads, or overwrite a file of somebody else's, and chown it
 * to the account that laid the link.
 *
 * Every path is handed through the environment and lies under a temporary
 * directory; the owners are left empty, this test running without root. The
 * machine's readings, `systemctl show`, `du`, `ss`, answer what they answer on
 * the workstation, or fail, which the collector takes as a blank: nothing here
 * depends on them.
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

/** One pass of the collector; the snapshot it wrote. */
async function collect(): Promise<Raw> {
  const child = Bun.spawn([process.execPath, "run", COLLECTOR], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
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
