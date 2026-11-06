import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "../borrowed/manifest";
import type { RenameRequest } from "../src/control/protocol";
import { readRenameLaunch, readRenameRequest, runRename } from "../src/installer/rename";
import { ZONE, type Bench } from "./installer-bench";
import { APP, createBench, deploy, NOW, renameHost } from "./rename-bench";

/**
 * The rename run on the installer's bench: a project deployed for real by
 * the pipeline, then renamed with the real rename host, real moves on a
 * throwaway tree, `usermod` and `groupmod` standing in as scripts that edit
 * the bench's passwd and group. systemd and Caddy are the bench's.
 */

const renaming = (slug: string, to: string): RenameRequest => ({ slug, to, requestedAt: Date.now(), actor: "owner" });

function deposited(bench: Bench, slug: string) {
  return readManifest(readFileSync(join(bench.sites, slug, "sitesolide.json"), "utf8")).manifest!;
}

describe("a project renamed", () => {
  test("everything its slug names moves, and the new address answers", async () => {
    const bench = createBench();
    await deploy(bench);
    const passwd = join(bench.root, "passwd");
    writeFileSync(passwd, readFileSync(passwd, "utf8").replace(/^(site-nis2:.*?:.*?:.*?:.*?:)[^:]*/m, "$1/home/site-nis2"));
    mkdirSync(join(bench.sites, "nis2", "data"), { recursive: true });
    writeFileSync(join(bench.sites, "nis2", "data", "app.db"), "rows");
    mkdirSync(join(bench.store, "nis2", "files"), { recursive: true });
    writeFileSync(join(bench.store, "nis2", "env"), "STRIPE_SECRET_KEY=x\n");
    mkdirSync(join(bench.units, "nis2.service.d"));
    writeFileSync(join(bench.units, "nis2.service.d", "syscalls.conf"), "[Service]\nSystemCallFilter=ptrace\n");

    const outcome = await runRename(renameHost(bench), renaming("nis2", "cybersolide"), { zone: ZONE });
    expect(outcome).toEqual({ ok: true, url: `https://cybersolide.${ZONE}/` });

    // The tree, its data, the store and the drop-in, under the new name; nothing left under the old.
    expect(readFileSync(join(bench.sites, "cybersolide", "data", "app.db"), "utf8")).toBe("rows");
    expect(readFileSync(join(bench.store, "cybersolide", "env"), "utf8")).toBe("STRIPE_SECRET_KEY=x\n");
    expect(existsSync(join(bench.units, "cybersolide.service.d", "syscalls.conf"))).toBe(true);
    for (const gone of [join(bench.sites, "nis2"), join(bench.store, "nis2"), join(bench.units, "nis2.service"), join(bench.units, "nis2.service.d"), join(bench.blocks, "nis2.caddy")]) {
      expect(existsSync(gone)).toBe(false);
    }
    // The account and its group renamed, the uid kept, the home useradd named by default following.
    expect(readFileSync(join(bench.root, "passwd"), "utf8")).toMatch(/^site-cybersolide:x:\d+:\d+::\/home\/site-cybersolide:/m);
    expect(readFileSync(join(bench.root, "group"), "utf8")).toMatch(/^site-cybersolide:x:2000:/m);
    // The manifest under the new slug, the old one remembered.
    expect(deposited(bench, "cybersolide")).toMatchObject({ slug: "cybersolide", formerSlugs: ["nis2"], port: 3035 });
    // The unit and the block, generated again for the new name.
    const unit = readFileSync(join(bench.units, "cybersolide.service"), "utf8");
    expect(unit).toContain("User=site-cybersolide");
    expect(unit).toContain("/srv/sites/cybersolide/app");
    expect(unit).not.toContain("nis2");
    expect(readFileSync(join(bench.blocks, "cybersolide.caddy"), "utf8")).toContain("cybersolide.{$SITESOLIDE_ZONE}");

    const events = bench.events.join("\n");
    expect(events).toContain("systemctl disable --now nis2");
    expect(events).toContain("systemctl enable cybersolide");
    expect(events).toContain("systemctl restart cybersolide");
    // The services stop before the account is renamed, Caddy reloads before they start again.
    expect(bench.events.indexOf("systemctl disable --now nis2")).toBeLessThan(bench.events.indexOf("reload"));
    expect(bench.events.indexOf("reload")).toBeLessThan(bench.events.indexOf("systemctl restart cybersolide"));
    expect(bench.events).toContain("release");
  });

  test("a project with its own domain gets the domain table written again under the new folder", async () => {
    const bench = createBench();
    await deploy(bench, { ...APP, domain: { name: "cybersolide.example", aliases: ["www.cybersolide.example"] } });
    // As `sitesolide domain --activate` leaves it.
    const path = join(bench.sites, "nis2", "sitesolide.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.domain.active = true;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(bench.root, "domaines.map"), "cybersolide.example nis2\nwww.cybersolide.example nis2\n");

    const outcome = await runRename(renameHost(bench), renaming("nis2", "cybersolide"), { zone: ZONE });
    expect(outcome.ok).toBe(true);
    const table = readFileSync(join(bench.root, "domaines.map"), "utf8");
    expect(table).toContain("cybersolide.example cybersolide");
    expect(table).not.toContain(" nis2");
  });

  test("a static site moves its folder, and has no unit to lay", async () => {
    const bench = createBench();
    await deploy(bench, { slug: "blog", publicDir: "public" });
    const outcome = await runRename(renameHost(bench), renaming("blog", "journal"), { zone: ZONE });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(bench.sites, "journal", "public", "index.html"), "utf8")).toBe("<h1>nis2</h1>");
    expect(readdirSync(bench.units)).toEqual([]);
  });
});

