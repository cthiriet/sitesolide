/**
 * The installer launched by systemd: read the instance and the steward's
 * request, mount the real host, run the pipeline, write the result as it goes.
 *
 * `dashboard/installer.ts` does nothing but call `main`: the body lives here,
 * under src/, so that typing and the tests cover it.
 *
 * The same file serves the extraction: `installer.js --extract <directory>`,
 * which the installer starts as the project's account, reads the archive on its
 * standard input. One file to build and install, and the code that reads an
 * archive is the code the tests ran.
 *
 * The exit code does not carry the verdict, as for the gatekeeper: 0 as soon
 * as a result is written, a failed deployment included. Non-zero only for a
 * launch that could not produce one.
 */
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configFrom, type Environment } from "../gatekeeper/main";
import { createMachine, type Systemctl } from "../gatekeeper/real";
import { readBounded, writeAtomically } from "../secrets/system";
import { readRegistry, rightsOf } from "../access/registry";
import { REGISTRY_NAME } from "../access/protocol";
import { installScope, type MemberRights } from "../members/tokens";
import { INSTALLER_RUN_FOLDER, MAX_ENTRIES, MAX_EXTRACTED_BYTES, MAX_LOG_LINE, MAX_LOG_LINES, MAX_PATH_BYTES, type InstallerResult, type InstallRequest } from "../control/protocol";
import { extract } from "./extract";
import { readLaunch, readRequest } from "./instance";
import { runPipeline, type Outcome } from "./pipeline";
import { createHost, realCommands, type Commands } from "./real";

export const LIMITS = { maxBytes: MAX_EXTRACTED_BYTES, maxEntries: MAX_ENTRIES, maxPathBytes: MAX_PATH_BYTES };

/** The extraction mode: the archive on standard input, the summary on standard output. */
export async function extractMain(destination: string | undefined, input: ReadableStream<Uint8Array>): Promise<number> {
  if (destination === undefined) {
    console.log(JSON.stringify({ ok: false, reason: "usage: installer.js --extract <directory>" }));
    return 2;
  }
  const outcome = await extract(input, destination, LIMITS);
  console.log(JSON.stringify(outcome));
  return outcome.ok ? 0 : 1;
}

/**
 * The result's file, rewritten on every line: the client follows the log
 * while the deployment runs. Root's, 0600, in a 0700 directory: the steward
 * relays it, nobody else reads it.
 */
