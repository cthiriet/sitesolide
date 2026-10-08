import { describe, expect, test } from "bun:test";
import {
  BACKUP_MAX_AGE_MS,
  CERTIFICATE_WARNING_DAYS,
  RESTART_WINDOW_MS,
  ago,
  bytes,
  judgeBackup,
  BACKUP_CHECK_MAX_AGE_MS,
  judgeCaddy,
  judgeCertificate,
  judgeDisk,
  judgeMemory,
  judgeProbe,
  judgeRestarts,
  judgeSelf,
  judgeUnits,
  notProbed,
  readMeminfo,
  readProperties,
  readUnitList,
  readValidTo,
  type ListedUnit,
} from "../src/checks";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("systemctl's output", () => {
  test("show: one property per line, values kept whole", () => {
    expect(readProperties("LoadState=loaded\nActiveState=active\nResult=success\nDescription=a=b\n\n")).toEqual({
      LoadState: "loaded",
      ActiveState: "active",
      Result: "success",
      Description: "a=b",
    });
  });

  test("list-units: four columns, the description dropped, a bullet skipped", () => {
    const output = [
      "caddy.service                 loaded active   running Caddy",
      "● cms.service                 loaded failed   failed  cms, deployed by sitesolide",
      "sitesolide-collector.service  loaded inactive dead    Machine state snapshot for the dashboard",
      "not-a-service.socket          loaded active   running Something else",
      "",
    ].join("\n");
    expect(readUnitList(output)).toEqual([
      { name: "caddy.service", load: "loaded", active: "active", sub: "running" },
      { name: "cms.service", load: "loaded", active: "failed", sub: "failed" },
      { name: "sitesolide-collector.service", load: "loaded", active: "inactive", sub: "dead" },
    ]);
  });
});

describe("Caddy", () => {
  test("active, or reloading for the instant of a deployment, is fine", () => {
    expect(judgeCaddy({ LoadState: "loaded", ActiveState: "active", SubState: "running" }).verdict).toBe("ok");
    expect(judgeCaddy({ LoadState: "loaded", ActiveState: "reloading", SubState: "reload" }).verdict).toBe("ok");
  });

  test("the outage of 11 August: inactive, dead, result success", () => {
    const result = judgeCaddy({ LoadState: "loaded", ActiveState: "inactive", SubState: "dead", Result: "success" });
    expect(result).toMatchObject({ id: "caddy", verdict: "fail", severity: "critical" });
    expect(result.summary).toBe("Caddy is inactive (dead), result success");
  });

  test("waiting between two automatic restarts is not running", () => {
    expect(judgeCaddy({ LoadState: "loaded", ActiveState: "activating", SubState: "auto-restart" }).verdict).toBe("fail");
  });

  test("a unit that is not even loaded fails, a systemctl that did not answer is unknown", () => {
    expect(judgeCaddy({ LoadState: "not-found", ActiveState: "inactive" }).verdict).toBe("fail");
    expect(judgeCaddy(null).verdict).toBe("unknown");
  });
});

describe("Caddy's automatic restarts", () => {
  const show = (count: number) => ({ LoadState: "loaded", ActiveState: "active", NRestarts: String(count) });

  test("the first reading is a baseline, however high the counter", () => {
    const { result, memory } = judgeRestarts(show(3), null, NOW);
    expect(result.verdict).toBe("ok");
    expect(memory).toEqual({ count: 3, increasedAt: null });
  });

  test("the counter going up is a warning held fifteen minutes, then it clears", () => {
    const first = judgeRestarts(show(1), { count: 0, increasedAt: null }, NOW);
    expect(first.result).toMatchObject({ id: "caddy-restarts", verdict: "fail", severity: "warning" });
    expect(first.result.summary).toContain("NRestarts 1");
    expect(first.result.summary).toContain("journalctl -u caddy");

    const later = judgeRestarts(show(1), first.memory, NOW + 10 * MINUTE);
    expect(later.result.verdict).toBe("fail");
    expect(later.result.summary).toContain("10 min ago");

    const after = judgeRestarts(show(1), later.memory, NOW + RESTART_WINDOW_MS);
    expect(after.result.verdict).toBe("ok");
  });

  test("a restart asked of systemd resets the counter, which is not news", () => {
    const { result, memory } = judgeRestarts(show(0), { count: 4, increasedAt: null }, NOW);
    expect(result.verdict).toBe("ok");
    expect(memory).toEqual({ count: 0, increasedAt: null });
  });

  test("an unreadable counter changes nothing", () => {
    const memory = { count: 2, increasedAt: null };
    const reading = judgeRestarts({ LoadState: "loaded" }, memory, NOW);
    expect(reading.result.verdict).toBe("unknown");
    expect(reading.memory).toBe(memory);
    expect(judgeRestarts(null, memory, NOW).result.verdict).toBe("unknown");
  });
});