describe("a rename refused before anything moves", () => {
  test("a name already taken on the machine, by a folder, an account or a unit", async () => {
    for (const lay of [
      (bench: Bench) => mkdirSync(join(bench.sites, "cybersolide", "public"), { recursive: true }),
      (bench: Bench) => writeFileSync(join(bench.root, "passwd"), `${readFileSync(join(bench.root, "passwd"), "utf8")}site-cybersolide:x:3000:3000::/nonexistent:/usr/sbin/nologin\n`),
      (bench: Bench) => writeFileSync(join(bench.units, "cybersolide.service"), "[Service]\n"),
      (bench: Bench) => mkdirSync(join(bench.store, "cybersolide"), { recursive: true }),
    ]) {
      const bench = createBench();
      await deploy(bench);
      lay(bench);
      const outcome = await runRename(renameHost(bench), renaming("nis2", "cybersolide"), { zone: ZONE });
      expect(outcome.ok).toBe(false);
      expect(existsSync(join(bench.sites, "nis2", "sitesolide.json"))).toBe(true);
      expect(bench.events.some((event) => event.startsWith("systemctl disable"))).toBe(false);
    }
  });

  test("Caddy being changed by another action", async () => {
    const bench = createBench();
    await deploy(bench);
    bench.options.lockHeld = true;
    const outcome = await runRename(renameHost(bench), renaming("nis2", "cybersolide"), { zone: ZONE });
    expect(outcome).toMatchObject({ ok: false, code: "caddy-busy" });
  });
});

describe("a rename that fails half way puts everything back", () => {
  test("Caddy refusing the renamed configuration", async () => {
    const bench = createBench();
    await deploy(bench);
    let validations = 0;
    bench.options.validate = () => (++validations === 2 ? { ok: false, output: "Error: adapting config using caddyfile: unrecognized directive" } : { ok: true, output: "Valid configuration" });
    const outcome = await runRename(renameHost(bench), renaming("nis2", "cybersolide"), { zone: ZONE });
    expect(outcome).toMatchObject({ ok: false, code: "caddy-refused" });
    expect((outcome as { message: string }).message).toContain("nis2 is back as it was");
    expect(deposited(bench, "nis2").slug).toBe("nis2");
    expect(deposited(bench, "nis2").formerSlugs).toBeUndefined();
    expect(existsSync(join(bench.sites, "cybersolide"))).toBe(false);
    expect(existsSync(join(bench.units, "nis2.service"))).toBe(true);
    expect(existsSync(join(bench.units, "cybersolide.service"))).toBe(false);
    expect(existsSync(join(bench.blocks, "nis2.caddy"))).toBe(true);
    expect(existsSync(join(bench.blocks, "cybersolide.caddy"))).toBe(false);
    expect(readFileSync(join(bench.root, "passwd"), "utf8")).toMatch(/^site-nis2:/m);
    expect(bench.events.at(-1)).toBe("release");
    expect(bench.events).toContain("systemctl restart nis2");
  });

  test("the new address not answering as the old one did", async () => {
    const bench = createBench({ probe: (host) => (host === `cybersolide.${ZONE}` ? { error: "connection refused" } : null) });
    await deploy(bench);
    const outcome = await runRename(renameHost(bench), renaming("nis2", "cybersolide"), { zone: ZONE });
    expect(outcome).toMatchObject({ ok: false, code: "verify-failed" });
    expect(existsSync(join(bench.sites, "nis2", "app", "server.ts"))).toBe(true);
    expect(existsSync(join(bench.blocks, "nis2.caddy"))).toBe(true);
  });
});

describe("the launch and the request", () => {
  test("the unit's name gives the slug, the request the new one, fresh", () => {
    expect(readRenameLaunch(["--rename", "sitesolide-rename@nis2.service"])).toEqual({ ok: true, slug: "nis2" });
    expect(readRenameLaunch(["--rename", "sitesolide-installer@nis2.service"]).ok).toBe(false);
    const text = JSON.stringify({ slug: "nis2", to: "cybersolide", requestedAt: NOW, actor: "owner" });
    expect(readRenameRequest(text, "nis2", NOW)).toEqual({ ok: true, request: { slug: "nis2", to: "cybersolide", requestedAt: NOW, actor: "owner" } });
    expect(readRenameRequest(text, "blog", NOW).ok).toBe(false);
    expect(readRenameRequest(text, "nis2", NOW + 11 * 60_000).ok).toBe(false);
    expect(readRenameRequest(null, "nis2", NOW).ok).toBe(false);
  });
});
