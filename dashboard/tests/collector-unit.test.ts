import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The collector's unit and its deploy script, read the way systemd and bash
 * read them. Only a machine proves the unit starts (bin/deploy-collector.sh
 * runs it once before arming the timer); what makes it safe is checked here:
 * the code it runs lives where only root writes, what it may write, the
 * capabilities it keeps, and the bounds on a pass.
 */
const ROOT = join(import.meta.dir, "..", "..");
const UNIT = readFileSync(join(ROOT, "infra", "collector", "sitesolide-collector.service"), "utf8");
const SCRIPT = readFileSync(join(ROOT, "bin", "deploy-collector.sh"), "utf8");
const COLLECTOR = readFileSync(join(ROOT, "dashboard", "collector.ts"), "utf8");

function values(key: string, section = "Service"): string[] {
  const found: string[] = [];
  let current = "";
  for (const raw of UNIT.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      current = header[1]!;
      continue;
    }
    const equal = line.indexOf("=");
    if (current === section && line.slice(0, equal) === key) found.push(line.slice(equal + 1));
  }
  return found;
}

/** The unit without its comments. */
const directives = UNIT.split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

describe("sitesolide-collector.service", () => {
  test("runs the build installed root's, never a file of the dashboard's tree", () => {
    expect(values("ExecStart")).toEqual(["/usr/local/bin/bun /usr/local/lib/sitesolide/collector.js"]);
    expect(values("ConditionPathExists", "Unit")).toEqual(["/usr/local/lib/sitesolide/collector.js"]);
    // The dashboard's account and its deployments write there.
    expect(directives).not.toContain("/srv/sites/dashboard/app");
  });

  test("writes only the dashboard's data folder, the rest of the system read-only", () => {
    expect(values("ProtectSystem")).toEqual(["strict"]);
    expect(values("ReadWritePaths")).toEqual(["/srv/sites/dashboard/data"]);
    expect(values("StateDirectory")).toEqual([]);
    expect(values("RuntimeDirectory")).toEqual([]);
    expect(values("UMask")).toEqual(["0077"]);
  });

  test("keeps four capabilities, each for one reading or the one write, and gains none", () => {
    expect(values("CapabilityBoundingSet")).toEqual(["CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE CAP_CHOWN CAP_SYS_PTRACE"]);
    expect(values("AmbientCapabilities")).toEqual([""]);
    expect(values("NoNewPrivileges")).toEqual(["true"]);
    expect(values("SystemCallFilter")).toEqual(["@system-service"]);
    expect(values("SystemCallArchitectures")).toEqual(["native"]);
  });

  test("never sees the stores, the steward's state nor the DNS provider's token", () => {
    const hidden = values("InaccessiblePaths").flatMap((value) => value.split(/\s+/));
    for (const path of ["-/etc/sitesolide", "-/var/lib/sitesolide-steward", "-/run/sitesolide-steward", "-/etc/caddy/cloudflare.env"]) {
      expect(hidden).toContain(path);
    }
  });

  test("reaches nothing beyond the machine, and keeps sight of its sockets", () => {
    expect(values("IPAddressDeny")).toEqual(["any"]);
    expect(values("RestrictAddressFamilies")).toEqual(["AF_UNIX AF_NETLINK"]);
    // `ss` would list none of the machine's sockets in a namespace of its own,
    // nor `-p` any process with the others hidden.
    expect(values("PrivateNetwork")).toEqual([]);
    expect(values("ProtectProc")).toEqual([]);
    expect(values("ProcSubset")).toEqual([]);
  });

  test("a pass is bounded: its measures end well before the unit's timeout, and a du killed for memory spares the snapshot", () => {
    const seconds = Number(values("TimeoutStartSec")[0]);
    const timeout = Number(/MEASURE_TIMEOUT_MS \?\? "(\d+)"/.exec(COLLECTOR)?.[1]);
    const budget = Number(/MEASURE_BUDGET_MS \?\? "(\d+)"/.exec(COLLECTOR)?.[1]);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(budget);
    expect(budget).toBeLessThanOrEqual((seconds * 1000) / 2);
    expect(values("OOMPolicy")).toEqual(["continue"]);
    expect(values("MemoryMax")).toEqual(["192M"]);
  });
});

describe("bin/deploy-collector.sh", () => {
  test("builds the collector and installs it root's, then checks its fingerprint", () => {
    expect(SCRIPT).toContain('bun build collector.ts --target=bun --outfile "$LOCAL/collector.js"');
    expect(SCRIPT).toContain('TARGET_JS="/usr/local/lib/sitesolide/collector.js"');
    expect(SCRIPT).toContain("sudo install -D -m 0644 -o root -g root $REMOTE/collector.js $TARGET_JS");
    expect(SCRIPT).toContain('[ "$installed" = "$FINGERPRINT" ]');
  });

  test("runs the collector once by hand before it arms the timer", () => {
    const run = SCRIPT.indexOf("systemctl start $UNIT.service");
    expect(run).toBeGreaterThan(-1);
    expect(run).toBeLessThan(SCRIPT.indexOf("systemctl enable --now $UNIT.timer"));
  });
});
