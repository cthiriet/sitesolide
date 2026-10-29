import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { CLOUDFLARE_POLICY, tlsZoneContent } from "../cli/tls";
import { block } from "./caddy-lab";

/**
 * The zone's TLS policy moved from the Caddyfile to a file of the machine,
 * /etc/caddy/tls-zone.caddy, imported by name by the `(tls-zone)` snippet.
 * The proof, in a real Caddy, that a machine upgraded from the release in
 * production gets exactly the configuration it had: that release's
 * Caddyfile, and this one with the policy bin/deploy-caddy.sh lays for it,
 * adapt to the same JSON, the blocks of an app and of a customer domain
 * included. Then that a missing policy fails rather than falls back to
 * Caddy's defaults, and that manual DNS gives every name an on-demand policy
 * a stock Caddy validates.
 *
 * `caddy adapt` and `caddy validate` only, on the workstation: no server
 * starts, nothing listens. Never `caddy stop` nor `caddy start`, see the
 * Production section of CLAUDE.md. Skipped where Caddy is not installed.
 *
 * A Caddy built without the Cloudflare module cannot read `dns cloudflare`,
 * in either file. There, the directive is replaced on both sides by one a
 * stock Caddy reads, `key_type p384`, which gives the zone a policy of its own
 * just as the DNS challenge does: what is compared is then whether the import
 * of the file gives what the inline block gave, and the content laid is
 * compared with the block it replaces, text against text, in cli-tls.test.ts.
 * With the module, the directive itself is compared.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");

/** The release production runs, whose Caddyfile carried Cloudflare's policy inline: the reference. */
const REFERENCE = "v0.6.4";

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

/** Every `hide` list of the adapted configuration: the file servers'. */
function hideLists(json: unknown): string[][] {
  if (Array.isArray(json)) return json.flatMap(hideLists);
  if (json === null || typeof json !== "object") return [];
  return Object.entries(json).flatMap(([key, value]) => (key === "hide" && Array.isArray(value) ? [value as string[]] : hideLists(value)));
}

/** The configuration with one path taken out of every `hide` list. */
function withoutHidden(json: unknown, path: string): unknown {
  if (Array.isArray(json)) return json.map((value) => withoutHidden(value, path));
  if (json === null || typeof json !== "object") return json;
  return Object.fromEntries(
    Object.entries(json).map(([key, value]) => [key, key === "hide" && Array.isArray(value) ? value.filter((entry) => entry !== path) : withoutHidden(value, path)]),
  );
}

/** The landing's block of the reference, which this release no longer has: the bare domain is a domain of the table. */
const LANDING_HEADER = "{$SITESOLIDE_ZONE}, www.{$SITESOLIDE_ZONE} {";

/** The lines this release adds for the bare domain: www sent to it from the wildcard block, its HSTS in the nameless block. */
const BARE_LINES = [
  "\t@www host www.{$SITESOLIDE_ZONE}\n",
  '\theader @www Strict-Transport-Security "max-age=31536000"\n',
  "\tredir @www https://{$SITESOLIDE_ZONE}{uri} permanent\n",
  "\t@bare host {$SITESOLIDE_ZONE}\n",
  '\theader @bare Strict-Transport-Security "max-age=31536000"\n',
];

/** The configuration with no proxy handing on the visitor's address, which the landing's form proxy does since the Cloudflare Tunnel. */
function withoutVisitorAddress(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(withoutVisitorAddress);
  if (json === null || typeof json !== "object") return json;
  const entries = Object.entries(json).filter(
    ([key, value]) => !(key === "headers" && JSON.stringify(value) === JSON.stringify({ request: { set: { "X-Forwarded-For": ["{http.vars.client_ip}"] } } })),
  );
  return Object.fromEntries(entries.map(([key, value]) => [key, withoutVisitorAddress(value)]));
}

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

  /** The Caddyfile of each side, written in turn at the same path: Caddy names it in what it adapts. */
  let caddyfile = "";
  let reference = "";
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

    const shown = Bun.spawnSync(["git", "-C", REPO_ROOT, "show", `${REFERENCE}:infra/caddy/Caddyfile`], { stdout: "pipe", stderr: "pipe" });
    if (shown.exitCode !== 0) {
      throw new Error(`the reference Caddyfile, ${REFERENCE}'s, cannot be read: fetch the tags (git fetch --tags). ${shown.stderr.toString().trim()}`);
    }
    reference = localize(directive(shown.stdout.toString()));
    current = localize(readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8"));
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  test(`${REFERENCE}'s Caddyfile, and this one with the policy deploy-caddy.sh lays, give the same configuration, the bare domain aside`, () => {
    writeFileSync(policy, directive(tlsZoneContent(CLOUDFLARE_POLICY)));
    // The bare domain is this release's one change of structure: the
    // landing's block taken out of the reference, the lines that replace it
    // out of this one, and the rest must be the same configuration.
    writeFileSync(caddyfile, reference.replace(block(reference, LANDING_HEADER), ""));
    const before = adapt(caddyfile);
    for (const line of BARE_LINES) expect(current).toContain(line);
    writeFileSync(caddyfile, BARE_LINES.reduce((text, line) => text.replace(line, ""), current));
    const after = adapt(caddyfile);
    expect({ code: before.code, after: after.code }).toEqual({ code: 0, after: 0 });

    // Two differences. The first is Caddy's own: a file server hides the files
    // its block was read from, and the blocks that import the snippet were
    // read from the policy too. It lives in /etc/caddy, which no file
    // server's root reaches.
    expect(hideLists(after.json).some((list) => list.includes(policy))).toBe(true);
    expect(hideLists(before.json).some((list) => list.includes(policy))).toBe(false);
    // The other is this release's: the landing's form proxy hands its service
    // the visitor's address, as every generated block does (FORWARD_GENERATIONS
    // in bin/cli/fragment.ts), and the app's block is this release's on both
    // sides.
    expect(withoutVisitorAddress(withoutHidden(after.json, policy))).toEqual(withoutVisitorAddress(before.json!));

    // And the comparison is worth something: the zone's names, the app's
    // preview among them, are under the zone's policy, the DNS challenge's
    // or what stands in for it, and the customer domains under on demand.
    // The bare domain is not one of them any more: no block names it.
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
