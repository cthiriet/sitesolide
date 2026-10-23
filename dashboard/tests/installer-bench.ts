/**
 * The installer's bench, shared by its tests: a throwaway tree standing in for
 * the machine, the real host mounted on it, and only what needs root or a
 * machine simulated: `systemctl`, `systemd-analyze`, `useradd`, `userdel`,
 * `systemd-run`'s confinement, `nft`, and Caddy, whose model is the gatekeeper
 * tests' own: it serves the block of its last reload, and a site answers the
 * portal's 401 when that block carries the guard.
 *
 * Time is the machine's clock moved forward by its waits: the ten seconds a
 * deployment watches its services after their restart take none.
 *
 * The extraction is the real one, `installer.ts --extract` in a child
 * process, fed the archive through a descriptor as on the machine; `install`
 * is a real shell command.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle, type BundleEntry } from "../borrowed/bundle";
import { fragmentIsProtected } from "../borrowed/portal";
import type { Command, Machine, ManifestRead } from "../src/gatekeeper/machine";
import type { ProbeResponse } from "../src/gatekeeper/probe";
import { BUNDLE_NAME } from "../src/control/protocol";
import { createHost, spawn, type Commands, type ProjectRun } from "../src/installer/real";

export const ZONE = "test-zone.invalid";
export const INSTALLER = join(import.meta.dir, "..", "installer.ts");
/** The uid of whoever runs the tests: the files they lay belong to it. */
export const OWN_UID = process.getuid?.() ?? 2000;
const encoder = new TextEncoder();

export type BenchOptions = {
  lockHeld?: boolean;
  /** Called when the lock is taken: the dashboard acting in the meantime. */
  onLock?: (bench: Bench) => void;
  validate?: (bench: Bench) => Command;
  restartFails?: boolean;
  /** Units systemd reads from elsewhere than the bench's units folder, a package's own: unit -> file. */
  systemUnits?: Record<string, string>;
  /** The schedules `systemd-analyze calendar` refuses. */
  refusedSchedules?: string[];
  /** How a unit stands from the second reading after the restart on, by unit as deploy names it; every other one runs. */
  falls?: Record<string, { active: string; sub: string; restarts: number; status?: number }>;
  /** The exit status of a unit's main process at every reading, by unit as deploy names it; 0 otherwise. */
  statuses?: Record<string, number>;
  probe?: (host: string, path: string, bench: Bench) => ProbeResponse | null;
  /** The zone certified on demand, manual DNS: its policy laid on the bench, the zone's sites written there. */
  onDemand?: boolean;
};

export type Bench = {
  root: string;
  sites: string;
  blocks: string;
  units: string;
  secrets: string;
  /** The stores of secrets, `<secrets>/projects`, as /etc/sitesolide/projects. */
  store: string;
  /** The steward's previous versions of each store, as /var/lib/sitesolide-steward/precedents/projects. */
  previous: string;
  spool: string;
  run: string;
  events: string[];
  /** What Caddy serves: the block of each site at the last reload. */
  served: Map<string, string | null>;
  /** How far the machine's waits moved its clock. */
  elapsed: number;
  /** How many times the units' standing was read. */
  readings: number;
  options: BenchOptions;
  cleanup: () => void;
};

