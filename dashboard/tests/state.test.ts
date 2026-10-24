import { describe, expect, test } from "bun:test";
import { generateFragment } from "../borrowed/fragment";
import type { Manifest } from "../borrowed/manifest";
import {
  LANDING_FOLDER,
  LANDING_UNIT,
  addressOf,
  codeAddress,
  buildSnapshot,
  declaredSecrets,
  computeCpuShare,
  readTable,
  unitOf,
  type Raw,
  type RawFolder,
  type RawUnit,
} from "../src/state";

const CODE = "A7B2K9";

function unit(properties: Partial<RawUnit> = {}): RawUnit {
  return {
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "running",
    MemoryCurrent: "20971520",
    MemoryPeak: "31457280",
    MemoryMax: "268435456",
    NRestarts: "0",
    ActiveEnterTimestamp: "@1756400000",
    CPUUsageNSec: "120000000000",
    ...properties,
  };
}

function folder(slug: string, manifest: unknown, remaining: Partial<RawFolder> = {}): RawFolder {
  return {
    slug,
    manifest: manifest === null ? null : JSON.stringify(manifest),
    unit: null,
    bytes: 1024,
    deployed: 1_700_000_000_000,
    ...remaining,
  };
}

function raw(folders: RawFolder[], remaining: Partial<Raw> = {}): Raw {
  return {
    generated: 1_756_400_000_000,
    zone: "test-zone.invalid",
    folders,
    codes: "{}",
    domains: null,
    ports: [],
    blocks: {},
    machine: null,
    previous: null,
    ...remaining,
  };
}

/** The messages are long and will change; the tests aim at the subject, not the sentence. */
function messages(snapshot: ReturnType<typeof buildSnapshot>, slug: string | null): string[] {
  return snapshot.discrepancies.filter((discrepancy) => discrepancy.slug === slug).map((discrepancy) => discrepancy.message);
}

describe("project type", () => {
  test("a manifest with no start is a static site", () => {
    const { sites } = buildSnapshot(raw([folder("showcase", { slug: "showcase", publicDir: "public" })]));
    expect(sites[0]?.type).toBe("static");
    expect(sites[0]?.service).toBeNull();
  });

  test("a manifest with a start is an app project", () => {
    const manifest = { slug: "tool", port: 3030, publicDir: "public", start: "bun run server.ts" };
    const { sites } = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], { ports: [3030] }),
    );
    expect(sites[0]?.type).toBe("app");
    expect(sites[0]?.port).toBe(3030);
    expect(sites[0]?.listening).toBe(true);
  });

  test("a missing unit is not a fallen service", () => {
    const { sites } = buildSnapshot(
      raw([folder("showcase", { slug: "showcase", publicDir: "public" }, { unit: { LoadState: "not-found" } })]),
    );
    expect(sites[0]?.service).toBeNull();
    expect(messages(buildSnapshot(raw([])), null)).toHaveLength(0);
  });
});

describe("the lock", () => {
  test("a closed lock yields the link to send, code included", () => {
    const { sites, discrepancies } = buildSnapshot(
      raw([folder("client", { slug: "client", publicDir: "public", lock: true })], {
        codes: JSON.stringify({ client: CODE }),
      }),
    );
    expect(sites[0]?.lock).toEqual({
      closed: true,
      code: CODE,
      url: `https://client.test-zone.invalid/?key=${CODE}`,
    });
    expect(discrepancies).toHaveLength(0);
  });

  test("a lock asked for with no valid code is an error", () => {
    const snapshot = buildSnapshot(
      raw([folder("client", { slug: "client", publicDir: "public", lock: true })]),
    );
    expect(messages(snapshot, "client")).toHaveLength(1);
    expect(snapshot.discrepancies[0]?.severity).toBe("error");
    expect(snapshot.discrepancies[0]?.message).toContain("Choose one in its Access section");
  });

  test("a lower-case or too short code does not count as a code", () => {
    const snapshot = buildSnapshot(
      raw([folder("client", { slug: "client", publicDir: "public", lock: true })], {
        codes: JSON.stringify({ client: "a7b2k9" }),
      }),
    );
    expect(snapshot.sites[0]?.lock.code).toBeNull();
    expect(messages(snapshot, "client")).toHaveLength(1);
  });

  test("a code in force with no lock asked for is an error, the other way round", () => {
    const snapshot = buildSnapshot(
      raw([folder("client", { slug: "client", publicDir: "public" })], {
        codes: JSON.stringify({ client: CODE }),
      }),
    );
    expect(snapshot.discrepancies[0]?.severity).toBe("error");
    expect(snapshot.discrepancies[0]?.message).toContain("no longer asks for one. Choose one in its Access section");
  });

  test("an unreadable code table says so instead of keeping quiet", () => {
    const snapshot = buildSnapshot(raw([], { codes: "{ not json" }));
    expect(messages(snapshot, null)).toHaveLength(1);
  });
});