describe("units", () => {
  const projects = new Map([
    ["cms", "cms"],
    ["shop", "shop"],
    ["sitesolide-landing", "test-zone.invalid"],
  ]);
  const unit = (name: string, active: string, sub: string, load = "loaded"): ListedUnit => ({ name, load, active, sub });

  test("a project's unit fails when failed, stopped or crashing in a loop", () => {
    const results = judgeUnits(
      [
        unit("cms.service", "active", "running"),
        unit("cms.worker.service", "failed", "failed"),
        unit("shop.service", "activating", "auto-restart"),
        unit("sitesolide-landing.service", "inactive", "dead"),
      ],
      projects,
    );
    expect(results.map((r) => [r.id, r.kind, r.slug, r.verdict, r.severity])).toEqual([
      ["unit:cms.service", "unit", "cms", "ok", "critical"],
      ["unit:cms.worker.service", "unit", "cms", "fail", "critical"],
      ["unit:shop.service", "unit", "shop", "fail", "critical"],
      ["unit:sitesolide-landing.service", "unit", "test-zone.invalid", "fail", "critical"],
    ]);
    expect(results[1]!.summary).toBe("cms.worker.service is failed (failed)");
  });

  test("the platform's units fail only when failed or looping: a one-shot at rest is inactive", () => {
    const results = judgeUnits(
      [
        unit("sitesolide-collector.service", "inactive", "dead"),
        unit("sitesolide-api.service", "activating", "auto-restart"),
        unit("sitesolide-gatekeeper-on@cms.service", "failed", "failed"),
        unit("sitesolide-steward.service", "active", "running"),
      ],
      projects,
    );
    expect(results.map((r) => [r.id, r.kind, r.verdict, r.severity])).toEqual([
      ["unit:sitesolide-api.service", "platform", "fail", "warning"],
      ["unit:sitesolide-collector.service", "platform", "ok", "warning"],
      ["unit:sitesolide-gatekeeper-on@cms.service", "platform", "fail", "warning"],
      ["unit:sitesolide-steward.service", "platform", "ok", "warning"],
    ]);
  });

  test("the monitor never judges itself, nor a unit that is not loaded, nor the rest of the machine", () => {
    const results = judgeUnits(
      [
        unit("sitesolide-monitor.service", "activating", "start"),
        unit("blog.service", "inactive", "dead", "not-found"),
        unit("ssh.service", "failed", "failed"),
        unit("cmsx.service", "failed", "failed"),
      ],
      projects,
    );
    expect(results).toEqual([]);
  });
});