export function createBench(options: BenchOptions = {}): Bench {
  const root = mkdtempSync(join(tmpdir(), "installer-bench-"));
  const bench: Bench = {
    root,
    sites: join(root, "sites"),
    blocks: join(root, "caddy"),
    units: join(root, "units"),
    secrets: join(root, "secrets"),
    store: join(root, "secrets", "projects"),
    previous: join(root, "precedents", "projects"),
    spool: join(root, "spool"),
    run: join(root, "run"),
    events: [],
    served: new Map(),
    elapsed: 0,
    readings: 0,
    options,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  for (const folder of [bench.sites, bench.blocks, bench.units, bench.secrets, bench.spool, bench.run]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(root, "passwd"), "root:x:0:0::/root:/bin/sh\n");
  if (options.onDemand) writeFileSync(join(root, "tls-zone.caddy"), "tls {\n\ton_demand\n}\n");
  // The zone's sites are written as root: a chown that does nothing stands
  // in for it, the rest of the script runs as it is.
  mkdirSync(join(root, "stubs"));
  writeFileSync(join(root, "stubs", "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bench;
}

/** The steward's record that this token's write made the project's store (src/control/claims.ts). */
export function storeMadeBy(bench: Bench, slug: string, token: string): void {
  const file = join(bench.root, "claims.json");
  const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { claims: Record<string, unknown> }).claims : {};
  writeFileSync(file, JSON.stringify({ version: 1, claims: { ...current, [slug]: { creator: token, deployer: null, deployment: null, at: 1 } } }));
}

/** The zone's sites the bench's script wrote, null before any. */
export function zoneNames(bench: Bench): string | null {
  const file = join(bench.root, "zone-names");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function machineOf(bench: Bench): Machine {
  const blockPath = (slug: string) => join(bench.blocks, `${slug}.caddy`);
  const manifestPath = (slug: string) => join(bench.sites, slug, "sitesolide.json");
  return {
    now: () => Date.now() + bench.elapsed,
    async wait(ms) {
      bench.elapsed += ms;
      bench.events.push(`wait ${ms}`);
    },
    log: (line) => bench.events.push(`log ${line}`),
    async takeLock() {
      if (bench.options.lockHeld) return { kind: "held", who: "deploy", since: Date.now() };
      bench.events.push("lock");
      bench.options.onLock?.(bench);
      return { kind: "taken", release: () => bench.events.push("release") };
    },
    interruptedTransaction: async () => null,
    saveBackup: async () => {
      bench.events.push("backup");
    },
    clearBackup: async () => {},
    async readManifest(slug): Promise<ManifestRead | null> {
      if (!existsSync(manifestPath(slug))) return null;
      return { text: readFileSync(manifestPath(slug), "utf8"), permissions: { uid: 0, gid: 0, mode: 0o644 } };
    },
    readBlock: async (slug) => (existsSync(blockPath(slug)) ? readFileSync(blockPath(slug), "utf8") : null),
    async writeManifest(slug, text) {
      writeFileSync(manifestPath(slug), text);
      bench.events.push("manifest");
    },
    async writeBlock(slug, text) {
      writeFileSync(blockPath(slug), text);
      bench.events.push(`block ${fragmentIsProtected(text) ? "protected" : "open"}`);
    },
    removeBlock: async (slug) => rmSync(blockPath(slug), { force: true }),
    validateCaddy: async () => bench.options.validate?.(bench) ?? { ok: true, output: "Valid configuration" },
    async reloadCaddy() {
      for (const name of readdirSync(bench.blocks)) bench.served.set(name.replace(/\.caddy$/, ""), readFileSync(join(bench.blocks, name), "utf8"));
      bench.events.push("reload");
      return { ok: true, output: "" };
    },
    startCaddy: async () => ({ ok: true, output: "" }),
    isCaddyActive: async () => true,
    servedSites: async () => readdirSync(bench.sites),
    async probe(host, path) {
      const custom = bench.options.probe?.(host, path, bench);
      if (custom !== undefined && custom !== null) return custom;
      if (host === `portal.${ZONE}` && path === "/sante") return { code: 200, door: false, body: '{"configure":true}' };
      const slug = host.slice(0, -(ZONE.length + 1));
      const block = bench.served.get(slug);
      if (block !== undefined && block !== null && fragmentIsProtected(block)) return { code: 401, door: true, body: "" };
      return { code: 200, door: false, body: "" };
    },
    restartCollector: async () => ({ ok: true, output: "" }),
  };
}

export function commandsOf(bench: Bench): Commands {
  return {
    async systemctl(arguments_) {
      // What systemd knows of a unit: the file the bench's units folder
      // carries, a package's own unit the test laid, or nothing.
      if (arguments_[0] === "show" && arguments_.includes("NRestarts")) return standing(bench, arguments_.filter((argument, i) => i > 0 && argument !== "-p" && arguments_[i - 1] !== "-p"));
      if (arguments_[0] === "show") {
        // A service asked for as `<unit>.service`, a timer by its own name.
        const name = arguments_.at(-1)!;
        const unit = name.replace(/\.service$/, "");
        const own = join(bench.units, name);
        const fragment = bench.options.systemUnits?.[unit] ?? (existsSync(own) ? own : "");
        return { code: 0, output: `LoadState=${fragment === "" ? "not-found" : "loaded"}\nFragmentPath=${fragment}\n` };
      }
      bench.events.push(`systemctl ${arguments_.join(" ")}`);
      if (arguments_[0] === "restart" && bench.options.restartFails) return { code: 1, output: "failed" };
      if (arguments_[0] === "is-active") return { code: 0, output: arguments_.slice(1).map(() => "active").join("\n") };
      return { code: 0, output: "" };
    },
    async useradd(account) {
      bench.events.push(`useradd ${account}`);
      // The account a project's files belong to is the test's own uid: a
      // secret file a test lays is then the project's, as the steward would
      // have laid it, and one owned by anyone else is not.
      writeFileSync(join(bench.root, "passwd"), `${readFileSync(join(bench.root, "passwd"), "utf8")}${account}:x:${OWN_UID}:${OWN_UID}::/nonexistent:/usr/sbin/nologin\n`);
      return { code: 0, output: "" };
    },
    async userdel(account) {
      bench.events.push(`userdel ${account}`);
      const lines = readFileSync(join(bench.root, "passwd"), "utf8").split("\n");
      if (!lines.some((line) => line.startsWith(`${account}:`))) return { code: 6, output: `userdel: user '${account}' does not exist` };
      writeFileSync(join(bench.root, "passwd"), lines.filter((line) => !line.startsWith(`${account}:`)).join("\n"));
      return { code: 0, output: "" };
    },
    // systemd-run stands for the confinement, which only a machine has: the
    // program itself is the real one, run directly.
    async asProject(run: ProjectRun) {
      bench.events.push(`as ${run.slug} ${run.purpose}`);
      if (run.purpose === "extract") return spawn(run.command, 60_000, { stdin: run.stdin });
      return spawn(run.command, 60_000, { cwd: run.binds[0]!.source, stdin: run.stdin });
    },
    async nft() {
      return { code: 1, output: "Error: No such file or directory" };
    },
    async systemdAnalyze(arguments_) {
      bench.events.push(`systemd-analyze ${arguments_.join(" ")}`);
      const refused = arguments_[0] === "calendar" && (bench.options.refusedSchedules ?? []).includes(arguments_[1]!);
      return refused ? { code: 1, output: `Failed to parse calendar specification '${arguments_[1]}': Invalid argument` } : { code: 0, output: "  Original form: x\n" };
    },
    // The script really runs, on the bench's tree.
    async shell(script, timeoutMs) {
      bench.events.push("zone-names");
      const run = Bun.spawnSync(["/bin/sh", "-c", script], { env: { PATH: `${join(bench.root, "stubs")}:/usr/bin:/bin` }, timeout: timeoutMs });
      return { code: run.exitCode ?? 1, output: `${run.stdout.toString()}${run.stderr.toString()}` };
    },
  };
}

/**
 * `systemctl show -p Id -p ActiveState -p SubState -p NRestarts -p
 * ExecMainStatus`, one block per unit as systemd separates them: every unit
 * running at the first reading, and from the second on as `falls` says.
 */
function standing(bench: Bench, names: string[]) {
  bench.readings++;
  bench.events.push(`standing ${names.join(" ")}`);
  const blocks = names.map((name) => {
    const id = name.includes(".") ? name : `${name}.service`;
    const unit = id.replace(/\.service$/, "");
    const fell = bench.readings > 1 ? bench.options.falls?.[unit] : undefined;
    const now = fell ?? { active: "active", sub: "running", restarts: 0 };
    const status = fell?.status ?? bench.options.statuses?.[unit] ?? 0;
    return `Id=${id}\nActiveState=${now.active}\nSubState=${now.sub}\nNRestarts=${now.restarts}\nExecMainStatus=${status}\n`;
  });
  return { code: 0, output: blocks.join("\n") };
}

export function hostOf(bench: Bench, log: (line: string) => void = (line) => bench.events.push(`log ${line}`)) {
  return createHost({
    sitesDir: bench.sites,
    unitsFolder: bench.units,
    secretsFolder: bench.secrets,
    storePreviousFolder: bench.previous,
    claimsFile: join(bench.root, "claims.json"),
    spoolFolder: bench.spool,
    accountsFile: join(bench.root, "passwd"),
    projectPortsFile: join(bench.root, "projects.nft"),
    tlsZoneFile: join(bench.root, "tls-zone.caddy"),
    zoneNamesFile: join(bench.root, "zone-names"),
    deployAccount: null,
    dashboardAccount: null,
    extractor: [process.execPath, INSTALLER],
    machine: machineOf(bench),
    commands: commandsOf(bench),
    log,
  });
}

export const file = (path: string, content = "x"): BundleEntry => ({ kind: "file", path, mtime: 1_789_000_000, executable: false, content: encoder.encode(content) });

/** Lays the archive where the dashboard would have streamed it. */
export function stageBundle(bench: Bench, deployment: string, entries: BundleEntry[] | Uint8Array): void {
  mkdirSync(join(bench.spool, deployment), { recursive: true });
  writeFileSync(join(bench.spool, deployment, BUNDLE_NAME), entries instanceof Uint8Array ? entries : bundle(entries));
}
