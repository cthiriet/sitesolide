import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { bundle, entryBlocks, header } from "../borrowed/bundle";
import { generateFragment, HEADLESS_ANSWER } from "../borrowed/fragment";
import { readManifest, type Manifest } from "../borrowed/manifest";
import { fragmentIsProtected } from "../borrowed/portal";
import { earlierGenerations, generatedAs, generateUnits } from "../borrowed/unit";
import type { InstallRequest, Scope } from "../src/control/protocol";
import { finalManifest, replaceable, runPipeline, STABILITY_WINDOW_MS, type Outcome } from "../src/installer/pipeline";
import { FIRST_CERTIFICATE_MS, parseZoneNames, ZONE_NAMES_PATH } from "../borrowed/zone-names";
import { createBench as newBench, file, hostOf, OWN_UID, stageBundle as stage, storeMadeBy, zoneNames, ZONE, type Bench, type BenchOptions } from "./installer-bench";

/**
 * The installer's pipeline on a throwaway tree, with the real host: real
 * files, a real extraction by `installer.ts --extract` in a child process, a
 * real `install` command, and the real staging and swap. What needs root or a
 * machine is simulated, see installer-bench.ts.
 */

const DEPLOYMENT = "0123456789abcdef01234567";
/** The token every request of these tests comes from. */
const TOKEN_ID = "aaaaaaaaaaaa";
const NOW = Date.now();
const PRIVATE: Scope = { slugs: [], create: true, outbound: false, domain: false, public: false };
const PUBLIC: Scope = { ...PRIVATE, public: true };

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.cleanup();
});

function createBench(options: BenchOptions = {}): Bench {
  const bench = newBench(options);
  benches.push(bench);
  return bench;
}

const stageBundle = (bench: Bench, entries: Parameters<typeof stage>[2]) => stage(bench, DEPLOYMENT, entries);

function request(manifest: object, scope: Scope = PRIVATE, slug = "shop"): InstallRequest {
  return {
    deployment: DEPLOYMENT,
    slug,
    requestedAt: NOW,
    token: { id: TOKEN_ID, email: "ada@test-zone.invalid", member: null },
    scope,
    creating: true,
    manifest: JSON.stringify(manifest),
  };
}

function deposit(bench: Bench, manifest: Manifest): void {
  mkdirSync(join(bench.sites, manifest.slug, "app"), { recursive: true });
  mkdirSync(join(bench.sites, manifest.slug, "public"), { recursive: true });
  writeFileSync(join(bench.sites, manifest.slug, "sitesolide.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The pipeline as the steward starts it: a deployment is a creation when the
 * machine did not carry its project as the steward judged it, which these
 * tests lay or not beforehand.
 */
async function run(bench: Bench, requested: InstallRequest): Promise<Outcome> {
  return runPipeline(hostOf(bench), asJudged(bench, requested), { zone: ZONE, runFolder: bench.run });
}

function asJudged(bench: Bench, requested: InstallRequest): InstallRequest {
  return { ...requested, creating: !existsSync(join(bench.sites, requested.slug)) };
}

const APP = { slug: "shop", start: "/usr/local/bin/bun run server.ts", publicDir: "public" };
const APP_FILES = [file("app/server.ts", "Bun.serve({})"), file("public/index.html", "<h1>shop</h1>")];

function deposited(bench: Bench, slug = "shop"): Manifest {
  return readManifest(readFileSync(join(bench.sites, slug, "sitesolide.json"), "utf8")).manifest!;
}

const order = (bench: Bench, first: string, second: string) => bench.events.indexOf(first) < bench.events.indexOf(second);

describe("a new project, private by default", () => {
  test("behind the portal, its port chosen, its door up before its files", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP));
    expect(outcome).toEqual({ ok: true, url: `https://shop.${ZONE}/`, allocated: [{ service: null, port: 3002 }], missingSecrets: { runtime: [], files: [] } });

    const manifest = deposited(bench);
    expect(manifest.portal).toBe(true);
    expect(manifest.port).toBe(3002);
    expect(readFileSync(join(bench.sites, "shop", "app", "server.ts"), "utf8")).toBe("Bun.serve({})");
    expect(readFileSync(join(bench.sites, "shop", "public", "index.html"), "utf8")).toBe("<h1>shop</h1>");
    expect(existsSync(join(bench.sites, "shop", "app", "sitesolide.json"))).toBe(false);
    expect(readFileSync(join(bench.units, "shop.service"), "utf8")).toContain("ExecStart=/usr/local/bin/bun run server.ts");
    expect(fragmentIsProtected(readFileSync(join(bench.blocks, "shop.caddy"), "utf8"))).toBe(true);

    // The door before the files, as `deploy` does for a protected site.
    expect(order(bench, "block protected", "log -> app and public, put in place")).toBe(true);
    expect(bench.events).toContain("useradd site-shop");
    expect(bench.events).toContain("as shop extract");
    expect(bench.events).toContain("systemctl restart shop");
    // The staging directory and the trees set aside are gone.
    expect(readdirSync(join(bench.sites, "shop")).sort()).toEqual(["app", "data", "public", "sitesolide.json"]);
  });

  test("a token that may go public deploys in the open, its block after the restart", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP, PUBLIC));
    expect(outcome.ok).toBe(true);
    expect(deposited(bench).portal).toBeUndefined();
    expect(order(bench, "log -> app and public, put in place", "block open")).toBe(true);
    expect(order(bench, "systemctl restart shop", "block open")).toBe(true);
  });

  test("a static site, for a token that may go public: no unit, no block", async () => {
    const bench = createBench();
    stageBundle(bench, [file("public/index.html", "static")]);
    const outcome = await run(bench, request({ slug: "shop", publicDir: "public" }, PUBLIC));
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(bench.sites, "shop", "public", "index.html"), "utf8")).toBe("static");
    expect(readdirSync(bench.units)).toEqual([]);
    expect(existsSync(join(bench.blocks, "shop.caddy"))).toBe(false);
  });

  test("one service with a backup command reaches its own port: the loopback's set names it", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, backup: { folder: "index", command: "/usr/local/bin/bun run snapshot.ts" } }));
    expect(outcome.ok).toBe(true);
    const uid = /^site-shop:x:(\d+):/m.exec(readFileSync(join(bench.root, "passwd"), "utf8"))![1];
    expect(readFileSync(join(bench.root, "projects.nft"), "utf8")).toContain(`{ 3002 . ${uid} }`);
    expect(bench.events).toContain("log    shop reaching its own ports");
    // Without one, the set is none of its business.
    const plain = createBench();
    stageBundle(plain, APP_FILES);
    expect((await run(plain, request(APP))).ok).toBe(true);
    expect(existsSync(join(plain.root, "projects.nft"))).toBe(false);
  });

  test("install runs as the project's account, in the staging directory, before anything served changes", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, install: "echo installed > installed.txt && echo ok" }));
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(bench.sites, "shop", "app", "installed.txt"), "utf8")).toBe("installed\n");
    expect(bench.events).toContain("log    ok");
    expect(order(bench, "as shop install", "log -> app and public, put in place")).toBe(true);
  });
});

describe("refusals, before anything served changes", () => {
  test("a static site for a private token: refused before any account or directory", async () => {
    const bench = createBench();
    stageBundle(bench, [file("public/index.html")]);
    const outcome = await run(bench, request({ slug: "shop", publicDir: "public" }));
    expect(outcome).toMatchObject({ ok: false, code: "out-of-scope" });
    expect(readdirSync(bench.sites)).toEqual([]);
    expect(bench.events.some((event) => event.startsWith("useradd"))).toBe(false);
  });

  test("a slug systemd gives to a package's service: refused before any account, directory or unit", async () => {
    // The unit lives in /lib/systemd/system: the bench's units folder, which
    // stands for /etc/systemd/system, has no file of that name.
    const bench = createBench({ systemUnits: { mailer: "/lib/systemd/system/mailer.service" } });
    stageBundle(bench, [file("app/server.ts"), file("public/index.html")]);
    const outcome = await run(bench, request({ ...APP, slug: "mailer" }, PRIVATE, "mailer"));
    expect(outcome).toMatchObject({ ok: false, code: "system-unit" });
    expect(outcome.ok === false && outcome.message).toContain("/lib/systemd/system/mailer.service");
    expect(readdirSync(bench.sites)).toEqual([]);
    expect(readdirSync(bench.units)).toEqual([]);
    expect(bench.events.some((event) => event.startsWith("useradd"))).toBe(false);
  });

  test("a name validate() reserves for the machine's own services never reaches the machine", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, slug: "caddy" }, PRIVATE, "caddy"));
    expect(outcome).toMatchObject({ ok: false, code: "invalid-manifest" });
    expect(outcome.ok === false && outcome.message).toContain("a name the machine already uses");
    expect(readdirSync(bench.sites)).toEqual([]);
  });

  test("a failing install leaves the served code as it was", async () => {
    const bench = createBench();
    deposit(bench, { ...APP, port: 3040, portal: true });
    writeFileSync(join(bench.sites, "shop", "app", "server.ts"), "the previous version");
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, install: "echo broken >&2; exit 3" }));
    expect(outcome).toMatchObject({ ok: false, code: "install-failed" });
    expect(readFileSync(join(bench.sites, "shop", "app", "server.ts"), "utf8")).toBe("the previous version");
    expect(bench.events).toContain("log    broken");
    expect(existsSync(join(bench.sites, "shop", ".incoming"))).toBe(false);
  });

  test("an archive carrying a link is refused, and nothing is put in place", async () => {
    const bench = createBench();
    const link = header("app/escape", { type: "2", mode: 0o777, size: 0, mtime: 1 });
    const tar = new Uint8Array([...entryBlocks(file("app/a"))[0]!, ...entryBlocks(file("app/a"))[1]!, ...link, ...new Uint8Array(1024)]);
    stageBundle(bench, Bun.gzipSync(tar));
    const outcome = await run(bench, request(APP));
    expect(outcome).toMatchObject({ ok: false, code: "bundle-refused" });
    expect(outcome.ok === false && outcome.message).toContain("symbolic link");
    expect(existsSync(join(bench.sites, "shop", "sitesolide.json"))).toBe(false);
  });

  test("a public directory that arrives empty would wipe the site", async () => {
    const bench = createBench();
    stageBundle(bench, [file("app/server.ts")]);
    expect(await run(bench, request(APP))).toMatchObject({ ok: false, code: "public-empty" });
  });

  test("a block edited by hand on the machine stops everything", async () => {
    const bench = createBench();
    const previous = { ...APP, port: 3040, portal: true } as Manifest;
    deposit(bench, previous);
    writeFileSync(join(bench.blocks, "shop.caddy"), `${generateFragment(previous)}\n# a hand-made header\nheader X-Hand "made"\n`);
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, port: 3040 }));
    expect(outcome).toMatchObject({ ok: false, code: "edited-by-hand" });
    expect(outcome.ok === false && outcome.message).toContain("--force");
    expect(bench.events).not.toContain("lock");
  });

  test("Caddy being changed elsewhere: nothing served changes, deploy again later", async () => {
    const bench = createBench({ lockHeld: true });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP));
    expect(outcome).toMatchObject({ ok: false, code: "caddy-busy" });
    expect(existsSync(join(bench.sites, "shop", "app", "server.ts"))).toBe(false);
  });

  test("the door changed from the dashboard while the deployment ran", async () => {
    const bench = createBench({
      onLock: (b) => writeFileSync(join(b.sites, "shop", "sitesolide.json"), JSON.stringify({ ...APP, port: 3040 })),
    });
    deposit(bench, { ...APP, port: 3040, portal: true });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, port: 3040 }, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "access-changed" });
    expect(bench.events).toContain("release");
  });

  test("a code set from the dashboard while the deployment ran: refused, the code never left behind a manifest without it", async () => {
    const bench = createBench({
      onLock: (b) => writeFileSync(join(b.sites, "shop", "sitesolide.json"), JSON.stringify({ ...APP, port: 3040, lock: true })),
    });
    deposit(bench, { ...APP, port: 3040 });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, port: 3040 }, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "access-changed" });
    expect(outcome.ok === false && outcome.message).toContain("changed from the dashboard during this deploy");
    expect(JSON.parse(readFileSync(join(bench.sites, "shop", "sitesolide.json"), "utf8")).lock).toBe(true);
  });

  test("a site that opens with a code keeps it through a token's deployment", async () => {
    const bench = createBench();
    deposit(bench, { ...APP, port: 3040, lock: true });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, port: 3040 }, PUBLIC));
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(bench.sites, "shop", "sitesolide.json"), "utf8")).lock).toBe(true);
  });

  test("a manifest that would write Caddy or systemd syntax is refused on the machine, before any account or block", async () => {
    // The installer is root and the last judge: whatever the dashboard and the
    // steward let through, a token's placeholder never reaches a block, nor
    // its `+` an ExecStart run as root.
    for (const manifest of [
      { ...APP, headers: { "X-Leak": "{$CLOUDFLARE_API_TOKEN}" } },
      { ...APP, headers: { "X-Leak": "{env.CLOUDFLARE_API_TOKEN}" } },
      { ...APP, routes: ['/x\n\theader Leak "{$CLOUDFLARE_API_TOKEN}"'] },
      { ...APP, start: "+/bin/sh -c id" },
      { ...APP, env: { NODE_ENV: "x DATA_DIR=/srv/sites/dashboard/data" } },
    ]) {
      const bench = createBench();
      stageBundle(bench, APP_FILES);
      const outcome = await run(bench, request(manifest, { ...PUBLIC, outbound: true }));
      expect(outcome).toMatchObject({ ok: false, code: "invalid-manifest" });
      expect(readdirSync(bench.sites)).toEqual([]);
      expect(readdirSync(bench.blocks)).toEqual([]);
      expect(bench.events.some((event) => event.startsWith("useradd"))).toBe(false);
    }
  });

  test("the portal not ready: a site behind it would be closed to everyone", async () => {
    const bench = createBench({ probe: (host, path) => (path === "/sante" ? { code: 502, door: false, body: "" } : null) });
    stageBundle(bench, APP_FILES);
    expect(await run(bench, request(APP))).toMatchObject({ ok: false, code: "portal-not-ready" });
  });
});

