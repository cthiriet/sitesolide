import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownManifests } from "./manifests";
import { isApp, readManifest, servicesOf, type Manifest } from "../cli/manifest";
import {
  projectPaths,
  decideUnit,
  generateUnit,
  generateUnits,
  isTimerUnit,
  readUnitAnswer,
  MARKER_ABSENT,
  MARKER_PRESENT,
  runningUnits,
  sandboxedInstallCommand,
  substitute,
  systemdRunArguments,
  systemUser,
  timerUnit,
  unitArgument,
  unitFileName,
  unitNames,
  watchedUnits,
} from "../cli/unit";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const APP: Manifest = { slug: "budget", port: 3022, start: "/usr/local/bin/bun run server.ts" };

/**
 * A unit actually in service, if there is one.
 *
 * The confinement test bears on the list below, which is the reference. A unit
 * generated from a real manifest adds a second witness to it: a manifest can
 * carry what the sample below does not, and the directives must hold there too.
 */
const WITNESS = knownManifests().find((manifest) => isApp(manifest));
const IN_SERVICE = WITNESS === undefined ? null : generateUnit(WITNESS);

const CONFINEMENT = [
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "PrivateDevices=true",
  "ProtectSystem=strict",
  "ProtectHome=true",
  "TemporaryFileSystem=/srv:ro",
  "ProtectKernelTunables=true",
  "ProtectKernelModules=true",
  "ProtectControlGroups=true",
  "RestrictNamespaces=true",
  "RestrictSUIDSGID=true",
  "RestrictRealtime=true",
  "LockPersonality=true",
  "UMask=0077",
];

describe("confinement", () => {
  test.skipIf(IN_SERVICE === null)("a unit generated from a real manifest carries the directives this test watches", () => {
    // Without this check, a directive renamed in systemd would make the list
    // below obsolete without anything saying so. It only runs where a unit has
    // already been deposited: a fresh install has none, and the list then
    // remains the only reference.
    //
    // PrivateDevices is set aside: a unit may remove it on purpose, saying
    // why, when its service needs a device.
    for (const directive of CONFINEMENT) {
      if (directive === "PrivateDevices=true") continue;
      expect(IN_SERVICE as string).toInclude(directive);
    }
  });

  test.each(CONFINEMENT)("the generated unit carries %s", (directive) => {
    expect(generateUnit(APP)).toInclude(directive);
  });

  test("the service only writes in its own data folder", () => {
    const unit = generateUnit(APP);
    const paths = projectPaths("budget");
    expect(unit).toInclude(`ReadWritePaths=${paths.dataDir}`);
    expect(unit).toInclude(`BindReadOnlyPaths=${paths.app}`);
    expect(unit).toInclude(`BindReadOnlyPaths=${paths.publicDir}`);
    expect(unit).toInclude(`BindPaths=${paths.dataDir}`);
  });

  test("does not re-expose any other project under /srv", () => {
    const unit = generateUnit(APP);
    for (const line of unit.split("\n")) {
      if (!line.startsWith("Bind")) continue;
      expect(line).toInclude("/srv/sites/budget/");
    }
  });

  test("runs under its own user, never root", () => {
    const unit = generateUnit(APP);
    expect(unit).toInclude(`User=${systemUser("budget")}`);
    expect(unit).not.toInclude("User=root");
  });
});

describe("memory", () => {
  test("MemoryMax is never left out", () => {
    // The machine has no swap: without a ceiling per service, a saturation
    // hands the whole machine over to the OOM killer instead of the culprit
    // alone.
    expect(generateUnit(APP)).toInclude("MemoryMax=256M");
  });

  test("the manifest can raise the ceiling", () => {
    expect(generateUnit({ ...APP, memory: "512M" })).toInclude("MemoryMax=512M");
  });
});

describe("network", () => {
  test("closed by default", () => {
    const unit = generateUnit(APP);
    expect(unit).toInclude("IPAddressDeny=any");
    expect(unit).toInclude("IPAddressAllow=localhost");
  });

  test("outbound lifts the network confinement, and only that", () => {
    const unit = generateUnit({ ...APP, network: "outbound" });
    expect(unit).not.toInclude("IPAddressDeny=any");
    // Everything else holds.
    for (const directive of CONFINEMENT) expect(unit).toInclude(directive);
  });
});

