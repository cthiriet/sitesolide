import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment, ZONE_HOST } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { PORTAL_PORT } from "../cli/portal";
import { deriveKey, issueToken } from "../../portal/src/gate";

/**
 * The generated fragment, in a real Caddy, in front of the real portal.
 *
 * The tests of cli-fragment.test.ts read the text; this one runs it. What the
 * door promises hangs only on the order in which Caddy sorts the directives,
 * and an order is measured, not read back: one `handle` slipped into the
 * stanza, or one `route`, and the site would be served without the portal
 * having been consulted.
 *
 * Caddy runs on the workstation with `admin off`, on a free port, and is
 * stopped by its PID. Never `caddy stop`: see the Production section of
 * CLAUDE.md. The test skips itself where Caddy is not installed.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");
const PASSWORD = "sample-portal-password";
const HOST = "sample.localhost";

/** Same extraction as api/tests/caddyfile.test.ts, to read the real `(commun)`. */
function block(text: string, header: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith(header));
  if (first === -1) throw new Error(`block not found: `);
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

describe.skipIf(CADDY === null)("the fragment of a protected site, in Caddy", () => {
  const folder = mkdtempSync(join(tmpdir(), "portal-caddy-"));
  const caddyPort = freePort();
  const portalPort = freePort();
  const address = `http://127.0.0.1:${caddyPort}`;
  const origin = `http://${HOST}:${caddyPort}`;

  let site: ReturnType<typeof Bun.serve>;
  let portal: ReturnType<typeof Bun.spawn> | null = null;
  let caddy: ReturnType<typeof Bun.spawn>;
  let hash = "";

  async function startPortal(): Promise<void> {
    portal = Bun.spawn(["bun", "run", join(REPO_ROOT, "portal", "server.ts")], {
      env: {
        ...process.env,
        PORT: String(portalPort),
        DATA_DIR: join(folder, "data"),
        PASSWORD_HASH: hash,
        NODE_ENV: "test",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(`http://127.0.0.1:${portalPort}/sante`);
  }

  /** A request towards the site, as a browser would send it to Caddy. */
  function ask(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Host", `${HOST}:${caddyPort}`);
    if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
    return fetch(`${address}${path}`, { ...init, headers: headers, redirect: "manual" });
  }

  async function signIn(): Promise<string> {
    const response = await ask("/_portal/connexion", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ motdepasse: PASSWORD, retour: "/list" }),
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  beforeAll(async () => {
    hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
    Bun.spawnSync(["bun", join(REPO_ROOT, "portal", "scripts", "borrow.ts")], { stdout: "ignore" });

    mkdirSync(join(folder, "public"));
    mkdirSync(join(folder, "locks"));
    mkdirSync(join(folder, "data"));
    writeFileSync(join(folder, "public", "style.css"), "body{}");
    writeFileSync(join(folder, "public", "favicon.ico"), "ICO");

    // The site's fake service: it says what it received.
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => Response.json({ site: new URL(req.url).pathname, method: req.method }),
    });

    const manifest: Manifest = {
      slug: "sample",
      port: site.port,
      publicDir: "public",
      start: "bun run server.ts",
      portal: true,
      portalExempt: ["/webhook/*"],
    };

    // The fragment as the CLI writes it, brought back to the workstation:
    // local address over HTTP, temporary folders, port of the test portal.
    // Nothing else is touched, and above all not the order of the directives.
    const fragment = generateFragment(manifest)!
      .replace(`sample.${ZONE_HOST} {`, `http://${HOST}:${caddyPort} {`)
      .replace("import /etc/caddy/locks/*.caddy", `import ${folder}/locks/*.caddy`)
      .replaceAll("/srv/sites/sample/public", join(folder, "public"))
      .replaceAll(`127.0.0.1:${PORTAL_PORT}`, `127.0.0.1:${portalPort}`);

    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    writeFileSync(
      join(folder, "Caddyfile"),
      ["{", "\tadmin off", "\tauto_https off", "}", "(tls-zone) {", "}", block(caddyfile, "(commun) {"), fragment].join(
        "\n",
      ),
    );

    await startPortal();
    caddy = Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(address);
  });

  afterAll(() => {
    caddy?.kill();
    portal?.kill();
    site?.stop(true);
    rmSync(folder, { recursive: true, force: true });
  });

  test("without a cookie, the login page in 401, never the site", async () => {
    const response = await ask("/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("x-portal")).toBe("connexion");
    const page = await response.text();
    expect(page).toInclude('name="retour" value="/list"');
    expect(page).toInclude("This site is private.");
  });

  test("the files of public/ are closed too", async () => {
    expect((await ask("/style.css")).status).toBe(401);
  });

  test("the login page served at the icon's address is not frozen for a year", async () => {
    // (commun) lays an immutable cache on *.ico by default: it is the trap of
    // the lock's door page, measured and documented in api/src/locks.ts.
    const response = await ask("/favicon.ico");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a wrong password leaves the door closed", async () => {
    const response = await ask("/_portal/connexion", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ motdepasse: "wrong", retour: "/" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("the right password opens the site, files and service", async () => {
    const cookie = await signIn();
    const page = await ask("/list", { cookie });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ site: "/list", method: "GET" });
    expect((await ask("/style.css", { cookie })).status).toBe(200);
  });

  test("a POST coming from another origin is refused, the site's one goes through", async () => {
    const cookie = await signIn();
    const elsewhere = await ask("/api/x", { method: "POST", cookie, headers: { Origin: "http://agency.localhost" } });
    expect(elsewhere.status).toBe(403);
    const here = await ask("/api/x", { method: "POST", cookie, headers: { Origin: origin } });
    expect(here.status).toBe(200);
  });

  test("an X-Portal-Hote forged by the visitor is overwritten by Caddy", async () => {
    // The test cookie is signed for sample.localhost. If the visitor could
    // choose the host announced to the portal, he could also have a cookie
    // obtained elsewhere validated.
    const cookie = await signIn();
    const response = await ask("/list", { cookie, headers: { "X-Portal-Hote": "other.localhost" } });
    expect(response.status).toBe(200);

    // And the other way round: an authentic cookie, signed by this same portal
    // for another host, does not go through even accompanied by the host that
    // suits it.
    const key = deriveKey(new Uint8Array(readFileSync(join(folder, "data", "key"))), hash)!;
    const elsewhere = `portal=${issueToken(key, "other.localhost", Math.floor(Date.now() / 1000) + 60)}`;
    const forged = await ask("/list", { cookie: elsewhere, headers: { "X-Portal-Hote": "other.localhost" } });
    expect(forged.status).toBe(401);
  });

  test("an exempted path goes to the site without asking anything", async () => {
    const response = await ask("/webhook/inbound", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ site: "/webhook/inbound", method: "POST" });
  });

  /**
   * A request as curl sends it with --path-as-is: a browser, and fetch, would
   * clean the path before leaving, which the one trying to get through does
   * not do.
   */
  async function raw(path: string, cookie?: string): Promise<{ code: string; body: string }> {
    // Asynchronous, and that is not a detail: the fake site lives in this
    // process, and a spawnSync would freeze the loop that must answer it.
    const r = Bun.spawn([
      "curl", "-s", "--max-time", "5", "--path-as-is", "-w", "\\n%{http_code}",
      "-H", `Host: ${HOST}:${caddyPort}`,
      ...(cookie === undefined ? [] : ["-H", `Cookie: ${cookie}`]),
      `${address}${path}`,
    ], { stdout: "pipe" });
    const output = await new Response(r.stdout).text();
    const end = output.lastIndexOf("\n");
    return { body: output.slice(0, end), code: output.slice(end + 1) };
  }

  test("a path that Caddy and the service would read differently never reaches the service", async () => {
    // Caddy decodes %2f and cleans the .. before comparing to the exemptions;
    // the service routes on the raw path. Without a refusal, this path would
    // be exempted in Caddy's eyes and routed by the service towards /api/x/...
    // without a cookie. Without a cookie, the portal may answer before the
    // refusal, when Caddy does not take the path for an exemption: 401 is as
    // closed as 400. With a good cookie, only the refusal remains.
    const cookie = await signIn();
    for (const path of [
      "/api/x%2f..%2f..%2fwebhook/y",
      "/api/x%2F..%2F..%2Fwebhook/y",
      "/api/x/%2e%2e/%2e%2e/webhook/y",
      "/api/x%5c..%5c..%5cwebhook/y",
      "/api/x/../../webhook/y",
      "/api/./x/../../webhook/y",
      "//webhook/y",
    ]) {
      const anonymous = await raw(path);
      expect({ path, closed: ["400", "401"].includes(anonymous.code) }).toEqual({ path, closed: true });
      // The key that the fake service writes, and not the bare word: the login
      // page contains the word site as well.
      expect(anonymous.body).not.toInclude('"site":');
      const signedIn = await raw(path, cookie);
      expect({ path, code: signedIn.code }).toEqual({ path, code: "400" });
    }
  });

  test("a %2F in the query string, for its part, goes through", async () => {
    const cookie = await signIn();
    const { code, body } = await raw("/list?retour=%2Fother", cookie);
    expect(code).toBe("200");
    expect(body).toInclude("/list");
  });

  /** The dashboard, as it speaks to the portal: directly, without going through Caddy. */
  function admin(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${portalPort}${path}`, init);
  }

  test("a guest access opens the site, and its revocation closes it again at the next request", async () => {
    const created = await admin("/admin/guests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: HOST, label: "Alice", durationS: 24 * 3600 }),
    });
    expect(created.status).toBe(201);
    const { guest, password } = (await created.json()) as { guest: { id: string }; password: string };

    const entry = await ask("/_portal/connexion", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ motdepasse: password, retour: "/list" }),
    });
    expect(entry.status).toBe(303);
    expect(entry.headers.get("set-cookie")).toInclude("Max-Age=86400;");
    const cookie = (entry.headers.get("set-cookie") ?? "").split(";")[0]!;

    const page = await ask("/list", { cookie });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ site: "/list", method: "GET" });
    expect((await ask("/style.css", { cookie })).status).toBe(200);

    expect((await admin(`/admin/invites/${guest.id}`, { method: "DELETE" })).status).toBe(204);
    const after = await ask("/list", { cookie });
    expect(after.status).toBe(401);
    expect(await after.text()).toInclude("no longer valid");
  });

  test("the administration is never reached through the site: Caddy does not relay it", async () => {
    // Without a cookie, the door; with one, the request goes to the site's
    // service, never to the portal.
    expect((await ask("/admin/guests")).status).toBe(401);
    const cookie = await signIn();
    const response = await ask("/admin/guests", { cookie });
    expect(await response.json()).toEqual({ site: "/admin/guests", method: "GET" });
    // Nor by a detour under /_portal/, which the ambiguous paths rule refuses.
    expect((await raw("/_portal/../admin/guests", cookie)).code).toBe("400");
    expect((await raw("/_portal/%2e%2e/admin/guests", cookie)).code).toBe("400");
  });

    test("a restart of the portal makes it wait, it does not cut", async () => {
    const cookie = await signIn();
    portal!.kill();
    await portal!.exited;
    const pending = ask("/list", { cookie });
    await Bun.sleep(500);
    await startPortal();
    expect((await pending).status).toBe(200);
  });

  test("with the portal stopped, Caddy answers 502 and serves nothing", async () => {
    const cookie = await signIn();
    portal!.kill();
    await portal!.exited;
    portal = null;
    const response = await ask("/list", { cookie });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toInclude("/list");
  }, 15_000);
});
