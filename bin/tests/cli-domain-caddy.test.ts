import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment, IMPORT_LOCKS, ZONE_HOST } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { PORTAL_PORT } from "../cli/portal";
import { buildFragment, cookieName } from "../../api/src/locks";
import { encodeProjection, PROJECTION_VERSION, type Projection, type SiteAccess } from "../../portal/src/access";
import { guestHash } from "../../portal/src/gate";

/**
 * A site closes on every address it answers on, measured in a real Caddy in
 * front of the real portal.
 *
 * Three sites, each with its own domain:
 *
 * - `budget`, an app behind the portal, `budget.example` and its `www`;
 * - `kanban`, an app that opens with a code, `kanban.example`;
 * - `notes`, a static site that opens with a code, `notes.example`, served
 *   by the Caddyfile's nameless block from the domain table; and `brochure`,
 *   a static site that does not, `brochure.example`, served the same way.
 *
 * The blocks are the generator's and the Caddyfile's, the locks the ones the
 * gatekeeper writes, brought back to the workstation: plain HTTP on a free
 * port, temporary folders, the test portal's port, and nothing else touched.
 * The zone is `localhost`, given to Caddy as SITESOLIDE_ZONE as on the
 * machine, so a preview is `<slug>.localhost` and the domain's block announces
 * `budget.localhost` to the portal.
 *
 * Caddy runs with `admin off` and is stopped by its PID. Never `caddy stop`:
 * see the Production section of CLAUDE.md. The test skips itself where Caddy
 * is not installed.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");
const PASSWORD = "sample-portal-password";
const KANBAN_CODE = "K7M2PQ";
const NOTES_CODE = "W4XN8R";

/** Same extraction as api/tests/caddyfile.test.ts. */
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

