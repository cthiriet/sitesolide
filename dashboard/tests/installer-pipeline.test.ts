import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { bundle, entryBlocks, header } from "../borrowed/bundle";
import { generateFragment } from "../borrowed/fragment";
import { readManifest, type Manifest } from "../borrowed/manifest";
import { fragmentIsProtected } from "../borrowed/portal";
import { generateUnits } from "../borrowed/unit";
import type { InstallRequest, Scope } from "../src/control/protocol";
import { finalManifest, replaceable, runPipeline, type Outcome } from "../src/installer/pipeline";
import { createBench as newBench, file, hostOf, stageBundle as stage, ZONE, type Bench, type BenchOptions } from "./installer-bench";

/**
 * The installer's pipeline on a throwaway tree, with the real host: real
 * files, a real extraction by `installer.ts --extract` in a child process, a
 * real `install` command, and the real staging and swap. What needs root or a
 * machine is simulated, see installer-bench.ts.
 */

const DEPLOYMENT = "0123456789abcdef01234567";
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
    token: { id: "aaaaaaaaaaaa", email: "ada@test-zone.invalid", member: null },
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

async function run(bench: Bench, requested: InstallRequest): Promise<Outcome> {
  return runPipeline(hostOf(bench), requested, { zone: ZONE, runFolder: bench.run });
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
    expect(outcome).toEqual({ ok: true, url: `https://shop.${ZONE}/`, allocated: [{ service: null, port: 3002 }] });

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
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    expect(await run(bench, request({ ...APP, secrets: ["shop.env"] }))).toMatchObject({ ok: false, code: "secret-missing" });
    expect(passwd(bench)).toContain("site-shop");
    expect(existsSync(join(bench.sites, "shop", "sitesolide.json"))).toBe(true);
    expect(bench.events.some((event) => event.startsWith("userdel"))).toBe(false);
  });
});

describe("after the files are in place", () => {
  test("a missing secret: the files are there, the service is not restarted, the owner is told where to create it", async () => {
    const bench = createBench();
    stageBundle(bench, APP_FILES);
    const outcome = await run(bench, request({ ...APP, secrets: ["shop.env"] }));
    expect(outcome).toMatchObject({ ok: false, code: "secret-missing" });
    expect(outcome.ok === false && outcome.message).toContain(`https://dashboard.${ZONE}/`);
    expect(bench.events.some((event) => event.startsWith("systemctl restart"))).toBe(false);
    writeFileSync(join(bench.secrets, "shop.env"), "TOKEN=x\n");
    stageBundle(bench, APP_FILES);
    expect((await run(bench, request({ ...APP, secrets: ["shop.env"] }))).ok).toBe(true);
  });

  test("a site whose root answers 404 fails, saying what to serve there", async () => {
    const bench = createBench({ probe: (host, path) => (host === `shop.${ZONE}` && path === "/" ? { code: 404, door: false, body: "" } : null) });
    stageBundle(bench, [file("public/about.html", "no index")]);
    const outcome = await run(bench, request({ slug: "shop", publicDir: "public" }, PUBLIC));
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed" });
    expect(outcome.ok === false && outcome.message).toContain("nothing is served at the site's root");
    expect(outcome.ok === false && outcome.message).toContain("index.html in publicDir");
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

  test("a file is replaceable when absent, identical, or the previous manifest's own", () => {
    expect(replaceable(null, "a b", null)).toBe(true);
    expect(replaceable("x 1\n", "x 1", null)).toBe(true);
    expect(replaceable("x 1", "x 2", "x 1")).toBe(true);
    expect(replaceable("x 1\ny 2", "x 2", "x 1")).toBe(false);
    expect(replaceable("x 1", "x 2", null)).toBe(false);
  });
});