describe("domain", () => {
  const manifest = {
    slug: "client",
    publicDir: "public",
    domain: { name: "example.test", active: true },
  };

  test("an active domain missing from the table is an error", () => {
    const snapshot = buildSnapshot(raw([folder("client", manifest)]));
    expect(snapshot.sites[0]?.domain?.route).toBe(false);
    expect(snapshot.discrepancies[0]?.severity).toBe("error");
    expect(snapshot.discrepancies[0]?.message).toContain("generate-domains.sh");
  });

  test("an active and routed domain flags nothing", () => {
    const snapshot = buildSnapshot(
      raw([folder("client", manifest)], { domains: "\texample.test client\n" }),
    );
    expect(snapshot.sites[0]?.domain?.route).toBe(true);
    expect(snapshot.discrepancies).toHaveLength(0);
  });

  test("a routed domain the manifest no longer activates is a warning", () => {
    const inactive = { ...manifest, domain: { name: "example.test", active: false } };
    const snapshot = buildSnapshot(
      raw([folder("client", inactive)], { domains: "\texample.test client\n" }),
    );
    expect(snapshot.discrepancies[0]?.severity).toBe("warning");
  });

  test("the table ignores its comments and its wobbly lines", () => {
    const table = readTable("# generated\n\texample.test client\nwobbly\n");
    expect([...table]).toEqual([["example.test", "client"]]);
  });
});

describe("service", () => {
  const manifest = { slug: "tool", port: 3030, publicDir: "public", start: "bun run server.ts" };

  test("a failed service is a named error", () => {
    const snapshot = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit({ ActiveState: "failed", SubState: "failed" }) })], {
        ports: [3030],
      }),
    );
    expect(messages(snapshot, "tool")).toEqual(["Service failed (failed)"]);
  });

  test("a declared port nobody listens on is an error", () => {
    const snapshot = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], { ports: [3011] }),
    );
    expect(snapshot.sites[0]?.listening).toBe(false);
    expect(messages(snapshot, "tool")[0]).toContain("3030");
  });

  test("an app project with no loaded unit is an error", () => {
    const snapshot = buildSnapshot(raw([folder("tool", manifest)], { ports: [3030] }));
    expect(messages(snapshot, "tool")[0]).toContain("without a loaded unit");
  });

  test("a peak close to the limit is a warning", () => {
    const snapshot = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit({ MemoryPeak: "241591910" }) })], { ports: [3030] }),
    );
    expect(messages(snapshot, "tool")).toEqual(["Memory peak at 90% of the limit"]);
  });

  test("the unix timestamp becomes a date, and zero stays an absence", () => {
    const with_ = buildSnapshot(raw([folder("tool", manifest, { unit: unit() })], { ports: [3030] }));
    expect(with_.sites[0]?.service?.since).toBe(1_756_400_000_000);

    const without = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit({ ActiveEnterTimestamp: "@0" }) })], { ports: [3030] }),
    );
    expect(without.sites[0]?.service?.since).toBeNull();
  });

  test("systemd's unset values do not become zeros", () => {
    const snapshot = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit({ MemoryMax: "infinity", MemoryPeak: "[not set]" }) })], {
        ports: [3030],
      }),
    );
    expect(snapshot.sites[0]?.service?.limit).toBeNull();
    expect(snapshot.sites[0]?.service?.peak).toBeNull();
  });
});

