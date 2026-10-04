import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The systemd files, read as text: what only a machine can execute is at
 * least checked line by line here. That systemd accepts them, and that the
 * restart policy does what its comment says, is for a test VM: see
 * infra/README.md, "Caddy's restart policy", and monitor/README.md,
 * "Verification on a test VM".
 */

const INFRA = join(import.meta.dir, "..", "..", "infra");

/** The directives of a unit file, comments and blank lines left out, per section. */
function directives(path: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header !== null) {
      current = header[1]!;
      sections.set(current, sections.get(current) ?? []);
      continue;
    }
    sections.get(current)?.push(line);
  }
  return sections;
}

describe("Caddy's drop-in", () => {
  const unit = directives(join(INFRA, "caddy", "caddy.service.d", "override.conf"));
  const service = unit.get("Service") ?? [];

  test("restarted however it ended, never given up on", () => {
    expect(service).toContain("Restart=always");
    expect(service).toContain("RestartSec=2s");
    expect(service).toContain("RestartSteps=4");
    expect(service).toContain("RestartMaxDelaySec=30s");
    // The start limit belongs to [Unit]: in [Service] systemd ignores it.
    expect(unit.get("Unit")).toEqual(["StartLimitIntervalSec=0"]);
    expect(service.some((line) => line.startsWith("StartLimit"))).toBe(false);
  });

  test("what it already carried is still there: both environment files, and no --environ", () => {
    expect(service).toContain("EnvironmentFile=/etc/caddy/cloudflare.env");
    expect(service).toContain("EnvironmentFile=/etc/caddy/sitesolide.env");
    expect(service).toContain("ExecStart=");
    expect(service).toContain("ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile");
    expect(service.join("\n")).not.toContain("--environ");
  });
});

describe("the monitor's unit", () => {
  const unit = directives(join(INFRA, "monitor", "sitesolide-monitor.service"));
  const service = unit.get("Service") ?? [];

  test("a one-shot, run from the installed bundle", () => {
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/bin/bun /usr/local/lib/sitesolide/monitor.js");
    expect(unit.get("Unit")).toContain("ConditionPathExists=/usr/local/lib/sitesolide/monitor.js");
  });

  test("no privilege: a dynamic account, no capability, never root", () => {
    expect(service).toContain("DynamicUser=yes");
    expect(service).toContain("CapabilityBoundingSet=");
    expect(service).toContain("AmbientCapabilities=");
    expect(service).toContain("NoNewPrivileges=yes");
    expect(service.some((line) => line.startsWith("User="))).toBe(false);
    expect(service.some((line) => line.startsWith("ReadWritePaths="))).toBe(false);
  });

  test("its state where the collector looks for it", () => {
    expect(service).toContain("StateDirectory=sitesolide-monitor");
    expect(service).toContain("UMask=0077");
  });

  test("the zone required, the alerting optional, nothing else from /etc/sitesolide", () => {
    const files = service.filter((line) => line.startsWith("EnvironmentFile="));
    expect(files).toEqual(["EnvironmentFile=/etc/caddy/sitesolide.env", "EnvironmentFile=-/etc/sitesolide/dashboard-monitor.env"]);
  });

  test("bounded in time, below the timer's minute", () => {
    expect(service).toContain("TimeoutStartSec=50s");
  });

  test("the network families it needs and the sandbox, /proc/meminfo left readable", () => {
    expect(service).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ProtectProc=invisible");
    expect(service.some((line) => line.startsWith("ProcSubset="))).toBe(false);
    expect(service.some((line) => line.startsWith("PrivateNetwork="))).toBe(false);
  });

  test("the timer: every minute, nothing caught up", () => {
    const timer = directives(join(INFRA, "monitor", "sitesolide-monitor.timer")).get("Timer") ?? [];
    expect(timer).toContain("OnUnitActiveSec=1min");
    expect(timer).toContain("OnBootSec=2min");
    expect(timer).toContain("Persistent=false");
  });
});
