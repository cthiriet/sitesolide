import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFragment, isDisabledBlock } from "../borrowed/fragment";
import { readManifest } from "../borrowed/manifest";
import type { LifecycleRequest } from "../src/control/protocol";
import { readLifecycleLaunch, readLifecycleRequest, runLifecycle } from "../src/installer/lifecycle";
import { ZONE, type Bench } from "./installer-bench";
import { takeLock } from "../src/backup/lock";
import { runRename } from "../src/installer/rename";
import { APP, backupRunFolderOf, createBench, deploy, NOW, renameHost } from "./rename-bench";

/**
 * Turning a project off, on, and removing it, on the installer's bench: a
 * project deployed for real, then the run with the real host. The bench's
 * Caddy answers a site turned off with its 503, as disabledFragment makes it.
 */

const asking = (slug: string, action: LifecycleRequest["action"]): LifecycleRequest => ({ slug, action, requestedAt: Date.now(), actor: "owner" });

/** The bench, whose probe answers a 503 for a site whose block in service is a disabled one. */
function bench(): Bench {
  return createBench({
    probe: (host, _path, b) => {
      const slug = host.slice(0, -(ZONE.length + 1));
      return isDisabledBlock(b.served.get(slug) ?? null) ? { code: 503, door: false, body: "" } : null;
    },
  });
}

const manifestOf = (b: Bench, slug = "oldsite") => readManifest(readFileSync(join(b.sites, slug, "sitesolide.json"), "utf8")).manifest!;

describe("a project turned off, then on", () => {
  test("off: its services stopped, its block says so, everything kept; on: back as deploy left it", async () => {
    const b = bench();
    await deploy(b);
    const own = readFileSync(join(b.blocks, "oldsite.caddy"), "utf8");
    mkdirSync(join(b.sites, "oldsite", "data"), { recursive: true });
    writeFileSync(join(b.sites, "oldsite", "data", "app.db"), "rows");

    expect(await runLifecycle(renameHost(b), asking("oldsite", "disable"), { zone: ZONE })).toEqual({ ok: true });
    expect(manifestOf(b).disabled).toBe(true);
    expect(isDisabledBlock(readFileSync(join(b.blocks, "oldsite.caddy"), "utf8"))).toBe(true);
    expect(b.events).toContain("systemctl disable --now oldsite");
    // Everything else stays: the unit file, the data, the account.
    expect(existsSync(join(b.units, "oldsite.service"))).toBe(true);
    expect(readFileSync(join(b.sites, "oldsite", "data", "app.db"), "utf8")).toBe("rows");

    b.events.length = 0;
    expect(await runLifecycle(renameHost(b), asking("oldsite", "enable"), { zone: ZONE })).toEqual({ ok: true });
    expect(manifestOf(b).disabled).toBeUndefined();
    expect(readFileSync(join(b.blocks, "oldsite.caddy"), "utf8")).toBe(own);
    expect(readFileSync(join(b.blocks, "oldsite.caddy"), "utf8")).toBe(generateFragment(manifestOf(b))!);
    expect(b.events).toContain("systemctl enable oldsite");
    expect(b.events).toContain("systemctl restart oldsite");
    expect(b.events.indexOf("reload")).toBeLessThan(b.events.indexOf("systemctl restart oldsite"));
  });

  test("a static site gets the block that says so, and loses it once on", async () => {
    const b = bench();
    await deploy(b, { slug: "blog", publicDir: "public" });
    expect(await runLifecycle(renameHost(b), asking("blog", "disable"), { zone: ZONE })).toEqual({ ok: true });
    expect(isDisabledBlock(readFileSync(join(b.blocks, "blog.caddy"), "utf8"))).toBe(true);
    expect(await runLifecycle(renameHost(b), asking("blog", "enable"), { zone: ZONE })).toEqual({ ok: true });
    expect(existsSync(join(b.blocks, "blog.caddy"))).toBe(false);
  });

  test("turned off twice is refused, nothing changed", async () => {
    const b = bench();
    await deploy(b);
    await runLifecycle(renameHost(b), asking("oldsite", "disable"), { zone: ZONE });
    b.events.length = 0;
    const again = await runLifecycle(renameHost(b), asking("oldsite", "disable"), { zone: ZONE });
    expect(again).toMatchObject({ ok: false, code: "refused" });
    expect(b.events.some((event) => event.startsWith("systemctl"))).toBe(false);
  });

  test("a site that keeps answering once its block says it is off is put back on", async () => {
    const b = createBench();
    await deploy(b);
    const outcome = await runLifecycle(renameHost(b), asking("oldsite", "disable"), { zone: ZONE });
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed" });
    expect((outcome as { message: string }).message).toContain("oldsite is back as it was");
    expect(manifestOf(b).disabled).toBeUndefined();
    expect(isDisabledBlock(readFileSync(join(b.blocks, "oldsite.caddy"), "utf8"))).toBe(false);
    expect(b.events).toContain("systemctl restart oldsite");
  });
});

