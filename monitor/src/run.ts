/**
 * One pass of the monitor, the one the timer starts every minute.
 *
 * In order, and the order is the point:
 *
 *   1. read the memory of the previous runs;
 *   2. read the machine: Caddy, the units, the served directories and domains,
 *      memory, disks, the backup status;
 *   3. probe every served host over HTTPS and read each certificate, unless
 *      Caddy is known to be down, in which case the probes are skipped as
 *      unknown: one alert for Caddy, not one more per site;
 *   4. judge, then let the state machine say what changed;
 *   5. write the memory, notices included, BEFORE sending anything: a run
 *      killed while a webhook hangs loses no transition, the next run sends it;
 *   6. ping the heartbeat, send the webhook's one message if there is
 *      anything to say;
 *   7. write the memory again without what was delivered, and the status the
 *      dashboard is handed.
 *
 * Every notice is written to the journal as well, configured alerting or not:
 * with no address set, the journal is the only output, which is exactly what
 * the machine did before this monitor, and no worse.
 */
import { advance, isBad, isDown, type Notice } from "./alerts";
import {
  judgeBackup,
  judgeCaddy,
  judgeCertificate,
  judgeDisk,
  judgeMemory,
  judgeProbe,
  judgeRestarts,
  judgeSelf,
  judgeUnits,
  notProbed,
  type Kind,
  type Result,
} from "./checks";
import type { Config } from "./config";
import { certificateTargets, projectUnits, readDomainTable, servedTargets, siteFolders } from "./hosts";
import type { Machine } from "./machine";
import { heartbeatRequest, webhookRequest } from "./notify";
import { buildStatus, type ChannelState, type MonitorStatus } from "./status";
import { parseState, trimOutbox, type State } from "./store";

/** One request to the outside, at most. */
export const SEND_TIMEOUT_MS = 10_000;

export type Outcome = { status: MonitorStatus; notices: Notice[]; state: State };

/**
 * Runs `work` over every item, `limit` at a time, and never past `deadline`:
 * an item not started in time gets `skipped` instead. A hung Caddy makes every
 * probe wait for its full timeout, and fifty of them in a row would outlast
 * the unit's TimeoutStartSec, which would kill the run before it pinged the
 * heartbeat.
 */