describe("a new project refused before anything is served leaves nothing behind", () => {
  const passwd = (bench: Bench) => readFileSync(join(bench.root, "passwd"), "utf8");
  const traversal = () => bundle([file("app/../../../etc/cron.d/x", "* * * * * root id")]);
  const withLink = () => {
    const link = header("app/escape", { type: "2", mode: 0o777, size: 0, mtime: 1 });
    return Bun.gzipSync(new Uint8Array([...entryBlocks(file("app/a"))[0]!, ...entryBlocks(file("app/a"))[1]!, ...link, ...new Uint8Array(1024)]));
  };

  /** Every file and directory the machine's stand-ins carry, with the files' content. */
  function snapshot(bench: Bench): Record<string, string> {
    const seen: Record<string, string> = { passwd: passwd(bench) };
    const visit = (folder: string) => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        const directory = lstatSync(path).isDirectory();
        seen[relative(bench.root, path)] = directory ? "<directory>" : readFileSync(path, "utf8");
        if (directory) visit(path);
      }
    };
    for (const folder of [bench.sites, bench.units, bench.blocks]) visit(folder);
    return seen;
  }

  test("a refused archive, a traversal or a link: no account, no directory, no unit, no block", async () => {
    // Through the control API, each such deployment left site-<slug> and an
    // empty /srv/sites/<slug>/{app,public,data}, which the token's status
    // then listed as a public project of no type.
    for (const archive of [traversal(), withLink()]) {
      const bench = createBench();
      stageBundle(bench, archive);
      const outcome = await run(bench, request(APP));
      expect(outcome).toMatchObject({ ok: false, code: "bundle-refused" });
      expect(passwd(bench)).not.toContain("site-shop");
      expect(readdirSync(bench.sites)).toEqual([]);
      expect(readdirSync(bench.units)).toEqual([]);
      expect(readdirSync(bench.blocks)).toEqual([]);
      expect(order(bench, "useradd site-shop", "userdel site-shop")).toBe(true);
      expect(bench.events).toContain("log    removed    /srv/sites/shop");
      expect(bench.events).toContain("log    removed    site-shop");
    }
  });

  test("refused under the Caddy lock, once its units were laid: they go too, before the tree and the account", async () => {
    const bench = createBench({ lockHeld: true });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ slug: "shop", publicDir: "public", services: { web: { start: "/usr/local/bin/bun run web.ts" }, api: { start: "/usr/local/bin/bun run api.ts", routes: ["/api/*"] } } }));
    expect(outcome).toMatchObject({ ok: false, code: "caddy-busy" });
    expect(bench.events).toContain("systemctl disable --now shop shop.api.service");
    expect(readdirSync(bench.units)).toEqual([]);
    expect(readdirSync(bench.sites)).toEqual([]);
    expect(passwd(bench)).not.toContain("site-shop");
    expect(order(bench, "systemctl disable --now shop shop.api.service", "userdel site-shop")).toBe(true);
  });

  test("an account the machine already had is kept, even for a new tree", async () => {
    // A removal that stopped before its userdel, say: not this run's to take.
    const bench = createBench();
    writeFileSync(join(bench.root, "passwd"), `${passwd(bench)}site-shop:x:2001:2001::/nonexistent:/usr/sbin/nologin\n`);
    stageBundle(bench, traversal());
    expect(await run(bench, request(APP))).toMatchObject({ ok: false, code: "bundle-refused" });
    expect(readdirSync(bench.sites)).toEqual([]);
    expect(passwd(bench)).toContain("site-shop:x:2001");
    expect(bench.events.some((event) => event.startsWith("userdel"))).toBe(false);
  });

  test("the same refusals for an existing project change nothing of it", async () => {
    for (const [options, archive, code] of [
      [{}, traversal(), "bundle-refused"],
      [{}, withLink(), "bundle-refused"],
      [{ lockHeld: true }, bundle(APP_FILES), "caddy-busy"],
    ] as const) {
      const bench = createBench(options);
      const previous = { ...APP, port: 3040, portal: true } as Manifest;
      deposit(bench, previous);
      writeFileSync(join(bench.sites, "shop", "app", "server.ts"), "the version in service");
      writeFileSync(join(bench.sites, "shop", "public", "index.html"), "<h1>in service</h1>");
      mkdirSync(join(bench.sites, "shop", "data"));
      writeFileSync(join(bench.sites, "shop", "data", "shop.db"), "the project's rows");
      writeFileSync(join(bench.units, "shop.service"), generateUnits(previous)[0]!.text);
      writeFileSync(join(bench.blocks, "shop.caddy"), generateFragment(previous)!);
      writeFileSync(join(bench.root, "passwd"), `${passwd(bench)}site-shop:x:2001:2001::/nonexistent:/usr/sbin/nologin\n`);
      const before = snapshot(bench);
      stageBundle(bench, archive);
      expect(await run(bench, request({ ...APP, port: 3040 }))).toMatchObject({ ok: false, code });
      expect(snapshot(bench)).toEqual(before);
      expect(bench.events.some((event) => event.startsWith("userdel") || event.startsWith("systemctl disable"))).toBe(false);
    }
  });

  test("once something may be served, a new project keeps what it has, the owner then sees why", async () => {
    const bench = createBench({ restartFails: true });
    stageBundle(bench, APP_FILES);
    expect(await run(bench, request(APP))).toMatchObject({ ok: false, code: "service-failed" });
    expect(passwd(bench)).toContain("site-shop");
    expect(existsSync(join(bench.sites, "shop", "sitesolide.json"))).toBe(true);
    expect(bench.events.some((event) => event.startsWith("userdel"))).toBe(false);
  });
});