describe("a project with several services", () => {
  const LAB = {
    slug: "lab",
    services: {
      web: { start: "/srv/sites/lab/app/web", port: 3050 },
      api: { start: "/srv/sites/lab/app/api", port: 3051, routes: ["/v1/*"] },
      worker: { start: "/srv/sites/lab/app/worker", port: 3052, internal: true },
    },
  };

  test("every service is listed, the main one first, with its unit, port and routes", () => {
    const { sites } = buildSnapshot(
      raw([folder("lab", LAB, { unit: unit(), units: { "lab.api": unit(), "lab.worker": unit({ MemoryCurrent: "104857600" }) } })], {
        ports: [3050, 3051, 3052],
      }),
    );
    const services = sites[0]!.services;
    expect(services.map((service) => [service.name, service.unit, service.port, service.routes, service.internal])).toEqual([
      ["web", "lab", 3050, null, false],
      ["api", "lab.api", 3051, ["/v1/*"], false],
      ["worker", "lab.worker", 3052, null, true],
    ]);
    expect(services.every((service) => service.listening === true && service.service?.active === "active")).toBe(true);
    expect(services[2]!.service?.memory).toBe(104857600);
    // The main service stays where the rest of the page reads it.
    expect(sites[0]!.service?.unit).toBe("lab");
    expect(sites[0]!.port).toBe(3050);
  });

  test("a secondary service that is down, missing or silent is named in the discrepancies", () => {
    const snapshot = buildSnapshot(
      raw([folder("lab", LAB, { unit: unit(), units: { "lab.api": unit({ ActiveState: "failed", SubState: "failed" }), "lab.worker": null } })], {
        ports: [3050],
      }),
    );
    const found = messages(snapshot, "lab");
    expect(found).toContainEqual("Service api failed (failed)");
    expect(found).toContainEqual(expect.stringContaining("Service worker: no loaded unit"));
    expect(found).toContainEqual(expect.stringContaining("Service api: port 3051 declared, but nothing listens"));
  });

  test("a secondary service's memory peak is its own warning", () => {
    const snapshot = buildSnapshot(
      raw([folder("lab", LAB, { unit: unit(), units: { "lab.api": unit(), "lab.worker": unit({ MemoryPeak: "260000000" }) } })], {
        ports: [3050, 3051, 3052],
      }),
    );
    expect(messages(snapshot, "lab")).toEqual([expect.stringContaining("Service worker: memory peak at")]);
  });

  test("a reading from a collector older than services still opens", () => {
    const { sites } = buildSnapshot(raw([folder("lab", LAB, { unit: unit() })], { ports: [3050, 3051, 3052] }));
    expect(sites[0]!.services[1]!.service).toBeNull();
  });

  test("the rates of the other units are computed from their own counters", () => {
    const { sites } = buildSnapshot(
      raw(
        [folder("lab", LAB, { unit: unit(), units: { "lab.api": unit({ CPUUsageNSec: "66000000000" }), "lab.worker": unit() } })],
        { ports: [3050, 3051, 3052], previous: { generated: 1_756_400_000_000 - 60_000, cpu: { "lab.api": 6_000_000_000 } } },
      ),
    );
    expect(sites[0]!.services[1]!.service?.cpuShare).toBe(100);
  });

  test("a single start is one service, and a static site none", () => {
    const tool = { slug: "tool", port: 3030, start: "bun run server.ts" };
    const { sites } = buildSnapshot(
      raw([folder("tool", tool, { unit: unit() }), folder("notes", { slug: "notes", publicDir: "public" })], { ports: [3030] }),
    );
    const bySlug = new Map(sites.map((site) => [site.slug, site]));
    expect(bySlug.get("tool")!.services.map((service) => [service.name, service.unit, service.port])).toEqual([[null, "tool", 3030]]);
    expect(bySlug.get("notes")!.services).toEqual([]);
  });
});