describe("sites over HTTPS", () => {
  test("anything below 500 answers: a locked preview, the portal's redirect, a root with nothing", () => {
    for (const status of [200, 301, 302, 401, 404]) {
      expect(judgeProbe("cms.test-zone.invalid", "cms", { status }).verdict).toBe("ok");
    }
  });

  test("a 502 or a failed handshake does not, critically", () => {
    const bad = judgeProbe("cms.test-zone.invalid", "cms", { status: 502 });
    expect(bad).toMatchObject({ id: "site:cms.test-zone.invalid", verdict: "fail", severity: "critical", slug: "cms" });
    expect(bad.summary).toBe("https://cms.test-zone.invalid/ answered 502");
    const refused = judgeProbe("shop.example", null, { error: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(refused.summary).toBe("https://shop.example/ did not answer: ERR_TLS_CERT_ALTNAME_INVALID");
  });

  test("a probe not attempted is unknown", () => {
    expect(notProbed("cms.test-zone.invalid", "cms", "not probed: Caddy is not running").verdict).toBe("unknown");
  });
});

describe("certificates", () => {
  const target = { id: "certificate:*.test-zone.invalid", label: "*.test-zone.invalid", slug: null };

  test("OpenSSL's date is read strictly", () => {
    expect(readValidTo("Oct  9 17:58:41 2026 GMT")).toBe(Date.UTC(2026, 9, 9, 17, 58, 41));
    expect(readValidTo("Feb 28 00:00:00 2027 GMT")).toBe(Date.UTC(2027, 1, 28));
    expect(readValidTo("Feb 31 00:00:00 2027 GMT")).toBeNull();
    expect(readValidTo("2026-10-09T17:58:41Z")).toBeNull();
    expect(readValidTo("")).toBeNull();
  });

  test("fourteen days and more is fine, less is a warning", () => {
    expect(judgeCertificate(target, { notAfter: NOW + CERTIFICATE_WARNING_DAYS * DAY }, NOW).verdict).toBe("ok");
    const soon = judgeCertificate(target, { notAfter: NOW + 9 * DAY + MINUTE }, NOW);
    expect(soon).toMatchObject({ verdict: "fail", severity: "warning", kind: "certificate" });
    expect(soon.summary).toBe("The certificate for *.test-zone.invalid expires in 9 days, on 2026-10-13");
    expect(judgeCertificate(target, { notAfter: NOW + 3 * 60 * MINUTE }, NOW).summary).toContain("in less than a day");
  });

  test("an expired certificate says when", () => {
    const expired = judgeCertificate(target, { notAfter: NOW - DAY }, NOW);
    expect(expired.verdict).toBe("fail");
    expect(expired.summary).toBe("The certificate for *.test-zone.invalid expired on 2026-10-03");
  });

  test("a certificate that could not be read is unknown: the probe reports the host", () => {
    expect(judgeCertificate(target, { error: "ECONNREFUSED" }, NOW).verdict).toBe("unknown");
  });
});

describe("disk and memory", () => {
  // 100 GB, 4 KB blocks.
  const disk = (usedPercent: number) => {
    const blocks = 25_000_000;
    const bfree = Math.round(blocks * (1 - usedPercent / 100));
    return { bsize: 4096, blocks, bfree, bavail: bfree };
  };

  test("90 % raises the alert, critically", () => {
    expect(judgeDisk("/", disk(89), false).verdict).toBe("ok");
    const full = judgeDisk("/", disk(90), false);
    expect(full).toMatchObject({ id: "disk:/", verdict: "fail", severity: "critical" });
    expect(full.summary).toBe("/ is 90% full, 10.2 GB free");
  });

  test("once raised, it clears below 85 % only: no storm at the threshold", () => {
    expect(judgeDisk("/", disk(88), true).verdict).toBe("fail");
    expect(judgeDisk("/", disk(85), true).verdict).toBe("fail");
    expect(judgeDisk("/", disk(84), true).verdict).toBe("ok");
  });

  test("the reserved blocks count as neither used nor free, as df counts them", () => {
    // 1000 blocks, 50 reserved for root: 900 used, 50 available is 95 %.
    expect(judgeDisk("/srv", { bsize: 4096, blocks: 1000, bfree: 100, bavail: 50 }, false).summary).toContain("95% full");
  });

  test("an unreadable filesystem is unknown", () => {
    expect(judgeDisk("/srv", null, false).verdict).toBe("unknown");
  });

  const meminfo = (totalKb: number, availableKb: number) =>
    `MemTotal:       ${totalKb} kB\nMemFree:          123456 kB\nMemAvailable:   ${availableKb} kB\nBuffers:           1234 kB\n`;

  test("/proc/meminfo is read in bytes", () => {
    expect(readMeminfo(meminfo(8_000_000, 2_000_000))).toEqual({ total: 8_192_000_000, available: 2_048_000_000 });
    expect(readMeminfo("MemTotal: 12 kB\n")).toBeNull();
  });

  test("less than 10 % available is a warning, cleared at 15 %", () => {
    expect(judgeMemory(meminfo(8_000_000, 900_000), false).verdict).toBe("ok");
    const low = judgeMemory(meminfo(8_000_000, 700_000), false);
    expect(low).toMatchObject({ id: "memory", verdict: "fail", severity: "warning" });
    expect(low.summary).toBe("9% of memory available, 716.8 MB of 8.2 GB");
    expect(judgeMemory(meminfo(8_000_000, 1_100_000), true).verdict).toBe("fail");
    expect(judgeMemory(meminfo(8_000_000, 1_200_000), true).verdict).toBe("ok");
    expect(judgeMemory(null, false).verdict).toBe("unknown");
  });

  test("sizes read at a glance", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1_500_000)).toBe("1.5 MB");
  });
});

