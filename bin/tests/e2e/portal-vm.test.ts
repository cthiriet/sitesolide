import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../../cli/fragment";
import { setPortal, type Manifest } from "../../cli/manifest";
import { REPO, run, TEST_EMAIL, TEST_ZONE } from "./run";
import { createFakeVm, type FakeVm } from "./fake-vm";
import { FAKE_CODE, FAKE_NEW_CODE, SWITCHES } from "./fake-ssh";

/**
 * The portal of a deployed site is laid down from the dashboard, and the VM is
 * the authority.
 *
 * `deploy` and bin/deploy-caddy.sh really run here, in front of a simulated
 * VM: a folder on the workstation and an ssh that only answers readings.
 * Nothing touches the machine that serves the clients, nor this repository:
 * the test projects and repositories are copied into a temporary folder.
 *
 * The decisions themselves are tried without running anything in
 * cli-portal-vm.test.ts. Here, we check that they are indeed the ones the CLI
 * and the script apply, and that a refusal falls before any write.
 */

const TEMP_DIRS: string[] = [];
let vm: FakeVm;

function tempDir(prefix: string): string {
  // The real path: on macOS, /var is a link to /private/var, and the CLI
  // displays the current folder as the system resolves it.
  const folder = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TEMP_DIRS.push(folder);
  return folder;
}