describe("workers and scheduled services", () => {
  const GENERATED = 1_756_400_000_000;
  const HOUR_S = 3600;
  /** A date as `systemctl show --timestamp=unix` writes it, so many seconds before the reading. */
  const before = (seconds: number) => `@${GENERATED / 1000 - seconds}`;
  const after = (seconds: number) => `@${GENERATED / 1000 + seconds}`;

  /**
   * A date as systemd 257 writes a timer's next and last elapse, which
   * `--timestamp=unix` does not reach, in the UTC the collector asks for.
   */
  const timerDate = (offsetSeconds: number) => {
    const date = new Date(GENERATED + offsetSeconds * 1000);
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
    return `${day} ${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC`;
  };

  /** A timer as the collector reads it: armed, its last trigger and its next. */
  function timer(properties: Partial<RawUnit> = {}): RawUnit {
    return { LoadState: "loaded", ActiveState: "active", SubState: "waiting", LastTriggerUSec: timerDate(-HOUR_S), NextElapseUSecRealtime: timerDate(900), ...properties };
  }

  test("a timer's dates read as systemd writes them, a date in UTC, as well as in seconds", () => {
    const manifest = JSON.stringify({ slug: "clock", services: { tick: { start: "/bin/true", schedule: "*:0/15" } } });
    const read = (next: string) =>
      buildSnapshot(raw([{ slug: "clock", manifest, unit: unit({ ActiveState: "active", SubState: "exited" }), units: { "clock.tick": idle(), "clock.tick.timer": timer({ NextElapseUSecRealtime: next }) }, bytes: 0, deployed: 0 }])).sites[0]!.services[0]!.schedule!.next;
    expect(read(timerDate(900))).toBe(GENERATED + 900_000);
    expect(read(after(900))).toBe(GENERATED + 900_000);
    expect(read("n/a")).toBeNull();
  });

  /** A scheduled service between two runs, its last one a success an hour ago. */
  function idle(properties: Partial<RawUnit> = {}): RawUnit {
    return unit({
      ActiveState: "inactive",
      SubState: "dead",
      MemoryCurrent: "[not set]",
      CPUUsageNSec: "[not set]",
      Result: "success",
      ExecMainStatus: "0",
      ExecMainStartTimestamp: before(HOUR_S),
      ExecMainExitTimestamp: before(HOUR_S - 40),
      ...properties,
    });
  }

  /** A web front, a worker and an hourly job, the job written first: it is never the main one. */
  const SHOP = {
    slug: "shop",
    services: {
      sync: { start: "/srv/sites/shop/app/sync", schedule: "hourly" },
      web: { start: "/srv/sites/shop/app/web", port: 3050 },
      queue: { start: "/srv/sites/shop/app/queue", internal: true },
    },
  };

  function shop(units: Record<string, RawUnit | null>, main: RawUnit = unit()) {
    return buildSnapshot(raw([folder("shop", SHOP, { unit: main, units })], { generated: GENERATED, ports: [3050] }));
  }

  const HEALTHY = { "shop.sync": idle(), "shop.sync.timer": timer(), "shop.queue": unit() };

  test("every service with its kind, the main one first whatever the written order, a schedule for the scheduled one", () => {
    const { sites } = shop(HEALTHY);
    const site = sites[0]!;
    expect(site.services.map((service) => [service.name, service.unit, service.kind, service.main, service.port])).toEqual([
      ["web", "shop", "server", true, 3050],
      ["sync", "shop.sync", "scheduled", false, null],
      ["queue", "shop.queue", "worker", false, null],
    ]);
    expect(site.service?.unit).toBe("shop");
    expect(site.port).toBe(3050);
    expect(site.headless).toBe(false);
    expect(site.services[2]!.schedule).toBeNull();
    expect(site.services[1]!.schedule).toEqual({
      expression: "hourly",
      timeout: "1h",
      timer: "shop.sync.timer",
      timerState: { loaded: true, active: "active", subState: "waiting" },
      lastTrigger: GENERATED - HOUR_S * 1000,
      next: GENERATED + 900_000,
      lastRun: { at: GENERATED - (HOUR_S - 40) * 1000, ok: true, result: "success", status: 0, failure: null },
    });
  });

  test("an idle scheduled service, its timer waiting, and a running worker are no discrepancy", () => {
    expect(messages(shop(HEALTHY), "shop")).toEqual([]);
  });

  test("a run in progress is none either, and has no last run until it ends", () => {
    const snapshot = shop({ ...HEALTHY, "shop.sync": unit({ Result: "success", ExecMainStartTimestamp: before(30), ExecMainExitTimestamp: "" }) });
    expect(messages(snapshot, "shop")).toEqual([]);
    expect(snapshot.sites[0]!.services[1]!.schedule!.lastRun).toBeNull();
  });

  test("a failed last run is a warning naming the service, when and how", () => {
    const failed = (result: string, status: string) =>
      shop({ ...HEALTHY, "shop.sync": idle({ ActiveState: "failed", SubState: "failed", Result: result, ExecMainStatus: status, ExecMainExitTimestamp: before(2 * HOUR_S) }) });
    const snapshot = failed("exit-code", "1");
    expect(snapshot.discrepancies.filter((d) => d.slug === "shop")).toEqual([
      { slug: "shop", severity: "warning", message: "Service sync: last run failed 2 h ago (exit code 1)" },
    ]);
    expect(snapshot.sites[0]!.services[1]!.schedule!.lastRun).toMatchObject({ ok: false, result: "exit-code", status: 1, failure: "exit code 1" });
    expect(messages(failed("timeout", "15"), "shop")).toEqual(["Service sync: last run failed 2 h ago (stopped after its timeout of 1h)"]);
    expect(messages(failed("signal", "9"), "shop")).toEqual(["Service sync: last run failed 2 h ago (killed by signal 9)"]);
    expect(messages(failed("oom-kill", "9"), "shop")).toEqual(["Service sync: last run failed 2 h ago (killed for lack of memory)"]);
  });

  test("a timer that is not active is an error: the schedule stopped, and nothing runs", () => {
    const stopped = shop({ ...HEALTHY, "shop.sync.timer": timer({ ActiveState: "inactive", SubState: "dead" }) });
    expect(stopped.discrepancies.filter((d) => d.slug === "shop")).toEqual([
      { slug: "shop", severity: "error", message: "Service sync: its schedule is stopped, shop.sync.timer is inactive (dead)" },
    ]);
    expect(stopped.sites[0]!.services[1]!.schedule!.next).toBeNull();

    const missing = shop({ ...HEALTHY, "shop.sync.timer": { LoadState: "not-found", ActiveState: "inactive", SubState: "dead" } });
    expect(messages(missing, "shop")).toEqual(["Service sync: no loaded timer (shop.sync.timer), it never runs"]);
    expect(messages(shop({ ...HEALTHY, "shop.sync.timer": null }), "shop")).toEqual(["Service sync: no loaded timer (shop.sync.timer), it never runs"]);
  });

  test("a scheduled service with no loaded unit is an error, as any service", () => {
    expect(messages(shop({ ...HEALTHY, "shop.sync": null }), "shop")).toEqual(["Service sync: no loaded unit (shop.sync.service)"]);
  });

  test("a worker that is not active is an error, as any service that runs for good", () => {
    const snapshot = shop({ ...HEALTHY, "shop.queue": unit({ ActiveState: "activating", SubState: "auto-restart", NRestarts: "12" }) });
    expect(snapshot.discrepancies.filter((d) => d.slug === "shop")).toEqual([
      { slug: "shop", severity: "error", message: "Service queue activating (auto-restart)" },
    ]);
  });

  test("a reading from a collector older than scheduled services judges no timer, and no run it did not read", () => {
    const snapshot = shop({ "shop.sync": unit({ ActiveState: "inactive", SubState: "dead" }), "shop.queue": unit() });
    expect(messages(snapshot, "shop")).toEqual([]);
    expect(snapshot.sites[0]!.services[1]!.schedule).toMatchObject({ timerState: null, lastTrigger: null, next: null, lastRun: null });
  });

  test("after a reboot, systemd no longer says how the last run ended, the timer still says when it was", () => {
    const rebooted = idle({ Result: "success", ExecMainStartTimestamp: "", ExecMainExitTimestamp: "", ExecMainStatus: "0" });
    const snapshot = shop({ ...HEALTHY, "shop.sync": rebooted, "shop.sync.timer": timer({ LastTriggerUSec: before(5 * HOUR_S) }) });
    expect(snapshot.sites[0]!.services[1]!.schedule).toMatchObject({ lastRun: null, lastTrigger: GENERATED - 5 * HOUR_S * 1000 });
    expect(messages(snapshot, "shop")).toEqual([]);
  });

  test("a failure that never started the program still counts as a failed run", () => {
    const refused = idle({ ActiveState: "failed", SubState: "failed", Result: "resources", ExecMainStartTimestamp: "", ExecMainExitTimestamp: "" });
    const snapshot = shop({ ...HEALTHY, "shop.sync": refused });
    expect(messages(snapshot, "shop")).toEqual(["Service sync: last run failed 1 h ago (resources)"]);
  });

  test("a scheduled service's memory peak is named, its CPU counter absent between runs", () => {
    const snapshot = shop({ ...HEALTHY, "shop.sync": idle({ MemoryPeak: "250000000" }) });
    expect(messages(snapshot, "shop")).toEqual([expect.stringContaining("Service sync: memory peak at")]);
    expect(snapshot.sites[0]!.services[1]!.service?.cpuShare).toBeNull();
  });

  describe("a project whose every service is scheduled", () => {
    const NIGHTLY = {
      slug: "nightly",
      services: {
        report: { start: "/srv/sites/nightly/app/report", schedule: "daily" },
        purge: { start: "/srv/sites/nightly/app/purge", schedule: "*:0/15", timeout: "5m" },
      },
    };
    /** The anchor: a oneshot that ran /bin/true and stays active, with no memory and no ceiling. */
    const anchor = (properties: Partial<RawUnit> = {}) =>
      unit({ SubState: "exited", MemoryCurrent: "[not set]", MemoryPeak: "[not set]", MemoryMax: "infinity", CPUUsageNSec: "0", ...properties });
    const UNITS = {
      "nightly.report": idle(),
      "nightly.report.timer": timer(),
      "nightly.purge": idle(),
      "nightly.purge.timer": timer({ NextElapseUSecRealtime: after(300) }),
    };
    const nightly = (main: RawUnit | null, units: Record<string, RawUnit | null> = UNITS) =>
      buildSnapshot(raw([folder("nightly", NIGHTLY, { unit: main, units })], { generated: GENERATED }));

    test("its main unit is the anchor, none of its services is the main one, and it serves no page", () => {
      const snapshot = nightly(anchor());
      const site = snapshot.sites[0]!;
      expect(site.type).toBe("app");
      expect(site.headless).toBe(true);
      expect(site.service).toMatchObject({ unit: "nightly", active: "active", subState: "exited", memory: null });
      expect(site.port).toBeNull();
      expect(site.listening).toBeNull();
      expect(site.services.map((service) => [service.name, service.unit, service.main, service.schedule?.timeout])).toEqual([
        ["report", "nightly.report", false, "1h"],
        ["purge", "nightly.purge", false, "5m"],
      ]);
      expect(messages(snapshot, "nightly")).toEqual([]);
    });

    test("an anchor that is not active is the project stopped, an error", () => {
      expect(messages(nightly(anchor({ ActiveState: "inactive", SubState: "dead" })), "nightly")).toEqual(["Service inactive (dead)"]);
      expect(messages(nightly(null), "nightly")).toEqual(["App project without a loaded unit: none of its services runs"]);
    });

    test("one of its services' memory peak is named, being none the main one", () => {
      const snapshot = nightly(anchor(), { ...UNITS, "nightly.purge": idle({ MemoryPeak: "250000000" }) });
      expect(messages(snapshot, "nightly")).toEqual([expect.stringContaining("Service purge: memory peak at")]);
    });
  });

  test("a project that serves no page says so; one with a public service or a publicDir does not", () => {
    const worker = { slug: "courier", services: { queue: { start: "/srv/sites/courier/app/queue", internal: true } } };
    const { sites } = buildSnapshot(
      raw([
        folder("courier", worker, { unit: unit() }),
        folder("pages", { ...worker, slug: "pages", publicDir: "public" }, { unit: unit() }),
        folder("tool", { slug: "tool", port: 3030, start: "bun run server.ts" }, { unit: unit() }),
      ], { ports: [3030] }),
    );
    expect(sites.map((site) => [site.slug, site.headless, site.port, site.services[0]?.kind])).toEqual([
      ["courier", true, null, "worker"],
      ["pages", false, null, "worker"],
      ["tool", false, 3030, "server"],
    ]);
  });
});