describe("after the files are in place", () => {
  test("a legacy file missing stops nothing: said in the log, the service restarted without its variables", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, secrets: ["shop.env"] }));
    expect(outcome).toMatchObject({ ok: true, missingSecrets: { runtime: [], files: [] } });
    expect(bench.events).toContain("log    !! /etc/sitesolide/shop.env missing: the service starts without its variables");
    expect(bench.events).toContain("systemctl restart shop");
    writeFileSync(join(bench.secrets, "shop.env"), "TOKEN=x\n");
    stageBundle(bench, APP_FILES);
    expect((await run(bench, request({ ...APP, secrets: ["shop.env"] }))).ok).toBe(true);
    expect(bench.events).toContain(`log    present  /etc/sitesolide/shop.env`);
  });

  test("a site whose root answers 404 fails, saying what to serve there", async () => {
    const bench = createBench({ probe: (host, path) => (host === `shop.${ZONE}` && path === "/" ? { code: 404, door: false, body: "" } : null) });
    stageBundle(bench, [file("public/about.html", "no index")]);
    const outcome = await run(bench, request({ slug: "shop", publicDir: "public" }, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed" });
    expect(outcome.ok === false && outcome.message).toContain("nothing is served at the site's root");
    expect(outcome.ok === false && outcome.message).toContain("index.html in publicDir");
  });

  /** The site's answers once the verification starts, each attempt's from the script, its last entry for every attempt after. */
  function warmingBench(...script: number[]): { bench: Bench; attempts: () => number; waits: () => string[] } {
    let attempts = 0;
    const bench = createBench({
      probe: (host, path, current) =>
        host === `shop.${ZONE}` && path === "/" && current.events.includes("log -> verify") ? { code: script[Math.min(++attempts, script.length) - 1]!, door: false, body: "" } : null,
    });
    return { bench, attempts: () => attempts, waits: () => bench.events.slice(bench.events.indexOf("log -> verify")).filter((event) => event === "wait 5000") };
  }

  for (const code of [502, 503, 504]) {
    test(`an app still starting, answering ${code} through Caddy, is asked again, said once, and passes once it answers`, async () => {
      const { bench, attempts, waits } = warmingBench(code, code, 200);
      stageBundle(bench, APP_FILES);
      const outcome = await run(bench, request(APP, PUBLIC));
      expect(outcome).toMatchObject({ ok: true, url: `https://shop.${ZONE}/` });
      expect(attempts()).toBe(3);
      expect(waits()).toHaveLength(2);
      expect(bench.events.filter((event) => event.includes("asking again"))).toEqual([`log    ${code}: the app does not answer Caddy yet, as one still starting does; asking again for up to 30 s`]);
    });
  }

  test("an app that keeps answering 502 fails within the bound, saying it was asked again", async () => {
    const { bench, attempts, waits } = warmingBench(502);
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed" });
    expect(outcome.ok === false && outcome.message).toBe(`https://shop.${ZONE}/ answered 502, expected 200; still after 30 s of asking again: the app does not answer behind Caddy`);
    expect(waits()).toHaveLength(5);
    expect(attempts()).toBe(6);
  });

  test("any other error is judged at once: a 500 is not asked again", async () => {
    const { bench, attempts, waits } = warmingBench(500);
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed", message: `https://shop.${ZONE}/ answered 500, expected 200` });
    expect(attempts()).toBe(1);
    expect(waits()).toEqual([]);
  });

  test("a service that does not come back is a failure that says where to look", async () => {
    const bench = createBench({ restartFails: true });
    stageBundle(bench, APP_FILES);
    expect(await run(bench, request(APP))).toMatchObject({ ok: false, code: "service-failed" });
  });

  test("a block that Caddy refuses is put back, and the deployment fails", async () => {
    const bench = createBench({ validate: (b) => (existsSync(join(b.blocks, "shop.caddy")) ? { ok: false, output: "Error: bad block" } : { ok: true, output: "Valid configuration" }) });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP));
    expect(outcome).toMatchObject({ ok: false, code: "caddy-refused" });
    expect(existsSync(join(bench.blocks, "shop.caddy"))).toBe(false);
  });
});

describe("a redeployment", () => {
  test("keeps its port, follows a manifest that changed, and keeps the preview lock the owner set", async () => {
    const bench = createBench();
    const previous = { ...APP, port: 3040, lock: true } as Manifest;
    deposit(bench, previous);
    writeFileSync(join(bench.blocks, "shop.caddy"), generateFragment(previous)!);
    stageBundle(bench, APP_FILES);
    // A new route changes the block: it was the generator's, so it is replaced.
    const outcome = await run(bench, request({ ...APP, routes: ["/api/*"] }, PUBLIC));
    expect(outcome).toMatchObject({ ok: true, allocated: [{ service: null, port: 3040 }] });
    const manifest = deposited(bench);
    expect(manifest.lock).toBe(true);
    expect(manifest.routes).toEqual(["/api/*"]);
    expect(readFileSync(join(bench.blocks, "shop.caddy"), "utf8")).toContain("/api/*");
  });

  test("a port chosen at the start and deposited by another deployment in the meantime is refused under the lock", async () => {
    const bench = createBench({
      onLock: (b) => {
        mkdirSync(join(b.sites, "other"), { recursive: true });
        writeFileSync(join(b.sites, "other", "sitesolide.json"), JSON.stringify({ slug: "other", start: "x", port: 3002 }));
      },
    });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP));
    expect(outcome).toMatchObject({ ok: false, code: "port-taken" });
    expect(outcome.ok === false && outcome.message).toContain("since this deployment started");
    expect(existsSync(join(bench.sites, "shop", "sitesolide.json"))).toBe(false);
    expect(bench.events).toContain("release");
  });

  test("a port another project declares is refused, with what to do", async () => {
    const bench = createBench();
    deposit(bench, { slug: "cms", start: "x", port: 3040 } as Manifest);
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, port: 3040 }));
    expect(outcome).toMatchObject({ ok: false, code: "port-taken" });
  });

  test("the portal's port is refused before the portal is deployed, and never handed out", async () => {
    // The loopback rule lets the dashboard through to the portal's port: a
    // token's project there would be reached by it.
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, port: 3026 }));
    expect(outcome).toMatchObject({ ok: false, code: "port-taken" });
    expect(outcome.ok === false && outcome.message).toContain("the platform's portal");
    for (let port = 3002; port < 3026; port++) if (port !== 3022) deposit(bench, { slug: `p${port}`, start: "x", port } as Manifest);
    const chosen = await run(bench, request(APP));
    expect(chosen).toMatchObject({ ok: true, allocated: [{ service: null, port: 3027 }] });
  });
});

