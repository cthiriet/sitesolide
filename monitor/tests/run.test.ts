import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { createMachine, type Machine } from "../src/machine";
import { bounded, run } from "../src/run";
import type { MonitorStatus } from "../src/status";
import { OPENSSL, drawAuthority, drawCertificate, fakeSystemctl } from "./fixtures";

/**
 * Whole runs of the monitor, one simulated minute apart, against real
 * servers on the loopback: an HTTPS server standing in for Caddy, with a
 * certificate drawn by a test authority for the zone, its wildcard and a
 * customer domain; and an HTTP server standing in for healthchecks.io and for
 * a Slack or Discord webhook. Only `systemctl` is replaced, by a script that
 * answers from files and records every call: the test checks the monitor
 * never asks systemd for anything but readings.
 *
 * What it proves is the promise of the README: one message when a site goes
 * down, one when it recovers, and nothing else however many runs pass; the
 * heartbeat on /fail only while the platform itself is down, never for one
 * project, which would silence the dead man's switch for as long as that
 * project stays broken.
 */

const ZONE = "test-zone.invalid";
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

describe.skipIf(OPENSSL === null)("the monitor, run after run", () => {
  const D = mkdtempSync(join(tmpdir(), "monitor-run-"));
  const systemd = join(D, "systemd");
  const sites = join(D, "srv", "sites");
  const state = join(D, "state");
  const domainsFile = join(D, "domaines.map");
  const meminfoFile = join(D, "meminfo");
  const backupFile = join(D, "last-run.json");

  /** What the fake Caddy answers per host; absent, 200. */
  const answers = new Map<string, number>();
  /** What the fake healthchecks.io and webhook received, in order. */
  const received: Array<{ path: string; body: string }> = [];
  let webhookStatus = 200;
  let caddy: ReturnType<typeof Bun.serve> | null = null;
  let receiver: ReturnType<typeof Bun.serve>;
  let ca = "";
  let cert = "";
  let key = "";
  let caddyPort = 0;
  let minute = 0;

  function startCaddy(): void {
    caddy = Bun.serve({
      port: caddyPort,
      hostname: "127.0.0.1",
      tls: { cert, key },
      fetch: (req) => new Response("served", { status: answers.get(req.headers.get("host") ?? "") ?? 200 }),
    });
    caddyPort = caddy.port!;
  }

  function setCaddyUnit(active: string, sub: string, restarts: number, result = "success"): void {
    writeFileSync(
      join(systemd, "caddy"),
      `LoadState=loaded\nActiveState=${active}\nSubState=${sub}\nResult=${result}\nNRestarts=${restarts}\n`,
    );
  }

  function setUnits(lines: string[]): void {
    writeFileSync(join(systemd, "units"), `${lines.join("\n")}\n`);
  }

  function config(overrides: Partial<Config> = {}): Config {
    return {
      zone: ZONE,
      sitesDir: sites,
      domainsFile,
      stateDir: state,
      backupFile,
      diskPaths: [D],
      probe: { address: "127.0.0.1", port: caddyPort, ca, timeoutMs: 2000 },
      concurrency: 4,
      probeBudgetMs: 10_000,
      heartbeatUrl: `http://127.0.0.1:${receiver.port}/ping/5a7f`,
      webhookUrl: `http://127.0.0.1:${receiver.port}/hooks/sample`,
      webhookFormat: "json",
      problems: [],
      ...overrides,
    };
  }

  /**
   * One run, one simulated minute later than the previous one. `replaced`
   * stands in for some of the machine's readings, `clock` for the time the
   * probes' budget is measured against.
   */
  async function pass(
    overrides: Partial<Config> = {},
    replaced: Partial<Machine> = {},
    clock: () => number = Date.now,
  ): Promise<{ status: MonitorStatus; heartbeat: string[]; heartbeatBody: string[]; webhook: string[]; journal: string[] }> {
    received.length = 0;
    const journal: string[] = [];
    const machine = {
      ...createMachine(config(overrides), { systemctl: join(systemd, "systemctl"), meminfoFile }),
      log: (line: string) => journal.push(line),
      ...replaced,
    };
    const outcome = await run(config(overrides), machine, T0 + minute++ * MINUTE, clock);
    const written = JSON.parse(readFileSync(join(state, "status.json"), "utf8")) as MonitorStatus;
    expect(written).toEqual(outcome.status);
    return {
      status: outcome.status,
      heartbeat: received.filter((r) => r.path.startsWith("/ping/")).map((r) => r.path),
      heartbeatBody: received.filter((r) => r.path.startsWith("/ping/")).map((r) => r.body),
      webhook: received.filter((r) => r.path.startsWith("/hooks/")).map((r) => (JSON.parse(r.body) as { text: string }).text),
      journal,
    };
  }

  beforeAll(() => {
    // The test authority, a certificate for the zone, its wildcard and a
    // customer domain, valid sixty days.
    drawAuthority(D);
    drawCertificate(D, "site", [ZONE, `*.${ZONE}`, "sample-agency.example"], 60);
    ca = readFileSync(join(D, "ca.pem"), "utf8");
    cert = readFileSync(join(D, "site.pem"), "utf8");
    key = readFileSync(join(D, "site.key"), "utf8");

    // The served directories, the domain table, the memory.
    for (const folder of ["cms", "shop", ZONE]) mkdirSync(join(sites, folder, "public"), { recursive: true });
    writeFileSync(domainsFile, "# generated\n\tsample-agency.example cms\n");
    writeFileSync(meminfoFile, "MemTotal:        8000000 kB\nMemAvailable:    4000000 kB\n");
    mkdirSync(state, { recursive: true });

    // systemctl, answering from files and recording each call.
    fakeSystemctl(systemd);

    receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        received.push({ path, body: await req.text() });
        return path.startsWith("/hooks/") ? new Response(null, { status: webhookStatus }) : new Response("OK");
      },
    });
    startCaddy();
  });

  afterAll(() => {
    caddy?.stop(true);
    receiver.stop(true);
    rmSync(D, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(join(state, "state.json"), { force: true });
    rmSync(join(systemd, "calls"), { force: true });
    rmSync(join(systemd, "broken"), { force: true });
    rmSync(backupFile, { force: true });
    answers.clear();
    webhookStatus = 200;
    minute = 0;
    if (caddy === null) startCaddy();
    setCaddyUnit("active", "running", 0);
    setUnits([
      "caddy.service loaded active running Caddy",
      "cms.service loaded active running cms",
      "sitesolide-landing.service loaded active running landing",
      "sitesolide-collector.service loaded inactive dead Machine state snapshot",
    ]);
  });

  test("a project's site goes down and recovers: one message each way, the heartbeat kept armed, the site in its body", async () => {
    const quiet = await pass();
    expect(quiet.heartbeat).toEqual(["/ping/5a7f"]);
    expect(quiet.webhook).toEqual([]);
    expect(quiet.status).toMatchObject({ down: [], heartbeat: "ok", webhook: "idle", undelivered: 0 });
    // Caddy, its restarts, five hosts, three certificates, two units, the
    // collector, the disk, the memory and the monitor itself.
    expect(quiet.status.checks).toBe(16);

    answers.set(`shop.${ZONE}`, 502);
    const first = await pass();
    expect(first.webhook).toEqual([]);
    expect(first.heartbeat).toEqual(["/ping/5a7f"]);

    const second = await pass();
    expect(second.heartbeat).toEqual(["/ping/5a7f"]);
    expect(second.heartbeatBody).toEqual([
      `ok for the platform: 1 of 16 checks down, none of them platform-wide\nDOWN https://shop.${ZONE}/ answered 502`,
    ]);
    expect(second.webhook).toEqual([
      `sitesolide monitor, ${ZONE}: 1 down\nDOWN https://shop.${ZONE}/ answered 502 (since 2026-10-04 12:01 UTC)`,
    ]);
    expect(second.status.down).toEqual([
      {
        id: `site:shop.${ZONE}`,
        kind: "site",
        label: `shop.${ZONE}`,
        severity: "critical",
        slug: "shop",
        summary: `https://shop.${ZONE}/ answered 502`,
        since: T0 + MINUTE,
      },
    ]);

    for (let i = 0; i < 5; i++) {
      const still = await pass();
      expect(still.webhook).toEqual([]);
      expect(still.heartbeat).toEqual(["/ping/5a7f"]);
    }

    answers.delete(`shop.${ZONE}`);
    const answering = await pass();
    expect(answering.webhook).toEqual([]);
    const recovered = await pass();
    expect(recovered.webhook).toEqual([
      `sitesolide monitor, ${ZONE}: 1 recovered\nRECOVERED https://shop.${ZONE}/ answered 200 (after 8 min)`,
    ]);
    expect(recovered.heartbeat).toEqual(["/ping/5a7f"]);
    expect(recovered.status.down).toEqual([]);

    // Only readings were asked of systemd, never a change.
    const calls = readFileSync(join(systemd, "calls"), "utf8").trim().split("\n");
    expect(calls.every((call) => call.startsWith("show caddy.service ") || call.startsWith("list-units "))).toBe(true);
  });

  test("the bare domain down is the platform down: the heartbeat on /fail until it recovers", async () => {
    await pass();
    answers.set(ZONE, 502);
    expect((await pass()).heartbeat).toEqual(["/ping/5a7f"]);
    const down = await pass();
    expect(down.heartbeat).toEqual(["/ping/5a7f/fail"]);
    expect(down.heartbeatBody).toEqual([`down: 1 of 16 checks\nDOWN https://${ZONE}/ answered 502`]);
    answers.delete(ZONE);
    expect((await pass()).heartbeat).toEqual(["/ping/5a7f/fail"]);
    expect((await pass()).heartbeat).toEqual(["/ping/5a7f"]);
  });

  /**
   * A Caddy slower than the probes' budget allows, on a clock the probes
   * themselves advance: each host takes 2.4 s of a 2.5 s timeout, five hosts
   * against a budget of 10 s. A probe started with less than its full timeout
   * left would time out and be judged a failure, the same host at the tail
   * every pass, and go down for nothing.
   */
  function slowCaddy(order: string[]): { replaced: Partial<Machine>; clock: () => number; overrides: Partial<Config> } {
    let now = 0;
    const latency = 2400;
    return {
      overrides: { concurrency: 1, probeBudgetMs: 10_000, probe: { address: "127.0.0.1", port: caddyPort, ca, timeoutMs: 2500 } },
      clock: () => now,
      replaced: {
        async probe(host, timeoutMs) {
          order.push(host);
          if (timeoutMs < latency) {
            now += timeoutMs;
            return { error: "TimeoutError" };
          }
          now += latency;
          return { status: answers.get(host) ?? 200 };
        },
        async certificate() {
          return { notAfter: T0 + 60 * 24 * 60 * MINUTE };
        },
      },
    };
  }

  test("out of time: what does not fit is not checked rather than failed, and the next pass starts with it", async () => {
    const order: string[] = [];
    const slow = slowCaddy(order);
    const hosts = [ZONE, `www.${ZONE}`, `cms.${ZONE}`, `shop.${ZONE}`, "sample-agency.example"];

    const probed: string[][] = [];
    for (let i = 0; i < 4; i++) {
      order.length = 0;
      const outcome = await pass(slow.overrides, slow.replaced, slow.clock);
      probed.push([...order]);
      expect(outcome.status.down).toEqual([]);
      expect(outcome.status.unchecked).toBe(1);
      expect(outcome.journal.at(-1)).toContain(" 0 down, 0 failing, 1 not checked;");
    }
    // Four of five each pass, the one left out first at the next.
    expect(probed[0]).toEqual(hosts.slice(0, 4));
    expect(probed[1]).toEqual(["sample-agency.example", ...hosts.slice(0, 3)]);
    expect(probed[2]).toEqual([`shop.${ZONE}`, ZONE, `www.${ZONE}`, `cms.${ZONE}`]);
    expect(probed[3]).toEqual(["sample-agency.example", ZONE, `www.${ZONE}`, `cms.${ZONE}`]);
  });

  test("out of time: a host that failed is probed first, before those that answered", async () => {
    const order: string[] = [];
    const slow = slowCaddy(order);
    answers.set(`shop.${ZONE}`, 502);
    await pass(slow.overrides, slow.replaced, slow.clock);
    order.length = 0;
    const second = await pass(slow.overrides, slow.replaced, slow.clock);
    expect(order[0]).toBe(`shop.${ZONE}`);
    expect(second.status.down.map((problem) => problem.id)).toEqual([`site:shop.${ZONE}`]);
  });

  test("Caddy stopped: one alert for Caddy, none per site; back with a restart counted, a warning", async () => {
    await pass();
    caddy!.stop(true);
    caddy = null;
    setCaddyUnit("inactive", "dead", 0);
    await pass();
    const down = await pass();
    expect(down.webhook).toEqual([
      `sitesolide monitor, ${ZONE}: 1 down\nDOWN Caddy is inactive (dead), result success (since 2026-10-04 12:01 UTC)`,
    ]);
    expect(down.status.down.map((problem) => problem.id)).toEqual(["caddy"]);

    // systemd brought it back on its own: the counter says so.
    startCaddy();
    setCaddyUnit("active", "running", 1);
    const back = await pass();
    expect(back.webhook).toEqual([]);
    const recovered = await pass();
    expect(recovered.webhook).toHaveLength(1);
    expect(recovered.webhook[0]).toContain("1 down, 1 recovered");
    expect(recovered.webhook[0]).toContain("WARNING Caddy was restarted by systemd on its own 1 min ago (NRestarts 1)");
    expect(recovered.webhook[0]).toContain("RECOVERED Caddy is active (running)");
    // A warning does not hold the heartbeat on /fail.
    expect(recovered.heartbeat).toEqual(["/ping/5a7f"]);
  });

  test("a webhook that refuses keeps its notices for the next run, in one message", async () => {
    await pass();
    setUnits(["caddy.service loaded active running Caddy", "cms.service loaded failed failed cms"]);
    await pass();
    webhookStatus = 500;
    const refused = await pass();
    expect(refused.webhook).toHaveLength(1);
    expect(refused.status).toMatchObject({ webhook: "failed", undelivered: 1 });

    // Meanwhile the landing's unit fails too: the next message carries both.
    setUnits(["caddy.service loaded active running Caddy", "cms.service loaded failed failed cms", "sitesolide-landing.service loaded failed failed landing"]);
    webhookStatus = 200;
    const kept = await pass();
    expect(kept.webhook).toHaveLength(1);
    expect(kept.webhook[0]).toContain("cms.service is failed (failed)");
    expect(kept.status).toMatchObject({ webhook: "ok", undelivered: 0 });

    const next = await pass();
    expect(next.webhook).toHaveLength(1);
    expect(next.webhook[0]).toContain("sitesolide-landing.service is failed (failed)");
    expect(next.webhook[0]).not.toContain("cms.service");
  });

  test("a storm too long for one message: what did not fit arrives in the next, nothing lost", async () => {
    const storm = Array.from({ length: 40 }, (_, index) => `storm-${String(index).padStart(2, "0")}`);
    for (const folder of storm) {
      mkdirSync(join(sites, folder), { recursive: true });
      answers.set(`${folder}.${ZONE}`, 502);
    }
    try {
      await pass();
      const first = await pass();
      expect(first.webhook).toHaveLength(1);
      expect(first.webhook[0]).toMatch(/\.\.\. and \d+ more in the next message$/);
      expect(first.status.undelivered).toBeGreaterThan(0);
      expect(first.journal).toContain(`monitor: ${first.status.undelivered} notice(s) did not fit the message, kept for the next run`);

      const second = await pass();
      expect(second.webhook).toHaveLength(1);
      expect(second.status.undelivered).toBe(0);
      const delivered = [...first.webhook, ...second.webhook].join("\n");
      for (const folder of storm) expect(delivered).toContain(`DOWN https://${folder}.${ZONE}/ answered 502`);

      expect((await pass()).webhook).toEqual([]);
    } finally {
      for (const folder of storm) rmSync(join(sites, folder), { recursive: true, force: true });
    }
  });

  test("systemctl gone dark: the units keep their state, the monitor says it is half blind", async () => {
    setUnits(["caddy.service loaded active running Caddy", "cms.service loaded failed failed cms"]);
    await pass();
    const down = await pass();
    expect(down.status.down.map((problem) => problem.id)).toEqual(["unit:cms.service"]);

    writeFileSync(join(systemd, "broken"), "");
    await pass();
    const blind = await pass();
    // No "cleared" for the unit, no flood of recoveries: one warning about the monitor.
    expect(blind.webhook).toHaveLength(1);
    expect(blind.webhook[0]).toContain("WARNING The monitor could not run fully: systemctl show: Failed to connect to bus");
    expect(blind.status.down.map((problem) => problem.id)).toEqual(["unit:cms.service", "monitor"]);
  });

  test("a backup status, when there is one, is judged; with no alerting set, the journal alone hears", async () => {
    writeFileSync(
      backupFile,
      JSON.stringify({ startedAt: new Date(T0 - 2 * MINUTE).toISOString(), finishedAt: new Date(T0 - MINUTE).toISOString(), ok: false, projects: { shop: { ok: false, snapshot: null, error: "exit 1" } } }),
    );
    const silent = { heartbeatUrl: null, webhookUrl: null };
    const first = await pass(silent);
    expect(first.status).toMatchObject({ heartbeat: "unconfigured", webhook: "unconfigured" });
    const second = await pass(silent);
    expect(received).toEqual([]);
    expect(second.status.down.map((problem) => [problem.id, problem.summary])).toEqual([
      ["backup", "The last backup run failed for shop, 2 min ago"],
    ]);
    expect(second.journal).toContain("DOWN backup: The last backup run failed for shop, 2 min ago");
    expect(second.journal.at(-1)).toBe("17 checks, 1 down, 0 failing; heartbeat unconfigured, webhook unconfigured");
    const kept = JSON.parse(readFileSync(join(state, "state.json"), "utf8")) as { outbox: unknown[] };
    expect(kept.outbox).toEqual([]);
    expect(existsSync(join(state, "state.json.tmp"))).toBe(false);
  });
});

describe("the probes' budget", () => {
  test("an item starts only if its whole timeout fits in what is left; the rest is skipped", async () => {
    let now = 0;
    const started: Array<[string, number]> = [];
    const results = await bounded(
      ["a", "b", "c", "d"],
      1,
      10,
      () => now,
      4,
      async (item) => {
        started.push([item, 10 - now]);
        now += 3;
        return `probed ${item}`;
      },
      (item) => `skipped ${item}`,
    );
    // d would have had 1 of its 4: it is not started at all.
    expect(started).toEqual([["a", 10], ["b", 7], ["c", 4]]);
    expect(results).toEqual(["probed a", "probed b", "probed c", "skipped d"]);
  });
});
