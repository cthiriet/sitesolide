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
 *      unknown: one alert for Caddy, not one more per site. What failed is
 *      probed first, then what was checked least recently, and what no longer
 *      fits in the budget is not checked this time rather than judged on a
 *      timeout cut short;
 *   4. judge, then let the state machine say what changed;
 *   5. write the memory, notices included, BEFORE sending anything: a run
 *      killed while a webhook hangs loses no transition, the next run sends it;
 *   6. ping the heartbeat, send the webhook's one message if there is
 *      anything to say;
 *   7. write the memory again without what was delivered, what a message
 *      cut to fit left out kept for the next run, and the status the
 *      dashboard is handed.
 *
 * Every notice is written to the journal as well, configured alerting or not:
 * with no address set, the journal is the only output, which is exactly what
 * the machine did before this monitor, and no worse.
 */
import { advance, isBad, isDown, type Notice, type Tracked } from "./alerts";
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
 * an item is started only if `needMs`, its whole timeout, still fits before
 * the deadline, and gets `skipped` otherwise. A hung Caddy makes every probe
 * wait for its full timeout, and fifty of them in a row would outlast the
 * unit's TimeoutStartSec, which would kill the run before it pinged the
 * heartbeat.
 *
 * Never a shortened timeout: a probe given the 400 ms left of the budget fails
 * on its own clock and is judged a site that does not answer, the same site at
 * the tail of every run, down for nothing.
 */
export async function bounded<T, R>(
  items: readonly T[],
  limit: number,
  deadline: number,
  clock: () => number,
  needMs: number,
  work: (item: T) => Promise<R>,
  skipped: (item: T) => R,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index]!;
      results[index] = deadline - clock() < needMs ? skipped(item) : await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * The order the probes start in, which only matters when they do not all fit:
 * what is not ok first, a failure to confirm or a recovery to see, then the
 * rest from the least recently checked, so that what one run left out is the
 * first of the next and every host gets its turn. Stable: when everything
 * fits, every run probes in the order of what is served.
 */
export function probeOrder<T>(items: readonly T[], idOf: (item: T) => string, checks: Readonly<Record<string, Tracked>>): T[] {
  const ranked = items.map((item, index) => {
    const tracked = checks[idOf(item)];
    return { item, index, bad: isBad(tracked) ? 0 : 1, checkedAt: tracked?.checkedAt ?? Number.NEGATIVE_INFINITY };
  });
  ranked.sort((a, b) => a.bad - b.bad || (a.checkedAt < b.checkedAt ? -1 : a.checkedAt > b.checkedAt ? 1 : 0) || a.index - b.index);
  return ranked.map(({ item }) => item);
}

export async function run(config: Config, machine: Machine, now: number, clock: () => number = Date.now): Promise<Outcome> {
  const { state, problem } = parseState(machine.readState());
  if (problem !== null) machine.log(`monitor: ${problem}`);
  const problems = [...config.problems];
  const results: Result[] = [];
  const unknownKinds = new Set<Kind>();
  /** Probes and readings skipped for lack of time, for the status and the journal. */
  let unchecked = 0;

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
      const timeout = config.probe.timeoutMs;
      const probes = bounded(
        probeOrder(targets, (target) => `site:${target.host}`, state.checks),
        config.concurrency,
        deadline,
        clock,
        timeout,
        async (target) => judgeProbe(target.host, target.slug, await machine.probe(target.host, timeout)),
        (target) => {
          unchecked++;
          return notProbed(target.host, target.slug, "not probed: the run ran out of time");
        },
      );
      const readings = bounded(
        probeOrder(certificates, (certificate) => certificate.id, state.checks),
        config.concurrency,
        deadline,
        clock,
        timeout,
        async (certificate) => judgeCertificate(certificate, await machine.certificate(certificate.sni, timeout), now),
        (certificate) => {
          unchecked++;
          return judgeCertificate(certificate, { error: "not read: the run ran out of time" }, now);
        },
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

  let sent: Notice[] = [];
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
      if (delivery.ok) {
        sent = request.sent;
        return "ok";
      }
      machine.log(`monitor: webhook not delivered (${delivery.reason}), ${outbox.length} notice(s) kept for the next run`);
      return "failed";
    })(),
  ]);
  if (webhook === "ok") {
    outbox = outbox.filter((notice) => !sent.includes(notice));
    if (outbox.length > 0) machine.log(`monitor: ${outbox.length} notice(s) did not fit the message, kept for the next run`);
  }

  const final: State = { ...written, outbox };
  machine.writeState(`${JSON.stringify(final)}\n`);
  const status = buildStatus({ now, zone: config.zone, checks, heartbeat, webhook, undelivered: outbox.length, unchecked });
  machine.writeStatus(`${JSON.stringify(status)}\n`);

  const tracked = Object.values(checks);
  const down = tracked.filter(isDown).length;
  const failing = tracked.filter((check) => check.status === "failing").length;
  const skipped = unchecked > 0 ? `, ${unchecked} not checked` : "";
  machine.log(`${tracked.length} checks, ${down} down, ${failing} failing${skipped}; heartbeat ${heartbeat}, webhook ${webhook}`);
  return { status, notices, state: final };
}