describe("workers, scheduled services and anchors", () => {
  const BACKGROUND = {
    slug: "shop",
    publicDir: "public",
    services: {
      web: { start: "/usr/local/bin/bun run web.ts" },
      jobs: { start: "/usr/local/bin/bun run jobs.ts", internal: true },
      sync: { start: "/usr/local/bin/bun run sync.ts", schedule: "*:0/15", timeout: "5m" },
    },
  };
  const ANCHORED = { slug: "shop", services: { sync: { start: "/usr/local/bin/bun run sync.ts", schedule: "hourly" } } };
  const SYNC_FILES = [file("app/sync.ts", "await sync()")];
  const units = (bench: Bench) => readdirSync(bench.units).sort();

  test("a port for the public service alone, every unit laid, the timer restarted and never its service", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(BACKGROUND));
    expect(outcome).toEqual({ ok: true, url: `https://shop.${ZONE}/`, allocated: [{ service: "web", port: 3002 }], missingSecrets: { runtime: [], files: [] } });
    const manifest = deposited(bench);
    expect(manifest.services!.jobs!.port).toBeUndefined();
    expect(manifest.services!.sync!.port).toBeUndefined();
    expect(units(bench)).toEqual(["shop.jobs.service", "shop.service", "shop.sync.service", "shop.sync.timer"]);
    expect(readFileSync(join(bench.units, "shop.sync.timer"), "utf8")).toContain("OnCalendar=*:0/15");
    expect(readFileSync(join(bench.units, "shop.service"), "utf8")).toContain("Wants=shop.jobs.service shop.sync.timer");
    // Asked of systemd before anything is written.
    expect(order(bench, "systemd-analyze calendar *:0/15", "useradd site-shop")).toBe(true);
    // The scheduled service is started by its timer alone: a restart would run it outside its schedule.
    expect(bench.events).toContain("systemctl restart shop shop.jobs.service shop.sync.timer");
    expect(bench.events).toContain("systemctl is-active shop shop.jobs.service shop.sync.timer");
    expect(bench.events).toContain("log    installed  shop.sync.timer");
  });

  test("the servers and the workers are read again once the window has passed, after the verification", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    expect((await run(bench, request(BACKGROUND))).ok).toBe(true);
    // Never the scheduled service nor its timer: idle is their state.
    expect(bench.events.filter((event) => event.startsWith("standing"))).toEqual(["standing shop shop.jobs.service", "standing shop shop.jobs.service"]);
    const waited = bench.events.find((event) => event.startsWith("wait "));
    expect(Number(waited!.slice("wait ".length))).toBeGreaterThan(0);
    expect(Number(waited!.slice("wait ".length))).toBeLessThanOrEqual(STABILITY_WINDOW_MS);
    expect(order(bench, "log -> verify", waited!)).toBe(true);
    expect(bench.events).toContain("log    shop.service, shop.jobs.service still running");
  });

  test("a worker that falls within the window fails the deployment, named with what was seen", async () => {
    const bench = createBench({ falls: { "shop.jobs": { active: "activating", sub: "auto-restart", restarts: 2 } } });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(BACKGROUND));
    expect(outcome).toMatchObject({ ok: false, code: "service-failed" });
    expect(outcome.ok === false && outcome.message).toContain("shop.jobs.service is activating (auto-restart), restarted 2 time(s) by systemd");
    expect(outcome.ok === false && outcome.message).toContain("read sitesolide logs");
    expect(outcome.ok === false && outcome.message).not.toContain("shop.service is");
    // Everything is in place, as after a failed verification.
    expect(existsSync(join(bench.sites, "shop", "sitesolide.json"))).toBe(true);
  });

  test("a service that stopped within the window fails it too", async () => {
    const bench = createBench({ falls: { shop: { active: "failed", sub: "failed", restarts: 0 } } });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP));
    expect(outcome).toMatchObject({ ok: false, code: "service-failed" });
    expect(outcome.ok === false && outcome.message).toContain("shop.service is failed (failed)");
  });

  test("a schedule systemd does not read is refused before any account, directory or unit", async () => {
    const bench = createBench({ refusedSchedules: ["every hour"] });
    stageBundle(bench, APP_FILES);
    const manifest = { ...BACKGROUND, services: { ...BACKGROUND.services, sync: { ...BACKGROUND.services.sync, schedule: "every hour" } } };
    const outcome = await run(bench, request(manifest));
    expect(outcome).toMatchObject({ ok: false, code: "invalid-manifest" });
    expect(outcome.ok === false && outcome.message).toContain('services.sync.schedule: systemd does not read "every hour" as a time');
    expect(outcome.ok === false && outcome.message).toContain("nothing was changed");
    expect(readdirSync(bench.sites)).toEqual([]);
    expect(readdirSync(bench.units)).toEqual([]);
    expect(bench.events.some((event) => event.startsWith("useradd"))).toBe(false);
  });

  test("every service scheduled: the anchor stands for the project, its address says it serves no page", async () => {
    const bench = createBench();
    stageBundle(bench, SYNC_FILES);
    const outcome = await run(bench, request(ANCHORED, PUBLIC));
    expect(outcome).toEqual({ ok: true, url: `https://shop.${ZONE}/`, allocated: [], missingSecrets: { runtime: [], files: [] } });
    expect(units(bench)).toEqual(["shop.service", "shop.sync.service", "shop.sync.timer"]);
    const anchor = readFileSync(join(bench.units, "shop.service"), "utf8");
    expect(anchor).toContain("Type=oneshot");
    expect(anchor).toContain("Wants=shop.sync.timer");
    expect(readFileSync(join(bench.blocks, "shop.caddy"), "utf8")).toContain(HEADLESS_ANSWER);
    expect(bench.events).toContain("systemctl restart shop shop.sync.timer");
    expect(bench.events).toContain("systemctl enable shop");
    // Nothing runs for good: nothing to watch, and nothing waited for.
    expect(bench.events.some((event) => event.startsWith("standing") || event.startsWith("wait"))).toBe(false);
  });

  test("a worker alone: the main unit, no port, watched like a server, its address saying it serves no page", async () => {
    const bench = createBench();
    stageBundle(bench, [file("app/bot.ts", "await listen()")]);
    const outcome = await run(bench, request({ slug: "shop", services: { bot: { start: "/usr/local/bin/bun run bot.ts", internal: true } } }, PUBLIC));
    expect(outcome).toEqual({ ok: true, url: `https://shop.${ZONE}/`, allocated: [], missingSecrets: { runtime: [], files: [] } });
    expect(units(bench)).toEqual(["shop.service"]);
    const unit = readFileSync(join(bench.units, "shop.service"), "utf8");
    expect(unit).toContain("RestartSteps=8");
    expect(unit).not.toContain("Environment=PORT=");
    expect(readFileSync(join(bench.blocks, "shop.caddy"), "utf8")).toContain(HEADLESS_ANSWER);
    expect(bench.events.filter((event) => event.startsWith("standing"))).toEqual(["standing shop", "standing shop"]);
  });

  test("an anchored project behind the portal: its address answers the portal's 401", async () => {
    const bench = createBench();
    stageBundle(bench, SYNC_FILES);
    const outcome = await run(bench, request(ANCHORED));
    expect(outcome.ok).toBe(true);
    expect(deposited(bench).portal).toBe(true);
    expect(fragmentIsProtected(readFileSync(join(bench.blocks, "shop.caddy"), "utf8"))).toBe(true);
  });

  test("a schedule dropped takes its timer with it, the timer stopped first", async () => {
    const bench = createBench();
    const previous = { ...BACKGROUND, portal: true, services: { ...BACKGROUND.services, web: { ...BACKGROUND.services.web, port: 3040 } } } as Manifest;
    deposit(bench, previous);
    for (const { unit, text } of generateUnits(previous)) writeFileSync(join(bench.units, unit.endsWith(".timer") ? unit : `${unit}.service`), text);
    stageBundle(bench, APP_FILES);
    // The scheduled service becomes a worker: its unit stays, rewritten, its timer goes.
    const next = { ...BACKGROUND, services: { web: BACKGROUND.services.web, jobs: BACKGROUND.services.jobs, sync: { start: "/usr/local/bin/bun run sync.ts", internal: true } } };
    const outcome = await run(bench, request(next));
    expect(outcome).toMatchObject({ ok: true, allocated: [{ service: "web", port: 3040 }] });
    expect(units(bench)).toEqual(["shop.jobs.service", "shop.service", "shop.sync.service"]);
    expect(readFileSync(join(bench.units, "shop.sync.service"), "utf8")).toContain("Restart=always");
    expect(bench.events).toContain("systemctl disable --now shop.sync.timer");
    expect(bench.events).toContain("log    removed    shop.sync.timer, no longer declared");
    expect(bench.events).toContain("systemctl restart shop shop.jobs.service shop.sync.service");

    // Dropped whole: the timer before its service, in the one command.
    const again = createBench();
    deposit(again, previous);
    for (const { unit, text } of generateUnits(previous)) writeFileSync(join(again.units, unit.endsWith(".timer") ? unit : `${unit}.service`), text);
    stageBundle(again, APP_FILES);
    expect((await run(again, request({ ...BACKGROUND, services: { web: BACKGROUND.services.web, jobs: BACKGROUND.services.jobs } }))).ok).toBe(true);
    expect(again.events).toContain("systemctl disable --now shop.sync.timer shop.sync.service");
    // Their failed state cleared too: a scheduled service is `failed` after a
    // run that failed, and systemd keeps it once the file is gone.
    expect(order(again, "systemctl disable --now shop.sync.timer shop.sync.service", "systemctl reset-failed shop.sync.timer shop.sync.service")).toBe(true);
    expect(units(again)).toEqual(["shop.jobs.service", "shop.service"]);
  });

  test("a unit an earlier release wrote, before the system-call filter or the bind lines, is replaced, the manifest changed or not: it was never edited by hand", async () => {
    for (const generation of [0, 1]) {
      for (const next of [{ ...APP, port: 3040, portal: true }, { ...APP, port: 3040, portal: true, memory: "512M" }]) {
        const bench = createBench();
        const previous = { ...APP, port: 3040, portal: true } as Manifest;
        deposit(bench, previous);
        for (const { unit, text } of generateUnits(previous)) writeFileSync(join(bench.units, `${unit}.service`), earlierGenerations(text)[generation]!);
        stageBundle(bench, APP_FILES);
        const outcome = await run(bench, request(next));
        expect(outcome).toMatchObject({ ok: true });
        expect(bench.events.some((event) => event.includes("differs"))).toBe(false);
        const laid = readFileSync(join(bench.units, "shop.service"), "utf8");
        expect(laid).toContain("\nSocketBindAllow=tcp:3040\n");
        expect(laid).toContain("\nSystemCallFilter=@system-service\n");
      }
    }
  });

  test("a unit whose secret files were repeated or reordered by hand stays, and says so: the previous manifest's unit or an earlier release's, the same lines in another order decide which value wins", async () => {
    const FLAT = "EnvironmentFile=-/etc/sitesolide/shop.env\n";
    const STORE = "EnvironmentFile=-/etc/sitesolide/projects/shop/env\n";
    const previous = { ...APP, port: 3040, portal: true, secrets: ["shop.env"] } as Manifest;
    const [main] = generateUnits(previous);
    expect(main!.text).toContain(`${FLAT}${STORE}`);
    const repeated = (text: string) => text.replace(`${FLAT}${STORE}`, `${FLAT}${STORE}${FLAT}`);
    const swapped = (text: string) => text.replace(`${FLAT}${STORE}`, `${STORE}${FLAT}`);
    // The release before the system-call filter, store lines and all.
    const beforeFilter = earlierGenerations(main!.text)[3]!;
    expect(beforeFilter).toContain(`${FLAT}${STORE}`);
    for (const edited of [repeated(main!.text), swapped(main!.text), swapped(beforeFilter), repeated(beforeFilter)]) {
      const bench = createBench();
      deposit(bench, previous);
      writeFileSync(join(bench.units, "shop.service"), edited);
      stageBundle(bench, APP_FILES);
      const outcome = await run(bench, request({ ...previous, memory: "512M" }));
      expect(outcome).toMatchObject({ ok: true });
      expect(bench.events.some((event) => event.startsWith("log    differs    shop.service, edited by hand on the machine"))).toBe(true);
      expect(readFileSync(join(bench.units, "shop.service"), "utf8")).toBe(edited);
    }
    // In the generator's order, it is the generator's own, and replaced.
    const bench = createBench();
    deposit(bench, previous);
    writeFileSync(join(bench.units, "shop.service"), main!.text);
    stageBundle(bench, APP_FILES);
    expect((await run(bench, request({ ...previous, memory: "512M" }))).ok).toBe(true);
    expect(bench.events.some((event) => event.includes("differs"))).toBe(false);
    expect(readFileSync(join(bench.units, "shop.service"), "utf8")).toContain("MemoryMax=512M");
  });

  test("a unit whose filter was taken off by hand stays, and says so", async () => {
    const bench = createBench();
    const previous = { ...APP, port: 3040, portal: true } as Manifest;
    deposit(bench, previous);
    const [main] = generateUnits(previous);
    const edited = main!.text.replace("SystemCallFilter=@system-service\n", "");
    writeFileSync(join(bench.units, "shop.service"), edited);
    stageBundle(bench, APP_FILES);
    await run(bench, request(previous));
    expect(bench.events.some((event) => event.includes("differs") && event.includes("shop.service"))).toBe(true);
    expect(readFileSync(join(bench.units, "shop.service"), "utf8")).toBe(edited);
  });

  test("a timer edited by hand on the machine stays, and says so", async () => {
    const bench = createBench();
    const previous = { ...ANCHORED, portal: true } as Manifest;
    deposit(bench, previous);
    for (const { unit, text } of generateUnits(previous)) writeFileSync(join(bench.units, unit.endsWith(".timer") ? unit : `${unit}.service`), text);
    writeFileSync(join(bench.units, "shop.sync.timer"), `${readFileSync(join(bench.units, "shop.sync.timer"), "utf8")}RandomizedDelaySec=5min\n`);
    stageBundle(bench, SYNC_FILES);
    const outcome = await run(bench, request({ ...ANCHORED, services: { sync: { ...ANCHORED.services.sync, schedule: "daily" } } }));
    expect(outcome.ok).toBe(true);
    expect(bench.events.some((event) => event.startsWith("log    differs    shop.sync.timer, edited by hand on the machine"))).toBe(true);
    expect(readFileSync(join(bench.units, "shop.sync.timer"), "utf8")).toContain("RandomizedDelaySec=5min");
  });

  test("a timer name systemd gives to a package's unit: refused before any account", async () => {
    const bench = createBench({ systemUnits: { "shop.sync.timer": "/lib/systemd/system/shop.sync.timer" } });
    stageBundle(bench, SYNC_FILES);
    const outcome = await run(bench, request(ANCHORED));
    expect(outcome).toMatchObject({ ok: false, code: "system-unit" });
    expect(outcome.ok === false && outcome.message).toContain("shop.sync.timer is already a timer of the machine");
    expect(bench.events.some((event) => event.startsWith("useradd"))).toBe(false);
  });

  test("refused once its units were laid, a new project's timers go too, before its services", async () => {
    const bench = createBench({ lockHeld: true });
    stageBundle(bench, SYNC_FILES);
    expect(await run(bench, request(ANCHORED))).toMatchObject({ ok: false, code: "caddy-busy" });
    expect(bench.events).toContain("systemctl disable --now shop.sync.timer shop shop.sync.service");
    expect(readdirSync(bench.units)).toEqual([]);
    expect(bench.events).toContain("log    removed    shop.sync.timer");
  });

  test("a worker beside a backup command: the loopback's set names the server's port alone", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const manifest = { ...BACKGROUND, services: { ...BACKGROUND.services, web: { ...BACKGROUND.services.web, backup: { folder: "index", command: "/usr/local/bin/bun run snapshot.ts" } } } };
    expect((await run(bench, request(manifest))).ok).toBe(true);
    const uid = /^site-shop:x:(\d+):/m.exec(readFileSync(join(bench.root, "passwd"), "utf8"))![1];
    const set = readFileSync(join(bench.root, "projects.nft"), "utf8");
    expect(set).toContain(`{ 3002 . ${uid} }`);
    expect(set.match(/ \. /g)?.length).toBe(1);
  });
});

