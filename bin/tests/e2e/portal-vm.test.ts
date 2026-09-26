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
import { SWITCHES } from "./fake-ssh";

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
    // The site's door, and nothing else was asked of the machine: the other
    // sites' blocks are not this deployment's business, and in a dry run
    // there is no lock.
    expect(vm.logs()).toEqual(["READ sample-door"]);
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
    expect(r.output).toContain("portal was turned on from the dashboard");
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
    expect(r.output).toContain("portal was turned off from the dashboard");
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
    expect(r.error).toContain("cannot tell whether the portal of sample-door was changed from the dashboard");
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
      "portal was turned off from the dashboard; sitesolide.json updated, commit it",
    );
    expect(readFileSync(join(folder, "sitesolide.json"), "utf8")).toBe(
      setPortal(text(PROTECTED), false),
    );

    // Nothing other than the readings went through, the site's door and its
    // block in service: the preparation of the service is the first write, and
    // the simulated VM refused it. The lock is only taken before the first
    // deposit of the manifest or of the block, much further on.
    expect(r.code).toBe(1);
    const logs = vm.logs();
    expect(logs.slice(0, 2)).toEqual(["READ sample-door", "BLOCK sample-door"]);
    expect(logs.slice(2).every((line) => line.startsWith("REFUSED "))).toBe(true);
    expect(logs).toHaveLength(3);
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
      "portal of tool changed from the dashboard: run `sitesolide deploy` in its folder first",
    );
    expect(r.error).not.toContain("portal of cms");
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
      "portal of cms changed from the dashboard: run `sitesolide deploy` in its folder first",
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

describe("bin/lock.sh does not deposit a stale door", () => {
  async function runLock(subcommand: string, folder: string) {
    const proc = Bun.spawn(
      ["bash", join(REPO, "bin", "lock.sh"), subcommand, SHOWCASE.slug],
      {
        stdout: "pipe",
        stderr: "pipe",
        // The zone has no default: bin/config.sh refuses to guess a machine,
        // and the tests' one resolves nowhere.
        env: { SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...process.env, ...vm.env, SITESOLIDE_PROJECT_DIR: folder },
      },
    );
    const [output, error] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, output, error };
  }

  test("a lock on a site closed from the dashboard is refused before any write", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text({ ...SHOWCASE, portal: true }));
    const folder = project(SHOWCASE);

    const r = await runLock("enable", folder);
    expect(r.code).toBe(1);
    expect(r.error).toContain(`${SHOWCASE.slug} is behind the portal: turn it off from the dashboard first`);
    // The guard reads under the lock shared with the gatekeeper, and the
    // refusal gives it back.
    expect(vm.logs()).toEqual(["LOCK take lock", `READ ${SHOWCASE.slug}`, "LOCK release lock"]);
    expect(vm.lock()).toBeNull();
    expect(readFileSync(join(folder, "sitesolide.json"), "utf8")).toBe(text(SHOWCASE));
  });

  test("reopening the preview of a site closed from the dashboard points to deploy", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text({ ...SHOWCASE, portal: true }));
    const folder = project({ ...SHOWCASE, lock: true });

    const r = await runLock("disable", folder);
    expect(r.code).toBe(1);
    expect(r.error).toContain(
      `portal of ${SHOWCASE.slug} changed from the dashboard: run \`sitesolide deploy\` in its folder first`,
    );
    expect(vm.logs()).toEqual(["LOCK take lock", `READ ${SHOWCASE.slug}`, "LOCK release lock"]);
  });

  test("in agreement with the VM, the guard lets the gesture through", async () => {
    // The gesture then stops on its first reading of the codes file, refused
    // by the simulated VM: the guard, for its part, passed without a word.
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, text(SHOWCASE));
    const folder = project(SHOWCASE);

    const r = await runLock("enable", folder);
    expect(r.error).not.toContain("portal");
    const logs = vm.logs();
    expect(logs.slice(0, 2)).toEqual(["LOCK take lock", `READ ${SHOWCASE.slug}`]);
    expect(logs[2]).toStartWith("REFUSED sudo cat /etc/caddy/locks-codes.json");
    // The failure that follows gives the lock back, through the exit trap.
    expect(logs.at(-1)).toBe("LOCK release lock");
    expect(vm.lock()).toBeNull();
    expect(readFileSync(join(folder, "sitesolide.json"), "utf8")).toBe(text(SHOWCASE));
  });

  test("an unreadable answer stops the gesture", async () => {
    vm = createFakeVm();
    vm.forceAnswer("PRESENT\n");
    const r = await runLock("enable", project(SHOWCASE));
    expect(r.code).toBe(1);
    expect(r.error).toContain(`cannot tell whether the portal of ${SHOWCASE.slug}`);
    expect(vm.logs()).toEqual(["LOCK take lock", `READ ${SHOWCASE.slug}`, "LOCK release lock"]);
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
    expect(r.error).toContain(`${SHOWCASE.slug} is behind the portal: turn it off from the dashboard first`);
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
    expect(r.error).toContain("turn it off from the dashboard first");
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
    expect(r.error).toContain(`cannot tell whether the portal of ${SHOWCASE.slug}`);
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
    expect(vm.logs()).toEqual([`READ ${SHOWCASE.slug}`]);
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
    expect(r.error).toContain(`cannot tell whether ${SHOWCASE.slug} is behind the portal`);
    // Only the lock, which precedes the reading, is announced.
    const announcements = r.all.split("\n").filter((line) => line.includes("[dry-run]"));
    expect(announcements).toEqual(["   [dry-run] take the Caddy lock shared with the dashboard's gatekeeper"]);
  });
});
