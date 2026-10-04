import { describe, expect, test } from "bun:test";
import { buildStatus } from "../../monitor/src/status";
import type { Tracked } from "../../monitor/src/alerts";
import {
  MONITOR_STALE_MS,
  copyMonitorStatus,
  duration,
  monitorDiscrepancies,
  monitorRefusal,
  statusFileRefusal,
} from "../src/monitor";
import { buildSnapshot, type Raw } from "../src/state";

const NOW = 1_756_400_000_000;
const MINUTE = 60_000;

function tracked(status: Tracked["status"], kind: Tracked["kind"], severity: Tracked["severity"], summary: string, slug: string | null = null): Tracked {
  return { kind, label: summary, severity, slug, status, streak: 0, since: NOW - 12 * MINUTE, summary };
}

/**
 * A status as the monitor writes it, by its own code: this test is the
 * contract between the two, and breaks on the side that changed it.
 */
function status(checks: Record<string, Tracked>, overrides: Partial<ReturnType<typeof buildStatus>> = {}): string {
  return JSON.stringify({
    ...buildStatus({ now: NOW - 30_000, zone: "test-zone.invalid", checks, heartbeat: "ok", webhook: "idle", undelivered: 0, unchecked: 0 }),
    ...overrides,
  });
}

describe("the monitor among the Issues", () => {
  test("no status, from a collector older than the monitor or with no monitor installed, says nothing", () => {
    expect(monitorDiscrepancies(undefined, NOW)).toEqual([]);
    expect(monitorDiscrepancies(null, NOW)).toEqual([]);
  });

  test("what is down shows with its site, critical as an error, and how long it has lasted", () => {
    const content = status({
      "site:shop.test-zone.invalid": tracked("down", "site", "critical", "https://shop.test-zone.invalid/ answered 502", "shop"),
      "certificate:*.test-zone.invalid": tracked("recovering", "certificate", "warning", "The certificate for *.test-zone.invalid expires in 9 days, on 2026-09-07"),
      caddy: tracked("ok", "caddy", "critical", "Caddy is active (running)"),
      "site:cms.test-zone.invalid": tracked("failing", "site", "critical", "https://cms.test-zone.invalid/ answered 502", "cms"),
    });
    expect(monitorDiscrepancies(content, NOW)).toEqual([
      { slug: "shop", severity: "error", message: "https://shop.test-zone.invalid/ answered 502 (monitor, for 12 min)" },
      {
        slug: null,
        severity: "warning",
        message: "The certificate for *.test-zone.invalid expires in 9 days, on 2026-09-07 (monitor, for 12 min)",
      },
    ]);
  });

  test("a project's unit, the disk and the memory are left to the dashboard's own judgement", () => {
    const content = status({
      "unit:cms.service": tracked("down", "unit", "critical", "cms.service is failed (failed)", "cms"),
      "disk:/": tracked("down", "disk", "critical", "/ is 93% full, 5.2 GB free"),
      memory: tracked("down", "memory", "warning", "4% of memory available"),
      "unit:sitesolide-collector.service": tracked("down", "platform", "warning", "sitesolide-collector.service is failed (failed)"),
    });
    expect(monitorDiscrepancies(content, NOW).map((d) => d.message)).toEqual([
      "sitesolide-collector.service is failed (failed) (monitor, for 12 min)",
    ]);
  });

  test("a status older than five minutes is not shown as the present", () => {
    const content = status({ caddy: tracked("down", "caddy", "critical", "Caddy is inactive (dead), result success") });
    const later = NOW - 30_000 + MONITOR_STALE_MS + MINUTE;
    expect(monitorDiscrepancies(content, later)).toEqual([
      {
        slug: null,
        severity: "warning",
        message:
          'Monitor silent for 6 min: sitesolide-monitor.timer no longer runs, or its runs fail, see "journalctl -u sitesolide-monitor"',
      },
    ]);
  });

  test("an alerting that does not go through is said, never quoting where it goes", () => {
    const content = status({}, { heartbeat: "failed", webhook: "failed", undelivered: 3 });
    expect(monitorDiscrepancies(content, NOW).map((d) => [d.severity, d.message])).toEqual([
      ["warning", "The monitor's heartbeat did not go through: its outside service will report the machine as down"],
      ["warning", "3 monitor alerts not delivered to the webhook, kept for its next run"],
    ]);
  });

  test("checks the monitor had no time to make are said, as a warning", () => {
    expect(monitorDiscrepancies(status({}, { unchecked: 3 }), NOW)).toEqual([
      {
        slug: null,
        severity: "warning",
        message: "3 checks skipped by the monitor's last pass, out of time: they keep their last state, the next pass starts with them",
      },
    ]);
    expect(monitorDiscrepancies(status({}, { unchecked: 1 }), NOW)[0]!.message).toStartWith("1 check skipped by");
    expect(monitorDiscrepancies(status({}), NOW)).toEqual([]);
  });

  test("an unreadable status is a warning, never a crash; unknown fields are ignored", () => {
    expect(monitorDiscrepancies("{", NOW)[0]!.message).toStartWith("Monitor status unreadable:");
    expect(monitorDiscrepancies("[]", NOW)[0]!.message).toBe("Monitor status unreadable: an object was expected");
    expect(monitorDiscrepancies("{}", NOW)[0]!.message).toBe("Monitor status unreadable: no date");
    const future = JSON.stringify({ generatedAt: NOW, down: [{ kind: "site", summary: "x answered 502", severity: "critical", extra: 1 }, "junk"], newField: true });
    expect(monitorDiscrepancies(future, NOW)).toEqual([{ slug: null, severity: "error", message: "x answered 502 (monitor)" }]);
  });

  test("durations read the way the monitor writes them", () => {
    expect(duration(10_000)).toBe("less than a minute");
    expect(duration(59 * MINUTE)).toBe("59 min");
    expect(duration(47 * 60 * MINUTE)).toBe("47 h");
    expect(duration(72 * 60 * MINUTE)).toBe("3 days");
  });

  test("the snapshot carries them, errors first like every other discrepancy", () => {
    const raw: Raw = {
      generated: NOW,
      zone: "test-zone.invalid",
      folders: [],
      codes: "{}",
      domains: null,
      ports: [],
      blocks: {},
      machine: null,
      previous: null,
      monitor: status({ caddy: tracked("down", "caddy", "critical", "Caddy is inactive (dead), result success") }),
    };
    expect(buildSnapshot(raw).discrepancies).toEqual([
      { slug: null, severity: "error", message: "Caddy is inactive (dead), result success (monitor, for 12 min)" },
    ]);
  });
});