describe("the secret files a token's project reads are its own", () => {
  // Planted in every secret file these tests lay: no refusal may quote it.
  const CANARY = "secret-value-canary-91c4";
  const passwd = (bench: Bench) => readFileSync(join(bench.root, "passwd"), "utf8");
  const account = (bench: Bench, slug: string, uid: number) => writeFileSync(join(bench.root, "passwd"), `${passwd(bench)}site-${slug}:x:${uid}:${uid}::/nonexistent:/usr/sbin/nologin\n`);
  const lay = (bench: Bench, name: string) => writeFileSync(join(bench.secrets, name), `KEY=${CANARY}\n`, { mode: 0o600 });
  /** Refused before anything was written: no account, no tree, no unit, no block of its own. */
  function nothingLaid(bench: Bench, slug: string): void {
    expect(passwd(bench)).not.toContain(`site-${slug}:`);
    expect(readdirSync(bench.sites)).not.toContain(slug);
    expect(readdirSync(bench.units).filter((name) => name.startsWith(`${slug}.`))).toEqual([]);
    expect(readdirSync(bench.blocks).filter((name) => name.startsWith(`${slug}.`))).toEqual([]);
    expect(bench.events.some((event) => event.startsWith("useradd") || event.startsWith("as "))).toBe(false);
  }
  const refusedFor = (outcome: Outcome, text: string) => {
    expect(outcome).toMatchObject({ ok: false, code: "secret-taken" });
    expect(outcome.ok === false && outcome.message).toContain(text);
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
  };
  const DASHBOARD = { slug: "dashboard", start: "/usr/local/bin/bun run server.ts", port: 3022, publicDir: "public", secrets: ["dashboard.env"] } as Manifest;
  const appNamed = (slug: string, extra: object = {}) => ({ ...APP, slug, ...extra });

  test("a new project named after a file of the machine, declaring it: refused before anything is laid, the file there or not, the dashboard deployed or not", async () => {
    for (const slug of ["dashboard-backup", "dashboard-monitor"]) {
      for (const present of [true, false]) {
        for (const withDashboard of [true, false]) {
          const bench = createBench();
          if (withDashboard) deposit(bench, DASHBOARD);
          if (present) lay(bench, `${slug}.env`);
          stageBundle(bench, APP_FILES);
          refusedFor(await run(bench, request(appNamed(slug, { secrets: [`${slug}.env`] }), PRIVATE, slug)), `${slug}.env belongs to the machine`);
          nothingLaid(bench, slug);
        }
      }
    }
  });

  test("a new project named after a file another project holds: refused, declared or not, the file there or not; cms keeps it", async () => {
    const cms = (secrets: string[]) => ({ slug: "cms", start: "/usr/local/bin/bun run server.ts", port: 3048, publicDir: "public", portal: true, secrets }) as Manifest;
    for (const [declaredByCms, present, declaredByToken] of [
      [true, true, true],
      [true, false, true],
      [false, true, true],
      [false, true, false],
    ] as const) {
      const bench = createBench();
      deposit(bench, cms(declaredByCms ? ["cms.env", "cms-smtp.env"] : ["cms.env"]));
      lay(bench, "cms.env");
      if (present) lay(bench, "cms-smtp.env");
      stageBundle(bench, APP_FILES);
      const outcome = await run(bench, request(appNamed("cms-smtp", declaredByToken ? { secrets: ["cms-smtp.env"] } : {}), PRIVATE, "cms-smtp"));
      refusedFor(outcome, "cms-smtp.env belongs to cms, which this deployment would take it from");
      nothingLaid(bench, "cms-smtp");
    }
  });

  test("a name that takes nothing from anyone is no reason to refuse: cms-blog beside cms, shop beside shop-api", async () => {
    const bench = createBench();
    deposit(bench, { slug: "cms", start: "/usr/local/bin/bun run server.ts", port: 3048, publicDir: "public", portal: true, secrets: ["cms.env"] } as Manifest);
    deposit(bench, { slug: "shop-api", start: "/usr/local/bin/bun run server.ts", port: 3049, publicDir: "public", portal: true, secrets: ["shop-api.env"] } as Manifest);
    lay(bench, "cms.env");
    lay(bench, "shop-api.env");
    for (const slug of ["cms-blog", "shop"]) {
      stageBundle(bench, APP_FILES);
      expect(await run(bench, request(appNamed(slug), PRIVATE, slug))).toMatchObject({ ok: true });
    }
  });

  test("a declared file there before its account, another account's, or not a plain file: refused before anything changes; the project's own passes", async () => {
    // A new project: the file is there before site-shop exists.
    const fresh = createBench();
    lay(fresh, "shop.env");
    stageBundle(fresh, APP_FILES);
    refusedFor(await run(fresh, request({ ...APP, secrets: ["shop.env"] })), "/etc/sitesolide/shop.env is already on the machine and does not belong to site-shop");
    nothingLaid(fresh, "shop");

    // An existing project, the file another account's, or a link.
    for (const [uid, link] of [
      [OWN_UID + 1, false],
      [OWN_UID, true],
    ] as const) {
      const bench = createBench();
      const previous = { ...APP, port: 3040, portal: true, secrets: ["shop.env"] } as Manifest;
      deposit(bench, previous);
      account(bench, "shop", uid);
      if (link) symlinkSync(join(bench.root, "passwd"), join(bench.secrets, "shop.env"));
      else lay(bench, "shop.env");
      stageBundle(bench, APP_FILES);
      refusedFor(await run(bench, request({ ...APP, port: 3040, secrets: ["shop.env"] })), link ? "/etc/sitesolide/shop.env is not a plain file" : "does not belong to site-shop");
      expect(readdirSync(bench.units)).toEqual([]);
      expect(bench.events.some((event) => event.startsWith("as ") || event === "manifest")).toBe(false);
    }

    // Its own: deployed.
    const own = createBench();
    deposit(own, { ...APP, port: 3040, portal: true, secrets: ["shop.env"] } as Manifest);
    account(own, "shop", OWN_UID);
    lay(own, "shop.env");
    stageBundle(own, APP_FILES);
    expect(await run(own, request({ ...APP, port: 3040, secrets: ["shop.env"] }))).toMatchObject({ ok: true });
  });

  test("a file that stopped being the project's while it deployed: the service is not restarted", async () => {
    // The account's uid changes under the Caddy lock, after step 1 judged the file the project's own.
    const bench = createBench({ onLock: (b) => writeFileSync(join(b.root, "passwd"), passwd(b).replace(`site-shop:x:${OWN_UID}:${OWN_UID}`, `site-shop:x:${OWN_UID + 1}:${OWN_UID + 1}`)) });
    deposit(bench, { ...APP, port: 3040, portal: true, secrets: ["shop.env"] } as Manifest);
    account(bench, "shop", OWN_UID);
    lay(bench, "shop.env");
    stageBundle(bench, APP_FILES);
    refusedFor(await run(bench, request({ ...APP, port: 3040, secrets: ["shop.env"] })), "/etc/sitesolide/shop.env does not belong to site-shop");
    expect(bench.events.some((event) => event.startsWith("systemctl restart"))).toBe(false);
  });
});