export async function bounded<T, R>(
  items: readonly T[],
  limit: number,
  deadline: number,
  clock: () => number,
  work: (item: T, timeoutMs: number) => Promise<R>,
  skipped: (item: T) => R,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index]!;
      const left = deadline - clock();
      results[index] = left <= 0 ? skipped(item) : await work(item, left);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export async function run(config: Config, machine: Machine, now: number, clock: () => number = Date.now): Promise<Outcome> {
  const { state, problem } = parseState(machine.readState());
  if (problem !== null) machine.log(`monitor: ${problem}`);
  const problems = [...config.problems];
  const results: Result[] = [];
  const unknownKinds = new Set<Kind>();

  const [caddy, units, backup] = await Promise.all([machine.caddy(), machine.units(), machine.backup()]);
  const folders = machine.folders();
  const domains = machine.domains();

  // Caddy, and whether systemd had to restart it since the last run.
  const show = "value" in caddy ? caddy.value : null;
  if ("error" in caddy) problems.push(caddy.error);
  const caddyResult = judgeCaddy(show);
  results.push(caddyResult);
  const restarts = judgeRestarts(show, state.restarts, now);
  results.push(restarts.result);

  // What is served. Without the directories, neither the sites nor the
  // projects' units can be named: they are left as they were.
  const names = "value" in folders ? siteFolders(folders.value, config.zone) : null;
  if ("error" in folders) {
    problems.push(folders.error);
    for (const kind of ["site", "certificate", "unit"] as const) unknownKinds.add(kind);
  }
  const table = "value" in domains ? readDomainTable(domains.value) : [];
  if ("error" in domains) {
    problems.push(domains.error);
    unknownKinds.add("site");
    unknownKinds.add("certificate");
  }

  if ("error" in units) {
    problems.push(units.error);
    unknownKinds.add("unit");
    unknownKinds.add("platform");
  } else if (names !== null) {
    results.push(...judgeUnits(units.value, projectUnits(names, config.zone)));
  } else {
    unknownKinds.add("platform");
  }

  if (names !== null) {
    const targets = servedTargets(config.zone, names, table);
    const certificates = certificateTargets(config.zone, targets);
    if (caddyResult.verdict === "fail") {
      const reason = "not probed: Caddy is not running";
      for (const target of targets) results.push(notProbed(target.host, target.slug, reason));
      for (const certificate of certificates) results.push(judgeCertificate(certificate, { error: reason }, now));
    } else {
      const deadline = clock() + config.probeBudgetMs;
      const timeout = (left: number) => Math.min(config.probe.timeoutMs, left);
      const probes = bounded(
        targets,
        config.concurrency,
        deadline,
        clock,
        async (target, left) => judgeProbe(target.host, target.slug, await machine.probe(target.host, timeout(left))),
        (target) => notProbed(target.host, target.slug, "not probed: the run ran out of time"),
      );
      const readings = bounded(
        certificates,
        config.concurrency,
        deadline,
        clock,
        async (certificate, left) => judgeCertificate(certificate, await machine.certificate(certificate.sni, timeout(left)), now),
        (certificate) => judgeCertificate(certificate, { error: "not read: the run ran out of time" }, now),
      );
      const [probed, read] = await Promise.all([probes, readings]);
      results.push(...probed, ...read);
    }
  }

  results.push(judgeMemory(machine.meminfo(), isBad(state.checks.memory)));
  for (const { path, stats } of machine.disks(config.diskPaths)) {
    results.push(judgeDisk(path, stats, isBad(state.checks[`disk:${path}`])));
  }
  const backupResult = judgeBackup(backup, now);
  if (backupResult !== null) results.push(backupResult);
  results.push(judgeSelf(problems));

  const { checks, notices } = advance(state.checks, results, now, unknownKinds);
  for (const notice of notices) machine.log(`${notice.event.toUpperCase()} ${notice.id}: ${notice.summary}`);

  // With no webhook, the journal above was the delivery: nothing waits.
  let outbox = config.webhookUrl === null ? [] : trimOutbox([...state.outbox, ...notices], now);
  const written: State = { version: state.version, checks, restarts: restarts.memory, outbox };
  machine.writeState(`${JSON.stringify(written)}\n`);

  const [heartbeat, webhook] = await Promise.all([
    (async (): Promise<MonitorStatus["heartbeat"]> => {
      if (config.heartbeatUrl === null) return "unconfigured";
      const delivery = await machine.send(heartbeatRequest(config.heartbeatUrl, checks, config.zone), SEND_TIMEOUT_MS);
      if (delivery.ok) return "ok";
      machine.log(`monitor: heartbeat not delivered (${delivery.reason})`);
      return "failed";
    })(),
    (async (): Promise<ChannelState> => {
      if (config.webhookUrl === null) return "unconfigured";
      if (outbox.length === 0) return "idle";
      const request = webhookRequest(config.webhookUrl, config.webhookFormat, outbox, config.zone);
      const delivery = await machine.send(request, SEND_TIMEOUT_MS);
      if (delivery.ok) return "ok";
      machine.log(`monitor: webhook not delivered (${delivery.reason}), ${outbox.length} notice(s) kept for the next run`);
      return "failed";
    })(),
  ]);
  if (webhook === "ok") outbox = [];

  const final: State = { ...written, outbox };
  machine.writeState(`${JSON.stringify(final)}\n`);
  const status = buildStatus({ now, zone: config.zone, checks, heartbeat, webhook, undelivered: outbox.length });
  machine.writeStatus(`${JSON.stringify(status)}\n`);

  const tracked = Object.values(checks);
  const down = tracked.filter(isDown).length;
  const failing = tracked.filter((check) => check.status === "failing").length;
  machine.log(`${tracked.length} checks, ${down} down, ${failing} failing; heartbeat ${heartbeat}, webhook ${webhook}`);
  return { status, notices, state: final };
}
