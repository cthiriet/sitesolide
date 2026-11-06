/**
 * The zone's wildcard serves /srv/sites/<slug>/public to anyone as soon as no
 * /etc/caddy/sites/<slug>.caddy exists (bin/tests/remove-wildcard.test.ts, in
 * a real Caddy). A removal from the dashboard reloads Caddy without the block
 * before it deletes the folder, and a rename moves the folder under a new
 * name: neither may leave a restricted site's public/ where the wildcard
 * serves it, even for the seconds in between.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fragmentIsProtected } from "../borrowed/portal";
import { readManifest } from "../borrowed/manifest";
import { runLifecycle } from "../src/installer/lifecycle";
import { file, hostOf, stageBundle, ZONE } from "./installer-bench";
import { runPipeline } from "../src/installer/pipeline";
import { APP, createBench, DEPLOYMENT, NOW, PUBLIC, renameHost } from "./rename-bench";

test("a removal sets a restricted app's public/ aside before the reload that drops its door", async () => {
  const b = createBench();
  stageBundle(b, DEPLOYMENT, [file("app/server.ts", "Bun.serve({})"), file("public/index.html", "<h1>restricted</h1>")]);
  const deployed = await runPipeline(hostOf(b), { deployment: DEPLOYMENT, slug: "nis2", requestedAt: NOW, token: { id: "aaaaaaaaaaaa", email: "", member: null }, scope: PUBLIC, creating: true, manifest: JSON.stringify({ ...APP, portal: true }) }, { zone: ZONE, runFolder: b.run });
  expect(deployed.ok).toBe(true);
  b.events.length = 0;
  expect(readManifest(readFileSync(join(b.sites, "nis2", "sitesolide.json"), "utf8")).manifest!.portal).toBe(true);
  expect(fragmentIsProtected(readFileSync(join(b.blocks, "nis2.caddy"), "utf8"))).toBe(true);
  const host = renameHost(b);
  const seen: string[] = [];
  const reload = host.machine.reloadCaddy;
  host.machine.reloadCaddy = async (ms) => {
    const answer = await reload(ms);
    seen.push(`reload: block in service ${existsSync(join(b.blocks, "nis2.caddy"))}, public/index.html on disk ${existsSync(join(b.sites, "nis2", "public", "index.html"))}`);
    return answer;
  };
  const probe = host.machine.probe;
  let probesAfterReload = 0;
  host.machine.probe = async (...args) => {
    if (seen.length > 0) probesAfterReload++;
    return probe(...args);
  };
  const outcome = await runLifecycle(host, { slug: "nis2", action: "remove", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE });
  expect(outcome).toEqual({ ok: true });
  expect(seen[0]).toBe("reload: block in service false, public/index.html on disk false");
  expect(existsSync(join(b.sites, "nis2"))).toBe(false);
});

import { runRename } from "../src/installer/rename";

test("a rename lays the new name's block before it moves a restricted app's folder there", async () => {
  const b = createBench();
  stageBundle(b, DEPLOYMENT, [file("app/server.ts", "Bun.serve({})"), file("public/index.html", "<h1>restricted</h1>")]);
  const deployed = await runPipeline(hostOf(b), { deployment: DEPLOYMENT, slug: "nis2", requestedAt: NOW, token: { id: "aaaaaaaaaaaa", email: "", member: null }, scope: PUBLIC, creating: true, manifest: JSON.stringify({ ...APP, portal: true }) }, { zone: ZONE, runFolder: b.run });
  expect(deployed.ok).toBe(true);
  writeFileSync(join(b.root, "group"), `${readFileSync(join(b.root, "group"), "utf8")}site-nis2:x:2000:\n`);
  const host = renameHost(b);
  const exposed: string[] = [];
  // At each step after the move, would the wildcard serve /srv/sites/secret-v2/public? Yes while the folder is there and secret-v2.caddy is not.
  const look = (step: string) => {
    if (existsSync(join(b.sites, "secret-v2", "public", "index.html")) && !existsSync(join(b.blocks, "secret-v2.caddy"))) exposed.push(step);
  };
  const { systemctl, installUnit, writeManifest } = host;
  host.systemctl = async (args, ms) => { look(`systemctl ${args.join(" ")}`); return systemctl(args, ms); };
  host.installUnit = async (unit, text) => { look(`install ${unit}`); return installUnit(unit, text); };
  host.writeManifest = async (...args) => { look("write manifest"); return writeManifest(...args); };
  const outcome = await runRename(host, { slug: "nis2", to: "secret-v2", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE });
  expect(outcome.ok).toBe(true);
  expect(exposed).toEqual([]);
  expect(existsSync(join(b.sites, "secret-v2", "public", "index.html"))).toBe(true);
});