describe("processor", () => {
  const manifest = { slug: "tool", port: 3030, publicDir: "public", start: "bun run server.ts" };

  test("with no previous reading, the rate is absent and not zero", () => {
    const { sites } = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], { ports: [3030] }),
    );
    expect(sites[0]?.service?.cpuShare).toBeNull();
    // The running total, though, reads from the very first reading: it needs no delta.
    expect(sites[0]?.service?.cpuTotal).toBe(120_000);
  });

  test("one full core over the whole window makes a hundred per cent", () => {
    // Sixty seconds of wall clock, sixty seconds of CPU consumed.
    expect(computeCpuShare(120_000_000_000, 60_000_000_000, 60_000)).toBe(100);
    expect(computeCpuShare(90_000_000_000, 60_000_000_000, 60_000)).toBe(50);
  });

  test("a service with several threads goes past a hundred, and that is not capped", () => {
    expect(computeCpuShare(240_000_000_000, 60_000_000_000, 60_000)).toBe(300);
  });

  test("a counter that goes backwards is a restart, not negative consumption", () => {
    expect(computeCpuShare(10_000_000_000, 60_000_000_000, 60_000)).toBeNull();
  });

  test("a zero window or a missing counter yield nothing", () => {
    expect(computeCpuShare(120_000_000_000, 60_000_000_000, 0)).toBeNull();
    expect(computeCpuShare(120_000_000_000, undefined, 60_000)).toBeNull();
    expect(computeCpuShare(null, 60_000_000_000, 60_000)).toBeNull();
  });

  test("the rate is computed over the window between the two readings", () => {
    const { sites } = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], {
        ports: [3030],
        generated: 1_756_400_060_000,
        previous: { generated: 1_756_400_000_000, cpu: { tool: 90_000_000_000 } },
      }),
    );
    expect(sites[0]?.service?.cpuShare).toBe(50);
  });
});

