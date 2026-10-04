import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment, ZONE_HOST } from "../cli/fragment";
import { readManifest, validate, type Manifest } from "../cli/manifest";

/**
 * A manifest's headers, as a real Caddy serves them.
 *
 * Since the control API, whoever holds a team token writes the manifest, and
 * its `headers` were written verbatim between double quotes in the site's
 * block. Caddy substitutes `{$NAME}` with its own environment while it reads
 * the configuration, and `{env.NAME}` at each request: a header valued
 * `{$CLOUDFLARE_API_TOKEN}` served the zone's DNS token to anyone who asked.
 *
 * One Caddy, `admin off` on free ports, stopped by its PID, with a random
 * canary standing for the token in its environment:
 *
 * - a block written by hand with the line the generator used to write shows
 *   the canary in its answer: the laboratory sees a leak when there is one;
 * - the same payload in a manifest is refused by validate(), and the
 *   generator refuses to write it even past validate();
 * - the block generated from a manifest carrying real headers, a
 *   Content-Security-Policy with its single quotes first, is accepted by Caddy
 *   and serves every value exactly as written, values drawn at random among
 *   those validate() accepts included, and the canary nowhere.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");
const CANARY = `canary-${crypto.randomUUID()}`;
const SITE = "sample.localhost";
const CONTROL = "control.localhost";

const PAYLOADS = { "X-Leak": "{$CLOUDFLARE_API_TOKEN}", "X-Leak-Runtime": "{env.CLOUDFLARE_API_TOKEN}" };

const LEGITIMATE: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.example.com 'sha256-AbC+/9=='; img-src data: blob: *; frame-ancestors 'none'",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  Link: "</style.css>; rel=preload; as=style",
  "X-Note": "100% #1 & more ~ | ^ [ok] ! ? @ = + < > ;",
};

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

/** Values validate() accepts, drawn from every printable character with a fixed seed. */
function acceptedValues(count: number): string[] {
  let seed = 4102026;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const alphabet = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), "{$", "{env."];
  const values: string[] = [];
  while (values.length < count) {
    const value = Array.from({ length: 1 + Math.floor(next() * 20) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("").trim();
    if (value !== "" && validate({ slug: "x", publicDir: "p", headers: { "X-Fuzz": value } }).length === 0) values.push(value);
  }
  return values;
}

describe.skipIf(CADDY === null)("a manifest's headers, in a real Caddy", () => {
  const folder = mkdtempSync(join(tmpdir(), "headers-caddy-"));
  const caddyPort = freePort();
  const fuzz = acceptedValues(60);
  let service: ReturnType<typeof Bun.serve>;
  let caddy: ReturnType<typeof Bun.spawn>;

  const get = (host: string, path = "/") => fetch(`http://127.0.0.1:${caddyPort}${path}`, { headers: { Host: `${host}:${caddyPort}` } });

  beforeAll(async () => {
    for (const name of ["public", "locks"]) mkdirSync(join(folder, name));
    writeFileSync(join(folder, "public", "style.css"), "body{}");
    service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("service") });

    const headers = { ...LEGITIMATE, ...Object.fromEntries(fuzz.map((value, rank) => [`X-Fuzz-${rank}`, value])) };
    const manifest: Manifest = { slug: "sample", port: service.port, publicDir: "public", start: "/usr/local/bin/bun run server.ts", headers };
    expect(validate(manifest)).toEqual([]);
    const local = generateFragment(manifest)!
      .replace(`sample.${ZONE_HOST} {`, `http://${SITE}:${caddyPort} {`)
      .replace("import /etc/caddy/locks/*.caddy", `import ${folder}/locks/*.caddy`)
      .replaceAll("/srv/sites/sample/public", join(folder, "public"));

    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    writeFileSync(
      join(folder, "Caddyfile"),
      [
        "{",
        "\tadmin off",
        "\tauto_https off",
        "}",
        "(tls-zone) {",
        "}",
        block(caddyfile, "(commun) {"),
        local,
        "# The control: the very lines the generator wrote before validate()",
        "# refused placeholders, written by hand.",
        `http://${CONTROL}:${caddyPort} {`,
        ...Object.entries(PAYLOADS).map(([name, value]) => `\theader ${name} "${value}"`),
        '\trespond "control"',
        "}",
      ].join("\n"),
    );

    caddy = Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: folder, CLOUDFLARE_API_TOKEN: CANARY },
      stdout: "ignore",
      stderr: Bun.file(join(folder, "caddy.log")),
    });
    for (let i = 0; i < 100; i++) {
      try {
        await get(CONTROL);
        return;
      } catch {
        await Bun.sleep(50);
      }
    }
    throw new Error(`Caddy did not start: ${readFileSync(join(folder, "caddy.log"), "utf8")}`);
  });

  afterAll(() => {
    caddy?.kill();
    service?.stop(true);
    rmSync(folder, { recursive: true, force: true });
  });

  test("the laboratory sees a leak: written by hand, both placeholders serve the canary", async () => {
    const response = await get(CONTROL);
    expect(await response.text()).toBe("control");
    expect(response.headers.get("x-leak")).toBe(CANARY);
    expect(response.headers.get("x-leak-runtime")).toBe(CANARY);
  });

  test("the same payload in a manifest is refused before generation, and never generated", () => {
    const raw = JSON.stringify({ slug: "sample", port: service.port, publicDir: "public", start: "/usr/local/bin/bun run server.ts", headers: PAYLOADS });
    const { manifest, errors } = readManifest(raw);
    expect(errors.filter((error) => error.startsWith("headers: the value of X-Leak"))).toHaveLength(2);
    expect(() => generateFragment(manifest!)).toThrow("never written into a Caddy block");
  });

  test("a generated block serves real headers exactly as written, on the service and on a file", async () => {
    for (const path of ["/", "/style.css"]) {
      const response = await get(SITE, path);
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries(LEGITIMATE)) expect(response.headers.get(name)).toBe(value);
    }
  });

  test("whatever validate() accepts reaches the visitor as written, never as a placeholder", async () => {
    const response = await get(SITE);
    fuzz.forEach((value, rank) => expect(response.headers.get(`X-Fuzz-${rank}`)).toBe(value));
    const served = [...response.headers.values()].join("\n");
    expect(served).not.toContain(CANARY);
  });
});