describe("the project's store of secrets", () => {
  // Planted in every value the tests lay in a store: no log line, no outcome may carry it.
  const CANARY = "store-value-canary-3b7e";
  const mode = (path: string) => lstatSync(path).mode & 0o777;
  const storeOf = (bench: Bench, slug = "shop") => join(bench.store, slug);

  /** The real host, its store and its units recorded in the order they are laid. */
  function recorded(bench: Bench) {
    const host = hostOf(bench);
    return {
      ...host,
      prepareStore: async (slug: string) => {
        bench.events.push("prepare store");
        return host.prepareStore(slug);
      },
      installUnit: async (unit: string, text: string) => {
        bench.events.push(`install unit ${unit}`);
        return host.installUnit(unit, text);
      },
    };
  }

  test("laid before any unit, on every deployment of an app, root's three folders 0700, empty; the old form's apps get one too, a static site none", async () => {
    for (const manifest of [APP, { ...APP, secrets: ["shop.env"] }, { ...APP, secrets: ["ADMIN_TOKEN"] }]) {
      const bench = createBench();
      stageBundle(bench, APP_FILES);
      expect((await runPipeline(recorded(bench), request(manifest), { zone: ZONE, runFolder: bench.run })).ok).toBe(true);
      expect(order(bench, "prepare store", "install unit shop")).toBe(true);
      expect(order(bench, "prepare store", "systemctl restart shop")).toBe(true);
      for (const path of [bench.store, storeOf(bench), join(storeOf(bench), "files")]) expect(mode(path)).toBe(0o700);
      expect(readdirSync(storeOf(bench))).toEqual(["files"]);
      expect(readdirSync(join(storeOf(bench), "files"))).toEqual([]);
      expect(bench.events).toContain("log    the project's store of secrets laid, empty");
    }
    const static_ = createBench();
    stageBundle(static_, [file("public/index.html")]);
    const outcome = await run(static_, request({ slug: "shop", publicDir: "public" }, PUBLIC));
    expect(outcome.ok).toBe(true);
    expect(outcome.missingSecrets).toBeUndefined();
    expect(existsSync(static_.store)).toBe(false);
  });

  test("a files folder deleted by hand comes back at the next deployment, and nothing the store holds is touched", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    expect((await run(bench, request(APP))).ok).toBe(true);
    writeFileSync(join(storeOf(bench), "env"), `API_KEY=${CANARY}\n`, { mode: 0o600 });
    rmSync(join(storeOf(bench), "files"), { recursive: true });
    bench.events.length = 0;
    stageBundle(bench, APP_FILES);
    expect((await run(bench, request(APP))).ok).toBe(true);
    expect(mode(join(storeOf(bench), "files"))).toBe(0o700);
    expect(readFileSync(join(storeOf(bench), "env"), "utf8")).toBe(`API_KEY=${CANARY}\n`);
    expect(bench.events).not.toContain("log    the project's store of secrets laid, empty");
    expect(bench.events.join("\n")).not.toContain(CANARY);
  });

  test("a link, or anything that is no folder, where a folder of the store goes: refused before any unit, the path named; a new project's creation undone, an existing one untouched", async () => {
    const elsewhere = (bench: Bench) => {
      mkdirSync(join(bench.root, "elsewhere"), { recursive: true });
      return join(bench.root, "elsewhere");
    };
    const layouts: [string, (bench: Bench) => string][] = [
      ["the stores' root a link", (bench) => (symlinkSync(elsewhere(bench), bench.store), bench.store)],
      ["the project's folder a link", (bench) => (mkdirSync(bench.store, { recursive: true }), symlinkSync(elsewhere(bench), storeOf(bench)), storeOf(bench))],
      ["the project's folder a file", (bench) => (mkdirSync(bench.store, { recursive: true }), writeFileSync(storeOf(bench), "x"), storeOf(bench))],
      ["its files a link", (bench) => (mkdirSync(storeOf(bench), { recursive: true }), symlinkSync(elsewhere(bench), join(storeOf(bench), "files")), join(storeOf(bench), "files"))],
    ];
    for (const [, lay] of layouts) {
      const bench = createBench();
      const refusedPath = lay(bench);
      stageBundle(bench, APP_FILES);
      const outcome = await run(bench, request(APP));
      expect(outcome).toMatchObject({ ok: false, code: "store-refused", message: `${refusedPath} is not a folder root owns: the owner of the machine must look at it; nothing was changed` });
      expect(readdirSync(bench.units)).toEqual([]);
      expect(readdirSync(bench.sites)).toEqual([]);
      expect(readFileSync(join(bench.root, "passwd"), "utf8")).not.toContain("site-shop");
      // Nothing written through the link.
      expect(existsSync(join(bench.root, "elsewhere", "shop"))).toBe(false);
      expect(existsSync(join(bench.root, "elsewhere", "files"))).toBe(false);
    }
    const existing = createBench();
    const previous = { ...APP, port: 3040, portal: true } as Manifest;
    deposit(existing, previous);
    writeFileSync(join(existing.units, "shop.service"), generateUnits(previous)[0]!.text);
    const before = readFileSync(join(existing.units, "shop.service"), "utf8");
    mkdirSync(storeOf(existing), { recursive: true });
    writeFileSync(join(storeOf(existing), "files"), "not a folder");
    stageBundle(existing, APP_FILES);
    expect(await run(existing, request({ ...APP, port: 3040 }))).toMatchObject({ ok: false, code: "store-refused" });
    expect(readFileSync(join(existing.units, "shop.service"), "utf8")).toBe(before);
    expect(existing.events.some((event) => event.startsWith("systemctl restart"))).toBe(false);
  });

  test("a store that cannot be laid stops before any unit, and says what to do", async () => {
    const bench = createBench();
    const host = { ...hostOf(bench), prepareStore: async () => Promise.reject(Object.assign(new Error("read-only file system"), { code: "EROFS" })) };
    stageBundle(bench, APP_FILES);
    const outcome = await runPipeline(host, request(APP), { zone: ZONE, runFolder: bench.run });
    expect(outcome).toMatchObject({ ok: false, code: "store-failed" });
    expect(outcome.ok === false && outcome.message).toContain("could not be laid under /etc/sitesolide/projects (EROFS)");
    expect(outcome.ok === false && outcome.message).toContain("sitesolide upgrade");
    expect(readdirSync(bench.units)).toEqual([]);
  });

  test("a creation undone takes the store it laid, after its units and its tree; a store found there, written ahead, stays as it is", async () => {
    const traversal = bundle([file("app/../../../etc/cron.d/x", "* * * * * root id")]);
    const bench = createBench({ lockHeld: true });
    stageBundle(bench, APP_FILES);
    expect(await run(bench, request(APP))).toMatchObject({ ok: false, code: "caddy-busy" });
    expect(existsSync(storeOf(bench))).toBe(false);
    expect(order(bench, "log    removed    /srv/sites/shop", "log    removed    the project's store of secrets, empty")).toBe(true);
    expect(order(bench, "systemctl disable --now shop", "log    removed    the project's store of secrets, empty")).toBe(true);

    const ahead = createBench();
    mkdirSync(join(storeOf(ahead), "files"), { recursive: true });
    // Made ahead by the deploying token's own write, as the steward records it.
    storeMadeBy(ahead, "shop", TOKEN_ID);
    writeFileSync(join(storeOf(ahead), "env"), `API_KEY=${CANARY}\n`, { mode: 0o600 });
    stageBundle(ahead, traversal);
    expect(await run(ahead, request(APP))).toMatchObject({ ok: false, code: "bundle-refused" });
    expect(readFileSync(join(storeOf(ahead), "env"), "utf8")).toBe(`API_KEY=${CANARY}\n`);
    expect(ahead.events.join("\n")).not.toContain("store of secrets");
  });

  test("the previous versions a removed project left are dropped when its store is laid anew, and kept when the store was there", async () => {
    const fresh = createBench();
    mkdirSync(join(fresh.previous, "shop", "files"), { recursive: true });
    writeFileSync(join(fresh.previous, "shop", "env"), `API_KEY=${CANARY}\n`);
    mkdirSync(join(fresh.previous, "other"), { recursive: true });
    stageBundle(fresh, APP_FILES);
    expect((await run(fresh, request(APP))).ok).toBe(true);
    expect(existsSync(join(fresh.previous, "shop"))).toBe(false);
    expect(existsSync(join(fresh.previous, "other"))).toBe(true);

    const kept = createBench();
    mkdirSync(join(storeOf(kept), "files"), { recursive: true });
    // Made ahead by the deploying token's own write, as the steward records it.
    storeMadeBy(kept, "shop", TOKEN_ID);
    mkdirSync(join(kept.previous, "shop"), { recursive: true });
    writeFileSync(join(kept.previous, "shop", "env"), "API_KEY=before\n");
    stageBundle(kept, APP_FILES);
    expect((await run(kept, request(APP))).ok).toBe(true);
    expect(readFileSync(join(kept.previous, "shop", "env"), "utf8")).toBe("API_KEY=before\n");
  });

  test("the declared names the store lacks: said in the log and in the outcome, names alone; nothing stops, the service restarted", async () => {
    const bench = createBench();
    mkdirSync(join(storeOf(bench), "files"), { recursive: true });
    // Made ahead by the deploying token's own write, as the steward records it.
    storeMadeBy(bench, "shop", TOKEN_ID);
    writeFileSync(join(storeOf(bench), "env"), `ADMIN_TOKEN=${CANARY}\nUNDECLARED=${CANARY}\n`, { mode: 0o600 });
    writeFileSync(join(storeOf(bench), "files", "gcp.json"), `{"key":"${CANARY}"}`, { mode: 0o600 });
    writeFileSync(join(storeOf(bench), "files", "tls.key"), "", { mode: 0o600 });
    writeFileSync(join(storeOf(bench), "files", ".tls.key.0123456789abcdef.tmp"), CANARY, { mode: 0o600 });
    stageBundle(bench, APP_FILES);
    const manifest = { ...APP, secrets: { runtime: ["ADMIN_TOKEN", "STRIPE_SECRET_KEY", "SESSION_KEY"], files: ["gcp.json", "tls.key"] } };
    const outcome = await run(bench, request(manifest));
    expect(outcome).toMatchObject({ ok: true, missingSecrets: { runtime: ["STRIPE_SECRET_KEY", "SESSION_KEY"], files: ["tls.key"] } });
    expect(bench.events).toContain("log    !! runtime secrets not set on the machine: STRIPE_SECRET_KEY, SESSION_KEY: sitesolide secrets set STRIPE_SECRET_KEY, or sitesolide secrets generate SESSION_KEY");
    expect(bench.events).toContain("log    !! secret files not set on the machine: tls.key: sitesolide secrets set-file tls.key < tls.key");
    expect(bench.events).toContain("systemctl restart shop");
    expect(bench.events.join("\n")).not.toContain(CANARY);
    expect(JSON.stringify(outcome)).not.toContain(CANARY);

    // Every one set: said so, nothing missing.
    writeFileSync(join(storeOf(bench), "env"), `ADMIN_TOKEN=a\nSTRIPE_SECRET_KEY=b\nSESSION_KEY=c\n`, { mode: 0o600 });
    writeFileSync(join(storeOf(bench), "files", "tls.key"), "key", { mode: 0o600 });
    stageBundle(bench, APP_FILES);
    expect(await run(bench, request(manifest))).toMatchObject({ ok: true, missingSecrets: { runtime: [], files: [] } });
    expect(bench.events).toContain("log    every declared name is set");
  });

  test("a store's env that does not read back: said with its line and reason, never the line; nothing known of what is missing, nothing stops", async () => {
    const bench = createBench();
    mkdirSync(join(storeOf(bench), "files"), { recursive: true });
    // Made ahead by the deploying token's own write, as the steward records it.
    storeMadeBy(bench, "shop", TOKEN_ID);
    writeFileSync(join(storeOf(bench), "env"), `export ADMIN_TOKEN=${CANARY}\n`, { mode: 0o600 });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, secrets: ["ADMIN_TOKEN"] }));
    expect(outcome).toMatchObject({ ok: true, missingSecrets: null });
    expect(bench.events.some((event) => event.startsWith("log    !! the store's env does not read back (line 1: "))).toBe(true);
    expect(bench.events).toContain("log    !! the store's names could not be read: whether a declared secret is missing is not checked");
    expect(bench.events.join("\n")).not.toContain(CANARY);
  });

  test("a unit that could not load its files is said as such, 243/CREDENTIALS, at the restart and within the window", async () => {
    const restarting = createBench({ restartFails: true, statuses: { shop: 243 } });
    stageBundle(restarting, APP_FILES);
    expect(await run(restarting, request(APP))).toMatchObject({
      ok: false,
      code: "service-failed",
      message: "shop.service could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh shop lays the folder again: read sitesolide logs",
    });
    const falling = createBench({ falls: { shop: { active: "activating", sub: "auto-restart", restarts: 2, status: 243 } } });
    stageBundle(falling, APP_FILES);
    expect(await run(falling, request(APP))).toMatchObject({ ok: false, code: "service-failed", message: expect.stringContaining("shop.service could not load its secret files (243/CREDENTIALS)") });
    // Any other status is said as before.
    const other = createBench({ restartFails: true, statuses: { shop: 1 } });
    stageBundle(other, APP_FILES);
    expect(await run(other, request(APP))).toMatchObject({ ok: false, code: "service-failed", message: expect.stringContaining("did not come back active") });
  });

  test("a foreign legacy file is still refused before anything is written, the store included; one that becomes foreign meanwhile, before the restart", async () => {
    const bench = createBench();
    deposit(bench, { ...APP, port: 3040, portal: true, secrets: ["shop.env"] } as Manifest);
    writeFileSync(join(bench.root, "passwd"), `${readFileSync(join(bench.root, "passwd"), "utf8")}site-shop:x:${OWN_UID + 1}:${OWN_UID + 1}::/nonexistent:/usr/sbin/nologin\n`);
    writeFileSync(join(bench.secrets, "shop.env"), "A=b\n", { mode: 0o600 });
    stageBundle(bench, APP_FILES);
    expect(await run(bench, request({ ...APP, port: 3040, secrets: ["shop.env"] }))).toMatchObject({ ok: false, code: "secret-taken" });
    expect(existsSync(bench.store)).toBe(false);
    const later = createBench({ onLock: (b) => writeFileSync(join(b.secrets, "shop.env"), "A=b\n", { mode: 0o600 }) });
    writeFileSync(join(later.root, "passwd"), `${readFileSync(join(later.root, "passwd"), "utf8")}site-shop:x:${OWN_UID + 1}:${OWN_UID + 1}::/nonexistent:/usr/sbin/nologin\n`);
    stageBundle(later, APP_FILES);
    expect(await run(later, request({ ...APP, secrets: ["shop.env"] }))).toMatchObject({ ok: false, code: "secret-taken" });
    expect(existsSync(join(storeOf(later), "files"))).toBe(true);
    expect(later.events.some((event) => event.startsWith("systemctl restart"))).toBe(false);
  });
});