describe("secrets", () => {
  test("without a secret, the whole folder is closed to the service", () => {
    // Without this line, a service can list /etc/sitesolide and learn which
    // other sites have credentials.
    expect(generateUnit(APP)).toInclude("InaccessiblePaths=-/etc/sitesolide");
  });

  test("with a secret, the file is loaded and the directive removed", () => {
    const unit = generateUnit({ ...APP, secrets: ["budget.env"] });
    expect(unit).toInclude("EnvironmentFile=-/etc/sitesolide/budget.env");
    expect(unit).not.toInclude("InaccessiblePaths=-/etc/sitesolide");
  });

  test("the dash of EnvironmentFile is kept", () => {
    // Without it, a missing file makes the start fail and Restart=always makes
    // it loop. It is bin/sitesolide.ts that then refuses to restart.
    const unit = generateUnit({ ...APP, secrets: ["budget.env"] });
    expect(unit).toInclude("EnvironmentFile=-");
  });

});

describe("start-up", () => {
  test("the manifest's command is the one systemd executes", () => {
    const unit = generateUnit({ ...APP, start: ".venv/bin/python -m uvicorn app:api" });
    expect(unit).toInclude("ExecStart=.venv/bin/python -m uvicorn app:api");
  });

  test("the port and the folders arrive through the environment", () => {
    const unit = generateUnit(APP);
    expect(unit).toInclude("Environment=PORT=3022");
    expect(unit).toInclude("Environment=DATA_DIR=/srv/sites/budget/data");
    expect(unit).toInclude("Environment=PUBLIC_DIR=/srv/sites/budget/public");
  });
});

describe("declared variables and description", () => {
  test("the manifest's variables add to the three already laid", () => {
    const unit = generateUnit({ ...APP, env: { NODE_ENV: "production" } });
    expect(unit).toInclude("Environment=NODE_ENV=production");
    expect(unit).toInclude("Environment=PORT=3022");
  });

  test("the description replaces the default label", () => {
    // This is what `systemctl status` displays: without the field, a generated
    // unit would lose the little that the hand written one said.
    expect(generateUnit({ ...APP, description: "Booking tool" })).toInclude(
      "Description=Booking tool",
    );
    expect(generateUnit(APP)).toInclude("Description=Project budget");
  });
});

describe("what a manifest can no longer write into its unit", () => {
  test("a % is the percent sign itself, never a specifier systemd expands", () => {
    const unit = generateUnit({ ...APP, description: "100% %h", start: "/bin/date +%s", env: { FORMAT: "%Y-%m-%d" } });
    expect(unit).toInclude("Description=100%% %%h");
    expect(unit).toInclude("ExecStart=/bin/date +%%s");
    expect(unit).toInclude("Environment=FORMAT=%%Y-%%m-%%d");
  });

  test("a text without % comes out as it always did", () => {
    // Every unit in service: escaping must not make one of them diverge.
    for (const manifest of knownManifests().filter(isApp)) {
      for (const { text } of generateUnits(manifest)) expect(text).not.toInclude("%%");
    }
  });

  test("what validate() refuses is never written, even past validate()", () => {
    // The second barrier, for a manifest that reached the generator without
    // the validation: a start run as root, a variable set past the rules on
    // names, a directive added after a secret's name or a description.
    for (const manifest of [
      { ...APP, start: "+/bin/sh -c id" },
      { ...APP, start: "!/bin/sh -c id" },
      { ...APP, start: "/bin/app\nUser=root" },
      { ...APP, env: { NODE_ENV: "x DATA_DIR=/srv/sites/other/data" } },
      { ...APP, secrets: ["budget.env\nExecStartPre=+/bin/sh -c id"] },
      { ...APP, description: "notes\\" },
      { slug: "budget", services: { web: { start: "/bin/web", port: 3040 }, api: { start: "+/bin/api", port: 3041, routes: ["/api/*"] } } },
    ] as Manifest[]) {
      expect(() => generateUnits(manifest)).toThrow("never written into a unit");
    }
  });
});

