/**
 * A token's deployment that read the machine before an owner's Turn off or
 * rename, and reaches the Caddy lock after it: refused there, by what it
 * reads again under the lock. Simulated: the pipeline's first read of the
 * manifests is the one it made before the owner's run, every later one is
 * the machine's own.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDisabledBlock } from "../borrowed/fragment";
import { readManifest } from "../borrowed/manifest";
import type { InstallRequest } from "../src/control/protocol";
import { runLifecycle } from "../src/installer/lifecycle";
import { runPipeline } from "../src/installer/pipeline";
import { runRename } from "../src/installer/rename";
import { hostOf, stageBundle, ZONE } from "./installer-bench";
import { APP, createBench, deploy, FILES, NOW, PUBLIC, renameHost } from "./rename-bench";

const AGAIN = "fedcba9876543210fedcba98";
const request = (manifest: object): InstallRequest => ({ deployment: AGAIN, slug: "nis2", requestedAt: NOW, token: { id: "aaaaaaaaaaaa", email: "", member: null }, scope: PUBLIC, creating: false, manifest: JSON.stringify(manifest) });

/** The installer's host whose first manifests read is `before`. */
function staleFirstRead(b: Parameters<typeof hostOf>[0], before: Map<string, string>) {
  const host = hostOf(b);
  const real = host.readManifests;
  let first = true;
  host.readManifests = async () => {
    if (first) {
      first = false;
      return before;
    }
    return real();
  };
  return host;
}

test("app: a deployment started before Turn off is refused at the block", async () => {
  const b = createBench({ probe: (host, _path, bench) => (isDisabledBlock(bench.served.get(host.slice(0, -(ZONE.length + 1))) ?? null) ? { code: 503, door: false, body: "" } : null) });
  await deploy(b);
  const before = await hostOf(b).readManifests();
  expect((await runLifecycle(renameHost(b), { slug: "nis2", action: "disable", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE })).ok).toBe(true);
  expect(isDisabledBlock(readFileSync(join(b.blocks, "nis2.caddy"), "utf8"))).toBe(true);
  b.events.length = 0;
  stageBundle(b, AGAIN, FILES);
  const outcome = await runPipeline(staleFirstRead(b, before), request(APP), { zone: ZONE, runFolder: b.run });
  const manifest = readManifest(readFileSync(join(b.sites, "nis2", "sitesolide.json"), "utf8")).manifest!;
  // Sound for an app: the off block reads as a block edited by hand, and nothing is written.
  expect(outcome).toMatchObject({ ok: false, code: "edited-by-hand" });
  expect(manifest.disabled).toBe(true);
});

test("app: a deployment started before a rename is refused on its port", async () => {
  const b = createBench();
  await deploy(b);
  const before = await hostOf(b).readManifests();
  expect((await runRename(renameHost(b), { slug: "nis2", to: "cyber", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE })).ok).toBe(true);
  b.events.length = 0;
  stageBundle(b, AGAIN, FILES);
  const outcome = await runPipeline(staleFirstRead(b, before), request(APP), { zone: ZONE, runFolder: b.run });
  // Sound for an app with a port: the port, read again under the lock, collides.
  expect(outcome).toMatchObject({ ok: false, code: "port-taken" });
  expect(existsSync(join(b.sites, "nis2"))).toBe(false);
});

const offBench = () => createBench({ probe: (host, _path, bench) => (isDisabledBlock(bench.served.get(host.slice(0, -(ZONE.length + 1))) ?? null) ? { code: 503, door: false, body: "" } : null) });

test("the same race with a changed manifest: refused at the block before any unit is written", async () => {
  const b = offBench();
  await deploy(b);
  const before = await hostOf(b).readManifests();
  expect((await runLifecycle(renameHost(b), { slug: "nis2", action: "disable", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE })).ok).toBe(true);
  b.events.length = 0;
  stageBundle(b, AGAIN, FILES);
  const outcome = await runPipeline(staleFirstRead(b, before), request({ ...APP, env: { CHANGED: "1" } }), { zone: ZONE, runFolder: b.run });
  expect(outcome).toMatchObject({ ok: false, code: "edited-by-hand" });
  expect(b.events).not.toContain("systemctl enable nis2");
});

test("static: a deployment started before Turn off is refused under the lock, the flag kept", async () => {
  const b = offBench();
  await deploy(b, { slug: "blog", publicDir: "public" });
  const before = await hostOf(b).readManifests();
  expect((await runLifecycle(renameHost(b), { slug: "blog", action: "disable", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE })).ok).toBe(true);
  stageBundle(b, AGAIN, FILES);
  const outcome = await runPipeline(staleFirstRead(b, before), { ...request({ slug: "blog", publicDir: "public" }), slug: "blog" }, { zone: ZONE, runFolder: b.run });
  const manifest = readManifest(readFileSync(join(b.sites, "blog", "sitesolide.json"), "utf8")).manifest!;
  expect(outcome).toMatchObject({ ok: false, code: "disabled" });
  expect(manifest.disabled).toBe(true);
  expect(isDisabledBlock(readFileSync(join(b.blocks, "blog.caddy"), "utf8"))).toBe(true);
});

test("static: a deployment started before a rename is refused under the lock, nothing left under the old name", async () => {
  const b = createBench();
  await deploy(b, { slug: "blog", publicDir: "public" });
  writeFileSync(join(b.root, "group"), `${readFileSync(join(b.root, "group"), "utf8")}site-blog:x:2001:\n`);
  const before = await hostOf(b).readManifests();
  const renamed = await runRename(renameHost(b), { slug: "blog", to: "journal", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE });
  expect(renamed.ok).toBe(true);
  stageBundle(b, AGAIN, FILES);
  const outcome = await runPipeline(staleFirstRead(b, before), { ...request({ slug: "blog", publicDir: "public" }), slug: "blog" }, { zone: ZONE, runFolder: b.run });
  expect(outcome).toMatchObject({ ok: false, code: "renamed" });
  expect(existsSync(join(b.sites, "blog"))).toBe(false);
  expect(readFileSync(join(b.root, "passwd"), "utf8")).not.toMatch(/^site-blog:/m);
  expect(existsSync(join(b.sites, "journal", "sitesolide.json"))).toBe(true);
});
