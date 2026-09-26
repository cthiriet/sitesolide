import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../borrowed/fragment";
import { readManifest, type Manifest } from "../borrowed/manifest";
import { fragmentIsProtected, PORTAL_PORT } from "../borrowed/portal";
import type { Machine } from "../src/gatekeeper/machine";
import { createMachine, writeResult, spawn, type MachineConfig, type Execution } from "../src/gatekeeper/real";
import { run } from "../src/gatekeeper/transaction";

/**
 * The real gatekeeper in front of a real Caddy, on the workstation.
 *
 * Everything is real except `systemctl`: the machine writes the files, runs
 * `caddy validate` with the test file's environment, queries Caddy over HTTPS
 * with certificate verification. The reload is simulated by what `systemctl
 * reload caddy` would do: a refused configuration leaves the old one in
 * service, a valid configuration replaces it. Here Caddy runs with `admin off`
 * and the replacement goes through its PID: stopped by signal, then started
 * again on the same configuration.
 *
 * NEVER `caddy stop`, `caddy start` or `caddy reload`: they address the
 * administration API of the instance in service, whatever `--config` says, and
 * that is how production came to a stop on 11 August 2026. See the Production
 * section of CLAUDE.md.
 *
 * The block is the one `generateFragment` writes for production, with no
 * retouching: `sample.test-zone.invalid`, the portal on 127.0.0.1:3026. The
 * names resolve on the loopback through the probe's Host header, and the
 * certificate is drawn here by a test authority. The test skips itself with no
 * `caddy` and no `openssl`, or when the portal's port is already taken on the
 * workstation.
 */

const CADDY = Bun.which("caddy");
const OPENSSL = Bun.which("openssl");
const ZONE = "test-zone.invalid";
const TOKEN = "sample-cloudflare-token-7f3a";

function freePort(port = 0): number | null {
  try {
    const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() });
    const taken = server.port!;
    server.stop(true);
    return taken;
  } catch {
    return null;
  }
}

const PORTAL_FREE = freePort(PORTAL_PORT) !== null;

/** The same extraction as bin/tests/cli-portal-caddy.test.ts, to read the real `(commun)`. */
function block(text: string, header: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith(header));
  if (start === -1) throw new Error(`block not found: ${header}`);
  const body: string[] = [];
  let depth = 0;
  for (const line of lines.slice(start)) {
    const code = line.trimStart().startsWith("#") ? "" : line;
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    body.push(line);
    if (depth === 0 && body.length > 1) break;
  }
  return body.join("\n");
}

function openssl(folder: string, ...arguments_: string[]): void {
  const output = Bun.spawnSync([OPENSSL!, ...arguments_], { cwd: folder, stdout: "ignore", stderr: "pipe" });
  if (output.exitCode !== 0) throw new Error(`openssl ${arguments_[0]}: ${output.stderr.toString()}`);
}

