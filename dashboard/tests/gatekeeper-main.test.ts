import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../borrowed/fragment";
import type { Manifest } from "../borrowed/manifest";
import { configFrom } from "../src/gatekeeper/main";

/**
 * The entry point as systemd launches it:
 * `GATEKEEPER_ACTION=on bun gatekeeper.ts sitesolide-gatekeeper-on@<slug>.service`.
 * The exit code does not carry the verdict, the result file does.
 */
const PROJECT = join(import.meta.dir, "..");
const D = mkdtempSync(join(tmpdir(), "gatekeeper-principal-"));

afterAll(() => rmSync(D, { recursive: true, force: true }));

function arborescence(name: string): Record<string, string> {
  const root = join(D, name);
  const manifest: Manifest = { slug: "sample", port: 3999, publicDir: "public", start: "bun run server.ts" };
  mkdirSync(join(root, "srv", "sample"), { recursive: true });
  mkdirSync(join(root, "sites"), { recursive: true });
  writeFileSync(join(root, "srv", "sample", "sitesolide.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, "sites", "sample.caddy"), generateFragment(manifest)!);
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SITES_DIR: join(root, "srv"),
    BLOCKS_FOLDER: join(root, "sites"),
    CADDYFILE: join(root, "Caddyfile"),
    CADDY_ENV_FILE: join(root, "cloudflare.env"),
    ZONE_ENV_FILE: join(root, "sitesolide.env"),
    // The gatekeeper probes `<slug>.<zone>` after reloading: with no zone, it
    // refuses to begin rather than probe an address that does not exist.
    SITESOLIDE_ZONE: "test-zone.invalid",
    CADDY: "/nonexistent/caddy",
    RUN_FOLDER: join(root, "run"),
    BLOCK_OWNER: "",
    // A systemctl that always fails: Caddy passes for stopped, nothing reloads.
    SYSTEMCTL: "/usr/bin/false",
    PROBE_PORT: "9",
  };
}

async function gatekeeper(argv: string[], env: Record<string, string>, action?: string): Promise<number> {
  const process = Bun.spawn(["bun", "gatekeeper.ts", ...argv], {
    cwd: PROJECT,
    env: action === undefined ? env : { ...env, GATEKEEPER_ACTION: action },
    stdout: "ignore",
    stderr: "ignore",
  });
  return process.exited;
}

describe("gatekeeper.ts", () => {
  test("a malformed start: exit code 2, and nothing is written, neither result nor lock", async () => {
    const env = arborescence("mal-forme");
    const before = readFileSync(join(env.SITES_DIR!, "sample", "sitesolide.json"), "utf8");
    // The template from before, a slug out of rule, a name that is not a unit's.
    expect(await gatekeeper(["on-sample"], env, "on")).toBe(2);
    expect(await gatekeeper(["sitesolide-gatekeeper-on@...service"], env, "on")).toBe(2);
    expect(await gatekeeper(["sitesolide-gatekeeper-reload@sample.service"], env, "on")).toBe(2);
    // The action missing, malformed, or contradicting the unit file.
    expect(await gatekeeper(["sitesolide-gatekeeper-on@sample.service"], env)).toBe(2);
    expect(await gatekeeper(["sitesolide-gatekeeper-on@sample.service"], env, "yes")).toBe(2);
    expect(await gatekeeper(["sitesolide-gatekeeper-off@sample.service"], env, "on")).toBe(2);
    // Two arguments: ExecStart passes only %n.
    expect(await gatekeeper(["sitesolide-gatekeeper-on@sample.service", "sample"], env, "on")).toBe(2);
    expect(existsSync(env.RUN_FOLDER!)).toBe(false);
    expect(readFileSync(join(env.SITES_DIR!, "sample", "sitesolide.json"), "utf8")).toBe(before);
  });

  test("a refusal: exit code 0, the result is what counts", async () => {
    const env = arborescence("rejects");
    expect(await gatekeeper(["sitesolide-gatekeeper-on@dashboard.service"], env, "on")).toBe(0);
    const file = join(env.RUN_FOLDER!, "dashboard.json");
    const result = JSON.parse(readFileSync(file, "utf8"));
    expect(result).toMatchObject({
      result: "rejects",
      message: "the dashboard must stay reachable if the portal fails",
      requested: false,
      installed: false,
    });
    expect(typeof result.a).toBe("number");
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  test("a failure before the action: exit code 0, nothing changed, no lock or backup left behind", async () => {
    const env = arborescence("failure");
    const before = readFileSync(join(env.SITES_DIR!, "sample", "sitesolide.json"), "utf8");
    expect(await gatekeeper(["sitesolide-gatekeeper-on@sample.service"], env, "on")).toBe(0);
    const result = JSON.parse(readFileSync(join(env.RUN_FOLDER!, "sample.json"), "utf8"));
    expect(result).toMatchObject({ result: "failure", message: "Caddy is not active, nothing was changed" });
    expect(readFileSync(join(env.SITES_DIR!, "sample", "sitesolide.json"), "utf8")).toBe(before);
    expect(readdirSync(env.RUN_FOLDER!)).toEqual(["sample.json"]);
  });

  test("Caddy's lock held by the workstation: refusal, and the lock stays with its holder", async () => {
    const env = arborescence("held");
    const lock = join(env.RUN_FOLDER!, "caddy.lock");
    mkdirSync(lock, { recursive: true });
    const holder = `deploy ${process.pid} ${Date.now()}\n`;
    writeFileSync(join(lock, "holder"), holder);
    expect(await gatekeeper(["sitesolide-gatekeeper-off@sample.service"], env, "off")).toBe(0);
    const result = JSON.parse(readFileSync(join(env.RUN_FOLDER!, "sample.json"), "utf8"));
    expect(result.result).toBe("rejects");
    expect(result.message).toStartWith("Caddy is being changed from the workstation (deploy, since ");
    expect(readFileSync(join(lock, "holder"), "utf8")).toBe(holder);
  });
});

describe("configFrom", () => {
  test("the production defaults", () => {
    const config = configFrom({});
    expect(config).toMatchObject({
      sitesDir: "/srv/sites",
      blocksFolder: "/etc/caddy/sites",
      caddyfile: "/etc/caddy/Caddyfile",
      caddyEnvFile: "/etc/caddy/cloudflare.env",
      zoneEnvFile: "/etc/caddy/sitesolide.env",
      caddy: "/usr/bin/caddy",
      runFolder: "/run/sitesolide-gatekeeper",
      blockOwner: { uid: 0, gid: 0 },
      probeConfig: { address: "127.0.0.1", port: 443, ca: null },
      caddyUnit: "caddy.service",
      collectorUnit: "sitesolide-collector.service",
    });
  });

  test("malformed values are refused rather than guessed", () => {
    expect(() => configFrom({ BLOCK_OWNER: "root" })).toThrow();
    expect(() => configFrom({ PROBE_PORT: "https" })).toThrow();
    expect(configFrom({ BLOCK_OWNER: "" }).blockOwner).toBeNull();
  });
});
