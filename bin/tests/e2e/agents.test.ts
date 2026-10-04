import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeVm, type FakeVm } from "./fake-vm";
import { run, TESTS_ROOT, type Result } from "./run";

/**
 * The CLI as an agent drives it: `--json`, a folder with no manifest, an app
 * with no port.
 *
 * **Nothing here touches a machine.** Every test runs in front of the fake VM
 * of fake-vm.ts: an ssh that answers only the reads it recognises, or accepts
 * writes without running anything when a test asks it to, and a zone that
 * resolves nowhere. A deployment run without --dry-run goes as far as the
 * first refused write, which is how what it writes on the workstation before
 * that, the port it chose, is checked for real.
 */

const TEMP_DIRS: string[] = [];
let vm: FakeVm | null = null;

afterEach(() => {
  vm?.cleanup();
  vm = null;
  for (const folder of TEMP_DIRS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fakeVm(): FakeVm {
  vm = createFakeVm();
  return vm;
}

/**
 * A copy of a fixture, under a folder name of our choosing, outside the
 * repository. The real path: on macOS /var is a link to /private/var.
 */
function copyOf(fixture: string, name: string): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "agents-")));
  TEMP_DIRS.push(parent);
  const folder = join(parent, name);
  cpSync(join(TESTS_ROOT, fixture), folder, { recursive: true });
  return folder;
}

/** The events of a run: every line of standard output, each of which must be one. */
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

const TYPES = ["step", "info", "planned", "warning", "output", "file", "inferred", "log", "result", "error"];

/** A run's events are all known, and exactly the last one ends it. */
function ended(r: Result, type: "result" | "error"): Record<string, unknown> {
  const list = events(r);
  for (const event of list) expect(TYPES).toContain(event.type as string);
  const last = list.at(-1)!;
  expect(last.type).toBe(type);
  expect(list.filter((event) => event.type === "result" || event.type === "error")).toHaveLength(1);
  return last;
}

const APP = { slug: "agent-shop", start: "/usr/local/bin/bun run server.ts", exclude: ["node_modules"] };