describe("the machine's load", () => {
  const machine = {
    memoryTotal: null,
    memoryAvailable: null,
    diskTotal: null,
    diskFree: null,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    cores: 4,
  };

  test("an idle machine flags nothing", () => {
    expect(buildSnapshot(raw([], { machine })).discrepancies).toHaveLength(0);
  });

  test("a load beyond the number of cores is a warning", () => {
    const chargee = buildSnapshot(raw([], { machine: { ...machine, load5: 6.2 } }));
    expect(chargee.discrepancies[0]).toMatchObject({ slug: null, severity: "warning" });
    expect(chargee.discrepancies[0]?.message).toContain("6.2");
    expect(chargee.discrepancies[0]?.message).toContain("4 cores");
  });

  test("a load equal to the number of cores does not trigger yet", () => {
    expect(buildSnapshot(raw([], { machine: { ...machine, load5: 4 } })).discrepancies).toHaveLength(0);
  });

  test("with no known cores, no load is judged", () => {
    const without = { ...machine, load5: 99, cores: null };
    expect(buildSnapshot(raw([], { machine: without })).discrepancies).toHaveLength(0);
  });
});

describe("the machine's special cases", () => {
  test("the landing is neither a forgotten directory nor a fallen service", () => {
    expect(unitOf(LANDING_FOLDER)).toBe(LANDING_UNIT);
    const snapshot = buildSnapshot(
      raw([folder(LANDING_FOLDER, null, { unit: unit() })]),
    );
    expect(snapshot.sites[0]?.type).toBe("app");
    expect(snapshot.discrepancies).toHaveLength(0);
  });

  test("the landing takes the bare domain, not test-zone.invalid.test-zone.invalid", () => {
    expect(addressOf(LANDING_FOLDER, "test-zone.invalid")).toBe("test-zone.invalid");
    expect(addressOf("client", "test-zone.invalid")).toBe("client.test-zone.invalid");
    const snapshot = buildSnapshot(raw([folder(LANDING_FOLDER, null)]));
    expect(snapshot.sites[0]?.address).toBe("test-zone.invalid");
  });

  test("the code's link leads to the site's own domain once it serves one, the preview otherwise", () => {
    const manifest = { slug: "client", publicDir: "public" };
    expect(codeAddress("client", "test-zone.invalid", manifest)).toBe("client.test-zone.invalid");
    expect(codeAddress("client", "test-zone.invalid", { ...manifest, domain: { name: "client.example", active: false } })).toBe("client.test-zone.invalid");
    expect(codeAddress("client", "test-zone.invalid", { ...manifest, domain: { name: "client.example", active: true } })).toBe("client.example");
    expect(codeAddress("client", "test-zone.invalid", null)).toBe("client.test-zone.invalid");
  });

  test("any other directory with no manifest is flagged", () => {
    const snapshot = buildSnapshot(raw([folder("forgotten", null)]));
    expect(snapshot.sites[0]?.type).toBe("no-manifest");
    expect(snapshot.discrepancies[0]?.severity).toBe("warning");
  });

  test("an unreadable manifest is an error, not a site ignored", () => {
    const snapshot = buildSnapshot(
      raw([{ slug: "broken", manifest: "{ oops", unit: null, bytes: null, deployed: null }]),
    );
    expect(messages(snapshot, "broken")[0]).toContain("unreadable");
  });

  test("a Caddy fragment with no directory is flagged", () => {
    const snapshot = buildSnapshot(raw([], { blocks: { ghost: "" } }));
    expect(snapshot.discrepancies[0]).toMatchObject({ slug: "ghost", severity: "warning" });
  });

  test("the sites come out sorted, and the errors before the warnings", () => {
    const snapshot = buildSnapshot(
      raw([folder("zebra", null), folder("client", { slug: "client", publicDir: "public", lock: true })]),
    );
    expect(snapshot.sites.map((site) => site.slug)).toEqual(["client", "zebra"]);
    expect(snapshot.discrepancies.map((discrepancy) => discrepancy.severity)).toEqual(["error", "warning"]);
  });

  test("the secrets are named, never read", () => {
    const manifest = { slug: "tool", port: 3030, start: "bun run server.ts", secrets: ["TOOL_KEY"] };
    const { sites } = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], { ports: [3030] }),
    );
    expect(sites[0]?.secrets).toEqual(["TOOL_KEY"]);
  });

  test("a project whose values live in its store is named by its runtime variables, then its files; never its build secrets", () => {
    const short = { slug: "shop", port: 3030, start: "bun run server.ts", secrets: ["ADMIN_TOKEN", "STRIPE_SECRET_KEY"] };
    const long = {
      slug: "engine",
      port: 3040,
      start: "bun run server.ts",
      build: "bun run build",
      secrets: { runtime: ["POSTGRES_PASSWORD"], files: ["gcp.json"], build: ["CMS_TOKEN"] },
    };
    const blog = { slug: "blog", build: "bun run build", publicDir: "dist", secrets: { build: ["CMS_TOKEN"] } };
    const { sites } = buildSnapshot(
      raw([folder("shop", short, { unit: unit() }), folder("engine", long, { unit: unit() }), folder("blog", blog)], { ports: [3030, 3040] }),
    );
    const bySlug = Object.fromEntries(sites.map((site) => [site.slug, site.secrets]));
    expect(bySlug).toEqual({ blog: [], engine: ["POSTGRES_PASSWORD", "gcp.json"], shop: ["ADMIN_TOKEN", "STRIPE_SECRET_KEY"] });
  });

  test("declaredSecrets never throws on a manifest it cannot read", () => {
    expect(declaredSecrets({ slug: "odd", secrets: 42 } as unknown as Manifest)).toEqual([]);
    expect(declaredSecrets({ slug: "none" } as Manifest)).toEqual([]);
  });
});

