import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { CLOUDFLARE_POLICY, tlsZoneContent } from "../cli/tls";

/**
 * The zone's TLS policy lives in a file of the machine,
 * /etc/caddy/tls-zone.caddy, imported by name by the `(tls-zone)` snippet.
 * The proof, in a real Caddy, that the Caddyfile with Cloudflare's policy
 * puts the zone's names under it and the customer domains on demand, the
 * blocks of an app and of a customer domain included; that a missing policy
 * fails rather than falls back to Caddy's defaults; and that manual DNS gives
 * every name an on-demand policy a stock Caddy validates.
 *
 * `caddy adapt` and `caddy validate` only, on the workstation: no server
 * starts, nothing listens. Never `caddy stop` nor `caddy start`, see the
 * Production section of CLAUDE.md. Skipped where Caddy is not installed.
 *
 * A Caddy built without the Cloudflare module cannot read `dns cloudflare`.
 * There, the directive is replaced by one a stock Caddy reads, `key_type
 * p384`, which gives the zone a policy of its own just as the DNS challenge
 * does. With the module, the directive itself is read.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");

const ZONE = "test-zone.invalid";
const DIRECTIVE = "dns cloudflare {env.CLOUDFLARE_API_TOKEN}";
const STAND_IN = "key_type p384";

const WITH_MODULE =
  CADDY !== null &&
  Bun.spawnSync([CADDY, "list-modules"], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .split("\n")
    .some((line) => line.trim() === "dns.providers.cloudflare");

const APP: Manifest = {
  slug: "kanban",
  port: 3040,
  publicDir: "public",
  start: "bun run server.ts",
  domain: { name: "kanban.example", active: true },
};

type Adapted = { code: number; json: Record<string, unknown> | null; error: string };

describe.skipIf(CADDY === null)(`the zone's TLS policy in a file, in Caddy${WITH_MODULE ? "" : " (without the Cloudflare module: the directive stood in for)"}`, () => {
  // Made in beforeAll, so that a run without Caddy leaves nothing behind.
  let folder = "";
  let etc = "";
  let policy = "";

  /** The machine's /etc/caddy, moved into the test's folder; the rest of the text as it is. */
  const localize = (text: string): string => text.replaceAll("/etc/caddy/", `${etc}/`);
  /** Cloudflare's directive, or what stands in for it in a Caddy that cannot read it. */
  const directive = (text: string): string => {
    if (WITH_MODULE) return text;
    expect(text.split(DIRECTIVE).length).toBe(2);
    return text.replace(DIRECTIVE, STAND_IN);
  };

  /** Caddy's environment, as systemd hands it the zone's variables; its own folders the test's. */
  const environment = (): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    HOME: folder,
    XDG_DATA_HOME: join(folder, "data"),
    XDG_CONFIG_HOME: join(folder, "config"),
    SITESOLIDE_ZONE: ZONE,
    SITESOLIDE_ACME_EMAIL: `ops@${ZONE}`,
    SITESOLIDE_SLUG: "{labels.2}",
  });

  function adapt(caddyfile: string): Adapted {
    const run = Bun.spawnSync([CADDY!, "adapt", "--config", caddyfile, "--adapter", "caddyfile"], { stdout: "pipe", stderr: "pipe", env: environment() });
    const output = run.stdout.toString();
    return { code: run.exitCode, json: run.exitCode === 0 ? (JSON.parse(output) as Record<string, unknown>) : null, error: run.stderr.toString() };
  }

  function validate(caddyfile: string): { code: number; output: string } {
    const run = Bun.spawnSync([CADDY!, "validate", "--config", caddyfile, "--adapter", "caddyfile"], { stdout: "pipe", stderr: "pipe", env: environment() });
    return { code: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
  }

  type Policy = { subjects?: string[]; on_demand?: boolean; key_type?: string; issuers?: Array<{ challenges?: { dns?: { provider?: { name?: string } } } }> };
  const policies = (json: Record<string, unknown> | null): Policy[] =>
    ((json?.apps as { tls?: { automation?: { policies?: Policy[] } } } | undefined)?.tls?.automation?.policies ?? []) as Policy[];

  /** The Caddyfile, written at the same path each time: Caddy names it in what it adapts. */
  let caddyfile = "";
  let current = "";

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "tls-caddy-"));
    etc = join(folder, "etc");
    policy = join(etc, "tls-zone.caddy");
    caddyfile = join(folder, "Caddyfile");
    // The machine around the Caddyfile: an app's block, with its customer
    // domain, the customer domains' table, an empty folder of locks.
    mkdirSync(join(etc, "sites"), { recursive: true });
    mkdirSync(join(etc, "locks"));
    writeFileSync(join(etc, "sites", `${APP.slug}.caddy`), localize(generateFragment(APP)!));
    writeFileSync(join(etc, "domaines.map"), "\tsample-agency.example agency\n");

    current = localize(readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8"));
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  test("with Cloudflare's policy, the zone's names are under it and the customer domains on demand", () => {
    writeFileSync(policy, directive(tlsZoneContent(CLOUDFLARE_POLICY)));
    // The zone's names, the app's preview among them, are under the zone's
    // policy, the DNS challenge's or what stands in for it, and the customer
    // domains under on demand. The bare domain is not one of them: no block
    // names it, a project that declares it serves it as a customer domain.
    writeFileSync(caddyfile, current);
    const whole = adapt(caddyfile);
    expect(whole.code).toBe(0);
    const zone = policies(whole.json).find((one) => one.subjects?.includes(`*.${ZONE}`));
    expect(zone?.subjects).toEqual(expect.arrayContaining([`*.${ZONE}`, `${APP.slug}.${ZONE}`]));
    expect(zone?.subjects).not.toContain(ZONE);
    if (WITH_MODULE) {
      expect(zone?.issuers?.some((issuer) => issuer.challenges?.dns?.provider?.name === "cloudflare")).toBe(true);
    } else {
      expect(zone?.key_type).toBe("p384");
    }
    expect(zone?.on_demand).toBeUndefined();
    // The customer domains keep theirs: on demand, with no subject, the
    // catch-all the app's own domain and the nameless block share.
    expect(policies(whole.json).some((one) => one.on_demand === true && one.subjects === undefined)).toBe(true);
  });

  test("the Caddyfile does not adapt without the policy: no zone falls back to Caddy's defaults", () => {
    rmSync(policy, { force: true });
    writeFileSync(caddyfile, current);
    const adapted = adapt(caddyfile);
    expect(adapted.code).not.toBe(0);
    expect(adapted.error).toContain("tls-zone.caddy");
  });

  test("manual DNS: every name certified on demand, through the ask endpoint, and a stock Caddy validates it", () => {
    writeFileSync(policy, tlsZoneContent({ kind: "on-demand" }));
    writeFileSync(caddyfile, current);
    const adapted = adapt(caddyfile);
    expect(adapted.code).toBe(0);
    const all = policies(adapted.json);
    expect(all.length).toBeGreaterThan(0);
    // One policy, on demand, for the zone's names and the customer domains
    // alike: no DNS challenge anywhere, no wildcard to obtain.
    expect(all.every((one) => one.on_demand === true)).toBe(true);
    expect(JSON.stringify(adapted.json)).not.toContain('"dns"');
    const tls = (adapted.json!.apps as { tls: { automation: { on_demand: { permission: { endpoint: string } } } } }).tls;
    expect(tls.automation.on_demand.permission.endpoint).toBe("http://127.0.0.1:3001/interne/domaine-autorise");
    const validated = validate(caddyfile);
    expect(validated.output).toContain("Valid configuration");
    expect(validated.code).toBe(0);
  });
});
