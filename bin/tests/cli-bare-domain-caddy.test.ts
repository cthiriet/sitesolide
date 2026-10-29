import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment, ZONE_HOST } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { CLOUDFLARE_POLICY, tlsZoneContent } from "../cli/tls";
import { block, freePort, waitFor } from "./caddy-lab";

/**
 * The bare domain, in a real Caddy, now that the Caddyfile has no block of its
 * own for it: it is the domain of the project that declares the zone.
 *
 *   - a static site that declares it is served by the customer domains'
 *     block, routed by the table, with the HSTS header the old block sent;
 *   - none declaring it, it answers 404 from that same block;
 *   - an app that declares it serves it from its own block, and its www
 *     from its own block too, which wins over the wildcard's;
 *   - www.<zone> sends to the bare domain from the wildcard block, path and
 *     query kept, while the previews under the zone are served as before.
 *
 * Then the whole Caddyfile adapts with an app's block that claims the zone and
 * its www, which a block of the bare domain in the Caddyfile would have
 * refused, under a provider's policy and under manual DNS: the bare domain
 * and its www are certified on demand, never under the zone's policy.
 *
 * Caddy runs on the workstation with `admin off`, on free ports, and is
 * stopped by its PID; the adaptation starts nothing. Never `caddy stop` nor
 * `caddy start`: see the Production section of CLAUDE.md. Skipped where Caddy
 * is not installed.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");

/** A zone of two labels, so that an app that declares it gets its www, and that resolves to the loopback alone. */
const ZONE = "example.localhost";

const CADDYFILE = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");

/** A machine's folders in the test's, Caddy's TLS taken off: every block is served over plain HTTP on a free port. */
function local(text: string, folder: string): string {
  return text
    .replaceAll("\timport tls-zone\n", "")
    .replaceAll("\ttls {\n\t\ton_demand\n\t}\n", "")
    .replaceAll("/etc/caddy/locks/*.caddy", `${folder}/locks/*.caddy`)
    .replaceAll("/etc/caddy/domaines.map", `${folder}/domains.map`)
    .replaceAll("/srv/sites/", `${folder}/sites/`);
}

type Lab = { folder: string; caddy: ReturnType<typeof Bun.spawn> };

/** A Caddy serving `blocks` over the test's folder, which holds `sites` and the domain table `table`. */
async function start(blocks: (folder: string) => string[], table: string, sites: Record<string, string>, ports: number[]): Promise<Lab> {
  const folder = mkdtempSync(join(tmpdir(), "bare-caddy-"));
  for (const [site, page] of Object.entries(sites)) {
    mkdirSync(join(folder, "sites", site, "public"), { recursive: true });
    writeFileSync(join(folder, "sites", site, "public", "index.html"), page);
  }
  mkdirSync(join(folder, "locks"));
  writeFileSync(join(folder, "domains.map"), table);
  writeFileSync(
    join(folder, "Caddyfile"),
    ["{", "\tadmin off", "\tauto_https off", "}", block(CADDYFILE, "(commun) {"), ...blocks(folder)].join("\n"),
  );
  // {$SITESOLIDE_SLUG} is the label carrying the slug, as bin/deploy-caddy.sh sets it for a zone of two labels.
  const caddy = Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
    env: { ...process.env, SITESOLIDE_SLUG: "{labels.2}", SITESOLIDE_ZONE: ZONE, HOME: folder, XDG_DATA_HOME: join(folder, "data"), XDG_CONFIG_HOME: join(folder, "config") },
    stdout: "ignore",
    stderr: "ignore",
  });
  await Promise.all(ports.map((port) => waitFor(`http://127.0.0.1:${port}/`)));
  return { folder, caddy };
}

function stop(lab: Lab | undefined): void {
  lab?.caddy.kill();
  if (lab !== undefined) rmSync(lab.folder, { recursive: true, force: true });
}

/** The wildcard block of the Caddyfile, on a plain port. */
function wildcard(folder: string, port: number): string {
  return local(block(CADDYFILE, "*.{$SITESOLIDE_ZONE} {"), folder).replace("*.{$SITESOLIDE_ZONE} {", `http://*.${ZONE}:${port} {`);
}

