import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countItemized } from "../cli/comparison";
import { hintFor } from "../cli/hints";
import type { KitRunner, KitTask } from "../cli/setup";
import { COMPONENT_CONDITIONS } from "../cli/setup";
import {
  API_LEFT_OUT,
  labelFor,
  lastEvent,
  NOT_INSTALLED,
  parseUpgradeArguments,
  readFingerprints,
  runUpgrade,
  sameFile,
  stateOf,
  STEWARD_WRITES_BACKUPS,
  surveyScript,
  treeDigest,
  treeDigestCommand,
  treeListing,
  upgradeComponents,
  upgradeOutput,
  withPlan,
  type UpgradeOptions,
} from "../cli/upgrade";
import { scriptLabels } from "../cli/steps";
import { EMAIL, FakeMachine, fakeKit, HOST, printed, ZONE, type Printed } from "./setup-fakes";

/**
 * `sitesolide upgrade`: what decides, and the whole sequence against the model
 * machine and kit of setup-fakes.ts, the ones setup's tests use. Nothing here
 * opens a connection. The machine is the set of labels its checks report; a
 * component is out of date when one of its fingerprints' labels is missing,
 * and a run of its script sets them again, as a real run makes its check pass.
 *
 * What has to hold: the order of docs/upgrading.md; only what differs runs; a
 * component the machine does not carry is never installed, and setup named
 * for it; a dry run runs nothing; a failure names its component and the next
 * run resumes there; a second run changes nothing; no secret is ever read.
 */

const REPO = join(import.meta.dir, "..", "..");
const SERVER = `deploy@${HOST}`;
const FOLDERS: string[] = [];