describe.skipIf(CADDY === null)("a site's own domain, in Caddy", () => {
  const folder = mkdtempSync(join(tmpdir(), "domain-caddy-"));
  const caddyPort = freePort();
  const portalPort = freePort();
  const address = `http://127.0.0.1:${caddyPort}`;
  const accessFile = join(folder, "access.json");
  const locks = join(folder, "locks");
  const doors = join(folder, "doors");

  let budget: ReturnType<typeof Bun.serve>;
  let kanban: ReturnType<typeof Bun.serve>;
  let portal: ReturnType<typeof Bun.spawn> | null = null;
  let caddy: ReturnType<typeof Bun.spawn>;
  let writtenAt = 0;

  /** The steward's projection, filed by each site's preview, the one address it knows. */
  function project(sites: Record<string, Partial<SiteAccess>>): void {
    writtenAt += 1;
    const projection: Projection = {
      version: PROJECTION_VERSION,
      writtenAt,
      sites: Object.fromEntries(Object.entries(sites).map(([host, site]) => [host, { slug: host.split(".")[0]!, people: {}, domains: [], passwords: [], ...site }])),
    };
    writeFileSync(`${accessFile}.new`, encodeProjection(projection));
    renameSync(`${accessFile}.new`, accessFile);
  }

  /** A request towards a host, as a browser would send it to Caddy. */
  function ask(host: string, path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Host", `${host}:${caddyPort}`);
    if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
    return fetch(`${address}${path}`, { ...init, headers, redirect: "manual" });
  }

  async function signIn(host: string, password: string): Promise<Response> {
    return ask(host, "/_portal/connexion", {
      method: "POST",
      headers: { Origin: `http://${host}:${caddyPort}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ motdepasse: password, retour: "/list" }),
    });
  }

  const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0]!;

  /** The locks as the gatekeeper writes them, each stanza naming its preview's host alone. */
  function writeLocks(sites: Record<string, string>): void {
    const fragment = buildFragment(
      Object.entries(sites).map(([slug, code]) => ({ slug, host: `${slug}.localhost`, lock: true, code })),
      { doorPagesDir: doors, secure: false },
    );
    writeFileSync(join(locks, "verrous.caddy"), fragment);
  }

  /** An app's fragment, brought to the workstation: HTTP, the test port, its folders. */
  function local(manifest: Manifest): string {
    let fragment = generateFragment(manifest)!
      .replaceAll("\ttls {\n\t\ton_demand\n\t}\n", "")
      .replace(`${manifest.slug}.${ZONE_HOST} {`, `http://${manifest.slug}.localhost:${caddyPort} {`)
      .replaceAll(IMPORT_LOCKS, `import ${locks}/*.caddy`)
      .replaceAll(`/srv/sites/${manifest.slug}/public`, join(folder, manifest.slug))
      .replaceAll(`127.0.0.1:${PORTAL_PORT}`, `127.0.0.1:${portalPort}`);
    const domain = manifest.domain!.name;
    fragment = fragment.replace(`\n${domain} {`, `\nhttp://${domain}:${caddyPort} {`);
    return fragment.replace(`\nwww.${domain} {`, `\nhttp://www.${domain}:${caddyPort} {`);
  }

  beforeAll(async () => {
    const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
    Bun.spawnSync(["bun", join(REPO_ROOT, "portal", "scripts", "borrow.ts")], { stdout: "ignore" });

    for (const name of ["budget", "kanban", "notes", "brochure", "data", "locks", "blocks", "doors/kanban", "doors/notes"]) {
      mkdirSync(join(folder, name), { recursive: true });
    }
    writeFileSync(join(folder, "notes", "index.html"), "NOTES");
    writeFileSync(join(folder, "brochure", "index.html"), "BROCHURE");
    writeFileSync(join(folder, "budget", "style.css"), "body{}");
    writeFileSync(join(doors, "kanban", "index.html"), "KANBAN DOOR");
    writeFileSync(join(doors, "notes", "index.html"), "NOTES DOOR");
    writeLocks({ kanban: KANBAN_CODE, notes: NOTES_CODE });
    project({ "budget.localhost": {} });

    // The apps' fake services: they say who they are and what they received.
    budget = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => Response.json({ site: "budget", path: new URL(req.url).pathname, role: req.headers.get("x-sitesolide-role") }) });
    kanban = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => Response.json({ site: "kanban", path: new URL(req.url).pathname }) });

    const budgetManifest: Manifest = {
      slug: "budget",
      port: budget.port,
      publicDir: "public",
      start: "bun run server.ts",
      portal: true,
      domain: { name: "budget.example", active: true },
    };
    const kanbanManifest: Manifest = {
      slug: "kanban",
      port: kanban.port,
      start: "bun run server.ts",
      lock: true,
      domain: { name: "kanban.example", active: true },
    };

    // The nameless block of the static sites' domains, read from the
    // Caddyfile, with the table it imports written here. budget's old name
    // is still in it, as after a deployment that took it out of the manifest:
    // no block of budget's claims it any more.
    writeFileSync(join(folder, "domains.map"), "\tnotes.example notes\n\tbrochure.example brochure\n\told-budget.example budget\n");
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    const nameless = block(caddyfile, "https:// {")
      .replace("https:// {", `http://:${caddyPort} {`)
      .replace("\ttls {\n\t\ton_demand\n\t}\n", "")
      .replace("import /etc/caddy/domaines.map", `import ${join(folder, "domains.map")}`)
      .replace(IMPORT_LOCKS, `import ${locks}/*.caddy`)
      .replace("/srv/sites/{folder}/public", join(folder, "{folder}"))
      .replace("root /etc/caddy/sites", `root ${join(folder, "blocks")}`);
    // Where the apps' blocks lie, which tells an app from a static site.
    for (const app of ["budget", "kanban"]) writeFileSync(join(folder, "blocks", `${app}.caddy`), `# ${app}\n`);
    expect(nameless).toInclude(`import ${locks}/*.caddy`);

    writeFileSync(
      join(folder, "Caddyfile"),
      ["{", "\tadmin off", "\tauto_https off", "}", "(tls-zone) {", "}", block(caddyfile, "(commun) {"), local(budgetManifest), local(kanbanManifest), nameless].join("\n"),
    );

    portal = Bun.spawn(["bun", "run", join(REPO_ROOT, "portal", "server.ts")], {
      env: { ...process.env, PORT: String(portalPort), DATA_DIR: join(folder, "data"), PASSWORD_HASH: hash, ACCESS_FILE: accessFile, NODE_ENV: "test" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(`http://127.0.0.1:${portalPort}/sante`);
    const validation = Bun.spawnSync([CADDY!, "validate", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      env: { ...process.env, SITESOLIDE_ZONE: "localhost" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (validation.exitCode !== 0) throw new Error(`caddy validate: ${validation.stderr.toString().split("\n").slice(-3).join(" ")}`);
    caddy = Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      env: { ...process.env, SITESOLIDE_ZONE: "localhost" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(address);
  });

  afterAll(() => {
    caddy?.kill();
    portal?.kill();
    budget?.stop(true);
    kanban?.stop(true);
    rmSync(folder, { recursive: true, force: true });
  });

  describe("behind the portal", () => {
    test("the domain answers the portal's sign-in, never the site, files included", async () => {
      for (const path of ["/list", "/style.css"]) {
        const response = await ask("budget.example", path);
        expect(response.status).toBe(401);
        expect(response.headers.get("x-portal")).toBe("connexion");
      }
    });

    test("the owner's password opens the domain, with a cookie the preview does not take", async () => {
      const entry = await signIn("budget.example", PASSWORD);
      expect(entry.status).toBe(303);
      const cookie = cookieOf(entry);
      const page = await ask("budget.example", "/list", { cookie });
      expect(page.status).toBe(200);
      expect(await page.json()).toEqual({ site: "budget", path: "/list", role: "admin" });
      expect((await ask("budget.localhost", "/list", { cookie })).status).toBe(401);
    });

    test("a password access given on the site opens its domain, judged on the site's people through the block's announcement", async () => {
      const password = "sample-password-access-for-tests";
      project({ "budget.localhost": { passwords: [{ id: "AAAAAAAAAAAAAAAA", who: "alice@acme.test", hash: guestHash(password), expiresAt: null }] } });
      const entry = await signIn("budget.example", password);
      expect(entry.status).toBe(303);
      const cookie = cookieOf(entry);
      const page = await ask("budget.example", "/list", { cookie });
      expect(page.status).toBe(200);
      expect(await page.json()).toEqual({ site: "budget", path: "/list", role: "visitor" });

      // Taken off the site's people, it is out of the domain at the next request.
      project({ "budget.localhost": {} });
      expect((await ask("budget.example", "/list", { cookie })).status).toBe(401);
    });

    test("a visitor cannot choose the site the portal judges: Caddy overwrites the announcement", async () => {
      // Someone given another site sends that site's address: the domain's
      // block announces its own, and their password opens nothing here.
      const password = "sample-password-for-another-site";
      project({ "budget.localhost": {}, "roster.localhost": { passwords: [{ id: "BBBBBBBBBBBBBBBB", who: "bob@acme.test", hash: guestHash(password), expiresAt: null }] } });
      const forged = await ask("budget.example", "/_portal/connexion", {
        method: "POST",
        headers: {
          Origin: `http://budget.example:${caddyPort}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Portal-Hote": "budget.example roster.localhost",
        },
        body: new URLSearchParams({ motdepasse: password, retour: "/" }),
      });
      expect(forged.status).toBe(401);
      expect(forged.headers.get("set-cookie")).toBeNull();
    });

    test("its www sends to it, whatever the path, and reaches neither the portal nor the site", async () => {
      const response = await ask("www.budget.example", "/list?page=2");
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("https://budget.example/list?page=2");
    });
  });

  describe("with a code", () => {
    test("an app's domain answers the door page, and opens with the code, in any case of its name", async () => {
      for (const host of ["kanban.example", "KANBAN.Example", "kanban.localhost"]) {
        const closed = await ask(host, "/board");
        expect({ host, status: closed.status }).toEqual({ host, status: 401 });
        expect(await closed.text()).toInclude("KANBAN DOOR");
        const open = await ask(host, "/board", { cookie: `${cookieName("kanban")}=${KANBAN_CODE}` });
        expect({ host, status: open.status }).toEqual({ host, status: 200 });
        expect(await open.json()).toEqual({ site: "kanban", path: "/board" });
      }
      expect((await ask("kanban.example", "/board", { cookie: `${cookieName("kanban")}=${NOTES_CODE}` })).status).toBe(401);
    });

    test("the link with the key sets the cookie on the domain", async () => {
      const response = await ask("kanban.example", `/?key=${KANBAN_CODE}`);
      expect(response.status).toBe(303);
      expect(response.headers.get("set-cookie")).toStartWith(`${cookieName("kanban")}=${KANBAN_CODE};`);
    });

    test("a static site's domain closes through the nameless block, another static domain stays open", async () => {
      const closed = await ask("notes.example", "/");
      expect(closed.status).toBe(401);
      expect(await closed.text()).toInclude("NOTES DOOR");
      const open = await ask("notes.example", "/", { cookie: `${cookieName("notes")}=${NOTES_CODE}` });
      expect(open.status).toBe(200);
      expect(await open.text()).toBe("NOTES");
      const brochure = await ask("brochure.example", "/");
      expect(brochure.status).toBe(200);
      expect(await brochure.text()).toBe("BROCHURE");
    });

    test("a name the table still carries for an app, and its block no longer claims, serves none of its files", async () => {
      // budget is behind the portal: its public/ served here would skip it.
      for (const path of ["/", "/style.css"]) {
        const response = await ask("old-budget.example", path);
        expect({ path, status: response.status }).toEqual({ path, status: 404 });
        expect(await response.text()).not.toInclude("body{}");
      }
    });

    test("a domain no table carries serves nothing, and no stanza names it", async () => {
      expect((await ask("unknown.example", "/")).status).toBe(404);
    });

    test("the code taken away, the domains open again with nothing else written", async () => {
      writeLocks({});
      // Caddy reads the locks at load: started again on the same file, as a
      // reload would, through its PID.
      caddy.kill();
      await caddy.exited;
      caddy = Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
        env: { ...process.env, SITESOLIDE_ZONE: "localhost" },
        stdout: "ignore",
        stderr: "ignore",
      });
      await waitFor(address);
      expect((await ask("kanban.example", "/board")).status).toBe(200);
      expect((await ask("notes.example", "/")).status).toBe(200);
    });
  });
});
