import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "../../cli/manifest";
import { generateUnit } from "../../cli/unit";
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
  test("the build runs and produces what leaves", async () => {
    const dist = join(TESTS_ROOT, "projects/static-docs/dist");
    rmSync(dist, { recursive: true, force: true });

    const r = await run("projects/static-docs", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("build (bun run build.ts)");

    // The build really ran: it is what produces what would leave, and a test
    // that skips it checks nothing.
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(r.output).toContain("projects/static-docs/dist/");
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

describe("the lock from the project's folder", () => {
  /**
   * `lock` and `unlock` do not rewrite the gesture: they run bin/lock.sh,
   * which lays the code, writes the manifest, generates the fragment,
   * validates it, reloads Caddy and measures the result, with a restore on
   * every failure. Two paths towards the same configuration in service is what
   * the disappearance of site.json has just corrected.
   */

  test("lock closes the preview of the slug, not of the folder name", async () => {
    // The folder is called showcase-simple and the slug sample-static: it is
    // the case of a project deployed from somewhere other than the sites
    // repository, and the script therefore receives the folder rather than
    // deducing it from the slug.
    const r = await run("projects/simple-site", ["lock", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("lock.sh enable sample-static");
  });

  test("unlock reopens", async () => {
    const r = await run("projects/simple-site", ["unlock", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("lock.sh disable sample-static");
  });

  test("--new-code renews instead of recalling", async () => {
    // Without this flag, `lock` on an already closed site gives back the code
    // in force: generating a fresh one would break the link already sent to
    // the client.
    const r = await run("projects/simple-site", ["lock", "--new-code", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("lock.sh code sample-static");
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
  test("the unit loads the file and no longer forbids the folder", async () => {
    const r = await run("projects/api-with-secret", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("EnvironmentFile=-/etc/sitesolide/sample-secret.env");
    // A service that reads its own file does not carry the directive,
    // otherwise systemd could not give it to it.
    expect(r.output).not.toContain("InaccessiblePaths=-/etc/sitesolide");
  });

  test("network outbound lifts the network confinement, and only that", async () => {
    const r = await run("projects/api-with-secret", ["deploy", "--dry-run"]);
    expect(r.output).not.toContain("IPAddressDeny=any");
    // Everything else holds.
    expect(r.output).toContain("TemporaryFileSystem=/srv:ro");
    expect(r.output).toContain("MemoryMax=256M");
  });

  test("in a dry run, the secret's presence is not asked of the VM", async () => {
    const r = await run("projects/api-with-secret", ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(
      "[dry-run] check that /etc/sitesolide/sample-secret.env is on the server",
    );
    // Nothing is asked of the machine: an end to end test must run without it.
    expect(r.all).not.toContain("test -f");
    expect(r.all).not.toContain("from the vault");
  });
});

/**
 * The secrets are managed on the machine, from the dashboard's Secrets
 * section: the VM is the authority. `sitesolide secrets` therefore pushes
 * nothing, and says where to go.
 *
 * The tests pass `--dry-run` although the command makes nothing of it: that is
 * what gives them the SITESOLIDE_SERVER that does not resolve, and a regression that
 * started pushing again would fail loudly instead of speaking to production.
 */
describe("sitesolide secrets points to the dashboard", () => {
  test("from a project, it says where the secrets are managed and exits with an error", async () => {
    const r = await run("projects/api-with-secret", ["secrets", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("Secrets section of https://dashboard.");
    expect(r.error).toContain("source of truth");
  });

  test("it recalls the one secret the dashboard cannot create, its own password", async () => {
    const r = await run("projects/api-with-secret", ["secrets", "--dry-run"]);
    expect(r.error).toContain("bin/dashboard-password.sh");
    // Nothing is pushed from the workstation any more: the script that did it
    // is gone, and the command must not send anyone looking for it.
    expect(r.error).not.toContain("deploy-secrets");
  });

  test("it no longer holds any site file outside the dashboard", async () => {
    // The dashboard, the portal and the landing used to be kept out of it;
    // naming them still as exceptions would point to the vault for files that
    // the dashboard now manages, and a value pushed from there would overwrite
    // the one in service. The message only quotes the platform's own pieces:
    // an ordinary site has no business appearing there, the platform knowing
    // nothing of their trade.
    const r = await run("projects/api-with-secret", ["secrets", "--dry-run"]);
    expect(r.error).toContain("the dashboard, the portal and the landing included");
    expect(r.error).not.toContain("dashboard.env");
    expect(r.error).not.toContain("portal.env");
    expect(r.error).not.toContain("does not manage");
  });

  test("nothing leaves, nothing is read, nothing restarts", async () => {
    const r = await run("projects/api-with-secret", ["secrets", "--dry-run"]);
    // Not even a command displayed in a dry run: there is no gesture to
    // simulate.
    expect(r.all).not.toContain("[dry-run]");
    expect(r.all).not.toContain("systemctl");
    expect(r.all).not.toContain("test -f");
  });

  test("outside a project, the answer is the same", async () => {
    const r = await run(".", ["secrets", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("Secrets section of https://dashboard.");
    expect(r.error).toContain("bin/dashboard-password.sh");
    expect(r.all).not.toContain("[dry-run]");
  });

  test("the usage no longer offers it, and says where the secrets live", async () => {
    const r = await run(".", ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.error).toContain("usage:");
    expect(r.error).not.toContain("sitesolide secrets");
    expect(r.error).toContain("Secrets section of https://dashboard.");
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
