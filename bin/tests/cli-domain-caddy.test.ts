import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMAIN_TABLE, generateFragment, IMPORT_LOCKS, INACTIVE_ANSWER, INACTIVE_HEADER, INACTIVE_VALUE, ZONE_HOST } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { PORTAL_PORT } from "../cli/portal";
import { caddyHandshakeCommand, readCaddyHandshake, tunnelRouteProblem } from "../cli/tunnel";
import { buildFragment, cookieName } from "../../api/src/locks";
import { encodeProjection, PROJECTION_VERSION, type Projection, type SiteAccess } from "../../portal/src/access";
import { guestHash } from "../../portal/src/gate";
import { block, freePort, waitFor } from "./caddy-lab";

/**
 * A site closes on every address it answers on, and its domain answers only
 * while the domain table carries it, measured in a real Caddy in front of the
 * real portal.
 *
 * Five sites, each with its own domain:
 *
 * - `budget`, an app behind the portal, `budget.example` and its `www`;
 * - `kanban`, an app that opens with a code, `kanban.example`;
 * - `ledger`, an open app whose domain, `ledger.example` and its `www`, is
 *   switched off: the table does not carry it, and Caddy holds a certificate
 *   for both names all the same, its own authority's, as it keeps one from
 *   an earlier activation on the machine;
 * - `notes`, a static site that opens with a code, `notes.example`, served
 *   by the Caddyfile's nameless block from the domain table; and `brochure`,
 *   a static site that does not, `brochure.example`, served the same way.
 *
 * The blocks are the generator's and the Caddyfile's, the locks the ones the
 * gatekeeper writes, brought back to the workstation: plain HTTP on a free
 * port, ledger's own names over HTTPS on another, temporary folders, the
 * test portal's port, and nothing else touched. The zone is `localhost`,
 * given to Caddy as SITESOLIDE_ZONE as on the machine, so a preview is
 * `<slug>.localhost` and the domain's block announces `budget.localhost` to
 * the portal. Caddy reads the table and the locks at load: a switch is
 * measured by starting it again on the same files, as generate-domains.sh
 * reloads it.
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

describe.skipIf(CADDY === null)("a site's own domain, in Caddy", () => {
  const folder = mkdtempSync(join(tmpdir(), "domain-caddy-"));
  const caddyPort = freePort();
  const httpsPort = freePort();
  const portalPort = freePort();
  const address = `http://127.0.0.1:${caddyPort}`;
  const accessFile = join(folder, "access.json");
  const locks = join(folder, "locks");
  const doors = join(folder, "doors");
  const table = join(folder, "domains.map");
  /** The root of Caddy's own authority, which certifies ledger's names: what a verified handshake trusts here. */
  const authority = join(folder, "storage", "pki", "authorities", "local", "root.crt");

  /** The domain table as generate-domains.sh writes it, every site's domain switched on but ledger's. */
  const TABLE: Record<string, string> = {
    "budget.example": "budget",
    "www.budget.example": "budget",
    "kanban.example": "kanban",
    "notes.example": "notes",
    "brochure.example": "brochure",
    // budget's old name, as after a deployment that took it out of the
    // manifest: no block of budget's claims it any more.
    "old-budget.example": "budget",
  };

  let budget: ReturnType<typeof Bun.serve>;
  let kanban: ReturnType<typeof Bun.serve>;
  let ledger: ReturnType<typeof Bun.serve>;
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

  /** The table, written whole as generate-domains.sh installs it. */
  function writeTable(entries: Record<string, string>): void {
    writeFileSync(table, `${Object.entries(entries).map(([name, slug]) => `\t${name} ${slug}`).join("\n")}\n`);
  }

  /**
   * An app's fragment, brought to the workstation: HTTP on the test port, its
   * folders, the lab's table. `secure`: its own names over HTTPS on the other
   * port instead, certified by Caddy's own authority in place of on demand.
   */
  function local(manifest: Manifest, secure = false): string {
    let fragment = generateFragment(manifest)!
      .replaceAll("\ttls {\n\t\ton_demand\n\t}\n", secure ? "\ttls internal\n" : "")
      .replace(`${manifest.slug}.${ZONE_HOST} {`, `http://${manifest.slug}.localhost:${caddyPort} {`)
      .replaceAll(IMPORT_LOCKS, `import ${locks}/*.caddy`)
      .replaceAll(`import ${DOMAIN_TABLE}`, `import ${table}`)
      .replaceAll(`/srv/sites/${manifest.slug}/public`, join(folder, manifest.slug))
      .replaceAll(`127.0.0.1:${PORTAL_PORT}`, `127.0.0.1:${portalPort}`);
    const domain = manifest.domain!.name;
    const own = secure ? (name: string) => `https://${name}:${httpsPort}` : (name: string) => `http://${name}:${caddyPort}`;
    fragment = fragment.replace(`\n${domain} {`, `\n${own(domain)} {`);
    return fragment.replace(`\nwww.${domain} {`, `\n${own(`www.${domain}`)} {`);
  }

  /** A command's output, run without blocking: the apps' fake services answer from this very process. */
  async function output(command: string[], env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    const run = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env }) });
    const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    return { code: await run.exited, stdout, stderr };
  }

  /**
   * A request over HTTPS to ledger's names, the name resolved to the loopback
   * and its certificate verified against Caddy's authority, as curl reads it
   * on the machine: the handshake completes, a certificate is held.
   */
  async function secure(host: string, path: string): Promise<{ status: number; headers: Headers; body: string }> {
    const run = await output(["curl", "-sS", "-i", "--max-time", "10", "--cacert", authority, "--resolve", `${host}:${httpsPort}:127.0.0.1`, `https://${host}:${httpsPort}${path}`]);
    if (run.code !== 0) throw new Error(`curl https://${host}${path}: ${run.stderr.trim()}`);
    const [head = "", ...rest] = run.stdout.split("\r\n\r\n");
    const [first = "", ...fields] = head.split("\r\n");
    const headers = new Headers(fields.map((line): [string, string] => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
    return { status: Number(/^HTTP\/[\d.]+ (\d{3})/.exec(first)?.[1]), headers, body: rest.join("\r\n\r\n") };
  }

  /** What the machine reads of a name on its loopback before switching it on behind a tunnel, brought to the lab's port and authority. */
  async function machineReading(name: string) {
    const command = caddyHandshakeCommand(name)
      .replace(`'${name}:443:127.0.0.1'`, `'${name}:${httpsPort}:127.0.0.1'`)
      .replace(`'https://${name}/'`, `'https://${name}:${httpsPort}/'`);
    return readCaddyHandshake((await output(["sh", "-c", command], { PATH: process.env.PATH ?? "", CURL_CA_BUNDLE: authority })).stdout);
  }

  function startCaddy(): ReturnType<typeof Bun.spawn> {
    return Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      env: { ...process.env, SITESOLIDE_ZONE: "localhost" },
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  /** Once both ports answer, ledger's certificate issued; ten seconds at most. */
  async function waitForCaddy(): Promise<void> {
    await waitFor(address);
    for (let i = 0; i < 200; i++) {
      try {
        await secure("ledger.example", "/");
        return;
      } catch {
        await Bun.sleep(50);
      }
    }
    throw new Error("ledger.example completes no verified handshake");
  }

  /** Caddy started again on the same files, as a reload reads them again, through its PID. */
  async function restartCaddy(): Promise<void> {
    caddy.kill();
    await caddy.exited;
    caddy = startCaddy();
    await waitForCaddy();
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
    ledger = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => Response.json({ site: "ledger", path: new URL(req.url).pathname }) });

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
    // Switched off: `sitesolide domain --deactivate` wrote false and took
    // its names out of the table. Its blocks are the same either way.
    const ledgerManifest: Manifest = {
      slug: "ledger",
      port: ledger.port,
      start: "bun run server.ts",
      domain: { name: "ledger.example", active: false },
    };

    // The table, which the apps' blocks and the nameless block of the static
    // sites' domains, read from the Caddyfile, import alike.
    writeTable(TABLE);
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    const nameless = block(caddyfile, "https:// {")
      .replace("https:// {", `http://:${caddyPort} {`)
      .replace("\ttls {\n\t\ton_demand\n\t}\n", "")
      .replace(`import ${DOMAIN_TABLE}`, `import ${table}`)
      .replace(IMPORT_LOCKS, `import ${locks}/*.caddy`)
      .replace("/srv/sites/{folder}/public", join(folder, "{folder}"))
      .replace("root /etc/caddy/sites", `root ${join(folder, "blocks")}`);
    // Where the apps' blocks lie, which tells an app from a static site.
    for (const app of ["budget", "kanban", "ledger"]) writeFileSync(join(folder, "blocks", `${app}.caddy`), `# ${app}\n`);
    expect(nameless).toInclude(`import ${locks}/*.caddy`);
    expect(nameless).toInclude(`import ${table}`);

    // Automatic HTTPS for ledger's names alone, the only https:// addresses,
    // without the redirects of every other name nor the system's trust store.
    writeFileSync(
      join(folder, "Caddyfile"),
      [
        "{",
        "\tadmin off",
        "\tauto_https disable_redirects",
        "\tskip_install_trust",
        `\tstorage file_system ${join(folder, "storage")}`,
        "}",
        "(tls-zone) {",
        "}",
        block(caddyfile, "(commun) {"),
        local(budgetManifest),
        local(kanbanManifest),
        local(ledgerManifest, true),
        nameless,
      ].join("\n"),
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
    caddy = startCaddy();
    await waitForCaddy();
  }, 20_000);

  afterAll(() => {
    caddy?.kill();
    portal?.kill();
    budget?.stop(true);
    kanban?.stop(true);
    ledger?.stop(true);
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
      // Caddy reads the locks at load.
      await restartCaddy();
      expect((await ask("kanban.example", "/board")).status).toBe(200);
      expect((await ask("notes.example", "/")).status).toBe(200);
    });
  });

  describe("switched on and off by the domain table", () => {
    /** The table without these names, as generate-domains.sh writes it once their domain is switched off. */
    const without = (...names: string[]) => Object.fromEntries(Object.entries(TABLE).filter(([name]) => !names.includes(name)));

    /** The answer of a domain switched off: its block's 404, saying so and naming the zone Caddy was given, never cached. */
    function switchedOff(response: { status: number; headers: Headers }, body: string): void {
      expect(response.status).toBe(404);
      expect(response.headers.get(INACTIVE_HEADER)).toBe(`${INACTIVE_VALUE} localhost`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(body).toBe(INACTIVE_ANSWER);
    }

    test("a domain the table does not carry answers its block's 404 over the certificate Caddy holds, its www too, the preview serving", async () => {
      for (const path of ["/", "/books"]) {
        const response = await secure("ledger.example", path);
        switchedOff(response, response.body);
      }
      const www = await secure("www.ledger.example", "/books?page=2");
      switchedOff(www, www.body);
      const preview = await ask("ledger.localhost", "/books");
      expect(preview.status).toBe(200);
      expect(await preview.json()).toEqual({ site: "ledger", path: "/books" });
    });

    test("the machine's own reading of such a name lets it through the tunnel's check when the edge relays its answer, never another installation's", async () => {
      const machine = await machineReading("ledger.example");
      expect(machine).toEqual({ kind: "answered", status: 404, inactive: `${INACTIVE_VALUE} localhost` });
      // The edge relays the origin's answer as it stands: this lab's, or that
      // of another installation the record still points at, its zone another.
      const edge = await secure("ledger.example", "/");
      const reading = (inactive: string | null) => ({ name: "ledger.example", here: false, edge: true, root: String(edge.status), inactive, machine });
      expect(tunnelRouteProblem(reading(edge.headers.get(INACTIVE_HEADER)), "203.0.113.10")).toBeNull();
      expect(tunnelRouteProblem(reading(`${INACTIVE_VALUE} other-zone.invalid`), "203.0.113.10")).toContain(
        `answers the 404 of a domain switched off on another installation, "${INACTIVE_VALUE} other-zone.invalid" where this machine answers "${INACTIVE_VALUE} localhost"`,
      );
      expect(tunnelRouteProblem(reading(INACTIVE_VALUE), "203.0.113.10")).toContain("on another installation");
    });

    test("switched on, the same blocks serve the site and its www sends to it, at the next load", async () => {
      writeTable({ ...TABLE, "ledger.example": "ledger", "www.ledger.example": "ledger" });
      await restartCaddy();
      const site = await secure("ledger.example", "/books");
      expect(site.status).toBe(200);
      expect(site.headers.get(INACTIVE_HEADER)).toBeNull();
      expect(JSON.parse(site.body)).toEqual({ site: "ledger", path: "/books" });
      const www = await secure("www.ledger.example", "/books?page=2");
      expect(www.status).toBe(301);
      expect(www.headers.get("location")).toBe("https://ledger.example/books?page=2");
      expect(await machineReading("ledger.example")).toEqual({ kind: "answered", status: 200, inactive: null });
      expect((await ask("ledger.localhost", "/books")).status).toBe(200);
    });

    test("a name the table gives another site switches nothing on: each block asks for its own site", async () => {
      writeTable({ ...TABLE, "ledger.example": "kanban", "www.ledger.example": "kanban" });
      await restartCaddy();
      const response = await secure("ledger.example", "/books");
      switchedOff(response, response.body);
    });

    test("switched off, a closed app's domain answers the 404, neither its door nor its site with the door's key; the previews keep theirs", async () => {
      writeLocks({ kanban: KANBAN_CODE, notes: NOTES_CODE });
      writeTable(without("budget.example", "www.budget.example", "kanban.example"));
      await restartCaddy();
      const key = `${cookieName("kanban")}=${KANBAN_CODE}`;

      // Behind the portal: no sign-in page, and no sign-in either.
      for (const path of ["/list", "/style.css"]) {
        const response = await ask("budget.example", path);
        switchedOff(response, await response.text());
        expect(response.headers.get("x-portal")).toBeNull();
      }
      const entry = await signIn("budget.example", PASSWORD);
      switchedOff(entry, await entry.text());
      const www = await ask("www.budget.example", "/list");
      switchedOff(www, await www.text());

      // With a code: no door page, and the code opens nothing.
      for (const init of [{}, { cookie: key }]) {
        const response = await ask("kanban.example", "/board", init);
        switchedOff(response, await response.text());
      }
      const link = await ask("kanban.example", `/?key=${KANBAN_CODE}`);
      switchedOff(link, await link.text());

      // The previews, unaffected.
      const portal = await ask("budget.localhost", "/list");
      expect(portal.status).toBe(401);
      expect(portal.headers.get("x-portal")).toBe("connexion");
      expect((await ask("kanban.localhost", "/board")).status).toBe(401);
      const open = await ask("kanban.localhost", "/board", { cookie: key });
      expect(open.status).toBe(200);
      expect(await open.json()).toEqual({ site: "kanban", path: "/board" });
    });

    test("a static site's domain taken out of the table is served by no block: the nameless one answers 404, none of its files", async () => {
      const key = { cookie: `${cookieName("notes")}=${NOTES_CODE}` };
      writeTable(TABLE);
      await restartCaddy();
      expect(await (await ask("brochure.example", "/")).text()).toBe("BROCHURE");
      expect(await (await ask("notes.example", "/", key)).text()).toBe("NOTES");

      writeTable(without("brochure.example", "notes.example"));
      await restartCaddy();
      for (const [host, page] of [
        ["brochure.example", "BROCHURE"],
        ["notes.example", "NOTES"],
      ] as const) {
        for (const init of [{}, key]) {
          const response = await ask(host, "/", init);
          expect({ host, status: response.status }).toEqual({ host, status: 404 });
          const body = await response.text();
          expect(body).not.toInclude(page);
          expect(body).not.toInclude("DOOR");
        }
      }
    });
  });
});
