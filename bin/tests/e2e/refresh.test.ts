import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utcTime } from "../../cli/caddy-lock";
import { DEFAULT_HINT, REMOTE_HINTS } from "../../cli/hints";
import type { Manifest } from "../../cli/manifest";
import { earlierGenerations, generateUnits, unitFileName } from "../../cli/unit";
import { createFakeVm, type FakeVm } from "./fake-vm";
import { CLI, TEST_EMAIL, TEST_ZONE, type Result } from "./run";

/**
 * `sitesolide refresh`, the real CLI, in front of the fake machine of
 * fake-vm.ts: a deployed project's units generated again from the manifest
 * the machine carries, and nothing else sent, no code, no manifest, no Caddy
 * block.
 *
 * The machine is the fake's tree: the manifests and the units each test lays
 * under /srv/sites and /etc/systemd/system. A write is accepted only where a
 * test says so, and then logged without running anything, except a unit's,
 * which `keepUnits` lays in the tree as the machine would, so that the next
 * run reads it back. The CLI's zone resolves nowhere: a refresh that restarts
 * a service goes on to the same HTTPS check as deploy, and stops there, as a
 * deployment in front of this machine does. The decisions themselves are
 * tried in bin/tests/cli-refresh.test.ts.
 */

const FOLDERS: string[] = [];
let vm: FakeVm | null = null;

afterEach(() => {
  vm?.resume();
  vm?.cleanup();
  vm = null;
  for (const folder of FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  FOLDERS.push(made);
  return made;
}

function machine(): FakeVm {
  vm = createFakeVm();
  return vm;
}

/**
 * A workstation whose configuration gives the zone and the contact address,
 * read from nowhere else: the server comes from the fake machine's
 * environment, and the test runner's own SITESOLIDE_* are left out.
 */
function workstation(): Record<string, string> {
  const home = folder("refresh-home-");
  mkdirSync(join(home, "config"));
  writeFileSync(join(home, "config", "config.json"), JSON.stringify({ zone: TEST_ZONE, email: TEST_EMAIL, contact: TEST_EMAIL }));
  return { HOME: home, SITESOLIDE_CONFIG_DIR: join(home, "config") };
}

/** `sitesolide refresh ...`, from a folder that holds no project: refresh needs none. */
function refreshProc(on: FakeVm, arguments_: string[], extra: Record<string, string> = {}) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("SITESOLIDE_")) environment[key] = value;
  }
  return Bun.spawn(["bun", CLI, "refresh", ...arguments_], {
    cwd: folder("refresh-cwd-"),
    env: { ...environment, ...workstation(), ...on.env, ...extra },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function finished(proc: ReturnType<typeof refreshProc>): Promise<Result> {
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, output, error, all: `${output}\n${error}` };
}

function refresh(on: FakeVm, arguments_: string[], extra: Record<string, string> = {}): Promise<Result> {
  return finished(refreshProc(on, arguments_, extra));
}

/** Every line of standard output is one event. */
function events(r: Result): Record<string, unknown>[] {
  return r.output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`not an event on standard output: ${line}`);
      }
    });
}

const TYPES = ["step", "info", "planned", "warning", "output", "file", "result", "error"];

/** A run's events are all known, and exactly the last one ends it. */
function ended(r: Result, type: "result" | "error"): Record<string, unknown> {
  const list = events(r);
  for (const event of list) expect(TYPES).toContain(event.type as string);
  expect(list.filter((event) => event.type === "result" || event.type === "error")).toHaveLength(1);
  const last = list.at(-1)!;
  expect(last.type).toBe(type);
  return last;
}

function app(slug: string, port: number, more: Partial<Manifest> = {}): Manifest {
  // `{contact}` and `{zone}`: the placeholders deploy replaces, from the configuration.
  return { slug, start: "/usr/local/bin/bun run server.ts", port, env: { CONTACT: "{contact}", ORIGIN: "https://{slug}.{zone}" }, ...more };
}

/** The units deploy generates for this manifest, with the configuration's zone and contact. */
function generated(manifest: Manifest): { unit: string; text: string }[] {
  return generateUnits(manifest, { slug: manifest.slug, zone: TEST_ZONE, contact: TEST_EMAIL });
}

