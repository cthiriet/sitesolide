/**
 * `disabled` is the machine's to write, when its owner turns the project off:
 * a token's deployment that carried it would leave the site serving while the
 * dashboard, refresh, the gatekeeper and Turn off all believed it off. And a
 * project's new name goes only to a token that may deploy it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDisabledBlock } from "../borrowed/fragment";
import { readManifest } from "../borrowed/manifest";
import { fixedRefusal } from "../src/gatekeeper/rules";
import { runLifecycle } from "../src/installer/lifecycle";
import { finalManifest } from "../src/installer/pipeline";
import { ZONE } from "./installer-bench";
import { APP, createBench, deploy, PUBLIC, renameHost } from "./rename-bench";

test("finalManifest drops a token's disabled: true", () => {
  const out = finalManifest(
    { deployment: "0123456789abcdef01234567", slug: "nis2", requestedAt: Date.now(), token: { id: "aaaaaaaaaaaa", email: null, member: null }, scope: PUBLIC, creating: true, manifest: JSON.stringify({ ...APP, disabled: true }) } as never,
    new Map(),
  );
  expect(out.manifest.disabled).toBeUndefined();
});

test("deployed with disabled: true by a token, the machine still reads the site as on, and its owner can turn it off", async () => {
  // The bench's probe answers the 503 of a site whose block in service is a disabled one.
  const b = createBench({
    probe: (host, _path, bench) => (isDisabledBlock(bench.served.get(host.slice(0, -(ZONE.length + 1))) ?? null) ? { code: 503, door: false, body: "" } : null),
  });
  await deploy(b, { ...APP, disabled: true });
  const manifest = readManifest(readFileSync(join(b.sites, "nis2", "sitesolide.json"), "utf8")).manifest!;
  expect(manifest.disabled).toBeUndefined();
  // Its own block, not the block of a site off: it serves.
  const block = readFileSync(join(b.blocks, "nis2.caddy"), "utf8");
  expect(isDisabledBlock(block)).toBe(false);
  expect(block).toContain("reverse_proxy");
  expect(fixedRefusal("nis2", manifest) ?? "").not.toContain("turned off");
  const off = await runLifecycle(renameHost(b), { slug: "nis2", action: "disable", requestedAt: Date.now(), actor: "owner" }, { zone: ZONE });
  expect(off).toEqual({ ok: true });
});

test("a former name is refused to every token, its new name told only to one that may deploy it", () => {
  const machine = new Map([["crm-v2", `${JSON.stringify({ slug: "crm-v2", formerSlugs: ["crm"], publicDir: "public" })}\n`]]);
  const refusal = (slugs: string[]) => {
    try {
      finalManifest({ deployment: "0123456789abcdef01234567", slug: "crm", requestedAt: Date.now(), token: { id: "aaaaaaaaaaaa", email: null, member: null }, scope: { ...PUBLIC, slugs }, creating: true, manifest: JSON.stringify({ slug: "crm", publicDir: "public" }) } as never, machine);
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };
  expect(refusal([])).toContain("former name");
  expect(refusal([])).not.toContain("crm-v2");
  expect(refusal(["crm-v2"])).toContain("renamed crm-v2");
});