/**
 * What `deploy` does with a project's unit, tried without a machine.
 *
 * The decision carries all the risk of the single command: `deploy` now lays
 * the unit itself, and nothing must be able to make it replace the one that
 * keeps a service running. It happened once the other way round, with a Caddy
 * fragment laid too early on 19 August 2026.
 */
describe("what deploy does with the unit", () => {
  const GENERATED = generateUnit(APP);

  test("absent from the machine: it is laid down", () => {
    expect(decideUnit({ installed: "", generated: GENERATED, replace: false })).toBe("install");
  });

  test("a file of nothing but whitespace counts as absent", () => {
    expect(decideUnit({ installed: "\n  \n", generated: GENERATED, replace: false })).toBe(
      "install",
    );
  });

  test("identical: nothing is deposited, nothing is reloaded", () => {
    // This is what makes `deploy` idempotent: the second pass touches neither
    // systemd nor the file.
    expect(
      decideUnit({ installed: GENERATED, generated: GENERATED, replace: false }),
    ).toBe("present");
  });

  test("different: reported and left in place", () => {
    // A unit in service may remove PrivateDevices on purpose, saying why: a
    // deployment that replaced it would cut off the microphone without anyone
    // having asked for it.
    const handWritten = GENERATED.replace("PrivateDevices=true\n", "");
    expect(decideUnit({ installed: handWritten, generated: GENERATED, replace: false })).toBe(
      "diverged",
    );
  });

  test("--force is the only gesture that switches to the generated one", () => {
    const handWritten = GENERATED.replace("PrivateDevices=true\n", "");
    expect(decideUnit({ installed: handWritten, generated: GENERATED, replace: true })).toBe(
      "install",
    );
  });

  test("--force on an identical unit deposits nothing again", () => {
    expect(decideUnit({ installed: GENERATED, generated: GENERATED, replace: true })).toBe(
      "present",
    );
  });
});

/**
 * The reading of the unit laid on the machine. It is through it that `deploy`
 * knows whether it is dealing with a first pass, so it decides what it
 * replaces.
 */
describe("what the machine answers about its unit", () => {
  test("the absence marker is recognised", () => {
    expect(readUnitAnswer(`${MARKER_ABSENT}\n`)).toEqual({ kind: "absent" });
  });

  test("the file comes after the marker, as it is", () => {
    const unit = generateUnit(APP);
    const reading = readUnitAnswer(`${MARKER_PRESENT}\n${unit}`);
    expect(reading).toEqual({ kind: "present", content: unit });
    // The comparison that follows is exact: one character added or removed
    // here would make an identical unit look different, at every deployment.
    if (reading.kind !== "present") return;
    expect(decideUnit({ installed: reading.content, generated: unit, replace: false })).toBe(
      "present",
    );
  });

  test("an empty output is never an absence", () => {
    // A refused sudo gives back the same emptiness as a non existent file:
    // confusing them would replace a hand written unit with the generated one,
    // silently.
    expect(readUnitAnswer("")).toEqual({ kind: "unreadable" });
    expect(readUnitAnswer("sudo: a password is required\n")).toEqual({ kind: "unreadable" });
  });

  test("an empty but present unit is not an absence", () => {
    // The marker comes first rather than in place of an empty output,
    // precisely for this case.
    expect(readUnitAnswer(`${MARKER_PRESENT}\n`)).toEqual({ kind: "present", content: "" });
  });
});

describe("placeholders", () => {
  const WITH = { slug: "budget", zone: "test-zone.invalid", contact: "me@test-zone.invalid" };

  test("each placeholder takes its value", () => {
    expect(substitute("https://{slug}.{zone}", WITH)).toBe("https://budget.test-zone.invalid");
    expect(substitute("{contact}", WITH)).toBe("me@test-zone.invalid");
  });

  test("an empty zone stays visible rather than making a wrong address", () => {
    // https://budget. would read as an address, and nothing would say it is
    // wrong; {zone} left in place says a setting is missing.
    expect(substitute("https://{slug}.{zone}", { ...WITH, zone: "" })).toBe("https://budget.{zone}");
  });

  test("an empty contact is an answer, not a gap", () => {
    // The contact is optional. Left as {contact}, the portal received a value
    // and the door page of a locked preview offered to write to "{contact}".
    expect(substitute("{contact}", { ...WITH, contact: "" })).toBe("");
  });

  test("a unit generated without a contact carries an empty variable", () => {
    const unit = generateUnit(
      { ...APP, env: { SITESOLIDE_CONTACT: "{contact}" } },
      { slug: "budget", zone: "test-zone.invalid", contact: "" },
    );
    expect(unit).toContain("Environment=SITESOLIDE_CONTACT=\n");
    expect(unit).not.toContain("{contact}");
  });
});