/**
 * How a unit stands on the machine: the current generation, the one every
 * release before the port rules wrote (neither those nor the system-call
 * filter), one edited by hand, which drops a directive the manifest cannot
 * drop, or none.
 */
type Installed = "current" | "previous" | "edited" | "missing";

function asInstalled(text: string, how: Installed): string | null {
  switch (how) {
    case "current":
      return text;
    case "previous":
      return earlierGenerations(text).at(-1)!;
    case "edited":
      return text.replace("PrivateDevices=true\n", "");
    case "missing":
      return null;
  }
}

/** A project deployed on the machine: its manifest, and each unit as `how` says, the first one for the main unit. */
function lay(on: FakeVm, manifest: Manifest, how: Installed | Installed[] = "current"): void {
  on.writeManifest(manifest.slug, `${JSON.stringify(manifest, null, 2)}\n`);
  generated(manifest).forEach(({ unit, text }, i) => {
    const state = Array.isArray(how) ? (how[i] ?? "current") : how;
    const installed = asInstalled(text, state);
    if (installed !== null) on.writeFile(`/etc/systemd/system/${unitFileName(unit)}`, installed);
  });
}

function unitOnMachine(on: FakeVm, unit: string): string {
  return readFileSync(join(on.root, "etc", "systemd", "system", unitFileName(unit)), "utf8");
}

const accepted = (on: FakeVm): string[] => on.logs().filter((line) => line.startsWith("ACCEPTED"));

const SAMPLE = app("sample-refresh", 3061);
const UNIT_PATH = "/etc/systemd/system/sample-refresh.service";
const INSTALL = `ACCEPTED sudo install -m 644 -o root -g root /dev/stdin ${UNIT_PATH}`;
const RELOAD = "ACCEPTED sudo systemctl daemon-reload && sudo systemctl enable sample-refresh";
const RESTART = "ACCEPTED sudo systemctl reset-failed sample-refresh 2>/dev/null; sudo systemctl restart sample-refresh && systemctl is-active sample-refresh";