export function createReporter(folder: string, request: InstallRequest, clock: () => number, echo: (line: string) => void) {
  const result: InstallerResult = {
    deployment: request.deployment,
    slug: request.slug,
    state: "running",
    startedAt: clock(),
    updatedAt: clock(),
    finishedAt: null,
    log: [],
    error: null,
    url: null,
    allocated: [],
  };
  const write = () => {
    result.updatedAt = clock();
    try {
      writeAtomically(folder, `${request.deployment}.json`, new TextEncoder().encode(`${JSON.stringify(result)}\n`), { owner: null, mode: 0o600 });
    } catch (error) {
      echo(`installer ${request.slug}: result not written (${(error as Error).message})`);
    }
  };
  return {
    log(line: string) {
      echo(`installer ${request.slug}: ${line}`);
      result.log.push(line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE - 3)}...` : line);
      if (result.log.length > MAX_LOG_LINES) result.log.splice(0, result.log.length - MAX_LOG_LINES);
      write();
    },
    finish(outcome: Outcome) {
      result.state = outcome.ok ? "succeeded" : "failed";
      result.finishedAt = clock();
      result.allocated = outcome.allocated;
      if (outcome.ok) {
        result.url = outcome.url;
        result.log.push(`-> deployed: ${outcome.url}`);
      } else {
        result.error = { code: outcome.code, message: outcome.message };
        result.log.push(`!! ${outcome.message}`);
      }
      echo(`installer ${request.slug}: ${result.state}${outcome.ok ? "" : `, ${outcome.code}`}`);
      write();
    },
  };
}

/**
 * The rights of the person whose token asked for this deployment, as the
 * access registry reads now, in the steward's state folder: null when they
 * no longer sign in to the dashboard, or the registry does not read, which
 * refuses rather than guessing.
 */
export function memberRights(stateFolder: string, email: string): MemberRights | null {
  const examination = readBounded(join(stateFolder, REGISTRY_NAME), 8 * 1024 * 1024);
  if (examination.kind === "absent") return null;
  if (examination.bytes === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(examination.bytes);
  } catch {
    return null;
  }
  const registry = readRegistry(text);
  return "unreadable" in registry ? null : rightsOf(registry, email);
}

/** A result is read while its deployment is followed; a week later, nobody will. */
export const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The results older than the retention, removed: the folder is a tmpfs, and a
 * busy team would otherwise fill it until the next reboot. Only files named
 * like a result go; a failure to prune stops nothing.
 */
export function pruneResults(folder: string, now: number): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{24}\.json$/.test(name)) continue;
    try {
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (stat.isFile() && now - stat.mtimeMs > RESULT_RETENTION_MS) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      // Gone in the meantime, or unreadable: left for the next run.
    }
  }
  return removed;
}

/**
 * Each path from a variable, with the production default, like the
 * gatekeeper. On the workstation, the tests set every one of them, and
 * `DEPLOY_ACCOUNT` empty: nothing is handed over, no account is looked up.
 */
export async function main(argv: string[], env: Environment, overrides: { commands?: Commands; systemctl?: Systemctl } = {}): Promise<number> {
  const { commands } = overrides;
  if (argv[0] === "--extract") return extractMain(argv[1], Bun.stdin.stream());

  const launch = readLaunch(argv);
  if (!launch.ok) {
    console.error(`installer: refused to start: ${launch.reason} (got ${JSON.stringify((argv[0] ?? "").slice(0, 80))})`);
    return 2;
  }
  const { slug } = launch;
  const zone = env.SITESOLIDE_ZONE ?? "";
  if (zone === "") {
    console.error("installer: SITESOLIDE_ZONE is required, it is read from /etc/caddy/sitesolide.env");
    return 2;
  }
  const stateFolder = env.STEWARD_STATE ?? "/var/lib/sitesolide-steward";
  const examination = readBounded(join(stateFolder, "installs", `${slug}.json`), 1024 * 1024);
  const text = examination.kind === "present" && examination.bytes !== null ? new TextDecoder().decode(examination.bytes) : null;
  const read = readRequest(text, slug, Date.now());
  if (!read.ok) {
    // No result is written: the deployment this would name, if any, has its
    // own, and a replay must not overwrite it.
    console.error(`installer ${slug}: nothing to do: ${read.reason}`);
    return 0;
  }
  let { request } = read;

  const resultsFolder = env.INSTALLER_FOLDER ?? INSTALLER_RUN_FOLDER;
  pruneResults(resultsFolder, Date.now());
  const reporter = createReporter(resultsFolder, request, Date.now, (line) => console.log(line));
  reporter.log(`-> deployment ${request.deployment} of ${slug}, for ${request.token.email} (token ${request.token.id}${request.token.member === null ? "" : `, a person's own`})`);

  // A member's token: its scope narrowed once more to the member's roles as
  // the registry reads now, the request's copy being the steward's of a few
  // seconds ago. See src/members/tokens.ts.
  if (request.token.member !== null) {
    const narrowed = installScope(request.scope, memberRights(stateFolder, request.token.member), slug, request.creating);
    if ("refusal" in narrowed) {
      reporter.finish({ ok: false, code: "out-of-scope", message: narrowed.refusal, allocated: [] });
      return 0;
    }
    request = { ...request, scope: narrowed.scope };
  }

  const machineConfig = { ...configFrom(env, overrides.systemctl), holder: "installer" as const, log: (line: string) => console.log(line) };
  // The accounts are checked and handed over unless CHECK_ACCOUNTS is set
  // empty, which only the workstation's tests do: a machine whose environment
  // file lost DEPLOY_ACCOUNT refuses, rather than leaving the served trees to
  // whoever extracted them.
  const deployAccount = env.DEPLOY_ACCOUNT ?? "";
  if ((env.CHECK_ACCOUNTS ?? "yes") !== "" && deployAccount === "") {
    reporter.finish({ ok: false, code: "misconfigured", message: "DEPLOY_ACCOUNT is missing from /etc/sitesolide-installer.env: the owner must run sitesolide upgrade", allocated: [] });
    return 0;
  }
  const host = createHost({
    sitesDir: machineConfig.sitesDir,
    unitsFolder: env.UNITS_FOLDER ?? "/etc/systemd/system",
    secretsFolder: env.SECRETS_FOLDER ?? "/etc/sitesolide",
    spoolFolder: env.SPOOL_FOLDER ?? "/srv/sites/dashboard/data/control",
    accountsFile: env.ACCOUNTS_FILE ?? "/etc/passwd",
    projectPortsFile: env.PROJECT_PORTS_FILE ?? "/etc/sitesolide-loopback-projects.nft",
    deployAccount: deployAccount === "" ? null : deployAccount,
    dashboardAccount: deployAccount === "" ? null : (env.DASHBOARD_ACCOUNT ?? "site-dashboard"),
    extractor: (env.EXTRACTOR ?? "/usr/local/bin/bun /usr/local/lib/sitesolide/installer.js").split(" ").filter((part) => part !== ""),
    machine: createMachine(machineConfig),
    commands:
      commands ??
      realCommands({
        systemctl: env.SYSTEMCTL ?? "/usr/bin/systemctl",
        useradd: env.USERADD ?? "/usr/sbin/useradd",
        userdel: env.USERDEL ?? "/usr/sbin/userdel",
        systemdRun: env.SYSTEMD_RUN ?? "/usr/bin/systemd-run",
        nft: env.NFT ?? "/usr/sbin/nft",
      }),
    log: (line) => reporter.log(line),
  });

  const outcome = await runPipeline(host, request, { zone, runFolder: machineConfig.runFolder });
  reporter.finish(outcome);
  return 0;
}
