import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { block, freePort, waitFor } from "./caddy-lab";

/**
 * The wildcard block serves a slug's folder and nothing else, in a real Caddy,
 * over HTTP/2.
 *
 * Its root is built from the host's label, `/srv/sites/<label>/public`. Over
 * HTTP/2 and HTTP/3, Caddy up to 2.11.7 accepts a host that holds a slash,
 * which HTTP/1.1 refuses with a 400: `finance/.<zone>` served the public/ of
 * an app behind its portal, its own block never asked, and a longer label any
 * folder named public deeper down (GHSA-r766-rf9f-588h, met on production on
 * 5 November 2026). The block refuses a label that is not a slug, and an
 * app's slug, whose names are its own block's.
 *
 * HTTP/2 in clear text (h2c), which curl speaks with prior knowledge and
 * Bun's fetch does not: the test skips itself without Caddy, or without a curl
 * that speaks HTTP/2. Caddy runs with `admin off`, on a free port, and is
 * stopped by its PID. Never `caddy stop`: see the Production section of
 * CLAUDE.md.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");
const CURL = Bun.which("curl");
const H2 = CURL !== null && /\bHTTP2\b/.test(Bun.spawnSync([CURL, "-V"]).stdout.toString());

/** What one curl request over h2c brings back: status, body, and the HSTS header. */
type Answer = { status: number; body: string; hsts: string };

describe.skipIf(CADDY === null || !H2)("the wildcard block serves a slug's folder alone, over HTTP/2, in Caddy", () => {
  const folder = mkdtempSync(join(tmpdir(), "wildcard-label-"));
  const port = freePort();
  let caddy: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    const files: Record<string, string> = {
      // A static site, which the wildcard serves.
      "sites/notes/public/index.html": "the notes",
      // An app's public/, which only its own block serves, behind its portal.
      "sites/ledger/public/plan.js": "the ledger's script",
      // A folder named public in an app's sources.
      "sites/ledger/app/src/public/page.tsx": "the ledger's sources",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(folder, path, ".."), { recursive: true });
      writeFileSync(join(folder, path), content);
    }
    // The ledger is an app: its block is in place, and claims its own names.
    mkdirSync(join(folder, "etc", "sites"), { recursive: true });
    writeFileSync(join(folder, "etc", "sites", "ledger.caddy"), "");
    mkdirSync(join(folder, "locks"));

    // The Caddyfile's wildcard block as it stands, on a local address: only
    // the header, the TLS policy and the paths change.
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    const wildcard = block(caddyfile, "*.{$SITESOLIDE_ZONE} {")
      .replace("\timport tls-zone\n", "")
      .replace("import /etc/caddy/locks/*.caddy", `import ${folder}/locks/*.caddy`)
      .replaceAll("/etc/caddy/sites", `${folder}/etc/sites`)
      .replaceAll("/srv/sites/", `${folder}/sites/`)
      .replace("*.{$SITESOLIDE_ZONE} {", `http://*.localhost:${port} {`);
    writeFileSync(
      join(folder, "Caddyfile"),
      ["{", "\tadmin off", "\tauto_https off", "\tservers {", "\t\tprotocols h1 h2c", "\t}", "}", block(caddyfile, "(commun) {"), wildcard].join("\n"),
    );
    // {$SITESOLIDE_SLUG} is the label carrying the slug, as bin/deploy-caddy.sh sets it.
    caddy = Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      env: { ...process.env, SITESOLIDE_SLUG: "{labels.1}", SITESOLIDE_ZONE: "localhost", HOME: folder, XDG_DATA_HOME: join(folder, "data"), XDG_CONFIG_HOME: join(folder, "config") },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(`http://127.0.0.1:${port}/`);
  });

  afterAll(() => {
    caddy?.kill();
    rmSync(folder, { recursive: true, force: true });
  });

  /** One request over h2c, the host as the :authority. */
  function ask(host: string, path: string): Answer {
    const marker = "\n--status--";
    const run = Bun.spawnSync([CURL!, "-s", "--http2-prior-knowledge", "-H", `Host: ${host}:${port}`, "-w", `${marker}%{http_code} %header{strict-transport-security}`, `http://127.0.0.1:${port}${path}`]);
    const output = run.stdout.toString();
    const at = output.lastIndexOf(marker);
    const [status, ...hsts] = output.slice(at + marker.length).split(" ");
    return { status: Number(status), body: output.slice(0, at), hsts: hsts.join(" ") };
  }

  test("a static site under the zone is served, with HSTS", () => {
    const answer = ask("notes.localhost", "/");
    expect(answer).toEqual({ status: 200, body: "the notes", hsts: "max-age=31536000" });
  });

  /**
   * A host holding a slash: the block's 404 on a Caddy that accepts it, or no
   * answer at all from Caddy 2.11.8 on, which resets the stream before any
   * route sees it (curl's status 0). Never 200, never a byte of the folder.
   */
  function refused(host: string, path: string, content: string): { host: string; refused: boolean; leaked: boolean } {
    const answer = ask(host, path);
    return { host, refused: answer.status === 404 || answer.status === 0, leaked: answer.body.includes(content) };
  }

  test("a host whose label holds a slash reaches no app's public/", () => {
    // The one label the wildcard matches, refused there; and hosts of more
    // labels, which it does not match: this laboratory then answers Caddy's
    // empty 200 where the machine's nameless block answers 404, and either
    // way nothing of the folder.
    expect(refused("ledger/.localhost", "/plan.js", "the ledger")).toEqual({ host: "ledger/.localhost", refused: true, leaked: false });
    for (const host of ["./ledger/.localhost", "notes/../ledger.localhost"]) {
      expect({ host, body: ask(host, "/plan.js").body }).toEqual({ host, body: "" });
    }
  });

  test("nor any folder named public deeper down", () => {
    const host = "ledger/app/src.localhost";
    expect(refused(host, "/page.tsx", "the ledger")).toEqual({ host, refused: true, leaked: false });
  });

  test("a label that is not a slug serves nothing, even one naming a static site's folder", () => {
    for (const host of ["notes/.localhost", "Notes_.localhost", "-notes.localhost"]) {
      expect(refused(host, "/", "the notes")).toEqual({ host, refused: true, leaked: false });
    }
    // Without a slash, every Caddy lets it reach the block: the block's own 404.
    expect(ask("Notes_.localhost", "/").status).toBe(404);
  });

  test("an app's slug reaching the wildcard serves nothing: its names are its own block's", () => {
    const answer = ask("ledger.localhost", "/plan.js");
    expect({ status: answer.status, leaked: answer.body.includes("the ledger") }).toEqual({ status: 404, leaked: false });
  });
});