/** The customer domains' block of the Caddyfile, on a plain port. */
function domains(folder: string, port: number): string {
  return local(block(CADDYFILE, "https:// {"), folder).replace("https:// {", `http://:${port} {`);
}

function ask(port: number, host: string, path = "/"): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: { Host: `${host}:${port}` }, redirect: "manual" });
}

describe.skipIf(CADDY === null)("the bare domain, declared by a static site, in Caddy", () => {
  const ports = { wildcard: freePort(), domains: freePort() };
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await start(
      (folder) => [wildcard(folder, ports.wildcard), domains(folder, ports.domains)],
      // What api/src/table.ts writes for a site that declares the zone: the
      // zone and its www, beside a client's domain.
      `\t${ZONE} home\n\twww.${ZONE} home\n\tclient.example client\n`,
      { home: "the home page", client: "a client's page" },
      Object.values(ports),
    );
  });
  afterAll(() => stop(lab));

  test("the bare domain serves the site the table names, with the HSTS of the old block", async () => {
    const response = await ask(ports.domains, ZONE);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the home page");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
  });

  test("a client's domain keeps no HSTS: it may move away from the machine", async () => {
    const response = await ask(ports.domains, "client.example");
    expect(await response.text()).toBe("a client's page");
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });

  test("www sends to the bare domain, path and query kept, and serves nothing", async () => {
    const response = await ask(ports.wildcard, `www.${ZONE}`, "/docs/install?from=www");
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`https://${ZONE}/docs/install?from=www`);
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(await response.text()).not.toContain("the home page");
  });

  test("the site's preview and the other previews are served as before", async () => {
    expect(await (await ask(ports.wildcard, `home.${ZONE}`)).text()).toBe("the home page");
    expect((await ask(ports.wildcard, `missing.${ZONE}`)).status).toBe(404);
  });
});

describe.skipIf(CADDY === null)("the bare domain no project declares, in Caddy", () => {
  const ports = { wildcard: freePort(), domains: freePort() };
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await start(
      (folder) => [wildcard(folder, ports.wildcard), domains(folder, ports.domains)],
      "\tclient.example client\n",
      { client: "a client's page", [ZONE]: "a folder named after the zone" },
      Object.values(ports),
    );
  });
  afterAll(() => stop(lab));

  test("answers 404, and a folder named after the zone, the old landing's, is not served", async () => {
    const response = await ask(ports.domains, ZONE);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("a folder named after the zone");
  });

  test("www still sends there", async () => {
    const response = await ask(ports.wildcard, `www.${ZONE}`);
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`https://${ZONE}/`);
  });
});

describe.skipIf(CADDY === null)("the bare domain, declared by an app, in Caddy", () => {
  const port = freePort();
  let lab: Lab | undefined;
  let service: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new Response(`the app, at ${new URL(request.url).pathname}`) });
    const manifest: Manifest = { slug: "shop", port: service.port, start: "bun run server.ts", domain: { name: ZONE, active: true } };
    lab = await start(
      (folder) => {
        // The app's three blocks and the wildcard on one port, as on the
        // machine: www is claimed by both, and the app's, more specific, wins.
        const fragment = local(generateFragment(manifest)!, folder)
          .replace(`\n${ZONE} {`, `\nhttp://${ZONE}:${port} {`)
          .replace(`\nwww.${ZONE} {`, `\nhttp://www.${ZONE}:${port} {`)
          .replace(`\nshop.${ZONE_HOST} {`, `\nhttp://shop.${ZONE}:${port} {`);
        return [fragment, wildcard(folder, port)];
      },
      `\t${ZONE} shop\n\twww.${ZONE} shop\n`,
      {},
      [port],
    );
  });
  afterAll(() => {
    stop(lab);
    service?.stop(true);
  });

  test("the bare domain reaches the app", async () => {
    const response = await ask(port, ZONE, "/orders");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the app, at /orders");
  });

  test("www is the app's block, which sends to the bare domain", async () => {
    const response = await ask(port, `www.${ZONE}`, "/orders");
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`https://${ZONE}/orders`);
  });

  test("the app's preview is served as before", async () => {
    expect(await (await ask(port, `shop.${ZONE}`, "/")).text()).toBe("the app, at /");
  });
});

