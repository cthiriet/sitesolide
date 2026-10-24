import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment, HEADLESS_ANSWER } from "../../cli/fragment";
import { readManifest } from "../../cli/manifest";
import { generateUnit, generateUnits, unitFileName } from "../../cli/unit";
import { SWITCHES } from "./fake-ssh";
import { createFakeVm } from "./fake-vm";
import { REPO, run, TESTS_ROOT } from "./run";

/**
 * End to end tests of the deployment CLI, on four projects that cover the
 * shapes met for real: a showcase without a build, a built documentation, a
 * mixed Bun project, a Python API without a page.
 *
 * **Nothing here touches the VM.** Every test passes `--dry-run`, which
 * displays the commands instead of running them, and `SITESOLIDE_SERVER` points to a
 * name that does not resolve. The tests against the real machine live in
 * vm.test.ts and only run if they are asked for.
 */

describe("showcase without a build", () => {
  test("deploys itself without a service, without Caddy, with nothing to prepare", async () => {
    const r = await run("projects/simple-site", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("project sample-static, static");

    // The folder is created then filled, and nothing else is touched.
    expect(r.output).toContain("sudo mkdir -p /srv/sites/sample-static/public");
    expect(r.output).toContain("/srv/sites/sample-static/public/");
    expect(r.output).toContain("rsync -a --delete");

    // No service, no unit, no Caddy reload.
    expect(r.all).not.toContain("systemctl");
    expect(r.all).not.toContain("deploy-caddy");
  });
});

describe("built documentation", () => {
  test("a dry run shows the build and runs nothing of the folder", async () => {
    // The build is the folder's own code, on the workstation that holds root
    // SSH to the machine: a dry run, the first thing an agent is told to try
    // on a folder it may have just cloned, never runs it.
    const dist = join(TESTS_ROOT, "projects/static-docs/dist");
    rmSync(dist, { recursive: true, force: true });

    const r = await run("projects/static-docs", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("[dry-run] build (bun run build.ts), not run");
    expect(r.output).toContain("[dry-run] check that the build fills dist");
    expect(existsSync(dist)).toBe(false);
  });

  test("with --build, the build runs and produces what leaves", async () => {
    const dist = join(TESTS_ROOT, "projects/static-docs/dist");
    rmSync(dist, { recursive: true, force: true });

    const r = await run("projects/static-docs", ["deploy", "--dry-run", "--build"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("-> build (bun run build.ts)");

    // The build really ran: it is what produces what would leave, and a test
    // that skips it checks nothing.
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(r.output).toContain("projects/static-docs/dist/");
  });

  test("the build gets no SITESOLIDE_ variable, a token exported by hand included, and of the rest only the allow list, the manifest's env and its build secrets", async () => {
    // The build is the folder's own code: a token or a DNS provider's
    // credentials in the workstation's environment would be its to read.
    const token = `sst_${"T".repeat(43)}`;
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "build-env-")));
    const vm = createFakeVm();
    try {
      const folder = join(parent, "site");
      mkdirSync(folder);
      const build = 'mkdir -p public && echo ok > public/index.html && env > "$ENV_PROBE"';
      // ENV_PROBE reaches the build because the manifest names it: nothing else of the workstation's but the allow list does.
      writeFileSync(join(folder, "sitesolide.json"), JSON.stringify({ slug: "build-env", publicDir: "public", build, env: { SITE_URL: "https://{slug}.{zone}" }, secrets: { build: ["ENV_PROBE"] } }));
      const probe = join(parent, "build-env.txt");
      const r = await run(folder, ["deploy", "--dry-run", "--build"], {
        vm,
        env: {
          SITESOLIDE_TOKEN: token,
          SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY: "a DNS provider's secret",
          ENV_PROBE: probe,
          BUILD_PROBE: "kept",
          SSH_AUTH_SOCK: "/tmp/ssh-agent/agent.1234",
        },
      });
      expect(r.code).toBe(0);
      expect(r.output).toContain(`-> build (${build})`);
      const lines = readFileSync(probe, "utf8").split("\n");
      // SITESOLIDE_SERVER and SITESOLIDE_ZONE, which the CLI itself reads, withheld with the rest.
      expect(lines.filter((line) => line.startsWith("SITESOLIDE_"))).toEqual([]);
      expect(lines.some((line) => line.includes(token) || line.includes("a DNS provider's secret"))).toBe(false);
      for (const line of [`PATH=${vm.env.PATH}`, `ENV_PROBE=${probe}`, "SITE_URL=https://build-env.test-zone.invalid"]) expect(lines).toContain(line);
      // Nor the SSH agent, whose keys log into the machine.
      expect(lines.filter((line) => line.startsWith("BUILD_PROBE=") || line.startsWith("SSH_AUTH_SOCK="))).toEqual([]);
      expect(r.output).toContain("build secret ENV_PROBE from your environment");
    } finally {
      vm.cleanup();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("mixed Bun project", () => {
  test("pushes the code and the files separately, then restarts", async () => {
    const r = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("project sample-bun, service");

    // The code goes into app/, the public files into public/, the data is
    // never overwritten.
    expect(r.output).toContain("/srv/sites/sample-bun/app/");
    expect(r.output).toContain("/srv/sites/sample-bun/public/");
    expect(r.output).toContain("sudo mkdir -p /srv/sites/sample-bun/app");

    // The workstation's dependencies do not leave, and neither does the public
    // folder: it has its own rsync, towards another folder.
    expect(r.output).toContain("--exclude node_modules");
    expect(r.output).toContain("--exclude public");
    expect(r.output).toContain("--exclude .git");

    // Nor do a repository's history and the .env files, at any depth, from
    // either tree; the public one also removes what an earlier deployment
    // left there, which a mere exclusion would keep.
    expect(r.output).toMatch(/rsync -a --delete [^\n]*--exclude \.git --exclude \.env\* [^\n]*\/srv\/sites\/sample-bun\/app\//);
    expect(r.output).toMatch(/rsync -a --delete --delete-excluded --exclude \.git --exclude \.env\* \S+\/public\/ \S+:\/srv\/sites\/sample-bun\/public\//);

    expect(r.output).toContain("bun install --production");
    expect(r.output).toContain("sudo systemctl restart sample-bun");
  });

  test("the data folder belongs to the service, never the code", async () => {
    const r = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    expect(r.output).toContain("sudo chown -R site-sample-bun:site-sample-bun /srv/sites/sample-bun/data");
    expect(r.output).toContain("sudo chown sample:sample /srv/sites/sample-bun");
    expect(r.output).toContain("sudo chmod 750 /srv/sites/sample-bun/data");
  });

  test("in a dry run, deploy shows the confined unit and the Caddy fragment", async () => {
    const r = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);

    // The unit: the full hardening, never less.
    expect(r.output).toContain("User=site-sample-bun");
    expect(r.output).toContain("MemoryMax=256M");
    expect(r.output).toContain("TemporaryFileSystem=/srv:ro");
    expect(r.output).toContain("IPAddressDeny=any");
    expect(r.output).toContain("InaccessiblePaths=-/etc/sitesolide");

    // The fragment: the four non negotiable rules.
    expect(r.output).toContain("import tls-zone");
    expect(r.output).toContain("import /etc/caddy/locks/*.caddy");
    expect(r.output).toContain("@dynamic not file");

    // No handle in a directive. The word appears in the fragment's comments,
    // which explain precisely why there is none: all the handles of a same
    // block form an exclusive group, the lock's one would win, and the visitor
    // holding the right code would receive a 200 with an empty body.
    for (const line of r.output.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      expect(line).not.toContain("handle");
    }

    // In a dry run, nothing is written nor laid down. What is really written
    // is checked by vm.test.ts, which runs a real deployment.
    expect(r.output).toContain("dry run, nothing was installed");
  });
});

describe("the manifest on the VM", () => {
  /**
   * The manifest is a site's only configuration file, on the machine as in the
   * repository. These tests hold that promise: it goes up for every project,
   * in a single copy, and the old description goes away.
   */

  test("a showcase deposits it, the only way to enter the table", async () => {
    // A static project otherwise sends up only its public/: without this
    // deposit, api/src/table.ts would read nothing and its domain would leave
    // the table, hence the routing and the certificate renewal.
    const r = await run("projects/simple-site", ["deploy", "--dry-run"]);
    expect(r.output).toContain("write /srv/sites/sample-static/sitesolide.json");
  });

  test("the site.json from before the switch is removed", async () => {
    // What makes the migration, one site at a time. A description left there
    // stops the regeneration of the table, api/src/table.ts refusing to choose
    // between two sources.
    const r = await run("projects/simple-site", ["deploy", "--dry-run"]);
    expect(r.output).toContain("rm -f /srv/sites/sample-static/site.json");
  });

  test("an application project does not send it twice, and erases the earlier copy", async () => {
    // The code's rsync would copy the manifest into app/, beside the one at
    // the root: two files to diverge, and nothing to say which one is the
    // authority.
    //
    // The exclusion is not enough to catch up with the copies already
    // deposited: rsync protects from its --delete what it is told to exclude,
    // instead of erasing it. Measured on 28 August 2026 on two app sites,
    // which kept theirs after a deployment carrying the exclusion.
    const r = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    expect(r.output).toContain("write /srv/sites/sample-bun/sitesolide.json");
    expect(r.output).toMatch(/rsync -a --delete[^\n]*--exclude sitesolide\.json/);
    expect(r.output).toContain("rm -f /srv/sites/sample-bun/site.json /srv/sites/sample-bun/app/sitesolide.json");
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

describe("the order between the code and Caddy", () => {
  test("deploy installs it after the restart and before the check", async () => {
    const r = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    const restart = r.output.indexOf("systemctl restart");
    const caddy = r.output.indexOf("deploy-caddy.sh");
    const check = r.output.indexOf("verify https://");

    expect(restart).toBeGreaterThan(-1);
    expect(caddy).toBeGreaterThan(restart);
    expect(check).toBeGreaterThan(caddy);
  });

  test("a showcase never has a fragment to install", async () => {
    const r = await run("projects/simple-site", ["deploy", "--dry-run"]);
    expect(r.all).not.toContain("deploy-caddy.sh");
  });
});

describe("a project with several services", () => {
  test("the dry run shows one unit per service, the others hanging on the main one", async () => {
    const r = await run("projects/multi-service", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("project sample-lab, 3 services");
    for (const unit of ["sample-lab", "sample-lab.api", "sample-lab.worker"]) {
      expect(r.output).toContain(`--- ${unit}.service ---`);
      expect(r.output).toContain(`[dry-run] read /etc/systemd/system/${unit}.service, install it if missing`);
    }
    expect(r.output).toContain("Wants=sample-lab.api.service sample-lab.worker.service");
    expect(r.output).toContain("PartOf=sample-lab.service");
    expect(r.output).toContain("MemoryMax=512M");
  });

  test("one block: the API gets /v1, the front the rest, the worker nothing", async () => {
    const r = await run("projects/multi-service", ["deploy", "--dry-run"]);
    expect(r.output).toContain("@service-api path /v1/*");
    expect(r.output).toContain("reverse_proxy @service-api 127.0.0.1:3061");
    expect(r.output).toContain("reverse_proxy 127.0.0.1:3060");
    expect(r.output).not.toContain("reverse_proxy 127.0.0.1:3062");
  });

  test("the project set is rebuilt before every service restarts together", async () => {
    const r = await run("projects/multi-service", ["deploy", "--dry-run"]);
    const set = r.output.indexOf("rebuild /etc/sitesolide-loopback-projects.nft");
    const restart = r.output.indexOf("systemctl restart sample-lab sample-lab.api.service sample-lab.worker.service");
    expect(set).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(set);
    expect(r.output).toContain("systemctl is-active sample-lab sample-lab.api.service sample-lab.worker.service");
  });

  test("a loopback rule laid before the project set stops everything, in a dry run too", async () => {
    const vm = createFakeVm();
    try {
      writeFileSync(join(vm.root, SWITCHES.loopbackState), "table\n");
      const r = await run("projects/multi-service", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(1);
      expect(r.error).toContain("the loopback rule in service predates the project set");
      expect(r.error).toContain("deploy-loopback.sh close");
      expect(r.output).not.toContain("system user and directories");
    } finally {
      vm.cleanup();
    }
  });

  test("one service with a backup command reaches its own port: the set is rebuilt, and an old rule stops it", async () => {
    const r = await run("projects/single-with-backup", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("rebuild /etc/sitesolide-loopback-projects.nft");
    const vm = createFakeVm();
    try {
      writeFileSync(join(vm.root, SWITCHES.loopbackState), "table\n");
      const refused = await run("projects/single-with-backup", ["deploy", "--dry-run"], { vm });
      expect(refused.code).toBe(1);
      expect(refused.error).toContain("the loopback rule in service predates the project set");
    } finally {
      vm.cleanup();
    }
    // Without its backup command, the same service needs no set.
    const plain = await run("projects/api-with-secret", ["deploy", "--dry-run"]);
    expect(plain.output).not.toContain("rebuild /etc/sitesolide-loopback-projects.nft");
  });

  test("a backup command on a server whose backup component predates it: said, and nothing refused", async () => {
    const current = await run("projects/single-with-backup", ["deploy", "--dry-run"]);
    expect(current.all).not.toContain("backup component");
    for (const [state, said] of [
      ["outdated", "the backup component on the server predates backup commands"],
      ["absent", "the backup component is not installed on the server"],
    ] as const) {
      const vm = createFakeVm();
      try {
        writeFileSync(join(vm.root, SWITCHES.backupComponent), `${state}\n`);
        const r = await run("projects/single-with-backup", ["deploy", "--dry-run"], { vm });
        expect(r.code).toBe(0);
        expect(r.all).toContain(said);
      } finally {
        vm.cleanup();
      }
    }
    // A project with no backup command does not ask.
    const vm = createFakeVm();
    try {
      writeFileSync(join(vm.root, SWITCHES.backupComponent), "outdated\n");
      const plain = await run("projects/api-with-secret", ["deploy", "--dry-run"], { vm });
      expect(plain.all).not.toContain("backup component");
    } finally {
      vm.cleanup();
    }
  });

  test("a port another project declares on the machine stops everything before the build", async () => {
    const vm = createFakeVm();
    try {
      vm.writeManifest("taken", JSON.stringify({ slug: "taken", port: 3061, start: "/x" }));
      const r = await run("projects/multi-service", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(1);
      expect(r.error).toContain("port already taken on the server");
      expect(r.error).toContain("port 3061 (service api) is already declared by project taken");
    } finally {
      vm.cleanup();
    }
  });
});

describe("a project that runs in the background", () => {
  /**
   * projects/background: a digest every quarter of an hour, written first,
   * and a queue consumer that listens on nothing. No public service and no
   * publicDir: it serves no page. projects/nightly: every service scheduled,
   * its main unit an anchor.
   */

  test("the dry run shows every unit under its own name, the timer included, the worker as the main one", async () => {
    const r = await run("projects/background", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("project sample-bg, 1 worker, 1 scheduled");
    for (const file of ["sample-bg.service", "sample-bg.digest.service", "sample-bg.digest.timer"]) {
      expect(r.output).toContain(`--- ${file} ---`);
      expect(r.output).toContain(`[dry-run] read /etc/systemd/system/${file}, install it if missing`);
    }
    expect(r.output).not.toContain("sample-bg.digest.timer.service");
    // The worker keeps the slug, and wants the timer, never the scheduled service.
    expect(r.output).toContain("ExecStart=/usr/local/bin/bun run consumer.ts\nRestart=always\nRestartSec=2\nRestartSteps=8");
    expect(r.output).toContain("Wants=sample-bg.digest.timer\n");
    expect(r.output).toContain("OnCalendar=*:0/15\n");
    expect(r.output).toContain("RuntimeMaxSec=5m\n");
    expect(r.output).toContain("CPUQuota=50%\n");
    expect(r.output).not.toContain("Environment=PORT=");
  });

  test("its address says it serves no page, and the verify expects that line", async () => {
    const r = await run("projects/background", ["deploy", "--dry-run"]);
    expect(r.output).toContain(`respond "${HEADLESS_ANSWER}" 200`);
    expect(r.output).not.toContain("reverse_proxy");
    expect(r.output).toContain("[dry-run] verify https://sample-bg.test-zone.invalid/, which answers that the project serves no page");
    // Its services listen on nothing: no port of its own to reach.
    expect(r.output).not.toContain("rebuild /etc/sitesolide-loopback-projects.nft");
  });

  test("the restart never names the scheduled service, its timer starts it; the worker is watched for ten seconds", async () => {
    const r = await run("projects/background", ["deploy", "--dry-run"]);
    expect(r.output).toContain(
      "sudo systemctl reset-failed sample-bg sample-bg.digest.timer 2>/dev/null; sudo systemctl restart sample-bg sample-bg.digest.timer && systemctl is-active sample-bg sample-bg.digest.timer",
    );
    expect(r.output).not.toMatch(/systemctl restart [^\n]*sample-bg\.digest\.service/);
    const restart = r.output.indexOf("systemctl restart sample-bg");
    const first = r.output.indexOf("[dry-run] read the state of sample-bg right after the restart");
    const caddy = r.output.indexOf("bin/deploy-caddy.sh sample-bg.caddy");
    const check = r.output.indexOf("verify https://");
    const second = r.output.indexOf("[dry-run] 10 s after the restart, read it again: sample-bg must still be active, never restarted by systemd meanwhile");
    expect(restart).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(restart);
    expect(caddy).toBeGreaterThan(first);
    expect(check).toBeGreaterThan(caddy);
    expect(second).toBeGreaterThan(check);
  });

  test("under --json, what it runs is counted by kind, its kind word unchanged", async () => {
    const r = await run("projects/background", ["deploy", "--dry-run", "--json"]);
    const last = JSON.parse(r.output.trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ type: "result", kind: "services", runs: { servers: 0, workers: 1, scheduled: 1 }, port: null, headless: true });
    // A project that serves a page says nothing of the kind.
    const served = await run("projects/multi-service", ["deploy", "--dry-run", "--json"]);
    const result = JSON.parse(served.output.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ kind: "services", runs: { servers: 3, workers: 0, scheduled: 0 } });
    expect(result).not.toHaveProperty("headless");
  });

  test("systemd is asked to read each schedule before anything is written, in a dry run too", async () => {
    const vm = createFakeVm();
    try {
      const r = await run("projects/background", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(0);
      expect(r.output).toContain("systemd reads every schedule: digest (*:0/15)");
      expect(vm.logs()).toContain("SCHEDULES *:0/15");
      expect(r.output.indexOf("systemd reads every schedule")).toBeLessThan(r.output.indexOf("system user and directories"));
    } finally {
      vm.cleanup();
    }
  });

  test("a schedule systemd cannot read stops everything, naming the service and the syntax", async () => {
    const vm = createFakeVm();
    try {
      vm.refuseSchedules(["*:0/15"]);
      const r = await run("projects/background", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(1);
      expect(r.error).toContain("systemd does not read the schedule of a scheduled service");
      expect(r.error).toContain('services.digest.schedule: "*:0/15"');
      expect(r.error).toContain("man systemd.time, section CALENDAR EVENTS");
      expect(r.output).not.toContain("system user and directories");
      expect(vm.logs().filter((line) => line.startsWith("REFUSED"))).toEqual([]);
    } finally {
      vm.cleanup();
    }
  });

  test("the units' names are checked against systemd, the timer's included", async () => {
    const vm = createFakeVm();
    try {
      vm.systemUnit("sample-bg.digest.timer", "/lib/systemd/system/sample-bg.digest.timer", "[Timer]\nOnCalendar=daily\n");
      const r = await run("projects/background", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(1);
      expect(r.error).toContain("sample-bg is already the name of a service of the server");
      expect(r.error).toContain("sample-bg.digest.timer is already a timer of the machine, read from /lib/systemd/system/sample-bg.digest.timer");
    } finally {
      vm.cleanup();
    }
  });

  test("for real, the services are read right after their restart, and a reading that does not read is said and stops nothing", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      // No --dry-run: the run goes past the restart, as far as the Caddy
      // step, which the simulated machine cannot carry.
      await run("projects/background", ["deploy"], { vm });
      const logs = vm.logs();
      const restart = logs.findIndex((line) => line.startsWith("ACCEPTED") && line.includes("systemctl restart sample-bg sample-bg.digest.timer"));
      expect(restart).toBeGreaterThan(-1);
      expect(logs.indexOf("STABILITY sample-bg")).toBeGreaterThan(restart);
      expect(logs.find((line) => line.startsWith("ACCEPTED") && line.includes("systemctl restart"))).not.toContain("sample-bg.digest.service");
    } finally {
      vm.cleanup();
    }
    const unreadable = createFakeVm();
    try {
      unreadable.acceptWrites();
      unreadable.setStandings([{ "sample-bg": null }]);
      const r = await run("projects/background", ["deploy"], { vm: unreadable });
      expect(r.output).toContain("!! how the services stand could not be read after their restart: whether they hold is not checked");
      // The deployment goes on to its Caddy step: stopping before it would
      // leave the new code behind the old block.
      expect(r.output).toContain("Caddy fragment");
    } finally {
      unreadable.cleanup();
    }
  }, 30_000);

  test("every service scheduled: an anchor stands for the project, its timers restarted, nothing to watch", async () => {
    const r = await run("projects/nightly", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("project sample-nightly, 2 scheduled");
    for (const file of ["sample-nightly.service", "sample-nightly.report.service", "sample-nightly.report.timer", "sample-nightly.cleanup.service", "sample-nightly.cleanup.timer"]) {
      expect(r.output).toContain(`--- ${file} ---`);
    }
    expect(r.output).toContain("Type=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\n");
    expect(r.output).toContain("Wants=sample-nightly.report.timer sample-nightly.cleanup.timer\n");
    expect(r.output).toContain(
      "sudo systemctl restart sample-nightly sample-nightly.report.timer sample-nightly.cleanup.timer && systemctl is-active sample-nightly sample-nightly.report.timer sample-nightly.cleanup.timer",
    );
    expect(r.output).not.toContain("right after the restart");
    expect(r.output).toContain(`respond "${HEADLESS_ANSWER}" 200`);
  });

  test("compared with the server, the anchor and the timers are units like any other", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      const raw = readFileSync(join(TESTS_ROOT, "projects/nightly/sitesolide.json"), "utf8");
      const manifest = readManifest(raw).manifest!;
      vm.writeManifest("sample-nightly", raw);
      vm.writeBlock("sample-nightly", generateFragment(manifest)!);
      const units = generateUnits(manifest, { slug: "sample-nightly", zone: "test-zone.invalid", contact: "sample@test-zone.invalid" });
      // Every unit in place but one timer, and the timer of a schedule since dropped.
      for (const { unit, text } of units) {
        if (unit !== "sample-nightly.cleanup.timer") vm.writeFile(`/etc/systemd/system/${unitFileName(unit)}`, text);
      }
      const report = units.find(({ unit }) => unit === "sample-nightly.report.timer")!.text;
      vm.writeFile("/etc/systemd/system/sample-nightly.old.timer", report.replace("service report", "service old"));
      const r = await run("projects/nightly", ["deploy", "--dry-run", "--compare", "--json"], { vm });
      expect(r.code).toBe(0);
      const last = JSON.parse(r.output.trim().split("\n").at(-1)!);
      expect(last).toMatchObject({
        type: "result",
        compared: true,
        changes: ["/etc/systemd/system/sample-nightly.cleanup.timer", "/etc/systemd/system/sample-nightly.old.timer, no longer declared"],
        kept: [],
      });
      expect(vm.logs()).toContain("FILE /etc/systemd/system/sample-nightly.report.timer");
      expect(vm.logs()).toContain("LIST-UNITS sample-nightly");
    } finally {
      vm.cleanup();
    }
  });

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

describe("a project that reaches outside through the egress proxy", () => {
  test("its unit keeps the loopback only, and points its clients at the proxy", async () => {
    const r = await run("projects/egress-app", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("IPAddressDeny=any");
    expect(r.output).toContain("IPAddressAllow=localhost");
    expect(r.output).toContain("Environment=HTTPS_PROXY=http://127.0.0.1:3128");
    expect(r.output).toContain("Environment=http_proxy=http://127.0.0.1:3128");
    expect(r.output).toContain("Environment=NO_PROXY=localhost,127.0.0.1,::1");
    expect(r.output).toContain("Environment=SITESOLIDE_CONNECTORS=http://127.0.0.1:3129/connectors");
  });

  test("the proxy's state is read before anything is built or pushed", async () => {
    const vm = createFakeVm();
    try {
      const r = await run("projects/egress-app", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(0);
      expect(vm.logs()).toContain("EGRESS");
    } finally {
      vm.cleanup();
    }
  });

  test("a machine without the proxy stops everything, in a dry run too", async () => {
    const vm = createFakeVm();
    try {
      writeFileSync(join(vm.root, SWITCHES.egressState), "absent\n");
      const r = await run("projects/egress-app", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(1);
      expect(r.error).toContain("the egress proxy is not installed on the server");
      expect(r.error).toContain("deploy-egress.sh");
      expect(r.output).not.toContain("system user and directories");
    } finally {
      vm.cleanup();
    }
  });

  test("a proxy installed but stopped stops everything too", async () => {
    const vm = createFakeVm();
    try {
      writeFileSync(join(vm.root, SWITCHES.egressState), "inactive\n");
      const r = await run("projects/egress-app", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(1);
      expect(r.error).toContain("installed on the server but not running");
      expect(r.output).not.toContain("system user and directories");
    } finally {
      vm.cleanup();
    }
  });

  test("a project without egress never asks", async () => {
    const vm = createFakeVm();
    try {
      writeFileSync(join(vm.root, SWITCHES.egressState), "absent\n");
      const r = await run("projects/bun-mixed", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(0);
      expect(vm.logs()).not.toContain("EGRESS");
    } finally {
      vm.cleanup();
    }
  });
});

describe("a manifest whose code lives elsewhere", () => {
  test("the code leaves from the folder source names, the manifest from its own", async () => {
    const r = await run("projects/sourced", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(`code from ${join(TESTS_ROOT, "projects/fastapi-app")}`);
    expect(r.output).toContain(`${join(TESTS_ROOT, "projects/fastapi-app")}/ sample@invalid.local:/srv/sites/sample-sourced/app/`);
    expect(r.output).toContain("write /srv/sites/sample-sourced/sitesolide.json");
    expect(r.output).toContain("--exclude .venv");
  });
});

describe("Python API", () => {
  test("the whole subdomain goes to the service, without file_server", async () => {
    const r = await run("projects/fastapi-app", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("reverse_proxy 127.0.0.1:3032");
    expect(r.output).not.toContain("file_server");
    expect(r.output).not.toContain("root *");
  });

  test("the start command is the manifest's one, not that of a guessed runtime", async () => {
    const r = await run("projects/fastapi-app", ["deploy", "--dry-run"]);
    expect(r.output).toContain(
      "ExecStart=/srv/sites/sample-api/app/.venv/bin/python -m uvicorn app.main:api",
    );
    expect(r.output).toContain("MemoryMax=384M");
  });

  test("the workstation's venv never leaves for the VM", async () => {
    // The workstation is arm64 macOS, the VM x86_64 Linux: a venv poured over
    // there gives a service that does not start, after having erased the
    // previous one.
    const r = await run("projects/fastapi-app", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("--exclude .venv");
    expect(r.output).toContain("uv sync --frozen --no-dev");
  });

  test("no public folder is pushed when the project declares none", async () => {
    const r = await run("projects/fastapi-app", ["deploy", "--dry-run"]);
    expect(r.output).not.toContain("public files");
  });
});

describe("rejects", () => {
  test("the landing is not deployed this way", async () => {
    // Without this refusal the deployment SUCCEEDS: it publishes a duplicate
    // of the landing on landing.test-zone.invalid, which the wildcard block
    // serves right away.
    const r = await run("rejects/landing-slug", ["deploy", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("reserved for the site on the bare domain");
  });

  test("a source that points nowhere is refused before anything leaves", async () => {
    const r = await run("rejects/source-missing", ["deploy", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("source not found");
  });

  test("a service without a port is refused", async () => {
    const r = await run("rejects/port-missing", ["deploy", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("port");
  });

  test("a publicDir that climbs out of the repository is refused", async () => {
    const r = await run("rejects/path-escapes", ["deploy", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("publicDir");
  });

  test("an empty publicDir is refused before the rsync", async () => {
    // The --delete would pour the emptiness into the served folder and erase
    // the site.
    const empty = join(TESTS_ROOT, "rejects/public-empty/public");
    mkdirSync(empty, { recursive: true });
    for (const entry of readdirSync(empty)) rmSync(join(empty, entry), { recursive: true });

    const r = await run("rejects/public-empty", ["deploy", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("empty");
    // The refusal falls before anything is sent. The word rsync appears in the
    // message, which says why: it is its --delete that would erase the site.
    expect(r.all).not.toContain("[dry-run] rsync");
  });

  test("a showcase does not have to exclude what it does not send", async () => {
    // The check only aims at application projects. A static one only sends its
    // publicDir, and demanding a pointless exclusion from it refused the
    // deployment of three showcases of the repository, whose node_modules only
    // carries a Tailwind compiler.
    const fake = join(TESTS_ROOT, "projects/simple-site/node_modules");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "marker.txt"), "fake\n");
    try {
      const r = await run("projects/simple-site", ["deploy", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.all).not.toContain("exclude:");
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test("workstation dependencies that are not excluded are refused", async () => {
    // The fake node_modules is created here rather than versioned: the
    // repository's .gitignore would swallow it, and the test would wrongly
    // turn green after a clone.
    const fake = join(TESTS_ROOT, "rejects/deps-not-excluded/node_modules");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "marker.txt"), "fake\n");

    const r = await run("rejects/deps-not-excluded", ["deploy", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("node_modules");
    expect(r.error).toContain("exclude");
  });

  test("a folder without a manifest is refused, without trying anything", async () => {
    const r = await run(".", ["deploy", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("sitesolide.json not found");
  });
});

describe("project with a secret", () => {
  test("the unit loads the project's store alone, and closes the folder all the same", async () => {
    const r = await run("projects/api-with-secret", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("\nEnvironmentFile=-/etc/sitesolide/projects/sample-secret/env\n");
    expect(r.output).not.toContain("EnvironmentFile=-/etc/sitesolide/sample-secret.env");
    expect(r.output).toContain("LoadCredential=files:/etc/sitesolide/projects/sample-secret/files");
    // PID 1 reads both before the walls go up (bench Q3): the folder stays
    // closed to the service.
    expect(r.output).toContain("InaccessiblePaths=-/etc/sitesolide");
    expect(r.output).toContain("ProtectProc=invisible");
  });

  test("network outbound lifts the network confinement, and only that", async () => {
    const r = await run("projects/api-with-secret", ["deploy", "--dry-run"]);
    expect(r.output).not.toContain("IPAddressDeny=any");
    // Everything else holds.
    expect(r.output).toContain("TemporaryFileSystem=/srv:ro");
    expect(r.output).toContain("MemoryMax=256M");
  });

  test("in a dry run, nothing of its secrets is asked of the VM", async () => {
    const vm = createFakeVm();
    try {
      const r = await run("projects/api-with-secret", ["deploy", "--dry-run"], { vm });
      expect(r.code).toBe(0);
      expect(r.output).toContain("[dry-run] the declared runtime secrets the store lacks asked for at a terminal, warned of otherwise");
      // Nothing is asked of the machine: an end to end test must run without it.
      expect(vm.logs().filter((line) => line.startsWith("STORE "))).toEqual([]);
      expect(r.all).not.toContain("/etc/sitesolide/sample-secret.env");
      expect(r.all).not.toContain("from the vault");
    } finally {
      vm.cleanup();
    }
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
 * The project's store of secrets, /etc/sitesolide/projects/<slug>/, on the
 * deploy path: its folders laid before the units, what it lacks read before
 * the build and the Caddy lock, warned of and never a stop.
 */
describe("deploy and the store of secrets", () => {
  test("a dry run reads nothing of the store, lays nothing and asks for no value", async () => {
    const vm = createFakeVm();
    try {
      const r = await run("projects/store-app", ["deploy", "--dry-run", "--json"], { vm });
      expect(r.code).toBe(0);
      const list = jsonEvents(r.output);
      const planned = list.filter((event) => event.type === "planned").map((event) => event.message as string);
      expect(planned).toContain("lay /etc/sitesolide/projects/sample-store/ and its files/ folder, root's, 0700, which every unit of sample-store loads");
      expect(planned).toContain("the declared runtime secrets the store lacks asked for at a terminal, warned of otherwise");
      // The store's folders before the units, so that none starts without them.
      const lay = planned.findIndex((message) => message.startsWith("lay /etc/sitesolide/projects/"));
      expect(lay).toBeLessThan(planned.findIndex((message) => message.startsWith("read /etc/systemd/system/sample-store.service")));
      expect(list.at(-1)).toMatchObject({ type: "result", command: "deploy", missingSecrets: null, buildSecrets: [] });
      // Nothing reached the machine: what the store lacks is asked of it for real alone.
      expect(vm.logs().filter((line) => /^(STORE|ACCEPTED|REFUSED)/.test(line))).toEqual([]);
    } finally {
      vm.cleanup();
    }
  });

  test("for real: what the store lacks read before the build and the Caddy lock, warned of under --json, and the deployment goes on; its folders laid before the units", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      vm.setStore({ variables: { "sample-store": ["SESSION_SECRET"] } });
      // No --dry-run: the run goes past the restart, as far as the HTTPS
      // check, which a zone that resolves nowhere fails.
      const r = await run("projects/store-app", ["deploy", "--json"], { vm });
      const list = jsonEvents(r.output);
      expect(list.find((event) => event.type === "warning" && String(event.message).startsWith("runtime secrets not set"))).toMatchObject({
        message: "runtime secrets not set on the server: MAIL_API_KEY; files not set on the server: signing.pem",
        details: expect.arrayContaining(["sitesolide secrets set MAIL_API_KEY, or sitesolide secrets generate MAIL_API_KEY (a random key, drawn on the server)", "sitesolide secrets set-file signing.pem < path"]),
      });
      const logs = vm.logs();
      const read = logs.indexOf("STORE GET sample-store");
      const prepared = logs.indexOf("STORE-PREPARE sample-store");
      const unit = logs.findIndex((line) => line.startsWith("ACCEPTED sudo install") && line.includes("/etc/systemd/system/sample-store.service"));
      const lock = logs.indexOf("LOCK take deploy");
      const restart = logs.findIndex((line) => line.startsWith("ACCEPTED") && line.includes("systemctl restart sample-store"));
      expect(read).toBeGreaterThan(-1);
      expect(read).toBeLessThan(lock);
      expect(prepared).toBeGreaterThan(-1);
      expect(prepared).toBeLessThan(unit);
      expect(prepared).toBeLessThan(restart);
      expect(existsSync(join(vm.root, "etc", "sitesolide", "projects", "sample-store", "files"))).toBe(true);
      // Nothing was written to the store: without a terminal, nothing is asked.
      expect(logs.filter((line) => line.startsWith("STORE ") && !line.startsWith("STORE GET"))).toEqual([]);
      // The run went on to the restart: a missing secret stopped nothing.
      expect(restart).toBeGreaterThan(-1);
    } finally {
      vm.cleanup();
    }
  }, 30_000);

  test("a steward from before the store, or one that does not answer: what the store lacks cannot be told, said, and the deployment goes on", async () => {
    for (const state of ["old", "down"] as const) {
      const vm = createFakeVm();
      try {
        vm.acceptWrites();
        vm.setStore({ state });
        const r = await run("projects/store-app", ["deploy", "--json"], { vm });
        expect(jsonEvents(r.output)).toContainEqual(
          expect.objectContaining({ type: "warning", message: expect.stringContaining("cannot tell which declared runtime secrets the store lacks: ") }),
        );
        // A missing secret never stops a deployment, nor does not knowing which: the run went on to the restart.
        expect(vm.logs().some((line) => line.startsWith("ACCEPTED") && line.includes("systemctl restart sample-store"))).toBe(true);
        // A project that declares no runtime secret never asks the store.
        const plain = await run("projects/bun-mixed", ["deploy", "--dry-run", "--json"], { vm });
        expect(plain.code).toBe(0);
        expect(vm.logs().filter((line) => line.startsWith("STORE GET sample-bun"))).toEqual([]);
      } finally {
        vm.cleanup();
      }
    }
  }, 30_000);

  test("a store folder that is a link stops the deployment before the units and the code", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      vm.refuseStorePrepare();
      const r = await run("projects/store-app", ["deploy", "--json"], { vm });
      expect(r.code).toBe(1);
      expect(jsonEvents(r.output).at(-1)).toMatchObject({
        type: "error",
        message: "the store of secrets cannot be laid: /etc/sitesolide/projects/sample-store is a link or not a folder",
        hint: expect.stringContaining("tell the owner of the machine"),
      });
      const logs = vm.logs();
      expect(logs.some((line) => line.includes("/etc/systemd/system/sample-store.service") && line.startsWith("ACCEPTED"))).toBe(false);
      expect(logs.some((line) => line.includes("rsync"))).toBe(false);
    } finally {
      vm.cleanup();
    }
  }, 30_000);

  test("a unit that cannot load its secret files is said so, never as systemd's Protocol error", async () => {
    const vm = createFakeVm();
    try {
      // The restart fails, and the services read after it say 243.
      vm.acceptWrites(["systemctl restart"]);
      vm.setStandings([{ "sample-store": { active: "failed", sub: "failed", restarts: 0, status: 243 } }]);
      const r = await run("projects/store-app", ["deploy", "--json"], { vm });
      expect(r.code).toBe(1);
      expect(jsonEvents(r.output).at(-1)).toMatchObject({
        type: "error",
        message: "sample-store.service could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh sample-store lays the folder again",
        hint: expect.stringContaining("sitesolide refresh"),
      });
    } finally {
      vm.cleanup();
    }
  }, 30_000);

  test("a build secret missing from the environment and the workstation stops before anything is read on the machine; a dry run that does not build only warns", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "build-secret-")));
    const vm = createFakeVm();
    try {
      const folder = join(parent, "site");
      mkdirSync(folder);
      writeFileSync(join(folder, "sitesolide.json"), JSON.stringify({ slug: "build-secret", publicDir: "public", build: "mkdir -p public && touch public/index.html", secrets: { build: ["CMS_TOKEN"] } }));
      const home = join(parent, "home");
      const built = await run(folder, ["deploy", "--dry-run", "--build", "--json"], { vm, env: { HOME: home, SITESOLIDE_VAULT: join(home, "vault") } });
      expect(built.code).toBe(1);
      expect(jsonEvents(built.output).at(-1)).toMatchObject({ type: "error", message: "build secrets missing: CMS_TOKEN", hint: expect.stringContaining("nothing was sent") });
      expect(vm.logs()).toEqual([]);
      const planned = await run(folder, ["deploy", "--dry-run", "--json"], { vm, env: { HOME: home, SITESOLIDE_VAULT: join(home, "vault") } });
      expect(planned.code).toBe(0);
      expect(jsonEvents(planned.output).find((event) => event.type === "warning")).toMatchObject({ message: "build secrets missing: CMS_TOKEN" });
      // From the workstation's file of the project: said by its path, its value never.
      mkdirSync(join(home, "vault"), { recursive: true });
      writeFileSync(join(home, "vault", "build-secret.env"), "CMS_TOKEN=from-the-vault\n");
      const found = await run(folder, ["deploy", "--dry-run", "--build", "--json"], { vm, env: { HOME: home, SITESOLIDE_VAULT: join(home, "vault") } });
      expect(found.code).toBe(0);
      expect(jsonEvents(found.output).at(-1)).toMatchObject({ buildSecrets: [{ name: "CMS_TOKEN", source: "workstation" }] });
      expect(found.all).not.toContain("from-the-vault");
    } finally {
      vm.cleanup();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

/**
 * A unit the generator made from the manifest the previous deployment left on
 * the machine is its own: a changed manifest replaces it without --force (M5).
 */
describe("a changed manifest replaces the unit its previous version made", () => {
  const UNIT = "/etc/systemd/system/sample-store.service";
  const installs = (lines: string[]) => lines.filter((line) => line.startsWith("ACCEPTED sudo install") && line.endsWith(UNIT));

  /** The project's folder as it was deployed before: store-app's code, `change` applied to its manifest. */
  function before(parent: string, change: (manifest: Record<string, unknown>) => Record<string, unknown>): string {
    const folder = join(parent, "before");
    cpSync(join(TESTS_ROOT, "projects", "store-app"), folder, { recursive: true });
    const manifest = change(JSON.parse(readFileSync(join(folder, "sitesolide.json"), "utf8")) as Record<string, unknown>);
    writeFileSync(join(folder, "sitesolide.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return folder;
  }

  test("M5: the unit the previous deployment laid is replaced by the changed manifest's; a hand edit is kept; no previous manifest, as before", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "previous-unit-")));
    try {
      for (const [label, edit, deposit, expected] of [
        ["generated from the previous manifest", (text: string) => text, true, "install"],
        ["edited by hand since", (text: string) => `${text}LimitNOFILE=4096\n`, true, "kept"],
        ["no previous manifest on the machine", (text: string) => text, false, "kept"],
      ] as const) {
        const vm = createFakeVm();
        try {
          vm.acceptWrites();
          vm.keepUnits();
          const earlier = before(parent, (manifest) => ({ ...manifest, memory: "384M" }));
          // The previous deployment: its unit laid as the machine keeps it.
          await run(earlier, ["deploy"], { vm });
          const laid = readFileSync(join(vm.root, UNIT.slice(1)), "utf8");
          expect(laid).toContain("MemoryMax=384M");
          vm.writeFile(UNIT, edit(laid));
          if (deposit) vm.writeManifest("sample-store", readFileSync(join(earlier, "sitesolide.json"), "utf8"));
          else rmSync(join(vm.root, "srv", "sites", "sample-store", "sitesolide.json"), { force: true });
          vm.setStore({ variables: { "sample-store": ["SESSION_SECRET", "MAIL_API_KEY"] } });
          const already = installs(vm.logs()).length;
          const r = await run("projects/store-app", ["deploy"], { vm });
          const installed = installs(vm.logs()).length - already;
          expect({ label, installed: installed > 0 ? "install" : "kept" }).toEqual({ label, installed: expected });
          if (expected === "kept") expect(r.output).toContain(`differs    ${UNIT}, left as it is`);
          else expect(readFileSync(join(vm.root, UNIT.slice(1)), "utf8")).not.toContain("MemoryMax=384M");
        } finally {
          vm.cleanup();
        }
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);

  test("a changed port replaces the unit the previous manifest made", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "previous-port-")));
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      vm.keepUnits();
      const earlier = before(parent, (manifest) => ({ ...manifest, port: 3037 }));
      await run(earlier, ["deploy"], { vm });
      vm.writeManifest("sample-store", readFileSync(join(earlier, "sitesolide.json"), "utf8"));
      const already = installs(vm.logs()).length;
      await run("projects/store-app", ["deploy"], { vm });
      expect(installs(vm.logs()).length).toBeGreaterThan(already);
      expect(readFileSync(join(vm.root, UNIT.slice(1)), "utf8")).toContain("Environment=PORT=3036");
    } finally {
      vm.cleanup();
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * A name a token holds while the machine does not carry its project: its
 * deployment accepted, or its write that made the project's store. The
 * owner's deploy stops on it, naming the token, before any prompt or write,
 * unless --adopt takes the name back first; a deployment of the token's under
 * way is waited for.
 */
describe("deploy and a name a token holds", () => {
  const HELD = { token: { id: "tok_ci", label: "ci", email: "dev@acme.test" }, store: true, deploying: false };
  const written = (logs: string[]): string[] => logs.filter((line) => /^(ACCEPTED|STORE (?!GET )|STORE-PREPARE|CLAIM DELETE|LOCK)/.test(line) || line.includes("rsync"));

  test("held, without --adopt: a stop naming the token and its store, before anything is asked or written, dry run included", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      vm.setClaims({ state: "current", claims: { "sample-store": HELD } });
      for (const asked of [["deploy", "--json"], ["deploy", "--dry-run", "--json"]]) {
        const r = await run("projects/store-app", asked, { vm });
        expect(r.code).toBe(1);
        expect(jsonEvents(r.output).at(-1)).toMatchObject({
          type: "error",
          message: "sample-store is held by token ci (tok_ci, dev@acme.test), and the server does not carry it yet: sitesolide deploy --adopt takes the name back",
          details: expect.arrayContaining(["the token's write made the project's store, which holds what it set there"]),
          hint: expect.stringContaining("never add --adopt on your own"),
        });
      }
      // The claim read before the store's listing, which leads to the prompts; nothing written.
      const logs = vm.logs();
      expect(logs).toContain("CLAIM GET sample-store");
      expect(logs).not.toContain("STORE GET sample-store");
      expect(written(logs)).toEqual([]);
      expect(vm.claims()?.claims["sample-store"]).toEqual(HELD);
    } finally {
      vm.cleanup();
    }
  });

  test("--adopt takes the name back before anything is written, what the token's store held moved aside and named, then deploys; a dry run only says it would", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      // The token's write made the store ahead: SESSION_SECRET and signing.pem, its values.
      vm.setClaims({ state: "current", claims: { "sample-store": HELD } });
      vm.setStore({ variables: { "sample-store": ["SESSION_SECRET"] }, files: { "sample-store": ["signing.pem"] } });
      const dry = await run("projects/store-app", ["deploy", "--dry-run", "--adopt"], { vm });
      expect(dry.code).toBe(0);
      expect(dry.output).toContain("[dry-run] take sample-store back from token ci (tok_ci, dev@acme.test), what its store holds moved aside");
      expect(written(vm.logs())).toEqual([]);

      const r = await run("projects/store-app", ["deploy", "--adopt", "--json"], { vm });
      const logs = vm.logs();
      const taken = logs.indexOf("CLAIM DELETE sample-store");
      expect(taken).toBeGreaterThan(-1);
      // Before the store is read for the prompts, laid, or anything installed.
      expect(taken).toBeLessThan(logs.lastIndexOf("STORE GET sample-store"));
      expect(taken).toBeLessThan(logs.indexOf("STORE-PREPARE sample-store"));
      expect(taken).toBeLessThan(logs.findIndex((line) => line.startsWith("ACCEPTED")));
      const list = jsonEvents(r.output);
      expect(list).toContainEqual(expect.objectContaining({ type: "step", message: "take sample-store back from token ci (tok_ci, dev@acme.test)" }));
      // What it held, names only, no longer set: the store's listing that follows finds them missing.
      expect(list).toContainEqual(
        expect.objectContaining({ type: "warning", message: "sample-store's store held what token ci (tok_ci, dev@acme.test) set there: moved aside, no longer set: SESSION_SECRET, the file signing.pem" }),
      );
      expect(list).toContainEqual(expect.objectContaining({ type: "warning", message: "runtime secrets not set on the server: SESSION_SECRET, MAIL_API_KEY; files not set on the server: signing.pem" }));
      expect(vm.claims()?.claims).toEqual({});
      expect(vm.store().variables["sample-store"]).toEqual([]);
      expect(logs.some((line) => line.startsWith("ACCEPTED") && line.includes("systemctl restart sample-store"))).toBe(true);
    } finally {
      vm.cleanup();
    }
  }, 30_000);

  test("a deployment under way is waited for, --adopt or not, a token's or one nobody holds", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      vm.setClaims({ state: "current", claims: { "sample-store": { ...HELD, deploying: true } } });
      for (const asked of [["deploy", "--json"], ["deploy", "--adopt", "--json"]]) {
        const r = await run("projects/store-app", asked, { vm });
        expect(r.code).toBe(1);
        expect(jsonEvents(r.output).at(-1)).toMatchObject({
          type: "error",
          message: "sample-store is being deployed by token ci (tok_ci, dev@acme.test): wait for its deployment to end, then deploy again",
          hint: expect.stringContaining("wait for it to end"),
        });
      }
      // The steward says a deployment runs, though nothing holds the name: waited for all the same.
      vm.setClaims({ state: "current", claims: { "sample-store": { token: null, store: false, deploying: true, claimed: false } } });
      const unheld = await run("projects/store-app", ["deploy", "--json"], { vm });
      expect(unheld.code).toBe(1);
      expect(jsonEvents(unheld.output).at(-1)).toMatchObject({ type: "error", message: "sample-store is being deployed: wait for its deployment to end, then deploy again", hint: expect.stringContaining("wait for it to end") });
      expect(written(vm.logs())).toEqual([]);
    } finally {
      vm.cleanup();
    }
  });

  test("a steward from before claims holds none; one that cannot say is warned of, and the deployment goes on", async () => {
    for (const state of ["old", "down"] as const) {
      const vm = createFakeVm();
      try {
        vm.acceptWrites();
        vm.setClaims({ state, claims: { "sample-store": HELD } });
        const r = await run("projects/store-app", ["deploy", "--dry-run", "--json"], { vm });
        expect({ state, code: r.code }).toEqual({ state, code: 0 });
        const warned = jsonEvents(r.output).filter((event) => event.type === "warning" && String(event.message).startsWith("cannot tell whether a token holds sample-store"));
        expect({ state, warned: warned.length }).toEqual({ state, warned: state === "down" ? 1 : 0 });
      } finally {
        vm.cleanup();
      }
    }
  });

  test("claims that do not read stop the deployment unless --adopt, saying to restore the file, never to delete it", async () => {
    const vm = createFakeVm();
    try {
      vm.acceptWrites();
      vm.setClaims({ state: "unreadable", claims: {} });
      const r = await run("projects/store-app", ["deploy", "--json"], { vm });
      expect(r.code).toBe(1);
      expect(jsonEvents(r.output).at(-1)).toMatchObject({
        type: "error",
        message: expect.stringContaining("the tokens' claims on sample-store do not read on the server: "),
        details: expect.arrayContaining([expect.stringContaining("from the steward's backups, never delete it"), "nothing was sent"]),
        hint: expect.stringContaining("never deletes it"),
      });
      expect(written(vm.logs())).toEqual([]);
      // --adopt deploys all the same, warned, and takes nothing back: nothing can be while they do not read.
      const adopted = await run("projects/store-app", ["deploy", "--dry-run", "--adopt", "--json"], { vm });
      expect(adopted.code).toBe(0);
      expect(jsonEvents(adopted.output)).toContainEqual(expect.objectContaining({ type: "warning", message: expect.stringContaining("the tokens' claims on sample-store do not read on the server") }));
      expect(vm.logs().filter((line) => line.startsWith("CLAIM DELETE"))).toEqual([]);
    } finally {
      vm.cleanup();
    }
  });

  test("a project the machine carries is asked about too: a token that holds it stops the deployment, a deployment of its under way first", async () => {
    const vm = createFakeVm();
    try {
      vm.writeManifest("sample-store", readFileSync(join(TESTS_ROOT, "projects", "store-app", "sitesolide.json"), "utf8"));
      const r = await run("projects/store-app", ["deploy", "--dry-run", "--json"], { vm });
      expect(r.code).toBe(0);
      expect(vm.logs()).toContain("CLAIM GET sample-store");
      vm.setClaims({ state: "current", claims: { "sample-store": HELD } });
      const held = await run("projects/store-app", ["deploy", "--dry-run", "--json"], { vm });
      expect(held.code).toBe(1);
      expect(jsonEvents(held.output).at(-1)).toMatchObject({
        type: "error",
        message: "sample-store is held by token ci (tok_ci, dev@acme.test): sitesolide deploy --adopt takes the name back",
        details: expect.arrayContaining([expect.stringContaining("the server carries the project, and that token holds it")]),
      });
      vm.setClaims({ state: "current", claims: { "sample-store": { ...HELD, deploying: true } } });
      const deploying = await run("projects/store-app", ["deploy", "--dry-run", "--adopt", "--json"], { vm });
      expect(jsonEvents(deploying.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("is being deployed by token ci") });
      // --adopt forgets the hold, the project's store moved aside and named, the prompts asking for what the manifest declares.
      vm.acceptWrites();
      vm.setClaims({ state: "current", claims: { "sample-store": { ...HELD, store: false } } });
      vm.setStore({ variables: { "sample-store": ["SESSION_SECRET", "MAIL_API_KEY"] } });
      const adopted = await run("projects/store-app", ["deploy", "--adopt", "--json"], { vm });
      const list = jsonEvents(adopted.output);
      expect(vm.logs()).toContain("CLAIM DELETE sample-store");
      expect(list).toContainEqual(expect.objectContaining({ type: "warning", message: expect.stringContaining("moved aside, no longer set: SESSION_SECRET, MAIL_API_KEY") }));
      expect(vm.claims()?.claims).toEqual({});
    } finally {
      vm.cleanup();
    }
  }, 30_000);

  test("a steward of 0.8's first claims, which does not say where the project is: the CLI's own reading of the server decides the words", async () => {
    const vm = createFakeVm();
    try {
      vm.setClaims({ state: "current", claims: { "sample-store": HELD }, older: true });
      const r = await run("projects/store-app", ["deploy", "--dry-run", "--json"], { vm });
      expect(jsonEvents(r.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("and the server does not carry it yet") });
    } finally {
      vm.cleanup();
    }
  });
});

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
      vm.setClaims({ state: "current", claims: { "sample-store": { token: { id: "tok_ci", label: "ci", email: "dev@acme.test" }, store: true, deploying: false } } });
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

/**
 * A first pass must no longer require two commands. `deploy` prepares by
 * itself what is missing, and that is what this suite checks: the system user,
 * the unit, the secret, in the order in which they condition one another.
 */
describe("first pass in a single command", () => {
  test("deploy creates the system user before chowning the data folder", async () => {
    const r = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("id -u site-sample-bun");
    expect(r.output).toContain("useradd --system --no-create-home");

    // The order matters: the chown -R names the user, and would fail on an
    // unknown account.
    const command = r.output
      .split("\n")
      .find((line) => line.includes("useradd"));
    expect(command).toBeDefined();
    expect(command!.indexOf("useradd")).toBeLessThan(
      command!.indexOf("chown -R site-sample-bun"),
    );
  });

  test("deploy lays the unit, and announces it before touching the code", async () => {
    const r = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    expect(r.output).toContain("systemd unit");
    expect(r.output).toContain(
      "[dry-run] read /etc/systemd/system/sample-bun.service, install it if missing",
    );
    // The preparation comes before the sending: a missing unit must not be
    // discovered after the code has left.
    expect(r.output.indexOf("systemd unit")).toBeLessThan(
      r.output.indexOf("application code"),
    );
  });

  test("a static project has neither a user, nor a unit, nor a secret", async () => {
    const r = await run("projects/simple-site", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("useradd");
    expect(r.all).not.toContain("systemd unit");
    expect(r.all).not.toContain("declared secrets");
  });

  test("in a dry run, both files are read before anything leaves", async () => {
    // It was the reason for `sitesolide init`, removed on 28 August 2026: two
    // verbs for one gesture made people believe in a prerequisite that no
    // longer existed. The reading joined the gesture, it did not disappear
    // with it.
    const r = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("--- sample-bun.service ---");
    expect(r.output).toContain("--- sample-bun.caddy ---");
    expect(r.output).toContain("installed by deploy, once the service is up");
    expect(r.output).toContain("dry run, nothing was installed");

    // And before anything is sent: reading afterwards protects from nothing.
    expect(r.output.indexOf("--- sample-bun.service ---")).toBeLessThan(
      r.output.indexOf("[dry-run] rsync"),
    );
  });

  test("the preparation carries its own guard: the user is only created if missing", async () => {
    const r = await run("projects/fastapi-app", ["deploy", "--dry-run"]);
    // `useradd` alone fails on the second pass, and the && that follows would
    // no longer execute: the tree would only be laid every other time.
    expect(r.output).toMatch(/id -u site-sample-api >\/dev\/null 2>&1 \|\| sudo useradd/);
    expect(r.output).toContain("mkdir -p");
    expect(r.all).not.toMatch(/\bmkdir (?!-p)/);
  });

  test("two passes propose exactly the same gestures", async () => {
    // Idempotence begins here: nothing that the CLI writes on the workstation
    // must change what it would do on the next pass.
    const first = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    const second = await run("projects/bun-mixed", ["deploy", "--dry-run"]);
    expect(second.code).toBe(0);
    expect(second.output).toBe(first.output);
  });
});

describe("project behind the portal", () => {
  test("checks the portal, lays the door, and only then the files", async () => {
    const r = await run("projects/portal-mixed", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("forward_auth @portal_guard");

    // Laid first, the files would be served in the clear by the
    // *.test-zone.invalid block until the fragment arrives.
    const portal = r.output.indexOf("check https://portal.");
    const door = r.output.indexOf("bin/deploy-caddy.sh sample-portal.caddy");
    const files = r.output.indexOf("/srv/sites/sample-portal/public/");
    expect(portal).toBeGreaterThan(-1);
    expect(door).toBeGreaterThan(portal);
    expect(files).toBeGreaterThan(door);
    // And the door is not laid down again after the restart.
    expect(r.output.indexOf("bin/deploy-caddy.sh sample-portal.caddy", door + 1)).toBe(-1);
  });
});