afterEach(() => {
  for (const folder of FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(prefix = "upgrade-"): string {
  const made = mkdtempSync(join(tmpdir(), prefix));
  FOLDERS.push(made);
  return made;
}

/** The order the components are brought up to date in, as docs/upgrading.md gives it. */
const ORDER = ["caddy-unit", "backups", "egress", "steward", "dashboard", "collector", "gatekeeper", "installer", "caddy-config", "api", "portal", "monitor"];

/** What each script's --fingerprint prints, as the real scripts word it: checked against them below. */
const FINGERPRINTED: Record<string, string[]> = {
  "deploy-backup.sh": [
    "/usr/local/lib/sitesolide/backup.js",
    "/etc/systemd/system/sitesolide-backup.service",
    "/etc/systemd/system/sitesolide-backup.timer",
    "/etc/systemd/system/sitesolide-restore@.service",
  ],
  "deploy-egress.sh": ["/usr/local/lib/sitesolide/egress.js", "/etc/systemd/system/sitesolide-egress.service"],
  "deploy-steward.sh": ["/usr/local/lib/sitesolide/steward.js", "/etc/systemd/system/sitesolide-steward.service"],
  "deploy-gatekeeper.sh": [
    "/usr/local/lib/sitesolide/gatekeeper.js",
    "/etc/systemd/system/sitesolide-gatekeeper-on@.service",
    "/etc/systemd/system/sitesolide-gatekeeper-off@.service",
  ],
  "deploy-installer.sh": ["/usr/local/lib/sitesolide/installer.js", "/etc/systemd/system/sitesolide-installer@.service", "/etc/sitesolide-installer.env"],
  "deploy-monitor.sh": ["/usr/local/lib/sitesolide/monitor.js", "/etc/systemd/system/sitesolide-monitor.service", "/etc/systemd/system/sitesolide-monitor.timer"],
};

/** What a run sets on the model machine beyond setup's labels: the fingerprints its check compares. */
const RUN_LABELS: Record<string, string[]> = {
  "deploy-backup.sh install": FINGERPRINTED["deploy-backup.sh"]!.map((path) => labelFor(path)),
  "deploy-egress.sh": FINGERPRINTED["deploy-egress.sh"]!.map((path) => labelFor(path)),
  "deploy-steward.sh": [...FINGERPRINTED["deploy-steward.sh"]!.map((path) => labelFor(path)), STEWARD_WRITES_BACKUPS.label],
  "deploy-gatekeeper.sh": [...FINGERPRINTED["deploy-gatekeeper.sh"]!.map((path) => labelFor(path)), "no-previous-template"],
  "deploy-installer.sh": FINGERPRINTED["deploy-installer.sh"]!.map((path) => labelFor(path)),
  "deploy-monitor.sh": FINGERPRINTED["deploy-monitor.sh"]!.map((path) => labelFor(path)),
  "deploy-collector.sh": ["sitesolide-collector.service", "sitesolide-collector.timer"],
  "deploy-caddy.sh": ["caddyfile-current"],
  "deploy-api.sh": ["sitesolide-api.service", "api-release"],
  "deploy dashboard": ["dashboard-code"],
  "deploy portal": ["portal-code"],
};

function taskName(task: KitTask): string {
  return task.kind === "deploy" ? ["deploy", task.folder, ...(task.args ?? [])].join(" ") : [task.name, ...task.args].join(" ");
}

type UpgradeKit = { run: KitRunner; tasks: string[]; failing: Set<string>; unreadableCompare: Set<string> };

/**
 * setup-fakes' kit, which sets setup's labels, with what upgrade asks of it
 * on top: a script's --fingerprint, and deploy's comparison with the server,
 * answered from the model machine. Neither changes anything there.
 */
function upgradeKit(machine: FakeMachine): UpgradeKit {
  const base = fakeKit(machine);
  const tasks: string[] = [];
  const failing = new Set<string>();
  const unreadableCompare = new Set<string>();
  const run: KitRunner = async (task, environment) => {
    const name = taskName(task);
    tasks.push(name);
    if (task.kind === "script" && task.args.includes("--fingerprint")) {
      const lines = (FINGERPRINTED[task.name] ?? []).map((path) => `${"a".repeat(64)}  ${path}`);
      return { code: 0, output: ["-> local build", `   ${task.name}, fingerprint aaaaaaaaaaaa`, ...lines].join("\n") };
    }
    if (task.kind === "deploy" && task.args?.includes("--compare")) {
      if (unreadableCompare.has(task.folder)) {
        return { code: 1, output: JSON.stringify({ type: "error", message: "cannot tell whether /srv/sites/x/sitesolide.json is there", details: [], hint: "" }) };
      }
      const changes = machine.labels.has(`${task.folder}-code`) ? [] : [`/srv/sites/${task.folder}/public: 3 entries to send or delete`];
      return { code: 0, output: `{"type":"step","message":"compare with the server"}\n${JSON.stringify({ type: "result", ok: true, command: "deploy", compared: true, changes, kept: [] })}` };
    }
    if (failing.has(name)) {
      failing.delete(name);
      machine.timeline.push(`kit ${name}`);
      return { code: 1, output: "-> local build\n-> verifications\n!! the installed file does not match the local build" };
    }
    const result = await base.run(task, environment);
    if (result.code === 0) machine.install(RUN_LABELS[name] ?? []);
    return result;
  };
  return { run, tasks, failing, unreadableCompare };
}

/** Every label a machine set up and current answers: setup's, the survey's, every fingerprint's. */
function currentLabels(): string[] {
  return [
    ...ORDER,
    ...Object.values(COMPONENT_CONDITIONS).flatMap((conditions) => conditions.map((condition) => condition.label)),
    ...Object.values(RUN_LABELS).flat(),
    "override.conf",
    "portal-password",
    "dashboard-password",
  ];
}

type World = { machine: FakeMachine; kit: UpgradeKit; home: string };

/** A machine setup installed, every component current unless `stale` names labels to remove, `absent` components to leave out. */
function world(options: { stale?: string[]; absent?: string[]; config?: Record<string, string> | null } = {}): World {
  const machine = new FakeMachine([]);
  machine.logins.add("deploy");
  machine.sudo.add("deploy");
  machine.install(currentLabels());
  for (const label of options.stale ?? []) machine.labels.delete(label);
  for (const id of options.absent ?? []) machine.labels.delete(id);
  const home = folder("upgrade-home-");
  if (options.config !== null) {
    mkdirSync(join(home, ".config", "sitesolide"), { recursive: true });
    writeFileSync(join(home, ".config", "sitesolide", "config.json"), JSON.stringify(options.config ?? { server: SERVER, zone: ZONE, email: EMAIL }));
  }
  return { machine, kit: upgradeKit(machine), home };
}

async function upgrade(w: World, given: Partial<UpgradeOptions> = {}, print: Printed = printed(given.json === true)) {
  const code = await runUpgrade(
    { dryRun: false, json: false, ...given },
    { connect: () => w.machine, kit: w.kit.run, kitRoot: REPO, home: w.home, environment: {}, output: print.output },
  );
  return { code, print, statuses: print.checks.map((report) => `${report.step}:${report.status}`) };
}

/** The runs that reached the kit or the machine, in order: neither a fingerprint nor a comparison. */
function runs(w: World): string[] {
  return w.machine.timeline.filter((line) => line.startsWith("kit ") || line.endsWith(":run"));
}

describe("the command line", () => {
  test("--dry-run and --json, nothing else", () => {
    expect(parseUpgradeArguments([])).toEqual({ dryRun: false, json: false });
    expect(parseUpgradeArguments(["--dry-run", "--json"])).toEqual({ dryRun: true, json: true });
    const refused = parseUpgradeArguments(["--force"]);
    expect("message" in refused && refused.message).toBe("usage: sitesolide upgrade [--dry-run] [--json]");
    expect("details" in refused && refused.details[0]).toBe("not an option of upgrade: --force");
    expect(hintFor("usage: sitesolide upgrade [--dry-run] [--json]")).toContain("--dry-run");
    // Another installation is the environment's, as for every command.
    expect(parseUpgradeArguments(["--config-dir", "/tmp/x"])).toMatchObject({ message: expect.stringContaining("usage") });
  });
});

describe("fingerprints", () => {
  test("a script's --fingerprint lines, as sha256sum prints them; everything else it says is skipped", () => {
    const sha = "0123456789abcdef".repeat(4);
    const output = ["-> local build", "$ bun scripts/borrow.ts", `   steward.js, fingerprint ${sha.slice(0, 12)}`, `${sha}  /usr/local/lib/sitesolide/steward.js`, `${sha}  /etc/systemd/system/sitesolide-gatekeeper-on@.service`, `${sha}  relative/path`, `${sha}  /etc/x;rm -rf /`].join("\n");
    expect(readFingerprints(output)).toEqual([
      { sha256: sha, path: "/usr/local/lib/sitesolide/steward.js" },
      { sha256: sha, path: "/etc/systemd/system/sitesolide-gatekeeper-on@.service" },
    ]);
  });

  test("a fingerprint becomes a condition read on the machine with sha256sum, and nothing else gets into the script", () => {
    const sha = "f".repeat(64);
    const condition = sameFile({ sha256: sha, path: "/etc/caddy/Caddyfile" });
    expect(condition.label).toBe("caddyfile");
    expect(condition.test).toBe(`[ "$(sha256sum '/etc/caddy/Caddyfile' 2>/dev/null | cut -d' ' -f1)" = '${sha}' ]`);
    expect(labelFor("/etc/systemd/system/sitesolide-gatekeeper-on@.service")).toBe("sitesolide-gatekeeper-on@.service");
    expect(() => sameFile({ sha256: "nope", path: "/etc/x" })).toThrow();
    expect(() => sameFile({ sha256: sha, path: "/etc/x'; reboot; '" })).toThrow();
  });

  test("each deploy script prints the files it installs, after its build and before any connection", async () => {
    // A PATH whose ssh and rsync only leave a mark: --fingerprint must never call them.
    const bin = folder("upgrade-bin-");
    const marks = join(bin, "marks");
    for (const tool of ["ssh", "rsync"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${marks}"\nexit 1\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const config = folder("upgrade-config-");
    for (const [name, paths] of Object.entries(FINGERPRINTED)) {
      const proc = Bun.spawn(["bash", join(REPO, "bin", name), "--fingerprint"], {
        cwd: REPO,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? "",
          SITESOLIDE_CONFIG_DIR: config,
          SITESOLIDE_SERVER: "deploy@invalid.local",
          SITESOLIDE_ZONE: ZONE,
          SITESOLIDE_EMAIL: EMAIL,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ name, code: await proc.exited, error: (await proc.exited) === 0 ? "" : error }).toEqual({ name, code: 0, error: "" });
      expect(readFingerprints(output).map((fingerprint) => fingerprint.path)).toEqual(paths);
    }
    expect(existsSync(marks)).toBe(false);
  }, 120_000);
});

describe("the tree of the shared service", () => {
  function tree(): string {
    const root = folder("upgrade-tree-");
    const put = (path: string, content: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    put("server.ts", "serve()\n");
    put("src/zone.ts", "export const zone = 1\n");
    put(".gitignore", "node_modules\n");
    put("src/B.ts", "upper\n");
    put("node_modules/dep/index.js", "left out\n");
    put("deploy/sitesolide-api.service", "left out\n");
    put("src/nested/node_modules/x.js", "left out at any depth\n");
    symlinkSync(join(root, "server.ts"), join(root, "link.ts"));
    return root;
  }

  test("listed as find | sort | sha256sum lists it: dot files in, the names left out at any depth, links out", () => {
    const root = tree();
    const listing = treeListing(root, API_LEFT_OUT);
    expect(listing.split("\n").filter(Boolean).map((line) => line.slice(66))).toEqual(["./.gitignore", "./server.ts", "./src/B.ts", "./src/zone.ts"]);
    expect(treeDigest(root, API_LEFT_OUT)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.skipIf(Bun.which("sha256sum") === null)("the command the machine runs gives the digest computed here", () => {
    const root = tree();
    const run = Bun.spawnSync(["sh", "-c", treeDigestCommand(root, API_LEFT_OUT)], { stdout: "pipe", stderr: "pipe" });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString().trim()).toBe(treeDigest(root, API_LEFT_OUT));
  });

  test("the command refuses a folder or a name that would break out of it", () => {
    expect(() => treeDigestCommand("/srv/api/current; reboot", API_LEFT_OUT)).toThrow();
    expect(() => treeDigestCommand("/srv/api/current", ["a'b"])).toThrow();
  });
});

describe("what deploy's comparison reads", () => {
  test("an rsync dry run's itemized lines: what it sends, creates or deletes counts, a time or a mode alone does not", () => {
    const gnu = [">f.st...... server.ts", "cd+++++++++ src/new/", ">f+++++++++ src/new/a.ts", ".d..t...... src/", ".f...p..... package.json", "*deleting   old.ts", ""].join("\n");
    expect(countItemized(gnu)).toBe(4);
    // openrsync, macOS's, words its lines alike.
    expect(countItemized("*deleting z\n>fcs..... y\n")).toBe(2);
    expect(countItemized("")).toBe(0);
  });

  test("the last event of a command under --json: its result or its error, whatever it printed before", () => {
    expect(lastEvent('{"type":"step","message":"x"}\n$ bun run build\n{"type":"result","ok":true,"compared":true}\n')).toEqual({ type: "result", ok: true, compared: true });
    expect(lastEvent('{"type":"error","message":"m","details":[],"hint":"h"}')).toMatchObject({ type: "error", message: "m" });
    expect(lastEvent("not json\n{broken")).toBeNull();
  });
});

describe("the components", () => {
  test("in docs/upgrading.md's order, each with one survey condition", () => {
    const components = upgradeComponents();
    expect(components.map((component) => component.id)).toEqual(ORDER);
    expect(scriptLabels(surveyScript(components))).toEqual(ORDER);
    // The backup install and the egress proxy before the steward; the
    // gatekeeper and the installer after the dashboard and the steward.
    const at = (id: string) => ORDER.indexOf(id);
    expect(at("backups")).toBeLessThan(at("steward"));
    expect(at("egress")).toBeLessThan(at("steward"));
    expect(at("steward")).toBeLessThan(at("dashboard"));
    expect(at("dashboard")).toBeLessThan(at("gatekeeper"));
    expect(at("steward")).toBeLessThan(at("installer"));
    expect(at("caddy-unit")).toBeLessThan(at("caddy-config"));
  });

  test("a report says what would run, or ran", () => {
    const report = { step: "steward", title: "steward", status: "todo" as const, detail: "differs: steward.js" };
    expect(withPlan(report, "bin/deploy-steward.sh").detail).toBe("differs: steward.js; would run bin/deploy-steward.sh");
    expect(withPlan({ ...report, status: "ok" }, "bin/deploy-steward.sh").detail).toBe("differed: steward.js; ran bin/deploy-steward.sh");
    expect(withPlan({ ...report, status: "done", detail: null }, "x").detail).toBeNull();
    expect(["done", "todo", "skip", "ok", "fail"].map((status) => stateOf(status as never))).toEqual(["up-to-date", "out-of-date", "missing", "upgraded", "failed"]);
  });

  test("no check names a secret: nothing under /etc/sitesolide/ is ever read", () => {
    const w = world();
    return upgrade(w, { dryRun: true }).then(() => {
      const inputs = w.machine.calls.map((call) => call.input).join("\n");
      expect(inputs).not.toMatch(/\/etc\/sitesolide\//);
      expect(inputs).not.toContain("caddy stop");
      expect(inputs).not.toContain("caddy start");
    });
  });
});

describe("a machine whose every component is current", () => {
  test("every component read, none run, and a result that says so", async () => {
    const w = world();
    const r = await upgrade(w);
    expect(r.print.errors).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.statuses).toEqual(ORDER.map((id) => `${id}:done`));
    expect(runs(w)).toEqual([]);
    expect(r.print.lines).toContain(`-> every installed component of ${SERVER} was up to date: nothing was changed`);
    expect(r.print.results[0]).toMatchObject({ dryRun: false, server: SERVER, zone: ZONE, upgraded: [], upToDate: ORDER, missing: [] });
    // Every check went through sudo -n as the account the configuration names.
    expect(w.machine.calls.every((call) => call.account === "deploy" && call.command.startsWith("sudo -n sh -s upgrade:"))).toBe(true);
  });
});

describe("components out of date", () => {
  test("only what differs runs, in order, through the scripts setup runs; a second run changes nothing", async () => {
    const w = world({ stale: ["steward.js", "dashboard-code", "portal-code", "caddyfile-current"] });
    const first = await upgrade(w);
    expect(first.print.errors).toEqual([]);
    expect(first.code).toBe(0);
    expect(runs(w)).toEqual(["kit deploy-steward.sh", "kit deploy dashboard", "kit deploy-caddy.sh", "kit deploy portal"]);
    expect(first.statuses.filter((status) => status.endsWith(":ok"))).toEqual(["steward:ok", "dashboard:ok", "caddy-config:ok", "portal:ok"]);
    const steward = first.print.checks.find((report) => report.step === "steward")!;
    expect(steward.detail).toBe("differed: steward.js; ran bin/deploy-steward.sh");
    expect(first.print.results[0]!.upgraded).toEqual(["steward", "dashboard", "caddy-config", "portal"]);
    expect(first.print.lines).toContain(`-> upgraded on ${SERVER}: steward, dashboard, caddy-config, portal`);

    const before = runs(w).length;
    const second = await upgrade(w);
    expect(second.code).toBe(0);
    expect(second.statuses).toEqual(ORDER.map((id) => `${id}:done`));
    expect(runs(w).length).toBe(before);
  });

  test("every script and every deploy runs with the configured machine's settings, and no Cloudflare token", async () => {
    const w = world({ stale: ["monitor.js", "dashboard-code"] });
    const environments: Record<string, string>[] = [];
    const recording: KitRunner = async (task, environment) => {
      environments.push(environment);
      return w.kit.run(task, environment);
    };
    await runUpgrade(
      { dryRun: false, json: false },
      { connect: () => w.machine, kit: recording, kitRoot: REPO, home: w.home, environment: { CLOUDFLARE_API_TOKEN: "cf-secret-0123456789abcdef" }, output: printed().output },
    );
    expect(environments.length).toBeGreaterThan(0);
    for (const environment of environments) {
      expect(environment.SITESOLIDE_SERVER).toBe(SERVER);
      expect(environment.SITESOLIDE_ZONE).toBe(ZONE);
      expect(environment.SITESOLIDE_EMAIL).toBe(EMAIL);
      expect(environment.SITESOLIDE_CONFIG_DIR).toBe(join(w.home, ".config", "sitesolide"));
      expect(environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
    }
  });

  test("the egress proxy redeployed, then the steward started again after it, as docs/upgrading.md says", async () => {
    const w = world({ stale: ["egress.js"] });
    const r = await upgrade(w);
    expect(r.code).toBe(0);
    expect(runs(w)).toEqual(["kit deploy-egress.sh", "kit deploy-steward.sh"]);
    const steward = r.print.checks.find((report) => report.step === "steward")!;
    expect(steward.detail).toContain("steward-after-egress");
    // setup's own check of the proxy passes afterwards: setup has nothing to redo.
    expect(w.machine.labels.has("steward-after-egress")).toBe(true);
  });

  test("Caddy's drop-in: setup's own run, through systemctl, never caddy stop nor caddy start", async () => {
    const w = world({ stale: ["override.conf"] });
    const r = await upgrade(w);
    expect(r.code).toBe(0);
    expect(runs(w)).toEqual(["deploy setup:caddy-unit:run"]);
    const run = w.machine.calls.find((call) => call.tag === "setup:caddy-unit:run")!;
    expect(run.input).toContain("systemctl daemon-reload");
    expect(run.input).toContain("systemctl restart caddy");
    // The drop-in's comments name the two commands to forbid them: no line runs one.
    expect(run.input.split("\n").filter((line) => /^\s*(sudo\s+)?caddy\s+(stop|start)\b/.test(line))).toEqual([]);
    expect(run.input).toContain("Restart=always");
  });

  test("the backups: their install, never their first run nor their timer, which setup owns", async () => {
    const w = world({ stale: ["backup.js"] });
    const r = await upgrade(w);
    expect(r.code).toBe(0);
    expect(runs(w)).toEqual(["kit deploy-backup.sh install"]);
    expect(w.kit.tasks).not.toContain("deploy-backup.sh enable");
  });

  test("a steward started before the backups' folder existed is started again", async () => {
    const w = world({ stale: [STEWARD_WRITES_BACKUPS.label] });
    const r = await upgrade(w);
    expect(runs(w)).toEqual(["kit deploy-steward.sh"]);
    expect(r.print.checks.find((report) => report.step === "steward")!.detail).toContain(STEWARD_WRITES_BACKUPS.label);
  });

  test("the conditions that only hold when their component is there: no egress, no backups, nothing asked of the steward about them", async () => {
    const w = world({ absent: ["egress", "backups"] });
    await upgrade(w, { dryRun: true });
    const steward = w.machine.calls.find((call) => call.tag === "upgrade:steward:check")!;
    expect(scriptLabels(steward.input)).not.toContain("steward-after-egress");
    expect(scriptLabels(steward.input)).not.toContain(STEWARD_WRITES_BACKUPS.label);
    const full = world();
    await upgrade(full, { dryRun: true });
    const all = full.machine.calls.find((call) => call.tag === "upgrade:steward:check")!;
    expect(scriptLabels(all.input)).toEqual(expect.arrayContaining(["steward-active", "steward-code", "steward.js", "sitesolide-steward.service", "steward-after-egress", STEWARD_WRITES_BACKUPS.label]));
  });
});

describe("--dry-run", () => {
  test("every component listed with its state and what would run; nothing runs", async () => {
    const w = world({ stale: ["egress.js", "dashboard-code"], absent: ["installer"] });
    const r = await upgrade(w, { dryRun: true });
    expect(r.code).toBe(0);
    expect(runs(w)).toEqual([]);
    expect(w.machine.runs()).toEqual([]);
    const byStep = Object.fromEntries(r.print.checks.map((report) => [report.step, report]));
    expect(byStep.egress!.status).toBe("todo");
    expect(byStep.egress!.detail).toBe("differs: egress.js; would run bin/deploy-egress.sh, the steward restarted after it");
    // The proxy would run first: the steward would start again after it.
    expect(byStep.steward!.status).toBe("todo");
    expect(byStep.steward!.detail).toContain("steward-after-egress");
    expect(byStep.dashboard!.detail).toBe("differs: /srv/sites/dashboard/public: 3 entries to send or delete; would run sitesolide deploy in dashboard/");
    expect(byStep.installer).toMatchObject({ status: "skip", detail: NOT_INSTALLED });
    expect(byStep.monitor!.status).toBe("done");
    const result = r.print.results[0]!;
    expect(result).toMatchObject({ dryRun: true, outOfDate: ["egress", "steward", "dashboard"], missing: ["installer"], upgraded: [] });
    expect((result.components as { component: string; state: string }[]).map((c) => `${c.component}:${c.state}`)).toContain("installer:missing");
    expect(r.print.lines).toContain("-> dry run: 3 component(s) to upgrade, egress, steward, dashboard; nothing was changed");
    // Only reads reached the kit: fingerprints and comparisons.
    expect(w.kit.tasks.every((task) => task.endsWith("--fingerprint") || task.includes("--compare"))).toBe(true);
  });

  test("a machine already current: nothing to do", async () => {
    const r = await upgrade(world(), { dryRun: true });
    expect(r.statuses).toEqual(ORDER.map((id) => `${id}:done`));
    expect(r.print.lines).toContain("-> every installed component is up to date: nothing to do");
  });

  test("a comparison that cannot be read is said, and nothing is decided on it", async () => {
    const w = world();
    w.kit.unreadableCompare.add("portal");
    const r = await upgrade(w, { dryRun: true });
    const portal = r.print.checks.find((report) => report.step === "portal")!;
    expect(portal.status).toBe("todo");
    expect(portal.detail).toContain("unreadable: sitesolide deploy --dry-run --compare in portal/: cannot tell whether");
    const real = await upgrade(w);
    expect(real.code).toBe(1);
    expect(real.print.errors[0]!.message).toBe("upgrade stopped at portal: could not tell whether it is done: sitesolide deploy --dry-run --compare in portal/: cannot tell whether /srv/sites/x/sitesolide.json is there");
    expect(runs(w)).toEqual([]);
    expect(hintFor(real.print.errors[0]!.message)).toContain("run `sitesolide upgrade` again");
  });
});

describe("components the machine does not carry", () => {
  test("never installed here: reported missing, and setup named for them", async () => {
    // A machine set up with --minimal.
    const w = world({ absent: ["backups", "installer", "egress"], stale: ["monitor.js"] });
    const r = await upgrade(w);
    expect(r.code).toBe(0);
    expect(runs(w)).toEqual(["kit deploy-monitor.sh"]);
    expect(w.kit.tasks.some((task) => /deploy-(backup|installer|egress)\.sh/.test(task))).toBe(false);
    const missing = r.print.checks.filter((report) => report.status === "skip");
    expect(missing.map((report) => report.step)).toEqual(["backups", "egress", "installer"]);
    expect(missing.every((report) => report.detail === NOT_INSTALLED)).toBe(true);
    const setup = `sitesolide setup ${SERVER} --zone ${ZONE} --email ${EMAIL}`;
    expect(r.print.lines).toContain(`   not installed, left as they are: backups, egress, installer; ${setup} installs them`);
    expect(r.print.results[0]).toMatchObject({ missing: ["backups", "egress", "installer"], next: [setup] });
  });

  test("another installation's folder is named in the setup command", async () => {
    const w = world({ absent: ["installer"], config: null });
    const config = join(w.home, "test-install");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "config.json"), JSON.stringify({ server: SERVER, zone: ZONE, email: EMAIL }));
    const print = printed();
    await runUpgrade({ dryRun: true, json: false }, { connect: () => w.machine, kit: w.kit.run, kitRoot: REPO, home: w.home, environment: { SITESOLIDE_CONFIG_DIR: config }, output: print.output });
    expect(print.results[0]!.next).toEqual([`SITESOLIDE_CONFIG_DIR=${config} sitesolide setup ${SERVER} --zone ${ZONE} --email ${EMAIL}`]);
  });

  test("a machine with nothing of sitesolide: refused, setup named, nothing else read", async () => {
    const w = world({ absent: ORDER });
    const r = await upgrade(w);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(`nothing of sitesolide is installed on ${SERVER}`);
    expect(r.print.errors[0]!.details).toContain(`to install the machine: sitesolide setup ${SERVER} --zone ${ZONE} --email ${EMAIL}`);
    expect(w.machine.calls.map((call) => call.tag)).toEqual(["upgrade:survey:check"]);
    expect(hintFor(r.print.errors[0]!.message)).toContain("sitesolide setup");
  });
});

describe("a failure, then the same command again", () => {
  test("stops at the component, quotes what it printed and what to inspect; the next run resumes there", async () => {
    const w = world({ stale: ["egress.js", "gatekeeper.js", "monitor.js"] });
    w.kit.failing.add("deploy-steward.sh");
    const first = await upgrade(w);
    expect(first.code).toBe(1);
    expect(first.statuses.at(-1)).toBe("steward:fail");
    expect(runs(w)).toEqual(["kit deploy-egress.sh", "kit deploy-steward.sh"]);
    const error = first.print.errors[0]!;
    expect(error.message).toBe("upgrade stopped at steward: bin/deploy-steward.sh failed (exit code 1)");
    expect(error.details).toContain("!! the installed file does not match the local build");
    expect(error.details).toContain(`inspect: ssh ${SERVER} 'sudo journalctl -u sitesolide-steward -n 50'`);
    expect(error.details).toContain("run sitesolide upgrade again to resume: the components already up to date are skipped");
    expect(error.details).toContain("upgraded before it: egress");
    expect(hintFor(error.message)).toContain("resumes at that component");

    const before = runs(w).length;
    const second = await upgrade(w);
    expect(second.code).toBe(0);
    // The proxy is current now: the run starts again at the steward.
    expect(runs(w).slice(before)).toEqual(["kit deploy-steward.sh", "kit deploy-gatekeeper.sh", "kit deploy-monitor.sh"]);
    expect(second.statuses.slice(0, 3)).toEqual(["caddy-unit:done", "backups:done", "egress:done"]);
  });

  test("a run on the machine that fails stops there too, with the end of what it said", async () => {
    const w = world({ stale: ["override.conf"] });
    w.machine.failing.add("setup:caddy-unit:run");
    const r = await upgrade(w);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe("upgrade stopped at caddy-unit: Caddy did not restart with its drop-in (exit code 1)");
    expect(r.print.errors[0]!.details).toContain("E: the run of caddy-unit broke");
    expect(r.statuses).toEqual(["caddy-unit:fail"]);
  });
});

describe("what stops upgrade before anything is read", () => {
  test("no configuration: the settings missing, and no connection", async () => {
    const w = world({ config: null });
    const r = await upgrade(w);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe("missing settings: server, zone, email");
    expect(w.machine.calls).toEqual([]);
    expect(hintFor(r.print.errors[0]!.message)).toContain("sitesolide init");
  });

  test("a server without its account", async () => {
    const r = await upgrade(world({ config: { server: HOST, zone: ZONE, email: EMAIL } }));
    expect(r.print.errors[0]!.message).toBe(`the configured server is not user@host: ${HOST}`);
  });

  test("a machine that refuses the login: cannot reach it, nothing changed", async () => {
    const w = world();
    w.machine.logins.delete("deploy");
    const r = await upgrade(w);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(`cannot reach ${SERVER} over SSH`);
    expect(w.machine.runs()).toEqual([]);
  });

  test("an account without passwordless sudo", async () => {
    const w = world();
    w.machine.sudo.delete("deploy");
    const r = await upgrade(w);
    expect(r.print.errors[0]!.message).toBe(`${SERVER} has no sudo without a password, which upgrade needs`);
    expect(hintFor(r.print.errors[0]!.message)).toContain("never type a password");
  });
});

describe("--json", () => {
  test("one event per line, the checklist as check events, and one result naming upgrade last", async () => {
    const lines: string[] = [];
    const w = world({ stale: ["monitor.js"] });
    const output = upgradeOutput(true, (line) => lines.push(line));
    const code = await runUpgrade({ dryRun: true, json: true }, { connect: () => w.machine, kit: w.kit.run, kitRoot: REPO, home: w.home, environment: {}, output });
    expect(code).toBe(0);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ type: "result", ok: true, command: "upgrade", dryRun: true, outOfDate: ["monitor"] });
    expect(events.filter((event) => event.type === "check").map((event) => event.step)).toEqual(ORDER);
    expect(events.filter((event) => event.type === "result" || event.type === "error")).toHaveLength(1);
  });

  test("a failure ends on one error, with a hint", async () => {
    const lines: string[] = [];
    const w = world({ stale: ["monitor.js"] });
    w.kit.failing.add("deploy-monitor.sh");
    const output = upgradeOutput(true, (line) => lines.push(line));
    const code = await runUpgrade({ dryRun: false, json: true }, { connect: () => w.machine, kit: w.kit.run, kitRoot: REPO, home: w.home, environment: {}, output });
    expect(code).toBe(1);
    // setupOutput writes an error with console.error in human mode only: under --json it is an event.
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "upgrade stopped at monitor: bin/deploy-monitor.sh failed (exit code 1)" });
    expect(String(events.at(-1)!.hint)).toContain("sitesolide upgrade");
  });
});
