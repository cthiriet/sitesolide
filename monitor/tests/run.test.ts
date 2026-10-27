import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { createMachine, type Machine } from "../src/machine";
import { bounded, run } from "../src/run";
import type { MonitorStatus } from "../src/status";
import { OPENSSL, drawAuthority, drawCertificate, fakeSystemctl } from "./fixtures";
import { loopbackRule } from "../../bin/cli/loopback";

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
const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
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
  /** The machine's service units, none until a test lays one, and the loopback rule laid, none either. */
  const unitsFolder = join(D, "units");
  const loopbackFile = join(D, "loopback.nft");

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
      tlsZoneFile: join(D, "tls-zone.caddy"),
      stateDir: state,
      backupFile,
      unitsFolder,
      loopbackFile,
      accountsFile: join(D, "passwd"),
      procNetTcp: [join(D, "tcp"), join(D, "tcp6")],
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
    // The kernel's sockets, none listening, and the accounts that would name them.
    writeFileSync(join(D, "tcp"), TCP_HEADER);
    writeFileSync(join(D, "passwd"), "root:x:0:0::/root:/bin/sh\nsite-old:x:1600:1600::/nonexistent:/usr/sbin/nologin\n");
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
    // collector, the disk, the memory, the projects' units' ports, what
    // listens on the second block and the monitor itself.
    expect(quiet.status.checks).toBe(18);

    answers.set(`shop.${ZONE}`, 502);
    const first = await pass();
    expect(first.webhook).toEqual([]);
    expect(first.heartbeat).toEqual(["/ping/5a7f"]);

    const second = await pass();
    expect(second.heartbeat).toEqual(["/ping/5a7f"]);
    expect(second.heartbeatBody).toEqual([
      `ok for the platform: 1 of 18 checks down, none of them platform-wide\nDOWN https://shop.${ZONE}/ answered 502`,
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
    expect(calls.every((call) => call.startsWith("show caddy.service ") || call.startsWith("show -p Id -p ExecMainStatus -- ") || call.startsWith("list-units "))).toBe(true);
  });

  test("behind a tunnel: its connector checked, down once the edge is lost, a message each way", async () => {
    let ready: { status: number } | { error: string } = { status: 200 };
    const tunnel = { tunnelReady: async () => ready };
    setUnits([
      "caddy.service loaded active running Caddy",
      "cms.service loaded active running cms",
      "sitesolide-landing.service loaded active running landing",
      "sitesolide-collector.service loaded inactive dead Machine state snapshot",
      "sitesolide-tunnel.service loaded active running Cloudflare Tunnel",
    ]);
    const quiet = await pass({}, tunnel);
    expect(quiet.status.checks).toBe(19);
    expect(quiet.status.down).toEqual([]);

    ready = { status: 503 };
    await pass({}, tunnel);
    const second = await pass({}, tunnel);
    // Every site lost to the Internet at once: the heartbeat fails, the one
    // alert that reaches someone when the machine can still send it.
    expect(second.heartbeat).toEqual(["/ping/5a7f/fail"]);
    expect(second.webhook).toEqual([
      `sitesolide monitor, ${ZONE}: 1 down\nDOWN The tunnel's connector runs and is not connected to Cloudflare's edge (503) (since 2026-10-04 12:01 UTC)`,
    ]);
    ready = { status: 200 };
    await pass({}, tunnel);
    const recovered = await pass({}, tunnel);
    expect(recovered.webhook[0]).toStartWith(`sitesolide monitor, ${ZONE}: 1 recovered\nRECOVERED The tunnel is connected to Cloudflare's edge`);
  });

  test("a machine served directly reads no tunnel", async () => {
    let asked = 0;
    const quiet = await pass({}, { tunnelReady: async () => (asked++, { status: 200 }) });
    expect(asked).toBe(0);
    expect(quiet.status.checks).toBe(18);
  });

  test("manual DNS: the certificate of each name of the zone read under its own name, and no wildcard", async () => {
    // The ids of the certificate checks the pass left in the monitor's memory.
    const certificates = (): string[] =>
      Object.keys((JSON.parse(readFileSync(join(state, "state.json"), "utf8")) as { checks: Record<string, unknown> }).checks)
        .filter((id) => id.startsWith("certificate:"))
        .sort();
    await pass();
    expect(certificates()).toEqual([`certificate:*.${ZONE}`, "certificate:sample-agency.example", `certificate:${ZONE}`].sort());

    rmSync(join(state, "state.json"), { force: true });
    const onDemand = await pass({}, { tlsPolicy: () => ({ value: "# manual DNS\ntls {\n\ton_demand\n}\n" }) });
    expect(certificates()).toEqual(
      [`certificate:${ZONE}`, `certificate:www.${ZONE}`, `certificate:cms.${ZONE}`, `certificate:shop.${ZONE}`, "certificate:sample-agency.example"].sort(),
    );
    expect(onDemand.status.down).toEqual([]);
  });

  test("an unreadable policy is said, and the wildcard read once as with a DNS provider", async () => {
    await pass({}, { tlsPolicy: () => ({ error: "/etc/caddy/tls-zone.caddy: EACCES" }) });
    const checks = (JSON.parse(readFileSync(join(state, "state.json"), "utf8")) as { checks: Record<string, unknown> }).checks;
    expect(Object.keys(checks)).toContain(`certificate:*.${ZONE}`);
    expect(JSON.stringify(checks.monitor)).toContain("/etc/caddy/tls-zone.caddy: EACCES");
  });

  test("the bare domain down is the platform down: the heartbeat on /fail until it recovers", async () => {
    await pass();
    answers.set(ZONE, 502);
    expect((await pass()).heartbeat).toEqual(["/ping/5a7f"]);
    const down = await pass();
    expect(down.heartbeat).toEqual(["/ping/5a7f/fail"]);
    expect(down.heartbeatBody).toEqual([`down: 1 of 18 checks\nDOWN https://${ZONE}/ answered 502`]);
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

  test("a scheduled service: at rest between runs, a failed run a warning, a stopped timer critical", async () => {
    const units = (service: string, timer: string) => [
      "caddy.service loaded active running Caddy",
      `cms.report.service loaded ${service} Project cms, service report`,
      "cms.service loaded active running cms",
      "sitesolide-landing.service loaded active running landing",
      "sitesolide-collector.service loaded inactive dead Machine state snapshot",
      `cms.report.timer loaded ${timer} Project cms, schedule of service report`,
      "sitesolide-collector.timer loaded active waiting Machine state snapshot, every minute",
      "sitesolide-monitor.timer loaded active waiting Monitor, every minute",
    ];

    // At rest, then running: nothing to say. The service and its timer are
    // two checks more, the platform's timers none.
    setUnits(units("inactive dead", "active waiting"));
    const rest = await pass();
    expect(rest.status).toMatchObject({ checks: 20, down: [] });
    setUnits(units("active running", "active running"));
    expect((await pass()).webhook).toEqual([]);

    // A failed run, seen twice: one warning, the heartbeat kept armed.
    setUnits(units("failed failed", "active waiting"));
    expect((await pass()).webhook).toEqual([]);
    const failed = await pass();
    const summary = "cms.report.service is failed (failed): its last scheduled run failed, see sitesolide logs";
    expect(failed.webhook).toEqual([`sitesolide monitor, ${ZONE}: 1 down\nWARNING ${summary} (since 2026-10-04 12:02 UTC)`]);
    expect(failed.heartbeat).toEqual(["/ping/5a7f"]);
    expect(failed.status.down).toEqual([
      { id: "unit:cms.report.service", kind: "unit", label: "cms.report.service", severity: "warning", slug: "cms", summary, since: T0 + 2 * MINUTE },
    ]);

    // The next run succeeds: recovered, once.
    setUnits(units("inactive dead", "active waiting"));
    expect((await pass()).webhook).toEqual([]);
    expect((await pass()).webhook).toEqual([
      `sitesolide monitor, ${ZONE}: 1 recovered\nRECOVERED cms.report.service is inactive (dead), between two scheduled runs (after 3 min)`,
    ]);

    // The timer stopped: nothing will run again, critical, yet one project's.
    setUnits(units("inactive dead", "inactive dead"));
    await pass();
    const stopped = await pass();
    expect(stopped.webhook).toEqual([
      `sitesolide monitor, ${ZONE}: 1 down\nDOWN cms.report.timer is inactive (dead): the schedule stopped, ` +
        "nothing starts cms.report.service any more (since 2026-10-04 12:06 UTC)",
    ]);
    expect(stopped.heartbeat).toEqual(["/ping/5a7f"]);
    expect(stopped.status.down.map((problem) => [problem.id, problem.severity])).toEqual([["unit:cms.report.timer", "critical"]]);

    // Timers are read in the same listing as the services, and only read.
    const calls = readFileSync(join(systemd, "calls"), "utf8").trim().split("\n");
    expect(calls.filter((call) => call.startsWith("list-units "))).toContain(
      "list-units --type=service,timer --all --plain --no-legend --no-pager",
    );
  });

  test("a project's service that could not load its secret files is said so, its exit status read for it alone", async () => {
    // systemd keeps restarting a server that fails with 243 before its program
    // runs: activating (auto-restart), and a misleading "Protocol error" in
    // its journal.
    setUnits(["caddy.service loaded active running Caddy", "cms.service loaded activating auto-restart cms", "sitesolide-landing.service loaded active running landing"]);
    writeFileSync(join(systemd, "statuses"), "Id=cms.service\nExecMainStatus=243\n");
    rmSync(join(systemd, "calls"), { force: true });
    await pass();
    const down = await pass();
    const summary = "cms.service could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh cms lays the folder again";
    expect(down.status.down.map((problem) => [problem.id, problem.summary])).toEqual([["unit:cms.service", summary]]);
    const calls = readFileSync(join(systemd, "calls"), "utf8").trim().split("\n");
    expect(calls.filter((call) => call.startsWith("show -p"))).toEqual(["show -p Id -p ExecMainStatus -- cms.service", "show -p Id -p ExecMainStatus -- cms.service"]);
    // Healthy again: nothing more is asked of systemd than before.
    setUnits(["caddy.service loaded active running Caddy", "cms.service loaded active running cms", "sitesolide-landing.service loaded active running landing"]);
    rmSync(join(systemd, "statuses"), { force: true });
    rmSync(join(systemd, "calls"), { force: true });
    await pass();
    expect(readFileSync(join(systemd, "calls"), "utf8").trim().split("\n").some((call) => call.startsWith("show -p"))).toBe(false);
  });

  test("a project unit that may listen on another's port, once the second block is open: critical, read as systemd has it", async () => {
    mkdirSync(unitsFolder, { recursive: true });
    writeFileSync(join(unitsFolder, "old.service"), "[Service]\nUser=site-old\n");
    // A masked unit and a template are not read.
    symlinkSync("/dev/null", join(unitsFolder, "masked.service"));
    writeFileSync(join(unitsFolder, "sitesolide-installer@.service"), "[Service]\nUser=root\n");
    writeFileSync(join(systemd, "statuses"), "Id=old.service\nUser=site-old\nSocketBindDeny=2019\nSocketBindDeny=3000-3099\nSocketBindDeny=3128-3129\nNeedDaemonReload=no\n");
    writeFileSync(loopbackFile, loopbackRule(997, "close", 1022));
    rmSync(join(systemd, "calls"), { force: true });
    try {
      await pass();
      const down = await pass();
      expect(down.status.down.map((problem) => [problem.id, problem.severity])).toEqual([["binds", "critical"]]);
      expect(down.webhook[0]).toContain("old.service may listen on the services' ports");
      const calls = readFileSync(join(systemd, "calls"), "utf8").trim().split("\n");
      expect(calls).toContain("show -p Id -p User -p SocketBindDeny -p NeedDaemonReload -- old.service");
      // The rule in observe, or none: the second block's line is not asked for yet.
      writeFileSync(loopbackFile, loopbackRule(997, "observe", 1022));
      await pass();
      expect((await pass()).status.down).toEqual([]);
    } finally {
      rmSync(unitsFolder, { recursive: true, force: true });
      rmSync(loopbackFile, { force: true });
      rmSync(join(systemd, "statuses"), { force: true });
    }
  });

  test("a port of the second block held by an account no manifest gives it, once the block is open: critical, and the heartbeat fails", async () => {
    // A scheduled run started under an earlier unit, holding 21000 through every reload.
    writeFileSync(join(D, "tcp"), `${TCP_HEADER}   0: 0100007F:5208 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1600        0 20311 1 0000000000000000 100 0 0 10 0\n`);
    writeFileSync(loopbackFile, loopbackRule(997, "close", 1022));
    try {
      await pass();
      const down = await pass();
      expect(down.status.down.map((problem) => [problem.id, problem.severity])).toEqual([["listeners", "critical"]]);
      expect(down.webhook[0]).toContain("Port 21000 (site-old) listened on in the second block");
      // The one channel a machine without a webhook has pages too.
      expect(down.heartbeat).toEqual(["/ping/5a7f/fail"]);
      // Before the block opens, a warning, and the heartbeat stays armed.
      rmSync(loopbackFile, { force: true });
      expect((await pass()).heartbeat).toEqual(["/ping/5a7f"]);
    } finally {
      writeFileSync(join(D, "tcp"), TCP_HEADER);
      rmSync(loopbackFile, { force: true });
    }
  });

  test("a systemctl that fails, or answers for fewer units than there are files, is no reading: the monitor says it is half blind", async () => {
    mkdirSync(unitsFolder, { recursive: true });
    writeFileSync(join(unitsFolder, "old.service"), "[Service]\nUser=site-old\n");
    writeFileSync(join(unitsFolder, "new.service"), "[Service]\nUser=site-new\n");
    // The fake systemctl answers one unit of the two.
    writeFileSync(join(systemd, "statuses"), "Id=old.service\nUser=site-old\nSocketBindDeny=2019\nNeedDaemonReload=no\n");
    writeFileSync(loopbackFile, loopbackRule(997, "close", 1022));
    try {
      await pass();
      const blind = await pass();
      expect(blind.status.down.map((problem) => problem.id)).toEqual(["monitor"]);
      expect(blind.webhook[0]).toContain("systemctl show of the units: 1 unit(s) read of 2");
    } finally {
      rmSync(unitsFolder, { recursive: true, force: true });
      rmSync(loopbackFile, { force: true });
      rmSync(join(systemd, "statuses"), { force: true });
    }
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
    expect(second.journal.at(-1)).toBe("19 checks, 1 down, 0 failing; heartbeat unconfigured, webhook unconfigured");
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