describe("the portal's door", () => {
  const RESTRICTED = { slug: "kanban", port: 3045, start: "bun run server.ts", portal: true };
  /** What bin/cli/portal.ts writes into the block, and the collector reads back. */
  const WITH_DOOR = "forward_auth @portal_guard 127.0.0.1:3026 {\n\turi /verifier\n}";

  test("a protected site whose block carries the door has nothing to flag", () => {
    const snapshot = buildSnapshot(
      raw([folder("kanban", RESTRICTED), folder("portal", { slug: "portal", port: 3026, start: "bun run server.ts" }, { unit: unit() })], {
        blocks: { kanban: WITH_DOOR },
      }),
    );
    // A door from before the identity headers: closed all the same, nothing to
    // flag, and the snapshot says its site learns nobody.
    expect(snapshot.sites[0]?.portal).toEqual({ wanted: true, installed: true, identity: false, exemptions: [] });
    expect(messages(snapshot, "kanban").filter((m) => m.includes("portal"))).toEqual([]);
  });

  test("a block that hands the site who is in says so", () => {
    const current = generateFragment({ slug: "kanban", port: 3045, start: "bun run server.ts", portal: true })!;
    const snapshot = buildSnapshot(raw([folder("kanban", RESTRICTED)], { blocks: { kanban: current } }));
    expect(snapshot.sites[0]?.portal).toMatchObject({ installed: true, identity: true });
  });

  test("portal asked for and block with no door: the worst state, told as an error", () => {
    // The manifest says closed, Caddy serves in the clear, and the owner
    // believes their site is closed. That is exactly what this dashboard
    // exists to show.
    const snapshot = buildSnapshot(
      raw([folder("kanban", RESTRICTED)], { blocks: { kanban: "reverse_proxy 127.0.0.1:3045" } }),
    );
    expect(snapshot.sites[0]?.portal.installed).toBe(false);
    expect(messages(snapshot, "kanban")).toContainEqual(expect.stringContaining("anyone can open the site"));
    expect(snapshot.discrepancies.find((e) => e.slug === "kanban")?.severity).toBe("error");
  });

  test("a door installed that the manifest no longer asks for", () => {
    const snapshot = buildSnapshot(
      raw([folder("kanban", { ...RESTRICTED, portal: undefined })], { blocks: { kanban: WITH_DOOR } }),
    );
    expect(messages(snapshot, "kanban")).toContainEqual("Restricted on the server, public in sitesolide.json. Choose one in its Access section");
  });

  test("the exemptions are taken from the manifest, never guessed", () => {
    const snapshot = buildSnapshot(
      raw([folder("roster", { ...RESTRICTED, slug: "roster", portalExempt: ["/webhooks/*", 42] })], {
        blocks: { roster: WITH_DOOR },
      }),
    );
    expect(snapshot.sites[0]?.portal.exemptions).toEqual(["/webhooks/*"]);
  });

  test("the portal's service being stopped is said once, not per site", () => {
    const snapshot = buildSnapshot(
      raw([folder("kanban", RESTRICTED), folder("roster", { ...RESTRICTED, slug: "roster" })], {
        blocks: { kanban: WITH_DOOR, roster: WITH_DOOR },
      }),
    );
    expect(messages(snapshot, "portal")).toContainEqual(
      expect.stringContaining("2 restricted site(s)"),
    );
  });

  test("with no protected site, a stopped portal says nothing", () => {
    const snapshot = buildSnapshot(raw([folder("showcase", { slug: "showcase", publicDir: "public" })]));
    expect(messages(snapshot, "portal").filter((m) => m.includes("behind the portal"))).toEqual([]);
  });
});
