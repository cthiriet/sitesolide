import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDisabled, type Manifest } from "../../cli/manifest";
import { run } from "./run";
import { createFakeVm, type FakeVm } from "./fake-vm";

/**
 * A project turned off on the machine: every gesture that deposits the
 * checkout's manifest is refused, since that manifest carries no `disabled`
 * and would switch it back on in the machine's eyes. A checkout that carries
 * `disabled` itself is refused too: the machine alone writes it.
 */
const dirs: string[] = [];
let vm: FakeVm;
afterEach(() => {
  vm?.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const SITE: Manifest = { slug: "shop-off", publicDir: "public", domain: { name: "shop-off.example", active: false } };
const text = (m: object) => `${JSON.stringify(m, null, 2)}\n`;
function project(m: Manifest): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "shop-off-")));
  dirs.push(folder);
  writeFileSync(join(folder, "sitesolide.json"), text(m));
  mkdirSync(join(folder, "public"));
  writeFileSync(join(folder, "public", "index.html"), "<p>x</p>\n");
  return folder;
}

test("deploy refuses a disabled project", async () => {
  vm = createFakeVm();
  vm.writeManifest(SITE.slug, setDisabled(text(SITE), true));
  const r = await run(project(SITE), ["deploy", "--dry-run"], { vm });
  expect(r.code).toBe(1);
  expect(r.error).toContain("turned off");
});

test("domain --activate refuses it too, before anything is deposited", async () => {
  vm = createFakeVm();
  vm.writeManifest(SITE.slug, setDisabled(text(SITE), true));
  const r = await run(project(SITE), ["domain", "--activate", "--dry-run", "--force"], { vm });
  expect(r.code).toBe(1);
  expect(r.error).toContain("turned off");
  expect(r.output).not.toContain("generate-domains.sh");
});

test("a checkout that says disabled itself is refused", async () => {
  vm = createFakeVm();
  const r = await run(project({ ...SITE, disabled: true }), ["deploy", "--dry-run"], { vm });
  expect(r.code).toBe(1);
  expect(r.error).toContain("only the machine writes");
});

test("domain --activate refuses to drop the former names the machine keeps", async () => {
  vm = createFakeVm();
  vm.writeManifest(SITE.slug, text({ ...SITE, formerSlugs: ["old-name"] }));
  const r = await run(project(SITE), ["domain", "--activate", "--dry-run", "--force"], { vm });
  expect(r.code).toBe(1);
  expect(r.error).toContain("former names");
});
