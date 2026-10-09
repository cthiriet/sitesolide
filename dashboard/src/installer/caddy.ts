/**
 * The installer's Caddy step: one project's block, written, validated,
 * reloaded, probed, and put back at the slightest failure.
 *
 * Over SSH, `sitesolide deploy` hands the block to bin/deploy-caddy.sh, which
 * also re-deposits the Caddyfile and the zone's variables from the
 * workstation's copy. On the machine there is no workstation copy, and
 * re-depositing a Caddyfile from the installer's bundle would roll back
 * whatever the owner deployed since. So the installer touches the one file it
 * owns, `/etc/caddy/sites/<slug>.caddy`, with the gatekeeper's machine
 * (src/gatekeeper/real.ts) and the gatekeeper's judgement of the probes
 * (src/gatekeeper/probe.ts): the same validation with the environment
 * systemd gives Caddy, the same `systemctl reload caddy`, the same reading of
 * every served site before and after, the same restore. Only what is written
 * differs: the block alone, the manifest being the pipeline's business.
 *
 * Called under the Caddy lock the pipeline holds. A backup of the block stays
 * in the gatekeeper's backups folder for the length of the transaction: an
 * installer killed in the middle leaves it there, and the gatekeeper then
 * refuses every portal change until a human has looked, exactly as after an
 * interrupted gatekeeper.
 *
 * NEVER `caddy stop`, `caddy start` or `caddy reload`: see the Production
 * section of CLAUDE.md. Only `systemctl reload caddy` applies a configuration.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUPS_NAME } from "../gatekeeper/instance";
import type { Machine } from "../gatekeeper/machine";
import { answers, describe, judgeTarget, regressions, servedHosts, type ProbeResponse } from "../gatekeeper/probe";
import { TIMEOUTS, caddyExtract } from "../gatekeeper/transaction";

export type BlockOutcome = { ok: true; changed: boolean; detail: string } | { ok: false; message: string };

export type BlockStep = {
  slug: string;
  zone: string;
  /** The generated block. */
  text: string;
  /** Behind the portal: the target must answer the portal's 401. */
  protected: boolean;
  /** Where the gatekeeper keeps its backups, /run/sitesolide-gatekeeper. */
  runFolder: string;
};

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

async function probeAll(machine: Machine, hosts: string[]): Promise<Map<string, ProbeResponse>> {
  const responses = await Promise.all(hosts.map((host) => machine.probe(host, "/", TIMEOUTS.probeConfig)));
  return new Map(hosts.map((host, i) => [host, responses[i]!]));
}

/** The target in its wanted state, and nobody lost, with retries up to the delay, as the gatekeeper does. */
async function probeAfter(machine: Machine, step: BlockStep, target: string, before: Map<string, ProbeResponse>): Promise<string | null> {
  const deadline = machine.now() + TIMEOUTS.probes;
  const hosts = [target, ...[...before].filter(([host, response]) => host !== target && answers(response)).map(([host]) => host)];
  const seen = new Map<string, ProbeResponse>();
  let pending = hosts;
  for (;;) {
    const remaining = Math.max(500, Math.min(TIMEOUTS.probeConfig, deadline - machine.now()));
    const responses = await Promise.all(pending.map((host) => machine.probe(host, "/", remaining)));
    pending.forEach((host, i) => seen.set(host, responses[i]!));
    const problem = judgeTarget(step.protected, target, seen.get(target)!);
    const lost = regressions(before, seen, [target]);
    if (problem === null && lost.length === 0) return null;
    if (machine.now() + TIMEOUTS.pause >= deadline) {
      const reasons = problem === null ? [] : [problem];
      if (lost.length > 0) reasons.push(`no longer answering: ${lost.map((host) => `${host} ${describe(seen.get(host) ?? { error: "not probed" })}`).slice(0, 3).join(", ")}`);
      return reasons.join("; ");
    }
    pending = [...(problem === null ? [] : [target]), ...lost];
    await machine.wait(TIMEOUTS.pause);
  }
}

/**
 * The block's backup, in the gatekeeper's folder. With a deposited manifest,
 * the gatekeeper's own format; without one, for a project being created, the
 * block alone: there is no manifest to put back.
 */
async function saveBackup(machine: Machine, step: BlockStep, inService: string | null): Promise<void> {
  const manifest = await machine.readManifest(step.slug);
  if (manifest !== null) {
    await machine.saveBackup(step.slug, { manifest, block: inService });
    return;
  }
  const folder = join(step.runFolder, BACKUPS_NAME, step.slug);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (inService === null) writeFileSync(join(folder, `${step.slug}.caddy.absent`), "", { mode: 0o600 });
  else writeFileSync(join(folder, `${step.slug}.caddy`), inService, { mode: 0o600 });
}