describe("sitesolide refresh <slug>", () => {
  test("a unit of the previous generation: the current one written, systemd reloaded, the service restarted, nothing else sent", async () => {
    const on = machine();
    on.acceptWrites();
    on.keepUnits();
    lay(on, SAMPLE, "previous");
    const r = await refresh(on, ["sample-refresh"]);
    // The HTTPS check aims at a zone that resolves nowhere: past the restart,
    // the run stops there, as a deployment in front of this machine does.
    expect(r.code).toBe(1);
    expect(r.error).toContain("refresh stopped at sample-refresh: https://sample-refresh.test-zone.invalid/ unreachable");
    expect(r.error).toContain(`written for sample-refresh: ${UNIT_PATH}`);
    // The unit shown before it is written, with what the earlier one lacked.
    expect(r.output).toContain("--- sample-refresh.service ---");
    expect(r.output).toContain("SystemCallFilter=@system-service");
    expect(r.output).toContain("SocketBindAllow=tcp:3061");

    // Three writes, and nothing else: no code, no manifest, no Caddy block.
    expect(accepted(on)).toEqual([INSTALL, RELOAD, RESTART]);
    const logs = on.logs();
    expect(logs.filter((line) => line.includes("rsync"))).toEqual([]);
    expect(logs.filter((line) => /^(BLOCK|BLOCKS|FINGERPRINT|CONNECT|UNIT_ENV|LOOPBACK|REFUSED)\b/.test(line))).toEqual([]);

    // The lock is taken before the reading that decides, and given back once
    // the services are restarted; the unit is written under it.
    const taken = logs.indexOf("LOCK take refresh");
    const released = logs.indexOf("LOCK release refresh");
    expect(taken).toBeGreaterThan(-1);
    expect(logs.indexOf("READ sample-refresh")).toBeLessThan(taken);
    expect(taken).toBeLessThan(logs.lastIndexOf("READ sample-refresh"));
    expect(logs.lastIndexOf("READ sample-refresh")).toBeLessThan(logs.indexOf(INSTALL));
    expect(logs.indexOf(RESTART)).toBeLessThan(released);
    expect(on.lock()).toBeNull();

    // On the machine, the unit deploy would write today.
    expect(unitOnMachine(on, "sample-refresh")).toBe(generated(SAMPLE)[0]!.text);

    // Run again: current, nothing written, nothing restarted, no lock.
    const before = on.logs().length;
    const again = await refresh(on, ["sample-refresh", "--json"]);
    expect(again.code).toBe(0);
    expect(ended(again, "result")).toMatchObject({ command: "refresh", refreshed: [], current: ["sample-refresh"] });
    const since = on.logs().slice(before);
    expect(since.filter((line) => line.startsWith("ACCEPTED") || line.startsWith("LOCK"))).toEqual([]);
  });

  test("a current unit: nothing written, nothing restarted, no lock taken", async () => {
    const on = machine();
    on.acceptWrites();
    lay(on, SAMPLE, "current");
    const r = await refresh(on, ["sample-refresh"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(`unchanged  ${UNIT_PATH}`);
    expect(r.output).toContain("-> nothing was written");
    expect(r.output).toContain("already current: sample-refresh");
    expect(accepted(on)).toEqual([]);
    expect(on.logs().filter((line) => line.startsWith("LOCK"))).toEqual([]);
  });

  test("a unit edited by hand is kept, and said, and nothing is restarted", async () => {
    const on = machine();
    on.acceptWrites();
    lay(on, SAMPLE, "edited");
    const r = await refresh(on, ["sample-refresh", "--json"]);
    expect(r.code).toBe(0);
    const result = ended(r, "result");
    expect(result).toMatchObject({ command: "refresh", dryRun: false, all: false, refreshed: [], kept: ["sample-refresh"] });
    expect(result.projects).toEqual([
      expect.objectContaining({ slug: "sample-refresh", state: "kept", write: [], current: [], kept: [UNIT_PATH] }),
    ]);
    expect(r.output).toContain(`differs    ${UNIT_PATH}, edited by hand: left as it is`);
    expect(accepted(on)).toEqual([]);
    expect(on.logs().filter((line) => line.startsWith("LOCK"))).toEqual([]);
    expect(unitOnMachine(on, "sample-refresh")).toBe(asInstalled(generated(SAMPLE)[0]!.text, "edited")!);
  });

  test("a manifest on the server that does not read, or that this release refuses: refused, nothing changed", async () => {
    for (const raw of ["{ not json\n", `${JSON.stringify({ ...SAMPLE, port: 80 })}\n`]) {
      const on = machine();
      on.acceptWrites();
      lay(on, SAMPLE, "previous");
      on.writeManifest("sample-refresh", raw);
      const r = await refresh(on, ["sample-refresh", "--json"]);
      expect(r.code).toBe(1);
      const error = ended(r, "error");
      expect(error.message).toBe("sample-refresh's manifest on the server does not read: nothing was changed for it");
      expect(String((error.details as string[]).join("\n"))).toMatch(raw.startsWith("{ not") ? /unreadable/ : /port/);
      expect(error.hint).not.toBe(DEFAULT_HINT);
      expect(String(error.hint)).toContain("sitesolide deploy");
      // Not even its units were read.
      expect(on.logs().filter((line) => line.startsWith("FILE /etc/systemd"))).toEqual([]);
      expect(accepted(on)).toEqual([]);
      on.cleanup();
    }
  });

  test("a project the server does not carry is refused, and a static one has nothing to refresh", async () => {
    const on = machine();
    on.acceptWrites();
    const missing = await refresh(on, ["sample-refresh", "--json"]);
    expect(missing.code).toBe(1);
    const error = ended(missing, "error");
    expect(error.message).toBe("sample-refresh is not deployed on the server");
    expect(String(error.hint)).toContain("sitesolide status");

    on.writeManifest("sample-static", `${JSON.stringify({ slug: "sample-static", publicDir: "public" })}\n`);
    const isStatic = await refresh(on, ["sample-static", "--json"]);
    expect(isStatic.code).toBe(0);
    expect(ended(isStatic, "result")).toMatchObject({ static: ["sample-static"], refreshed: [] });
    expect(on.logs().filter((line) => line.startsWith("FILE /etc/systemd"))).toEqual([]);
    expect(accepted(on)).toEqual([]);
  });

  test("several units: only the earlier generation's are written, every running unit restarted, never a scheduled service", async () => {
    const on = machine();
    on.acceptWrites();
    const MIXED: Manifest = {
      slug: "sample-mixed",
      services: { web: { start: "/usr/local/bin/bun run server.ts", port: 3062 }, sync: { start: "/usr/local/bin/bun run sync.ts", schedule: "hourly" } },
    };
    // The main unit current, the scheduled service's of the previous generation, its timer current.
    lay(on, MIXED, ["current", "previous", "current"]);
    const r = await refresh(on, ["sample-mixed"]);
    expect(r.error).toContain("refresh stopped at sample-mixed: https://sample-mixed.test-zone.invalid/ unreachable");
    expect(accepted(on)).toEqual([
      "ACCEPTED sudo install -m 644 -o root -g root /dev/stdin /etc/systemd/system/sample-mixed.sync.service",
      "ACCEPTED sudo systemctl daemon-reload && sudo systemctl enable sample-mixed",
      "ACCEPTED sudo systemctl reset-failed sample-mixed sample-mixed.sync.timer 2>/dev/null; sudo systemctl restart sample-mixed sample-mixed.sync.timer && systemctl is-active sample-mixed sample-mixed.sync.timer",
    ]);
  });

  test("a main unit edited by hand, in a project of several: none of its units is written", async () => {
    const on = machine();
    on.acceptWrites();
    const MIXED: Manifest = {
      slug: "sample-mixed",
      services: { web: { start: "/usr/local/bin/bun run server.ts", port: 3062 }, sync: { start: "/usr/local/bin/bun run sync.ts", schedule: "hourly" } },
    };
    lay(on, MIXED, ["edited", "previous", "current"]);
    const r = await refresh(on, ["sample-mixed", "--json"]);
    expect(r.code).toBe(0);
    expect(ended(r, "result")).toMatchObject({ kept: ["sample-mixed"], refreshed: [] });
    expect(r.output).toContain("starts the project's other units: none of them is written");
    expect(accepted(on)).toEqual([]);
  });

  test("held by the gatekeeper: refused before anything is written, its lock left in place", async () => {
    const on = machine();
    on.acceptWrites();
    lay(on, SAMPLE, "previous");
    const since = Date.now();
    on.setLock(`gatekeeper 4242 ${since}`);
    const r = await refresh(on, ["sample-refresh", "--json"]);
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toBe(`refresh stopped at sample-refresh: a portal change from the dashboard is in progress (since ${utcTime(since)}): try again in a moment`);
    expect(error.details).toContain("nothing was written for sample-refresh");
    expect(String(error.hint)).toContain("wait a minute");
    expect(accepted(on)).toEqual([]);
    expect(on.lock()).toBe(`gatekeeper 4242 ${since}`);
  });

  test("the manifest changed on the server before the lock: nothing written, the lock given back", async () => {
    const on = machine();
    on.acceptWrites();
    lay(on, SAMPLE, "previous");
    on.pause("LOCK take refresh");
    const proc = refreshProc(on, ["sample-refresh"]);
    const deadline = Date.now() + 15_000;
    while (!on.logs().includes("PAUSE LOCK take refresh") && Date.now() < deadline) await Bun.sleep(25);
    // A deployment from elsewhere deposits its manifest meanwhile.
    on.writeManifest("sample-refresh", `${JSON.stringify({ ...SAMPLE, description: "deployed meanwhile" }, null, 2)}\n`);
    on.resume();
    const r = await finished(proc);
    expect(r.code).toBe(1);
    expect(r.error).toContain("refresh stopped at sample-refresh: sample-refresh changed on the server during this refresh: run sitesolide refresh again");
    expect(accepted(on)).toEqual([]);
    expect(on.logs().at(-1)).toBe("LOCK release refresh");
    expect(on.lock()).toBeNull();
  }, 30_000);
});

describe("refresh and the store of secrets", () => {
  test("the store's folders laid before any unit, and for a current project too: a files/ folder deleted by hand comes back", async () => {
    const on = machine();
    on.acceptWrites();
    on.keepUnits();
    lay(on, SAMPLE, "previous");
    await refresh(on, ["sample-refresh"]);
    const logs = on.logs();
    expect(logs.indexOf("STORE-PREPARE sample-refresh")).toBeGreaterThan(-1);
    expect(logs.indexOf("STORE-PREPARE sample-refresh")).toBeLessThan(logs.indexOf(INSTALL));
    const files = join(on.root, "etc", "sitesolide", "projects", "sample-refresh", "files");
    expect(existsSync(files)).toBe(true);
    // Deleted by hand: every unit of the project would fail with 243. A
    // refresh of a project whose units are current lays it back, and
    // writes and restarts nothing else.
    rmSync(files, { recursive: true });
    const before = on.logs().length;
    const again = await refresh(on, ["sample-refresh", "--json"]);
    expect(again.code).toBe(0);
    expect(ended(again, "result")).toMatchObject({ current: ["sample-refresh"], refreshed: [] });
    expect(existsSync(files)).toBe(true);
    expect(on.logs().slice(before).filter((line) => /^(ACCEPTED|LOCK)/.test(line))).toEqual([]);
    expect(on.logs().slice(before)).toContain("STORE-PREPARE sample-refresh");
  });

  test("a store folder that is a link refuses the project before any unit is written", async () => {
    const on = machine();
    on.acceptWrites();
    on.refuseStorePrepare();
    lay(on, SAMPLE, "previous");
    const r = await refresh(on, ["sample-refresh", "--json"]);
    expect(r.code).toBe(1);
    expect(ended(r, "error")).toMatchObject({ message: "sample-refresh's store of secrets cannot be laid, which its units load: nothing was changed for it" });
    expect(accepted(on)).toEqual([]);
  });

  test("a legacy secret file the project may not read refuses it before any unit is written, as deploy refuses it", async () => {
    const on = machine();
    on.acceptWrites();
    lay(on, app("sample-refresh", 3061, { secrets: ["dashboard-backup.env"] }), "previous");
    const r = await refresh(on, ["sample-refresh", "--json"]);
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toBe("sample-refresh declares a secret file that is not its own, which its units would read as root: nothing was changed for it");
    expect((error.details as string[]).join(" ")).toContain("dashboard-backup.env belongs to the machine");
    expect(accepted(on)).toEqual([]);
    expect(on.logs().filter((line) => line.startsWith("STORE-PREPARE"))).toEqual([]);
  });

  test("after the restart, what the store lacks is warned of, never asked for", async () => {
    const on = machine();
    on.acceptWrites();
    on.keepUnits();
    lay(on, app("sample-refresh", 3061, { secrets: ["SESSION_SECRET"] }), "previous");
    const r = await refresh(on, ["sample-refresh", "--json"]);
    const warning = events(r).find((event) => event.type === "warning" && String(event.message).startsWith("runtime secrets not set"));
    expect(warning).toMatchObject({ message: "runtime secrets not set on the server: SESSION_SECRET" });
    const logs = on.logs();
    expect(logs.indexOf("STORE GET sample-refresh")).toBeGreaterThan(logs.indexOf(RESTART));
    expect(logs.filter((line) => line.startsWith("STORE ") && !line.startsWith("STORE GET"))).toEqual([]);
  });

  test("a manifest that names its variables over a unit that reads a legacy file: the unit is kept, nothing written nor restarted", async () => {
    const on = machine();
    on.acceptWrites();
    // The bench's case: the deposited manifest names its variables, the unit
    // in service is the one 0.7 made from the old form, which reads the file.
    const old = app("sample-refresh", 3061, { secrets: ["sample-refresh.env"] });
    on.writeManifest("sample-refresh", `${JSON.stringify(app("sample-refresh", 3061, { secrets: ["EARLY_KEY"] }), null, 2)}\n`);
    on.writeFile(UNIT_PATH, asInstalled(generated(old)[0]!.text, "previous")!);
    const r = await refresh(on, ["sample-refresh", "--json"]);
    expect(r.code).toBe(0);
    expect(ended(r, "result")).toMatchObject({ kept: ["sample-refresh"], refreshed: [] });
    expect(accepted(on)).toEqual([]);
    expect(readFileSync(join(on.root, UNIT_PATH.slice(1)), "utf8")).toContain("EnvironmentFile=-/etc/sitesolide/sample-refresh.env");
  });

  test("--dry-run says it would lay them, and asks nothing", async () => {
    const on = machine();
    lay(on, SAMPLE, "previous");
    const r = await refresh(on, ["sample-refresh", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("[dry-run] lay /etc/sitesolide/projects/sample-refresh/ and its files/ folder, root's, 0700, which every unit of sample-refresh loads");
    expect(on.logs().filter((line) => /^(STORE|ACCEPTED|REFUSED)/.test(line))).toEqual([]);
  });
});

describe("sitesolide refresh --all", () => {
  /** Six projects, in the order refresh takes them: current, edited, unreadable, static, then two of the previous generation. */
  function sixProjects(on: FakeVm): void {
    lay(on, app("alpha", 3061), "current");
    lay(on, app("bravo", 3062), "edited");
    on.writeManifest("charlie", `${JSON.stringify({ ...app("charlie", 3063), colour: "blue" })}\n`);
    on.writeManifest("delta", `${JSON.stringify({ slug: "delta", publicDir: "public" })}\n`);
    lay(on, app("echo", 3065), "previous");
    lay(on, app("foxtrot", 3066), "previous");
  }

  test("one project at a time, in order, stopping at the first that fails, with what it did and left in the refusal", async () => {
    const on = machine();
    on.acceptWrites();
    on.keepUnits();
    sixProjects(on);
    const r = await refresh(on, ["--all", "--json"]);
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(String(error.message)).toStartWith("refresh stopped at echo: https://echo.test-zone.invalid/ unreachable");
    expect(error.details).toEqual(
      expect.arrayContaining([
        "written for echo: /etc/systemd/system/echo.service",
        "refreshed before it: none",
        "already current: alpha",
        "kept, edited by hand: bravo",
        "refused, nothing changed: charlie",
        "static, no unit to refresh: delta",
        "not reached, left as they are: foxtrot",
      ]),
    );
    expect(String(error.hint)).toContain("sitesolide logs");
    expect(String(error.hint)).not.toContain("--force");

    // The unreadable manifest said why, as a warning, and the run went on.
    const warnings = events(r).filter((event) => event.type === "warning");
    expect(warnings).toEqual([expect.objectContaining({ message: "charlie's manifest on the server does not read: nothing was changed for it" })]);

    // Every unit read in order, foxtrot's never; echo's alone written.
    const logs = on.logs();
    const reads = logs.filter((line) => line.startsWith("FILE /etc/systemd/system/"));
    expect(reads[0]).toBe("FILE /etc/systemd/system/alpha.service");
    expect(reads[1]).toBe("FILE /etc/systemd/system/bravo.service");
    expect(reads.slice(2).every((line) => line === "FILE /etc/systemd/system/echo.service")).toBe(true);
    expect(accepted(on).filter((line) => line.includes("install"))).toEqual(["ACCEPTED sudo install -m 644 -o root -g root /dev/stdin /etc/systemd/system/echo.service"]);
    expect(logs.some((line) => line.includes("foxtrot") && line !== "READ *")).toBe(false);
    expect(unitOnMachine(on, "foxtrot")).toBe(asInstalled(generated(app("foxtrot", 3066))[0]!.text, "previous")!);
    expect(on.lock()).toBeNull();
  });

  test("with nothing to write, the run ends with the summary", async () => {
    const on = machine();
    on.acceptWrites();
    lay(on, app("alpha", 3061), "current");
    lay(on, app("bravo", 3062), "edited");
    on.writeManifest("charlie", "{ not json\n");
    on.writeManifest("delta", `${JSON.stringify({ slug: "delta", publicDir: "public" })}\n`);
    // The landing's folder bears the zone's name: no project of deploy's.
    on.writeManifest(TEST_ZONE, `${JSON.stringify({ slug: "landing", publicDir: "public" })}\n`);
    const human = await refresh(on, ["--all"]);
    expect(human.code).toBe(0);
    for (const line of [
      "-> nothing was written",
      "   already current: alpha",
      "   kept, edited by hand: bravo",
      "   refused, nothing changed: charlie",
      "   static, no unit to refresh: delta",
    ]) {
      expect(human.output).toContain(line);
    }
    expect(human.all).not.toContain("landing's manifest");

    const json = await refresh(on, ["--all", "--json"]);
    expect(json.code).toBe(0);
    const result = ended(json, "result");
    expect(result).toMatchObject({
      command: "refresh",
      all: true,
      dryRun: false,
      refreshed: [],
      outdated: [],
      current: ["alpha"],
      kept: ["bravo"],
      refused: ["charlie"],
      static: ["delta"],
    });
    expect((result.projects as { slug: string }[]).map((project) => project.slug)).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(accepted(on)).toEqual([]);
    expect(on.logs().filter((line) => line.startsWith("LOCK"))).toEqual([]);
  });

  test("--dry-run shows the units it would write and their text, and writes nothing", async () => {
    const on = machine();
    // No write accepted: one attempted would be refused, and logged.
    sixProjects(on);
    const r = await refresh(on, ["--all", "--dry-run"]);
    expect(r.code).toBe(0);
    for (const slug of ["echo", "foxtrot"]) {
      expect(r.output).toContain(`--- ${slug}.service ---`);
      expect(r.output).toContain(generated(app(slug, slug === "echo" ? 3065 : 3066))[0]!.text);
      expect(r.output).toContain(`[dry-run] write /etc/systemd/system/${slug}.service (root:root, 644)`);
    }
    expect(r.output).toContain("-> would be refreshed: echo, foxtrot");
    expect(r.output).not.toContain("--- alpha.service ---");
    expect(on.logs().filter((line) => /^(ACCEPTED|REFUSED|LOCK)/.test(line))).toEqual([]);

    const json = await refresh(on, ["--all", "--dry-run", "--json"]);
    expect(ended(json, "result")).toMatchObject({ dryRun: true, outdated: ["echo", "foxtrot"], refreshed: [], current: ["alpha"] });
    expect(events(json).filter((event) => event.type === "file").map((event) => event.name)).toEqual(["echo.service", "foxtrot.service"]);
    expect(on.logs().filter((line) => /^(ACCEPTED|REFUSED|LOCK)/.test(line))).toEqual([]);
  });
});

describe("refused before anything is read", () => {
  test("a command line that names no project, or two, or an option refresh does not take", async () => {
    const on = machine();
    for (const arguments_ of [[], ["alpha", "--all"], ["alpha", "bravo"], ["--force", "alpha"], ["Not_A_Slug"]]) {
      const r = await refresh(on, [...arguments_, "--json"]);
      expect({ arguments_, code: r.code }).toEqual({ arguments_, code: 1 });
      const error = ended(r, "error");
      expect(String(error.message)).toStartWith("usage: sitesolide refresh");
      expect(error.hint).not.toBe(DEFAULT_HINT);
    }
    const forced = await refresh(on, ["--force", "alpha"]);
    expect(forced.error).toContain("sitesolide deploy --force");
    expect(on.logs()).toEqual([]);
  });

  test("with a token: needs-ssh, the owner's command, and nothing sent", async () => {
    const on = machine();
    const token = { SITESOLIDE_SERVER: "", SITESOLIDE_API: "https://dashboard.test-zone.invalid", SITESOLIDE_TOKEN: `sst_${"T".repeat(43)}` };
    const r = await refresh(on, ["--all", "--json"], token);
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toBe("sitesolide refresh needs the owner's SSH access to the machine");
    expect(error.hint).toBe(REMOTE_HINTS["needs-ssh"]);
    expect(on.logs()).toEqual([]);
    expect(existsSync(join(on.root, "logs"))).toBe(false);
  });
});
