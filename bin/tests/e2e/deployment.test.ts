import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CADDY_TUNNEL_FILE, TUNNEL_CONFIG, TUNNEL_KIT_FILES, tunnelConfig as connectorConfig } from "../../cli/tunnel";
import { SWITCHES } from "./fake-ssh";
import { createFakeVm } from "./fake-vm";
import { REPO, run, TESTS_ROOT } from "./run";

/**
 * End to end tests of the CLI over the owner's SSH access: `deploy` of a
 * platform component, the one deployment that still goes over SSH (setup and
 * upgrade deploy the dashboard and the portal from the kit), and the commands
 * only that access carries, lock, domain, secrets, remove. Every other
 * project deploys through the dashboard's API, whose installer is tried in
 * dashboard/tests/installer-*.test.ts.
 *
 * **Nothing here touches the VM.** Every test passes `--dry-run`, which
 * displays the commands instead of running them, or runs in front of the fake
 * machine of fake-vm.ts, and `SITESOLIDE_SERVER` points to a name that does
 * not resolve.
 */

/** projects/component, copied out of the repository with `change` applied to its manifest. */
function componentCopy(change: (manifest: Record<string, unknown>) => Record<string, unknown> = (manifest) => manifest): { folder: string; cleanup: () => void } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "component-")));
  const folder = join(parent, "dashboard");
  cpSync(join(TESTS_ROOT, "projects/component"), folder, { recursive: true });
  const path = join(folder, "sitesolide.json");
  writeFileSync(path, `${JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>), null, 2)}\n`);
  return { folder, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

describe("over SSH, the platform's components alone", () => {
  test("a project's folder deploys through the API: without a token, a hint, and nothing asked of the machine", async () => {
    const vm = createFakeVm();
    try {
      const r = await run("projects/bun-mixed", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(1);
      expect(r.all).toContain("sitesolide login");
      expect(r.all).not.toContain("[dry-run]");
      expect(vm.logs().filter((line) => line !== "CONNECT")).toEqual([]);
    } finally {
      vm.cleanup();
    }
  });

  test("a component's name on a manifest of another shape is refused before the machine is read", async () => {
    const vm = createFakeVm();
    const statics = componentCopy(({ slug, publicDir }) => ({ slug, publicDir }));
    const behind = componentCopy((manifest) => ({ ...manifest, portal: true }));
    try {
      for (const folder of [statics.folder, behind.folder]) {
        const r = await run(folder, ["deploy", "--dry-run"], { vm });
        expect(r.code).toBe(1);
        expect(r.error).toContain("dashboard is not shaped as a platform component");
        expect(r.error).toContain("every other project deploys through the dashboard's API");
      }
      expect(vm.logs().filter((line) => line !== "CONNECT")).toEqual([]);
    } finally {
      vm.cleanup();
      statics.cleanup();
      behind.cleanup();
    }
  });
});

describe("the component's build", () => {
  test("a dry run shows the build and runs nothing of the folder", async () => {
    // The build is the folder's own code, on the workstation that holds root
    // SSH to the machine: a dry run never runs it.
    const { folder, cleanup } = componentCopy();
    try {
      rmSync(join(folder, "public"), { recursive: true, force: true });
      const r = await run(folder, ["deploy", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("[dry-run] build (bun run build.ts), not run");
      expect(r.output).toContain("[dry-run] check that the build fills public");
      expect(existsSync(join(folder, "public"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("with --build, the build runs and produces what leaves", async () => {
    const { folder, cleanup } = componentCopy();
    try {
      rmSync(join(folder, "public"), { recursive: true, force: true });
      const r = await run(folder, ["deploy", "--dry-run", "--build"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("-> build (bun run build.ts)");
      // The build really ran: it is what produces what would leave.
      expect(existsSync(join(folder, "public", "index.html"))).toBe(true);
      expect(r.output).toContain(`${folder}/public/`);
    } finally {
      cleanup();
    }
  });

  test("the build gets no SITESOLIDE_ variable, a token exported by hand included, and of the rest only the allow list and the manifest's env", async () => {
    // The build is the folder's own code: a token or another SITESOLIDE_
    // variable in the workstation's environment would be its to read.
    const token = `sst_${"T".repeat(43)}`;
    const vm = createFakeVm();
    const build = 'mkdir -p public && echo ok > public/index.html && env > "$ENV_PROBE"';
    const { folder, cleanup } = componentCopy((manifest) => ({ ...manifest, build, env: { SITE_URL: "https://{slug}.{zone}", ENV_PROBE: "" } }));
    try {
      const probe = join(folder, "..", "build-env.txt");
      // ENV_PROBE reaches the build because the manifest names it: nothing else of the workstation's but the allow list does.
      const path = join(folder, "sitesolide.json");
      writeFileSync(path, readFileSync(path, "utf8").replace('"ENV_PROBE": ""', `"ENV_PROBE": ${JSON.stringify(probe)}`));
      const r = await run(folder, ["deploy", "--dry-run", "--build"], {
        vm,
        env: {
          SITESOLIDE_TOKEN: token,
          SITESOLIDE_ANYTHING_ELSE: "sitesolide's own",
          BUILD_PROBE: "kept",
          SSH_AUTH_SOCK: "/tmp/ssh-agent/agent.1234",
        },
      });
      expect(r.code).toBe(0);
      expect(r.output).toContain(`-> build (${build})`);
      const lines = readFileSync(probe, "utf8").split("\n");
      // SITESOLIDE_SERVER and SITESOLIDE_ZONE, which the CLI itself reads, withheld with the rest.
      expect(lines.filter((line) => line.startsWith("SITESOLIDE_"))).toEqual([]);
      expect(lines.some((line) => line.includes(token) || line.includes("sitesolide's own"))).toBe(false);
      for (const line of [`PATH=${vm.env.PATH}`, `ENV_PROBE=${probe}`, "SITE_URL=https://dashboard.test-zone.invalid"]) expect(lines).toContain(line);
      // Nor the SSH agent, whose keys log into the machine.
      expect(lines.filter((line) => line.startsWith("BUILD_PROBE=") || line.startsWith("SSH_AUTH_SOCK="))).toEqual([]);
    } finally {
      vm.cleanup();
      cleanup();
    }
  });
});

describe("a platform component", () => {
  test("pushes the code and the files separately, then restarts", async () => {
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("project dashboard, service");

    // The code goes into app/, the public files into public/, the data is
    // never overwritten.
    expect(r.output).toContain("/srv/sites/dashboard/app/");
    expect(r.output).toContain("/srv/sites/dashboard/public/");
    expect(r.output).toContain("sudo mkdir -p /srv/sites/dashboard/app");

    // The workstation's dependencies do not leave, and neither does the public
    // folder: it has its own rsync, towards another folder.
    expect(r.output).toContain("--exclude node_modules");
    expect(r.output).toContain("--exclude public");
    expect(r.output).toContain("--exclude .git");

    // Nor do a repository's history and the .env files, at any depth, from
    // either tree; the public one also removes what an earlier deployment
    // left there, which a mere exclusion would keep.
    expect(r.output).toMatch(/rsync -a --delete [^\n]*--exclude \.git --exclude \.env\* [^\n]*\/srv\/sites\/dashboard\/app\//);
    expect(r.output).toMatch(/rsync -a --delete --delete-excluded --exclude \.git --exclude \.env\* \S+\/public\/ \S+:\/srv\/sites\/dashboard\/public\//);

    expect(r.output).toContain("bun install --production");
    expect(r.output).toContain("sudo systemctl restart dashboard");
  });

  test("the data folder belongs to the service, never the code", async () => {
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    expect(r.output).toContain("sudo chown -R site-dashboard:site-dashboard /srv/sites/dashboard/data");
    expect(r.output).toContain("sudo chown sample:sample /srv/sites/dashboard");
    expect(r.output).toContain("sudo chmod 750 /srv/sites/dashboard/data");
  });

  test("in a dry run, deploy shows the confined unit and the Caddy fragment", async () => {
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);

    // The unit: the full hardening, never less.
    expect(r.output).toContain("User=site-dashboard");
    expect(r.output).toContain("MemoryMax=128M");
    expect(r.output).toContain("TemporaryFileSystem=/srv:ro");
    expect(r.output).toContain("IPAddressDeny=any");

    // The fragment: the non negotiable rules, and the component's routes.
    expect(r.output).toContain("import tls-zone");
    expect(r.output).toContain("import /etc/caddy/locks/*.caddy");
    expect(r.output).toContain("/api/*");

    // No handle in a directive. The word appears in the fragment's comments,
    // which explain precisely why there is none: all the handles of a same
    // block form an exclusive group, the lock's one would win, and the visitor
    // holding the right code would receive a 200 with an empty body.
    for (const line of r.output.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      expect(line).not.toContain("handle");
    }
    expect(r.output).toContain("dry run, nothing was installed");
  });

  test("the manifest is deposited once, at the root, and the earlier copies go", async () => {
    // The code's rsync would copy the manifest into app/, beside the one at
    // the root: two files to diverge, and nothing to say which one is the
    // authority. The exclusion is not enough to catch up with the copies
    // already deposited: rsync protects from its --delete what it is told to
    // exclude, instead of erasing it.
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    expect(r.output).toContain("write /srv/sites/dashboard/sitesolide.json");
    expect(r.output).toMatch(/rsync -a --delete[^\n]*--exclude sitesolide\.json/);
    expect(r.output).toContain("rm -f /srv/sites/dashboard/site.json /srv/sites/dashboard/app/sitesolide.json");
  });

  test("its block is installed after the restart and before the check", async () => {
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    const restart = r.output.indexOf("systemctl restart");
    const caddy = r.output.indexOf("deploy-caddy.sh");
    const check = r.output.indexOf("verify https://");
    expect(restart).toBeGreaterThan(-1);
    expect(caddy).toBeGreaterThan(restart);
    expect(check).toBeGreaterThan(caddy);
  });

  test("a port another project declares on the machine stops everything before the build", async () => {
    const vm = createFakeVm();
    try {
      vm.writeManifest("taken", JSON.stringify({ slug: "taken", port: 3022, start: "/x" }));
      const r = await run("projects/component", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(1);
      expect(r.error).toContain("port already taken on the server");
      expect(r.error).toContain("is already declared by project taken");
      expect(r.output).not.toContain("build (");
    } finally {
      vm.cleanup();
    }
  });
});

describe("the second block of the services' ports, read on every deployment of a component", () => {
  /** A unit an earlier CLI wrote for another project: every bind line but the second block's. */
  const OLD_UNIT = "[Service]\nUser=site-old\nSocketBindDeny=2019\nSocketBindDeny=3000-3099\nSocketBindDeny=3128-3129\n";

  test("the block open and a unit that may listen in it: a warning naming the unit, the deployment goes on", async () => {
    const vm = createFakeVm();
    try {
      vm.writeFile("etc/systemd/system/old.service", OLD_UNIT);
      const r = await run("projects/component", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(0);
      expect(r.all).toContain("units on the server may listen where Caddy sends other projects' visitors");
      expect(r.all).toContain("old.service");
      expect(vm.logs()).toContain("SECOND-BLOCK");
    } finally {
      vm.cleanup();
    }
  });

  test("a machine read that does not answer only warns: the component's port is in the first block", async () => {
    const vm = createFakeVm();
    try {
      vm.writeFile(SWITCHES.secondBlock, "== rule\n");
      const r = await run("projects/component", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(0);
      expect(r.all).toContain("cannot tell whether every unit on the server still keeps to its own port");
    } finally {
      vm.cleanup();
    }
  });
});

describe("the service after its restart", () => {
  test("for real, read right after the restart, and a reading that does not read is said and stops nothing", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      // No --dry-run: the run goes past the restart, as far as the Caddy
      // step, which the simulated machine cannot carry.
      await run("projects/component", ["deploy"], { vm });
      const logs = vm.logs();
      const restart = logs.findIndex((line) => line.startsWith("ACCEPTED") && line.includes("systemctl restart dashboard"));
      expect(restart).toBeGreaterThan(-1);
      expect(logs.indexOf("STABILITY dashboard")).toBeGreaterThan(restart);
    } finally {
      vm.cleanup();
    }
    const unreadable = createFakeVm();
    try {
      unreadable.acceptWrites();
      unreadable.setStandings([{ dashboard: null }]);
      const r = await run("projects/component", ["deploy"], { vm: unreadable });
      expect(r.output).toContain("!! how the services stand could not be read after their restart: whether they hold is not checked");
      // The deployment goes on to its Caddy step: stopping before it would
      // leave the new code behind the old block.
      expect(r.output).toContain("Caddy fragment");
    } finally {
      unreadable.cleanup();
    }
  }, 30_000);
});

describe("rejects", () => {
  test("a source that points nowhere is refused before anything leaves", async () => {
    const { folder, cleanup } = componentCopy((manifest) => ({ ...manifest, source: "../nowhere" }));
    try {
      const r = await run(folder, ["deploy", "--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.error).toContain("source not found");
    } finally {
      cleanup();
    }
  });

  test("a publicDir that climbs out of the repository is refused", async () => {
    const { folder, cleanup } = componentCopy((manifest) => ({ ...manifest, publicDir: "../.." }));
    try {
      const r = await run(folder, ["deploy", "--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.error).toContain("publicDir");
    } finally {
      cleanup();
    }
  });

  test("an empty publicDir is refused before the rsync", async () => {
    // The --delete would pour the emptiness into the served folder and erase
    // the site. Without a build, the folder is judged as it is.
    const { folder, cleanup } = componentCopy(({ build: _, ...manifest }) => manifest);
    try {
      rmSync(join(folder, "public"), { recursive: true, force: true });
      mkdirSync(join(folder, "public"));
      const r = await run(folder, ["deploy", "--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.error).toContain("empty");
      // The word rsync appears in the message, which says why: it is its
      // --delete that would erase the site.
      expect(r.all).not.toContain("[dry-run] rsync");
    } finally {
      cleanup();
    }
  });

  test("workstation dependencies that are not excluded are refused", async () => {
    const { folder, cleanup } = componentCopy((manifest) => ({ ...manifest, exclude: ["data"] }));
    try {
      mkdirSync(join(folder, "node_modules"));
      writeFileSync(join(folder, "node_modules", "marker.txt"), "fake\n");
      const r = await run(folder, ["deploy", "--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.error).toContain("node_modules");
      expect(r.error).toContain("exclude");
    } finally {
      cleanup();
    }
  });
});

/**
 * A component's unit made by the generator from the manifest the previous
 * deployment left is its own: a changed manifest replaces it without --force,
 * and only that one.
 */
describe("a changed manifest replaces the unit its previous version made", () => {
  const UNIT = "/etc/systemd/system/dashboard.service";
  const installs = (lines: string[]) => lines.filter((line) => line.startsWith("ACCEPTED sudo install") && line.endsWith(UNIT));

  test("M5: the unit the previous deployment laid is replaced by the changed manifest's; a hand edit is kept; no previous manifest, as before", async () => {
    for (const [label, edit, deposit, expected] of [
      ["generated from the previous manifest", (text: string) => text, true, "install"],
      ["edited by hand since", (text: string) => `${text}LimitNOFILE=4096\n`, true, "kept"],
      ["no previous manifest on the machine", (text: string) => text, false, "kept"],
    ] as const) {
      const vm = createFakeVm();
      const earlier = componentCopy((manifest) => ({ ...manifest, memory: "384M" }));
      try {
        vm.acceptWrites();
        vm.keepUnits();
        // The previous deployment: its unit laid as the machine keeps it.
        await run(earlier.folder, ["deploy"], { vm });
        const laid = readFileSync(join(vm.root, UNIT.slice(1)), "utf8");
        expect(laid).toContain("MemoryMax=384M");
        vm.writeFile(UNIT, edit(laid));
        if (deposit) vm.writeManifest("dashboard", readFileSync(join(earlier.folder, "sitesolide.json"), "utf8"));
        else rmSync(join(vm.root, "srv", "sites", "dashboard", "sitesolide.json"), { force: true });
        const already = installs(vm.logs()).length;
        const r = await run("projects/component", ["deploy"], { vm });
        const installed = installs(vm.logs()).length - already;
        expect({ label, installed: installed > 0 ? "install" : "kept" }).toEqual({ label, installed: expected });
        if (expected === "kept") expect(r.output).toContain(`differs    ${UNIT}, left as it is`);
        else expect(readFileSync(join(vm.root, UNIT.slice(1)), "utf8")).not.toContain("MemoryMax=384M");
      } finally {
        vm.cleanup();
        earlier.cleanup();
      }
    }
  }, 60_000);
});

/**
 * A first pass must not require two commands: `setup` deploys each component
 * once, and `deploy` prepares by itself what is missing, the system user and
 * the unit, in the order in which they condition one another.
 */
describe("first pass in a single command", () => {
  test("deploy creates the system user before chowning the data folder", async () => {
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("id -u site-dashboard");
    expect(r.output).toContain("useradd --system --no-create-home");

    // The order matters: the chown -R names the user, and would fail on an
    // unknown account.
    const command = r.output.split("\n").find((line) => line.includes("useradd"));
    expect(command).toBeDefined();
    expect(command!.indexOf("useradd")).toBeLessThan(command!.indexOf("chown -R site-dashboard"));
  });

  test("deploy lays the unit, and announces it before touching the code", async () => {
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    expect(r.output).toContain("systemd unit");
    expect(r.output).toContain("[dry-run] read /etc/systemd/system/dashboard.service, install it if missing");
    // The preparation comes before the sending: a missing unit must not be
    // discovered after the code has left.
    expect(r.output.indexOf("systemd unit")).toBeLessThan(r.output.indexOf("application code"));
  });

  test("in a dry run, both files are read before anything leaves", async () => {
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("--- dashboard.service ---");
    expect(r.output).toContain("--- dashboard.caddy ---");
    expect(r.output).toContain("installed by deploy, once the service is up");
    expect(r.output).toContain("dry run, nothing was installed");
    // And before anything is sent: reading afterwards protects from nothing.
    expect(r.output.indexOf("--- dashboard.service ---")).toBeLessThan(r.output.indexOf("[dry-run] rsync"));
  });

  test("the preparation carries its own guard: the user is only created if missing", async () => {
    const r = await run("projects/component", ["deploy", "--dry-run"]);
    // `useradd` alone fails on the second pass, and the && that follows would
    // no longer execute: the tree would only be laid every other time.
    expect(r.output).toMatch(/id -u site-dashboard >\/dev\/null 2>&1 \|\| sudo useradd/);
    expect(r.output).toContain("mkdir -p");
    expect(r.all).not.toMatch(/\bmkdir (?!-p)/);
  });

  test("two passes propose exactly the same gestures", async () => {
    // Idempotence begins here: nothing that the CLI writes on the workstation
    // must change what it would do on the next pass.
    const first = await run("projects/component", ["deploy", "--dry-run"]);
    const second = await run("projects/component", ["deploy", "--dry-run"]);
    expect(second.code).toBe(0);
    expect(second.output).toBe(first.output);
  });
});

describe("the preview code from the project's folder", () => {
  /**
   * `lock` and `unlock` do not rewrite the gesture: they ask the steward on
   * its owner socket, which launches the gatekeeper, the one path that
   * changes a site's general access on the machine, the dashboard's as well.
   * In a dry run, nothing leaves: the request is shown, with the slug the
   * manifest names, never the folder's.
   */

  test("lock asks for Anyone with the code, for the slug, not the folder name", async () => {
    // The folder is called simple-site and the slug sample-static: it is the
    // case of a project deployed from somewhere other than the sites
    // repository.
    const r = await run("projects/simple-site", ["lock", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("/run/sitesolide-steward-owner/owner.sock http://steward/general");
    expect(r.output).toContain('{"slug":"sample-static","access":"code"}');
    expect(r.output).not.toContain("lock.sh");
  });

  test("unlock asks for Public", async () => {
    const r = await run("projects/simple-site", ["unlock", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('{"slug":"sample-static","access":"public"}');
  });

  test("--new-code asks for a new code instead of the one in force", async () => {
    // Without this flag, `lock` on a site that opens with a code gives back the
    // code in force: a fresh one would break the link already sent.
    const r = await run("projects/simple-site", ["lock", "--new-code", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('{"slug":"sample-static","access":"code","renew":true}');
  });
});

describe("the site's own domain", () => {
  /**
   * The switch holds in three gestures that used to be forgotten separately:
   * the versioned manifest, the same file on the VM, the table that Caddy
   * reads again. The last one is the one that counts: `deploy` never
   * regenerates the table, and a domain declared active without it obtains
   * neither routing nor certificate.
   */
  const MANIFEST_PATH = join(TESTS_ROOT, "projects/own-domain/sitesolide.json");

  test("a project without a domain has nothing to switch, and says so without trying anything", async () => {
    const r = await run("projects/simple-site", ["domain", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("no domain declared");
    expect(r.all).not.toContain("ssh");
  });

  test("activating refuses as long as the DNS does not point here", async () => {
    // Caddy asks for its certificate at the first request, and the authority
    // counts the refusals: a few attempts are enough to block the name for a
    // week.
    const r = await run("projects/own-domain", ["domain", "--activate", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("does not resolve");
    expect(r.all).not.toContain("generate-domains.sh");
  });

  test("--force goes ahead anyway, in the order manifest, VM, table", async () => {
    const before = readFileSync(MANIFEST_PATH, "utf8");
    const r = await run("projects/own-domain", [
      "domain",
      "--activate",
      "--force",
      "--dry-run",
    ]);
    expect(r.code).toBe(0);

    const local = r.output.indexOf("domain.active = true");
    const vm = r.output.indexOf("write /srv/sites/sample-domain/sitesolide.json");
    const table = r.output.indexOf("generate-domains.sh");
    expect(local).toBeGreaterThan(-1);
    expect(vm).toBeGreaterThan(local);
    expect(table).toBeGreaterThan(vm);

    // In a dry run, the versioned manifest is not touched.
    expect(readFileSync(MANIFEST_PATH, "utf8")).toBe(before);
  });

  test("deactivating an already inactive domain touches nothing", async () => {
    const r = await run("projects/own-domain", ["domain", "--deactivate", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("already inactive");
    expect(r.all).not.toContain("generate-domains.sh");
  });
});

describe("the site's own domain behind a Cloudflare Tunnel", () => {
  /**
   * A machine served through a tunnel takes a site's own domain whose zone is
   * at Cloudflare in the tunnel's account: the check is then Cloudflare's
   * edge, which `sample-domain.test` is never served by, a reserved name that
   * resolves nowhere, as the DNS check is tried above with it. The
   * configuration names the tunnel, as setup --tunnel writes it, and the
   * simulated machine carries the tunnel's two files of this release unless
   * the test lays others.
   */
  const TUNNEL = "6f1c2b8e-1d3a-4c5b-9e7f-0a1b2c3d4e5f";
  const TARGET = `${TUNNEL}.cfargotunnel.com`;
  const NAMES = ["sample-domain.test", "www.sample-domain.test"];
  const CURRENT_CADDY = readFileSync(join(REPO, TUNNEL_KIT_FILES.caddy), "utf8");

  function tunnelConfig(): Record<string, string> {
    const folder = mkdtempSync(join(tmpdir(), "own-domain-tunnel-"));
    writeFileSync(join(folder, "config.json"), JSON.stringify({ zone: "test-zone.invalid", email: "sample@test-zone.invalid", tunnel: TUNNEL }));
    return { SITESOLIDE_CONFIG_DIR: folder };
  }

  /** A machine behind the tunnel, its connector's configuration and Caddy's options as given. */
  function tunnelVm(files: { config?: string; caddy?: string } = {}) {
    const vm = createFakeVm();
    vm.writeFile(TUNNEL_CONFIG, files.config ?? connectorConfig(TUNNEL));
    vm.writeFile(CADDY_TUNNEL_FILE, files.caddy ?? CURRENT_CADDY);
    return vm;
  }

  test("a machine whose tunnel files are 0.10.0's is refused before anything, --force or not", async () => {
    // 0.10.0's connector, as it laid it: the zone's two rules, 404 for any
    // other name; and Caddy's options without the issuer that certifies a
    // site's own domain.
    const origin = ["    service: https://[::1]:443", "    originRequest:", "      matchSNItoHost: true", "      noTLSVerify: true"];
    const old = [
      "# Laid by sitesolide setup (bin/cli/tunnel.ts): every name of the zone goes to",
      "# Caddy on the loopback, any other answers 404. See docs/tunnel.md.",
      `tunnel: ${TUNNEL}`,
      "metrics: 127.0.0.1:20240",
      "no-autoupdate: true",
      "ingress:",
      "  - hostname: test-zone.invalid",
      ...origin,
      '  - hostname: "*.test-zone.invalid"',
      ...origin,
      "  - service: http_status:404",
      "",
    ].join("\n");
    const withoutIssuer = CURRENT_CADDY.slice(0, CURRENT_CADDY.indexOf("cert_issuer"));
    for (const [files, stale] of [
      [{ config: old }, [TUNNEL_CONFIG]],
      [{ caddy: withoutIssuer }, [CADDY_TUNNEL_FILE]],
    ] as const) {
      const vm = tunnelVm(files);
      const r = await run("projects/own-domain", ["domain", "--activate", "--force", "--dry-run"], { vm, env: tunnelConfig() });
      expect(r.code).toBe(1);
      expect(r.error).toContain("the machine's tunnel files are not this release's");
      for (const path of stale) expect(r.error).toContain(`${path} is not the one this release lays`);
      expect(r.error).toContain("sitesolide upgrade");
      // Read in the dry run, before the lock, the edge or any write.
      expect(r.all).not.toContain("take the Caddy lock");
      expect(r.all).not.toContain("Cloudflare's edge");
      expect(r.all).not.toContain("domain.active = true");
      expect(r.all).not.toContain("generate-domains.sh");
      rmSync(vm.root, { recursive: true, force: true });
    }
  });

  test("activating refuses while Cloudflare's edge does not serve every name the table adds, and names the records", async () => {
    const vm = tunnelVm();
    const r = await run("projects/own-domain", ["domain", "--activate", "--dry-run"], { vm, env: tunnelConfig() });
    expect(r.code).toBe(1);
    expect(r.error).toContain(`not served by Cloudflare's edge through the tunnel: ${NAMES.join(", ")}`);
    // The records to create, proxied CNAMEs to the tunnel, one per name, in
    // the format setup prints the zone's under --skip-dns.
    for (const name of NAMES) expect(r.error).toMatch(new RegExp(`\\n {5}${name.replaceAll(".", "\\.")} +CNAME ${TARGET}   proxied, TTL auto\\n`));
    expect(r.error).toContain("in a zone of the tunnel's own account");
    // Neither the DNS check of a machine served directly, nor the refusal of 0.10.0.
    expect(r.all).not.toContain("does not resolve");
    expect(r.all).not.toContain("cannot be served");
    expect(r.all).not.toContain("domain.active = true");
    expect(r.all).not.toContain("generate-domains.sh");
    rmSync(vm.root, { recursive: true, force: true });
  });

  test("--force goes ahead, saying what the token needs and the records, in the order manifest, VM, table", async () => {
    const vm = tunnelVm();
    const before = readFileSync(join(TESTS_ROOT, "projects/own-domain/sitesolide.json"), "utf8");
    const r = await run("projects/own-domain", ["domain", "--activate", "--force", "--dry-run"], { vm, env: tunnelConfig() });
    expect(r.code).toBe(0);
    expect(r.output).toContain(`--force: ${NAMES.join(", ")} not served by Cloudflare's edge through the tunnel, switching anyway`);

    const token = r.output.indexOf("Zone / Zone / Read and Zone / DNS / Edit on the domain's zone");
    const records = r.output.indexOf(`CNAME ${TARGET}   proxied, TTL auto`);
    const local = r.output.indexOf("domain.active = true");
    const machine = r.output.indexOf("write /srv/sites/sample-domain/sitesolide.json");
    const table = r.output.indexOf("generate-domains.sh");
    expect(token).toBeGreaterThan(-1);
    expect(records).toBeGreaterThan(token);
    expect(local).toBeGreaterThan(records);
    expect(machine).toBeGreaterThan(local);
    expect(table).toBeGreaterThan(machine);
    expect(readFileSync(join(TESTS_ROOT, "projects/own-domain/sitesolide.json"), "utf8")).toBe(before);
    rmSync(vm.root, { recursive: true, force: true });
  });

  test("under --json, the records come with the result", async () => {
    const vm = tunnelVm();
    const r = await run("projects/own-domain", ["domain", "--activate", "--force", "--dry-run", "--json"], { vm, env: tunnelConfig() });
    expect(r.code).toBe(0);
    const result = r.output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string; tunnelRecords?: unknown })
      .find((event) => event.type === "result");
    expect(result?.tunnelRecords).toEqual(NAMES.map((name) => ({ name, type: "CNAME", content: TARGET, proxied: true })));
    rmSync(vm.root, { recursive: true, force: true });
  });

  test("deactivating works as on a machine served directly, and says the token's permissions on the zone may go", async () => {
    const folder = mkdtempSync(join(tmpdir(), "own-domain-active-"));
    cpSync(join(TESTS_ROOT, "projects/own-domain"), folder, { recursive: true });
    const path = join(folder, "sitesolide.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"active": false', '"active": true'));
    const r = await run(folder, ["domain", "--deactivate", "--dry-run"], { env: tunnelConfig() });
    expect(r.code).toBe(0);
    expect(r.output.indexOf("generate-domains.sh")).toBeGreaterThan(r.output.indexOf("domain.active = false"));
    expect(r.all).not.toContain("Cloudflare's edge");
    expect(r.all).not.toContain("tunnel files");
    expect(r.output).toContain("Zone / Zone / Read and Zone / DNS / Edit on it can be taken off the machine's");
    expect(r.output.indexOf("can be taken off")).toBeGreaterThan(r.output.indexOf("generate-domains.sh"));
    rmSync(folder, { recursive: true, force: true });
  });

  test("on a machine served directly, deactivating says nothing of a token", async () => {
    const folder = mkdtempSync(join(tmpdir(), "own-domain-active-"));
    cpSync(join(TESTS_ROOT, "projects/own-domain"), folder, { recursive: true });
    const path = join(folder, "sitesolide.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"active": false', '"active": true'));
    const r = await run(folder, ["domain", "--deactivate", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("token");
    rmSync(folder, { recursive: true, force: true });
  });
});

describe("removing a project whose services are scheduled", () => {
  test("removed, the timers go first, with every unit the manifest generates", async () => {
    const r = await run("projects/nightly", ["remove", "--confirm", "sample-nightly", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(
      "sudo systemctl disable --now sample-nightly.report.timer sample-nightly.cleanup.timer sample-nightly sample-nightly.report.service sample-nightly.cleanup.service 2>/dev/null || true",
    );
    expect(r.output).toContain("/etc/systemd/system/sample-nightly.report.timer");
    expect(r.output).not.toContain("sample-nightly.report.timer.service");
    // The removal touches no backup: the snapshots stay, and the warning
    // says so rather than claiming the machine keeps none.
    expect(r.output).toContain("Backup snapshots, if the machine takes any, stay; what changed since the last one is lost.");
    expect(r.output).not.toContain("no backup");
  });
});

/** The events of a --json run, the last one checked to end it. */
function jsonEvents(output: string): Record<string, unknown>[] {
  const list = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(["result", "error"]).toContain(list.at(-1)!.type as string);
  return list;
}

/**
 * `sitesolide secrets` over SSH: the project's store, on the steward's owner
 * socket, as root. A value goes on standard input, never in a command line,
 * and never comes back. The dashboard and the portal have no store: they
 * point to the dashboard.
 */
describe("sitesolide secrets, over SSH", () => {
  const VALUE = "e2e-secret-value-never-on-a-line";

  test("the listing: names and states, never a value; nothing written", async () => {
    const vm = createFakeVm();
    try {
      vm.setStore({ variables: { "sample-store": ["SESSION_SECRET"] }, files: { "sample-store": ["signing.pem"] } });
      const r = await run("projects/store-app", ["secrets", "--json"], { vm });
      expect(r.code).toBe(0);
      const result = jsonEvents(r.output).at(-1)!;
      expect(result).toMatchObject({ type: "result", command: "secrets", slug: "sample-store", store: { variables: [{ name: "SESSION_SECRET", source: "store" }] } });
      const human = await run("projects/store-app", ["secrets"], { vm });
      expect(human.output).toContain("-> secrets of sample-store, over SSH, as the owner");
      expect(human.output).toContain("files, read at $CREDENTIALS_DIRECTORY/files_<name>: signing.pem set");
      expect(vm.logs()).toEqual(["STORE GET sample-store", "STORE GET sample-store"]);
    } finally {
      vm.cleanup();
    }
  });

  test("set takes the value on standard input, sends it to the steward on standard input, never in a command line", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      const proc = Bun.spawn(["bun", join(REPO, "bin", "sitesolide.ts"), "secrets", "set", "MAIL_API_KEY", "--stdin", "--json"], {
        cwd: join(TESTS_ROOT, "projects", "store-app"),
        env: { ...process.env, SITESOLIDE_ZONE: "test-zone.invalid", SITESOLIDE_EMAIL: "sample@test-zone.invalid", ...vm.env },
        stdin: new TextEncoder().encode(`${VALUE}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0);
      expect(jsonEvents(output).at(-1)).toMatchObject({ type: "result", command: "secrets", action: "set", set: ["MAIL_API_KEY"] });
      expect(`${output}${error}`).not.toContain(VALUE);
      expect(vm.logs()).toEqual(["STORE PUT /store/variable sample-store MAIL_API_KEY"]);
      expect(vm.store().variables["sample-store"]).toEqual(["MAIL_API_KEY"]);
      expect(readFileSync(join(vm.root, "logs"), "utf8")).not.toContain(VALUE);
    } finally {
      vm.cleanup();
    }
  });

  test("set over a store a token's write made ahead: the steward moves it aside first, and set names what it held, never a value", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      vm.setClaims({ state: "current", claims: { "sample-store": { token: { id: "tok_ci", label: "ci", email: "dev@acme.test" }, store: true } } });
      vm.setStore({ variables: { "sample-store": ["DATABASE_URL"] } });
      const proc = Bun.spawn(["bun", join(REPO, "bin", "sitesolide.ts"), "secrets", "set", "MAIL_API_KEY", "--stdin"], {
        cwd: join(TESTS_ROOT, "projects", "store-app"),
        env: { ...process.env, SITESOLIDE_ZONE: "test-zone.invalid", SITESOLIDE_EMAIL: "sample@test-zone.invalid", ...vm.env },
        stdin: new TextEncoder().encode(`${VALUE}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0);
      expect(output).toContain("!! sample-store's store held what a token set there: moved aside, no longer set: DATABASE_URL");
      expect(output).toContain("set what the project needs yourself");
      expect(`${output}${error}`).not.toContain(VALUE);
      expect(vm.store().variables["sample-store"]).toEqual(["MAIL_API_KEY"]);
      expect(vm.claims()?.claims).toEqual({});
    } finally {
      vm.cleanup();
    }
  });

  test("a value on the command line is refused before anything is read or sent, and so is --dry-run, which no secrets action takes", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      const r = await run("projects/store-app", ["secrets", "set", `MAIL_API_KEY=${VALUE}`, "--json"], { vm });
      expect(r.code).toBe(1);
      expect(jsonEvents(r.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("never goes on the command line") });
      expect(r.all).not.toContain(VALUE);
      const dry = await run("projects/store-app", ["secrets", "generate", "SESSION_SECRET", "--dry-run", "--json"], { vm });
      expect(dry.code).toBe(1);
      expect(vm.logs()).toEqual([]);
    } finally {
      vm.cleanup();
    }
  });

  test("generate draws the value on the server, never shown; a steward from before the store says so", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      const r = await run("projects/store-app", ["secrets", "generate", "SESSION_SECRET", "--json"], { vm });
      expect(jsonEvents(r.output).at(-1)).toMatchObject({ type: "result", action: "generate", generated: ["SESSION_SECRET"] });
      vm.setStore({ state: "old" });
      const old = await run("projects/store-app", ["secrets", "--json"], { vm });
      expect(jsonEvents(old.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("sitesolide upgrade"), hint: expect.stringContaining("sitesolide upgrade") });
    } finally {
      vm.cleanup();
    }
  });

  test("the dashboard and the portal have no store: secrets points to the dashboard; a static site has none either", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "storeless-")));
    const vm = createFakeVm();
    try {
      const portal = join(parent, "portal");
      mkdirSync(portal);
      writeFileSync(join(portal, "sitesolide.json"), JSON.stringify({ slug: "portal", start: "/usr/local/bin/bun run server.ts", port: 3001 }));
      const r = await run(portal, ["secrets"], { vm });
      expect(r.code).toBe(1);
      expect(r.error).toContain("Secrets section of https://dashboard.");
      expect(r.error).toContain("bin/dashboard-password.sh");
      const site = await run("projects/simple-site", ["secrets", "--json"], { vm });
      expect(jsonEvents(site.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("a static site") });
      expect(vm.logs()).toEqual([]);
    } finally {
      vm.cleanup();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("restart over SSH points to the dashboard, and restarts nothing", async () => {
    const r = await run("projects/api-with-secret", ["restart", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("a service is restarted from the dashboard: Restart service, in the project's Overview at https://dashboard.");
    expect(r.all).not.toContain("[dry-run]");
    expect(r.all).not.toContain("systemctl");
  });

  test("the usage offers it, and says where the secrets live", async () => {
    const r = await run(".", ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("usage:");
    expect(r.error).toContain("sitesolide secrets");
    expect(r.error).toContain("never in the repository");
  });
});
