/**
 * The installer's bench, shared by its tests: a throwaway tree standing in for
 * the machine, the real host mounted on it, and only what needs root or a
 * machine simulated: `systemctl`, `useradd`, `userdel`, `systemd-run`'s
 * confinement, `nft`, and Caddy, whose model is the gatekeeper tests' own: it
 * serves the block of its last reload, and a site answers the portal's 401
 * when that block carries the guard.
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
const encoder = new TextEncoder();

export type BenchOptions = {
  lockHeld?: boolean;
  /** Called when the lock is taken: the dashboard acting in the meantime. */
  onLock?: (bench: Bench) => void;
  validate?: (bench: Bench) => Command;
  restartFails?: boolean;
  /** Units systemd reads from elsewhere than the bench's units folder, a package's own: unit -> file. */
  systemUnits?: Record<string, string>;
  probe?: (host: string, path: string, bench: Bench) => ProbeResponse | null;
};

export type Bench = {
  root: string;
  sites: string;
  blocks: string;
  units: string;
  secrets: string;
  spool: string;
  run: string;
  events: string[];
  /** What Caddy serves: the block of each site at the last reload. */
  served: Map<string, string | null>;
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
    spool: join(root, "spool"),
    run: join(root, "run"),
    events: [],
    served: new Map(),
    options,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  for (const folder of [bench.sites, bench.blocks, bench.units, bench.secrets, bench.spool, bench.run]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(root, "passwd"), "root:x:0:0::/root:/bin/sh\n");
  return bench;
}

export function machineOf(bench: Bench): Machine {
  const blockPath = (slug: string) => join(bench.blocks, `${slug}.caddy`);
  const manifestPath = (slug: string) => join(bench.sites, slug, "sitesolide.json");
  return {
    now: () => Date.now(),
    wait: async () => {},
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
      if (arguments_[0] === "show") {
        const unit = arguments_.at(-1)!.replace(/\.service$/, "");
        const own = join(bench.units, `${unit}.service`);
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
      writeFileSync(join(bench.root, "passwd"), `${readFileSync(join(bench.root, "passwd"), "utf8")}${account}:x:2000:2000::/nonexistent:/usr/sbin/nologin\n`);
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
  };
}

export function hostOf(bench: Bench, log: (line: string) => void = (line) => bench.events.push(`log ${line}`)) {
  return createHost({
    sitesDir: bench.sites,
    unitsFolder: bench.units,
    secretsFolder: bench.secrets,
    spoolFolder: bench.spool,
    accountsFile: join(bench.root, "passwd"),
    projectPortsFile: join(bench.root, "projects.nft"),
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