describe("backups", () => {
  const status = (finishedAgoMs: number, ok: boolean, projects: Record<string, boolean>) =>
    JSON.stringify({
      startedAt: new Date(NOW - finishedAgoMs - MINUTE).toISOString(),
      finishedAt: new Date(NOW - finishedAgoMs).toISOString(),
      ok,
      projects: Object.fromEntries(
        Object.entries(projects).map(([slug, good]) => [slug, { ok: good, snapshot: good ? "a1b2c3" : null, error: good ? null : "restic: exit 1" }]),
      ),
    });

  test("no status file, no check: backups are installed separately", () => {
    expect(judgeBackup({ missing: true }, NOW)).toBeNull();
  });

  test("a recent successful run is fine", () => {
    const result = judgeBackup({ text: status(3 * 60 * MINUTE, true, { cms: true, shop: true }) }, NOW);
    expect(result).toMatchObject({ id: "backup", verdict: "ok", severity: "warning" });
    expect(result!.summary).toBe("The last backup run finished 3 h ago, 2 projects");
  });

  test("a failed run names the projects that failed", () => {
    const result = judgeBackup({ text: status(MINUTE * 30, false, { cms: true, shop: false, blog: false }) }, NOW);
    expect(result!.verdict).toBe("fail");
    expect(result!.summary).toBe("The last backup run failed for blog, shop, 30 min ago");
  });

  test("a failed project fails the run even if the top says ok", () => {
    expect(judgeBackup({ text: status(MINUTE, true, { shop: false }) }, NOW)!.verdict).toBe("fail");
  });

  test("a run older than 26 hours is stale", () => {
    expect(judgeBackup({ text: status(BACKUP_MAX_AGE_MS - MINUTE, true, {}) }, NOW)!.verdict).toBe("ok");
    const stale = judgeBackup({ text: status(BACKUP_MAX_AGE_MS + MINUTE, true, {}) }, NOW);
    expect(stale!.verdict).toBe("fail");
    expect(stale!.summary).toBe("The last backup run finished 26 h ago, more than 26 h");
  });

  test("a repository whose check failed, or was not checked for three days, is a warning", () => {
    const withChecks = (checks: unknown) => JSON.stringify({ ...JSON.parse(status(MINUTE, true, { cms: true })), checks });
    const at = (agoMs: number) => new Date(NOW - agoMs).toISOString();
    expect(judgeBackup({ text: withChecks({ local: { at: at(HOUR), ok: true, error: null }, offsite: null }) }, NOW)!.verdict).toBe("ok");
    expect(judgeBackup({ text: withChecks({ local: null, offsite: null }) }, NOW)!.verdict).toBe("ok");
    const failed = judgeBackup({ text: withChecks({ local: { at: at(HOUR), ok: false, error: "the check of the server's repository found errors" }, offsite: null }) }, NOW);
    expect(failed!.verdict).toBe("fail");
    expect(failed!.summary).toBe("Backups: the server's repository check failed 1 h ago (the check of the server's repository found errors)");
    const old = judgeBackup({ text: withChecks({ local: { at: at(HOUR), ok: true, error: null }, offsite: { at: at(BACKUP_CHECK_MAX_AGE_MS + HOUR), ok: true, error: null } }) }, NOW);
    expect(old!.summary).toBe("Backups: the bucket's repository was last checked 3 days ago, more than 72 h");
  });

  test("no check yet: fine on a first day, a warning three days after checks were first due", () => {
    const withChecks = (checks: unknown) => JSON.stringify({ ...JSON.parse(status(MINUTE, true, { cms: true })), checks });
    const at = (agoMs: number) => new Date(NOW - agoMs).toISOString();
    expect(judgeBackup({ text: withChecks({ local: null, offsite: null, since: at(20 * HOUR), offsiteSince: null }) }, NOW)!.verdict).toBe("ok");
    const never = judgeBackup({ text: withChecks({ local: null, offsite: null, since: at(4 * DAY), offsiteSince: null }) }, NOW);
    expect(never!.verdict).toBe("fail");
    expect(never!.summary).toBe("Backups: the server's repository was never checked, its checks due for 4 days");
    // A bucket configured yesterday on a machine checked for a month: not yet.
    const bucket = { local: { at: at(HOUR), ok: true, error: null }, offsite: null, since: at(30 * DAY), offsiteSince: at(DAY) };
    expect(judgeBackup({ text: withChecks(bucket) }, NOW)!.verdict).toBe("ok");
    expect(judgeBackup({ text: withChecks({ ...bucket, offsiteSince: at(5 * DAY) }) }, NOW)!.summary).toBe("Backups: the bucket's repository was never checked, its checks due for 5 days");
  });

  test("a file there but unreadable or malformed is a failure", () => {
    expect(judgeBackup({ error: "EACCES" }, NOW)!.verdict).toBe("fail");
    expect(judgeBackup({ text: "{" }, NOW)!.summary).toBe("The backup status is not valid JSON");
    expect(judgeBackup({ text: '{"ok": true}' }, NOW)!.summary).toBe("The backup status does not have the expected shape");
    expect(judgeBackup({ text: '{"ok": "yes", "finishedAt": "2026-10-04T10:00:00Z"}' }, NOW)!.verdict).toBe("fail");
  });

  test("durations in the largest unit that fits", () => {
    expect(ago(30_000)).toBe("less than a minute");
    expect(ago(5 * MINUTE)).toBe("5 min");
    expect(ago(47 * 60 * MINUTE)).toBe("47 h");
    expect(ago(3 * DAY)).toBe("3 days");
  });
});

describe("the monitor itself", () => {
  test("what it could not read is a warning, listed", () => {
    expect(judgeSelf([]).verdict).toBe("ok");
    const half = judgeSelf(["systemctl list-units: timed out after 10000 ms", "HEARTBEAT_URL is not a URL"]);
    expect(half).toMatchObject({ id: "monitor", verdict: "fail", severity: "warning" });
    expect(half.summary).toBe(
      "The monitor could not run fully: systemctl list-units: timed out after 10000 ms; HEARTBEAT_URL is not a URL",
    );
  });
});