describe.skipIf(CADDY === null)("the whole Caddyfile, with an app that declares the bare domain", () => {
  const WITH_MODULE = Bun.spawnSync([CADDY ?? "caddy", "list-modules"], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .split("\n")
    .some((line) => line.trim() === "dns.providers.cloudflare");
  /** The DNS directive, or one a stock Caddy reads that gives the zone a policy of its own just as well: see cli-tls-caddy.test.ts. */
  const provider = (text: string): string => (WITH_MODULE ? text : text.replace("dns cloudflare {env.CLOUDFLARE_API_TOKEN}", "key_type p384"));

  type Policy = { subjects?: string[]; on_demand?: boolean };
  let folder = "";

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "bare-adapt-"));
    const etc = join(folder, "etc");
    mkdirSync(join(etc, "sites"), { recursive: true });
    mkdirSync(join(etc, "locks"));
    const manifest: Manifest = { slug: "shop", port: 3050, publicDir: "public", start: "bun run server.ts", domain: { name: ZONE, active: true } };
    writeFileSync(join(etc, "sites", "shop.caddy"), generateFragment(manifest)!.replaceAll("/etc/caddy/", `${etc}/`));
    writeFileSync(join(etc, "domaines.map"), `\t${ZONE} shop\n\twww.${ZONE} shop\n`);
    writeFileSync(join(folder, "Caddyfile"), CADDYFILE.replaceAll("/etc/caddy/", `${etc}/`));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  function adapt(policy: string): { code: number; error: string; policies: Policy[] } {
    writeFileSync(join(folder, "etc", "tls-zone.caddy"), policy);
    const run = Bun.spawnSync([CADDY!, "adapt", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: folder, XDG_DATA_HOME: join(folder, "data"), XDG_CONFIG_HOME: join(folder, "config"), SITESOLIDE_ZONE: ZONE, SITESOLIDE_ACME_EMAIL: `ops@${ZONE}`, SITESOLIDE_SLUG: "{labels.2}" },
    });
    const json = run.exitCode === 0 ? (JSON.parse(run.stdout.toString()) as { apps?: { tls?: { automation?: { policies?: Policy[] } } } }) : null;
    return { code: run.exitCode, error: run.stderr.toString(), policies: json?.apps?.tls?.automation?.policies ?? [] };
  }

  test("a provider's policy: it adapts, the zone's policy keeps its wildcard, and the bare domain and its www are on demand", () => {
    const adapted = adapt(provider(tlsZoneContent(CLOUDFLARE_POLICY)));
    expect({ code: adapted.code, error: adapted.code === 0 ? "" : adapted.error }).toEqual({ code: 0, error: "" });
    const zone = adapted.policies.find((one) => one.subjects?.includes(`*.${ZONE}`));
    expect(zone?.on_demand).toBeUndefined();
    expect(zone?.subjects).toContain(`shop.${ZONE}`);
    expect(zone?.subjects).not.toContain(ZONE);
    expect(zone?.subjects).not.toContain(`www.${ZONE}`);
    const onDemand = adapted.policies.find((one) => one.subjects?.includes(ZONE));
    expect(onDemand?.on_demand).toBe(true);
    expect(onDemand?.subjects).toContain(`www.${ZONE}`);
  });

  test("manual DNS: it adapts, and every name is on demand", () => {
    const adapted = adapt(tlsZoneContent({ kind: "on-demand" }));
    expect({ code: adapted.code, error: adapted.code === 0 ? "" : adapted.error }).toEqual({ code: 0, error: "" });
    expect(adapted.policies.length).toBeGreaterThan(0);
    expect(adapted.policies.every((one) => one.on_demand === true)).toBe(true);
  });
});