afterEach(() => {
  vm?.cleanup();
  for (const folder of TEMP_DIRS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const APP: Manifest = {
  slug: "sample-door",
  port: 3035,
  publicDir: "public",
  start: "/usr/local/bin/bun run server.ts",
};
const PROTECTED: Manifest = { ...APP, portal: true };

function text(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** A deployable project outside the repository, like those the CLI exists to serve. */
function project(manifest: Manifest): string {
  const folder = tempDir("project-door-");
  writeFileSync(join(folder, "sitesolide.json"), text(manifest));
  mkdirSync(join(folder, "public"));
  writeFileSync(join(folder, "public", "index.html"), "<p>test</p>\n");
  return folder;
}

describe("deploy reads the door on the VM", () => {
  test("a site the machine does not know keeps the value from its repository", async () => {
    vm = createFakeVm();
    const folder = project(PROTECTED);
    const r = await run(folder, ["deploy", "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("from the dashboard");
    expect(r.output).toContain("check https://portal.");
    expect(r.output).toContain("forward_auth @portal_guard");
    // The site's door, what systemd knows of its unit, then every manifest
    // for the ports they declare, and nothing else was asked of the machine:
    // the other sites' blocks are not this deployment's business, and in a
    // dry run there is no lock.
    expect(vm.logs()).toEqual(["READ sample-door", "UNITS sample-door", "READ *"]);
  });

  test("the same value on both sides changes nothing", async () => {
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(PROTECTED));
    const folder = project(PROTECTED);
    const r = await run(folder, ["deploy", "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("from the dashboard");
    expect(r.output).toContain("forward_auth @portal_guard");
  });

  test("closed from the dashboard: the door applies to everything deploy generates", async () => {
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(PROTECTED));
    const folder = project(APP);
    const before = readFileSync(join(folder, "sitesolide.json"), "utf8");

    const r = await run(folder, ["deploy", "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(r.output).toContain("general access was set to Restricted from the dashboard");
    expect(r.output).toContain(`[dry-run] write ${join(folder, "sitesolide.json")}`);

    // The block shown carries the door, the portal is checked before anything
    // is sent, and the door is laid before the files, as for any protected
    // site.
    expect(r.output).toContain("forward_auth @portal_guard");
    const portal = r.output.indexOf("check https://portal.");
    const door = r.output.indexOf("bin/deploy-caddy.sh sample-door.caddy");
    const files = r.output.indexOf("/srv/sites/sample-door/public/");
    expect(portal).toBeGreaterThan(-1);
    expect(door).toBeGreaterThan(portal);
    expect(files).toBeGreaterThan(door);

    // In a dry run, nothing is written on the workstation.
    expect(readFileSync(join(folder, "sitesolide.json"), "utf8")).toBe(before);
  });

  test("reopened from the dashboard: the site is no longer treated as a protected site", async () => {
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(APP));
    const folder = project(PROTECTED);

    const r = await run(folder, ["deploy", "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(r.output).toContain("general access was set to Public from the dashboard");
    expect(r.output).not.toContain("forward_auth @portal_guard");
    expect(r.output).not.toContain("check https://portal.");
    // The block leaves after the restart, as for any open site.
    expect(r.output.indexOf("bin/deploy-caddy.sh sample-door.caddy")).toBeGreaterThan(
      r.output.indexOf("systemctl restart sample-door"),
    );
  });

  test("an unreadable door on the VM stops everything, before the build and before anything is sent", async () => {
    vm = createFakeVm();
    vm.writeManifest("sample-door", JSON.stringify({ ...APP, portal: "yes" }));
    const folder = project(APP);

    const r = await run(folder, ["deploy", "--dry-run"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain("cannot tell whether the general access of sample-door was changed from the dashboard");
    expect(r.all).not.toContain("[dry-run]");
    expect(vm.logs()).toEqual(["READ sample-door"]);
  });

  test("an unreadable answer from the machine stops everything too", async () => {
    // What a refused sudo would give back: no manifest, no end marker. Reading
    // it as an absence would make it take the repository's value.
    vm = createFakeVm();
    vm.forceAnswer("");
    const folder = project(APP);

    const r = await run(folder, ["deploy", "--dry-run"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain("the server did not finish its answer");
    expect(r.all).not.toContain("[dry-run]");
  });

  test("for real, the local manifest catches up with the VM before the first write", async () => {
    // The direction that does not ask the portal whether it answers: that one
    // would question the real portal. The first write is refused by the
    // simulated VM, and that is what stops the deployment.
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(APP));
    const folder = project(PROTECTED);

    const r = await run(folder, ["deploy"], { vm });
    expect(r.output).toContain(
      "general access was set to Public from the dashboard; sitesolide.json updated, commit it",
    );
    expect(readFileSync(join(folder, "sitesolide.json"), "utf8")).toBe(
      setPortal(text(PROTECTED), false),
    );

    // Nothing other than the readings went through, the site's door, its
    // block in service, what systemd knows of its unit and the manifests
    // whose ports it checks: the
    // preparation of the service is the first write, and the simulated VM
    // refused it. The lock is only taken before the first deposit of the
    // manifest or of the block, much further on.
    expect(r.code).toBe(1);
    const logs = vm.logs();
    expect(logs.slice(0, 4)).toEqual(["READ sample-door", "BLOCK sample-door", "UNITS sample-door", "READ *"]);
    expect(logs.slice(4).every((line) => line.startsWith("REFUSED "))).toBe(true);
    expect(logs).toHaveLength(5);
  });
});

/**
 * The block in service before the dashboard changed the door. It differs from
 * the generated block by the door alone, and that is the expected discrepancy:
 * refusing it without --force would make every gesture from the dashboard a
 * manual switch. Anything else it differs by is a decision made by hand on the
 * machine, and stops the deployment before anything leaves.
 *
 * The comparison is made against the machine, so these runs are real ones: in
 * a dry run nothing is asked of it. The simulated VM refuses the first write,
 * which is where they stop, and the zone resolves nowhere, so no real portal is
 * ever asked anything.
 */
describe("the block in service follows the dashboard's door", () => {
  test("a block that differs only by the door goes through without --force", async () => {
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(PROTECTED));
    vm.writeBlock("sample-door", generateFragment(APP)!);
    const r = await run(project(APP), ["deploy"], { vm });
    expect(r.output).toContain("/etc/caddy/sites/sample-door.caddy will follow the portal set from the dashboard");
    expect(r.all).not.toContain("no longer matches");
  });

  test("after an interrupted deployment, the block left behind catches up with the VM without --force", async () => {
    // The local manifest has already been rewritten by the previous pass,
    // which stopped before depositing the block: no switch left to announce,
    // but the block in service still does not say what the machine carries.
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(APP));
    vm.writeBlock("sample-door", generateFragment(PROTECTED)!);
    const r = await run(project(APP), ["deploy"], { vm });
    expect(r.all).not.toContain("turned");
    expect(r.output).toContain("will follow the portal set from the dashboard");
  });

  test("a protected block deployed before the identity headers is upgraded without --force", async () => {
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(PROTECTED));
    vm.writeBlock("sample-door", generateFragment(PROTECTED, "cookie")!);
    const r = await run(project(PROTECTED), ["deploy"], { vm });
    expect(r.output).toContain("/etc/caddy/sites/sample-door.caddy was written by an earlier release, the current one replaces it");
    expect(r.all).not.toContain("no longer matches");
  });

  test("a door set by a dashboard not yet upgraded is taken, and its block upgraded", async () => {
    // The older gatekeeper wrote the earlier stanza; the repository has not
    // caught up with the door yet.
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(PROTECTED));
    vm.writeBlock("sample-door", generateFragment(PROTECTED, "cookie")!);
    const r = await run(project(APP), ["deploy"], { vm });
    expect(r.output).toContain("general access was set to Restricted from the dashboard");
    expect(r.output).toContain("was written by an earlier release, the current one replaces it");
    expect(r.all).not.toContain("no longer matches");
  });

  test("without a manifest on the VM, the local door does not silently win over the block in service", async () => {
    // Nothing then confirms which door holds: the block is refused.
    vm = createFakeVm();
    vm.writeBlock("sample-door", generateFragment(APP)!);
    const r = await run(project(PROTECTED), ["deploy"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain("no longer matches the manifest");
  });

  test("a block that also differs by something else stays refused, before anything is written", async () => {
    vm = createFakeVm();
    vm.writeManifest("sample-door", text(PROTECTED));
    vm.writeBlock("sample-door", generateFragment({ ...APP, port: 3036 })!);
    const r = await run(project(APP), ["deploy"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain("no longer matches the manifest");
    expect(vm.logs().some((line) => line.startsWith("REFUSED") || line.startsWith("ACCEPTED"))).toBe(false);
  });
});

/**
 * The portal's own upgrade to the provider's two steps, as portal/README.md
 * tells the author to run it: its block in service only routes /sante, the new
 * manifest routes the two steps too, and that is a change of the manifest, not
 * an earlier generation of the same one. `deploy` stops and says so; `--force`
 * is the deliberate act the README asks for.
 */
describe("the portal's own block, upgraded to the provider's steps", () => {
  const current = JSON.parse(readFileSync(join(REPO, "portal", "sitesolide.json"), "utf8")) as Manifest;
  // No build: the copy lives outside the repository, where borrow.ts has nothing to copy.
  const { build: _, ...PORTAL } = current;
  const BEFORE: Manifest = { ...PORTAL, routes: ["/sante"] };

  test("is refused without --force, naming the two routes, before anything is written", async () => {
    vm = createFakeVm();
    vm.writeManifest("portal", text(BEFORE));
    vm.writeBlock("portal", generateFragment(BEFORE)!);
    const r = await run(project(PORTAL), ["deploy"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain("no longer matches the manifest");
    expect(r.error).toContain("@dynamic path /sante /oidc/start /oidc/callback");
    expect(vm.logs().some((line) => line.startsWith("ACCEPTED"))).toBe(false);
  });

  test("goes ahead with --force", async () => {
    vm = createFakeVm();
    vm.writeManifest("portal", text(BEFORE));
    vm.writeBlock("portal", generateFragment(BEFORE)!);
    const r = await run(project(PORTAL), ["deploy", "--force"], { vm });
    expect(r.output).toContain("--force: /etc/caddy/sites/portal.caddy will be replaced by the generated one");
  });
});

/**
 * bin/deploy-caddy.sh, from a test repository whose blocks are generated by
 * the test: the script and its guard are links there to the real ones, which
 * deduce the root from their own path.
 */
describe("deploy-caddy.sh does not contradict the VM", () => {
  const TOOL: Manifest = { ...APP, slug: "tool", port: 3030 };
  const CMS: Manifest = { ...APP, slug: "cms", port: 3048, portal: true };
  const FRESH: Manifest = { ...APP, slug: "fresh", port: 3037, portal: true };

  /** A test repository, and the blocks handed to the script, generated where a deployment would. */
  function caddyRepo(manifests: Manifest[]): { repo: string; blocks: string[] } {
    const repo = tempDir("repo-caddy-");
    mkdirSync(join(repo, "bin"));
    for (const name of ["config.sh", "deploy-caddy.sh", "portal-guard.ts"]) {
      symlinkSync(join(REPO, "bin", name), join(repo, "bin", name));
    }
    mkdirSync(join(repo, "infra", "caddy"), { recursive: true });
    writeFileSync(join(repo, "infra", "caddy", "Caddyfile"), "# test Caddyfile\n");
    const folder = tempDir("blocks-");
    const blocks = manifests.map((manifest) => {
      const path = join(folder, `${manifest.slug}.caddy`);
      writeFileSync(path, generateFragment(manifest)!);
      return path;
    });
    return { repo, blocks };
  }

  async function runDeployCaddy({ repo, blocks }: { repo: string; blocks: string[] }, arguments_: string[] = []) {
    const proc = Bun.spawn(["bash", join(repo, "bin", "deploy-caddy.sh"), ...arguments_, ...blocks], {
      stdout: "pipe",
      stderr: "pipe",
      // A zone that resolves nowhere: bin/config.sh refuses to guess a machine.
      env: {
        SITESOLIDE_ZONE: TEST_ZONE,
        SITESOLIDE_EMAIL: TEST_EMAIL,
        ...process.env,
        ...vm.env,
      },
    });
    const [output, error] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, output, error };
  }

  test("in agreement with the machine, the script goes on and leaves the other blocks alone", async () => {
    vm = createFakeVm();
    vm.writeManifest("cms", text(CMS));
    vm.writeManifest("tool", text(TOOL));
    // A showcase closed from the dashboard: its block only exists on the VM,
    // and its site does, so it is nobody's orphan.
    vm.writeManifest("vineyard", text({ slug: "vineyard", publicDir: "public", portal: true }));
    vm.writeBlock("vineyard", "# set by the gatekeeper\n");
    // A real orphan: a block whose site the machine no longer carries.
    vm.writeBlock("stale", "# forgotten block\n");
    // fresh is not deployed yet: its block goes through without a manifest to
    // confront.
    const caddy = caddyRepo([CMS, TOOL, FRESH]);

    const r = await runDeployCaddy(caddy, ["--dry-run"]);
    expect(r.error).not.toContain("!!");
    expect(r.code).toBe(0);
    expect(r.output).toContain("ORPHAN /etc/caddy/sites/stale.caddy");
    expect(r.output).not.toContain("ORPHAN /etc/caddy/sites/vineyard.caddy");
    expect(r.output).toContain("dry run, nothing was touched");
    expect(vm.logs().filter((line) => line.startsWith("REFUSED"))).toEqual([]);
  });

  test("a site closed from the dashboard and a block open in the repository: stop before any write", async () => {
    vm = createFakeVm();
    vm.writeManifest("tool", text({ ...TOOL, portal: true }));
    vm.writeManifest("cms", text(CMS));
    const caddy = caddyRepo([CMS, TOOL]);

    // Without --dry-run: it is the stop itself that must protect the machine.
    const r = await runDeployCaddy(caddy);
    expect(r.code).toBe(1);
    expect(r.error).toContain(
      "general access of tool changed from the dashboard: run `sitesolide deploy` in its folder first",
    );
    expect(r.error).not.toContain("general access of cms");
    // The guard reads under the lock, and the refusal gives it back.
    expect(vm.logs()).toEqual(["CONNECT", "LOCK take deploy-caddy", "READ *", "LOCK release deploy-caddy"]);
    expect(vm.lock()).toBeNull();
  });

  test("a Caddy unit without the zone variables stops everything before the deposit", async () => {
    // The Caddyfile and the fragments read $SITESOLIDE_ZONE, which Caddy
    // substitutes from ITS OWN environment. The validation sources the file by
    // hand and would therefore pass without proving anything; the reload, for
    // its part, addresses the process in service. If its unit does not load
    // that file, Caddy would take a configuration with empty addresses and ALL
    // the sites on the machine would fall. A reload never reads the unit
    // again.
    vm = createFakeVm();
    vm.writeManifest("cms", text(CMS));
    vm.writeManifest("tool", text(TOOL));
    writeFileSync(join(vm.root, SWITCHES.unitWithoutZone), "");
    const caddy = caddyRepo([CMS, TOOL]);

    const r = await runDeployCaddy(caddy);
    expect(r.code).toBe(1);
    expect(r.error).toContain("does not load /etc/caddy/sitesolide.env");
    expect(r.error).toContain("systemctl restart caddy");
    // Nothing left: the stop falls before the backup and before the deposit.
    expect(vm.logs().some((line) => line.includes("/var/backups/caddy/"))).toBe(false);
    expect(vm.lock()).toBeNull();
  });

  test("a site reopened from the dashboard and a block closed in the repository: stop as well", async () => {
    vm = createFakeVm();
    vm.writeManifest("cms", text({ ...CMS, portal: undefined }));
    const caddy = caddyRepo([CMS, TOOL]);

    const r = await runDeployCaddy(caddy);
    expect(r.code).toBe(1);
    expect(r.error).toContain(
      "general access of cms changed from the dashboard: run `sitesolide deploy` in its folder first",
    );
    expect(vm.logs()).toEqual(["CONNECT", "LOCK take deploy-caddy", "READ *", "LOCK release deploy-caddy"]);
  });

  test("an unreadable answer stops the script, even in a dry run", async () => {
    vm = createFakeVm();
    vm.writeManifest("cms", text(CMS));
    vm.forceAnswer(`MANIFEST cms\n${text(CMS)}`);
    const caddy = caddyRepo([CMS]);

    const r = await runDeployCaddy(caddy, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("cannot read the manifests deposited on the server");
    expect(vm.logs()).toEqual(["CONNECT", "READ *"]);
  });

  test("an unreadable deposited manifest stops the script", async () => {
    vm = createFakeVm();
    vm.writeManifest("cms", "{not json");
    const caddy = caddyRepo([CMS]);

    const r = await runDeployCaddy(caddy);
    expect(r.code).toBe(1);
    expect(r.error).toContain("cannot read /srv/sites/cms/sitesolide.json");
    expect(vm.logs()).toEqual(["CONNECT", "LOCK take deploy-caddy", "READ *", "LOCK release deploy-caddy"]);
  });
});

/**
 * The gestures that deposit the local manifest as it is. Without a guard, a
 * lock or a domain switch would erase the door laid from the dashboard, and
 * bin/deploy-caddy.sh would then see nothing left to refuse.
 */
const SHOWCASE: Manifest = { slug: "sample-static-door", publicDir: "public" };

/**
 * `sitesolide lock` and `unlock` deposit no manifest any more: they ask the
 * steward on its owner socket, the gatekeeper behind it changes the machine,
 * and the local manifest follows what the machine now carries.
 */
describe("sitesolide lock and unlock, through the steward", () => {
  test("lock: one request, the code said once, the repository following, no Caddy lock taken here", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    vm.acceptWrites();
    const folder = project(SHOWCASE);

    const r = await run(folder, ["lock"], { vm });
    expect(r.code).toBe(0);
    expect(r.output).toContain(`Code   : ${FAKE_CODE}`);
    expect(r.output).toContain(`Link   : https://${SHOWCASE.slug}.${TEST_ZONE}/?key=${FAKE_CODE}`);
    expect(r.output).toContain("commit sitesolide.json");
    expect(vm.logs()).toEqual([`GENERAL {"slug":"${SHOWCASE.slug}","access":"code"}`]);
    expect(JSON.parse(readFileSync(join(folder, "sitesolide.json"), "utf8"))).toEqual({ ...SHOWCASE, lock: true });
    // Never written into a file of the workstation.
    expect(readFileSync(join(folder, "sitesolide.json"), "utf8")).not.toContain(FAKE_CODE);
  });

  test("--json: the code and its link in the result, for an agent to hand over", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    vm.acceptWrites();
    const r = await run(project(SHOWCASE), ["lock", "--json"], { vm });
    expect(r.code).toBe(0);
    const result = JSON.parse(r.output.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ type: "result", ok: true, command: "lock", slug: SHOWCASE.slug, access: "code", code: FAKE_CODE, url: `https://${SHOWCASE.slug}.${TEST_ZONE}/?key=${FAKE_CODE}`, manifestWritten: true });
  });

  test("--new-code asks for another one; unlock asks for Public, and the local lock goes", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text({ ...SHOWCASE, lock: true }));
    vm.acceptWrites();
    const folder = project({ ...SHOWCASE, lock: true });
    const renewed = await run(folder, ["lock", "--new-code"], { vm });
    expect(renewed.code).toBe(0);
    expect(renewed.output).toContain(`Code   : ${FAKE_NEW_CODE}`);
    // Already asking for a code: nothing to commit.
    expect(renewed.output).not.toContain("commit sitesolide.json");
    const reopened = await run(folder, ["unlock"], { vm });
    expect(reopened.code).toBe(0);
    expect(reopened.output).toContain("is public again");
    expect(vm.logs()).toEqual([
      `GENERAL {"slug":"${SHOWCASE.slug}","access":"code","renew":true}`,
      `GENERAL {"slug":"${SHOWCASE.slug}","access":"public"}`,
    ]);
    expect(JSON.parse(readFileSync(join(folder, "sitesolide.json"), "utf8"))).toEqual(SHOWCASE);
  });

  test("a restricted site switches to the code in one request, and the repository follows both fields", async () => {
    vm = createFakeVm();
    const app: Manifest = { slug: "sample-door", port: 3035, publicDir: "public", start: "bun run server.ts", portal: true };
    vm.writeManifest(app.slug, text(app));
    vm.acceptWrites();
    const folder = project(app);
    const r = await run(folder, ["lock"], { vm });
    expect(r.code).toBe(0);
    const { portal, ...rest } = app;
    void portal;
    expect(JSON.parse(readFileSync(join(folder, "sitesolide.json"), "utf8"))).toEqual({ ...rest, lock: true });
  });

  test("the steward's refusal comes back as it stands, and nothing is written on the workstation", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    vm.acceptWrites();
    vm.setGeneral(403, { error: "out-of-scope", message: "it serves its own domain, sample-door.example, which a code would not close: switch it back to its preview first, sitesolide domain --deactivate" });
    const folder = project(SHOWCASE);
    const r = await run(folder, ["lock"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain("it serves its own domain, sample-door.example, which a code would not close");
    expect(readFileSync(join(folder, "sitesolide.json"), "utf8")).toBe(text(SHOWCASE));
  });

  test("a steward from before the code: the command says to upgrade", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    vm.acceptWrites();
    vm.setGeneral(404, { error: "not-found", message: "no such route" });
    const r = await run(project(SHOWCASE), ["lock", "--json"], { vm });
    expect(r.code).toBe(1);
    const error = JSON.parse(r.output.trim().split("\n").at(-1)!);
    expect(error.message).toContain("cannot change a site's general access yet: run sitesolide upgrade first");
    expect(error.hint).toContain("sitesolide upgrade");
  });

  test("a dry run asks the steward nothing", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    const r = await run(project(SHOWCASE), ["lock", "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(vm.logs()).toEqual([]);
  });
});

describe("sitesolide domain does not deposit a stale door", () => {
  const ACTIVE: Manifest = { ...SHOWCASE, domain: { name: "sample-door.example", active: true } };

  test("on a site closed from the dashboard, the switch is refused before any write", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text({ ...ACTIVE, portal: true }));
    const folder = project(ACTIVE);

    const r = await run(folder, ["domain", "--deactivate", "--dry-run"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain(`${SHOWCASE.slug} is restricted: make it public from the dashboard's Access section first`);
    // Only the lock, which precedes the guard, is announced.
    expect(r.all.split("\n").filter((line) => line.includes("[dry-run]"))).toEqual([
      "   [dry-run] take the Caddy lock shared with the dashboard's gatekeeper",
    ]);
    expect(vm.logs()).toEqual([`READ ${SHOWCASE.slug}`]);
  });

  test("the refusal falls before the DNS is measured", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text({ ...ACTIVE, portal: true }));
    const inactive: Manifest = { ...SHOWCASE, domain: { name: "sample-door.example", active: false } };

    const r = await run(project(inactive), ["domain", "--activate", "--dry-run"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain("make it public from the dashboard's Access section first");
    expect(r.all).not.toContain("does not resolve");
  });

  test("in agreement with the VM, the switch follows its course", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(ACTIVE));
    const r = await run(project(ACTIVE), ["domain", "--deactivate", "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(r.output).toContain("generate-domains.sh");
  });

  test("an unreadable answer stops the switch", async () => {
    vm = createFakeVm();
    vm.forceAnswer("");
    const r = await run(project(ACTIVE), ["domain", "--deactivate", "--dry-run"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain(`cannot tell whether the general access of ${SHOWCASE.slug}`);
    expect(r.all.split("\n").filter((line) => line.includes("[dry-run]"))).toEqual([
      "   [dry-run] take the Caddy lock shared with the dashboard's gatekeeper",
    ]);
  });
});

describe("sitesolide remove also removes the block laid from the dashboard", () => {
  test("a static site closed from the dashboard: its block goes through SITESOLIDE_REMOVE", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text({ ...SHOWCASE, portal: true }));
    vm.writeBlock(SHOWCASE.slug, "# set by the gatekeeper\n");

    const r = await run(project(SHOWCASE), ["remove", "--confirm", SHOWCASE.slug, "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(r.output).toContain(`[dry-run] bin/deploy-caddy.sh with SITESOLIDE_REMOVE=${SHOWCASE.slug}.caddy`);
    // In the same transaction as the rest, after the public files that the
    // wildcard block would serve in the clear, and before the rest of the
    // folder.
    const publicDir = r.output.indexOf(`rm -rf /srv/sites/${SHOWCASE.slug}/public`);
    const block = r.output.indexOf("SITESOLIDE_REMOVE=");
    const folder = r.output.indexOf(`rm -rf /srv/sites/${SHOWCASE.slug}\n`);
    expect(publicDir).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(publicDir);
    expect(folder).toBeGreaterThan(block);
    // Read before the Caddy lock, for a code to take away first, and under it.
    expect(vm.logs()).toEqual([`READ ${SHOWCASE.slug}`, `READ ${SHOWCASE.slug}`]);
  });

  test("a site that opens with a code goes back to Public through the steward first, then is removed", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text({ ...SHOWCASE, lock: true }));
    vm.acceptWrites();
    const r = await run(project(SHOWCASE), ["remove", "--confirm", SHOWCASE.slug], { vm });
    expect(r.code).toBe(0);
    const logs = vm.logs();
    const general = logs.indexOf(`GENERAL {"slug":"${SHOWCASE.slug}","access":"public"}`);
    const lock = logs.indexOf("LOCK take deploy");
    expect(general).toBeGreaterThan(-1);
    // Before the Caddy lock, which the gatekeeper takes for its own transaction.
    expect(lock).toBeGreaterThan(general);
    expect(logs).toContain(`ACCEPTED sudo rm -rf /srv/sites/${SHOWCASE.slug}`);
  });

  test("for real, an open static site: gone, then its name released from the token that created it", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    vm.setOwners({ [SHOWCASE.slug]: "aaaaaaaaaaaa", other: "bbbbbbbbbbbb" });
    vm.acceptWrites();
    const r = await run(project(SHOWCASE), ["remove", "--confirm", SHOWCASE.slug], { vm });
    expect(r.code).toBe(0);
    const logs = vm.logs();
    // Once the folder is gone, never before: the steward refuses while the machine carries it.
    const folder = logs.indexOf(`ACCEPTED sudo rm -rf /srv/sites/${SHOWCASE.slug}`);
    const release = logs.indexOf(`OWNERSHIP DELETE {"slug":"${SHOWCASE.slug}"}`);
    expect(folder).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(folder);
    expect(r.output).toContain(`${SHOWCASE.slug} created by token aaaaaaaaaaaa: its name is free again for another token`);
    expect(vm.owners()).toEqual({ other: "bbbbbbbbbbbb" });
    // Run again, as after a failure half way: nothing left to release, said so.
    const again = await run(project(SHOWCASE), ["remove", "--confirm", SHOWCASE.slug], { vm });
    expect(again.code).toBe(0);
    expect(again.output).toContain(`no token created ${SHOWCASE.slug}`);
  });

  test("a dry run says it would release the name, and asks the steward nothing", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    const r = await run(project(SHOWCASE), ["remove", "--confirm", SHOWCASE.slug, "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(r.output).toContain(`[dry-run] release ${SHOWCASE.slug} from the token that created it, if one did, and drop its people with access`);
    expect(vm.logs().some((line) => line.startsWith("OWNERSHIP"))).toBe(false);
  });

  test("an open static site has no block to remove", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    const r = await run(project(SHOWCASE), ["remove", "--confirm", SHOWCASE.slug, "--dry-run"], { vm });
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("deploy-caddy.sh");
  });

  test("an unreadable answer stops the removal before any gesture", async () => {
    vm = createFakeVm();
    vm.forceAnswer("DONE\ncut\n");
    const r = await run(project(SHOWCASE), ["remove", "--confirm", SHOWCASE.slug, "--dry-run"], { vm });
    expect(r.code).toBe(1);
    expect(r.error).toContain(`cannot tell whether ${SHOWCASE.slug} is restricted`);
    // Only the lock, which precedes the reading, is announced.
    const announcements = r.all.split("\n").filter((line) => line.includes("[dry-run]"));
    expect(announcements).toEqual(["   [dry-run] take the Caddy lock shared with the dashboard's gatekeeper"]);
  });
});
