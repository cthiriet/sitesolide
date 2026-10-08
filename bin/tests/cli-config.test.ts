import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptLegacyKeys,
  composeConfig,
  configPath,
  defaultPaths,
  deploymentAccount,
  expandHome,
  IncompleteConfig,
  mergeConfig,
  privateFolder,
} from "../cli/config";
import { printSettings, settings } from "../cli/settings";

const HOME = "/Users/test";
const MINIMUM = { server: "me@elsewhere", zone: "test.invalid", email: "me@test.invalid" };

describe("paths", () => {
  test("the configuration lives in ~/.config/sitesolide", () => {
    expect(configPath(HOME, {})).toBe(join(HOME, ".config", "sitesolide", "config.json"));
  });

  test("SITESOLIDE_CONFIG_DIR moves the whole folder: configuration and vault", () => {
    // A second installation driven from the same workstation, whose folder in
    // its usual place may point at a machine in service: every path of the
    // CLI and of the scripts comes from here, so none of them can miss it.
    const environment = { SITESOLIDE_CONFIG_DIR: "~/second" };
    expect(privateFolder(HOME, environment)).toBe("/Users/test/second");
    expect(configPath(HOME, environment)).toBe("/Users/test/second/config.json");
    expect(defaultPaths(HOME, environment)).toEqual({ vault: "/Users/test/second/secrets" });
    expect(mergeConfig(MINIMUM, environment, HOME).vault).toBe("/Users/test/second/secrets");
    expect(privateFolder(HOME, { SITESOLIDE_CONFIG_DIR: "" })).toBe(join(HOME, ".config", "sitesolide"));
  });

  test("the scripts under bin/ read the folder SITESOLIDE_CONFIG_DIR names", () => {
    const folder = mkdtempSync(join(tmpdir(), "config-dir-"));
    try {
      writeFileSync(join(folder, "config.json"), JSON.stringify({ server: "me@second.invalid", zone: "second.invalid", email: "me@second.invalid" }));
      const environment: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("SITESOLIDE_")) environment[key] = value;
      const printed = Bun.spawnSync(["bun", join(import.meta.dir, "..", "cli", "settings.ts")], {
        env: { ...environment, HOME: folder, SITESOLIDE_CONFIG_DIR: folder },
      });
      expect(printed.stdout.toString()).toContain("SITESOLIDE_SERVER='me@second.invalid'");
      expect(printed.stdout.toString()).toContain(`SITESOLIDE_VAULT='${join(folder, "secrets")}'`);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("init and setup write the same file: the required settings, then the optional ones given or already there", () => {
    const written = composeConfig(MINIMUM, { contact: "door@test.invalid" }, { vault: "~/vault", projects: "dropped", api: "" });
    expect(written).toEqual({ ...MINIMUM, contact: "door@test.invalid", vault: "~/vault" });
  });

  test("the tilde is expanded, never left to a shell", () => {
    // The CLI hands this path to Bun.file, which does not know the tilde: a
    // vault declared as "~/.config/sitesolide/secrets" would be looked for in a
    // directory literally named "~".
    expect(expandHome("~/Code/x", HOME)).toBe("/Users/test/Code/x");
    expect(expandHome("~", HOME)).toBe(HOME);
  });
});

describe("no default names a machine", () => {
  test("with no server and no zone, the merge refuses rather than guessing", () => {
    // This is the rule that makes the repository publishable. A ready-made
    // value here would aim at its author's machine, and a deploy run without
    // configuration would land on it.
    expect(() => mergeConfig(null, {}, HOME)).toThrow(IncompleteConfig);
  });

  test("the refusal names what is missing, and only that", () => {
    try {
      mergeConfig({ server: "me@elsewhere", email: "me@test.invalid" }, {}, HOME);
      throw new Error("the merge should have refused");
    } catch (error) {
      if (!(error instanceof IncompleteConfig)) throw error;
      expect(error.missing).toEqual(["zone"]);
      expect(error.message).toContain("sitesolide init");
    }
  });

  test("an empty zone is a missing zone", () => {
    expect(() =>
      mergeConfig({ server: "me@elsewhere", email: "me@test.invalid", zone: "" }, {}, HOME),
    ).toThrow(IncompleteConfig);
  });
});

describe("merging the three sources", () => {
  test("the vault has a default outside every repository", () => {
    // Beside the configuration file: out of git, so that no `git add` in a
    // repository can ever publish a credential.
    const config = mergeConfig(MINIMUM, {}, HOME);
    expect(config.vault).toBe("/Users/test/.config/sitesolide/secrets");
  });

  test("the projects repository has no default: it only exists for those who have one", () => {
    expect(mergeConfig(MINIMUM, {}, HOME).sites).toBeNull();
  });

  test("the file wins over the defaults", () => {
    const config = mergeConfig({ ...MINIMUM, vault: "~/vault" }, {}, HOME);
    expect(config.server).toBe("me@elsewhere");
    expect(config.zone).toBe("test.invalid");
    expect(config.vault).toBe("/Users/test/vault");
  });

  test("the environment wins over the file", () => {
    // Same precedence as in the scripts under bin/: a test against another
    // machine is set up the same way everywhere.
    const config = mergeConfig(
      { ...MINIMUM, vault: "/prod/vault" },
      { SITESOLIDE_SERVER: "me@test", SITESOLIDE_ZONE: "other.invalid", SITESOLIDE_VAULT: "/tmp/vault" },
      HOME,
    );
    expect(config.server).toBe("me@test");
    expect(config.zone).toBe("other.invalid");
    expect(config.vault).toBe("/tmp/vault");
  });
});

describe("a configuration written before the keys were translated", () => {
  // Only one such file exists, the author's, and dropping the old keys would
  // have turned it into an "incomplete configuration": a message that names the
  // missing settings without ever saying they were renamed, and sends its
  // reader editing the file blind.
  const OLD = {
    serveur: "me@elsewhere",
    zone: "test.invalid",
    courriel: "me@test.invalid",
    coffre: "~/prod/vault",
    projets: "~/prod/projects",
  };

  test("the old keys are read, not refused", () => {
    const config = mergeConfig(OLD, {}, HOME, () => {});
    expect(config.server).toBe("me@elsewhere");
    expect(config.email).toBe("me@test.invalid");
    expect(config.vault).toBe("/Users/test/prod/vault");
  });

  test("the keys for what the workstation no longer keeps are dropped, and named", () => {
    // projects and destinations pointed at copies of the machine's units,
    // blocks and secrets registry, which nothing reads any more.
    const said: string[] = [];
    const config = mergeConfig({ ...MINIMUM, projects: "~/p", destinations: "~/d" } as never, {}, HOME, (m) => said.push(m));
    expect(config as Record<string, unknown>).not.toHaveProperty("projects");
    expect(config as Record<string, unknown>).not.toHaveProperty("destinations");
    expect(said[0]).toContain("keys no longer read: projects, destinations");
    expect(said[0]).toContain("sitesolide init");
  });

  test("the warning names what to rename and what rewrites the file", () => {
    const said: string[] = [];
    mergeConfig(OLD, {}, HOME, (message) => said.push(message));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("serveur -> server");
    expect(said[0]).toContain("courriel -> email");
    expect(said[0]).toContain("coffre -> vault");
    expect(said[0]).toContain("no longer read: projets");
    expect(said[0]).toContain("sitesolide init");
  });

  test("a file that carries neither old key says nothing", () => {
    const said: string[] = [];
    mergeConfig(MINIMUM, {}, HOME, (message) => said.push(message));
    expect(said).toEqual([]);
  });

  test("the new key wins over the old one, and the old one does not survive", () => {
    // A file half rewritten by hand: what `init` writes is what counts, and the
    // leftover must not come back out of the merge under its own name.
    const { config, legacy } = adoptLegacyKeys({ ...OLD, server: "me@new" } as never);
    expect(config.server).toBe("me@new");
    expect((config as Record<string, unknown>).serveur).toBeUndefined();
    expect(legacy).toContain("serveur");
  });

  test("the scripts under bin/ get the settings out of an old file too", () => {
    // bin/config.sh evaluates settings.ts, which reads the file through
    // readConfigFile: without the adoption, every script would set off with an
    // empty server and ssh would complain about a missing hostname.
    const values = settings(adoptLegacyKeys(OLD as never).config, {}, HOME);
    expect(values.SITESOLIDE_SERVER).toBe("me@elsewhere");
    expect(values.SITESOLIDE_EMAIL).toBe("me@test.invalid");
    expect(values.SITESOLIDE_VAULT).toBe("/Users/test/prod/vault");
  });
});

describe("the scripts under bin/ read the same configuration", () => {
  // A second reader written in shell would end up diverging from the CLI's: it
  // would have neither tilde expansion nor the precedence of the environment.
  // bin/config.sh therefore evaluates the output of settings.ts.

  test("the output is a series of quoted shell assignments", () => {
    const values = settings(MINIMUM, {}, HOME);
    const text = printSettings(values);
    expect(text).toContain("SITESOLIDE_SERVER='me@elsewhere'");
    expect(text).toContain("SITESOLIDE_ZONE='test.invalid'");
    expect(text).toContain("SITESOLIDE_VAULT='/Users/test/.config/sitesolide/secrets'");
  });

  test("a single quote in a path does not break the evaluation", () => {
    // The shell recomposes the string: 'a'\''b' is a'b. Without that quoting, a
    // directory whose name carries an apostrophe would have anything at all
    // evaluated.
    const values = settings({ ...MINIMUM, vault: "/tmp/it's" }, {}, HOME);
    expect(printSettings(values)).toContain(`SITESOLIDE_VAULT='/tmp/it'\\''s'`);
  });

  test("the default paths are the CLI's, not a second list", () => {
    const defaults = defaultPaths(HOME, {});
    const values = settings(MINIMUM, {}, HOME);
    expect(values.SITESOLIDE_VAULT).toBe(defaults.vault);
  });

  test("with no configuration, the server and the zone come out empty rather than invented", () => {
    // settings.ts refuses nothing: a script dying in the middle of an eval
    // would leave a half-configured shell. bin/config.sh is what stops, and
    // what names the missing setting.
    const values = settings({}, {}, HOME);
    expect(values.SITESOLIDE_SERVER).toBe("");
    expect(values.SITESOLIDE_ZONE).toBe("");
  });

  test("the deployment account is derived from the server", () => {
    // Declared separately, it would end up naming another account than the one
    // that connects, and the deployed files would be unreadable to Caddy.
    expect(deploymentAccount("me@203.0.113.10")).toBe("me");
    expect(deploymentAccount("host-without-account")).toBe("host-without-account");
    expect(settings({ server: "me@203.0.113.10", zone: "c.invalid" }, {}, HOME).DEPLOY_USER).toBe("me");
    expect(settings({}, {}, HOME).DEPLOY_USER).toBe("");
  });

  test("the projects repository is only set when it exists", () => {
    expect(settings({ server: "a@b", zone: "c.invalid" }, {}, HOME).SITESOLIDE_SITES_REPO).toBeUndefined();
    expect(settings({ server: "a@b", zone: "c.invalid", sites: "~/projects" }, {}, HOME).SITESOLIDE_SITES_REPO).toBe(
      "/Users/test/projects",
    );
  });

  test("every caddy validate a script runs loads the environment systemd gives Caddy", async () => {
    // Run by hand, caddy validate reads neither the Cloudflare token nor the
    // zone, both of which systemd hands Caddy through EnvironmentFile: without
    // the zone every address is empty and the validation fails whatever was
    // changed. generate-domains.sh and lock.sh loaded the token alone, and no
    // domain could be activated on 5 October 2026. lock.sh no longer
    // validates anything: the gatekeeper does, with the same two files.
    const root = join(import.meta.dir, "..");
    const calls: string[] = [];
    for await (const name of new Bun.Glob("*.sh").scan({ cwd: root })) {
      const script = await Bun.file(join(root, name)).text();
      for (const line of script.split("\n")) {
        if (line.trimStart().startsWith("#") || !line.includes("caddy validate --config")) continue;
        calls.push(name);
        expect({ name, token: line.includes(". /etc/caddy/cloudflare.env"), zone: line.includes(". /etc/caddy/sitesolide.env") }).toEqual({ name, token: true, zone: true });
      }
    }
    expect(calls.sort()).toEqual(["deploy-caddy.sh", "generate-domains.sh"]);
  });

  test("every deployment script requires the configuration before acting", async () => {
    // Without that call, a script run with no configuration would set off with
    // an empty SITESOLIDE_SERVER: ssh would see a missing hostname, and the message would
    // be its own, not the one pointing at sitesolide init.
    const exempt = new Set(["config.sh", "test.sh"]);
    const root = join(import.meta.dir, "..");
    for await (const name of new Bun.Glob("*.sh").scan({ cwd: root })) {
      const script = await Bun.file(join(root, name)).text();
      expect(script).toContain('. "$REPO_ROOT/bin/config.sh"');
      if (exempt.has(name)) continue;
      expect(`${name}: ${script}`).toContain("sitesolide_require_config");
    }
  });
});

describe("what the deployment scripts do on the machine", () => {
  const root = join(import.meta.dir, "..");
  const scripts = async () => {
    const found: [string, string][] = [];
    for await (const name of new Bun.Glob("*.sh").scan({ cwd: root })) {
      found.push([name, await Bun.file(join(root, name)).text()]);
    }
    return found;
  };

  test("a probe of a service port runs as root", async () => {
    // The loopback rule lets only Caddy and root reach ports 3000 to 3099.
    // deploy-api.sh probed its service from the deployment account, was
    // refused every time since the rule closed, and stopped there.
    for (const [name, script] of await scripts()) {
      for (const line of script.split("\n")) {
        if (!/curl[^|]*(127\.0\.0\.1|localhost):30\d\d/.test(line)) continue;
        expect(`${name}: ${line.trim()}`).toContain("sudo");
      }
    }
  });

  test("deploy-api.sh lays down the unit it carries", async () => {
    // It deployed the code alone, and the unit on the machine stayed the one
    // installed by hand: the code ran without the zone the new unit provides.
    const script = await Bun.file(join(root, "deploy-api.sh")).text();
    expect(script).toContain("/etc/systemd/system/sitesolide-api.service");
    expect(script).toContain("deploy/sitesolide-api.service");
  });
});

describe("the dashboard's password", () => {
  const script = () => Bun.file(join(import.meta.dir, "..", "dashboard-password.sh")).text();

  test("its hash goes to the machine as root's, 0600, never through a file of the workstation", async () => {
    // The one secret the dashboard cannot create for itself, since it is what
    // opens it. It used to sit in a copy of every secret kept on the
    // workstation; it now travels from memory to the machine.
    const text = await script();
    expect(text).toContain("TARGET=/etc/sitesolide/dashboard.env");
    expect(text).toContain("sudo install -m 600 -o root -g root /dev/stdin $TARGET");
    expect(text).not.toMatch(/>\s*"?\$?[A-Za-z_/.~-]*dashboard\.env/);
  });

  test("a password in place is not replaced without --replace", async () => {
    // A password that works is changed from the dashboard; replacing it here
    // by mistake would lock its author out.
    const text = await script();
    expect(text).toContain('sudo test -e $TARGET" && [ -z "$REPLACE" ]');
  });
});


