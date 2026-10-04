import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment, ZONE_HOST } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";

/**
 * `.git` and the `.env` files, in a real Caddy: the file servers of a
 * generated block and of the Caddyfile's wildcard, landing and customer-domain
 * blocks answer 404 for them, at any depth, and serve every other file as
 * before.
 *
 * The CLI no longer sends them (NEVER_SENT), but a `public/` that was a clone
 * may have left them on the machine before, and that is what `hide` is for.
 * Its semantics are measured here rather than read in the documentation: a
 * name without a separator is matched against every component of the path on
 * disk, so `.git` must hide `.git/config`, and a dotted name that is neither
 * must still serve.
 *
 * Caddy runs on the workstation with `admin off`, on free ports, and is
 * stopped by its PID. Never `caddy stop`: see the Production section of
 * CLAUDE.md. The test skips itself where Caddy is not installed.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");

/** Same extraction as api/tests/caddyfile.test.ts: a block, by its header, braces counted. */
function block(text: string, header: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith(header));
  if (first === -1) throw new Error(`block not found: ${header}`);
  const body: string[] = [];
  let depth = 0;
  for (const line of lines.slice(first)) {
    const code = line.trimStart().startsWith("#") ? "" : line;
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    body.push(line);
    if (depth === 0 && body.length > 1) break;
  }
  return body.join("\n");
}

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`nothing answers on ${url}`);
}

/** A public folder holding what must never be served next to what must. */
function lay(folder: string): void {
  const files: Record<string, string> = {
    "index.html": "<h1>served</h1>",
    "style.css": "body{}",
    "nested/page.html": "<p>nested</p>",
    ".well-known/security.txt": "Contact: mailto:ops@test-zone.invalid",
    ".git/config": "[remote]\nurl = https://token@example.invalid/repo.git",
    ".git/HEAD": "ref: refs/heads/main",
    ".env": "SECRET=1",
    ".env.production": "SECRET=2",
    "config/.env.local": "SECRET=3",
    "nested/.git/config": "[core]",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
}

const HIDDEN = ["/.git/config", "/.git/HEAD", "/.git/", "/.env", "/.env.production", "/config/.env.local", "/nested/.git/config"];
const SERVED = ["/", "/index.html", "/style.css", "/nested/page.html", "/.well-known/security.txt"];

describe.skipIf(CADDY === null)("the file servers hide .git and .env, in Caddy", () => {
  const folder = mkdtempSync(join(tmpdir(), "hidden-caddy-"));
  const ports = { block: freePort(), wildcard: freePort(), landing: freePort(), domain: freePort() };
  let caddy: ReturnType<typeof Bun.spawn>;
  let service: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    for (const site of ["app", "static", "landing", "client"]) lay(join(folder, "sites", site, "public"));
    mkdirSync(join(folder, "locks"));
    writeFileSync(join(folder, "domains.map"), "client.localhost client\n");

    // The app's service: anything that is not a file reaches it.
    service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("from the service") });
    const manifest: Manifest = { slug: "app", port: service.port, publicDir: "public", start: "bun run server.ts" };
    const local = (text: string): string =>
      text
        .replace("import tls-zone", "")
        .replace("import /etc/caddy/locks/*.caddy", `import ${folder}/locks/*.caddy`)
        .replace("import /etc/caddy/domaines.map", `import ${folder}/domains.map`)
        .replaceAll("/srv/sites/", `${folder}/sites/`);
    const fragment = local(generateFragment(manifest)!).replace(`app.${ZONE_HOST} {`, `http://app.localhost:${ports.block} {`);

    // The Caddyfile's own blocks, as they stand, on local addresses: only the
    // header, the TLS policy and the paths change.
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    const wildcard = local(block(caddyfile, "*.{$SITESOLIDE_ZONE} {")).replace("*.{$SITESOLIDE_ZONE} {", `http://*.localhost:${ports.wildcard} {`);
    const landing = local(block(caddyfile, "{$SITESOLIDE_ZONE}, www.{$SITESOLIDE_ZONE} {"))
      .replace("{$SITESOLIDE_ZONE}, www.{$SITESOLIDE_ZONE} {", `http://landing.localhost:${ports.landing} {`)
      .replace(`${folder}/sites/{$SITESOLIDE_ZONE}/public`, join(folder, "sites", "landing", "public"));
    const domain = local(block(caddyfile, "https:// {"))
      .replace("https:// {", `http://:${ports.domain} {`)
      .replace(/\ttls \{\n\t\ton_demand\n\t\}\n/, "");
    writeFileSync(
      join(folder, "Caddyfile"),
      ["{", "\tadmin off", "\tauto_https off", "}", block(caddyfile, "(commun) {"), fragment, wildcard, landing, domain].join("\n"),
    );

    // {$SITESOLIDE_SLUG} is the label carrying the slug, as bin/deploy-caddy.sh sets it.
    caddy = Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      env: { ...process.env, SITESOLIDE_SLUG: "{labels.1}", SITESOLIDE_ZONE: "localhost", HOME: folder, XDG_DATA_HOME: join(folder, "data"), XDG_CONFIG_HOME: join(folder, "config") },
      stdout: "ignore",
      stderr: "ignore",
    });
    await Promise.all(Object.values(ports).map((port) => waitFor(`http://127.0.0.1:${port}/`)));
  });

  afterAll(() => {
    caddy?.kill();
    service?.stop(true);
    rmSync(folder, { recursive: true, force: true });
  });

  function ask(port: number, host: string, path: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, { headers: { Host: `${host}:${port}` }, redirect: "manual" });
  }

  const SITES = [
    ["a generated app block", () => ports.block, "app.localhost"],
    ["the wildcard block", () => ports.wildcard, "static.localhost"],
    ["the landing's block", () => ports.landing, "landing.localhost"],
    ["the customer domains' block", () => ports.domain, "client.localhost"],
  ] as const;

  for (const [name, port, host] of SITES) {
    test(`${name}: .git and .env answer 404 at any depth`, async () => {
      for (const path of HIDDEN) {
        const response = await ask(port(), host, path);
        const body = await response.text();
        expect({ path, leaked: body.includes("SECRET") || body.includes("[remote]") || body.includes("[core]") || body.includes("refs/heads") }).toEqual({ path, leaked: false });
        // A generated block hands what is not a file to its service: a
        // directory's bare path, `/.git/`, reaches it, and the answer is the
        // service's own, never the folder.
        const answer = response.status === 404 ? 404 : body === "from the service" ? "the service" : response.status;
        expect({ path, answer }).toEqual({ path, answer: name === "a generated app block" && path.endsWith("/") ? "the service" : 404 });
      }
    });

    test(`${name}: every other file is served as before`, async () => {
      for (const path of SERVED) {
        const response = await ask(port(), host, path);
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
      }
    });
  }
});
