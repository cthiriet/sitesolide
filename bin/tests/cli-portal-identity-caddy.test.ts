import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMAIN_TABLE, generateFragment, ZONE_HOST } from "../cli/fragment";
import { readManifest, type Manifest } from "../cli/manifest";
import { PORTAL_PORT } from "../cli/portal";
import { encodeProjection, PROJECTION_VERSION, type Projection, type SiteAccess } from "../../portal/src/access";
import { guestHash } from "../../portal/src/gate";
import { block, freePort, waitFor } from "./caddy-lab";

/**
 * Who is in, as the site behind a real Caddy learns it.
 *
 * cli-portal-caddy.test.ts proves the door opens and closes. This one proves
 * what the site receives once it is open: the portal's `X-Sitesolide-*`
 * headers, and never the visitor's. Caddy sorts `request_header` after
 * `forward_auth`, so the taking off only happens first inside the stanza's
 * `route`; and Caddy only copies a header the portal's answer carries, so
 * without the taking off, the owner's password, which names nobody, would
 * carry the visitor's `X-Sitesolide-User` to the site. Measured here, for
 * every path the block serves: the service, a file, an exempted path.
 *
 * Four sites in one Caddy: the protected site as the CLI generates it now, a
 * second one as the release before identities generated it, an open site
 * with its customer domain, and the portal's own block, from
 * portal/sitesolide.json. The portal is its real server.ts, who may open a
 * site the steward's projection, which the test writes as the steward does.
 * Caddy runs with `admin off` on free ports, stopped by its PID.
 *
 * The underscore spellings, `X_Sitesolide_User`, which some app servers read
 * as the dash form, never arrive: Caddy 2.11.4 drops such a header on
 * arrival. The test sends them all the same, and puts them on inside Caddy
 * too, ahead of the strip, in Go's canonical case: that is what a Caddy that
 * kept them would carry, and what the strip has to take off.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CADDY = Bun.which("caddy");
const PASSWORD = "sample-portal-password";
const SITE = "sample.localhost";
const LEGACY = "legacy.localhost";
const OPEN = "open.localhost";
const OPEN_DOMAIN = "open-agency.localhost";
const PORTAL_HOST = "portal.localhost";
const FORGED = {
  "X-Sitesolide-User": "ceo@acme.test",
  "x-sitesolide-user-name": "The CEO",
  "X-SITESOLIDE-ROLE": "admin",
  "X-Sitesolide-Impersonate": "yes",
  X_Sitesolide_User: "ceo@acme.test",
  "x-sitesolide_role": "admin",
  "X_SITESOLIDE-ROLE": "admin",
};

/** The underscore spellings as Go canonicalises them, put on inside Caddy ahead of everything. */
const INJECTED = [
  "\trequest_header X_sitesolide_user ceo@acme.test",
  "\trequest_header X-Sitesolide_role admin",
  '\trequest_header X_sitesolide-User-Name "The CEO"',
];