describe.skipIf(CADDY === null || OPENSSL === null || !PORTAL_FREE)("the gatekeeper in front of a real Caddy", () => {
  const D = mkdtempSync(join(tmpdir(), "gatekeeper-caddy-"));
  const portHttps = freePort()!;
  const portHttp = freePort()!;
  const sitesFolder = join(D, "srv");
  const blocksFolder = join(D, "etc", "sites");
  const caddyfile = join(D, "etc", "Caddyfile");
  const envFile = join(D, "etc", "cloudflare.env");
  const zoneFile = join(D, "etc", "sitesolide.env");

  /** What /etc/caddy/sitesolide.env carries, and systemd gives to Caddy. */
  const ZONE_VARIABLES = {
    SITESOLIDE_ZONE: ZONE,
    SITESOLIDE_ACME_EMAIL: `sample@${ZONE}`,
    SITESOLIDE_SLUG: `{labels.${ZONE.split(".").length}}`,
  };

  let caddy: ReturnType<typeof Bun.spawn> | null = null;
  let site: ReturnType<typeof Bun.serve>;
  let portal: ReturnType<typeof Bun.serve>;
  /** `normal`: the portal's 401; `mute`: a 401 without its header, to make the probe fail. */
  let portalMode: "normal" | "mute" = "normal";
  const systemctlCalls: string[][] = [];
  const log: string[] = [];
  let ca = "";
  let initialManifest = "";
  let machine: Machine;
  let config: MachineConfig;

  async function waitForCaddy(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      try {
        const socket = await Bun.connect({ hostname: "127.0.0.1", port: portHttps, socket: { data() {} } });
        socket.end();
        return;
      } catch {
        await Bun.sleep(25);
      }
    }
    throw new Error("the test Caddy does not answer");
  }

  async function startCaddy(): Promise<void> {
    // The environment systemd would give Caddy through EnvironmentFile.
    caddy = Bun.spawn([CADDY!, "run", "--config", caddyfile, "--adapter", "caddyfile"], {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: TOKEN,
        ...ZONE_VARIABLES,
        HOME: D,
        XDG_DATA_HOME: join(D, "data"),
        XDG_CONFIG_HOME: join(D, "config"),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForCaddy();
  }

  async function stopCaddy(): Promise<void> {
    if (caddy === null) return;
    // By its PID, never through the administration API, which is off anyway.
    caddy.kill("SIGTERM");
    await caddy.exited;
    caddy = null;
  }

  /** `systemctl`, as the gatekeeper calls it, for this test Caddy alone. */
  async function systemctl(arguments_: string[]): Promise<Execution> {
    systemctlCalls.push(arguments_);
    const [verb, ...remaining] = arguments_;
    const alive = caddy !== null && caddy.exitCode === null;
    if (verb === "is-active" && remaining[0] === "--quiet" && remaining[1] === "caddy.service") {
      return { code: alive ? 0 : 3, stdout: "", stderr: "" };
    }
    if (verb === "is-active") {
      // The site's service is running, nothing else.
      const lines = remaining.map((unit) => (unit === "sample.service" ? "active" : "inactive"));
      return { code: lines.every((l) => l === "active") ? 0 : 3, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    if (verb === "reload" && remaining[0] === "caddy.service") {
      // Like `caddy reload` under systemd: a refused configuration leaves the
      // old one in service.
      const verdict = await spawn([CADDY!, "validate", "--config", caddyfile, "--adapter", "caddyfile"], 15_000, {
        PATH: "/usr/bin:/bin",
        HOME: D,
        XDG_DATA_HOME: join(D, "data"),
        CLOUDFLARE_API_TOKEN: TOKEN,
        // The unit's two EnvironmentFile, not only the secrets one: the
        // Caddyfile reads the zone, and without it it has only empty addresses.
        ...ZONE_VARIABLES,
      });
      if (verdict.code !== 0) return { code: 1, stdout: "", stderr: "Job for caddy.service failed." };
      await stopCaddy();
      await startCaddy();
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "start" && remaining[0] === "caddy.service") {
      if (!alive) await startCaddy();
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "start" && remaining[0] === "--no-block" && remaining[1] === "sitesolide-collector.service") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected systemctl ${arguments_.join(" ")}` };
  }

  function readBlock(): string {
    return readFileSync(join(blocksFolder, "sample.caddy"), "utf8");
  }

  function readDeployedManifest(): string {
    return readFileSync(join(sitesFolder, "sample", "sitesolide.json"), "utf8");
  }

  beforeAll(async () => {
    // Test authority and certificate, for the zone and its wildcard.
    openssl(D, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2",
      "-subj", "/CN=Gatekeeper sample", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
    openssl(D, "req", "-newkey", "rsa:2048", "-nodes", "-keyout", "site.key", "-out", "site.csr", "-subj", `/CN=${ZONE}`);
    writeFileSync(
      join(D, "site.ext"),
      `subjectAltName=DNS:${ZONE},DNS:www.${ZONE},DNS:*.${ZONE}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
    );
    openssl(D, "x509", "-req", "-in", "site.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "site.pem",
      "-days", "2", "-extfile", "site.ext");
    ca = readFileSync(join(D, "ca.pem"), "utf8");

    // The fake site service, and the fake portal: /check refuses everyone,
    // as the real one does with no cookie; /sante says it is ready.
    site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("site sample") });
    portal = Bun.serve({
      port: PORTAL_PORT,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/sante") return Response.json({ ok: true, configure: true });
        const headers: Record<string, string> = { "Content-Type": "text/html", "Cache-Control": "no-store" };
        if (portalMode === "normal") headers["X-Portal"] = "connexion";
        return new Response("<p>This site is private.</p>", { status: 401, headers: headers });
      },
    });

    // /srv/sites: the app site, a static showcase.
    const manifest: Manifest = {
      slug: "sample",
      port: site.port,
      publicDir: "public",
      start: "/usr/local/bin/bun run server.ts",
      memory: "128M",
      portalExempt: ["/webhook/*"],
    };
    initialManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    mkdirSync(join(sitesFolder, "sample"), { recursive: true });
    writeFileSync(join(sitesFolder, "sample", "sitesolide.json"), initialManifest);
    // An unusual mode, to check that it survives the rewrite.
    chmodSync(join(sitesFolder, "sample", "sitesolide.json"), 0o640);
    mkdirSync(join(sitesFolder, "showcase", "public"), { recursive: true });
    writeFileSync(join(sitesFolder, "showcase", "public", "index.html"), "<p>showcase</p>");

    // /etc/caddy: the block as `sitesolide deploy` lays it down, and a
    // Caddyfile that takes production's shape.
    mkdirSync(blocksFolder, { recursive: true });
    writeFileSync(join(blocksFolder, "sample.caddy"), generateFragment(manifest)!);
    writeFileSync(envFile, `# Test token, worth nothing anywhere else\nCLOUDFLARE_API_TOKEN=${TOKEN}\n`);
    writeFileSync(
      zoneFile,
      [
        "# Test zone variables, as bin/deploy-caddy.sh lays them down.",
        ...Object.entries(ZONE_VARIABLES).map(([key, value]) => `${key}=${value}`),
        "",
      ].join("\n"),
    );
    const production = readFileSync(join(import.meta.dir, "..", "..", "infra", "caddy", "Caddyfile"), "utf8");
    writeFileSync(
      caddyfile,
      [
        "{",
        "\tadmin off",
        `\thttp_port ${portHttp}`,
        `\thttps_port ${portHttps}`,
        "\tauto_https disable_redirects",
        `\tstorage file_system ${join(D, "storage")}`,
        "}",
        "(tls-zone) {",
        `\ttls ${join(D, "site.pem")} ${join(D, "site.key")}`,
        "}",
        block(production, "(commun) {"),
        `${ZONE}, www.${ZONE} {`,
        "\timport tls-zone",
        '\trespond "landing" 200',
        "}",
        `*.${ZONE} {`,
        "\timport tls-zone",
        "\timport commun",
        `\troot * ${sitesFolder}/{labels.2}/public`,
        "\tfile_server",
        "}",
        `portal.${ZONE} {`,
        "\timport tls-zone",
        `\treverse_proxy /sante 127.0.0.1:${PORTAL_PORT}`,
        "}",
        `import ${blocksFolder}/*.caddy`,
        "",
      ].join("\n"),
    );

    config = {
      sitesDir: sitesFolder,
      blocksFolder,
      caddyfile,
      caddyEnvFile: envFile,
      zoneEnvFile: zoneFile,
      caddy: CADDY!,
      runFolder: join(D, "run"),
      blockOwner: null,
      probeConfig: { address: "127.0.0.1", port: portHttps, ca },
      caddyUnit: "caddy.service",
      collectorUnit: "sitesolide-collector.service",
      systemctl: (arguments_) => systemctl(arguments_),
      log: (line) => log.push(line),
    };
    machine = createMachine(config);
    await startCaddy();
  }, 60_000);

  afterAll(async () => {
    await stopCaddy();
    site?.stop(true);
    portal?.stop(true);
    rmSync(D, { recursive: true, force: true });
  });

  test("before: the site answers with no portal, over verified HTTPS", async () => {
    expect(await machine.probe(`sample.${ZONE}`, "/", 5000)).toEqual({ code: 200, door: false, body: "site sample" });
    expect(await machine.probe(`showcase.${ZONE}`, "/", 5000)).toMatchObject({ code: 200, door: false });
    expect(await machine.probe(ZONE, "/", 5000)).toMatchObject({ code: 200, body: "landing" });
    expect(await machine.servedSites(2000)).toEqual(["sample", "showcase"]);
  });

  test("TLS verification is kept: another authority, and the probe fails", async () => {
    const withoutAuthority = createMachine({ ...config, probeConfig: { ...config.probeConfig, ca: null } });
    const response = await withoutAuthority.probe(`sample.${ZONE}`, "/", 5000);
    expect(response).toEqual({ error: expect.stringMatching(/CERT|VERIFY|certificate/i) });
    // And a host the certificate does not cover, with the right authority.
    const other = await machine.probe("sample.example.org", "/", 5000);
    expect("error" in other).toBe(true);
  });

  test("validateCaddy passes on the configuration in place, and never quotes its token", async () => {
    const verdict = await machine.validateCaddy(15_000);
    expect(verdict.ok).toBe(true);
    expect(verdict.output).not.toContain(TOKEN);
  });

  test("setting the portal: valid, reloaded, the site answers through the portal", async () => {
    const pidBefore = caddy!.pid;
    const result = await run(machine, { slug: "sample", active: true, zone: ZONE });

    expect(result).toMatchObject({ result: "ok", requested: true, installed: true });
    expect(result.message).toContain("sample.test-zone.invalid answers the portal's 401");
    expect(result.message).toContain("3 other site(s) still answer");
    expect(caddy!.pid).not.toBe(pidBefore);

    const response = await machine.probe(`sample.${ZONE}`, "/", 5000);
    expect(response).toMatchObject({ code: 401, door: true });
    expect(await machine.probe(`showcase.${ZONE}`, "/", 5000)).toMatchObject({ code: 200 });

    // The block is exactly the next deployment's, the manifest keeps its mode.
    const newPassword = readManifest(readDeployedManifest()).manifest!;
    expect(newPassword.portal).toBe(true);
    expect(readBlock()).toBe(generateFragment(newPassword)!);
    expect(fragmentIsProtected(readBlock())).toBe(true);
    expect(statSync(join(sitesFolder, "sample", "sitesolide.json")).mode & 0o777).toBe(0o640);

    // No lock, no backup, no temporary file left behind.
    expect(readdirSync(config.runFolder)).toEqual([]);
    expect(readdirSync(blocksFolder)).toEqual(["sample.caddy"]);
    expect(readdirSync(join(sitesFolder, "sample"))).toEqual(["sitesolide.json"]);
    expect(systemctlCalls).toContainEqual(["start", "--no-block", "sitesolide-collector.service"]);

    // The result as the steward will read it.
    writeResult(config.runFolder, "sample", result);
    const file = join(config.runFolder, "sample.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(result);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    rmSync(file);
  }, 60_000);

  test("setting it again: nothing to do, Caddy is not reloaded", async () => {
    const pidBefore = caddy!.pid;
    const result = await run(machine, { slug: "sample", active: true, zone: ZONE });
    expect(result).toMatchObject({ result: "ok", message: "already behind the portal", installed: true });
    expect(caddy!.pid).toBe(pidBefore);
  });

  test("removing the portal: the site answers again, the manifest comes back identical", async () => {
    const result = await run(machine, { slug: "sample", active: false, zone: ZONE });
    expect(result).toMatchObject({ result: "ok", requested: false, installed: false });
    expect(await machine.probe(`sample.${ZONE}`, "/", 5000)).toEqual({ code: 200, door: false, body: "site sample" });
    expect(readDeployedManifest()).toBe(initialManifest);
    expect(fragmentIsProtected(readBlock())).toBe(false);
  }, 60_000);

  test("an invalid block: caddy validate refuses it, everything is restored, Caddy never reloaded", async () => {
    const blockBefore = readBlock();
    const pidBefore = caddy!.pid;
    // The first block written is broken, as a faulty generator's would be;
    // the restore, for its part, writes normally. `encode` followed by the
    // token: Caddy quotes it back in its refusal (`module not registered:
    // http.encoders.<token>`), and it must not come out anywhere.
    let writes = 0;
    const broken: Machine = {
      ...machine,
      writeBlock: (slug, text) =>
        machine.writeBlock(
          slug,
          ++writes === 1 ? `${text}\nsample.${ZONE} {\n\tencode {$CLOUDFLARE_API_TOKEN}\n}\n` : text,
        ),
    };
    const result = await run(broken, { slug: "sample", active: true, zone: ZONE });

    expect(result.result).toBe("failure");
    expect(result.message).toStartWith("validate: ");
    expect(result.message).toEndWith("previous configuration restored");
    expect(result.message).toContain("http.encoders.[redacted]");
    expect(result.message).not.toContain(TOKEN);
    expect(log.join("\n")).not.toContain(TOKEN);
    expect(result).toMatchObject({ requested: false, installed: false });
    expect(readBlock()).toBe(blockBefore);
    expect(readDeployedManifest()).toBe(initialManifest);
    expect(caddy!.pid).toBe(pidBefore);
    expect(await machine.probe(`sample.${ZONE}`, "/", 5000)).toMatchObject({ code: 200, door: false });
    expect(existsSync(join(config.runFolder, "sauvegardes"))).toBe(false);
  }, 60_000);

  test("a probe that fails after the reload: restore, reload, the site answers as before", async () => {
    const blockBefore = readBlock();
    const reloads = () => systemctlCalls.filter((a) => a[0] === "reload").length;
    const before = reloads();
    portalMode = "mute";
    try {
      const result = await run(machine, { slug: "sample", active: true, zone: ZONE });
      expect(result.result).toBe("failure");
      expect(result.message).toBe(
        "probe: sample.test-zone.invalid should answer the portal's 401, got 401; previous configuration restored",
      );
      expect(result).toMatchObject({ requested: false, installed: false });
    } finally {
      portalMode = "normal";
    }
    // The action, then the restore: two real reloads.
    expect(reloads() - before).toBe(2);
    expect(readBlock()).toBe(blockBefore);
    expect(readDeployedManifest()).toBe(initialManifest);
    expect(await machine.probe(`sample.${ZONE}`, "/", 5000)).toEqual({ code: 200, door: false, body: "site sample" });
  }, 60_000);

  test("systemctl received only the permitted verbs", () => {
    const allowed = new Set(["is-active", "reload", "start"]);
    for (const call of systemctlCalls) expect(allowed.has(call[0]!)).toBe(true);
    // `start caddy.service` is only permitted in a restore that finds Caddy stopped.
    expect(systemctlCalls.filter((a) => a[0] === "start" && a[1] === "caddy.service")).toEqual([]);
  });
});

describe("never caddy stop nor caddy start", () => {
  test("neither the gatekeeper nor its deployment script runs them", () => {
    const root = join(import.meta.dir, "..", "..");
    const files = [
      join(root, "dashboard", "gatekeeper.ts"),
      ...readdirSync(join(root, "dashboard", "src", "gatekeeper")).map((name) => join(root, "dashboard", "src", "gatekeeper", name)),
      join(root, "bin", "deploy-gatekeeper.sh"),
      join(root, "infra", "gatekeeper", "sitesolide-gatekeeper-on@.service"),
      join(root, "infra", "gatekeeper", "sitesolide-gatekeeper-off@.service"),
    ];
    for (const file of files) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(#|\/\/|\*|\/\*\*)/.test(line));
      for (const line of code) {
        expect({ file, line, forbidden: /caddy["',\s]+(stop|start|reload|run)\b/.test(line) }).toMatchObject({
          forbidden: false,
        });
      }
    }
  });
});