describe("install over SSH, in the service's walls", () => {
  const command = sandboxedInstallCommand("budget", "deploy");

  test("as the project's account, through systemd-run, with the walls the installer gives a token", () => {
    expect(command).toStartWith("sudo sh -c 'chown -hR site-budget:site-budget /srv/sites/budget/app && \"/usr/bin/systemd-run\"");
    for (const property of [
      '"-p" "User=site-budget"',
      '"-p" "NoNewPrivileges=yes"',
      '"-p" "ProtectSystem=strict"',
      '"-p" "TemporaryFileSystem=/srv:ro"',
      '"-p" "BindPaths=/srv/sites/budget/app:/srv/sites/budget/app" "-p" "ReadWritePaths=/srv/sites/budget/app"',
      '"-p" "InaccessiblePaths=-/etc/sitesolide"',
      '"-p" "IPAddressDeny=localhost"',
      '"-p" "WorkingDirectory=/srv/sites/budget/app"',
      '"-p" "RuntimeMaxSec=900"',
      '"--expand-environment=no"',
      '"-E" "HOME=/tmp"',
    ]) {
      expect(command).toContain(property);
    }
    // The same line the installer builds, word for word.
    const line = systemdRunArguments({
      slug: "budget",
      purpose: "install",
      command: ["/bin/sh", "-s"],
      stdin: null,
      binds: [{ source: "/srv/sites/budget/app", target: "/srv/sites/budget/app" }],
      workingDirectory: "/srv/sites/budget/app",
      network: true,
      timeoutS: 900,
      memory: "1G",
    });
    expect(command).toContain(line.map((argument) => `"${argument}"`).join(" "));
  });

  test("the install command is never in it: it travels on standard input, to sh -s", () => {
    expect(command).toContain('"/bin/sh" "-s";');
  });

  test("app/ goes back to the deployment account whatever the install's outcome, links never followed", () => {
    expect(command).toEndWith("; code=$?; chown -hR deploy:deploy /srv/sites/budget/app; exit $code'");
  });

  test("the shell runs it as written: against a fake sudo, chown and systemd-run, an install that fails", () => {
    const root = mkdtempSync(join(tmpdir(), "sitesolide-install-"));
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "bin", "sudo"), `#!/bin/sh\nexec "$@"\n`, { mode: 0o755 });
      writeFileSync(join(root, "bin", "chown"), `#!/bin/sh\necho "chown $*" >> "${root}/calls"\n`, { mode: 0o755 });
      // systemd-run stands for itself: it runs the script it reads on
      // standard input, then fails the way a failing install does.
      const fake = join(root, "systemd-run");
      writeFileSync(fake, `#!/bin/sh\nsh -s >> "${root}/calls"\nexit 3\n`, { mode: 0o755 });
      const script = command.replace(/^sudo sh -c '/, "").replace(/'$/, "").replace('"/usr/bin/systemd-run"', `"${fake}"`);
      const proc = Bun.spawnSync(["sh", "-c", script], { stdin: new TextEncoder().encode("echo installed\n"), env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` } });
      expect(proc.exitCode).toBe(3);
      expect(readFileSync(join(root, "calls"), "utf8").split("\n").filter((line) => line !== "")).toEqual([
        "chown -hR site-budget:site-budget /srv/sites/budget/app",
        "installed",
        "chown -hR deploy:deploy /srv/sites/budget/app",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an account or a slug that could leave the quotes", () => {
    expect(() => sandboxedInstallCommand("budget", "deploy'; reboot")).toThrow();
    expect(() => sandboxedInstallCommand("budget; reboot", "deploy")).toThrow();
  });
});

describe("workers, scheduled services and their timers", () => {
  const PLACEHOLDERS = { slug: "lab", zone: "test-zone.invalid", contact: "" };
  /** A front, a sync every quarter of an hour, and a queue consumer, written in that order. */
  const MIXED: Manifest = {
    slug: "lab",
    services: {
      web: { start: "/srv/sites/lab/app/web", port: 3050 },
      sync: { start: "/srv/sites/lab/app/sync", schedule: "*:0/15", timeout: "15m" },
      queue: { start: "/srv/sites/lab/app/queue", internal: true, cpu: "50%" },
    },
  };
  /** Every service scheduled: the main unit is an anchor. */
  const ANCHORED: Manifest = {
    slug: "lab",
    services: {
      report: { start: "/srv/sites/lab/app/report", schedule: "daily" },
      cleanup: { start: "/srv/sites/lab/app/cleanup", schedule: "Sun 03:00" },
    },
  };
  const units = generateUnits(MIXED, PLACEHOLDERS);
  const text = (unit: string): string => units.find((generated) => generated.unit === unit)!.text;

  test("main first, then each other service, a scheduled one followed by its timer", () => {
    expect(units.map((generated) => generated.unit)).toEqual(["lab", "lab.sync", "lab.sync.timer", "lab.queue"]);
    expect(unitNames(MIXED)).toEqual(["lab", "lab.sync", "lab.sync.timer", "lab.queue"]);
  });

  test("the main unit wants the timer, never the scheduled service, and starts after what runs for good alone", () => {
    expect(text("lab")).toInclude("\nWants=lab.sync.timer lab.queue.service\n");
    expect(text("lab")).toInclude("\nAfter=lab.queue.service\n");
    expect(text("lab")).not.toInclude("lab.sync.service");
    expect(text("lab")).toInclude("[Install]\nWantedBy=multi-user.target");
    // A server keeps the machine's defaults, line for line.
    expect(text("lab")).toInclude("Type=simple\n");
    expect(text("lab")).toInclude("\nRestart=always\nRestartSec=2\n\n");
    expect(text("lab")).not.toMatch(/^(CPUWeight|TasksMax|CPUQuota|StartLimitIntervalSec)=/m);
  });

  test("a worker: no port, restarted for good with a growing delay, and yielding the processor to the sites", () => {
    const queue = text("lab.queue");
    expect(queue).not.toInclude("PORT=");
    expect(queue).toInclude("Environment=DATA_DIR=/srv/sites/lab/data\n");
    expect(queue).toInclude("PartOf=lab.service\n");
    expect(queue).toMatch(/\[Unit\][^[]*\nStartLimitIntervalSec=0\n/);
    expect(queue).toInclude("Type=simple\n");
    expect(queue).toInclude("\nRestart=always\nRestartSec=2\nRestartSteps=8\nRestartMaxDelaySec=5min\n");
    expect(queue).toInclude("\nCPUWeight=20\nTasksMax=512\nCPUQuota=50%\n");
    expect(queue).not.toMatch(/^\[Install\]$/m);
    expect(queue).toInclude("IPAddressDeny=any");
  });

  test("a scheduled service: started by its timer, run to its end, never restarted, stopped past its timeout", () => {
    const sync = text("lab.sync");
    expect(sync).not.toInclude("PORT=");
    expect(sync).toInclude("PartOf=lab.service\n");
    expect(sync).toInclude("# Started by its timer, and stopped or restarted with the project's main unit.\n");
    expect(sync).toInclude("Type=exec\n");
    expect(sync).toInclude("\nRestart=no\nRuntimeMaxSec=15m\n");
    expect(sync).not.toInclude("Restart=always");
    expect(sync).toInclude("\nCPUWeight=20\nTasksMax=512\n");
    expect(sync).not.toInclude("CPUQuota");
    expect(sync).not.toInclude("StartLimitIntervalSec");
    expect(sync).not.toMatch(/^\[Install\]$/m);
    expect(sync).toInclude("# No [Install]: started by its timer.");
    expect(sync).toInclude("ExecStart=/srv/sites/lab/app/sync\n");
    // An hour unless the service says otherwise.
    const plain = generateUnits({ slug: "lab", services: { web: { start: "/x", port: 3050 }, sync: { start: "/y", schedule: "hourly" } } }, PLACEHOLDERS);
    expect(plain[1]!.text).toInclude("\nRuntimeMaxSec=1h\n");
  });

  test("its timer: the schedule as written, a missed run made up at boot, on time to the second, and nothing else", () => {
    expect(text("lab.sync.timer")).toBe(
      [
        "# Timer of project lab, generated by bin/sitesolide.ts from its",
        "# sitesolide.json. Do not edit by hand: the next deployment overwrites it.",
        "",
        "[Unit]",
        "Description=Project lab, schedule of service sync",
        "# Started by the project's main unit, and stopped or restarted with it.",
        "PartOf=lab.service",
        "",
        "[Timer]",
        "OnCalendar=*:0/15",
        "Persistent=true",
        "AccuracySec=1s",
        "",
      ].join("\n"),
    );
  });

  test("every service scheduled: the main unit is an anchor that runs nothing, as the project's account, and wants the timers", () => {
    const anchored = generateUnits(ANCHORED, PLACEHOLDERS);
    expect(anchored.map((generated) => generated.unit)).toEqual(["lab", "lab.report", "lab.report.timer", "lab.cleanup", "lab.cleanup.timer"]);
    const anchor = anchored[0]!.text;
    expect(anchor).toInclude("generated by bin/sitesolide.ts");
    expect(anchor).toInclude("\nWants=lab.report.timer lab.cleanup.timer\n");
    expect(anchor).not.toInclude("After=");
    for (const line of ["Type=oneshot", "RemainAfterExit=yes", "ExecStart=/bin/true", "User=site-lab", "Group=site-lab", "WorkingDirectory=/srv/sites/lab/app", "PrivateNetwork=true", "NoNewPrivileges=true"]) {
      expect(anchor).toInclude(`\n${line}\n`);
    }
    expect(anchor).toInclude("[Install]\nWantedBy=multi-user.target\n");
    expect(generateUnit(ANCHORED, PLACEHOLDERS)).toBe(anchor);
    for (const { unit, text: secondary } of anchored.slice(1)) {
      expect({ unit, partOf: secondary.includes("\nPartOf=lab.service\n") }).toEqual({ unit, partOf: true });
    }
  });

  test("what deploy restarts, and what it watches after the restart", () => {
    expect(runningUnits(MIXED)).toEqual(["lab", "lab.sync.timer", "lab.queue"]);
    expect(watchedUnits(MIXED)).toEqual(["lab", "lab.queue"]);
    expect(unitNames(ANCHORED)).toEqual(["lab", "lab.report", "lab.report.timer", "lab.cleanup", "lab.cleanup.timer"]);
    expect(runningUnits(ANCHORED)).toEqual(["lab", "lab.report.timer", "lab.cleanup.timer"]);
    // The anchor runs nothing, a timer neither: nothing to watch.
    expect(watchedUnits(ANCHORED)).toEqual([]);
    // A project of servers alone: every unit, as before.
    expect(unitNames(APP)).toEqual(["budget"]);
    expect(runningUnits(APP)).toEqual(["budget"]);
    expect(watchedUnits(APP)).toEqual(["budget"]);
    expect(unitNames({ slug: "notes", publicDir: "dist" })).toEqual([]);
  });

  test("a timer is named with its suffix, a service without, and each is given to systemctl and laid in its file", () => {
    expect(isTimerUnit("lab.sync.timer")).toBe(true);
    expect(isTimerUnit("lab.sync")).toBe(false);
    expect(isTimerUnit("lab")).toBe(false);
    expect(timerUnit(servicesOf(MIXED)[1]!)).toBe("lab.sync.timer");
    expect(unitArgument("lab")).toBe("lab");
    expect(unitArgument("lab.sync")).toBe("lab.sync.service");
    expect(unitArgument("lab.sync.timer")).toBe("lab.sync.timer");
    expect(unitFileName("lab")).toBe("lab.service");
    expect(unitFileName("lab.sync")).toBe("lab.sync.service");
    expect(unitFileName("lab.sync.timer")).toBe("lab.sync.timer");
  });

  test("cpu caps a server too, which keeps every other default", () => {
    const capped = generateUnit({ ...APP, cpu: "150%" }, { slug: "budget", zone: "test-zone.invalid", contact: "" });
    expect(capped).toInclude("\nMemoryMax=256M\nCPUQuota=150%\n");
    expect(capped).not.toInclude("CPUWeight");
    expect(capped).toInclude("Environment=PORT=3022\n");
  });

  test("a schedule, a timeout or a cpu validate() refuses is never written, even past validate()", () => {
    const broken = (service: Record<string, unknown>): Manifest => ({ slug: "lab", services: { web: { start: "/x", port: 3050 }, sync: { start: "/y", ...service } } as Manifest["services"] });
    expect(() => generateUnits(broken({ schedule: "daily\nExecStartPre=/bin/sh" }), PLACEHOLDERS)).toThrow(/never written/);
    expect(() => generateUnits(broken({ schedule: "daily", timeout: "infinity" }), PLACEHOLDERS)).toThrow(/never written/);
    expect(() => generateUnits(broken({ internal: true, cpu: "50%\nUser=root" }), PLACEHOLDERS)).toThrow(/never written/);
  });

  test("a slug, a service name or a memory validate() refuses is never written into a unit, even past validate()", () => {
    // The same second barrier as above, for the three fields that still name
    // or bound the unit itself and reach it unescaped: a `\n` in any of them
    // adds a directive systemd obeys as root, `User=root` the worst of them.
    // The anchor and the secondary units embed the slug and the service names
    // too, so a project of scheduled services alone must refuse them as well.
    const unit = { slug: "lab", start: "/usr/local/bin/bun x", port: 3050 } as Manifest;
    expect(() => generateUnits({ ...unit, slug: "lab\nUser=root" }, PLACEHOLDERS)).toThrow(/never written/);
    expect(() => generateUnits({ ...unit, memory: "256M\nUser=root" }, PLACEHOLDERS)).toThrow(/never written/);
    const named = (name: string, extra: Record<string, unknown> = {}): Manifest => ({ slug: "lab", services: { [name]: { start: "/x", port: 3050, ...extra } } } as Manifest);
    expect(() => generateUnits(named("web\nUser=root"), PLACEHOLDERS)).toThrow(/never written/);
    expect(() => generateUnits(named("web", { memory: "256M\nExecStartPre=+/bin/sh" }), PLACEHOLDERS)).toThrow(/never written/);
    // All scheduled: the anchor's Wants= would otherwise carry the bad name.
    const anchored: Manifest = { slug: "lab", services: { "sync\nUser=root": { start: "/x", schedule: "daily" } } } as Manifest;
    expect(() => generateUnits(anchored, PLACEHOLDERS)).toThrow(/never written/);
  });
});

describe("the units of servers, as they were before workers existed", () => {
  /**
   * A server's unit is byte for byte what the generator wrote before workers
   * and scheduled services: a single byte of difference would make every unit
   * in service read as diverged, and each project's next deployment refuse
   * without --force. The fingerprints below were taken from the e2e fixtures
   * with the generator of the release before them; a change here is a change
   * to every unit on every machine, to be made on purpose.
   */
  const FINGERPRINTS: Record<string, Record<string, string>> = {
    "bun-mixed": { "sample-bun": "add7fdc8d713e6954cf1e1456d63ff2a5a97b8f49c80149a9eac2a450900ca46" },
    "multi-service": {
      "sample-lab": "6a9b54567d9bebc3fd3db56dcdd8c4ae5604e3613f6f8f26ba3b54abadae9786",
      "sample-lab.api": "fc6ce37f51ecccbcc4b4e26ac891a10bbbc96d9d4fef00e736990dfc405cc9ee",
      "sample-lab.worker": "faca45fbdecdeecdf51d9d6c608bab2972966ecd14abbc294188dbc9435a6aef",
    },
  };

  test.each(Object.keys(FINGERPRINTS))("projects/%s generates the same units, to the byte", (fixture) => {
    const { manifest } = readManifest(readFileSync(join(REPO_ROOT, "bin", "tests", "e2e", "projects", fixture, "sitesolide.json"), "utf8"));
    const generated = generateUnits(manifest!, { slug: manifest!.slug, zone: "test-zone.invalid", contact: "sample@test-zone.invalid" });
    const fingerprints = Object.fromEntries(generated.map(({ unit, text }) => [unit, new Bun.CryptoHasher("sha256").update(text).digest("hex")]));
    expect(fingerprints).toEqual(FINGERPRINTS[fixture]!);
  });
});