describe("what the installer refuses a token whatever its client checked", () => {
  const CANARY = "legacy-value-canary-6d2a";
  const direct = (bench: Bench, requested: InstallRequest) => runPipeline(hostOf(bench), requested, { zone: ZONE, runFolder: bench.run });

  /** shop deployed in the old form: its unit reads shop.env, which holds API_KEY and SMTP_URL. */
  function oldForm(bench: Bench): string {
    const previous = { ...APP, port: 3040, portal: true, secrets: ["shop.env"] } as Manifest;
    deposit(bench, previous);
    const unit = generateUnits(previous)[0]!.text.replace(/EnvironmentFile=-\/etc\/sitesolide\/shop\.env/, `EnvironmentFile=-${bench.secrets}/shop.env`);
    writeFileSync(join(bench.units, "shop.service"), unit);
    writeFileSync(join(bench.secrets, "shop.env"), `API_KEY=${CANARY}\nSMTP_URL=smtp://mail\n`, { mode: 0o600 });
    writeFileSync(join(bench.root, "passwd"), `${readFileSync(join(bench.root, "passwd"), "utf8")}site-shop:x:${OWN_UID}:${OWN_UID}::/nonexistent:/usr/sbin/nologin\n`);
    return unit;
  }

  test("a manifest that reads the store alone over a unit that reads values the store lacks: migrate-first before anything is written, naming no variable", async () => {
    for (const secrets of [["API_KEY"], undefined]) {
      const bench = createBench();
      const unit = oldForm(bench);
      stageBundle(bench, APP_FILES);
      const outcome = await run(bench, request({ ...APP, port: 3040, ...(secrets === undefined ? {} : { secrets }) }));
      expect(outcome).toMatchObject({ ok: false, code: "migrate-first" });
      expect(outcome.ok === false && outcome.message).toBe(
        "migrate first: sitesolide secrets migrate --restart; the service reads 2 variables from legacy files this manifest no longer reads, and the store lacks them: deployed as it is, the service would start without them; nothing was changed",
      );
      expect(readFileSync(join(bench.units, "shop.service"), "utf8")).toBe(unit);
      expect(existsSync(bench.store)).toBe(false);
      expect(bench.events.some((event) => event.startsWith("systemctl") || event.startsWith("as shop"))).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain("API_KEY");
      expect(bench.events.join("\n")).not.toContain(CANARY);
    }
  });

  test("the old form, or a store that holds every name, deploys; a legacy file that does not read, or a store whose names do not, refuses", async () => {
    const legacy = createBench();
    oldForm(legacy);
    stageBundle(legacy, APP_FILES);
    expect((await run(legacy, request({ ...APP, port: 3040, secrets: ["shop.env"] }))).ok).toBe(true);

    const migrated = createBench();
    oldForm(migrated);
    mkdirSync(join(migrated.store, "shop", "files"), { recursive: true });
    writeFileSync(join(migrated.store, "shop", "env"), "API_KEY=a\nSMTP_URL=b\n", { mode: 0o600 });
    stageBundle(migrated, APP_FILES);
    expect((await run(migrated, request({ ...APP, port: 3040, secrets: ["API_KEY"] }))).ok).toBe(true);

    const unmanaged = createBench();
    oldForm(unmanaged);
    writeFileSync(join(unmanaged.secrets, "shop.env"), "export API_KEY=x\n", { mode: 0o600 });
    stageBundle(unmanaged, APP_FILES);
    const refused = await run(unmanaged, request({ ...APP, port: 3040, secrets: ["API_KEY"] }));
    expect(refused).toMatchObject({ ok: false, code: "migrate-first" });
    expect(refused.ok === false && refused.message).toContain("a legacy file the dashboard does not manage");

    const unreadable = createBench();
    oldForm(unreadable);
    mkdirSync(join(unreadable.store, "shop", "files"), { recursive: true });
    writeFileSync(join(unreadable.store, "shop", "env"), "export A=b\n", { mode: 0o600 });
    stageBundle(unreadable, APP_FILES);
    expect(await run(unreadable, request({ ...APP, port: 3040, secrets: ["API_KEY"] }))).toMatchObject({ ok: false, code: "machine-unreadable" });
  });

  test("the old form naming fewer files than the unit reads: what the dropped file alone supplies stops the deployment, migrate-first; moved to the kept file, or in the store, it goes on", async () => {
    const layout = () => {
      const bench = createBench();
      const previous = { ...APP, port: 3040, portal: true, secrets: ["shop.env", "smtp.env"] } as Manifest;
      deposit(bench, previous);
      const unit = generateUnits(previous)[0]!.text.replaceAll("EnvironmentFile=-/etc/sitesolide/", `EnvironmentFile=-${bench.secrets}/`);
      writeFileSync(join(bench.units, "shop.service"), unit);
      writeFileSync(join(bench.secrets, "shop.env"), "API_KEY=a\n", { mode: 0o600 });
      writeFileSync(join(bench.secrets, "smtp.env"), `SMTP_URL=${CANARY}\n`, { mode: 0o600 });
      writeFileSync(join(bench.root, "passwd"), `${readFileSync(join(bench.root, "passwd"), "utf8")}site-shop:x:${OWN_UID}:${OWN_UID}::/nonexistent:/usr/sbin/nologin\n`);
      stageBundle(bench, APP_FILES);
      return { bench, unit };
    };
    const dropped = layout();
    const refused = await run(dropped.bench, request({ ...APP, port: 3040, secrets: ["shop.env"] }));
    expect(refused).toMatchObject({ ok: false, code: "migrate-first" });
    expect(refused.ok === false && refused.message).toContain("the service reads 1 variable from legacy files this manifest no longer reads");
    expect(readFileSync(join(dropped.bench.units, "shop.service"), "utf8")).toBe(dropped.unit);
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    // The names form over the same unit: both files dropped.
    const names = layout();
    expect(await run(names.bench, request({ ...APP, port: 3040, secrets: ["API_KEY"] }))).toMatchObject({ ok: false, code: "migrate-first" });

    // SMTP_URL now in the kept file: nothing dropped.
    const moved = layout();
    writeFileSync(join(moved.bench.secrets, "shop.env"), "API_KEY=a\nSMTP_URL=moved\n", { mode: 0o600 });
    expect((await run(moved.bench, request({ ...APP, port: 3040, secrets: ["shop.env"] }))).ok).toBe(true);
    // SMTP_URL in the store: nothing dropped either.
    const stored = layout();
    mkdirSync(join(stored.bench.store, "shop", "files"), { recursive: true });
    writeFileSync(join(stored.bench.store, "shop", "env"), "SMTP_URL=stored\n", { mode: 0o600 });
    expect((await run(stored.bench, request({ ...APP, port: 3040, secrets: ["shop.env"] }))).ok).toBe(true);
  });

  test("a creation that finds its project laid since it was accepted, its manifest or its tree: refused, the other's project untouched", async () => {
    const deposited = createBench();
    deposit(deposited, { ...APP, port: 3040, portal: true } as Manifest);
    writeFileSync(join(deposited.sites, "shop", "app", "server.ts"), "the owner's code");
    stageBundle(deposited, APP_FILES);
    expect(await direct(deposited, request(APP))).toMatchObject({ ok: false, code: "taken-meanwhile" });
    expect(readFileSync(join(deposited.sites, "shop", "app", "server.ts"), "utf8")).toBe("the owner's code");
    expect(deposited.events.some((event) => event.startsWith("useradd") || event.startsWith("as shop"))).toBe(false);

    const tree = createBench();
    mkdirSync(join(tree.sites, "shop", "app"), { recursive: true });
    writeFileSync(join(tree.sites, "shop", "app", "server.ts"), "laid by the owner, its manifest not yet");
    stageBundle(tree, APP_FILES);
    expect(await direct(tree, request(APP))).toMatchObject({ ok: false, code: "taken-meanwhile" });
    expect(readFileSync(join(tree.sites, "shop", "app", "server.ts"), "utf8")).toBe("laid by the owner, its manifest not yet");
    expect(readdirSync(tree.units)).toEqual([]);
  });

  test("a creation finding a store no write of its token made: refused before any unit, the store untouched, the creation undone; its own store passes", async () => {
    for (const [name, lay] of [
      ["the owner's", () => undefined],
      ["another token's", (bench: Bench) => storeMadeBy(bench, "shop", "bbbbbbbbbbbb")],
      ["claims that do not read", (bench: Bench) => writeFileSync(join(bench.root, "claims.json"), "not json")],
    ] as const) {
      const bench = createBench();
      mkdirSync(join(bench.store, "shop", "files"), { recursive: true });
      writeFileSync(join(bench.store, "shop", "env"), `STRIPE_SECRET_KEY=${CANARY}\n`, { mode: 0o600 });
      lay(bench);
      stageBundle(bench, APP_FILES);
      const outcome = await run(bench, request(APP));
      expect({ name, outcome }).toMatchObject({ name, outcome: { ok: false, code: "store-not-yours" } });
      expect(readdirSync(bench.units)).toEqual([]);
      expect(readdirSync(bench.sites)).toEqual([]);
      expect(readFileSync(join(bench.store, "shop", "env"), "utf8")).toBe(`STRIPE_SECRET_KEY=${CANARY}\n`);
    }
    const own = createBench();
    mkdirSync(join(own.store, "shop", "files"), { recursive: true });
    storeMadeBy(own, "shop", TOKEN_ID);
    stageBundle(own, APP_FILES);
    expect((await run(own, request(APP))).ok).toBe(true);
  });
});