describe.skipIf(CADDY === null)("the identity headers, in Caddy", () => {
  const folder = mkdtempSync(join(tmpdir(), "portal-identity-caddy-"));
  const caddyPort = freePort();
  const portalPort = freePort();
  const address = `http://127.0.0.1:${caddyPort}`;

  let site: ReturnType<typeof Bun.serve>;
  let legacySite: ReturnType<typeof Bun.serve>;
  let openSite: ReturnType<typeof Bun.serve>;
  let portal: ReturnType<typeof Bun.spawn> | null = null;
  let caddy: ReturnType<typeof Bun.spawn>;

  /** What a fake service received: its path, and every header naming sitesolide, any spelling, lowercased. */
  function echo(name: string) {
    return Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const identity: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          if (key.includes("sitesolide")) identity[key] = value;
        });
        return Response.json({ [name]: new URL(req.url).pathname, identity });
      },
    });
  }

  /** One browser's cookies, by host without port. */
  class Browser {
    jars = new Map<string, Map<string, string>>();

    keep(host: string, response: Response): void {
      const jar = this.jars.get(host) ?? new Map<string, string>();
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(";").map((part) => part.trim());
        const at = pair!.indexOf("=");
        if (attributes.includes("Max-Age=0") || pair!.slice(at + 1) === "") jar.delete(pair!.slice(0, at));
        else jar.set(pair!.slice(0, at), pair!.slice(at + 1));
      }
      this.jars.set(host, jar);
    }

    /**
     * A request as the browser sends it. The sites and the portal's host go to
     * Caddy, which tells them apart by Host.
     */
    async get(url: string, init: RequestInit = {}): Promise<Response> {
      const target = new URL(url);
      const viaCaddy = [SITE, LEGACY, OPEN, OPEN_DOMAIN, PORTAL_HOST].includes(target.hostname);
      const headers = new Headers(init.headers);
      const jar = this.jars.get(target.hostname);
      if (jar !== undefined && jar.size > 0) {
        headers.set("Cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
      }
      if (viaCaddy) headers.set("Host", `${target.hostname}:${caddyPort}`);
      const response = await fetch(viaCaddy ? `${address}${target.pathname}${target.search}` : url, {
        ...init,
        headers,
        redirect: "manual",
      });
      this.keep(target.hostname, response);
      return response;
    }

    async signInWithPassword(host: string): Promise<void> {
      const response = await this.get(`http://${host}/_portal/connexion`, {
        method: "POST",
        headers: { Origin: `http://${host}:${caddyPort}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ motdepasse: PASSWORD, retour: "/" }),
      });
      expect(response.status).toBe(303);
    }
  }

  async function received(browser: Browser, path: string, host = SITE): Promise<{ status: number; identity?: Record<string, string> }> {
    const response = await browser.get(`http://${host}${path}`, { headers: FORGED });
    if (response.status !== 200) return { status: response.status };
    const body = (await response.json()) as { identity: Record<string, string> };
    return { status: 200, identity: body.identity };
  }

  const accessFile = join(folder, "access.json");
  let writtenAt = 0;

  /** The steward's projection, written whole and renamed into place: the portal reads it again at the next request. */
  function project(sites: Record<string, Partial<SiteAccess>>): void {
    writtenAt += 1;
    const projection: Projection = {
      version: PROJECTION_VERSION,
      writtenAt,
      sites: Object.fromEntries(Object.entries(sites).map(([host, site]) => [host, { slug: host.split(".")[0]!, passwords: [], ...site }])),
    };
    writeFileSync(`${accessFile}.new`, encodeProjection(projection));
    renameSync(`${accessFile}.new`, accessFile);
  }

  beforeAll(async () => {
    const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
    Bun.spawnSync(["bun", join(REPO_ROOT, "portal", "scripts", "borrow.ts")], { stdout: "ignore" });

    for (const name of ["public", "public-legacy", "public-open", "public-portal", "locks", "data"]) mkdirSync(join(folder, name));
    project({});
    writeFileSync(join(folder, "public", "style.css"), "body{}");
    writeFileSync(join(folder, "public-legacy", "style.css"), "body{}");
    writeFileSync(join(folder, "public-open", "style.css"), "body{}");
    writeFileSync(join(folder, "public-portal", "index.html"), "portal");

    site = echo("site");
    legacySite = echo("legacy");
    openSite = echo("open");

    const protectedSite: Manifest = {
      slug: "sample",
      port: site.port,
      publicDir: "public",
      start: "bun run server.ts",
      portal: true,
      portalExempt: ["/webhook/*"],
    };
    const legacy: Manifest = { slug: "legacy", port: legacySite.port, publicDir: "public", start: "bun run server.ts", portal: true };
    const open: Manifest = {
      slug: "open",
      port: openSite.port,
      publicDir: "public",
      start: "bun run server.ts",
      domain: { name: OPEN_DOMAIN, active: true },
    };
    const portalManifest = readManifest(readFileSync(join(REPO_ROOT, "portal", "sitesolide.json"), "utf8")).manifest!;

    // Each fragment as the CLI writes it, brought to the workstation: local
    // addresses over HTTP, temporary folders, the domain table switching the
    // customer domain on, the test portal's port, and no on-demand certificate
    // for the customer domain. Nothing else is touched, the order of the
    // directives above all. `inject` puts the underscore spellings on as each
    // site's block opens, ahead of its strip.
    writeFileSync(join(folder, "domains.map"), `\t${OPEN_DOMAIN} open\n`);
    const local = (text: string, slug: string, host: string, publicDir: string, inject = false) => {
      const opening = (address: string) => [`http://${address}:${caddyPort} {`, ...(inject ? INJECTED : [])].join("\n");
      return text
        .replace(`${slug}.${ZONE_HOST} {`, opening(host))
        .replace(`${OPEN_DOMAIN} {\n\ttls {\n\t\ton_demand\n\t}\n`, `${opening(OPEN_DOMAIN)}\n`)
        .replace("import /etc/caddy/locks/*.caddy", `import ${folder}/locks/*.caddy`)
        .replaceAll(`import ${DOMAIN_TABLE}`, `import ${join(folder, "domains.map")}`)
        .replaceAll(`/srv/sites/${slug}/public`, join(folder, publicDir))
        .replaceAll(`127.0.0.1:${PORTAL_PORT}`, `127.0.0.1:${portalPort}`);
    };

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
        local(generateFragment(protectedSite)!, "sample", SITE, "public", true),
        local(generateFragment(legacy, "cookie")!, "legacy", LEGACY, "public-legacy"),
        local(generateFragment(open)!, "open", OPEN, "public-open", true),
        local(generateFragment(portalManifest)!, "portal", PORTAL_HOST, "public-portal"),
      ].join("\n"),
    );

    portal = Bun.spawn(["bun", "run", join(REPO_ROOT, "portal", "server.ts")], {
      env: {
        ...process.env,
        PORT: String(portalPort),
        DATA_DIR: join(folder, "data"),
        PASSWORD_HASH: hash,
        ACCESS_FILE: accessFile,
        NODE_ENV: "test",
        PUBLIC_URL: `http://${PORTAL_HOST}:${caddyPort}`,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(`http://127.0.0.1:${portalPort}/sante`);
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
    legacySite?.stop(true);
    openSite?.stop(true);
    rmSync(folder, { recursive: true, force: true });
  });

  test("without a cookie, forged headers open nothing, the service's paths nor the files", async () => {
    const browser = new Browser();
    expect(await received(browser, "/list")).toEqual({ status: 401 });
    expect((await browser.get(`http://${SITE}/style.css`, { headers: FORGED })).status).toBe(401);
  });

  test("the owner's password: the site learns the role, and nobody, whatever the visitor claims", async () => {
    const browser = new Browser();
    await browser.signInWithPassword(SITE);
    expect(await received(browser, "/list")).toEqual({ status: 200, identity: { "x-sitesolide-role": "admin" } });
    // A file is served by Caddy itself: the forged headers go nowhere, and open nothing more.
    const file = await browser.get(`http://${SITE}/style.css`, { headers: FORGED });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("body{}");
  });

  test("an exempted path skips the portal, and the visitor's headers are taken off all the same", async () => {
    expect(await received(new Browser(), "/webhook/inbound")).toEqual({ status: 200, identity: {} });
  });

  test("password access opens the site as a visitor, never as the CEO", async () => {
    const password = "sample-password-access-for-tests";
    project({ [SITE]: { passwords: [{ id: "AAAAAAAAAAAAAAAA", who: "eve@elsewhere.test", hash: guestHash(password), expiresAt: Date.now() + 3_600_000 }] } });
    const browser = new Browser();
    const entry = await browser.get(`http://${SITE}/_portal/connexion`, {
      method: "POST",
      headers: { Origin: `http://${SITE}:${caddyPort}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ motdepasse: password, retour: "/" }),
    });
    expect(entry.status).toBe(303);
    expect(await received(browser, "/list")).toEqual({ status: 200, identity: { "x-sitesolide-role": "visitor" } });
    project({});
  });

  test("a block from before identities keeps working with this portal, and passes nothing", async () => {
    const browser = new Browser();
    expect((await browser.get(`http://${LEGACY}/list`)).status).toBe(401);
    await browser.signInWithPassword(LEGACY);
    const response = await browser.get(`http://${LEGACY}/list`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ legacy: "/list", identity: {} });
    // And what it does not do: it takes nothing off either, so the visitor's
    // headers reach the service. That is why a site's app must not trust them
    // before its block has been deployed again, see portal/README.md.
    expect(await received(browser, "/list", LEGACY)).toMatchObject({
      status: 200,
      identity: {
        "x-sitesolide-user": "ceo@acme.test",
        "x-sitesolide-user-name": "The CEO",
        "x-sitesolide-role": "admin",
        "x-sitesolide-impersonate": "yes",
      },
    });
  });

  test("a site not behind the portal hands its app nobody, whatever the visitor claims", async () => {
    // A site whose door was turned off: anyone gets in, and an app written to
    // trust the headers behind the portal must not believe a stranger's.
    expect(await received(new Browser(), "/list", OPEN)).toEqual({ status: 200, identity: {} });
  });

  test("nor does its customer domain, which never goes through the portal", async () => {
    expect(await received(new Browser(), "/list", OPEN_DOMAIN)).toEqual({ status: 200, identity: {} });
  });

  test("the portal's own host refuses a path that would pass its allow list for another route", async () => {
    // Caddy cleaned /admin/sharing/..%2f..%2fsante into /sante, the allow
    // list let it through, and Bun routed the raw path to the admin API,
    // stopped only by its X-Forwarded-For check.
    const browser = new Browser();
    expect((await browser.get(`http://${PORTAL_HOST}/admin/sharing/..%2f..%2fsante`)).status).toBe(400);
    const put = await browser.get(`http://${PORTAL_HOST}/admin/sharing/..%2f..%2fsante`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "domain", domains: ["acme.test"] }),
    });
    expect(put.status).toBe(400);
    expect((await browser.get(`http://${PORTAL_HOST}/sante`)).status).toBe(200);
  });

  test("the portal's own host serves nothing of the site side nor the admin, nor a company sign-in", async () => {
    const browser = new Browser();
    for (const path of ["/oidc/start?flow=x", "/oidc/signout?ticket=x", "/_portal/oidc", "/_portal/oidc/complete?code=x", "/admin/access", "/admin/sharing", "/admin/audit", "/verifier"]) {
      const response = await browser.get(`http://${PORTAL_HOST}${path}`);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    // Nor through the protected site, where /admin/* goes to the service.
    const owner = new Browser();
    await owner.signInWithPassword(SITE);
    const relayed = await owner.get(`http://${SITE}/admin/sharing`);
    expect(((await relayed.json()) as { site: string }).site).toBe("/admin/sharing");
  });
});