async function restore(machine: Machine, slug: string, block: string | null, reloadAttempted: boolean): Promise<string | null> {
  try {
    const current = await machine.readBlock(slug).catch(() => undefined);
    if (current !== block) {
      if (block === null) await machine.removeBlock(slug);
      else await machine.writeBlock(slug, block);
    }
  } catch (error) {
    return `block not written back: ${errorMessage(error)}`;
  }
  const validation = await machine.validateCaddy(TIMEOUTS.validate);
  if (!validation.ok) return `the restored configuration does not validate: ${caddyExtract(validation.output)}`;
  if (!reloadAttempted) return null;
  const active = await machine.isCaddyActive(TIMEOUTS.active);
  const command = active ? await machine.reloadCaddy(TIMEOUTS.reload) : await machine.startCaddy(TIMEOUTS.reload);
  if (!command.ok) return `${active ? "reload" : "start"} refused: ${caddyExtract(command.output)}`;
  if (!(await machine.isCaddyActive(TIMEOUTS.active))) return "Caddy is not active";
  return null;
}

/** Writes the block through the validated path. The caller holds the Caddy lock. */
export async function installBlock(machine: Machine, step: BlockStep): Promise<BlockOutcome> {
  const { slug, zone, text } = step;
  const target = `${slug}.${zone}`;

  let inService: string | null;
  try {
    if ((await machine.interruptedTransaction()) !== null) {
      return { ok: false, message: "an interrupted change left Caddy in an unknown state on the machine: the owner must look at the gatekeeper's journal, nothing was changed" };
    }
    inService = await machine.readBlock(slug);
  } catch (error) {
    return { ok: false, message: `cannot read the block in service: ${errorMessage(error)}, nothing was changed` };
  }
  // Idempotent, like bin/deploy-caddy.sh comparing fingerprints: an
  // identical block is neither written nor reloaded.
  if (inService === text) return { ok: true, changed: false, detail: `/etc/caddy/sites/${slug}.caddy unchanged` };

  let before: Map<string, ProbeResponse>;
  try {
    if (!(await machine.isCaddyActive(TIMEOUTS.active))) return { ok: false, message: "Caddy is not active, nothing was changed" };
    const validation = await machine.validateCaddy(TIMEOUTS.validate);
    if (!validation.ok) {
      return { ok: false, message: `caddy validate refuses the configuration already in place: ${caddyExtract(validation.output)}, nothing was changed` };
    }
    const hosts = servedHosts(zone, await machine.servedSites(TIMEOUTS.sites));
    if (!hosts.includes(target)) hosts.push(target);
    before = await probeAll(machine, hosts);
    await saveBackup(machine, step, inService);
  } catch (error) {
    try {
      await machine.clearBackup(slug);
    } catch {
      // Left in place: it blocks the next action, and somebody has to look.
    }
    return { ok: false, message: `preconditions: ${errorMessage(error)}, nothing was changed` };
  }

  let stage = "write";
  let reloadAttempted = false;
  try {
    await machine.writeBlock(slug, text);
    stage = "validate";
    const validation = await machine.validateCaddy(TIMEOUTS.validate);
    if (!validation.ok) throw new Error(caddyExtract(validation.output));
    stage = "reload";
    reloadAttempted = true;
    const reload = await machine.reloadCaddy(TIMEOUTS.reload);
    if (!reload.ok) throw new Error(caddyExtract(reload.output));
    if (!(await machine.isCaddyActive(TIMEOUTS.active))) throw new Error("Caddy is no longer active");
    stage = "probe";
    const problem = await probeAfter(machine, step, target, before);
    if (problem !== null) throw new Error(problem);
  } catch (error) {
    const failure = `${stage}: ${errorMessage(error)}`;
    machine.log(`installer ${slug}: Caddy ${failure}, restoring`);
    let restoration: string | null;
    try {
      restoration = await restore(machine, slug, inService, reloadAttempted);
    } catch (unexpected) {
      restoration = errorMessage(unexpected);
    }
    if (restoration !== null) {
      return {
        ok: false,
        message: `the Caddy block failed (${failure}) and the restore failed too (${restoration}): the owner must check Caddy now, the backup is in ${join(step.runFolder, BACKUPS_NAME, slug)}`,
      };
    }
    await machine.clearBackup(slug).catch(() => undefined);
    return { ok: false, message: `the Caddy block was refused (${failure}); the previous configuration is back in service` };
  }

  await machine.clearBackup(slug).catch((error) => machine.log(`installer ${slug}: backup not removed: ${errorMessage(error)}`));
  await machine.restartCollector(TIMEOUTS.collector).catch(() => undefined);
  const others = [...before].filter(([host, response]) => host !== target && answers(response)).length;
  return { ok: true, changed: true, detail: `validated, reloaded, ${target} answers${step.protected ? " the portal's 401" : ""}, ${others} other site(s) still answer` };
}