describe("what a creation laid itself", () => {
  /** The real host, what the pipeline says of the folder it laid recorded. */
  const told = (bench: Bench) => ({ ...hostOf(bench), laid: (laid: boolean) => void bench.events.push(`laid ${laid}`) });

  test("said as soon as its installer made the project's folder, and taken back when it removes it again; never for one it found", async () => {
    const kept = createBench({ restartFails: true });
    stageBundle(kept, APP_FILES);
    expect(await runPipeline(told(kept), request(APP), { zone: ZONE, runFolder: kept.run })).toMatchObject({ ok: false, code: "service-failed" });
    expect(kept.events.filter((event) => event.startsWith("laid"))).toEqual(["laid true"]);
    expect(order(kept, "laid true", "as shop extract")).toBe(true);

    const undone = createBench({ lockHeld: true });
    stageBundle(undone, APP_FILES);
    expect(await runPipeline(told(undone), request(APP), { zone: ZONE, runFolder: undone.run })).toMatchObject({ ok: false, code: "caddy-busy" });
    expect(undone.events.filter((event) => event.startsWith("laid"))).toEqual(["laid true", "laid false"]);

    const existing = createBench();
    deposit(existing, { ...APP, port: 3040, portal: true } as Manifest);
    stageBundle(existing, APP_FILES);
    expect((await runPipeline(told(existing), asJudged(existing, request({ ...APP, port: 3040 })), { zone: ZONE, runFolder: existing.run })).ok).toBe(true);
    expect(existing.events.filter((event) => event.startsWith("laid"))).toEqual([]);
  });
});

describe("the zone's sites for the ask endpoint", () => {
  const STATIC = { slug: "shop", publicDir: "public" };
  const STATIC_FILES = [file("public/index.html", "static")];
  const said = (bench: Bench, text: string) => bench.events.some((event) => event.startsWith("log ") && event.includes(text));

  test("a provider's zone: the script runs and writes nothing, nothing is said, and a site that does not answer fails at once", async () => {
    const bench = createBench({ probe: (host) => (host === `shop.${ZONE}` ? { error: "connection refused" } : null) });
    stageBundle(bench, STATIC_FILES);
    const outcome = await run(bench, request(STATIC, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed" });
    expect(bench.events).toContain("zone-names");
    expect(zoneNames(bench)).toBeNull();
    expect(said(bench, ZONE_NAMES_PATH) || said(bench, "no answer yet")).toBe(false);
    expect(bench.elapsed).toBe(0);
  });

  test("manual DNS: listed before the first handshake, and the site's first certificate waited for", async () => {
    let attempts = 0;
    const bench = createBench({ onDemand: true, probe: (host) => (host === `shop.${ZONE}` && ++attempts < 4 ? { error: "tls: handshake failure" } : null) });
    stageBundle(bench, STATIC_FILES);
    const outcome = await run(bench, request(STATIC, PUBLIC));
    expect(outcome).toMatchObject({ ok: true, url: `https://shop.${ZONE}/` });
    expect(parseZoneNames(zoneNames(bench)!)).toEqual(new Set(["shop"]));
    expect(said(bench, `${ZONE_NAMES_PATH}: 1 site(s) under the zone`)).toBe(true);
    expect(said(bench, `no answer yet: the zone is certified on demand, and the site's first certificate is obtained by this handshake; asking again for up to ${FIRST_CERTIFICATE_MS / 1000} s`)).toBe(true);
    expect(attempts).toBe(4);
    expect(bench.events.indexOf("zone-names")).toBeLessThan(bench.events.indexOf("log -> verify"));
  });

  test("manual DNS: a site that never answers fails once the bound is reached, and not before", async () => {
    const bench = createBench({ onDemand: true, probe: (host) => (host === `shop.${ZONE}` ? { error: "tls: handshake failure" } : null) });
    stageBundle(bench, STATIC_FILES);
    const outcome = await run(bench, request(STATIC, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed" });
    expect(bench.elapsed).toBeGreaterThan(FIRST_CERTIFICATE_MS - 10_000);
    expect(bench.elapsed).toBeLessThanOrEqual(FIRST_CERTIFICATE_MS);
  });

  test("manual DNS: an open app's block waits for its first certificate too, while every other site answers", async () => {
    let attempts = 0;
    const bench = createBench({
      onDemand: true,
      probe: (host, _path, current) => (host === `shop.${ZONE}` && current.events.includes("reload") && ++attempts < 4 ? { error: "tls: handshake failure" } : null),
    });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP, PUBLIC));
    expect(outcome.ok).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(said(bench, "validated, reloaded")).toBe(true);
  });

  test("a provider's zone: an app's block that does not answer is restored within the gatekeeper's delay", async () => {
    const bench = createBench({ probe: (host, _path, current) => (host === `shop.${ZONE}` && current.events.includes("reload") ? { error: "connection refused" } : null) });
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request(APP, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "caddy-refused" });
    expect(bench.elapsed).toBeLessThan(FIRST_CERTIFICATE_MS / 3);
  });

  test("manual DNS: a creation undone takes its name out of the list again", async () => {
    const bench = createBench({ onDemand: true });
    const link = header("app/escape", { type: "2", mode: 0o777, size: 0, mtime: 1 });
    const tar = new Uint8Array([...entryBlocks(file("app/a"))[0]!, ...entryBlocks(file("app/a"))[1]!, ...link, ...new Uint8Array(1024)]);
    stageBundle(bench, Bun.gzipSync(tar));
    const outcome = await run(bench, request(APP));
    expect(outcome).toMatchObject({ ok: false, code: "bundle-refused" });
    expect(existsSync(join(bench.sites, "shop"))).toBe(false);
    expect(parseZoneNames(zoneNames(bench)!).has("shop")).toBe(false);
    // Written once, by the undoing: never listed before the archive was judged.
    expect(bench.events.filter((event) => event === "zone-names")).toHaveLength(1);
  });

  test("manual DNS: a name is listed only once the deployment is in place, never while `install` runs", async () => {
    // A token that may create projects could otherwise open TLS to a name
    // whose install it makes last and fail, a certificate spent each time.
    const bench = createBench({ onDemand: true });
    stageBundle(bench, APP_FILES);
    const failed = await run(bench, request({ ...APP, install: "echo broken >&2; exit 3" }));
    expect(failed).toMatchObject({ ok: false, code: "install-failed" });
    const listedAt = bench.events.indexOf("zone-names");
    expect(listedAt).toBeGreaterThan(bench.events.indexOf("as shop install"));
    expect(parseZoneNames(zoneNames(bench)!).has("shop")).toBe(false);

    const kept = createBench({ onDemand: true });
    stageBundle(kept, APP_FILES);
    expect((await run(kept, request({ ...APP, install: "echo ok" }, PUBLIC))).ok).toBe(true);
    expect(kept.events).toContain("as shop install");
    expect(order(kept, "as shop install", "zone-names")).toBe(true);
    expect(order(kept, "log -> manifest", "zone-names")).toBe(false);
    expect(parseZoneNames(zoneNames(kept)!).has("shop")).toBe(true);
  });
});

describe("finalManifest and replaceable, pure", () => {
  test("the scope is judged on the manifest the machine would carry", () => {
    expect(() => finalManifest(request({ ...APP, network: "outbound" }), new Map())).toThrow("network");
    expect(() => finalManifest(request({ ...APP, secrets: ["dashboard.env"] }), new Map())).toThrow("secrets");
    expect(() => finalManifest(request({ slug: "shop" }), new Map())).toThrow("publicDir");
    expect(() => finalManifest(request({ ...APP, slug: "cms" }), new Map())).toThrow("slug");
  });

  test("an unreadable manifest on the machine decides nothing", () => {
    expect(() => finalManifest(request(APP), new Map([["shop", "{"]]))).toThrow("does not read");
  });

  test("a domain's switch is the machine's, never the token's: active only as the owner left it, for the same names", () => {
    const DOMAIN_SCOPE: Scope = { ...PRIVATE, domain: true };
    const domainOf = (text: string) => readManifest(text).manifest!.domain;
    const machine = (domain: object) => new Map([["shop", `${JSON.stringify({ ...APP, port: 3040, portal: true, domain })}\n`]]);
    // A new project switches nothing on.
    expect(domainOf(finalManifest(request({ ...APP, domain: { name: "shop.example", active: true } }, DOMAIN_SCOPE), new Map()).text)).toEqual({ name: "shop.example", active: false });
    // Inactive on the machine: the token cannot switch it on.
    expect(domainOf(finalManifest(request({ ...APP, port: 3040, domain: { name: "shop.example", active: true } }, DOMAIN_SCOPE), machine({ name: "shop.example", active: false })).text)?.active).toBe(false);
    // Active on the machine: the token cannot switch it off, nor carry the switch to another name or a new alias.
    expect(domainOf(finalManifest(request({ ...APP, port: 3040, domain: { name: "shop.example" } }, DOMAIN_SCOPE), machine({ name: "shop.example", active: true })).text)?.active).toBe(true);
    expect(domainOf(finalManifest(request({ ...APP, port: 3040, domain: { name: "other.example", active: true } }, DOMAIN_SCOPE), machine({ name: "shop.example", active: true })).text)?.active).toBe(false);
    expect(domainOf(finalManifest(request({ ...APP, port: 3040, domain: { name: "shop.example", aliases: ["new.example"], active: true } }, DOMAIN_SCOPE), machine({ name: "shop.example", active: true })).text)?.active).toBe(false);
  });

  test("a file is replaceable when absent, identical, or the previous manifest's own", () => {
    expect(replaceable(null, "a b", null)).toBe(true);
    expect(replaceable("x 1\n", "x 1", null)).toBe(true);
    expect(replaceable("x 1", "x 2", "x 1")).toBe(true);
    expect(replaceable("x 1\ny 2", "x 2", "x 1")).toBe(false);
    expect(replaceable("x 1", "x 2", null)).toBe(false);
  });

  test("a unit is the generator's own only with its EnvironmentFile= lines in the same order and number; a block has none", () => {
    const written = "Type=simple\nEnvironmentFile=-/etc/sitesolide/a.env\nEnvironmentFile=-/etc/sitesolide/b.env\n";
    expect(generatedAs(written, written)).toBe(true);
    expect(generatedAs(`# kept\n${written}\n`, written)).toBe(true);
    expect(generatedAs("Type=simple\nEnvironmentFile=-/etc/sitesolide/b.env\nEnvironmentFile=-/etc/sitesolide/a.env\n", written)).toBe(false);
    expect(generatedAs(`${written}EnvironmentFile=-/etc/sitesolide/a.env\n`, written)).toBe(false);
    expect(generatedAs("EnvironmentFile=-/etc/sitesolide/a.env\nType=simple\nEnvironmentFile=-/etc/sitesolide/b.env\n", written)).toBe(true);
    // Both the file generated now and the previous manifest's are held to it.
    expect(replaceable(`${written}EnvironmentFile=-/etc/sitesolide/a.env\n`, "Type=notify\n", written)).toBe(false);
    expect(replaceable(`${written}EnvironmentFile=-/etc/sitesolide/a.env\n`, written, null)).toBe(false);
    expect(replaceable("x 1\ny 2\n", "y 2\nx 1\n", null)).toBe(true);
  });
});
