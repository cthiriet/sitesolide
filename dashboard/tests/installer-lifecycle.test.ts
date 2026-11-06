import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFragment, isDisabledBlock } from "../borrowed/fragment";
import { readManifest } from "../borrowed/manifest";
import type { LifecycleRequest } from "../src/control/protocol";
import { readLifecycleLaunch, readLifecycleRequest, runLifecycle } from "../src/installer/lifecycle";
import { ZONE, type Bench } from "./installer-bench";
import { APP, createBench, deploy, NOW, renameHost } from "./rename-bench";

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

const manifestOf = (b: Bench, slug = "nis2") => readManifest(readFileSync(join(b.sites, slug, "sitesolide.json"), "utf8")).manifest!;

describe("a project turned off, then on", () => {
  test("off: its services stopped, its block says so, everything kept; on: back as deploy left it", async () => {
    const b = bench();
    await deploy(b);
    const own = readFileSync(join(b.blocks, "nis2.caddy"), "utf8");
    mkdirSync(join(b.sites, "nis2", "data"), { recursive: true });
    writeFileSync(join(b.sites, "nis2", "data", "app.db"), "rows");

    expect(await runLifecycle(renameHost(b), asking("nis2", "disable"), { zone: ZONE })).toEqual({ ok: true });
    expect(manifestOf(b).disabled).toBe(true);
    expect(isDisabledBlock(readFileSync(join(b.blocks, "nis2.caddy"), "utf8"))).toBe(true);
    expect(b.events).toContain("systemctl disable --now nis2");
    // Everything else stays: the unit file, the data, the account.
    expect(existsSync(join(b.units, "nis2.service"))).toBe(true);
    expect(readFileSync(join(b.sites, "nis2", "data", "app.db"), "utf8")).toBe("rows");

    b.events.length = 0;
    expect(await runLifecycle(renameHost(b), asking("nis2", "enable"), { zone: ZONE })).toEqual({ ok: true });
    expect(manifestOf(b).disabled).toBeUndefined();
    expect(readFileSync(join(b.blocks, "nis2.caddy"), "utf8")).toBe(own);
    expect(readFileSync(join(b.blocks, "nis2.caddy"), "utf8")).toBe(generateFragment(manifestOf(b))!);
    expect(b.events).toContain("systemctl enable nis2");
    expect(b.events).toContain("systemctl restart nis2");
    expect(b.events.indexOf("reload")).toBeLessThan(b.events.indexOf("systemctl restart nis2"));
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
    await runLifecycle(renameHost(b), asking("nis2", "disable"), { zone: ZONE });
    b.events.length = 0;
    const again = await runLifecycle(renameHost(b), asking("nis2", "disable"), { zone: ZONE });
    expect(again).toMatchObject({ ok: false, code: "refused" });
    expect(b.events.some((event) => event.startsWith("systemctl"))).toBe(false);
  });

  test("a site that keeps answering once its block says it is off is put back on", async () => {
    const b = createBench();
    await deploy(b);
    const outcome = await runLifecycle(renameHost(b), asking("nis2", "disable"), { zone: ZONE });
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed" });
    expect((outcome as { message: string }).message).toContain("nis2 is back as it was");
    expect(manifestOf(b).disabled).toBeUndefined();
    expect(isDisabledBlock(readFileSync(join(b.blocks, "nis2.caddy"), "utf8"))).toBe(false);
    expect(b.events).toContain("systemctl restart nis2");
  });
});

describe("a project removed", () => {
  test("its units, folder, store and account go; its neighbours still answer", async () => {
    const b = bench();
    await deploy(b);
    await deploy(b, { slug: "blog", publicDir: "public" });
    mkdirSync(join(b.store, "nis2", "files"), { recursive: true });
    writeFileSync(join(b.store, "nis2", "env"), "STRIPE_SECRET_KEY=x\n");
    expect(await runLifecycle(renameHost(b), asking("nis2", "remove"), { zone: ZONE })).toEqual({ ok: true });
    for (const gone of [join(b.sites, "nis2"), join(b.store, "nis2"), join(b.units, "nis2.service"), join(b.blocks, "nis2.caddy")]) {
      expect(existsSync(gone)).toBe(false);
    }
    expect(readFileSync(join(b.root, "passwd"), "utf8")).not.toMatch(/^site-nis2:/m);
    expect(existsSync(join(b.sites, "blog", "public", "index.html"))).toBe(true);
    // Nothing deleted before Caddy reloaded without its block.
    expect(b.events.indexOf("reload")).toBeLessThan(b.events.findIndex((event) => event.startsWith("userdel")));
  });

  test("a project with its own domain leaves the domain table", async () => {
    const b = bench();
    await deploy(b, { ...APP, domain: { name: "cybersolide.example" } });
    const path = join(b.sites, "nis2", "sitesolide.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.domain.active = true;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(b.root, "domaines.map"), "cybersolide.example nis2\n");
    expect(await runLifecycle(renameHost(b), asking("nis2", "remove"), { zone: ZONE })).toEqual({ ok: true });
    expect(readFileSync(join(b.root, "domaines.map"), "utf8")).not.toContain("nis2");
  });

  test("Caddy refusing the configuration without it deletes nothing", async () => {
    const b = bench();
    await deploy(b);
    let validations = 0;
    b.options.validate = () => (++validations === 2 ? { ok: false, output: "Error: refused" } : { ok: true, output: "Valid configuration" });
    const outcome = await runLifecycle(renameHost(b), asking("nis2", "remove"), { zone: ZONE });
    expect(outcome).toMatchObject({ ok: false, code: "caddy-refused" });
    expect(existsSync(join(b.sites, "nis2", "sitesolide.json"))).toBe(true);
    expect(existsSync(join(b.blocks, "nis2.caddy"))).toBe(true);
    expect(b.events).toContain("systemctl restart nis2");
  });
});

describe("the launch and the request", () => {
  test("the unit's name gives the slug, the request the action, fresh", () => {
    expect(readLifecycleLaunch(["--lifecycle", "sitesolide-lifecycle@nis2.service"])).toEqual({ ok: true, slug: "nis2" });
    expect(readLifecycleLaunch(["--lifecycle", "sitesolide-rename@nis2.service"]).ok).toBe(false);
    const text = JSON.stringify({ slug: "nis2", action: "disable", requestedAt: NOW, actor: "owner" });
    expect(readLifecycleRequest(text, "nis2", NOW).ok).toBe(true);
    expect(readLifecycleRequest(JSON.stringify({ slug: "nis2", action: "explode", requestedAt: NOW, actor: "owner" }), "nis2", NOW).ok).toBe(false);
    expect(readLifecycleRequest(text, "nis2", NOW + 11 * 60_000).ok).toBe(false);
  });
});
