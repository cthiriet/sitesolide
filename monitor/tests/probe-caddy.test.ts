import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeCertificate, judgeProbe } from "../src/checks";
import type { Config } from "../src/config";
import { createMachine, type Machine } from "../src/machine";
import { run } from "../src/run";
import { OPENSSL, drawAuthority, drawCertificate, fakeSystemctl, freePort } from "./fixtures";

/**
 * The probes in front of a real Caddy, on the workstation.
 *
 * Caddy runs with `admin off`, on free high ports, with certificates drawn by
 * a test authority: the bare domain valid sixty days, the wildcard four days,
 * so that its warning fires, and a customer domain that serves a certificate
 * for another name. It is stopped by its PID.
 *
 * NEVER `caddy stop`, `caddy start` or `caddy reload`: they address the
 * administration API of the instance in service, whatever `--config` says, and
 * that is how production came to a stop on 11 August 2026. See the Production
 * section of CLAUDE.md.
 *
 * The test skips itself with no `caddy` or no `openssl` on the workstation.
 */

const CADDY = Bun.which("caddy");
const ZONE = "test-zone.invalid";
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(CADDY === null || OPENSSL === null)("the probes in front of a real Caddy", () => {
  const D = mkdtempSync(join(tmpdir(), "monitor-caddy-"));
  const httpsPort = freePort();
  const httpPort = freePort();
  /** Nothing listens there: the shop's service is down. */
  const deadPort = freePort();
  let caddy: ReturnType<typeof Bun.spawn> | null = null;
  let ca = "";

  function config(overrides: Partial<Config> = {}): Config {
    return {
      zone: ZONE,
      sitesDir: join(D, "srv", "sites"),
      domainsFile: join(D, "domaines.map"),
      stateDir: join(D, "state"),
      backupFile: join(D, "last-run.json"),
      diskPaths: [D],
      probe: { address: "127.0.0.1", port: httpsPort, ca, timeoutMs: 3000 },
      concurrency: 4,
      probeBudgetMs: 15_000,
      heartbeatUrl: null,
      webhookUrl: null,
      webhookFormat: "json",
      problems: [],
      ...overrides,
    };
  }

  async function waitForCaddy(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      try {
        const socket = await Bun.connect({ hostname: "127.0.0.1", port: httpsPort, socket: { data() {} } });
        socket.end();
        return;
      } catch {
        await Bun.sleep(25);
      }
    }
    throw new Error("the test Caddy does not answer");
  }

  beforeAll(async () => {
    drawAuthority(D);
    drawCertificate(D, "apex", [ZONE, `www.${ZONE}`], 60);
    drawCertificate(D, "wildcard", [`*.${ZONE}`], 4);
    drawCertificate(D, "wrong", ["other-customer.example"], 60);
    ca = readFileSync(join(D, "ca.pem"), "utf8");

    writeFileSync(
      join(D, "Caddyfile"),
      [
        "{",
        "\tadmin off",
        `\thttp_port ${httpPort}`,
        `\thttps_port ${httpsPort}`,
        "\tauto_https disable_redirects",
        `\tstorage file_system ${join(D, "storage")}`,
        "}",
        `${ZONE}, www.${ZONE} {`,
        `\ttls ${join(D, "apex.pem")} ${join(D, "apex.key")}`,
        '\trespond "landing" 200',
        "}",
        `*.${ZONE} {`,
        `\ttls ${join(D, "wildcard.pem")} ${join(D, "wildcard.key")}`,
        `\t@shop host shop.${ZONE}`,
        "\thandle @shop {",
        `\t\treverse_proxy 127.0.0.1:${deadPort}`,
        "\t}",
        `\t@locked host locked.${ZONE}`,
        "\thandle @locked {",
        '\t\trespond "Locked preview" 401',
        "\t}",
        "\thandle {",
        '\t\trespond "preview" 200',
        "\t}",
        "}",
        "sample-agency.example {",
        `\ttls ${join(D, "wrong.pem")} ${join(D, "wrong.key")}`,
        '\trespond "customer" 200',
        "}",
        "",
      ].join("\n"),
    );

    for (const folder of ["cms", "shop", "locked"]) mkdirSync(join(D, "srv", "sites", folder), { recursive: true });
    writeFileSync(join(D, "domaines.map"), "\tsample-agency.example cms\n");
    mkdirSync(join(D, "state"), { recursive: true });
    const systemd = join(D, "systemd");
    fakeSystemctl(systemd);
    writeFileSync(join(systemd, "caddy"), "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nNRestarts=0\n");
    writeFileSync(join(systemd, "units"), "caddy.service loaded active running Caddy\n");

    caddy = Bun.spawn([CADDY!, "run", "--config", join(D, "Caddyfile"), "--adapter", "caddyfile"], {
      env: { ...process.env, HOME: D, XDG_DATA_HOME: join(D, "data"), XDG_CONFIG_HOME: join(D, "config") },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForCaddy();
  });

  afterAll(async () => {
    // By its PID, never through the administration API, which is off anyway.
    caddy?.kill("SIGTERM");
    await caddy?.exited;
    rmSync(D, { recursive: true, force: true });
  });

  function machine(): Machine {
    return createMachine(config(), { systemctl: join(D, "systemd", "systemctl"), meminfoFile: join(D, "no-meminfo") });
  }

  test("a static preview, a locked preview and the landing answer", async () => {
    const m = machine();
    for (const host of [ZONE, `www.${ZONE}`, `cms.${ZONE}`]) {
      expect(await m.probe(host, 3000)).toEqual({ status: 200 });
    }
    expect(await m.probe(`locked.${ZONE}`, 3000)).toEqual({ status: 401 });
    expect(judgeProbe(`locked.${ZONE}`, "locked", { status: 401 }).verdict).toBe("ok");
  });

  test("a service that does not answer behind Caddy is a 502", async () => {
    const response = await machine().probe(`shop.${ZONE}`, 3000);
    expect(response).toEqual({ status: 502 });
    expect(judgeProbe(`shop.${ZONE}`, "shop", response).verdict).toBe("fail");
  });

  test("a certificate for another name fails the probe, verified the way a browser would", async () => {
    const response = await machine().probe("sample-agency.example", 3000);
    expect("error" in response).toBe(true);
    if ("error" in response) expect(response.error).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  test("without the test authority, the same certificates are refused", async () => {
    const strict = createMachine({ ...config(), probe: { ...config().probe, ca: null } });
    const response = await strict.probe(`cms.${ZONE}`, 3000);
    expect("error" in response).toBe(true);
  });

  test("each certificate's expiry is read, even when it would be refused", async () => {
    const m = machine();
    const now = Date.now();
    const wildcard = await m.certificate(`cms.${ZONE}`, 3000);
    const apex = await m.certificate(ZONE, 3000);
    const wrong = await m.certificate("sample-agency.example", 3000);
    if (!("notAfter" in wildcard) || !("notAfter" in apex) || !("notAfter" in wrong)) {
      throw new Error(`a certificate was not read: ${JSON.stringify([wildcard, apex, wrong])}`);
    }
    expect(Math.round((wildcard.notAfter - now) / DAY)).toBe(4);
    expect(Math.round((apex.notAfter - now) / DAY)).toBe(60);
    const target = { id: `certificate:*.${ZONE}`, label: `*.${ZONE}`, slug: null };
    expect(judgeCertificate(target, wildcard, now).verdict).toBe("fail");
    expect(judgeCertificate({ ...target, label: ZONE }, apex, now).verdict).toBe("ok");
  });

  test("a port nobody listens on is an error, quickly", async () => {
    const closed = createMachine({ ...config(), probe: { ...config().probe, port: deadPort } });
    const response = await closed.probe(`cms.${ZONE}`, 3000);
    expect("error" in response).toBe(true);
    expect("error" in (await closed.certificate(`cms.${ZONE}`, 3000))).toBe(true);
  });

  test("two whole runs: the shop, the customer domain and the wildcard are down, nothing else", async () => {
    const m = { ...machine(), log: () => {} };
    const start = Date.now();
    await run(config(), m, start);
    const { status } = await run(config(), m, start + 60_000);
    expect(status.down.map((problem) => [problem.id, problem.severity])).toEqual([
      ["site:sample-agency.example", "critical"],
      [`site:shop.${ZONE}`, "critical"],
      [`certificate:*.${ZONE}`, "warning"],
    ]);
    expect(status.down.find((problem) => problem.kind === "certificate")!.summary).toMatch(
      /^The certificate for \*\.test-zone\.invalid expires in [34] days, on \d{4}-\d{2}-\d{2}$/,
    );
  });
});