describe("a project removed", () => {
  test("its units, folder, store and account go; its neighbours still answer", async () => {
    const b = bench();
    await deploy(b);
    await deploy(b, { slug: "blog", publicDir: "public" });
    mkdirSync(join(b.store, "oldsite", "files"), { recursive: true });
    writeFileSync(join(b.store, "oldsite", "env"), "STRIPE_SECRET_KEY=x\n");
    expect(await runLifecycle(renameHost(b), asking("oldsite", "remove"), { zone: ZONE })).toEqual({ ok: true });
    for (const gone of [join(b.sites, "oldsite"), join(b.store, "oldsite"), join(b.units, "oldsite.service"), join(b.blocks, "oldsite.caddy")]) {
      expect(existsSync(gone)).toBe(false);
    }
    expect(readFileSync(join(b.root, "passwd"), "utf8")).not.toMatch(/^site-oldsite:/m);
    expect(existsSync(join(b.sites, "blog", "public", "index.html"))).toBe(true);
    // Nothing deleted before Caddy reloaded without its block.
    expect(b.events.indexOf("reload")).toBeLessThan(b.events.findIndex((event) => event.startsWith("userdel")));
  });

  test("a project with its own domain leaves the domain table", async () => {
    const b = bench();
    await deploy(b, { ...APP, domain: { name: "cybersolide.example" } });
    const path = join(b.sites, "oldsite", "sitesolide.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.domain.active = true;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(b.root, "domaines.map"), "cybersolide.example oldsite\n");
    expect(await runLifecycle(renameHost(b), asking("oldsite", "remove"), { zone: ZONE })).toEqual({ ok: true });
    expect(readFileSync(join(b.root, "domaines.map"), "utf8")).not.toContain("oldsite");
  });

  test("Caddy refusing the configuration without it deletes nothing", async () => {
    const b = bench();
    await deploy(b);
    let validations = 0;
    b.options.validate = () => (++validations === 2 ? { ok: false, output: "Error: refused" } : { ok: true, output: "Valid configuration" });
    const outcome = await runLifecycle(renameHost(b), asking("oldsite", "remove"), { zone: ZONE });
    expect(outcome).toMatchObject({ ok: false, code: "caddy-refused" });
    expect(existsSync(join(b.sites, "oldsite", "sitesolide.json"))).toBe(true);
    expect(existsSync(join(b.blocks, "oldsite.caddy"))).toBe(true);
    expect(b.events).toContain("systemctl restart oldsite");
  });
});

describe("a backup or a restore under way", () => {
  test("a removal waits for it, then refuses, nothing changed", async () => {
    const b = bench();
    await deploy(b);
    // The hourly run, alive: this very process holds it.
    const run = takeLock(backupRunFolderOf(b), "run");
    expect(run.ok).toBe(true);
    const outcome = await runLifecycle(renameHost(b, { backupLockWaitMs: 50 }), asking("oldsite", "remove"), { zone: ZONE });
    expect(outcome).toMatchObject({ ok: false, code: "backup-busy" });
    expect(existsSync(join(b.sites, "oldsite", "sitesolide.json"))).toBe(true);
    expect(b.events.filter((event) => event.startsWith("systemctl disable"))).toEqual([]);
    if (run.ok) run.release();
  });

  test("a rename waits for it, then goes on once it is over, and lets the lock go", async () => {
    const b = bench();
    await deploy(b);
    const run = takeLock(backupRunFolderOf(b), "run");
    if (!run.ok) throw new Error("the lock was not taken");
    setTimeout(run.release, 100);
    const outcome = await runRename(renameHost(b, { backupLockWaitMs: 5000 }), { slug: "oldsite", to: "cyber", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE });
    expect(outcome.ok).toBe(true);
    // Free again for the next backup run.
    const next = takeLock(backupRunFolderOf(b), "run");
    expect(next.ok).toBe(true);
    if (next.ok) next.release();
  });
});

describe("the launch and the request", () => {
  test("the unit's name gives the slug, the request the action, fresh", () => {
    expect(readLifecycleLaunch(["--lifecycle", "sitesolide-lifecycle@oldsite.service"])).toEqual({ ok: true, slug: "oldsite" });
    expect(readLifecycleLaunch(["--lifecycle", "sitesolide-rename@oldsite.service"]).ok).toBe(false);
    const text = JSON.stringify({ slug: "oldsite", action: "disable", requestedAt: NOW, actor: "owner" });
    expect(readLifecycleRequest(text, "oldsite", NOW).ok).toBe(true);
    expect(readLifecycleRequest(JSON.stringify({ slug: "oldsite", action: "explode", requestedAt: NOW, actor: "owner" }), "oldsite", NOW).ok).toBe(false);
    expect(readLifecycleRequest(text, "oldsite", NOW + 11 * 60_000).ok).toBe(false);
  });
});