/**
 * What the collector, as root, lets through from a file the monitor's account
 * owns: decided here, so that it is tested without root, and run by
 * collector.ts, whose own test lays the traps on a real tree.
 */
describe("the monitor's status as the collector copies it", () => {
  const file = { link: false, regular: true, links: 1, uid: 61234, size: 400 };

  test("a small regular file of the directory's owner, with a single name, passes", () => {
    expect(statusFileRefusal(file, 61234, 1024)).toBeNull();
  });

  test("a link, anything but a regular file, a second name, another owner or too many bytes is refused", () => {
    expect(statusFileRefusal({ ...file, link: true, regular: false }, 61234, 1024)).toBe("status.json is a symbolic link");
    expect(statusFileRefusal({ ...file, regular: false }, 61234, 1024)).toBe("status.json is not a regular file");
    expect(statusFileRefusal({ ...file, links: 2 }, 61234, 1024)).toBe("status.json has more than one name");
    // A hard link to a file of root's keeps root as its owner.
    expect(statusFileRefusal({ ...file, uid: 0 }, 61234, 1024)).toBe("status.json does not belong to the owner of its directory");
    expect(statusFileRefusal({ ...file, size: 1025 }, 61234, 1024)).toBe("status.json is larger than 1024 bytes");
  });

  test("written anew from the fields the dashboard knows, never byte for byte", () => {
    const written = status(
      { "site:shop.test-zone.invalid": tracked("down", "site", "critical", "https://shop.test-zone.invalid/ answered 502", "shop") },
      { unchecked: 2 },
    );
    const original = JSON.parse(written) as { down: unknown[] };
    const smuggled = JSON.stringify({ ...original, smuggled: "SECRET=value", down: [...original.down, "junk", { kind: 1 }] });
    expect(JSON.parse(copyMonitorStatus(smuggled))).toEqual(original);
    expect(monitorDiscrepancies(copyMonitorStatus(written), NOW)).toEqual(monitorDiscrepancies(written, NOW));
  });

  test("strings are cut, unknown words dropped, and a status with no date is refused", () => {
    const long = "x".repeat(5000);
    const raw = { generatedAt: NOW, zone: long, heartbeat: "exfiltrated", down: [{ kind: "site", summary: long, severity: "loud", slug: 3 }] };
    const copy = JSON.parse(copyMonitorStatus(JSON.stringify(raw))) as { zone: string; heartbeat?: string; down: unknown[] };
    expect(copy.zone).toHaveLength(1000);
    expect(copy.heartbeat).toBeUndefined();
    expect(copy.down).toEqual([{ kind: "site", summary: "x".repeat(1000), slug: null }]);
    expect(copyMonitorStatus("{")).toBe(monitorRefusal("status.json is not valid JSON"));
    expect(copyMonitorStatus("[]")).toBe(monitorRefusal("status.json is not an object"));
    expect(copyMonitorStatus("{}")).toBe(monitorRefusal("status.json has no date"));
  });

  test("a refusal shows among the Issues, as a warning", () => {
    expect(monitorDiscrepancies(monitorRefusal("status.json is a symbolic link"), NOW)).toEqual([
      { slug: null, severity: "warning", message: "Monitor status refused by the collector: status.json is a symbolic link" },
    ]);
  });
});