/** A project folder with this manifest and a public/ page. */
function project(manifest: object, name = "agent-shop"): string {
  const folder = copyOf("../infer/bun-app", name);
  writeFileSync(join(folder, "sitesolide.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return folder;
}

describe("deploy --json", () => {
  test("a dry run prints nothing but events, and ends with the site's address", async () => {
    const r = await run("projects/bun-mixed", ["deploy", "--json", "--dry-run"], { vm: fakeVm() });
    expect(r.code).toBe(0);
    const result = ended(r, "result");
    expect(result).toMatchObject({
      ok: true,
      command: "deploy",
      slug: "sample-bun",
      kind: "service",
      dryRun: true,
      port: 3031,
      portal: false,
      url: "https://sample-bun.test-zone.invalid/",
      status: null,
    });
  });

  test("the generated unit and block are files, the commands not run are planned, the build's own output is relayed", async () => {
    const r = await run("projects/bun-mixed", ["deploy", "--json", "--dry-run"], { vm: fakeVm() });
    const list = events(r);
    const files = list.filter((event) => event.type === "file").map((event) => event.name);
    expect(files).toEqual(["sample-bun.service", "sample-bun.caddy"]);
    expect(String(list.find((event) => event.name === "sample-bun.service")?.content)).toContain("User=site-sample-bun");
    expect(list.some((event) => event.type === "planned" && String(event.message).startsWith("rsync -a --delete"))).toBe(true);
    expect(list.some((event) => event.type === "step" && event.message === "build (bun run build.ts)")).toBe(true);
    // The same run without --json: the human output, not one event.
    const human = await run("projects/bun-mixed", ["deploy", "--dry-run"], { vm: fakeVm() });
    expect(human.output).toContain("-> project sample-bun, service");
    expect(human.output).toContain("--- sample-bun.service ---");
    expect(human.output.split("\n").some((line) => line.startsWith('{"type"'))).toBe(false);
  });

  test("a static site", async () => {
    const r = await run("projects/simple-site", ["deploy", "--json", "--dry-run"], { vm: fakeVm() });
    expect(r.code).toBe(0);
    expect(ended(r, "result")).toMatchObject({ command: "deploy", slug: "sample-static", kind: "static", port: null });
  });

  test("a refusal is one error event, with its details and a hint, and a non-zero exit", async () => {
    const r = await run("rejects/path-escapes", ["deploy", "--json", "--dry-run"], { vm: fakeVm() });
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toBe("sitesolide.json rejected");
    expect((error.details as string[]).join(" ")).toContain("publicDir");
    expect(error.hint).toContain("docs/manifest.md");
    // Nothing on standard error that the event does not carry.
    expect(r.error).not.toContain("!!");
  });

  test("a port another project declares: the hint says how to let deploy pick one", async () => {
    const machine = fakeVm();
    machine.writeManifest("taken", JSON.stringify({ slug: "taken", start: "/usr/local/bin/bun run server.ts", port: 3031 }));
    const r = await run("projects/bun-mixed", ["deploy", "--json", "--dry-run"], { vm: machine });
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toBe("port already taken on the server");
    expect(error.hint).toContain("delete the key and let deploy pick one");
  });

  test("a slug systemd already gives to a package's service is refused before anything is written, --force included", async () => {
    const machine = fakeVm();
    machine.systemUnit("agent-shop", "/lib/systemd/system/agent-shop.service");
    const r = await run(project({ ...APP, port: 3040 }), ["deploy", "--json", "--dry-run"], { vm: machine });
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toBe("agent-shop is already the name of a service of the server, which deploy never replaces");
    expect((error.details as string[]).join(" ")).toContain("read from /lib/systemd/system/agent-shop.service");
    expect(error.hint).toContain("pick another slug");
    // For real: the refusal falls before the first write, and --force does not lift it.
    machine.acceptWrites();
    const forced = await run(project({ ...APP, port: 3040 }), ["deploy", "--json", "--force"], { vm: machine });
    expect(ended(forced, "error").message).toBe(error.message);
    expect(machine.logs().filter((line) => line.startsWith("ACCEPTED"))).toEqual([]);
  });

  test("a unit in /etc stays the project's when it serves the project's folder, and is refused otherwise", async () => {
    const machine = fakeVm();
    const unit = "/etc/systemd/system/agent-shop.service";
    machine.writeFile(unit, "[Service]\nWorkingDirectory=/srv/sites/agent-shop/app\nExecStart=/usr/local/bin/bun run server.ts\n");
    expect((await run(project({ ...APP, port: 3040 }), ["deploy", "--json", "--dry-run"], { vm: machine })).code).toBe(0);
    machine.writeFile(unit, "[Service]\nExecStart=/usr/sbin/postfix start-fg\n");
    const refused = await run(project({ ...APP, port: 3040 }), ["deploy", "--json", "--dry-run"], { vm: machine });
    expect((ended(refused, "error").details as string[]).join(" ")).toContain(`${unit} is a unit deploy did not write`);
  });

  test("an unknown command and --json on run are refused as events too", async () => {
    const unknown = await run("projects/simple-site", ["dance", "--json"], { vm: fakeVm() });
    expect(unknown.code).toBe(1);
    expect(ended(unknown, "error").message).toBe("unknown command: dance");
    const runs = await run("projects/simple-site", ["run", "--json", "--", "true"], { vm: fakeVm() });
    expect(ended(runs, "error").message).toBe("--json is not available for run");
    // Past `--`, the option belongs to the command run launches.
    const passed = await run("projects/simple-site", ["run", "--", "echo", "--json"], { vm: fakeVm() });
    expect(passed.error).toContain("no secret declared in the manifest");
  });
});

describe("an app that declares no port", () => {
  test("a dry run says which port it would take, the lowest the machine leaves, and writes nothing", async () => {
    const machine = fakeVm();
    machine.writeManifest("blog", JSON.stringify({ slug: "blog", start: "/usr/local/bin/bun run server.ts", port: 3002 }));
    machine.writeManifest("notes", JSON.stringify({ slug: "notes", start: "/usr/local/bin/bun run server.ts", port: 3003 }));
    const folder = project(APP);
    const before = readFileSync(join(folder, "sitesolide.json"), "utf8");
    const r = await run(folder, ["deploy", "--dry-run"], { vm: machine });
    expect(r.code).toBe(0);
    expect(r.output).toContain("-> port 3004, the lowest free one on the server");
    expect(r.output).toContain(`[dry-run] write ${join(folder, "sitesolide.json")} with "port": 3004`);
    // The unit and the block generated with it.
    expect(r.output).toContain("Environment=PORT=3004");
    expect(r.output).toContain("reverse_proxy 127.0.0.1:3004");
    expect(readFileSync(join(folder, "sitesolide.json"), "utf8")).toBe(before);
  });

  test("for real, the port is written into sitesolide.json before anything leaves", async () => {
    const machine = fakeVm();
    machine.writeManifest("blog", JSON.stringify({ slug: "blog", start: "/usr/local/bin/bun run server.ts", port: 3002 }));
    const folder = project(APP);
    // No --dry-run: the fake ssh refuses the first write, which is as far as
    // this deployment goes.
    const r = await run(folder, ["deploy", "--json"], { vm: machine });
    expect(r.code).toBe(1);
    const written = JSON.parse(readFileSync(join(folder, "sitesolide.json"), "utf8"));
    expect(written).toEqual({ ...APP, port: 3003 });
    expect(Object.keys(written)).toEqual(["slug", "start", "port", "exclude"]);
    const list = events(r);
    expect(list.some((event) => event.type === "step" && event.message === "port 3003, the lowest free one on the server")).toBe(true);
    // The refusal fell on the machine's side, after the port was written.
    expect(ended(r, "error").message).toStartWith("failed (");
    expect(machine.logs().some((line) => line.startsWith("REFUSED ") && line.includes("useradd"))).toBe(true);
  });

  test("a project the machine already carries keeps its port, as on a fresh clone", async () => {
    const machine = fakeVm();
    machine.writeManifest("agent-shop", JSON.stringify({ ...APP, port: 3057 }));
    const r = await run(project(APP), ["deploy", "--json", "--dry-run"], { vm: machine });
    expect(r.code).toBe(0);
    expect(ended(r, "result")).toMatchObject({ port: 3057, portChosen: "kept", manifestWritten: false });
  });

  test("the other commands point at deploy rather than refusing the manifest blindly", async () => {
    const r = await run(project(APP), ["logs", "--json"], { vm: fakeVm() });
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toBe("port: required, and only deploy chooses one");
    expect(error.hint).toContain("sitesolide deploy");
  });
});

describe("a folder with no sitesolide.json", () => {
  test("detect shows the manifest it implies, and writes nothing", async () => {
    const folder = copyOf("../infer/bun-app", "agent-shop");
    const r = await run(folder, ["detect", "--json"], { vm: fakeVm() });
    expect(r.code).toBe(0);
    const result = ended(r, "result");
    expect(result).toMatchObject({ command: "detect", kind: "bun", written: null });
    expect((result.manifest as Record<string, unknown>).slug).toBe("agent-shop");
    expect(existsSync(join(folder, "sitesolide.json"))).toBe(false);
    // Read-only and offline: not a single command sent to the machine.
    expect(vm!.logs()).toEqual([]);
  });

  test("detect --write writes it, and never over a manifest already there", async () => {
    const folder = copyOf("../infer/bun-app", "agent-shop");
    const first = await run(folder, ["detect", "--write"], { vm: fakeVm() });
    expect(first.code).toBe(0);
    expect(first.output).toContain("this folder reads as a Bun app");
    expect(JSON.parse(readFileSync(join(folder, "sitesolide.json"), "utf8")).slug).toBe("agent-shop");
    const again = await run(folder, ["detect", "--write", "--json"], { vm: fakeVm() });
    expect(again.code).toBe(1);
    expect(ended(again, "error").message).toStartWith("sitesolide.json already exists in");
  });

  test("detect --slug names the project otherwise than after its folder", async () => {
    const folder = copyOf("../infer/static-public", "My Folder");
    const r = await run(folder, ["detect", "--json", "--slug", "portfolio"], { vm: fakeVm() });
    expect((ended(r, "result").manifest as Record<string, unknown>).slug).toBe("portfolio");
    const invalid = await run(folder, ["detect", "--json", "--slug", "Not.Valid"], { vm: fakeVm() });
    expect(ended(invalid, "error").message).toStartWith("--slug:");
  });

  test("a folder with nothing deployable is refused with what was looked for", async () => {
    const r = await run(copyOf("../infer/root-index", "landing-page"), ["detect", "--json"], { vm: fakeVm() });
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toStartWith("nothing deployable recognised in");
    expect((error.details as string[]).join(" ")).toContain("move the site into public/");
  });

  test("deploy shows the inferred manifest and stops, giving the command that accepts it", async () => {
    const folder = copyOf("../infer/bun-app", "agent-shop");
    const r = await run(folder, ["deploy", "--json", "--dry-run"], { vm: fakeVm() });
    expect(r.code).toBe(1);
    const list = events(r);
    const inferred = list.find((event) => event.type === "inferred");
    expect(inferred).toMatchObject({ kind: "bun", manifest: { slug: "agent-shop", start: "/usr/local/bin/bun run server.ts" } });
    const error = ended(r, "error");
    expect(error.message).toBe(`no sitesolide.json in ${folder}: inferred one shown above, not written`);
    expect(error.hint).toContain("sitesolide deploy --yes");
    expect(existsSync(join(folder, "sitesolide.json"))).toBe(false);

    const human = await run(folder, ["deploy", "--dry-run"], { vm: fakeVm() });
    expect(human.output).toContain("-> no sitesolide.json: this folder reads as a Bun app");
    expect(human.error).toContain("to write it and deploy:            sitesolide deploy --yes");
  });

  test("deploy --yes in a dry run goes through with the inferred manifest and its port, writing nothing", async () => {
    const folder = copyOf("../infer/bun-app", "agent-shop");
    const r = await run(folder, ["deploy", "--json", "--dry-run", "--yes"], { vm: fakeVm() });
    expect(r.code).toBe(0);
    expect(ended(r, "result")).toMatchObject({
      slug: "agent-shop",
      inferred: "bun",
      port: 3002,
      portChosen: "free",
      manifestWritten: false,
      url: "https://agent-shop.test-zone.invalid/",
    });
    expect(existsSync(join(folder, "sitesolide.json"))).toBe(false);
  });

  test("deploy --yes for real writes the manifest, then its port, before anything leaves", async () => {
    const folder = copyOf("../infer/bun-app", "agent-shop");
    const r = await run(folder, ["deploy", "--yes"], { vm: fakeVm() });
    expect(r.code).toBe(1);
    const written = JSON.parse(readFileSync(join(folder, "sitesolide.json"), "utf8"));
    expect(written).toMatchObject({ slug: "agent-shop", start: "/usr/local/bin/bun run server.ts", port: 3002 });
    expect(r.output).toContain(`written: ${join(folder, "sitesolide.json")}, commit it`);
  });

  test("an inferred manifest never takes over a project the machine already serves under that name", async () => {
    const machine = fakeVm();
    machine.writeManifest("agent-shop", JSON.stringify({ slug: "agent-shop", publicDir: "public" }));
    const folder = copyOf("../infer/bun-app", "agent-shop");
    const r = await run(folder, ["deploy", "--json", "--yes"], { vm: machine });
    expect(r.code).toBe(1);
    const error = ended(r, "error");
    expect(error.message).toBe("agent-shop already exists on the server, and this folder has no sitesolide.json");
    expect(error.hint).toContain("--slug");
    expect(existsSync(join(folder, "sitesolide.json"))).toBe(false);
    // Another name goes through.
    const renamed = await run(folder, ["deploy", "--json", "--dry-run", "--yes", "--slug", "agent-shop-2"], { vm: machine });
    expect(ended(renamed, "result")).toMatchObject({ slug: "agent-shop-2" });
  });
});

describe("the reading commands, as data", () => {
  test("status --json reads the machine's table into projects, ports and memory", async () => {
    const machine = fakeVm();
    machine.acceptWrites();
    machine.answer(
      "=== projects served ===",
      [
        "=== projects served ===",
        "PROJECT                SIZE     SERVICE    MEMORY   PEAK     LIMIT",
        "sample-bun             48M      active     31MB     40MB     256MB",
        "",
        "=== ports listening on loopback ===",
        "127.0.0.1:3031",
        "",
        "=== memory ===",
        "               total        used        free      shared  buff/cache   available",
        "Mem:            7941        1234        4000          12        2707        6500",
        "",
      ].join("\n"),
    );
    const r = await run("projects/simple-site", ["status", "--json"], { vm: machine });
    expect(r.code).toBe(0);
    const result = ended(r, "result");
    expect(result.projects).toEqual([
      { slug: "sample-bun", size: "48M", service: "active", memoryMB: 31, peakMB: 40, limitMB: 256, services: [] },
    ]);
    expect(result.ports).toEqual([3031]);
    expect((result.memory as Record<string, number>).available).toBe(6500);
  });

  test("logs --json: one event per journal entry, from journalctl's own JSON", async () => {
    const machine = fakeVm();
    machine.acceptWrites();
    const entry = (message: string, priority: number) =>
      JSON.stringify({ __REALTIME_TIMESTAMP: "1759600000000000", PRIORITY: String(priority), _SYSTEMD_UNIT: "sample-bun.service", MESSAGE: message });
    machine.answer("journalctl", `${entry("listening", 6)}\n${entry("crashed", 3)}\n`);
    const r = await run("projects/bun-mixed", ["logs", "--json", "--lines", "20"], { vm: machine });
    expect(r.code).toBe(0);
    const logs = events(r).filter((event) => event.type === "log");
    expect(logs.map((event) => [event.message, event.priority, event.unit])).toEqual([
      ["listening", 6, "sample-bun.service"],
      ["crashed", 3, "sample-bun.service"],
    ]);
    expect(ended(r, "result")).toMatchObject({ command: "logs", slug: "sample-bun", units: ["sample-bun"], entries: 2 });
    const asked = machine.logs().find((line) => line.includes("journalctl"))!;
    expect(asked).toContain("-n 20 --no-pager -o json");
    expect(asked).not.toContain(" -f");
  });

  test("logs --lines out of bounds is refused before anything is asked", async () => {
    const r = await run("projects/bun-mixed", ["logs", "--json", "--lines", "0"], { vm: fakeVm() });
    expect(ended(r, "error").message).toStartWith("--lines:");
    expect(vm!.logs()).toEqual([]);
  });

  test("lock --status --json hands over the project's row, never a code", async () => {
    const machine = fakeVm();
    machine.acceptWrites();
    const r = await run("projects/simple-site", ["lock", "--status", "--json"], { vm: machine });
    expect(r.code).toBe(0);
    const result = ended(r, "result");
    expect(result).toMatchObject({ command: "lock", slug: "sample-static" });
    // The zone resolves nowhere: curl's 000, read as no answer at all.
    expect(result.lock).toEqual({ wanted: false, installed: false, withoutCode: 0, withCode: null, domain: null });
  });

  test("domain --json: what the manifest wants, the table holds, the DNS says", async () => {
    const machine = fakeVm();
    machine.acceptWrites();
    machine.answer("domaines.map", "0\n");
    const r = await run("projects/own-domain", ["domain", "--json"], { vm: machine });
    expect(r.code).toBe(0);
    const domain = ended(r, "result").domain as Record<string, unknown>;
    expect(domain).toMatchObject({ name: "sample-domain.test", active: false, table: false, dns: false });
    expect(String(domain.https)).toStartWith("unreachable");
  });

  test("remove --dry-run --json lists every step and removes nothing", async () => {
    const r = await run("projects/bun-mixed", ["remove", "--confirm", "sample-bun", "--dry-run", "--json"], { vm: fakeVm() });
    expect(r.code).toBe(0);
    expect(ended(r, "result")).toMatchObject({ command: "remove", slug: "sample-bun", dryRun: true });
    expect(events(r).filter((event) => event.type === "planned").length).toBeGreaterThan(3);
    expect(vm!.logs().some((line) => line.startsWith("REFUSED"))).toBe(false);
  });
});

describe("ssh under --json", () => {
  test("never waits for a keyboard: the askpass answers nothing, and the scripts inherit it", async () => {
    // A fake ssh that prints the two variables it received, then refuses.
    const machine = fakeVm();
    const bin = join(machine.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ssh"), '#!/bin/sh\necho "askpass=$SSH_ASKPASS_REQUIRE" >&2\nexit 255\n', { mode: 0o755 });
    const r = await run("projects/bun-mixed", ["deploy", "--json", "--dry-run"], { vm: machine });
    expect(r.code).toBe(1);
    const relayed = events(r).filter((event) => event.type === "warning").map((event) => event.message);
    expect(relayed.join(" ")).toContain("askpass=force");
  });
});
